// validate.js — ISOMORPHIC validation of the inputs the core reads, and the calendar helpers of the rate
// model. Imports nothing and uses no Node APIs (Intl only), so a browser can load it unchanged.
//
// validate(cfg) → {errors:[{path, message}], warnings:[{path, message}]} — every section the core reads:
//   timezone (an IANA name), units (a list of {id, shed?, precondition?}; ids unique; pre-conditioning needs shed),
//   tou, holidays, precondition, shed.fanOnlyMin and optimizer (when present), plus the lead-room warning below.
//   Paths use dot/bracket notation: 'tou.weekday[2].start', 'optimizer.units.unit-a'. A host that stores more
//   (devices, schedules, notifications) validates those itself and can reuse the section checkers below in place.
// validateOptimizer(cfg) → [{path, message}] — the optimizer section's errors only (tuning.validateTuningCfg).
//
// Sections (each checker takes a collector c = collector() and reports into it; the host calls them in its own order):
//   checkTou(c, cfg) → {eventsByTable, weekendRows}: tou.defaultTier ∈ TIERS; tou.weekendDays day numbers 0–6, unique;
//     tou.mergeGapMin 0–120; tou.weekday / tou.weekendHoliday: windows {start, end ('24:00' allowed), tier,
//     precondition?} on the 5-minute grid, in time order, never overlapping, never crossing midnight; precondition
//     only on a peak window; warnings for a window edge in the 1:00–3:00 AM daylight-saving band, a pre-conditioning
//     start in that band ("it is held to 3:00") and a pre-conditioning window that is not all super off-peak.
//   checkHolidays(c, cfg): holidays.preset ∈ HOLIDAY_PRESETS; holidays.rows [{date (a real YYYY-MM-DD, unique),
//     name (1–80 chars), observed?, source? 'preset'|'user'}].
//   checkPrecondition(c, cfg, weekendRows): modes ⊆ PRECONDITION_MODES; deltaF {cooling, heating} 1–6 by 0.5;
//     leadMin {cooling, heating} 20–240 whole minutes; clampF {coolingMin 61–75, heatingMax 66–90}; minLeadMin 5–120;
//     joinCutoffMin 0–60; fan ∈ PRECONDITION_FANS | null; optimumStart 0–120 by 5; superOffPeak {weekend: boolean}
//     (unknown keys are 'Unknown field'). While superOffPeak.weekend === true, warnings on
//     precondition.superOffPeak.weekend for the weekend & holidays table: no super off-peak → off-peak change; per
//     boundary the two lead warnings above; "Too close to 3:00 AM …" when no boundary leaves minLeadMin.
//   checkFanOnly(c, v, eventsByTable): shed.fanOnlyMin {cooling, heating} whole minutes 0–180 by 15, with a warning when
//     one leaves less than 60 min of the shortest peak switched off ("Leaves no off time to learn from").
//   checkOptimizer(c, cfg, eventsByTable) → {earliest, peakEnds}: the guardrails (observeDays 0–14; minDeltaF ≤
//     maxDeltaF, both 1–6 by 0.5; earliestStart HH:MM; minLeadMin 20–240; maxStepDeltaF fixed at 1; maxStepLeadMin
//     5–30; comfyMarginF ≥ marginF; cooldowns), earliestStart ≤ (first peak start of any day type − minLeadMin), and
//     optimizer.units.<id> {enabled, comfortLowF 55–80, comfortHighF 65–90, at least 4° apart, sensorOffsetF ±5} for
//     configured unit ids. earliest = earliestStart in minutes | null; peakEnds = each table's last peak end (minutes).
//   checkLeadRoom(c, cfg, eventsByTable): with the optimizer on, a warning on precondition.leadMin.<season> when the
//     base lead is longer than (first pre-conditioning peak − earliestStart): auto-tune can then only change the strength.
//   tableEvents(cfg) → eventsByTable of the two tables, computed silently (for a host that validates in pieces).
// Host extension helpers (the rules above are built from them): collector(), isObj, isNum, toMin('HH:MM', allow24),
//   clock(min) → 'H:MM', validDate, validTimezone, num(c, path, v, min, max, {int, required, step, range}), bool,
//   oneOf, hhmm(c, path, v, {allow24, required}) → minutes | null, DST_LO / DST_HI (the 1:00–3:00 AM band, minutes).
//
// Calendar helpers (the one definition; tou.js uses them):
// offPeakBoundaries(list) → [start]: `list` = [{tier, start}] in time order (any time unit); same-tier neighbours
//   merge; the start of every off_peak segment whose predecessor is super_off_peak. The first segment (local 00:00)
//   never counts. tou.events (boundary events) and the table checks share it.
// dayTypeOf({weekendDays, holidayDates}, 'YYYY-MM-DD') → 'weekday' | 'weekend' | 'holiday' (holidayDates is an array
//   or anything with has(date); weekendDays default [0, 6]; tou.dayType delegates here). entryOnDay(days, dayType) →
//   bool ('all'/absent: every day; 'weekday': weekdays only; 'weekend': weekends AND holidays; an unknown value:
//   never). daysOverlap(a, b) → bool (two daily entries at one time collide iff their day sets intersect).

