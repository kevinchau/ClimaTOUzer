// holidays.test.js — presets, observed shifts (incl. 2027-12-31), seed merge, user rows untouched.
// Re-runs itself under TZ=UTC and TZ=Asia/Tokyo (addendum §8: every suite is process-TZ independent).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PRESETS, generate, seed, isHoliday, missingYearWarning } from '../holidays.js'
import { dowOf } from '../tz.js'

const SELF = fileURLToPath(import.meta.url)
if (process.env.FK_TZ_CHILD !== '1') {
  for (const zone of ['UTC', 'Asia/Tokyo']) {
    test(`holidays suite passes with process TZ=${zone}`, () => {
      const env = { ...process.env, TZ: zone, FK_TZ_CHILD: '1' }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 120000 })
      assert.equal(r.status, 0, `child under TZ=${zone} failed:\n${r.stdout}\n${r.stderr}`)
    })
  }
}

const dates = (rows) => rows.map((r) => r.date)
const byDate = (rows, d) => rows.find((r) => r.date === d)

test('PRESETS', () => {
  assert.deepEqual(PRESETS, ['us-federal', 'ca-utility-8', 'none'])
})

test('us-federal 2026: 11 rows with the right dates', () => {
  const rows = generate('us-federal', 2026)
  assert.deepEqual(dates(rows), [
    '2026-01-01', // New Year (Thu)
    '2026-01-19', // MLK, 3rd Mon Jan
    '2026-02-16', // Presidents, 3rd Mon Feb
    '2026-05-25', // Memorial, last Mon May
    '2026-06-19', // Juneteenth (Fri)
    '2026-07-03', // Independence observed (Jul 4 is Sat)
    '2026-09-07', // Labor, 1st Mon Sep
    '2026-10-12', // Columbus, 2nd Mon Oct
    '2026-11-11', // Veterans (Wed)
    '2026-11-26', // Thanksgiving, 4th Thu Nov
    '2026-12-25', // Christmas (Fri)
  ])
  assert.equal(byDate(rows, '2026-07-03').observed, true)
  assert.equal(byDate(rows, '2026-07-03').name, 'Independence Day')
  assert.equal(byDate(rows, '2026-11-26').observed, false)
  for (const r of rows) assert.equal(r.source, 'preset')
})

test('spec §5.3 observed test vectors', () => {
  const y26 = generate('us-federal', 2026)
  const y27 = generate('us-federal', 2027)
  assert.equal(byDate(y26, '2026-07-03')?.observed, true)
  assert.equal(byDate(y27, '2027-06-18')?.observed, true) // Juneteenth Sat → Fri
  assert.equal(byDate(y27, '2027-07-05')?.observed, true) // Independence Sun → Mon
  assert.equal(byDate(y27, '2027-12-24')?.observed, true) // Christmas Sat → Fri
  assert.equal(byDate(y27, '2027-12-31')?.observed, true) // New Year 2028 (Sat) → Dec 31 2027
  assert.equal(byDate(y27, '2027-12-31').name, "New Year's Day")
  assert.equal(y27.length, 12) // 11 + the early New Year's Day
})

test('a Saturday Jan 1 belongs to the previous year', () => {
  const y28 = generate('us-federal', 2028)
  assert.equal(byDate(y28, '2028-01-01'), undefined)
  assert.equal(byDate(y28, '2027-12-31'), undefined)
  assert.ok(dates(y28).every((d) => d.startsWith('2028-')))
  assert.equal(y28.length, 10)
})

test('Sunday fixed dates shift to Monday; weekday fixed dates stay', () => {
  // Christmas 2022 was a Sunday → Mon Dec 26
  assert.equal(byDate(generate('us-federal', 2022), '2022-12-26')?.observed, true)
  // Veterans Day 2029 is a Sunday → Mon Nov 12
  assert.equal(byDate(generate('us-federal', 2029), '2029-11-12')?.observed, true)
  for (const y of [2026, 2027, 2028, 2029, 2030]) {
    for (const r of generate('us-federal', y)) assert.ok(![0, 6].includes(dowOf(r.date)), `${r.date} on a weekend`)
  }
})

