// labels.js — ISOMORPHIC short labels for tiers, modes, fan speeds and daily scheduled settings. Imports
// nothing and uses no Node APIs, so a browser can load it unchanged. tou.plan() words its markers with these.
//
// TIER_LABELS / tierLabel(kind) → 'Peak' | 'Off-peak' | 'Super off-peak' (else the value as a string).
// MODE_LABELS / modeLabel(mode) → 'Auto' | 'Dry' | 'Cool' | 'Heat' | 'Fan' (case-insensitive; else the value;
//   '' for none).
// FAN_LABELS / fanLabel(fan) → 'Low', 'Medium (auto)', 'Speed 3', … (case-insensitive; else the value; '' for none).
// settingLabel(fields, {fan: 'plain'|'word'|false, season?}?) → "Heat 70° · Low" / "Heat 70° · fan Low" / "Heat 70°"
//   (fan false); an Off entry "Off"; '' for no fields. Temperatures: one decimal at most, U+2212 for a negative number.
//   An entry may keep the mode (power ON, no mode) and carry the setpoint pair coolTo / heatTo instead of temp (with or
//   without a mode). One label rule: values that carry a mode read in the explicit form ("Heat 68° · Low"); config
//   fields given a season ('cooling' | 'heating'; null/absent = not known) read in the verb form:
//     {ON, coolTo 74, heatTo 68, fan LOW}   "cool to 74° / heat to 68° · Low"   heating "heat to 68° · Low"
//     {ON, heatTo 68}                       "heat to 68°"                       cooling "keep mode" (no slot for it)
//     {ON, temp 70} / {ON}                  "keep mode · 70°" / "keep mode"     (any season)
//     {ON, mode HEAT, heatTo 70, coolTo 76} "Heat 70° (cool to 76° if switched)" heating "Heat 70°", cooling
//                                           "Heat · cool to 76° if switched"
//     {ON, mode HEAT, temp 70, fan LOW}     "Heat 70° · Low" whatever the season (an entry without the pair that names
//                                           a mode reads exactly as before)
// entryLabel(fields, opts?) → "On · Heat 70° · Low" / "On · heat to 68°" / "On · keep mode" / "Off" (settingLabel with the
//   power word in front; "On" alone when nothing else is set).
// daysLabel(days) → '' | 'weekdays' | 'weekends' (the day types of a daily entry, see validate.js ENTRY_DAYS).

const MINUS = '−'

export const TIER_LABELS = { peak: 'Peak', off_peak: 'Off-peak', super_off_peak: 'Super off-peak' }
export const MODE_LABELS = { AUTO: 'Auto', DRY: 'Dry', COOL: 'Cool', HEAT: 'Heat', FAN: 'Fan' }
export const FAN_LABELS = {
  LOW: 'Low', LOW_AUTO: 'Low (auto)', MEDIUM: 'Medium', MEDIUM_AUTO: 'Medium (auto)', HIGH: 'High',
  HIGH_AUTO: 'High (auto)', AUTO: 'Auto', QUIET: 'Quiet', DIFFUSE: 'Diffuse', MIDDLE: 'Middle',
  1: 'Speed 1', 2: 'Speed 2', 3: 'Speed 3', 4: 'Speed 4', 5: 'Speed 5',
}

function isNum(n) { return n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) }

function num(n) {
  if (!isNum(n)) return ''
  const r = Math.round(Number(n) * 10) / 10
  if (r === 0) return '0'
  return (r < 0 ? MINUS : '') + String(Math.abs(r))
}

function up(v) { return String(v ?? '').toUpperCase() }

export function tierLabel(kind) { return TIER_LABELS[kind] ?? String(kind ?? '') }
export function modeLabel(mode) {
  if (mode == null || mode === '') return ''
  return MODE_LABELS[String(mode).toUpperCase()] ?? String(mode)
}
export function fanLabel(fan) {
  if (fan == null || fan === '') return ''
  return FAN_LABELS[String(fan).toUpperCase()] ?? String(fan)
}

// The setpoint pair of an entry (Addendum F): [slot key, season, verb] in label order.
const SLOTS = [['coolTo', 'cooling', 'cool'], ['heatTo', 'heating', 'heat']]
function deg(n) { return `${num(n)}°` }
function seasonOf(mode) { const m = up(mode); return m === 'HEAT' ? 'heating' : m === 'COOL' || m === 'DRY' ? 'cooling' : null }

// The mode/setpoint part of settingLabel (see header).
function setpointText(fields, season) {
  const pair = SLOTS.filter(([k]) => isNum(fields[k]))
  const hasMode = fields.mode != null && fields.mode !== ''
  if (!pair.length && (hasMode || up(fields.power) !== 'ON')) return [modeLabel(fields.mode), isNum(fields.temp) ? deg(fields.temp) : ''].filter(Boolean).join(' ')
  const slot = (s) => pair.find(([, ss]) => ss === s)
  const verbTo = ([k, , verb]) => `${verb} to ${deg(fields[k])}`
  if (!hasMode) {
    if (!pair.length) return isNum(fields.temp) ? `keep mode · ${deg(fields.temp)}` : 'keep mode'
    if (season == null) return pair.map(verbTo).join(' / ')
    return slot(season) ? verbTo(slot(season)) : 'keep mode'
  }
  const own = seasonOf(fields.mode)
  const ownTxt = [modeLabel(fields.mode), slot(own) ? deg(fields[slot(own)[0]]) : ''].filter(Boolean).join(' ')
  const others = pair.filter(([, s]) => s !== own)
  if (season == null) return others.length ? `${ownTxt} (${others.map(verbTo).join(' / ')} if switched)` : ownTxt
  if (season !== own && slot(season)) return `${modeLabel(fields.mode)} · ${verbTo(slot(season))} if switched`
  return ownTxt
}

/** "Heat 70° · Low" / "heat to 68° · Low" (see header). */
export function settingLabel(fields, { fan = 'plain', season } = {}) {
  if (!fields || typeof fields !== 'object') return ''
  if (up(fields.power) === 'OFF') return 'Off'
  const f = fan !== false && fields.fan != null && fields.fan !== '' ? `${fan === 'word' ? 'fan ' : ''}${fanLabel(fields.fan)}` : ''
  return [setpointText(fields, season), f].filter(Boolean).join(' · ')
}

/** "On · Heat 70° · Low" / "Off" (see header). */
export function entryLabel(fields, opts = {}) {
  if (!fields || typeof fields !== 'object') return ''
  if (up(fields.power) === 'OFF') return 'Off'
  const rest = settingLabel(fields, opts)
  return rest ? `On · ${rest}` : 'On'
}

/** '' | 'weekdays' | 'weekends' (addendum D E1.7). */
export function daysLabel(days) {
  return days === 'weekday' ? 'weekdays' : days === 'weekend' ? 'weekends' : ''
}