export const TIERS = ['peak', 'off_peak', 'super_off_peak']
export const PRECONDITION_MODES = ['COOL', 'DRY', 'HEAT']
// Fan speeds a pre-conditioning run can set; `precondition.fan: null` leaves the fan alone.
export const PRECONDITION_FANS = ['HIGH', 'MEDIUM', 'LOW', 'AUTO']
export const HOLIDAY_PRESETS = ['us-federal', 'ca-utility-8', 'none']
// Daily scheduled settings: the day types an entry can apply on.
export const ENTRY_DAYS = ['all', 'weekday', 'weekend']
export const DST_LO = 60
export const DST_HI = 180
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const HHMM_RE = /^(\d{2}):(\d{2})$/

export function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
export function isNum(v) { return typeof v === 'number' && Number.isFinite(v) }

export function collector() {
  const errors = []
  const warnings = []
  return {
    errors, warnings,
    err(path, message, code) { errors.push(code ? { path, message, code } : { path, message }) },
    warn(path, message) { warnings.push({ path, message }) },
  }
}

/** 'HH:MM' → minutes; `allow24` accepts '24:00'. Returns null when malformed. */
export function toMin(s, allow24 = false) {
  const m = typeof s === 'string' ? HHMM_RE.exec(s) : null
  if (!m) return null
  const h = +m[1], mi = +m[2]
  if (mi > 59) return null
  if (h === 24 && mi === 0 && allow24) return 1440
  if (h > 23) return null
  return h * 60 + mi
}

