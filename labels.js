// labels.js — ISOMORPHIC short labels for tiers, modes, fan speeds and daily scheduled settings. Imports
// nothing and uses no Node APIs, so a browser can load it unchanged. tou.plan() words its markers with these.
//
// TIER_LABELS / tierLabel(kind) → 'Peak' | 'Off-peak' | 'Super off-peak' (else the value as a string).
// MODE_LABELS / modeLabel(mode) → 'Auto' | 'Dry' | 'Cool' | 'Heat' | 'Fan' (case-insensitive; else the value;
//   '' for none).
// FAN_LABELS / fanLabel(fan) → 'Low', 'Medium (auto)', 'Speed 3', … (case-insensitive; else the value; '' for none).
// settingLabel(fields, {fan: 'plain'|'word'|false}?) → "Heat 70° · Low" / "Heat 70° · fan Low" / "Heat 70°"
//   (fan false); an Off entry "Off"; '' for no fields. Temperatures: one decimal at most, U+2212 for a negative number.
// entryLabel(fields, opts?) → "On · Heat 70° · Low" / "Off" (settingLabel with the power word in front; "On" alone
//   when nothing else is set).
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

/** "Heat 70° · Low" (see header). */
export function settingLabel(fields, { fan = 'plain' } = {}) {
  if (!fields || typeof fields !== 'object') return ''
  if (up(fields.power) === 'OFF') return 'Off'
  const modeTemp = [modeLabel(fields.mode), isNum(fields.temp) ? `${num(fields.temp)}°` : ''].filter(Boolean).join(' ')
  const f = fan !== false && fields.fan != null && fields.fan !== '' ? `${fan === 'word' ? 'fan ' : ''}${fanLabel(fields.fan)}` : ''
  return [modeTemp, f].filter(Boolean).join(' · ')
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
