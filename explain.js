// explain.js — ISOMORPHIC wording of the optimizer's decisions: one-sentence rationales for a tuning change,
// the hold chip texts and the parameter labels. Imports nothing and uses no Node APIs, so a browser can load it unchanged;
// optimizer.js words every proposal with it, and a host words its own logs and screens with the same functions so they
// say exactly the same thing.
//
// Conventions: temperatures "66.5°" (one decimal, trailing .0 dropped); negative numbers and cooling deltas use U+2212
// "−"; clock labels are 24 h without a leading zero ("5:00", "15:00"). Missing inputs degrade to shorter sentences; the
// output never contains "undefined" or "NaN".
//
// `names` (unit display names) may be: a string (the name), a map {unitId: name}, or omitted (falls back to the unit id).
// `tz` may be an object with formatLocal(ms, preset) (tz.js makeTz()), an IANA zone string, or omitted; it is only used
// when evidence carries epoch-ms instants.
//
// num(n, digits = 1) → "66.5" · temp(n) → "66.5°" · clockLabel(min) → "5:00"
// deltaLabel(season, deltaF) → "+3°" / "−3°" · startLabel(peakStartMin = 420, leadMin) → "4:30"
// paramLabel({season, deltaF, leadMin, peakStartMin}) → "+4° from 5:00"
// valueLabel(param, value, {season, peakStartMin}) → "+4°" | "4:30" | "paused"/"active"
// changeSummary({season, param, from, to, peakStartMin}) → "Pre-heat +3° → +4°" · "Pre-heat start 5:00 → 4:30"
// rationale(rule, evidence, names?, tz?) → one sentence (≤ ~120 chars) for rules R1_DELTA, R1_LEAD, R5, R3, R2_DELTA,
//   R2_LEAD, R4A, R4B, RESET, REVERT (unknown rule ⇒ "<Unit>: <change summary>").
// holdText(code, ctx?) → the hold chip for an optimizer hold code (optimizer.HOLD_CODES, plus 'dry_run' / 'observe').
//   The water season (a host's hot-water tank): at_limit reads the scald limit (ctx.ceilingF), no_sensor "… reports
//   neither its tank temperature nor a hot-water level — auto-tune can't learn; pre-heat stays at +15° from 4:00", and the
//   R1_DELTA / R2_DELTA rationales speak of "<Unit>'s tank" ("Water heater's tank dropped to 103° during Tue's morning
//   peak (floor 105°). Pre-heat +5° → +10° from today 4:00 AM.").
// seasonWords(season) → the season's word table {heating, verb:'Pre-heat', noun, sign, edge:'floor', comfort, …};
// nameOf(names, unitId) → the display name; plural(word, n) — shared with a host's other texts.
//
// Evidence fields read by rationale(rule, ev, names, tz) — all optional unless noted:
//   common : unit (id), season 'heating'|'cooling' (default heating), param, from, to,
//            peakStartMin (default 420 = 07:00), fromLabel ("today 5:00 AM") | applyWord
//            ('today'|'tomorrow') + startLabel | applyAt (ms, needs tz)
//   R1_DELTA: minRoom (heating) / maxRoom (cooling), band [L, H], dayLabel ("Tue"), eventLabel
//   R1_LEAD : roomAtPeak, target
//   R5      : overrideDays, ofDays, overrideVerb ("turned back on"), via ("Apple Home"), eventLabel
//   R3      : forecastPeakF, predEndF, dayWord ("Tomorrow"), windowLabel ("7–10 AM"), peakEndLabel ("10:00")
//   R2_DELTA: minRoom/maxRoom, band [L, H] or marginF, n (peaks)
//   R2_LEAD : reachedMinBeforePeak
//   R4A     : days;  R4B: deltaF, leadMin;  RESET: reason 'base' | undefined, baseDeltaF;  REVERT: lockedLabel

const MINUS = '−'

function isNum(n) { return n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) }

/** 66.5 → "66.5", 68 → "68", −1.25 → "−1.3" (one decimal max, U+2212 minus). */
export function num(n, digits = 1) {
  if (!isNum(n)) return ''
  const f = 10 ** digits
  const r = Math.round(Number(n) * f) / f
  if (Object.is(r, -0) || r === 0) return '0'
  return (r < 0 ? MINUS : '') + String(Math.abs(r))
}

/** 66.5 → "66.5°" ('' when missing). */
export function temp(n) { return isNum(n) ? `${num(n)}°` : '' }

