// tz.js — time-zone arithmetic (spec §5.1, §9.2). PURE: no I/O, and it NEVER uses
// process-local Date getters (getHours, getDate, …); the process TZ is irrelevant to every
// result here (tests run under TZ=UTC and TZ=Asia/Tokyo).
//
// makeTz(timezone) → {
//   timezone,
//   localParts(ms)          → {date:'YYYY-MM-DD', dow:0-6 (0=Sun), minuteOfDay, second,
//                              year, month, day, hour, minute, hhmm:'HH:MM'}
//   offsetAt(ms)            → UTC offset in MINUTES east of UTC (PDT = −420, PST = −480)
//   zonedToInstant(date, hhmm) → epoch ms. Spring-forward gap ⇒ moved forward by the gap
//                              (2026-03-08 02:30 → 03:30 PDT = 10:30Z); fall-back overlap ⇒ the
//                              EARLIER occurrence (2026-11-01 01:30 → 08:30Z); '24:00' = next date
//                              00:00. `hhmm` may also be a number of minutes after local midnight.
//   addDays(date, n)        → 'YYYY-MM-DD' (calendar arithmetic via Date.UTC, never +86400000)
//   formatLocal(ms, opts)   → string in the configured timezone, en-US. `opts` is an Intl options object
//                              or a preset: 'time' "7:00 AM" (default) · 'hmm' "7:00"/"15:00" (24 h,
//                              no leading zero) · 'hhmm' "07:00" · 'date' "Wed, Sep 24" ·
//                              'weekday' "Wed" · 'monthDay' "Sep 24" · 'dayTime' "Wed 1:30 AM" ·
//                              'dateTime' "Wed, Sep 24, 7:00 AM". Narrow/thin no-break spaces that
//                              some ICU versions emit are normalised to a plain space.
//   dayBounds(date)         → {start, end, minutes} (1380 / 1440 / 1500 on DST days)
//   selfTest()              → {ok, failures:[string]} — §5.1 vectors (validates ICU tz data) plus
//                              round trips in the configured zone. Never throws.
// }
// makeTz throws RangeError for an unknown IANA zone (validate.js rejects those first).

const DAY_MS = 86400000
const MIN_MS = 60000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const HHMM_RE = /^(\d{1,2}):(\d{2})$/

function pad2(n) { return String(n).padStart(2, '0') }

/** Parse 'YYYY-MM-DD' → {y, m, d}; throws RangeError on malformed or impossible dates. */
export function parseDate(date) {
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null
  if (!m) throw new RangeError(`bad date: ${date}`)
  const y = +m[1], mo = +m[2], d = +m[3]
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new RangeError(`bad date: ${date}`)
  return { y, m: mo, d }
}

export function isValidDate(date) {
  try { parseDate(date); return true } catch { return false }
}