test('floating holidays land on the right weekday', () => {
  for (const y of [2026, 2027, 2030, 2031]) {
    const rows = generate('us-federal', y)
    const get = (name) => rows.find((r) => r.name === name).date
    for (const n of ['Martin Luther King Jr. Day', "Presidents' Day", 'Memorial Day', 'Labor Day', 'Columbus Day']) assert.equal(dowOf(get(n)), 1, `${n} ${y}`)
    assert.equal(dowOf(get('Thanksgiving Day')), 4)
    const mem = get('Memorial Day')
    assert.ok(Number(mem.slice(8)) >= 25, 'Memorial Day is the last Monday')
    const tg = Number(get('Thanksgiving Day').slice(8))
    assert.ok(tg >= 22 && tg <= 28)
  }
})

test('ca-utility-8 has the eight utility holidays', () => {
  const rows = generate('ca-utility-8', 2026)
  assert.deepEqual(rows.map((r) => r.name), ["New Year's Day", "Presidents' Day", 'Memorial Day', 'Independence Day', 'Labor Day', 'Veterans Day', 'Thanksgiving Day', 'Christmas Day'])
  assert.deepEqual(dates(rows), ['2026-01-01', '2026-02-16', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-11', '2026-11-26', '2026-12-25'])
  assert.equal(generate('ca-utility-8', 2027).length, 9) // includes 2027-12-31
})

test("'none' and unknown presets generate nothing", () => {
  assert.deepEqual(generate('none', 2026), [])
  assert.deepEqual(generate('bogus', 2026), [])
})

test('seed merges without duplicates and never touches user rows', () => {
  const user = { date: '2026-11-27', name: 'Day after Thanksgiving', observed: false, source: 'user' }
  const clash = { date: '2026-12-25', name: 'Xmas (mine)', observed: false, source: 'user' }
  const cfg = { preset: 'us-federal', rows: [clash, user] }
  const frozen = JSON.stringify(cfg)
  const { rows, added } = seed(cfg, 2026)
  assert.equal(JSON.stringify(cfg), frozen, 'input not mutated')
  assert.equal(added.length, 10) // 11 minus the clashing Christmas
  assert.ok(!added.some((r) => r.date === '2026-12-25'))
  assert.equal(rows.length, 12)
  assert.deepEqual(byDate(rows, '2026-12-25'), clash)
  assert.deepEqual(byDate(rows, '2026-11-27'), user)
  assert.deepEqual(dates(rows), [...dates(rows)].sort())
  // idempotent
  const again = seed({ preset: 'us-federal', rows }, 2026)
  assert.equal(again.added.length, 0)
  assert.equal(again.rows.length, 12)
})

test('seed with an explicit preset, next year, and preset none', () => {
  const r27 = seed({ preset: 'us-federal', rows: generate('us-federal', 2026) }, 2027, 'ca-utility-8')
  assert.equal(r27.added.length, 9)
  assert.ok(r27.added.every((r) => r.date.startsWith('2027-')))
  assert.equal(seed({ preset: 'none', rows: [] }, 2027).added.length, 0)
  assert.equal(seed(undefined, 2026).added.length, 11) // defaults to us-federal
})

test('isHoliday', () => {
  const cfg = { preset: 'us-federal', rows: generate('us-federal', 2026) }
  assert.equal(isHoliday(cfg, '2026-11-26').name, 'Thanksgiving Day')
  assert.equal(isHoliday(cfg, '2026-07-04'), null) // the observed date is listed, not the Saturday
  assert.equal(isHoliday(cfg, '2026-09-23'), null)
  assert.equal(isHoliday(null, '2026-11-26'), null)
  assert.equal(isHoliday({ rows: null }, '2026-11-26'), null)
})

test('missingYearWarning looks 60 days ahead', () => {
  const cfg = { preset: 'us-federal', rows: generate('us-federal', 2026) }
  assert.equal(missingYearWarning(cfg, '2026-09-23'), null) // +60 = 2026-11-22
  const w = missingYearWarning(cfg, '2026-11-15') // +60 = 2027-01-14
  assert.match(w, /2027/)
  assert.match(w, /US federal/)
  assert.equal(missingYearWarning({ ...cfg, rows: [...cfg.rows, ...generate('us-federal', 2027)] }, '2026-11-15'), null)
  assert.match(missingYearWarning({ preset: 'us-federal', rows: [] }, '2026-03-01'), /2026/)
  assert.equal(missingYearWarning({ preset: 'none', rows: [] }, '2026-11-15'), null)
  // a single user row for the year counts as "has rows"
  assert.equal(missingYearWarning({ preset: 'us-federal', rows: [{ date: '2027-06-01', name: 'x', source: 'user' }, ...cfg.rows] }, '2026-11-15'), null)
  assert.throws(() => missingYearWarning(cfg, 'not-a-date'), RangeError)
})