export function nameOf(names, unitId) {
  if (typeof names === 'string' && names) return names
  if (names && typeof names === 'object') {
    if (unitId != null && typeof names[unitId] === 'string') return names[unitId]
    if (typeof names.unit === 'string') return names.unit
    if (typeof names.name === 'string') return names.name
  }
  return unitId ? String(unitId) : 'This unit'
}

export function seasonWords(season) {
  const heating = season !== 'cooling'
  return heating
    ? { heating, verb: 'Pre-heat', noun: 'pre-heat', sign: '+', edge: 'floor', comfort: 'too cold', moved: 'dropped', colder: 'colder', bound: '≥', side: 'above' }
    : { heating, verb: 'Pre-cool', noun: 'pre-cool', sign: MINUS, edge: 'ceiling', comfort: 'too warm', moved: 'rose', colder: 'warmer', bound: '≤', side: 'below' }
}

export function plural(word, n) { return Number(n) === 1 ? word : word + 's' }

/** minutes after midnight → "5:00" (wraps into 0..1439). */
export function clockLabel(min) {
  if (!isNum(min)) return ''
  const m = ((Math.round(Number(min)) % 1440) + 1440) % 1440
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** Signed precondition amount: heating +3 → "+3°", cooling 3 → "−3°". */
export function deltaLabel(season, deltaF) {
  if (!isNum(deltaF)) return ''
  return `${seasonWords(season).sign}${num(Math.abs(Number(deltaF)))}°`
}

/** Start clock label for a lead: peakStartMin 420, leadMin 150 → "4:30". */
export function startLabel(peakStartMin = 420, leadMin) {
  if (!isNum(leadMin)) return ''
  return clockLabel((isNum(peakStartMin) ? Number(peakStartMin) : 420) - Number(leadMin))
}

/** "+4° from 5:00" (heating) / "−3° from 5:00" (cooling); "+4°" when leadMin is null. */
export function paramLabel({ season, deltaF, leadMin, peakStartMin = 420 } = {}) {
  const d = deltaLabel(season, deltaF)
  const s = startLabel(peakStartMin, leadMin)
  return [d, s ? `from ${s}` : ''].filter(Boolean).join(' ')
}

/** Label of one parameter value: deltaF → "+4°", leadMin → start "4:30", suspended → "paused"/"active". */
export function valueLabel(param, value, { season, peakStartMin = 420 } = {}) {
  if (param === 'deltaF') return deltaLabel(season, value)
  if (param === 'leadMin') return startLabel(peakStartMin, value)
  if (param === 'suspended') return value ? 'paused' : 'active'
  return isNum(value) ? num(value) : String(value ?? '')
}

/** ChangeDTO.summary: "Pre-heat +3° → +4°" · "Pre-heat start 5:00 → 4:30" · "Pre-heat paused". */
export function changeSummary({ season, param, from, to, peakStartMin = 420 } = {}) {
  const W = seasonWords(season)
  if (param === 'suspended') return `${W.verb} ${to ? 'paused' : 'resumed'}`
  if (param === 'leadMin') return `${W.verb} start ${startLabel(peakStartMin, from)} → ${startLabel(peakStartMin, to)}`
  return `${W.verb} ${deltaLabel(season, from)} → ${deltaLabel(season, to)}`
}

function fmtInstant(tz, ms, preset = 'time') {
  if (!isNum(ms)) return ''
  if (tz && typeof tz.formatLocal === 'function') return tz.formatLocal(Number(ms), preset)
  try {
    const f = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: typeof tz === 'string' ? tz : 'America/Los_Angeles' })
    return f.format(Number(ms)).replace(/[\u202f\u2009\u00a0]/g, ' ')
  } catch { return '' }
}

function fromWhen(ev, tz) {
  if (ev.fromLabel) return ` from ${ev.fromLabel}`
  const time = isNum(ev.applyAt) && tz ? fmtInstant(tz, ev.applyAt) : (ev.startLabel || '')
  const parts = [ev.applyWord, time].filter(Boolean)
  return parts.length ? ` from ${parts.join(' ')}` : ''
}

/**
 * One-sentence (≤ ~120 chars) rationale for an optimizer change. Rules: R1_DELTA, R1_LEAD, R5, R3,
 * R2_DELTA, R2_LEAD, R4A, R4B, RESET, REVERT (unknown rule ⇒ "<Unit>: <change summary>").
 */
