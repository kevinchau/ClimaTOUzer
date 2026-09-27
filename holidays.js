// holidays.js — utility holiday rows (spec §5.3, §9.3). PURE: no I/O, no clock.
//
// The rate model uses ONLY `config.holidays.rows` ({date, name, observed, source}). Presets generate
// rows; `seed` merges them without duplicates and never touches `source:'user'` rows.
//
// Observed rule (fixed-date holidays only): Saturday → Friday before, Sunday → Monday after, row
// flagged `observed:true` and only the observed date is listed (the actual date is a weekend).
// `generate(preset, year)` returns exactly the rows whose (observed) date falls inside `year`:
// New Year's Day of year+1 falling on a Saturday is observed Dec 31 of `year` and belongs to
// `year` (generate(…, 2027) includes 2027-12-31); likewise a Saturday Jan 1 of `year` is NOT in
// generate(…, year) (it belongs to year−1).

import { addDays, dowOf, parseDate } from './tz.js'

export const PRESETS = ['us-federal', 'ca-utility-8', 'none']

export const PRESET_LABELS = {
  'us-federal': 'US federal holidays',
  'ca-utility-8': 'California utility (8 holidays)',
  none: 'No holidays',
}

// Holiday catalogue. kind 'fixed' = month/day with observed shift; 'nth' = nth weekday of month
// (n = −1 ⇒ last). dow: 0 = Sunday … 6 = Saturday.
const H = {
  newYear: { name: "New Year's Day", kind: 'fixed', month: 1, day: 1 },
  mlk: { name: 'Martin Luther King Jr. Day', kind: 'nth', month: 1, dow: 1, n: 3 },
  presidents: { name: "Presidents' Day", kind: 'nth', month: 2, dow: 1, n: 3 },
  memorial: { name: 'Memorial Day', kind: 'nth', month: 5, dow: 1, n: -1 },
  juneteenth: { name: 'Juneteenth', kind: 'fixed', month: 6, day: 19 },
  independence: { name: 'Independence Day', kind: 'fixed', month: 7, day: 4 },
  labor: { name: 'Labor Day', kind: 'nth', month: 9, dow: 1, n: 1 },
  columbus: { name: 'Columbus Day', kind: 'nth', month: 10, dow: 1, n: 2 },
  veterans: { name: 'Veterans Day', kind: 'fixed', month: 11, day: 11 },
  thanksgiving: { name: 'Thanksgiving Day', kind: 'nth', month: 11, dow: 4, n: 4 },
  christmas: { name: 'Christmas Day', kind: 'fixed', month: 12, day: 25 },
}

const PRESET_KEYS = {
  'us-federal': ['newYear', 'mlk', 'presidents', 'memorial', 'juneteenth', 'independence', 'labor', 'columbus', 'veterans', 'thanksgiving', 'christmas'],
  'ca-utility-8': ['newYear', 'presidents', 'memorial', 'independence', 'labor', 'veterans', 'thanksgiving', 'christmas'],
  none: [],
}

function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function nthWeekday(year, month, dow, n) {
  if (n > 0) {
    const first = ymd(year, month, 1)
    const offset = (dow - dowOf(first) + 7) % 7
    return addDays(first, offset + (n - 1) * 7)
  }
  const nextFirst = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1)
  const last = addDays(nextFirst, -1)
  return addDays(last, -((dowOf(last) - dow + 7) % 7))
}

/** Actual + observed date of one holiday occurrence in `year` (fixed dates may shift across years). */
function occurrence(h, year) {
  if (h.kind === 'nth') return { date: nthWeekday(year, h.month, h.dow, h.n), observed: false }
  const actual = ymd(year, h.month, h.day)
  const dow = dowOf(actual)
  if (dow === 6) return { date: addDays(actual, -1), observed: true }
  if (dow === 0) return { date: addDays(actual, 1), observed: true }
  return { date: actual, observed: false }
}

/** Rows for `preset` whose (observed) date lies in `year`, sorted by date. Unknown preset ⇒ []. */
export function generate(preset, year) {
  const keys = PRESET_KEYS[preset]
  const y = Math.trunc(Number(year))
  if (!keys || !Number.isFinite(y)) return []
  const rows = []
  for (const key of keys) {
    const h = H[key]
    // Look at the occurrence in year−1, year and year+1 so shifts across Jan 1 land in the right year.
    for (const yy of [y - 1, y, y + 1]) {
      const occ = occurrence(h, yy)
      if (occ.date.slice(0, 4) === String(y).padStart(4, '0')) {
        rows.push({ date: occ.date, name: h.name, observed: occ.observed, source: 'preset' })
      }
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return rows
}

function rowsOf(holidaysCfg) {
  return Array.isArray(holidaysCfg?.rows) ? holidaysCfg.rows : []
}

/**
 * Merge `generate(preset ?? holidaysCfg.preset, year)` into the rows. A generated row is added only
 * when no existing row (any source) has the same date; existing rows are never modified.
 * Returns NEW arrays (input untouched): {rows (sorted by date), added}.
 */
export function seed(holidaysCfg, year, preset) {
  const existing = rowsOf(holidaysCfg)
  const p = preset ?? holidaysCfg?.preset ?? 'us-federal'
  const have = new Set(existing.map((r) => r && r.date))
  const added = []
  for (const row of generate(p, year)) {
    if (have.has(row.date)) continue
    have.add(row.date)
    added.push(row)
  }
  const rows = [...existing, ...added].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { rows, added }
}

/** The row for `date`, or null. */
export function isHoliday(holidaysCfg, date) {
  for (const r of rowsOf(holidaysCfg)) if (r && r.date === date) return r
  return null
}

/**
 * Warning text when any day in [today, today+60] falls in a year that has zero rows, else null.
 * Suppressed when the preset is 'none' (no holidays is then the user's explicit choice).
 */
export function missingYearWarning(holidaysCfg, todayDate) {
  parseDate(todayDate)
  if (holidaysCfg?.preset === 'none') return null
  const rows = rowsOf(holidaysCfg)
  const years = [...new Set([todayDate.slice(0, 4), addDays(todayDate, 60).slice(0, 4)])]
  const missing = years.filter((y) => !rows.some((r) => r && typeof r.date === 'string' && r.date.startsWith(y + '-')))
  if (!missing.length) return null
  const y = missing[0]
  const label = PRESET_LABELS[holidaysCfg?.preset] ?? PRESET_LABELS['us-federal']
  return `No holidays listed for ${y} — peak pricing would apply on them. Add ${label} for ${y}.`
}