export function clock(min) { return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` }

export function validDate(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// Numeric field: required ⇒ missing is an error; present ⇒ must be a finite number in [min, max]
// (`range` overrides the out-of-range message).
export function num(c, path, v, min, max, { int = false, required = false, step = null, range = null } = {}) {
  if (v === undefined || v === null) { if (required) c.err(path, 'Required'); return false }
  if (!isNum(v)) { c.err(path, 'Must be a number'); return false }
  if (int && !Number.isInteger(v)) { c.err(path, 'Must be a whole number'); return false }
  if (v < min || v > max) { c.err(path, range ?? `Must be between ${min} and ${max}`); return false }
  if (step && Math.abs(v / step - Math.round(v / step)) > 1e-6) { c.err(path, `Must be a multiple of ${step}`); return false }
  return true
}

export function bool(c, path, v, required = false) {
  if (v === undefined || v === null) { if (required) c.err(path, 'Required'); return }
  if (typeof v !== 'boolean') c.err(path, 'Must be true or false')
}

export function oneOf(c, path, v, list, required = true) {
  if (v === undefined || v === null) { if (required) c.err(path, 'Required'); return false }
  if (!list.includes(v)) { c.err(path, `Must be one of: ${list.join(', ')}`); return false }
  return true
}

export function hhmm(c, path, v, { allow24 = false, required = true } = {}) {
  if (v === undefined || v === null) { if (required) c.err(path, 'Required'); return null }
  const m = toMin(v, allow24)
  if (m === null) { c.err(path, 'Use HH:MM (24-hour)'); return null }
  if (m % 5 !== 0) { c.err(path, 'Use a 5-minute step (e.g. 07:05)'); return null }
  return m
}

function pick(v, season) { return isNum(v) ? v : isObj(v) ? v[season] : undefined }

// ---- day types (addendum D E1.6) ------------------------------------------------------------------

/** 'weekday' | 'weekend' | 'holiday' for a local 'YYYY-MM-DD' (see header). */
export function dayTypeOf({ weekendDays, holidayDates } = {}, date) {
  const h = holidayDates
  if (h && (typeof h.has === 'function' ? h.has(date) : Array.isArray(h) && h.includes(date))) return 'holiday'
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null
  const dow = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : null
  return (Array.isArray(weekendDays) ? weekendDays : [0, 6]).includes(dow) ? 'weekend' : 'weekday'
}

/** Does an entry with `days` apply on a date of `dayType`? (see header) */
export function entryOnDay(days, dayType) {
  const d = days ?? 'all'
  if (d === 'all') return true
  if (d === 'weekday') return dayType === 'weekday'
  if (d === 'weekend') return dayType === 'weekend' || dayType === 'holiday'
  return false
}

/** Two entries at one time collide iff their day sets intersect (D E1.4). */
export function daysOverlap(a, b) {
  const x = a ?? 'all'
  const y = b ?? 'all'
  return x === 'all' || y === 'all' || x === y
}
// ---- TOU tables ---------------------------------------------------------------------------------

// Validate one day table; returns the valid rows in minutes (sorted) for cross-checks.
function validateTable(c, path, rows, cfg) {
  if (!Array.isArray(rows)) { c.err(path, 'Must be a list of windows'); return [] }
  const good = []
  let prev = null
  rows.forEach((w, i) => {
    const p = `${path}[${i}]`
    if (!isObj(w)) { c.err(p, 'Must be a window {start, end, tier}'); return }
    const start = hhmm(c, `${p}.start`, w.start)
    const end = hhmm(c, `${p}.end`, w.end, { allow24: true })
    const tierOk = oneOf(c, `${p}.tier`, w.tier, TIERS)
    if (w.precondition !== undefined && w.precondition !== null && typeof w.precondition !== 'boolean') c.err(`${p}.precondition`, 'Must be true or false')
    if (w.precondition === true && w.tier !== 'peak') c.err(`${p}.precondition`, 'Pre-conditioning can only be set on peak windows')
    if (start === null || end === null) return
    if (start >= end) { c.err(`${p}.end`, 'End must be after start (windows cannot cross midnight)'); return }
    if (prev) {
      if (start < prev.start) c.err(`${p}.start`, 'Windows must be in time order')
      else if (start < prev.end) c.err(`${p}.start`, `Overlaps the previous window (ends ${clock(prev.end)})`)
    }
    for (const [k, m] of [['start', start], ['end', end]]) {
      if (m >= DST_LO && m < DST_HI) c.warn(`${p}.${k}`, 'Falls in the 1:00–3:00 AM daylight-saving band (that hour is skipped or repeated twice a year)')
    }
    const row = { start, end, tier: w.tier, precondition: w.precondition === true, index: i }
    if (tierOk) good.push(row)
    if (!prev || start >= prev.start) prev = row
  })
  good.sort((a, b) => a.start - b.start)
  return good
}

// Gap-filled minute segments (default tier in the gaps), overlaps clipped.
function filled(rows, defaultTier) {
  const out = []
  let cur = 0
  for (const r of rows) {
    const s = Math.max(r.start, cur)
    if (s >= r.end) continue
    if (s > cur) out.push({ start: cur, end: s, tier: defaultTier, precondition: false })
    out.push({ ...r, start: s })
    cur = r.end
  }
  if (cur < 1440) out.push({ start: cur, end: 1440, tier: defaultTier, precondition: false })
  return out
}

// Merged peak events in minutes (same rule as tou.js events()).
function peakEvents(segs, mergeGapMin) {
  const out = []
  let cur = null
  for (const s of segs) {
    if (s.tier !== 'peak') continue
    if (cur && (s.start <= cur.end || s.start - cur.end < mergeGapMin)) {
      cur.end = Math.max(cur.end, s.end)
      cur.precondition = cur.precondition || s.precondition
      cur.rows.push(s)
      continue
    }
    cur = { start: s.start, end: s.end, precondition: s.precondition, rows: [s] }
    out.push(cur)
  }
  return out
}

/** Addendum E §3.1: starts of the off_peak segments that follow a super_off_peak one (see header). */
export function offPeakBoundaries(list) {
  const out = []
  let prev = null
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || s.tier === prev) continue // same-tier neighbours merge
    if (prev === 'super_off_peak' && s.tier === 'off_peak') out.push(s.start)
    prev = s.tier
  }
  return out
}

function tableSegs(rows, cfg) {
  const def = TIERS.includes(cfg?.tou?.defaultTier) ? cfg.tou.defaultTier : 'super_off_peak'
  const gap = isNum(cfg?.tou?.mergeGapMin) ? cfg.tou.mergeGapMin : 30
  const segs = filled(rows, def)
  const leads = ['cooling', 'heating'].map((s) => pick(cfg?.precondition?.leadMin, s)).filter(isNum)
  return { gap, segs, evs: peakEvents(segs, gap), leads }
}

// The pre-conditioning warnings of one event starting at `start` (minutes) after `prevEnd` (the previous event's
// end + mergeGapMin, else 0): the DST band per lead and a window [lo, start) that is not all super off-peak. → lo
function leadChecks(c, path, start, prevEnd, segs, leads) {
  for (const lead of new Set(leads)) {
    const raw = start - lead
    if (raw >= DST_LO && raw < DST_HI) c.warn(path, `Pre-conditioning would start at ${clock(raw)}, inside the 1:00–3:00 AM daylight-saving band (it is held to 3:00)`)
  }
  const lo = Math.max(start - Math.max(...leads), prevEnd, 180)
  if (lo >= start) return lo
  const hit = segs.find((s) => s.tier !== 'super_off_peak' && s.start < start && s.end > lo)
  if (hit) {
    const label = hit.tier === 'off_peak' ? 'off-peak' : 'peak'
    c.warn(path, `Pre-conditioning ${clock(lo)}–${clock(start)} runs during ${label}, not super off-peak`)
  }
  return lo
}

function tableChecks(c, path, rows, cfg) {
  const { gap, segs, evs, leads } = tableSegs(rows, cfg)
  evs.forEach((e, i) => {
    if (!e.precondition || !leads.length) return
    const rowPath = `${path}[${(e.rows.find((r) => r.precondition) ?? e.rows[0]).index}]`
    leadChecks(c, `${rowPath}.precondition`, e.start, i > 0 ? evs[i - 1].end + gap : 0, segs, leads)
  })
  return evs
}

// Addendum E §3.1: the weekend & holidays table's boundaries while precondition.superOffPeak.weekend is on. A
// boundary's previous event is the latest peak event or boundary ending at or before it (tou's prev clamp).
function boundaryChecks(c, rows, cfg) {
  const path = 'precondition.superOffPeak.weekend'
  const { gap, segs, evs, leads } = tableSegs(rows, cfg)
  const bs = offPeakBoundaries(segs)
  if (!bs.length) { c.warn(path, 'The weekend & holidays table has no super off-peak → off-peak change to pre-condition for'); return }
  if (!leads.length) return
  const minLead = isNum(cfg.precondition.minLeadMin) ? cfg.precondition.minLeadMin : 20
  let usable = false
  for (const t of bs) {
    const ends = [...evs.map((e) => e.end), ...bs].filter((end) => end < t)
    const lo = leadChecks(c, path, t, ends.length ? Math.max(...ends) + gap : 0, segs, leads)
    if (t - lo >= minLead) usable = true
  }
  if (!usable) c.warn(path, 'Too close to 3:00 AM for the shortest lead: nothing pre-conditions')
}
// ---- fan-only dry-out (addendum B F2.2) -----------------------------------------------------------

// shed.fanOnlyMin {cooling, heating}: minutes of fan-only before the shed's power OFF (0 = straight to OFF).
// Warns when a season's dry-out leaves under an hour of the shortest peak switched off (C-9: the drift
// model learns only from the OFF part of a peak).
export function checkFanOnly(c, v, eventsByTable) {
  if (!isObj(v)) { c.err('shed.fanOnlyMin', 'Must be {cooling, heating} in minutes'); return }
  const lens = eventsByTable.flat().map((e) => e.end - e.start)
  const shortest = lens.length ? Math.min(...lens) : null
  for (const s of ['cooling', 'heating']) {
    const p = `shed.fanOnlyMin.${s}`
    if (!num(c, p, v[s], 0, 180, { int: true, required: true, step: 15 })) continue
    if (shortest !== null && v[s] > shortest - 60) c.warn(p, `Leaves no off time to learn from (the shortest peak is ${shortest} min)`)
  }
}

// X1.3 (addendum D): a base lead longer than (first pre-conditioning peak − earliestStart) can never be tuned —
// with the optimizer on, only the strength changes and the start stays where the base lead puts it.
// X1.3 (addendum D): a base lead longer than (first pre-conditioning peak − earliestStart) can never be tuned —
// with the optimizer on, only the strength changes and the start stays where the base lead puts it.
export function checkLeadRoom(c, cfg, eventsByTable) {
  const opt = cfg.optimizer
  const pc = cfg.precondition
  if (!isObj(opt) || opt.enabled !== true || !isObj(pc) || !isObj(pc.leadMin)) return
  const starts = eventsByTable.flat().filter((e) => e.precondition).map((e) => e.start)
  const earliest = toMin(typeof opt.earliestStart === 'string' ? opt.earliestStart : '04:30')
  if (!starts.length || earliest === null) return
  const first = Math.min(...starts)
  const room = first - earliest
  for (const s of ['cooling', 'heating']) {
    const lead = pc.leadMin[s]
    if (!isNum(lead) || lead <= room) continue
    c.warn(`precondition.leadMin.${s}`, `Longer than auto-tune can adjust (first peak ${clock(first)} − earliest start ${clock(earliest)} = ${room} min): auto-tune will only change the pre-${s === 'cooling' ? 'cool' : 'heat'} strength; the start stays at ${clock(Math.max(0, first - lead))}.`)
  }
}

// ---- optimizer guardrails (§2.10) -----------------------------------------------------------------

export function checkOptimizer(c, cfg, eventsByTable) {
  const opt = cfg.optimizer
  if (opt === undefined) return { earliest: null, peakEnds: [] }
  if (!isObj(opt)) { c.err('optimizer', 'Must be an object'); return { earliest: null, peakEnds: [] } }
  bool(c, 'optimizer.enabled', opt.enabled)
  num(c, 'optimizer.observeDays', opt.observeDays, 0, 14, { int: true })
  const maxOk = num(c, 'optimizer.maxDeltaF', opt.maxDeltaF, 1, 6, { step: 0.5 })
  if (num(c, 'optimizer.minDeltaF', opt.minDeltaF, 1, 6, { step: 0.5 }) && maxOk && opt.minDeltaF > opt.maxDeltaF) {
    c.err('optimizer.minDeltaF', `Must not exceed the maximum (${opt.maxDeltaF}°)`)
  }
  const earliest = hhmm(c, 'optimizer.earliestStart', opt.earliestStart, { required: false })
  const minLeadOk = num(c, 'optimizer.minLeadMin', opt.minLeadMin, 20, 240, { int: true })
  if (opt.maxStepDeltaF !== undefined && opt.maxStepDeltaF !== null && opt.maxStepDeltaF !== 1) c.err('optimizer.maxStepDeltaF', 'Fixed at 1°')
  num(c, 'optimizer.maxStepLeadMin', opt.maxStepLeadMin, 5, 30, { int: true })
  const marginOk = num(c, 'optimizer.marginF', opt.marginF, 0.5, 3)
  if (num(c, 'optimizer.comfyMarginF', opt.comfyMarginF, 0.5, 5) && marginOk && opt.comfyMarginF < opt.marginF) {
    c.err('optimizer.comfyMarginF', `Must be at least the safety margin (${opt.marginF}°)`)
  }
  num(c, 'optimizer.revertCooldownDays', opt.revertCooldownDays, 1, 14, { int: true })
  num(c, 'optimizer.minDaysBetweenOpposite', opt.minDaysBetweenOpposite, 0, 14, { int: true })
  num(c, 'optimizer.dormantDays', opt.dormantDays, 1, 14, { int: true })

  // earliestStart ≤ min(peakStart of any peak window, any day type) − minLeadMin (§2.10; equality is
  // allowed — tuned leads then have no room to grow but stay valid)
  const peakStarts = []
  const peakEnds = []
  for (const evs of eventsByTable) {
    for (const e of evs) peakStarts.push(e.start)
    if (evs.length) peakEnds.push(Math.max(...evs.map((e) => e.end)))
  }
  if (earliest !== null && minLeadOk && peakStarts.length) {
    const first = Math.min(...peakStarts)
    const limit = first - opt.minLeadMin
    if (earliest > limit) c.err('optimizer.earliestStart', `Must be ${clock(Math.max(0, limit))} or earlier (first peak at ${clock(first)} minus ${opt.minLeadMin} min)`)
  }

  if (opt.units !== undefined && opt.units !== null) {
    if (!isObj(opt.units)) c.err('optimizer.units', 'Must be an object keyed by unit id')
    else {
      const ids = new Set((Array.isArray(cfg.units) ? cfg.units : []).map((x) => x && x.id))
      for (const [id, v] of Object.entries(opt.units)) {
        const p = `optimizer.units.${id}`
        if (!ids.has(id)) { c.err(p, 'No unit with this id'); continue }
        if (!isObj(v)) { c.err(p, 'Must be an object'); continue }
        bool(c, `${p}.enabled`, v.enabled)
        const loOk = num(c, `${p}.comfortLowF`, v.comfortLowF, 55, 80)
        const hiOk = num(c, `${p}.comfortHighF`, v.comfortHighF, 65, 90)
        if (loOk && hiOk && v.comfortHighF - v.comfortLowF < 4) c.err(`${p}.comfortHighF`, 'Comfort band must be at least 4° wide')
        num(c, `${p}.sensorOffsetF`, v.sensorOffsetF, -5, 5)
      }
    }
  }
  return { earliest, peakEnds }
}

// ---- sections --------------------------------------------------------------------------------------

/** tou (see header) → {eventsByTable, weekendRows}. */
export function checkTou(c, cfg) {
  const eventsByTable = []
  let weekendRows = null
  if (!isObj(cfg.tou)) c.err('tou', 'Required')
  else {
    const t = cfg.tou
    oneOf(c, 'tou.defaultTier', t.defaultTier, TIERS)
    if (t.weekendDays !== undefined) {
      if (!Array.isArray(t.weekendDays) || t.weekendDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) c.err('tou.weekendDays', 'Use day numbers 0 (Sun) to 6 (Sat)')
      else if (new Set(t.weekendDays).size !== t.weekendDays.length) c.err('tou.weekendDays', 'Duplicate day')
    }
    num(c, 'tou.mergeGapMin', t.mergeGapMin, 0, 120, { int: true })
    for (const k of ['weekday', 'weekendHoliday']) {
      const rows = validateTable(c, `tou.${k}`, t[k], cfg)
      if (k === 'weekendHoliday') weekendRows = rows
      eventsByTable.push(tableChecks(c, `tou.${k}`, rows, cfg))
    }
  }
  return { eventsByTable, weekendRows }
}

/** holidays (see header). */
export function checkHolidays(c, cfg) {
  if (!isObj(cfg.holidays)) c.err('holidays', 'Required')
  else {
    const h = cfg.holidays
    oneOf(c, 'holidays.preset', h.preset, HOLIDAY_PRESETS)
    if (!Array.isArray(h.rows)) c.err('holidays.rows', 'Must be a list')
    else {
      const seen = new Map()
      h.rows.forEach((r, i) => {
        const p = `holidays.rows[${i}]`
        if (!isObj(r)) { c.err(p, 'Must be {date, name}'); return }
        if (!validDate(r.date)) c.err(`${p}.date`, 'Use a real date YYYY-MM-DD')
        else if (seen.has(r.date)) c.err(`${p}.date`, `Duplicate date (also holidays.rows[${seen.get(r.date)}])`)
        else seen.set(r.date, i)
        if (typeof r.name !== 'string' || !r.name.trim()) c.err(`${p}.name`, 'Required')
        else if (r.name.length > 80) c.err(`${p}.name`, 'At most 80 characters')
        bool(c, `${p}.observed`, r.observed)
        if (r.source !== undefined && r.source !== null) oneOf(c, `${p}.source`, r.source, ['preset', 'user'])
      })
    }
  }
}

/** precondition (see header); weekendRows from checkTou for the superOffPeak.weekend boundary warnings. */
export function checkPrecondition(c, cfg, weekendRows) {
  const pc = cfg.precondition
  if (!isObj(pc)) c.err('precondition', 'Required')
  else {
    if (!Array.isArray(pc.modes) || pc.modes.some((m) => !PRECONDITION_MODES.includes(m))) c.err('precondition.modes', `Use any of ${PRECONDITION_MODES.join(', ')}`)
    if (!isObj(pc.deltaF)) c.err('precondition.deltaF', 'Required')
    else for (const s of ['cooling', 'heating']) num(c, `precondition.deltaF.${s}`, pc.deltaF[s], 1, 6, { required: true, step: 0.5 })
    if (!isObj(pc.leadMin)) c.err('precondition.leadMin', 'Required')
    else for (const s of ['cooling', 'heating']) num(c, `precondition.leadMin.${s}`, pc.leadMin[s], 20, 240, { required: true, int: true })
    if (!isObj(pc.clampF)) c.err('precondition.clampF', 'Required')
    else {
      num(c, 'precondition.clampF.coolingMin', pc.clampF.coolingMin, 61, 75, { required: true })
      num(c, 'precondition.clampF.heatingMax', pc.clampF.heatingMax, 66, 90, { required: true })
    }
    num(c, 'precondition.minLeadMin', pc.minLeadMin, 5, 120, { int: true })
    num(c, 'precondition.joinCutoffMin', pc.joinCutoffMin, 0, 60, { int: true })
    if (pc.fan !== undefined && pc.fan !== null && !PRECONDITION_FANS.includes(pc.fan)) {
      c.err('precondition.fan', `Must be one of: ${PRECONDITION_FANS.join(', ')} (or null to leave the fan alone)`)
    }
    num(c, 'precondition.optimumStart', pc.optimumStart, 0, 120, { int: true, step: 5 })
    const sop = pc.superOffPeak
    if (sop !== undefined && sop !== null) {
      if (!isObj(sop)) c.err('precondition.superOffPeak', 'Must be an object')
      else {
        for (const k of Object.keys(sop)) if (k !== 'weekend') c.err(`precondition.superOffPeak.${k}`, 'Unknown field')
        bool(c, 'precondition.superOffPeak.weekend', sop.weekend)
        if (sop.weekend === true && weekendRows) boundaryChecks(c, weekendRows, cfg)
      }
    }
  }
}

/** eventsByTable of the two tables, computed without reporting anything. */
export function tableEvents(cfg) {
  const scratch = collector()
  const evs = []
  if (isObj(cfg?.tou)) {
    for (const k of ['weekday', 'weekendHoliday']) evs.push(tableChecks(scratch, `tou.${k}`, validateTable(scratch, `tou.${k}`, cfg.tou[k], cfg), cfg))
  }
  return evs
}

// units: the core reads id, shed, precondition, order and schedule (malformed schedule rows are dropped by
// tou.unitEntries; a host validates its own schedule entries and device fields).
function checkUnits(c, cfg) {
  if (!Array.isArray(cfg.units)) { c.err('units', 'Must be a list of units'); return }
  const ids = new Map()
  cfg.units.forEach((u, i) => {
    const p = `units[${i}]`
    if (!isObj(u)) { c.err(p, 'Must be a unit object'); return }
    if (typeof u.id !== 'string' || !u.id) c.err(`${p}.id`, 'Required')
    else if (ids.has(u.id)) c.err(`${p}.id`, `Duplicate id (also units[${ids.get(u.id)}])`)
    else ids.set(u.id, i)
    bool(c, `${p}.shed`, u.shed)
    bool(c, `${p}.precondition`, u.precondition)
    if (u.precondition === true && u.shed === false) c.err(`${p}.precondition`, 'Pre-conditioning needs "Off during peak" turned on')
  })
}

// ---- entry points ------------------------------------------------------------------------------------

/** Every section the core reads (see header). */
export function validate(cfg) {
  const c = collector()
  if (!isObj(cfg)) { c.err('', 'Config must be an object'); return { errors: c.errors, warnings: c.warnings } }
  if (!validTimezone(cfg.timezone)) c.err('timezone', 'Unknown time zone (use an IANA name like America/Los_Angeles)')
  checkUnits(c, cfg)
  const { eventsByTable, weekendRows } = checkTou(c, cfg)
  checkHolidays(c, cfg)
  checkPrecondition(c, cfg, weekendRows)
  const sh = cfg.shed
  if (sh !== undefined) {
    if (!isObj(sh)) c.err('shed', 'Must be an object')
    else if (sh.fanOnlyMin !== undefined) checkFanOnly(c, sh.fanOnlyMin, eventsByTable)
  }
  checkOptimizer(c, cfg, eventsByTable)
  checkLeadRoom(c, cfg, eventsByTable)
  return { errors: c.errors, warnings: c.warnings }
}

/** The optimizer section's errors only (see header). */
export function validateOptimizer(cfg) {
  if (!isObj(cfg)) return [{ path: '', message: 'Config must be an object' }]
  const c = collector()
  checkOptimizer(c, cfg, tableEvents(cfg))
  return c.errors
}