export function rationale(rule, evidence, names, tz) {
  const ev = evidence || {}
  const u = nameOf(names, ev.unit)
  const W = seasonWords(ev.season)
  const pk = isNum(ev.peakStartMin) ? Number(ev.peakStartMin) : 420
  const dl = (v) => deltaLabel(ev.season, v)
  const band = Array.isArray(ev.band) ? ev.band : null
  const edge = band ? (W.heating ? band[0] : band[1]) : null
  const worst = W.heating ? ev.minRoom : ev.maxRoom
  const eventLabel = ev.eventLabel || 'morning peak'
  const water = ev.season === 'water' // a hot-water tank: its reading is the tank's
  const subj = water ? `${u}'s tank` : u
  switch (rule) {
    case 'R1_DELTA': {
      const when = ev.dayLabel ? `${ev.dayLabel}'s ${eventLabel}` : `the last ${eventLabel}`
      const s1 = isNum(worst)
        ? `${subj} ${W.moved} to ${temp(worst)} during ${when}${isNum(edge) ? ` (${W.edge} ${temp(edge)})` : ''}.`
        : water ? `${u} ran low on hot water during ${when}.` : `${u} left its comfort band during ${when}.`
      return `${s1} ${W.verb} ${dl(ev.from)} → ${dl(ev.to)}${fromWhen(ev, tz)}.`
    }
    case 'R1_LEAD': {
      const s1 = isNum(ev.roomAtPeak) && isNum(ev.target)
        ? `${u} only reached ${temp(ev.roomAtPeak)} of its ${temp(ev.target)} target by ${clockLabel(pk)}.`
        : `${u} did not reach its target by ${clockLabel(pk)}.`
      return `${s1} ${W.verb} now starts ${startLabel(pk, ev.to)} (was ${startLabel(pk, ev.from)}).`
    }
    case 'R5': {
      const count = isNum(ev.overrideDays) && isNum(ev.ofDays) ? ` during ${ev.overrideDays} of the last ${ev.ofDays} ${plural(eventLabel, ev.ofDays)}` : ` during recent ${eventLabel}s`
      const via = ev.via ? ` (${ev.via})` : ''
      return `${u} was ${ev.overrideVerb || 'turned back on'}${count}${via}. Treating that as '${W.comfort}': ${dl(ev.from)} → ${dl(ev.to)}.`
    }
    case 'R3': {
      const day = ev.dayWord || 'Tomorrow'
      const win = ev.windowLabel ? ` ${ev.windowLabel}` : ''
      const fc = isNum(ev.forecastPeakF) ? ` is ${num(ev.forecastPeakF)}°F` : ' is'
      const s1 = `${day}${win} forecast${fc}, ${W.colder} than any recent ${eventLabel.replace(/ peak$/, '')}.`
      const end = ev.peakEndLabel || clockLabel(pk + 180)
      const s2 = isNum(ev.predEndF)
        ? `At ${dl(ev.from)} the model predicts ${temp(ev.predEndF)} by ${end}, so ${dl(ev.to)}.`
        : `The model says ${dl(ev.to)} is needed.`
      return `${s1} ${s2}`
    }
    case 'R2_DELTA': {
      const margin = isNum(ev.marginF) ? Number(ev.marginF) : (isNum(worst) && isNum(edge) ? Math.abs(Number(worst) - Number(edge)) : null)
      const n = isNum(ev.n) ? ev.n : 3
      const s1 = isNum(worst)
        ? `${subj} stayed ${W.bound} ${temp(worst)} through the last ${n} peaks${isNum(margin) && !water ? `, ${temp(margin)} ${W.side} your ${W.edge}` : ''}.`
        : water ? `${u} had hot water through the last ${n} peaks.` : `${u} stayed comfortable through the last ${n} peaks.`
      return `${s1} Trying less ${W.noun}: ${dl(ev.from)} → ${dl(ev.to)}.`
    }
    case 'R2_LEAD': {
      const s1 = isNum(ev.reachedMinBeforePeak)
        ? `${u} reached its target ~${Math.round(Number(ev.reachedMinBeforePeak))} min before peak on recent mornings.`
        : `${u} reached its target early on recent mornings.`
      return `${s1} Starting later: ${startLabel(pk, ev.from)} → ${startLabel(pk, ev.to)}.`
    }
    case 'R4A': {
      const days = isNum(ev.days) ? ev.days : 3
      return `${u} has been off for ${days} ${plural('day', days)}. ${W.verb} paused until it's used again.`
    }
    case 'R4B': {
      const p = paramLabel({ season: ev.season, deltaF: ev.deltaF, leadMin: ev.leadMin, peakStartMin: pk })
      return `${u} is in use again. ${W.verb} resumed${p ? ` at ${p}` : ''}.`
    }
    case 'RESET': {
      if (ev.reason === 'base') {
        const d = dl(ev.baseDeltaF ?? ev.to)
        return `Default ${W.noun} changed${d ? ` to ${d}` : ''}, so auto-tuned values were cleared.`
      }
      const p = paramLabel({ season: ev.season, deltaF: ev.deltaF, leadMin: ev.leadMin, peakStartMin: pk })
      return `${u} ${W.noun} reset to the default${p ? ` ${p}` : ''}.`
    }
    case 'REVERT': {
      const v = valueLabel(ev.param, ev.to, { season: ev.season, peakStartMin: pk })
      return `${u} ${W.noun} back to ${v || 'its previous value'}${ev.lockedLabel ? ` · optimizer locked for ${ev.lockedLabel}` : ''}`
    }
    default:
      return `${u}: ${changeSummary({ ...ev, peakStartMin: pk })}`
  }
}