function fmtUTCDate(ms) {
  const t = new Date(ms)
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** Calendar arithmetic on 'YYYY-MM-DD' (DST-proof: works on dates, not instants). */
export function addDays(date, n) {
  const { y, m, d } = parseDate(date)
  return fmtUTCDate(Date.UTC(y, m - 1, d + Math.trunc(Number(n) || 0)))
}

/** Day of week of a calendar date, 0 = Sunday. */
export function dowOf(date) {
  const { y, m, d } = parseDate(date)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 'HH:MM' → minutes after midnight (0..1440; '24:00' → 1440). Throws RangeError when malformed. */
export function hhmmToMin(hhmm) {
  const m = typeof hhmm === 'string' ? HHMM_RE.exec(hhmm) : null
  if (!m) throw new RangeError(`bad time: ${hhmm}`)
  const h = +m[1], mi = +m[2]
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new RangeError(`bad time: ${hhmm}`)
  return h * 60 + mi
}

/** minutes after midnight → 'HH:MM' (1440 → '24:00'). */
export function minToHHMM(min) {
  const v = Math.round(Number(min))
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`
}

export function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true } catch { return false }
}

const PRESETS = {
  time: { hour: 'numeric', minute: '2-digit' },
  date: { weekday: 'short', month: 'short', day: 'numeric' },
  weekday: { weekday: 'short' },
  monthDay: { month: 'short', day: 'numeric' },
  dayTime: { weekday: 'short', hour: 'numeric', minute: '2-digit' },
  dateTime: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
}

const ODD_SPACES = /[\u202f\u2009\u00a0]/g // narrow no-break, thin and no-break spaces (ICU-version dependent)

function build(timezone) {
  // One cached formatter (spec §5.1). Constructing it validates the zone (RangeError if unknown).
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  })
  const offsetCache = new Map()
  const fmtCache = new Map()

  // Offset in ms at instant ms. Cached per UTC minute (all modern zone transitions fall on whole minutes).
  function offsetMs(ms) {
    const key = Math.floor(ms / MIN_MS)
    const hit = offsetCache.get(key)
    if (hit !== undefined) return hit
    const at = key * MIN_MS
    let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0
    for (const p of dtf.formatToParts(at)) {
      switch (p.type) {
        case 'year': y = +p.value; break
        case 'month': mo = +p.value; break
        case 'day': d = +p.value; break
        case 'hour': h = +p.value % 24; break
        case 'minute': mi = +p.value; break
        case 'second': s = +p.value; break
      }
    }
    const off = Date.UTC(y, mo - 1, d, h, mi, s) - at
    if (offsetCache.size > 4096) offsetCache.clear()
    offsetCache.set(key, off)
    return off
  }

  function localParts(ms) {
    const t = Number(ms)
    if (!Number.isFinite(t)) throw new RangeError(`bad instant: ${ms}`)
    const shifted = new Date(t + offsetMs(t)) // read with UTC getters only
    const year = shifted.getUTCFullYear()
    const month = shifted.getUTCMonth() + 1
    const day = shifted.getUTCDate()
    const hour = shifted.getUTCHours()
    const minute = shifted.getUTCMinutes()
    const second = shifted.getUTCSeconds()
    return {
      date: `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`,
      dow: shifted.getUTCDay(),
      minuteOfDay: hour * 60 + minute,
      second,
      year, month, day, hour, minute,
      hhmm: `${pad2(hour)}:${pad2(minute)}`,
    }
  }

  function offsetAt(ms) { return Math.round(offsetMs(Number(ms)) / MIN_MS) }

  function zonedToInstant(date, hhmm) {
    const { y, m, d } = parseDate(date)
    const min = typeof hhmm === 'number' ? hhmm : hhmmToMin(hhmm)
    if (!Number.isFinite(min)) throw new RangeError(`bad time: ${hhmm}`)
    const L = Date.UTC(y, m - 1, d) + Math.round(min * MIN_MS) // local wall time read as if UTC
    const before = offsetMs(L - DAY_MS)
    const after = offsetMs(L + DAY_MS)
    let best = null
    for (const o of before === after ? [before] : [before, after]) {
      const t = L - o
      if (offsetMs(t) === o && (best === null || t < best)) best = t // earliest valid ⇒ overlap resolves early
    }
    if (best !== null) return best
    return L - before // nonexistent (gap): pre-transition offset ⇒ shifted forward by the gap
  }

  function formatLocal(ms, opts = 'time') {
    const t = Number(ms)
    if (!Number.isFinite(t)) return ''
    if (opts === 'hhmm') return localParts(t).hhmm
    if (opts === 'hmm') { const p = localParts(t); return `${p.hour}:${pad2(p.minute)}` }
    const key = typeof opts === 'string' ? opts : JSON.stringify(opts)
    let f = fmtCache.get(key)
    if (!f) {
      const o = typeof opts === 'string' ? (PRESETS[opts] ?? PRESETS.time) : (opts ?? PRESETS.time)
      f = new Intl.DateTimeFormat('en-US', { ...o, timeZone: timezone })
      if (fmtCache.size > 64) fmtCache.clear()
      fmtCache.set(key, f)
    }
    return f.format(t).replace(ODD_SPACES, ' ')
  }

  function dayBounds(date) {
    const start = zonedToInstant(date, '00:00')
    const end = zonedToInstant(addDays(date, 1), '00:00')
    return { start, end, minutes: Math.round((end - start) / MIN_MS) }
  }

  return { timezone, localParts, offsetAt, zonedToInstant, addDays, formatLocal, dayBounds }
}

// §5.1 startup vectors (America/Los_Angeles). They validate the ICU tz data regardless of the
// configured zone, so they always run against an internal LA instance.
function laVectors(la) {
  const f = []
  const lp = (iso) => { const p = la.localParts(Date.parse(iso)); return `${p.date} ${p.hhmm}` }
  const check = (label, got, want) => { if (got !== want) f.push(`${label}: got ${got}, want ${want}`) }
  check('2026-03-08 10:00Z', lp('2026-03-08T10:00:00Z'), '2026-03-08 03:00')
  check('2026-11-01 08:30Z', lp('2026-11-01T08:30:00Z'), '2026-11-01 01:30')
  check('2026-09-23 07:00 local', la.zonedToInstant('2026-09-23', '07:00'), Date.parse('2026-09-23T14:00:00Z'))
  check('2026-07-01T19:00Z', lp('2026-07-01T19:00:00Z'), '2026-07-01 12:00')
  check('2026-12-01T20:00Z', lp('2026-12-01T20:00:00Z'), '2026-12-01 12:00')
  check('gap 2026-03-08 02:30', la.zonedToInstant('2026-03-08', '02:30'), Date.parse('2026-03-08T10:30:00Z'))
  check('overlap 2026-11-01 01:30', la.zonedToInstant('2026-11-01', '01:30'), Date.parse('2026-11-01T08:30:00Z'))
  check('24:00', la.zonedToInstant('2026-09-23', '24:00'), la.zonedToInstant('2026-09-24', '00:00'))
  check('23 h day', la.dayBounds('2026-03-08').minutes, 1380)
  check('25 h day', la.dayBounds('2026-11-01').minutes, 1500)
  check('addDays', addDays('2026-12-31', 1), '2027-01-01')
  return f
}

export function makeTz(timezone = 'America/Los_Angeles') {
  const core = build(timezone)
  function selfTest() {
    const failures = []
    try {
      failures.push(...laVectors(timezone === 'America/Los_Angeles' ? core : build('America/Los_Angeles')))
      // Round trips in the configured zone (instants chosen away from any DST overlap).
      for (const iso of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z', '2026-09-23T19:07:00Z']) {
        const ms = Date.parse(iso)
        const p = core.localParts(ms)
        const back = core.zonedToInstant(p.date, p.hhmm) + p.second * 1000
        if (back !== ms) failures.push(`round trip ${iso} in ${timezone}: got ${new Date(back).toISOString()}`)
        if (!core.formatLocal(ms)) failures.push(`formatLocal empty in ${timezone}`)
      }
    } catch (e) {
      failures.push(`exception: ${e && e.message}`)
    }
    return { ok: failures.length === 0, failures }
  }
  return { ...core, selfTest }
}
