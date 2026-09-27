// tz.test.js — spec §5.1 vectors, DST gap/overlap, 23 h/25 h days, addDays across DST.
// The whole file re-runs itself in child processes under TZ=UTC and TZ=Asia/Tokyo to prove the
// results never depend on the process time zone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeTz, addDays, dowOf, hhmmToMin, minToHHMM, isValidDate, isValidTimezone, parseDate } from '../tz.js'

const SELF = fileURLToPath(import.meta.url)
const CHILD = process.env.FK_TZ_CHILD === '1'
const Z = (s) => Date.parse(s)
const tz = makeTz('America/Los_Angeles')
const at = (ms) => { const p = tz.localParts(ms); return `${p.date} ${p.hhmm}` }

if (!CHILD) {
  for (const zone of ['UTC', 'Asia/Tokyo']) {
    test(`tz suite passes with process TZ=${zone}`, () => {
      const env = { ...process.env, TZ: zone, FK_TZ_CHILD: '1' }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 120000 })
      assert.equal(r.status, 0, `child under TZ=${zone} failed:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /\bfail 0\b/) // TAP ("# fail 0", Node 20) or spec ("ℹ fail 0") reporter
    })
  }
} else {
  test(`child really runs with process TZ=${process.env.TZ}`, () => {
    const want = { UTC: 0, 'Asia/Tokyo': -540 }[process.env.TZ]
    assert.equal(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset(), want)
  })
}

test('§5.1 startup vectors', () => {
  assert.equal(at(Z('2026-03-08T10:00:00Z')), '2026-03-08 03:00')
  assert.equal(at(Z('2026-11-01T08:30:00Z')), '2026-11-01 01:30')
  assert.equal(tz.zonedToInstant('2026-09-23', '07:00'), Z('2026-09-23T14:00:00Z'))
  assert.equal(at(Z('2026-07-01T19:00:00Z')), '2026-07-01 12:00')
  assert.equal(at(Z('2026-12-01T20:00:00Z')), '2026-12-01 12:00')
})

test('spring-forward gap moves forward by the gap', () => {
  assert.equal(tz.zonedToInstant('2026-03-08', '02:30'), Z('2026-03-08T10:30:00Z'))
  assert.equal(at(tz.zonedToInstant('2026-03-08', '02:30')), '2026-03-08 03:30')
  assert.equal(tz.zonedToInstant('2026-03-08', '02:00'), Z('2026-03-08T10:00:00Z'))
  assert.equal(tz.zonedToInstant('2026-03-08', '01:59'), Z('2026-03-08T09:59:00Z'))
  assert.equal(tz.zonedToInstant('2026-03-08', '03:00'), Z('2026-03-08T10:00:00Z'))
})

test('fall-back overlap resolves to the EARLIER occurrence', () => {
  assert.equal(tz.zonedToInstant('2026-11-01', '01:30'), Z('2026-11-01T08:30:00Z'))
  assert.equal(tz.zonedToInstant('2026-11-01', '01:00'), Z('2026-11-01T08:00:00Z'))
  assert.equal(tz.zonedToInstant('2026-11-01', '02:00'), Z('2026-11-01T10:00:00Z'))
  // both instants of the repeated hour read back as 01:30
  assert.equal(at(Z('2026-11-01T08:30:00Z')), '2026-11-01 01:30')
  assert.equal(at(Z('2026-11-01T09:30:00Z')), '2026-11-01 01:30')
})

test("'24:00' is next date 00:00; numeric minutes accepted", () => {
  assert.equal(tz.zonedToInstant('2026-09-23', '24:00'), tz.zonedToInstant('2026-09-24', '00:00'))
  assert.equal(tz.zonedToInstant('2026-12-31', '24:00'), Z('2027-01-01T08:00:00Z'))
  assert.equal(tz.zonedToInstant('2026-09-23', 420), Z('2026-09-23T14:00:00Z'))
  assert.equal(tz.zonedToInstant('2026-03-07', 1440), tz.zonedToInstant('2026-03-08', '00:00'))
})

test('localParts fields', () => {
  const p = tz.localParts(Z('2026-09-23T19:07:42Z'))
  assert.deepEqual(p, { date: '2026-09-23', dow: 3, minuteOfDay: 12 * 60 + 7, second: 42, year: 2026, month: 9, day: 23, hour: 12, minute: 7, hhmm: '12:07' })
  // local midnight rollover (UTC is already the next day)
  assert.equal(at(Z('2026-09-24T06:59:00Z')), '2026-09-23 23:59')
  assert.equal(at(Z('2026-09-24T07:00:00Z')), '2026-09-24 00:00')
  assert.equal(tz.localParts(Z('2026-09-27T12:00:00Z')).dow, 0) // Sunday
  assert.throws(() => tz.localParts(NaN), RangeError)
})

test('offsetAt in minutes east of UTC', () => {
  assert.equal(tz.offsetAt(Z('2026-07-01T00:00:00Z')), -420)
  assert.equal(tz.offsetAt(Z('2026-12-01T00:00:00Z')), -480)
  assert.equal(tz.offsetAt(Z('2026-03-08T09:59:59Z')), -480)
  assert.equal(tz.offsetAt(Z('2026-03-08T10:00:00Z')), -420)
  assert.equal(tz.offsetAt(Z('2026-11-01T08:59:59Z')), -420)
  assert.equal(tz.offsetAt(Z('2026-11-01T09:00:00Z')), -480)
  assert.equal(makeTz('Asia/Kolkata').offsetAt(Z('2026-07-01T00:00:00Z')), 330)
  assert.equal(makeTz('UTC').offsetAt(0), 0)
})

test('addDays is calendar arithmetic (across DST, months, years, leap days)', () => {
  assert.equal(addDays('2026-03-07', 1), '2026-03-08')
  assert.equal(addDays('2026-03-08', 1), '2026-03-09')
  assert.equal(addDays('2026-10-31', 2), '2026-11-02')
  assert.equal(addDays('2026-11-01', -1), '2026-10-31')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addDays('2027-02-28', 1), '2027-03-01')
  assert.equal(addDays('2026-09-23', -365), '2025-09-23')
  assert.equal(addDays('2026-09-23', 0), '2026-09-23')
  assert.equal(tz.addDays('2026-03-08', 1), '2026-03-09')
  // stepping instants by addDays + zonedToInstant keeps the wall clock across DST
  for (const d of ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01']) {
    assert.equal(at(tz.zonedToInstant(addDays(d, 1), '07:00')).slice(11), '07:00')
  }
})

test('23 h and 25 h days', () => {
  assert.equal(tz.dayBounds('2026-03-08').minutes, 1380)
  assert.equal(tz.dayBounds('2026-11-01').minutes, 1500)
  assert.equal(tz.dayBounds('2026-09-23').minutes, 1440)
  const b = tz.dayBounds('2026-11-01')
  assert.equal(b.start, Z('2026-11-01T07:00:00Z'))
  assert.equal(b.end, Z('2026-11-02T08:00:00Z'))
  // Every other day of 2026 is 24 h
  let d = '2026-01-01'
  const odd = []
  while (d < '2027-01-01') { const m = tz.dayBounds(d).minutes; if (m !== 1440) odd.push(`${d}:${m}`); d = addDays(d, 1) }
  assert.deepEqual(odd, ['2026-03-08:1380', '2026-11-01:1500'])
})

test('round trip localParts ↔ zonedToInstant for every 30 min of 2026', () => {
  const start = Z('2026-01-01T08:00:00Z')
  const end = Z('2027-01-01T08:00:00Z')
  const mismatches = []
  for (let ms = start; ms < end; ms += 30 * 60000) {
    const p = tz.localParts(ms)
    const back = tz.zonedToInstant(p.date, p.hhmm) + p.second * 1000
    if (back !== ms) mismatches.push(new Date(ms).toISOString())
  }
  // only the second (PST) occurrence of the repeated 01:xx hour maps back to the earlier instant
  assert.deepEqual(mismatches, ['2026-11-01T09:00:00.000Z', '2026-11-01T09:30:00.000Z'])
})

test('formatLocal presets (plain spaces only)', () => {
  const ms = Z('2026-09-24T14:00:00Z') // Thu 07:00 PDT
  assert.equal(tz.formatLocal(ms), '7:00 AM')
  assert.equal(tz.formatLocal(ms, 'time'), '7:00 AM')
  assert.equal(tz.formatLocal(ms, 'hmm'), '7:00')
  assert.equal(tz.formatLocal(Z('2026-09-25T03:00:00Z'), 'hmm'), '20:00')
  assert.equal(tz.formatLocal(ms, 'hhmm'), '07:00')
  assert.equal(tz.formatLocal(ms, 'date'), 'Thu, Sep 24')
  assert.equal(tz.formatLocal(ms, 'weekday'), 'Thu')
  assert.equal(tz.formatLocal(ms, 'monthDay'), 'Sep 24')
  assert.equal(tz.formatLocal(Z('2026-09-24T08:30:00Z'), 'dayTime'), 'Thu 1:30 AM')
  assert.equal(tz.formatLocal(ms, 'dateTime'), 'Thu, Sep 24, 7:00 AM')
  assert.equal(tz.formatLocal(ms, { hour: 'numeric' }), '7 AM')
  assert.equal(tz.formatLocal(NaN), '')
  for (const p of ['time', 'date', 'dayTime', 'dateTime']) assert.doesNotMatch(tz.formatLocal(ms, p), /[   ]/)
})

test('selfTest passes for the house zone and other zones', () => {
  assert.deepEqual(tz.selfTest(), { ok: true, failures: [] })
  for (const zone of ['UTC', 'Asia/Tokyo', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu']) {
    assert.equal(makeTz(zone).selfTest().ok, true, zone)
  }
})

test('results do not change when process.env.TZ changes at runtime', () => {
  const before = [at(Z('2026-03-08T10:00:00Z')), tz.zonedToInstant('2026-11-01', '01:30'), tz.localParts(Z('2026-09-23T19:07:42Z')).dow]
  const old = process.env.TZ
  try {
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/Berlin']) {
      process.env.TZ = zone
      const fresh = makeTz('America/Los_Angeles')
      assert.deepEqual([
        `${fresh.localParts(Z('2026-03-08T10:00:00Z')).date} ${fresh.localParts(Z('2026-03-08T10:00:00Z')).hhmm}`,
        fresh.zonedToInstant('2026-11-01', '01:30'),
        fresh.localParts(Z('2026-09-23T19:07:42Z')).dow,
      ], before, zone)
    }
  } finally {
    if (old === undefined) delete process.env.TZ
    else process.env.TZ = old
  }
})

test('input validation', () => {
  assert.throws(() => tz.zonedToInstant('2026-02-30', '07:00'), RangeError)
  assert.throws(() => tz.zonedToInstant('2026-9-23', '07:00'), RangeError)
  assert.throws(() => tz.zonedToInstant('2026-09-23', '25:00'), RangeError)
  assert.throws(() => tz.zonedToInstant('2026-09-23', '24:30'), RangeError)
  assert.throws(() => tz.zonedToInstant('2026-09-23', '7am'), RangeError)
  assert.throws(() => makeTz('Mars/Olympus_Mons'), RangeError)
  assert.throws(() => parseDate('2026-13-01'), RangeError)
  assert.equal(isValidDate('2028-02-29'), true)
  assert.equal(isValidDate('2027-02-29'), false)
  assert.equal(isValidTimezone('America/Los_Angeles'), true)
  assert.equal(isValidTimezone('Nope/Nowhere'), false)
  assert.equal(isValidTimezone(''), false)
})

test('HH:MM helpers and dowOf', () => {
  assert.equal(hhmmToMin('00:00'), 0)
  assert.equal(hhmmToMin('07:05'), 425)
  assert.equal(hhmmToMin('7:05'), 425)
  assert.equal(hhmmToMin('24:00'), 1440)
  assert.equal(minToHHMM(425), '07:05')
  assert.equal(minToHHMM(1440), '24:00')
  assert.equal(dowOf('2026-09-23'), 3)
  assert.equal(dowOf('2026-09-26'), 6)
  assert.equal(dowOf('2026-09-27'), 0)
})