/**
 * Hold chip text (addendum §5.13 codes + addendum C forced_by_master). ctx (all optional): unitName, n, need, have,
 * paramLabel, byName (the master), sinceLabel, dayLabel, untilLabel, lowF, highF, season, days, daysLeft, dir ('up'|'down': the frozen
 * direction; 'up' reads "More pre-heat/pre-cool", or "Raising" without a season; else "Lowering").
 */
export function holdText(code, ctx = {}) {
  const c = ctx || {}
  const W = seasonWords(c.season)
  const pl = c.paramLabel || 'current settings'
  switch (code) {
    case 'off': return `Auto-tune off for ${c.unitName || 'this unit'}`
    case 'not_live': return 'Learning starts when the schedule is live'
    case 'no_season': return 'Not heating or cooling lately — nothing to tune'
    case 'learning': {
      const n = isNum(c.n) ? Number(c.n) : 0
      return `${n} ${plural('morning', n)} at ${pl}${c.sinceLabel ? ` since ${c.sinceLabel}` : ''}`
    }
    case 'forced_by_master': return `${c.unitName || 'This unit'} was forced by ${c.byName || 'the master'}${c.dayLabel ? ` on ${c.dayLabel}` : ''} — not counted`
    case 'low_data': return 'Partial data yesterday'
    case 'locked': return `Locked ${c.dayLabel || 'today'} (you reverted)`
    case 'already': return `Already adjusted from ${c.dayLabel ? `${c.dayLabel}'s` : "yesterday's"} data`
    case 'tight': {
      const v = W.heating ? c.lowF : c.highF
      return `Tight but in band${isNum(v) ? ` (${W.heating ? 'low' : 'high'} ${temp(v)})` : ''} — holding`
    }
    case 'need_n': return `Need ${isNum(c.need) ? c.need : 3} comfortable peaks at ${pl} (have ${isNum(c.have) ? c.have : 0})`
    case 'cooldown': return `Cooldown after your revert${c.untilLabel ? ` until ${c.untilLabel}` : ''}`
    case 'hysteresis': return 'Waiting a few days before reversing direction'
    case 'veto': return `Forecast model says ${c.paramLabel || 'the current setting'} is still needed`
    case 'sensor': return 'Room sensor looked stuck or jumpy while off — not lowering'
    case 'at_limit': return c.season === 'water'
      ? `At the ${isNum(c.ceilingF) ? temp(c.ceilingF) : '125°'} scald limit — tell the app if a mixing valve is installed`
      : `At maximum ${W.noun} — raise the max, widen the band, or opt out`
    case 'no_sensor': return `${c.unitName || 'The water heater'} reports neither its tank temperature nor a hot-water level — auto-tune can't learn; pre-heat stays at ${pl}`
    case 'frozen': {
      const what = c.dir !== 'up' ? 'Lowering' : c.season === 'heating' || c.season === 'cooling' ? `More ${W.noun}` : 'Raising'
      return `${what} paused after two reverts${c.untilLabel ? ` until ${c.untilLabel}` : ''}`
    }
    case 'suspended': return `Paused — off for ${isNum(c.days) ? c.days : 3} days`
    case 'dry_run': return 'Dry run — nothing is being changed'
    case 'observe': return `Observing${isNum(c.daysLeft) ? ` · ${c.daysLeft} ${plural('day', c.daysLeft)} left` : ''}`
    case 'guardrail': return 'Held by a guardrail'
    default: return code ? String(code) : ''
  }
}
