// tou.test.js — day types, segments/gap fill, event merge, precondition windows (defaults, evening,
// minLeadMin, tuned eff / earliestStart), D−1..D+1 scanning, tierAt, nextBoundaryAfter, plan()
// (incl. H6 auto.params text), addendum B F2 (dryOutUntilFor, fan-only boundaries, PlanDay
// fanOnlyUntil), the addendum §8 validate additions (guardrails, earliestStart), and the Release 4
// entry helpers (unitEntries, entryInstants by day type, entryInEffect, eventEntry, nextEntry, eventOverlapping, …).
// Re-runs itself under TZ=UTC and TZ=Asia/Tokyo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeTz } from '../tz.js'
import { generate } from '../holidays.js'
import * as tou from '../tou.js'
import { validate } from '../validate.js'

const SELF = fileURLToPath(import.meta.url)
if (process.env.FK_TZ_CHILD !== '1') {
  for (const zone of ['UTC', 'Asia/Tokyo']) {
    test(`tou suite passes with process TZ=${zone}`, () => {
      const env = { ...process.env, TZ: zone, FK_TZ_CHILD: '1' }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 120000 })
      assert.equal(r.status, 0, `child under TZ=${zone} failed:\n${r.stdout}\n${r.stderr}`)
    })
  }
}

const tz = makeTz('America/Los_Angeles')
const L = (date, hhmm) => tz.zonedToInstant(date, hhmm)
const hm = (ms) => tz.localParts(ms).hhmm
const day = (ms) => tz.localParts(ms).date

function cfgDefault() {
  return {
    schemaVersion: 1,
    rev: 1,
    timezone: 'America/Los_Angeles',
    automation: { mode: 'dry-run' },
    units: [
      { id: 'kitchen', name: 'Kitchen', host: '198.51.100.21', order: 0, shed: true, precondition: true, timeoutMs: 5000 },
      { id: 'living-room', name: 'Living Room', host: '198.51.100.230', order: 1, shed: true, precondition: true },
      { id: 'office', name: 'Office', host: '198.51.100.57', order: 5, shed: true, precondition: true },
    ],
    tou: {
      defaultTier: 'super_off_peak',
      weekendDays: [0, 6],
      mergeGapMin: 30,
      weekday: [
        { start: '07:00', end: '10:00', tier: 'peak', precondition: true },
        { start: '10:00', end: '17:00', tier: 'off_peak' },
        { start: '17:00', end: '20:00', tier: 'peak', precondition: false },
        { start: '20:00', end: '23:00', tier: 'off_peak' },
      ],
      weekendHoliday: [{ start: '07:00', end: '23:00', tier: 'off_peak' }],
    },
    holidays: { preset: 'us-federal', rows: [...generate('us-federal', 2026), ...generate('us-federal', 2027)] },
    precondition: {
      modes: ['COOL', 'DRY', 'HEAT'],
      deltaF: { cooling: 3, heating: 3 },
      leadMin: { cooling: 120, heating: 120 },
      clampF: { coolingMin: 65, heatingMax: 76 },
      minLeadMin: 20,
      joinCutoffMin: 10,
    },
    shed: { minRemainingMin: 15, restoreStaggerSec: 20, minDwellSec: 180, fanOnlyMin: { cooling: 60, heating: 15 } },
    optimizer: {
      enabled: false, observeDays: 3, minDeltaF: 1, maxDeltaF: 4, earliestStart: '04:30', minLeadMin: 60,
      maxStepDeltaF: 1, maxStepLeadMin: 30, marginF: 1, comfyMarginF: 2, revertCooldownDays: 3,
      minDaysBetweenOpposite: 3, dormantDays: 3, units: {},
    },
    insights: { runAt: '01:30', windowDays: 14, modelDays: 45, reportKeepDays: 60 },
  }
}

const WED = '2026-09-23'
const SAT = '2026-09-26'
const THANKSGIVING = '2026-11-26'

test('dayType: weekday, weekend, holiday', () => {
  const cfg = cfgDefault()
  assert.equal(tou.dayType(cfg, WED), 'weekday')
  assert.equal(tou.dayType(cfg, SAT), 'weekend')
  assert.equal(tou.dayType(cfg, '2026-09-27'), 'weekend')
  assert.equal(tou.dayType(cfg, THANKSGIVING), 'holiday')
  assert.equal(tou.dayType(cfg, '2026-07-03'), 'holiday') // observed Independence Day
  assert.equal(tou.dayType({ ...cfg, tou: { ...cfg.tou, weekendDays: [5] } }, '2026-09-25'), 'weekend')
})

test('segments: default weekday table with gap fill', () => {
  const segs = tou.segments(cfgDefault(), tz, WED)
  assert.deepEqual(segs.map((s) => [s.tier, s.localStart, s.localEnd]), [
    ['super_off_peak', '00:00', '07:00'],
    ['peak', '07:00', '10:00'],
    ['off_peak', '10:00', '17:00'],
    ['peak', '17:00', '20:00'],
    ['off_peak', '20:00', '23:00'],
    ['super_off_peak', '23:00', '24:00'],
  ])
  assert.equal(segs[1].start, Date.parse('2026-09-23T14:00:00Z'))
  assert.equal(segs[5].end, L('2026-09-24', '00:00'))
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end)
})

test('segments: weekend/holiday table and merged same-tier neighbours', () => {
  assert.deepEqual(tou.segments(cfgDefault(), tz, SAT).map((s) => [s.tier, s.localStart, s.localEnd]), [
    ['super_off_peak', '00:00', '07:00'], ['off_peak', '07:00', '23:00'], ['super_off_peak', '23:00', '24:00'],
  ])
  const cfg = cfgDefault()
  cfg.tou.weekendHoliday = [{ start: '07:00', end: '12:00', tier: 'off_peak' }, { start: '12:00', end: '23:00', tier: 'off_peak' }]
  assert.deepEqual(tou.segments(cfg, tz, SAT).map((s) => [s.tier, s.localStart, s.localEnd]), [
    ['super_off_peak', '00:00', '07:00'], ['off_peak', '07:00', '23:00'], ['super_off_peak', '23:00', '24:00'],
  ])
})

test('segments on DST days are real-time spans', () => {
  const spring = tou.segments(cfgDefault(), tz, '2026-03-09') // Monday after spring-forward
  assert.equal(spring[0].end - spring[0].start, 7 * 3600000)
  const s = tou.segments(cfgDefault(), tz, '2026-03-08') // Sunday (weekend table): 00:00–07:00 lasts 6 h
  assert.equal(s[0].end - s[0].start, 6 * 3600000)
  const f = tou.segments(cfgDefault(), tz, '2026-11-01') // Sunday fall-back: 00:00–07:00 lasts 8 h
  assert.equal(f[0].end - f[0].start, 8 * 3600000)
  const total = f.reduce((a, x) => a + (x.end - x.start), 0)
  assert.equal(total, 25 * 3600000)
})

test('events: default weekday = 07:00 (precondition) and 17:00; none on weekend/holiday', () => {
  const evs = tou.events(cfgDefault(), tz, WED)
  assert.equal(evs.length, 2)
  assert.deepEqual(evs.map((e) => [e.id, hm(e.peakStart), hm(e.peakEnd), e.precondition]), [
    ['2026-09-23@07:00', '07:00', '10:00', true],
    ['2026-09-23@17:00', '17:00', '20:00', false],
  ])
  assert.equal(evs[0].date, WED)
  assert.equal(evs[0].windows.length, 1)
  assert.deepEqual(tou.events(cfgDefault(), tz, SAT), [])
  assert.deepEqual(tou.events(cfgDefault(), tz, THANKSGIVING), [])
  // addendum E: with precondition.superOffPeak.weekend on, the weekend/holiday dates get their 07:00 boundary event
  const on = cfgDefault()
  on.precondition.superOffPeak = { weekend: true }
  for (const d of [SAT, THANKSGIVING]) assert.deepEqual(tou.events(on, tz, d).map((e) => [e.id, e.kind]), [[`${d}@07:00`, 'boundary']])
})

test('firstPreconditionDate: first date ≥ fromDate with a precondition event (weekends, holidays, none)', () => {
  const cfg = cfgDefault()
  assert.equal(tou.firstPreconditionDate(cfg, tz, WED), WED)
  assert.equal(tou.firstPreconditionDate(cfg, tz, SAT), '2026-09-28', 'Sat ⇒ Mon')
  assert.equal(tou.firstPreconditionDate(cfg, tz, '2026-09-27'), '2026-09-28', 'Sun ⇒ Mon')
  assert.equal(tou.firstPreconditionDate(cfg, tz, THANKSGIVING), '2026-11-27', 'Thanksgiving ⇒ Fri')
  assert.equal(tou.firstPreconditionDate(cfg, tz, '2026-12-25'), '2026-12-28', 'Christmas (Fri) ⇒ Mon')
  assert.equal(tou.firstPreconditionDate(cfg, tz, SAT, 2), null, 'only maxDays dates are scanned')
  assert.equal(tou.firstPreconditionDate(cfg, tz, SAT, 3), '2026-09-28')
  const noPre = cfgDefault()
  noPre.tou.weekday[0].precondition = false
  assert.equal(tou.firstPreconditionDate(noPre, tz, WED), null, 'no precondition-flagged event at all')
  const wkndPre = cfgDefault()
  wkndPre.tou.weekendHoliday = [{ start: '08:00', end: '11:00', tier: 'peak', precondition: true }]
  assert.equal(tou.firstPreconditionDate(wkndPre, tz, SAT), SAT, 'a flagged weekend peak counts')
})

test('events: mergeGapMin merges near windows; the gap becomes part of the event', () => {
  const cfg = cfgDefault()
  cfg.tou.weekday = [
    { start: '07:00', end: '09:00', tier: 'peak', precondition: false },
    { start: '09:00', end: '09:15', tier: 'off_peak' },
    { start: '09:15', end: '10:00', tier: 'peak', precondition: true },
    { start: '10:00', end: '17:00', tier: 'off_peak' },
    { start: '17:00', end: '18:00', tier: 'peak' },
    { start: '18:00', end: '18:30', tier: 'off_peak' },
    { start: '18:30', end: '20:00', tier: 'peak' },
  ]
  const evs = tou.events(cfg, tz, WED)
  assert.deepEqual(evs.map((e) => [e.id, hm(e.peakStart), hm(e.peakEnd), e.precondition, e.windows.length]), [
    ['2026-09-23@07:00', '07:00', '10:00', true, 2], // 15 min gap < 30 ⇒ merged; any member flagged ⇒ precondition
    ['2026-09-23@17:00', '17:00', '18:00', false, 1], // 30 min gap is NOT < 30 ⇒ separate
    ['2026-09-23@18:30', '18:30', '20:00', false, 1],
  ])
  // adjacent peak windows always merge, even with mergeGapMin 0
  cfg.tou.mergeGapMin = 0
  cfg.tou.weekday = [{ start: '07:00', end: '08:00', tier: 'peak' }, { start: '08:00', end: '10:00', tier: 'peak' }]
  assert.deepEqual(tou.events(cfg, tz, WED).map((e) => [e.id, hm(e.peakEnd)]), [['2026-09-23@07:00', '10:00']])
})

test('preconditionWindow: defaults ⇒ 05:00–07:00; evening none; flipping evening on ⇒ 15:00–17:00', () => {
  const cfg = cfgDefault()
  const [am, pm] = tou.events(cfg, tz, WED)
  for (const season of ['heating', 'cooling', null]) {
    const w = tou.preconditionWindow(cfg, tz, am, season)
    assert.equal(hm(w.preStart), '05:00')
    assert.equal(w.peakStart, am.peakStart)
    assert.equal(w.leadMin, 120)
  }
  assert.equal(tou.preconditionWindow(cfg, tz, pm, 'heating'), null)
  cfg.tou.weekday[2].precondition = true
  const pm2 = tou.events(cfg, tz, WED)[1]
  assert.equal(hm(tou.preconditionWindow(cfg, tz, pm2, 'cooling').preStart), '15:00')
})

test('preconditionWindow: season leads, previous event + gap, 03:00 floor, minLeadMin', () => {
  const cfg = cfgDefault()
  cfg.precondition.leadMin = { cooling: 60, heating: 240 }
  const am = tou.events(cfg, tz, WED)[0]
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'cooling').preStart), '06:00')
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'heating').preStart), '03:00') // 07:00 − 240
  // 03:00 floor
  cfg.tou.weekday[0] = { start: '06:00', end: '10:00', tier: 'peak', precondition: true }
  const early = tou.events(cfg, tz, WED)[0]
  assert.equal(hm(tou.preconditionWindow(cfg, tz, early, 'heating').preStart), '03:00')
  // previous event end + mergeGapMin bounds the evening window
  const c2 = cfgDefault()
  c2.tou.weekday = [
    { start: '07:00', end: '10:00', tier: 'peak' },
    { start: '10:00', end: '11:00', tier: 'off_peak' },
    { start: '11:00', end: '13:00', tier: 'peak', precondition: true },
  ]
  const second = tou.events(c2, tz, WED)[1]
  const w = tou.preconditionWindow(c2, tz, second, 'heating')
  assert.equal(hm(w.preStart), '10:30')
  assert.equal(w.leadMin, 30)
  c2.precondition.minLeadMin = 45
  assert.equal(tou.preconditionWindow(c2, tz, second, 'heating'), null)
  // a peak that starts before 03:00 gets no precondition
  const c3 = cfgDefault()
  c3.tou.weekday = [{ start: '02:00', end: '04:00', tier: 'peak', precondition: true }]
  assert.equal(tou.preconditionWindow(c3, tz, tou.events(c3, tz, WED)[0], 'heating'), null)
})

test('preconditionWindow with eff (H6): leadMin override, tuned earliestStart clamp, suspended', () => {
  const cfg = cfgDefault()
  const am = tou.events(cfg, tz, WED)[0]
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'heating', { leadMin: 150, source: 'tuned' }).preStart), '04:30')
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'heating', { leadMin: 180, source: 'tuned' }).preStart), '04:30') // earliestStart clamp
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'heating', { leadMin: 180, source: 'config' }).preStart), '04:00') // clamp only for tuned
  cfg.optimizer.earliestStart = '05:30'
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'heating', { leadMin: 120, source: 'tuned' }).preStart), '05:30')
  // an earliestStart carried by eff (effectivePrecondition / frozen params) wins over the live config
  assert.equal(hm(tou.preconditionWindow(cfg, tz, am, 'heating', { leadMin: 150, source: 'tuned', earliestStart: '04:30' }).preStart), '04:30')
  assert.equal(tou.preconditionWindow(cfg, tz, am, 'heating', { leadMin: 120, suspended: true }), null)
})

test('preconditionWindow is DST-correct', () => {
  const cfg = cfgDefault()
  const mon = tou.events(cfg, tz, '2026-03-09')[0] // first weekday after spring-forward
  assert.equal(hm(tou.preconditionWindow(cfg, tz, mon, 'heating').preStart), '05:00')
  const nov2 = tou.events(cfg, tz, '2026-11-02')[0]
  assert.equal(hm(tou.preconditionWindow(cfg, tz, nov2, 'heating').preStart), '05:00')
  // a weekday table on the DST Sunday itself (weekendDays emptied)
  const c = cfgDefault(); c.tou.weekendDays = []; c.precondition.leadMin = { cooling: 240, heating: 240 }
  const spring = tou.events(c, tz, '2026-03-08')[0]
  const w = tou.preconditionWindow(c, tz, spring, 'heating')
  assert.equal(w.preStart, Date.parse('2026-03-08T10:00:00Z')) // 03:00 PDT
  assert.equal(w.leadMin, 240)
})

test('activeEventFor: phases across the default morning', () => {
  const cfg = cfgDefault()
  const u = cfg.units[0]
  assert.equal(tou.activeEventFor(cfg, tz, u, L(WED, '04:59')), null)
  const pre = tou.activeEventFor(cfg, tz, u, L(WED, '05:00'))
  assert.equal(pre.phase, 'precondition')
  assert.equal(pre.event.id, '2026-09-23@07:00')
  assert.equal(hm(pre.preStart), '05:00')
  assert.equal(tou.activeEventFor(cfg, tz, u, L(WED, '07:00')).phase, 'shed')
  assert.equal(tou.activeEventFor(cfg, tz, u, L(WED, '10:00') - 1).phase, 'shed')
  assert.equal(tou.activeEventFor(cfg, tz, u, L(WED, '10:00')), null)
  assert.equal(tou.activeEventFor(cfg, tz, u, L(WED, '16:00')), null) // evening has no precondition
  const ev = tou.activeEventFor(cfg, tz, u, L(WED, '17:00'))
  assert.equal(ev.event.id, '2026-09-23@17:00')
  assert.equal(ev.preStart, ev.event.peakStart)
  assert.equal(tou.activeEventFor(cfg, tz, u, L(SAT, '08:00')), null)
  assert.equal(tou.activeEventFor(cfg, tz, u, L(THANKSGIVING, '08:00')), null)
})

test('activeEventFor: unit flags and eff', () => {
  const cfg = cfgDefault()
  const noPre = { ...cfg.units[0], precondition: false }
  assert.equal(tou.activeEventFor(cfg, tz, noPre, L(WED, '05:30')), null)
  const shed = tou.activeEventFor(cfg, tz, noPre, L(WED, '07:30'))
  assert.equal(shed.phase, 'shed')
  assert.equal(shed.preStart, shed.event.peakStart)
  assert.equal(tou.activeEventFor(cfg, tz, { ...cfg.units[0], shed: false }, L(WED, '08:00')), null)
  assert.equal(tou.activeEventFor(cfg, tz, null, L(WED, '05:00')).phase, 'precondition') // house level
  assert.equal(tou.activeEventFor(cfg, tz, cfg.units[0], L(WED, '04:30'), { season: 'heating', leadMin: 150, source: 'tuned' }).phase, 'precondition')
  assert.equal(tou.activeEventFor(cfg, tz, cfg.units[0], L(WED, '05:30'), { season: 'heating', leadMin: 120, suspended: true }), null)
})

test('activeEventFor scans D−1..D+1 around midnight', () => {
  const cfg = cfgDefault()
  cfg.tou.weekday = [{ start: '00:00', end: '01:00', tier: 'peak' }, { start: '22:00', end: '24:00', tier: 'peak' }]
  const u = cfg.units[0]
  const late = tou.activeEventFor(cfg, tz, u, L(WED, '23:59'))
  assert.equal(late.event.id, '2026-09-23@22:00')
  const justAfter = tou.activeEventFor(cfg, tz, u, L('2026-09-24', '00:00'))
  assert.equal(justAfter.event.id, '2026-09-24@00:00')
  assert.equal(justAfter.phase, 'shed')
  assert.equal(tou.activeEventFor(cfg, tz, u, L('2026-09-24', '01:00')), null)
})

test('tierAt extends across midnight and weekends', () => {
  const cfg = cfgDefault()
  const t = tou.tierAt(cfg, tz, L(WED, '06:00'))
  assert.equal(t.kind, 'super_off_peak')
  assert.equal(t.since, L('2026-09-22', '23:00'))
  assert.equal(t.until, L(WED, '07:00'))
  const p = tou.tierAt(cfg, tz, L(WED, '08:00'))
  assert.deepEqual([p.kind, hm(p.since), hm(p.until)], ['peak', '07:00', '10:00'])
  const fri = tou.tierAt(cfg, tz, L('2026-09-25', '23:30'))
  assert.equal(fri.kind, 'super_off_peak')
  assert.equal(fri.until, L(SAT, '07:00'))
  const sat = tou.tierAt(cfg, tz, L(SAT, '12:00'))
  assert.deepEqual([sat.kind, hm(sat.since), hm(sat.until)], ['off_peak', '07:00', '23:00'])
})

test('nextBoundaryAfter', () => {
  const cfg = cfgDefault()
  const next = (hhmm, date = WED) => { const t = tou.nextBoundaryAfter(cfg, tz, L(date, hhmm)); return `${day(t)} ${hm(t)}` }
  assert.equal(next('04:00'), `${WED} 05:00`) // precondition start
  assert.equal(next('05:00'), `${WED} 07:00`)
  assert.equal(next('07:30'), `${WED} 08:00`) // the cooling dry-out deadline (addendum B F2), then 10:00
  assert.equal(next('08:00'), `${WED} 10:00`)
  assert.equal(next('10:00'), `${WED} 17:00`)
  assert.equal(next('21:00'), `${WED} 23:00`)
  assert.equal(next('23:30'), '2026-09-24 00:00') // local midnight (date change)
  assert.equal(next('12:00', SAT), `${SAT} 23:00`)
  assert.ok(tou.nextBoundaryAfter(cfg, tz, L(WED, '04:00')) > L(WED, '04:00'))
})

// ---- Release 4 stage 1: daily-schedule entry helpers (addendum B F3, D E1/E2) ----------------------

const THU = '2026-09-24'
const FRI = '2026-09-25'
const ISOL = (date, hhmm) => new Date(L(date, hhmm)).toISOString()
const KITCHEN_SCHED = [
  { at: '22:00', power: 'OFF' },
  { at: '07:00', power: true, mode: 'heat', temp: '70', fan: 'low', days: 'weekday' },
  { at: '07:00', power: 'ON', mode: 'HEAT', temp: 68, days: 'weekend' },
  { at: '7am', power: 'OFF' }, // malformed rows are skipped (validation rejects them)
  { at: '09:00', power: 'maybe' },
]
function withSched(schedule, id = 'kitchen') {
  const cfg = cfgDefault()
  cfg.units.find((u) => u.id === id).schedule = schedule
  return { cfg, u: cfg.units.find((x) => x.id === id) }
}

test('unitEntries: normalised and sorted by time, then all < weekday < weekend; Off rows carry nothing else', () => {
  const { u } = withSched([...KITCHEN_SCHED, { at: '07:00', power: 'OFF', mode: 'COOL', days: 'all' }])
  assert.deepEqual(tou.unitEntries(u), [
    { at: '07:00', min: 420, power: 'OFF', days: 'all' },
    { at: '07:00', min: 420, power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW', days: 'weekday' },
    { at: '07:00', min: 420, power: 'ON', mode: 'HEAT', temp: 68, days: 'weekend' },
    { at: '22:00', min: 1320, power: 'OFF', days: 'all' },
  ])
  assert.deepEqual(tou.unitEntries({ id: 'x' }), [])
  assert.deepEqual(tou.unitEntries(null), [])
})

test('entryInstants: filtered by day type (weekday, Saturday, holiday Thursday), keyed s:<date>@<HH:MM>, DST-correct', () => {
  const { cfg, u } = withSched(KITCHEN_SCHED)
  const thu = tou.entryInstants(cfg, tz, u, THU)
  assert.deepEqual(thu.map((x) => [x.key, x.at, x.date, x.hhmm, x.days]), [
    ['s:2026-09-24@07:00', L(THU, '07:00'), THU, '07:00', 'weekday'],
    ['s:2026-09-24@22:00', L(THU, '22:00'), THU, '22:00', 'all'],
  ])
  assert.deepEqual(thu[0].fields, { power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' })
  assert.deepEqual(thu[1].fields, { power: 'OFF' })
  const sat = tou.entryInstants(cfg, tz, u, SAT)
  assert.deepEqual(sat.map((x) => [x.hhmm, x.days, x.fields.temp]), [['07:00', 'weekend', 68], ['22:00', 'all', undefined]])
  assert.deepEqual(tou.entryInstants(cfg, tz, u, THANKSGIVING).map((x) => x.days), ['weekend', 'all'], 'a holiday is a weekend day')
  // two entries whose day sets collide (hand-edited, validation bypassed): the first survives
  const dup = withSched([{ at: '07:00', power: 'OFF' }, { at: '07:00', power: 'ON', mode: 'COOL', days: 'weekday' }])
  assert.deepEqual(tou.entryInstants(dup.cfg, tz, dup.u, THU).map((x) => x.fields.power), ['OFF'])
  // DST: the spring-forward gap moves forward, the fall-back overlap takes the earlier occurrence (like TOU windows)
  const dst = withSched([{ at: '02:30', power: 'OFF' }, { at: '01:30', power: 'OFF' }])
  assert.equal(tou.entryInstants(dst.cfg, tz, dst.u, '2026-03-08').find((x) => x.hhmm === '02:30').at, Date.parse('2026-03-08T10:30:00Z'))
  assert.equal(tou.entryInstants(dst.cfg, tz, dst.u, '2026-11-01').find((x) => x.hhmm === '01:30').at, Date.parse('2026-11-01T08:30:00Z'))
})

test('entryInEffect / latestEntryAtOrBefore (F3.3, F3.11): D−1 and D, ≤ now, arming', () => {
  const { cfg, u } = withSched(KITCHEN_SCHED)
  const at = (x) => (x ? `${x.date} ${x.hhmm}` : null)
  assert.equal(at(tou.entryInEffect(cfg, tz, u, L(FRI, '00:30'))), `${THU} 22:00`, "yesterday's 22:00 after midnight")
  assert.equal(at(tou.entryInEffect(cfg, tz, u, L(THU, '07:00'))), `${THU} 07:00`, 'at its instant exactly')
  assert.equal(at(tou.entryInEffect(cfg, tz, u, L(THU, '06:59'))), '2026-09-23 22:00')
  assert.equal(tou.entryInEffect(cfg, tz, u, L(FRI, '00:30'), L(THU, '23:00')), null, 'armed after the latest instant ⇒ nothing in effect')
  assert.equal(at(tou.entryInEffect(cfg, tz, u, L(FRI, '00:30'), new Date(L(THU, '21:00')).toISOString())), `${THU} 22:00`, 'armedAt as ISO')
  assert.equal(at(tou.entryInEffect(cfg, tz, u, L(SAT, '00:30'))), `${FRI} 22:00`)
  assert.equal(at(tou.latestEntryAtOrBefore(cfg, tz, u, L(THU, '07:00'))), `${THU} 07:00`, 'E* at peakStart')
  assert.equal(at(tou.latestEntryAtOrBefore(cfg, tz, u, L(THU, '06:00'), L(THU, '05:00'))), null, 'D: arming honoured')
  const none = withSched([])
  assert.equal(tou.entryInEffect(none.cfg, tz, none.u, L(THU, '12:00')), null)
})

test('eventEntry (F3.12): closed at peakStart, follows now through the shed, excludes peakEnd and entries before preStart', () => {
  const { cfg, u } = withSched([
    { at: '04:30', power: 'ON', mode: 'HEAT' }, { at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 },
    { at: '08:00', power: 'OFF' }, { at: '10:00', power: 'ON', mode: 'COOL' },
  ])
  const ev = tou.events(cfg, tz, THU)[0]
  const pre = L(THU, '05:00')
  const key = (now) => tou.eventEntry(cfg, tz, u, ev, pre, now)?.key ?? null
  for (const hhmm of ['05:00', '06:59']) assert.equal(key(L(THU, hhmm)), 's:2026-09-24@07:00', hhmm)
  assert.equal(key(L(THU, '07:00')), 's:2026-09-24@07:00')
  assert.equal(key(L(THU, '08:30')), 's:2026-09-24@08:00', 'folding through the shed')
  assert.equal(key(L(THU, '10:00')), 's:2026-09-24@08:00', 'the 10:00 entry at peakEnd is never the event entry')
  const early = withSched([{ at: '04:30', power: 'ON', mode: 'HEAT' }])
  assert.equal(tou.eventEntry(early.cfg, tz, early.u, ev, pre, L(THU, '06:00')), null, 'before preStart ⇒ live rules')
})

test('R4-3 arming (F3.4, J8): eventEntry, entryEffFor’s E* and plan leave out an entry at or before armedAt', () => {
  const { cfg, u } = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }, { at: '08:00', power: 'OFF' }])
  const ev = tou.events(cfg, tz, THU)[0]
  const pre = L(THU, '05:00')
  const key = (now, armed) => tou.eventEntry(cfg, tz, u, ev, pre, now, armed)?.key ?? null
  assert.equal(key(L(THU, '07:30')), 's:2026-09-24@07:00', 'unarmed')
  assert.equal(key(L(THU, '07:30'), L(THU, '07:30')), null, 'the Schedule switched on at 07:30: not the event entry')
  assert.equal(key(L(THU, '07:30'), new Date(L(THU, '07:00')).toISOString()), null, 'armed at its instant exactly (ISO)')
  assert.equal(key(L(THU, '07:30'), L(THU, '06:59')), 's:2026-09-24@07:00')
  assert.equal(key(L(THU, '06:00'), L(THU, '05:30')), 's:2026-09-24@07:00', 'an instant still ahead of the arming')
  assert.equal(key(L(THU, '08:30'), L(THU, '07:30')), 's:2026-09-24@08:00', 'an entry after the arming folds as usual')
  // F3.11 pass 1: an E* older than the arming is no entry — an OFF one no longer cancels the precondition, an ON one no
  // longer overrides a suspension or picks the season
  const off = withSched([{ at: '06:30', power: 'OFF' }])
  assert.equal(tou.entryEffFor(off.cfg, tz, off.u, null, 'HEAT')(ev).noPrecondition, true)
  assert.equal(tou.entryEffFor(off.cfg, tz, off.u, null, 'HEAT', { armedAt: L(THU, '06:45') })(ev).noPrecondition, undefined)
  const suspended = { auto: { phase: 'idle' }, tuning: { suspended: { since: THU } } }
  const e1 = tou.entryEffFor(cfg, tz, u, suspended, 'COOL', { armedAt: L(THU, '07:30') })(ev)
  assert.deepEqual([e1.season, e1.suspended], ['cooling', true], 'live rules')
  // plan: armedAtOf(state, id) — the event unit's entry / restore / precondition text agree with decide
  const live = { kitchen: { power: 'OFF', mode: 'COOL', temp: 68 } }
  const only7 = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }])
  const armedPlan = (st) => tou.plan(only7.cfg, { units: {}, ledger: {}, ...st }, tz, THU, { live }).events[0].units.kitchen
  const k0 = armedPlan({})
  assert.deepEqual([k0.entry?.key, k0.restore], ['s:2026-09-24@07:00', 'Heat 70°'])
  for (const st of [{ scheduleArmedAt: new Date(L(THU, '07:30')).toISOString() }, { units: { kitchen: { scheduleEditedAt: new Date(L(THU, '07:30')).toISOString() } } }]) {
    const k = armedPlan(st)
    assert.deepEqual([k.entry, k.restore, k.precondition], [null, null, 'skip: unit off'], JSON.stringify(st))
  }
})

test('nextEntry (D E2.11): the next instant > now within 24 h, arming honoured', () => {
  const { cfg, u } = withSched(KITCHEN_SCHED)
  const nx = (now, armed) => { const x = tou.nextEntry(cfg, tz, u, now, armed); return x ? `${x.date} ${x.hhmm}` : null }
  assert.equal(nx(L(THU, '06:00')), `${THU} 07:00`)
  assert.equal(nx(L(THU, '07:00')), `${THU} 22:00`, 'strictly after now')
  assert.equal(nx(L(FRI, '23:00')), `${SAT} 07:00`, 'the weekend entry on Saturday')
  assert.equal(nx(L(THU, '06:00'), L(THU, '08:00')), `${THU} 22:00`, 'armedAt after an instant skips it')
  const weekdayOnly = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT', days: 'weekday' }])
  assert.equal(tou.nextEntry(weekdayOnly.cfg, tz, weekdayOnly.u, L(FRI, '08:00')), null, 'Monday is beyond 24 h')
})

test('eventOverlapping (D E2.5): interval test against every participating window', () => {
  const { cfg, u } = withSched([])
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '06:00'), L(THU, '07:00')), true, 'preStart 05:00 ≤ 07:00')
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '04:00'), L(THU, '04:59')), false)
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '04:30'), L(THU, '05:00')), true, 'a window starting at the band end')
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '10:00'), L(THU, '11:00')), false, 'a band starting at peakEnd exactly')
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '09:30'), L(THU, '10:30')), true, 'a band that meets the peak')
  assert.equal(tou.eventOverlapping(cfg, tz, { ...u, shed: false }, L(THU, '06:00'), L(THU, '07:00')), false, 'shed:false never participates')
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(SAT, '06:00'), L(SAT, '07:00')), false)
  // the eff function moves the window: a 45-min lead starts at 06:15, still inside [06:00, 07:00]
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '05:30'), L(THU, '06:00'), () => ({ season: 'heating', leadMin: 45 })), false)
  assert.equal(tou.eventOverlapping(cfg, tz, u, L(THU, '06:00'), L(THU, '07:00'), () => ({ season: 'heating', leadMin: 45 })), true)
})

test('activeEventFor with an eff function (B §1.3): per-event eff, noPrecondition, suspended override; the fold decision at E.at', () => {
  const { cfg, u } = withSched([])
  assert.equal(tou.activeEventFor(cfg, tz, u, L(THU, '06:00'), () => ({ season: 'heating', noPrecondition: true })), null, 'OFF entry ⇒ preStart = peakStart')
  assert.equal(tou.activeEventFor(cfg, tz, u, L(THU, '07:00'), () => ({ noPrecondition: true })).phase, 'shed')
  const seen = []
  tou.activeEventFor(cfg, tz, u, L(THU, '05:30'), (e) => { seen.push(e.id); return { season: 'cooling', leadMin: 60 } })
  assert.ok(seen.includes('2026-09-24@07:00'))
  assert.equal(tou.activeEventFor(cfg, tz, u, L(THU, '05:30'), () => ({ season: 'cooling', leadMin: 60 })), null, 'the function supplies the lead')
  assert.equal(tou.activeEventFor(cfg, tz, u, L(THU, '06:30'), () => ({ season: 'cooling', leadMin: 60 })).phase, 'precondition')
  assert.equal(tou.foldEventFor(cfg, tz, u, L(THU, '07:00'))?.id, '2026-09-24@07:00', 'an entry at peakStart folds')
  assert.equal(tou.foldEventFor(cfg, tz, u, L(THU, '05:30'))?.id, '2026-09-24@07:00', 'inside the precondition window')
  assert.equal(tou.foldEventFor(cfg, tz, u, L(THU, '10:00')), null, 'at peakEnd it fires')
  assert.equal(tou.foldEventFor(cfg, tz, { ...u, shed: false }, L(THU, '07:00')), null)
})

test('entryEffFor (B §1.3 effFor): season from E* at peakStart, OFF ⇒ noPrecondition, ON ⇒ not suspended, engaged ⇒ auto.params', () => {
  const heat = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }])
  const ev = tou.events(heat.cfg, tz, THU)[0]
  const suspended = { auto: { phase: 'idle' }, tuning: { suspended: { since: THU } } }
  const e1 = tou.entryEffFor(heat.cfg, tz, heat.u, suspended, 'COOL')(ev)
  assert.equal(e1.season, 'heating', "the entry's mode, not the live COOL")
  assert.equal(e1.suspended, false, 'C-11: an ON entry at peak overrides the suspension')
  const off = withSched([{ at: '06:30', power: 'OFF' }])
  assert.equal(tou.entryEffFor(off.cfg, tz, off.u, null, 'HEAT')(ev).noPrecondition, true)
  // F3.11's second pass: an E* before preStart already fired — live rules (yesterday's 22:00 Off never cancels a morning)
  const night = withSched([{ at: '22:00', power: 'OFF' }])
  assert.equal(tou.entryEffFor(night.cfg, tz, night.u, null, 'HEAT')(ev).noPrecondition, undefined)
  const early4 = withSched([{ at: '04:00', power: 'ON', mode: 'COOL' }])
  const e4 = tou.entryEffFor(early4.cfg, tz, early4.u, suspended, 'HEAT')(ev)
  assert.deepEqual([e4.season, e4.suspended], ['cooling', true], "E*'s season, but no suspension override for an entry before the window")
  const none = withSched([])
  const e3 = tou.entryEffFor(none.cfg, tz, none.u, suspended, 'COOL')(ev)
  assert.deepEqual([e3.season, e3.suspended, e3.noPrecondition], ['cooling', true, undefined], 'no entry ⇒ live rules')
  const params = { season: 'heating', leadMin: 90, source: 'config' }
  const engaged = { auto: { phase: 'precondition', eventId: ev.id, params } }
  assert.equal(tou.entryEffFor(heat.cfg, tz, heat.u, engaged, 'COOL')(ev), params, 'H5: frozen while engaged')
  // an injected seasonOf (decide passes C's seasonFor through it)
  assert.equal(tou.entryEffFor(heat.cfg, tz, heat.u, null, 'COOL', { seasonOf: () => 'cooling' })(ev).season, 'cooling')
})

test('armedAtOf (F3.4): max(scheduleArmedAt, units[id].scheduleEditedAt)', () => {
  assert.equal(tou.armedAtOf({}, 'kitchen'), -Infinity)
  const st = { scheduleArmedAt: '2026-09-24T03:00:00.000Z', units: { kitchen: { scheduleEditedAt: '2026-09-24T20:00:00.000Z' }, office: {} } }
  assert.equal(tou.armedAtOf(st, 'kitchen'), Date.parse('2026-09-24T20:00:00.000Z'))
  assert.equal(tou.armedAtOf(st, 'office'), Date.parse('2026-09-24T03:00:00.000Z'))
})

test('nextBoundaryAfter wakes at entry instants of every unit (B §5.2)', () => {
  const { cfg } = withSched([{ at: '14:10', power: 'OFF' }], 'office')
  const t = tou.nextBoundaryAfter(cfg, tz, L(THU, '13:00'))
  assert.equal(hm(t), '14:10')
  const t2 = tou.nextBoundaryAfter(cfg, tz, L(SAT, '07:00'))
  assert.equal(hm(t2), '14:10', 'every day type (days all)')
})

test('plan (B §3.4, C F3.11′): entry precondition texts, entry / restore / fanOnlyUntil per event unit', () => {
  const { cfg } = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW', days: 'weekday' }, { at: '22:00', power: 'OFF' }])
  const live = { kitchen: { power: 'OFF', mode: 'COOL', temp: 68 } }
  const p = tou.plan(cfg, { units: {}, ledger: {} }, tz, THU, { live })
  const k = p.events[0].units.kitchen
  assert.equal(k.precondition, 'heat +3° → 73° from 5:00 (scheduled Heat 70°)', 'the entry authorizes the ON of an OFF unit')
  assert.equal(k.preStart, ISOL(THU, '05:00'))
  assert.equal(k.target, 73)
  assert.deepEqual(k.entry, { key: 's:2026-09-24@07:00', at: ISOL(THU, '07:00'), atLabel: '7:00', label: 'On · Heat 70° · Low' })
  assert.equal(k.restore, 'Heat 70° · Low')
  assert.equal(k.fanOnlyUntil, ISOL(THU, '07:15'), 'predicted from the entry mode (heating 15 min)')
  const evening = p.events[1].units.kitchen
  assert.deepEqual([evening.entry, evening.restore], [null, null])
  // an OFF entry at or before peakStart inside the window: no precondition, silently
  const off = withSched([{ at: '06:30', power: 'OFF' }])
  const po = tou.plan(off.cfg, { units: {} }, tz, THU, { live: { kitchen: { power: 'ON', mode: 'HEAT', temp: 70 } } }).events[0].units.kitchen
  assert.deepEqual([po.precondition, po.preStart, po.restore], ['skip: scheduled off', null, 'stays off'])
  // an entry in Fan: skipped with the scheduled mode
  const fan = withSched([{ at: '07:00', power: 'ON', mode: 'FAN' }])
  assert.equal(tou.plan(fan.cfg, { units: {} }, tz, THU, { live }).events[0].units.kitchen.precondition, 'skip: scheduled mode Fan')
  // F3.11′: a running unit already past the bumped target in the entry's season keeps its setpoint
  const cool = withSched([{ at: '07:00', power: 'ON', mode: 'COOL', temp: 74 }], 'office')
  const pc = tou.plan(cool.cfg, { units: {} }, tz, THU, { live: { office: { power: 'ON', mode: 'COOL', temp: 68 } } }).events[0].units.office
  assert.deepEqual([pc.precondition, pc.target], ['keeps 68° (already below the 71° target)', null])
  const warmer = tou.plan(cool.cfg, { units: {} }, tz, THU, { live: { office: { power: 'ON', mode: 'COOL', temp: 72 } } }).events[0].units.office
  assert.deepEqual([warmer.precondition, warmer.target], ['cool −1° → 71° from 5:00 (scheduled Cool 74°)', 71])
  const inFan = tou.plan(cool.cfg, { units: {} }, tz, THU, { live: { office: { power: 'ON', mode: 'FAN', temp: 68 } } }).events[0].units.office
  assert.equal(inFan.precondition, 'cool −3° → 71° from 5:00 (scheduled Cool 74°)', 'a unit in Fan is pre-cooled to the bumped target, never 68 (B-1)')
  const heatKeep = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }])
  assert.equal(tou.plan(heatKeep.cfg, { units: {} }, tz, THU, { live: { kitchen: { power: 'ON', mode: 'HEAT', temp: 74 } } }).events[0].units.kitchen.precondition, 'keeps 74° (already above the 73° target)')
  // while engaged: auto.entry and the owned temp (base = the entry's temp)
  const eng = { units: { kitchen: { auto: { phase: 'precondition', eventId: '2026-09-24@07:00', params: { season: 'heating', deltaF: 3, leadMin: 120, source: 'config' },
    entry: { key: 's:2026-09-24@07:00', at: ISOL(THU, '07:00'), fields: { power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' } },
    owned: { power: { original: 'OFF', applied: 'ON', status: 'held' }, temp: { original: 68, applied: 73, status: 'held' } }, baseline: { power: 'OFF', mode: 'COOL', temp: 68 } } } } }
  const pe = tou.plan(cfg, eng, tz, THU, { live: { kitchen: { power: 'ON', mode: 'HEAT', temp: 73 } } }).events[0].units.kitchen
  assert.equal(pe.precondition, 'heat +3° → 73° from 5:00 (scheduled Heat 70°)')
  assert.equal(pe.entry.label, 'On · Heat 70° · Low')
  assert.equal(pe.restore, 'Heat 70° · Low')
  // opted out ⇒ neither; the C dry-out forecast text is injected (tou imports no system.js)
  const opt = withSched([{ at: '07:00', power: 'ON', mode: 'HEAT' }])
  opt.u.shed = false
  opt.u.precondition = false
  const pp = tou.plan(opt.cfg, { units: {} }, tz, THU, { live, dryoutSkip: { 'living-room': ['Office'], office: { units: ['Kitchen', 'Den'], season: 'heating' } } })
  assert.deepEqual([pp.events[0].units.kitchen.entry, pp.events[0].units.kitchen.restore], [null, null])
  assert.equal(pp.events[0].units['living-room'].dryout, 'skipped if Office is cooling')
  assert.equal(pp.events[0].units.office.dryout, 'skipped if Kitchen and Den are heating')
  assert.equal(pp.events[0].units.kitchen.dryout, null)
})

test('plan (B §3.4, D E1/E2): entries per unit — days, folded, startAt/lead from opts.early, earlyMax', () => {
  const { cfg } = withSched(KITCHEN_SCHED)
  cfg.precondition.optimumStart = 60
  const thu = tou.plan(cfg, { units: {}, ledger: {} }, tz, THU, { live: {} })
  assert.deepEqual(Object.keys(thu.entries).sort(), ['kitchen', 'living-room', 'office'])
  assert.deepEqual(thu.entries.office, [])
  assert.deepEqual(thu.entries.kitchen.map((x) => [x.key, x.at, x.atLabel, x.label, x.folded, x.days, x.startAt ?? null, x.earlyMax ?? null]), [
    ['s:2026-09-24@07:00', ISOL(THU, '07:00'), '7:00', 'On · Heat 70° · Low', '2026-09-24@07:00', 'weekday', null, null],
    ['s:2026-09-24@22:00', ISOL(THU, '22:00'), '22:00', 'Off', null, 'all', null, null],
  ])
  assert.deepEqual(thu.entries.kitchen[0].fields, { power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' })
  // a skipped event does not fold: entries fire on time (F3.14)
  const skipped = tou.plan(cfg, { units: { kitchen: { skipDate: THU } }, ledger: {} }, tz, THU, { live: {} })
  assert.equal(skipped.entries.kitchen[0].folded, null)
  // Saturday: no peak ⇒ the ON entry may start early
  const noInj = tou.plan(cfg, { units: {}, ledger: {} }, tz, SAT, { live: {} })
  assert.deepEqual(noInj.entries.kitchen.map((x) => [x.hhmm ?? x.atLabel, x.startAt ?? null, x.earlyMax ?? null]), [['7:00', null, 60], ['22:00', null, null]])
  const early = { kitchen: { entry: { key: 's:2026-09-26@07:00' }, startAt: L(SAT, '06:05'), lead: 55 } }
  const inj = tou.plan(cfg, { units: {}, ledger: {} }, tz, SAT, { live: {}, early })
  assert.deepEqual([inj.entries.kitchen[0].startAt, inj.entries.kitchen[0].lead, inj.entries.kitchen[0].earlyMax], [ISOL(SAT, '06:05'), 55, undefined])
  const tomorrow = tou.plan(cfg, { units: {}, ledger: {} }, tz, '2026-09-27', { live: {}, early })
  assert.deepEqual([tomorrow.entries.kitchen[0].startAt, tomorrow.entries.kitchen[0].earlyMax], [undefined, 60], "tomorrow's entry: only the cap")
  // precondition:false ⇒ never an early start
  cfg.units.find((u) => u.id === 'kitchen').precondition = false
  assert.equal(tou.plan(cfg, { units: {} }, tz, SAT, { live: {} }).entries.kitchen[0].earlyMax, undefined)
})

test('plan (C §3.5, D E4): units[id].entryDryOut from the live read and the markers', () => {
  const { cfg } = withSched(KITCHEN_SCHED)
  cfg.precondition.optimumStart = 60
  cfg.units.find((u) => u.id === 'office').schedule = [{ at: '22:00', power: 'OFF' }, { at: '14:00', power: 'OFF' }]
  const live = { kitchen: { power: 'ON', mode: 'HEAT', temp: 70, room: 66 }, office: { power: 'ON', mode: 'COOL', temp: 74, caps: { modes: ['COOL', 'FAN'] } } }
  const early = { kitchen: { entry: { key: 's:2026-09-26@07:00' }, startAt: L(SAT, '06:05'), lead: 55 } }
  const p = tou.plan(cfg, { units: {}, ledger: {} }, tz, SAT, { live, early, now: L(SAT, '12:00') })
  assert.deepEqual(p.units.kitchen, { entryDryOut: { until: ISOL(SAT, '22:15') } }, 'heating 15 min after the next OFF entry')
  assert.deepEqual(p.units.office, { entryDryOut: { until: ISOL(SAT, '15:00') } }, 'the NEXT OFF entry (14:00), cooling 60')
  assert.deepEqual(p.units['living-room'], {}, 'no read ⇒ no prediction')
  const late = tou.plan(cfg, { units: {} }, tz, SAT, { live, now: L(SAT, '23:00') })
  assert.deepEqual(late.units.kitchen, {}, 'no OFF entry after now')
  const inFan = tou.plan(cfg, { units: {} }, tz, SAT, { live: { office: { power: 'ON', mode: 'FAN' } }, now: L(SAT, '12:00') })
  assert.deepEqual(inFan.units.office, {}, 'a unit in Fan (a follower under a master in Fan) predicts nothing')
  const noFan = tou.plan(cfg, { units: {} }, tz, SAT, { live: { office: { power: 'ON', mode: 'COOL', caps: { modes: ['COOL', 'HEAT'] } } }, now: L(SAT, '12:00') })
  assert.deepEqual(noFan.units.office, {}, 'no FAN in caps')
  const zero = structuredClone(cfg)
  zero.shed.fanOnlyMin = { cooling: 0, heating: 0 }
  assert.deepEqual(tou.plan(zero, { units: {} }, tz, SAT, { live, now: L(SAT, '12:00') }).units.kitchen, {})

  const kinds = p.markers.map((m) => `${m.kind}@${hm(Date.parse(m.at))}${m.end ? `-${hm(Date.parse(m.end))}` : ''}:${m.units.join('+')}`)
  assert.deepEqual(kinds, ['start@06:05-07:00:kitchen', 'entry@07:00:kitchen', 'entry@14:00:office', 'dryout@14:00-15:00:office', 'entry@22:00:kitchen+office', 'dryout@22:00-22:15:kitchen'])
  const at7 = p.markers.find((m) => m.kind === 'entry' && m.units[0] === 'kitchen' && m.lines.length === 1)
  assert.deepEqual(at7.lines, [{ unit: 'kitchen', name: 'Kitchen', at: ISOL(SAT, '07:00'), label: 'On · Heat 68°', note: 'starts ~6:05 AM (room 66°)' }])
  const at22 = p.markers.find((m) => m.kind === 'entry' && m.units.length === 2)
  assert.deepEqual(at22.lines.map((l) => [l.name, l.label, l.note]), [['Kitchen', 'Off', 'fan-only, then off at 10:15 PM'], ['Office', 'Off', null]], 'the band only on the predicted entry')
  assert.equal(p.markers.find((m) => m.kind === 'entry' && m.units[0] === 'office' && m.lines.length === 1).lines[0].note, 'fan-only, then off at 3:00 PM')
  // Thursday: a folded entry marks the restore; other ON entries say how early they may start
  const thu = tou.plan(cfg, { units: {} }, tz, THU, { live: {} })
  const folded = thu.markers.find((m) => m.kind === 'folded')
  assert.deepEqual([folded.at, folded.lines[0].note], [ISOL(THU, '10:00'), 'applies at 10:00 AM when the peak ends'])
  cfg.units.find((u) => u.id === 'office').schedule = [{ at: '14:00', power: 'ON', mode: 'COOL' }]
  const may = tou.plan(cfg, { units: {} }, tz, THU, { live: {} }).markers.find((m) => m.units.includes('office'))
  assert.equal(may.lines[0].note, 'may start up to 60 min early')
  assert.deepEqual(tou.plan(cfgDefault(), { units: {} }, tz, THU, { live: {} }).markers, [])
})

test('tou.js imports neither tuning.js nor system.js nor early.js (D E2.11, C CD-5)', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../tou.js', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  for (const bad of ['./tuning.js', './system.js', './early.js']) assert.ok(!imports.includes(bad), bad)
})

test('plan: weekday texts per unit (live, owned, flags, skip, ledger)', () => {
  const cfg = cfgDefault()
  cfg.units.push({ id: 'den', name: 'Den', host: '198.51.100.85', order: 4, shed: false, precondition: false })
  const live = {
    kitchen: { power: 'ON', mode: 'COOL', temp: 74 },
    'living-room': { power: 'OFF', mode: 'HEAT', temp: 70 },
    office: { power: 'ON', mode: 'HEAT', temp: 70 },
    'den': { power: 'ON', mode: 'COOL', temp: 72 },
  }
  const state = { units: { office: { skipDate: null } }, ledger: {} }
  const p = tou.plan(cfg, state, tz, WED, { live })
  assert.equal(p.date, WED)
  assert.equal(p.dow, 3)
  assert.equal(p.dayType, 'weekday')
  assert.equal(p.holiday, null)
  assert.equal(p.segments.length, 6)
  assert.equal(p.segments[1].start, '2026-09-23T14:00:00.000Z')
  const [am, pm] = p.events
  assert.equal(am.id, '2026-09-23@07:00')
  assert.equal(am.preStart, '2026-09-23T12:00:00.000Z')
  assert.equal(am.peakStart, '2026-09-23T14:00:00.000Z')
  assert.equal(am.peakEnd, '2026-09-23T17:00:00.000Z')
  assert.equal(am.precondition, true)
  assert.deepEqual(Object.keys(am.units), ['kitchen', 'living-room', 'den', 'office']) // by order
  assert.equal(am.units.kitchen.precondition, 'cool −3° → 71° from 5:00')
  assert.equal(am.units.kitchen.target, 71)
  assert.equal(am.units.kitchen.shed, 'off')
  assert.equal(am.units['living-room'].precondition, 'skip: unit off')
  assert.equal(am.units.office.precondition, 'heat +3° → 73° from 5:00')
  assert.equal(am.units['den'].precondition, 'off')
  assert.equal(am.units['den'].shed, 'opted out')
  assert.equal(pm.preStart, null)
  assert.equal(pm.units.kitchen.precondition, 'off')
  assert.equal(pm.units.kitchen.shed, 'off')

  const s2 = { units: { office: { skipDate: WED } }, ledger: { kitchen: { '2026-09-23@07:00': { status: 'released', at: 'x' } } } }
  const p2 = tou.plan(cfg, s2, tz, WED, { live: (id) => live[id] })
  assert.equal(p2.events[0].units.office.shed, 'skipped')
  assert.equal(p2.events[0].units.kitchen.shed, 'released')
})

test('plan: modes, clamps and missing reads', () => {
  const cfg = cfgDefault()
  const txt = (l) => tou.plan(cfg, null, tz, WED, { live: { kitchen: l } }).events[0].units.kitchen.precondition
  assert.equal(txt({ power: 'ON', mode: 'DRY', temp: 74 }), 'cool −3° → 71° from 5:00')
  assert.equal(txt({ power: 'ON', mode: 'FAN', temp: 74 }), 'skip: mode FAN')
  assert.equal(txt({ power: 'ON', mode: 'AUTO', temp: 74 }), 'skip: mode AUTO')
  assert.equal(txt({ power: 'ON', mode: 'COOL', temp: 66 }), 'cool −1° → 65° from 5:00') // floor 65
  assert.equal(txt({ power: 'ON', mode: 'COOL', temp: 65 }), 'skip: already at floor')
  assert.equal(txt({ power: 'ON', mode: 'HEAT', temp: 75 }), 'heat +1° → 76° from 5:00') // ceiling 76
  assert.equal(txt({ power: 'ON', mode: 'HEAT', temp: 76 }), 'skip: already at ceiling')
  assert.equal(txt(null), '±3° from 5:00')
  cfg.precondition.modes = ['HEAT']
  assert.equal(txt({ power: 'ON', mode: 'COOL', temp: 74 }), 'skip: mode COOL')
})

test('plan (H6): frozen auto.params for the active event; tuned effective params otherwise', () => {
  const cfg = cfgDefault()
  const owning = {
    units: {
      office: {
        auto: {
          phase: 'precondition', eventId: '2026-09-23@07:00',
          baseline: { power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' },
          params: { season: 'heating', deltaF: 4, leadMin: 150, clampF: { coolingMin: 65, heatingMax: 76 }, source: 'tuned' },
          owned: { temp: { original: 70, applied: 74, status: 'held' } },
        },
      },
    },
  }
  // live has since drifted — the plan still reports the frozen ownership
  const p = tou.plan(cfg, owning, tz, WED, { live: { office: { power: 'ON', mode: 'HEAT', temp: 74 } } })
  assert.equal(p.events[0].units.office.precondition, 'heat +4° → 74° from 4:30 · auto-tuned')
  assert.equal(p.events[0].units.office.preStart, new Date(L(WED, '04:30')).toISOString())
  assert.equal(p.events[0].preStart, new Date(L(WED, '04:30')).toISOString()) // earliest unit window

  // idle unit with a tuned value: fallback §5.2 effective params (clamped to maxDeltaF 4)
  const tuned = { units: { office: { tuning: { heating: { deltaF: 5, leadMin: 150 }, cooling: {} } } } }
  const p2 = tou.plan(cfg, tuned, tz, WED, { live: { office: { power: 'ON', mode: 'HEAT', temp: 70 } } })
  assert.equal(p2.events[0].units.office.precondition, 'heat +4° → 74° from 4:30 · auto-tuned')
  assert.equal(p2.events[0].units.office.source, 'tuned')

  // injected effectivePrecondition wins over the fallback
  let calls = 0
  const eff = (c, u, us, season) => { calls++; return { season, deltaF: 2, leadMin: 60, clampF: c.precondition.clampF, suspended: false, source: 'config' } }
  const p3 = tou.plan(cfg, null, tz, WED, { live: { office: { power: 'ON', mode: 'HEAT', temp: 70 } }, effectivePrecondition: eff })
  assert.equal(p3.events[0].units.office.precondition, 'heat +2° → 72° from 6:00')
  assert.ok(calls > 0)

  // suspended unit
  const susp = { units: { office: { tuning: { suspended: { since: WED, changeId: 't_x' } } } } }
  assert.match(tou.plan(cfg, susp, tz, WED, { live: { office: { power: 'ON', mode: 'HEAT', temp: 70 } } }).events[0].units.office.precondition, /^skip: paused/)
})

// ---- addendum B F2: fan-only dry-out ------------------------------------------------------------

test('dryOutUntilFor (F2.5): min(from + shed.fanOnlyMin[season], peakEnd); null when the season has no dry-out', () => {
  const cfg = cfgDefault()
  const [am, pm] = tou.events(cfg, tz, WED)
  const at = (ms) => (ms == null ? null : hm(ms))
  assert.equal(at(tou.dryOutUntilFor(cfg, am, 'heating')), '07:15', 'from defaults to peakStart')
  assert.equal(at(tou.dryOutUntilFor(cfg, am, 'cooling')), '08:00')
  assert.equal(at(tou.dryOutUntilFor(cfg, pm, 'heating')), '17:15')
  assert.equal(at(tou.dryOutUntilFor(cfg, am, 'cooling', L(WED, '07:40'))), '08:40', 'a late join dries out from its entry read')
  assert.equal(tou.dryOutUntilFor(cfg, am, 'cooling', L(WED, '09:30')), am.peakEnd, 'clamped to peakEnd')
  for (const season of [null, undefined, 'auto', 'FAN']) assert.equal(tou.dryOutUntilFor(cfg, am, season), null, String(season))
  cfg.shed.fanOnlyMin = { cooling: 0, heating: 180 }
  assert.equal(tou.dryOutUntilFor(cfg, am, 'cooling'), null, '0 = straight to OFF')
  assert.equal(tou.dryOutUntilFor(cfg, am, 'heating'), am.peakEnd, 'fan-only for the whole peak (F2.9)')
  delete cfg.shed.fanOnlyMin
  assert.equal(at(tou.dryOutUntilFor(cfg, am, 'cooling')), '08:00', 'missing ⇒ the shipped defaults (60 / 15)')
  assert.equal(at(tou.dryOutUntilFor(cfg, am, 'heating')), '07:15')
  delete cfg.shed
  assert.equal(at(tou.dryOutUntilFor(cfg, am, 'heating')), '07:15')
  assert.equal(tou.dryOutUntilFor(cfg, null, 'heating'), null)
})

test('nextBoundaryAfter: fan-only deadlines peakStart + fanOnlyMin for both seasons, clamped to peakEnd', () => {
  const cfg = cfgDefault()
  const next = (hhmm) => hm(tou.nextBoundaryAfter(cfg, tz, L(WED, hhmm)))
  assert.deepEqual(['07:00', '07:15', '08:00', '17:00', '17:15', '18:00'].map(next), ['07:15', '08:00', '10:00', '17:15', '18:00', '20:00'])
  cfg.shed.fanOnlyMin = { cooling: 0, heating: 0 }
  assert.deepEqual(['07:00', '17:00'].map(next), ['10:00', '20:00'], 'no dry-out ⇒ the core boundaries only')
  cfg.shed.fanOnlyMin = { cooling: 180, heating: 180 }
  assert.deepEqual(['07:00', '17:00'].map(next), ['10:00', '20:00'], 'a deadline at peakEnd adds nothing')
  cfg.shed.fanOnlyMin = { cooling: 45, heating: 0 }
  assert.deepEqual(['06:59', '07:00', '07:45'].map(next), ['07:00', '07:45', '10:00'])
})

test('plan: fanOnlyUntil per unit (addendum B §3.4) — prediction from the read, the persisted deadline while in shed', () => {
  const cfg = cfgDefault()
  cfg.units.push({ id: 'den', name: 'Den', host: '198.51.100.85', order: 4, shed: false, precondition: false })
  const AM = `${WED}@07:00`
  const isoAt = (hhmm) => new Date(L(WED, hhmm)).toISOString()
  const live = {
    kitchen: { power: 'ON', mode: 'COOL', temp: 74, caps: { modes: ['AUTO', 'DRY', 'COOL', 'HEAT', 'FAN'] } },
    'living-room': { power: 'OFF', mode: 'HEAT', temp: 70 },
    office: { power: 'ON', mode: 'HEAT', temp: 70 },
    'den': { power: 'ON', mode: 'COOL', temp: 72 },
  }
  const p = tou.plan(cfg, null, tz, WED, { live })
  const [am, pm] = p.events
  assert.equal(am.units.kitchen.fanOnlyUntil, isoAt('08:00'), 'running COOL ⇒ cooling 60')
  assert.equal(am.units.office.fanOnlyUntil, isoAt('07:15'), 'running HEAT ⇒ heating 15 (caps unknown ⇒ eligible)')
  assert.equal(am.units['living-room'].fanOnlyUntil, null, 'off at shed entry ⇒ no dry-out')
  assert.equal(am.units['den'].fanOnlyUntil, null, 'opted out')
  assert.equal(pm.units.kitchen.fanOnlyUntil, isoAt('18:00'), 'the evening peak dries out too (F2.1)')
  assert.equal(pm.units.office.fanOnlyUntil, isoAt('17:15'))

  const one = (l, state = null, c = cfg) => tou.plan(c, state, tz, WED, { live: { kitchen: l } }).events[0].units.kitchen.fanOnlyUntil
  assert.equal(one({ power: 'ON', mode: 'DRY', temp: 74 }), isoAt('08:00'), 'DRY is cooling')
  assert.equal(one({ power: 'ON', mode: 'FAN', temp: 74 }), null, 'FAN ⇒ straight OFF (F2.4)')
  assert.equal(one({ power: 'ON', mode: 'AUTO', temp: 74 }), null, 'AUTO ⇒ straight OFF')
  assert.equal(one({ power: 'ON', mode: 'COOL', temp: 74, caps: { modes: ['DRY', 'COOL', 'HEAT'] } }), null, 'no Fan mode ⇒ straight OFF')
  assert.equal(one(null), null, 'no reading')
  assert.equal(one({ power: 'ON', mode: 'COOL', temp: 65 }), isoAt('08:00'), 'independent of the precondition bump (already at floor)')

  const whole = cfgDefault()
  whole.shed.fanOnlyMin = { cooling: 180, heating: 0 }
  assert.equal(one({ power: 'ON', mode: 'COOL', temp: 74 }, null, whole), isoAt('10:00'), 'clamped to peakEnd')
  assert.equal(one({ power: 'ON', mode: 'HEAT', temp: 70 }, null, whole), null, 'fanOnlyMin 0')

  // skipped / released units do not shed this event
  assert.equal(one(live.kitchen, { units: { kitchen: { skipDate: WED } } }), null)
  assert.equal(one(live.kitchen, { units: {}, ledger: { kitchen: { [AM]: { status: 'released', at: 'x' } } } }), null)

  // engaged: the persisted deadline wins in shed (a late join after downtime dries out from its entry read) …
  const inShed = (dryOutUntil) => ({ units: { kitchen: { auto: { phase: 'shed', eventId: AM, baseline: { power: 'ON', mode: 'COOL', temp: 74 }, owned: {}, dryOutUntil } } } })
  assert.equal(one({ power: 'ON', mode: 'FAN', temp: 74 }, inShed(isoAt('08:30'))), isoAt('08:30'))
  assert.equal(one({ power: 'ON', mode: 'COOL', temp: 74 }, inShed(null)), null, 'shed entered straight OFF')
  // … while pre-conditioning the phase-entry read predicts it (the precondition text reads it too)
  const pre = { units: { kitchen: { auto: { phase: 'precondition', eventId: AM, baseline: { power: 'ON', mode: 'HEAT', temp: 70 }, owned: {} } } } }
  assert.equal(one({ power: 'ON', mode: 'COOL', temp: 74 }, pre), isoAt('07:15'))
  // another event's shed does not leak into this one
  const other = { units: { kitchen: { auto: { phase: 'shed', eventId: `${WED}@17:00`, owned: {}, dryOutUntil: null } } } }
  assert.equal(one(live.kitchen, other), isoAt('08:00'))
})

test('plan without injection = with injection for a Δ-only tuned unit (X1.1: fallbackEff mirrors tuning.js)', async () => {
  const { effectivePrecondition } = await import('../tuning.js')
  const cfg = cfgDefault()
  cfg.precondition.leadMin.heating = 180 // base start 04:00
  cfg.optimizer = { enabled: true, earliestStart: '04:30', minDeltaF: 1, maxDeltaF: 4, minLeadMin: 60 }
  const state = { units: { kitchen: { auto: { phase: 'idle' }, tuning: { heating: { deltaF: 4, leadMin: null } } } }, ledger: {} }
  const live = { kitchen: { power: 'ON', mode: 'HEAT', temp: 68 } }
  const fall = tou.plan(cfg, state, tz, '2026-09-23', { live })
  const inj = tou.plan(cfg, state, tz, '2026-09-23', { live, effectivePrecondition })
  const pre = (p) => p.events[0].units.kitchen.preStart
  assert.equal(pre(fall), new Date(L('2026-09-23', '04:00')).toISOString())
  assert.equal(pre(fall), pre(inj))
  // a tuned lead is still held to earliestStart on both paths
  state.units.kitchen.tuning.heating = { deltaF: null, leadMin: 180 }
  assert.equal(pre(tou.plan(cfg, state, tz, '2026-09-23', { live })), new Date(L('2026-09-23', '04:30')).toISOString())
  assert.equal(pre(tou.plan(cfg, state, tz, '2026-09-23', { live, effectivePrecondition })), new Date(L('2026-09-23', '04:30')).toISOString())
})

test('plan: weekend and holiday days', () => {
  const cfg = cfgDefault()
  const sat = tou.plan(cfg, null, tz, SAT)
  assert.equal(sat.dayType, 'weekend')
  assert.deepEqual(sat.events, [])
  const tg = tou.plan(cfg, null, tz, THANKSGIVING)
  assert.equal(tg.dayType, 'holiday')
  assert.equal(tg.holiday, 'Thanksgiving Day')
  assert.deepEqual(tg.events, [])
  assert.equal(tg.segments.length, 3)
  // addendum E: with the weekend pre-condition on, one boundary event each
  cfg.precondition.superOffPeak = { weekend: true }
  for (const d of [SAT, THANKSGIVING]) assert.deepEqual(tou.plan(cfg, null, tz, d).events.map((e) => [e.id, e.kind]), [[`${d}@07:00`, 'boundary']], d)
})

test('validate additions (addendum §8): guardrails, earliestStart', () => {
  const ok = validate(cfgDefault())
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.warnings, [])

  const bad = cfgDefault()
  bad.optimizer.maxDeltaF = 7
  bad.optimizer.minLeadMin = 10
  bad.optimizer.comfyMarginF = 0.5
  bad.optimizer.maxStepDeltaF = 2
  const paths = validate(bad).errors.map((e) => e.path)
  assert.ok(paths.includes('optimizer.maxDeltaF'))
  assert.ok(paths.includes('optimizer.minLeadMin'))
  assert.ok(paths.includes('optimizer.comfyMarginF'))
  assert.ok(paths.includes('optimizer.maxStepDeltaF'))

  const late = cfgDefault()
  late.optimizer.earliestStart = '06:30' // 07:00 − 60 = 06:00 is the latest allowed
  assert.deepEqual(validate(late).errors.map((e) => e.path), ['optimizer.earliestStart'])
  late.optimizer.earliestStart = '06:00'
  assert.deepEqual(validate(late).errors, [])
})

// ---- Release 4.1 (addendum E): boundary events before the weekend off-peak ------------------------

const SUN = '2026-09-27'
const LABOR = '2026-09-07' // us-federal holiday, a Monday
const DST_SPRING = '2026-03-08'
const DST_FALL = '2026-11-01'
function cfgE(over = {}) {
  const cfg = cfgDefault()
  cfg.precondition.superOffPeak = { weekend: true }
  if (over.weekendHoliday) cfg.tou.weekendHoliday = over.weekendHoliday
  if (over.schedule) cfg.units[0].schedule = over.schedule
  return cfg
}
const boundaryOf = (cfg, date) => tou.events(cfg, tz, date).find((e) => e.kind === 'boundary')

test('E events: option off ⇒ unchanged on the weekend, holiday and DST dates; weekday peaks gain only kind', () => {
  const off = cfgDefault()
  const offExplicit = cfgDefault()
  offExplicit.precondition.superOffPeak = { weekend: false }
  for (const d of [SAT, SUN, LABOR, DST_SPRING, DST_FALL]) {
    assert.deepEqual(tou.events(off, tz, d), [], d)
    assert.deepEqual(tou.events(offExplicit, tz, d), [], d)
  }
  const wed = tou.events(off, tz, WED)
  assert.deepEqual(wed.map((e) => e.kind), ['peak', 'peak'])
  assert.deepEqual(tou.events(cfgE(), tz, WED), wed, 'a weekday is untouched by the option')
  assert.deepEqual(tou.events(offExplicit, tz, WED), wed)
})

test('E events: option on ⇒ one boundary event at 07:00 on Saturday, Sunday and Labor Day, none on a weekday', () => {
  const cfg = cfgE()
  for (const d of [SAT, SUN, LABOR]) {
    assert.deepEqual(tou.events(cfg, tz, d), [{ id: `${d}@07:00`, date: d, kind: 'boundary', peakStart: L(d, '07:00'), peakEnd: L(d, '07:00'), precondition: true, windows: [] }], d)
  }
  assert.ok(tou.events(cfg, tz, WED).every((e) => e.kind === 'peak'))
  // DST Sundays: instants from zonedToInstant; 2 h of real time before 07:00 either way
  for (const d of [DST_SPRING, DST_FALL]) {
    const b = boundaryOf(cfg, d)
    assert.equal(b.peakStart, L(d, '07:00'), d)
    const w = tou.preconditionWindow(cfg, tz, b, 'heating')
    assert.deepEqual([w.preStart, w.leadMin], [L(d, '05:00'), 120], d)
  }
})

test('E events: user weekend tables — two boundaries, peaks before and after (the prev clamp), a 03:10 boundary', () => {
  const two = cfgE({ weekendHoliday: [{ start: '07:00', end: '12:00', tier: 'off_peak' }, { start: '14:00', end: '23:00', tier: 'off_peak' }] })
  assert.deepEqual(tou.events(two, tz, SAT).map((e) => [e.id, e.kind]), [[`${SAT}@07:00`, 'boundary'], [`${SAT}@14:00`, 'boundary']])
  const second = tou.events(two, tz, SAT)[1]
  assert.equal(hm(tou.preconditionWindow(two, tz, second, 'heating').preStart), '12:00', 'lead 120 from 14:00')
  // an evening peak after the boundary: sorted by peakStart; its window starts ≥ the boundary + mergeGapMin
  const evening = cfgE({ weekendHoliday: [{ start: '07:00', end: '16:00', tier: 'off_peak' }, { start: '16:00', end: '19:00', tier: 'peak', precondition: true }, { start: '19:00', end: '23:00', tier: 'off_peak' }] })
  assert.deepEqual(tou.events(evening, tz, SAT).map((e) => [e.id, e.kind, hm(e.peakStart), hm(e.peakEnd)]), [[`${SAT}@07:00`, 'boundary', '07:00', '07:00'], [`${SAT}@16:00`, 'peak', '16:00', '19:00']])
  assert.equal(hm(tou.preconditionWindow(evening, tz, tou.events(evening, tz, SAT)[1], 'heating').preStart), '14:00')
  const morning = cfgE({ weekendHoliday: [{ start: '07:00', end: '09:00', tier: 'off_peak' }, { start: '09:00', end: '12:00', tier: 'peak', precondition: true }, { start: '12:00', end: '23:00', tier: 'off_peak' }] })
  assert.equal(hm(tou.preconditionWindow(morning, tz, tou.events(morning, tz, SAT)[1], 'heating').preStart), '07:30', 'never across the boundary')
  // a 04:00–06:00 peak before the boundary is the boundary's previous event
  const before = cfgE({ weekendHoliday: [{ start: '04:00', end: '06:00', tier: 'peak' }, { start: '07:00', end: '23:00', tier: 'off_peak' }] })
  assert.deepEqual(tou.events(before, tz, SAT).map((e) => [e.kind, hm(e.peakStart)]), [['peak', '04:00'], ['boundary', '07:00']])
  assert.deepEqual(tou.preconditionWindow(before, tz, boundaryOf(before, SAT), 'heating'), { preStart: L(SAT, '06:30'), peakStart: L(SAT, '07:00'), leadMin: 30, season: 'heating' })
  // a boundary at 03:10: held to 03:00 ⇒ 10 min < minLeadMin ⇒ no window
  const early = cfgE({ weekendHoliday: [{ start: '03:10', end: '23:00', tier: 'off_peak' }] })
  assert.equal(boundaryOf(early, SAT).id, `${SAT}@03:10`)
  assert.equal(tou.preconditionWindow(early, tz, boundaryOf(early, SAT), 'heating'), null)
  assert.equal(tou.activeEventFor(early, tz, early.units[0], L(SAT, '03:05')), null)
  // an off-peak table starting at 00:00 has no boundary there
  assert.deepEqual(tou.events(cfgE({ weekendHoliday: [{ start: '00:00', end: '23:00', tier: 'off_peak' }] }), tz, SAT), [])
})

test('E preconditionWindow on a boundary: both seasons, eff lead, tuned lead held to earliestStart, the 03:00 clamp on DST Sundays', () => {
  const cfg = cfgE()
  cfg.precondition.leadMin = { cooling: 90, heating: 120 }
  const b = boundaryOf(cfg, SAT)
  assert.equal(hm(tou.preconditionWindow(cfg, tz, b, 'heating').preStart), '05:00')
  assert.equal(hm(tou.preconditionWindow(cfg, tz, b, 'cooling').preStart), '05:30')
  assert.equal(hm(tou.preconditionWindow(cfg, tz, b, 'heating', { leadMin: 60, source: 'config' }).preStart), '06:00')
  assert.equal(hm(tou.preconditionWindow(cfg, tz, b, 'heating', { leadMin: 180, source: 'tuned', earliestStart: '04:30' }).preStart), '04:30')
  assert.equal(tou.preconditionWindow(cfg, tz, b, 'heating', { suspended: true }), null)
  const six = cfgE({ weekendHoliday: [{ start: '06:00', end: '23:00', tier: 'off_peak' }] })
  six.precondition.leadMin = { cooling: 240, heating: 240 }
  for (const d of [DST_SPRING, DST_FALL]) {
    const w = tou.preconditionWindow(six, tz, boundaryOf(six, d), 'heating')
    assert.deepEqual([w.preStart, w.leadMin], [L(d, '03:00'), 180], d)
  }
})

test('E dryOutUntilFor: null for a boundary event (no fan-only deadline); a peak event unchanged', () => {
  const cfg = cfgE()
  const b = boundaryOf(cfg, SAT)
  for (const s of ['heating', 'cooling']) {
    assert.equal(tou.dryOutUntilFor(cfg, b, s), null, s)
    assert.equal(tou.dryOutUntilFor(cfg, b, s, L(SAT, '07:10')), null, s)
  }
  const wed = tou.events(cfg, tz, WED)[0]
  assert.equal(tou.dryOutUntilFor(cfg, wed, 'heating'), L(WED, '07:15'))
  assert.equal(tou.dryOutUntilFor(cfg, wed, 'cooling', L(WED, '09:30')), L(WED, '10:00'))
  assert.equal(tou.dryOutUntilFor(cfg, wed, 'cooling', L(WED, '10:00')), null, 'a deadline at or before from is none')
})

test('E nextBoundaryAfter / firstPreconditionDate / activeEventFor see boundary events', () => {
  const on = cfgE()
  const off = cfgDefault()
  const next = (cfg, date, hhmm) => { const t = tou.nextBoundaryAfter(cfg, tz, L(date, hhmm)); return `${day(t)} ${hm(t)}` }
  assert.equal(next(on, SAT, '00:00'), `${SAT} 05:00`, 'the base pre-condition start')
  assert.equal(next(off, SAT, '00:00'), `${SAT} 07:00`)
  assert.equal(next(on, SAT, '05:00'), `${SAT} 07:00`, 'no fan-only deadline after the boundary')
  assert.equal(next(on, SAT, '07:00'), `${SAT} 23:00`)
  assert.equal(next(on, FRI, '23:30'), `${SAT} 00:00`)
  assert.equal(tou.firstPreconditionDate(on, tz, SAT), SAT)
  assert.equal(tou.firstPreconditionDate(off, tz, SAT), '2026-09-28')
  assert.equal(tou.firstPreconditionDate(on, tz, THANKSGIVING), THANKSGIVING)
  assert.equal(tou.firstPreconditionDate(on, tz, FRI), FRI, 'a weekday keeps its own peak')
  const u = on.units[0]
  assert.equal(tou.activeEventFor(on, tz, u, L(SAT, '04:59')), null)
  for (const hhmm of ['05:00', '06:59']) {
    const a = tou.activeEventFor(on, tz, u, L(SAT, hhmm))
    assert.deepEqual([a.event.id, a.event.kind, a.phase, hm(a.preStart)], [`${SAT}@07:00`, 'boundary', 'precondition', '05:00'], hhmm)
  }
  assert.equal(tou.activeEventFor(on, tz, u, L(SAT, '07:00')), null, 'over at its instant: never shed')
  assert.equal(tou.activeEventFor(on, tz, u, L(SAT, '07:00') - 1).phase, 'precondition')
  assert.equal(tou.activeEventFor(on, tz, u, L(LABOR, '05:30')).event.id, `${LABOR}@07:00`)
  assert.equal(tou.activeEventFor(on, tz, u, L(LABOR, '08:00')), null, 'a holiday Monday has no peak')
  assert.equal(tou.activeEventFor(on, tz, { ...u, shed: false }, L(SAT, '05:30')), null, 'shed:false never pre-conditions (E1.11)')
  assert.equal(tou.activeEventFor(on, tz, { ...u, precondition: false }, L(SAT, '06:30')), null)
  const skipped = tou.activeEventFor(on, tz, u, L(SAT, '06:30'), { season: 'cooling', noPrecondition: true })
  assert.equal(skipped, null, 'noPrecondition ⇒ an empty window')
})

test('E eventEntry (E1.6): the entry at the boundary is the target; a peak event still excludes its peakEnd', () => {
  const cfg = cfgE({ schedule: [{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' }, { at: '07:30', power: 'ON', mode: 'COOL' }, { at: '22:00', power: 'OFF' }] })
  const u = cfg.units[0]
  const b = boundaryOf(cfg, SAT)
  const pre = L(SAT, '05:00')
  for (const hhmm of ['05:00', '06:59', '07:00', '07:10']) assert.equal(tou.eventEntry(cfg, tz, u, b, pre, L(SAT, hhmm))?.key, `s:${SAT}@07:00`, hhmm)
  assert.equal(tou.eventEntry(cfg, tz, u, b, pre, L(SAT, '07:00'), L(SAT, '07:00')), null, 'the arming still wins')
  const later = cfgE({ schedule: [{ at: '07:30', power: 'ON', mode: 'HEAT' }] })
  assert.equal(tou.eventEntry(later, tz, later.units[0], boundaryOf(later, SAT), pre, L(SAT, '07:40')), null, 'an entry after the boundary is not its entry')
  const folded = cfgE({ schedule: [{ at: '06:30', power: 'ON', mode: 'HEAT', temp: 68 }] })
  assert.equal(tou.eventEntry(folded, tz, folded.units[0], boundaryOf(folded, SAT), pre, L(SAT, '06:45'))?.key, `s:${SAT}@06:30`)
  const thu = withSched([{ at: '10:00', power: 'ON', mode: 'COOL' }])
  thu.cfg.precondition.superOffPeak = { weekend: true }
  const ev = tou.events(thu.cfg, tz, THU)[0]
  assert.equal(tou.eventEntry(thu.cfg, tz, thu.u, ev, L(THU, '05:00'), L(THU, '10:30')), null, 'peakEnd is never a peak event entry')
})

test('E entryEffFor with livePower (E1.8): an OFF unit without an ON entry has no boundary window; peaks unaffected', () => {
  const eff = (schedule, liveMode, livePower, date = SAT) => {
    const cfg = cfgE({ schedule })
    const e = tou.events(cfg, tz, date)[0]
    return { cfg, e, u: cfg.units[0], ef: tou.entryEffFor(cfg, tz, cfg.units[0], null, liveMode, { livePower })(e) }
  }
  const at = (x, hhmm) => tou.activeEventFor(x.cfg, tz, x.u, L(SAT, hhmm), tou.entryEffFor(x.cfg, tz, x.u, null, 'HEAT', { livePower: x.lp }))
  // OFF (or unknown) + no entry ⇒ noPrecondition
  for (const lp of ['OFF', 'off', null, undefined]) assert.equal(eff([], 'HEAT', lp).ef.noPrecondition, true, String(lp))
  assert.equal(eff([{ at: '22:00', power: 'OFF' }], 'HEAT', 'OFF').ef.noPrecondition, true, "yesterday's Off is no entry for the window")
  // OFF + an ON entry at 07:00 ⇒ the window, never suspended
  const on7 = eff([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }], 'COOL', 'OFF')
  assert.deepEqual([on7.ef.noPrecondition, on7.ef.suspended, on7.ef.season], [undefined, false, 'heating'])
  assert.equal(at({ ...on7, lp: 'OFF' }, '05:00').phase, 'precondition')
  // ON + no entry ⇒ live rules
  const run = eff([], 'HEAT', 'ON')
  assert.equal(run.ef.noPrecondition, undefined)
  assert.equal(at({ ...run, lp: 'ON' }, '05:00').phase, 'precondition')
  assert.equal(at({ ...run, lp: 'OFF' }, '05:00'), null)
  // an ON entry before the window already fired: an OFF unit (turned off since) stays out (J23); a running one is in
  assert.equal(eff([{ at: '04:00', power: 'ON', mode: 'HEAT' }], 'HEAT', 'OFF').ef.noPrecondition, true)
  assert.equal(eff([{ at: '04:00', power: 'ON', mode: 'HEAT' }], 'HEAT', 'ON').ef.noPrecondition, undefined)
  // an OFF entry inside the window ⇒ no precondition whatever the unit reads
  assert.equal(eff([{ at: '06:30', power: 'OFF' }], 'HEAT', 'ON').ef.noPrecondition, true)
  // a weekday peak ignores livePower (an OFF unit still joins for the shed)
  assert.equal(eff([], 'HEAT', 'OFF', THU).ef.noPrecondition, undefined)
  assert.equal(eff([], 'HEAT', 'OFF', THU).e.kind, 'peak')
  // engaged ⇒ the frozen params, whatever the power
  const cfg = cfgE()
  const b = boundaryOf(cfg, SAT)
  const params = { season: 'heating', leadMin: 120, source: 'config' }
  assert.equal(tou.entryEffFor(cfg, tz, cfg.units[0], { auto: { phase: 'precondition', eventId: b.id, params } }, 'HEAT', { livePower: 'OFF' })(b), params)
})

test('E entryEffFor / plan (E1.8, J23): a unit reading ON outside a precondition mode (Fan, Auto) has no boundary window; peaks and ON entries unaffected', () => {
  const eff = (schedule, liveMode, livePower, date = SAT) => {
    const cfg = cfgE({ schedule })
    const e = tou.events(cfg, tz, date)[0]
    return tou.entryEffFor(cfg, tz, cfg.units[0], null, liveMode, { livePower })(e)
  }
  for (const m of ['FAN', 'AUTO', 'fan', '', null, undefined]) assert.equal(eff([], m, 'ON').noPrecondition, true, `ON in ${m}`)
  for (const m of ['HEAT', 'COOL', 'DRY', 'cool']) assert.equal(eff([], m, 'ON').noPrecondition, undefined, `ON in ${m}`)
  assert.equal(eff([{ at: '04:00', power: 'ON', mode: 'HEAT' }], 'FAN', 'ON').noPrecondition, true, 'an ON entry that already fired: live rules, and Fan has none')
  // an ON entry E inside the window decides whatever the unit reads
  const on7 = eff([{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }], 'FAN', 'ON')
  assert.deepEqual([on7.noPrecondition, on7.suspended, on7.season], [undefined, false, 'heating'])
  // Thursday's peak: an ON unit in Fan still joins for the shed
  assert.equal(eff([], 'FAN', 'ON', THU).noPrecondition, undefined)
  // plan: no window, no preStart for the Fan / Auto unit; a running Heat unit keeps its window
  for (const mode of ['FAN', 'AUTO']) {
    const cfg = cfgE({ schedule: [] })
    const p = tou.plan(cfg, { units: {}, ledger: {} }, tz, SAT, { live: { kitchen: { power: 'ON', mode, temp: 70 }, 'living-room': { power: 'ON', mode: 'HEAT', temp: 70 } } })
    const k = p.events[0].units.kitchen
    assert.deepEqual([k.precondition, k.preStart, k.target], ['off', null, null], mode)
    assert.equal(p.events[0].units['living-room'].precondition, 'heat +3° → 73° from 5:00', mode)
  }
})

test('E eventOverlapping / foldEventFor (E1.10): a boundary blocks an optimum start only for a unit that pre-conditions', () => {
  const sched = [{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70 }, { at: '07:30', power: 'ON', mode: 'HEAT', temp: 71 }]
  const withEntry = cfgE({ schedule: sched })
  const u = withEntry.units[0]
  const effE = tou.entryEffFor(withEntry, tz, u, null, 'HEAT', { livePower: 'OFF' })
  assert.equal(tou.eventOverlapping(withEntry, tz, u, L(SAT, '06:00'), L(SAT, '07:00'), effE), true, 'the 07:00 entry is the precondition target')
  assert.equal(tou.eventOverlapping(withEntry, tz, u, L(SAT, '06:30'), L(SAT, '07:30'), effE), true, 'a 07:30 entry within the cap is excluded too')
  assert.equal(tou.eventOverlapping(withEntry, tz, u, L(SAT, '07:00'), L(SAT, '08:00'), effE), false, 'a band from the boundary on')
  const bare = cfgE({ schedule: [{ at: '07:30', power: 'ON', mode: 'HEAT' }] })
  const v = bare.units[0]
  const effB = tou.entryEffFor(bare, tz, v, null, 'HEAT', { livePower: 'OFF' })
  assert.equal(tou.eventOverlapping(bare, tz, v, L(SAT, '06:00'), L(SAT, '07:00'), effB), false, 'an OFF unit without an ON entry at/before 07:00 has no window')
  assert.equal(tou.eventOverlapping(bare, tz, v, L(SAT, '06:30'), L(SAT, '07:30'), effB), false, 'so its 07:30 entry may start early')
  assert.equal(tou.eventOverlapping(bare, tz, v, L(SAT, '06:30'), L(SAT, '07:30'), tou.entryEffFor(bare, tz, v, null, 'HEAT', { livePower: 'ON' })), true, 'a running unit pre-conditions')
  // weekday: unchanged (an OFF unit still participates through its shed)
  assert.equal(tou.eventOverlapping(bare, tz, v, L(THU, '06:00'), L(THU, '07:00'), tou.entryEffFor(bare, tz, v, null, 'HEAT', { livePower: 'OFF' })), true)
  assert.equal(tou.eventOverlapping(bare, tz, v, L(THU, '06:00'), L(THU, '07:00'), () => ({ noPrecondition: true })), true, 'a noPrecondition peak still overlaps at peakStart')
  // folding: an entry inside [preStart, t) folds into the boundary; the entry at t never folds
  assert.equal(tou.foldEventFor(withEntry, tz, u, L(SAT, '06:30'), effE)?.id, `${SAT}@07:00`)
  assert.equal(tou.foldEventFor(withEntry, tz, u, L(SAT, '07:00'), effE), null)
})

test('E plan (§3.4): Saturday — kind, preStart, per-unit texts, no fan-only / dry-out, restore, folded entry at t, markers', () => {
  const cfg = cfgE({ schedule: [{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' }, { at: '22:00', power: 'OFF' }] })
  cfg.precondition.optimumStart = 60
  cfg.units[2].schedule = [{ at: '07:30', power: 'ON', mode: 'COOL', temp: 74 }]
  const live = { kitchen: { power: 'OFF', mode: 'FAN', temp: 70 }, 'living-room': { power: 'ON', mode: 'HEAT', temp: 70 }, office: { power: 'OFF', mode: 'COOL', temp: 74 } }
  const p = tou.plan(cfg, { units: {}, ledger: {} }, tz, SAT, { live, dryoutSkip: { kitchen: ['Office'], 'living-room': ['Office'] } })
  assert.equal(p.events.length, 1)
  const e = p.events[0]
  assert.deepEqual([e.id, e.kind, e.preStart, e.peakStart, e.peakEnd, e.precondition], [`${SAT}@07:00`, 'boundary', ISOL(SAT, '05:00'), ISOL(SAT, '07:00'), ISOL(SAT, '07:00'), true])
  const k = e.units.kitchen
  assert.deepEqual([k.precondition, k.preStart, k.target, k.shed], ['heat +3° → 73° from 5:00 (scheduled Heat 70°)', ISOL(SAT, '05:00'), 73, 'off'], 'OFF overnight, from the 07:00 entry')
  assert.deepEqual([k.fanOnlyUntil, k.dryout, k.restore, k.entry.key], [null, null, 'Heat 70° · Low', `s:${SAT}@07:00`])
  const lr = e.units['living-room']
  assert.deepEqual([lr.precondition, lr.fanOnlyUntil, lr.dryout, lr.restore], ['heat +3° → 73° from 5:00', null, null, null], 'running, live rules')
  const o = e.units.office
  assert.deepEqual([o.precondition, o.preStart, o.restore, o.entry], ['off', null, null, null], 'OFF, no ON entry at/before 07:00: not engaged')
  // entries: the 07:00 ON entry of the pre-conditioning unit folds into the boundary; the office may start early
  assert.deepEqual(p.entries.kitchen.map((x) => [x.atLabel, x.folded, x.earlyMax ?? null]), [['7:00', `${SAT}@07:00`, null], ['22:00', null, null]])
  assert.deepEqual(p.entries.office.map((x) => [x.atLabel, x.folded, x.earlyMax ?? null]), [['7:30', null, 60]])
  // markers: the folded entry sits at t with the pre-condition note, never repeated as an entry
  const kinds = p.markers.map((m) => `${m.kind}@${hm(Date.parse(m.at))}:${m.units.join('+')}`)
  assert.deepEqual(kinds, ['folded@07:00:kitchen', 'entry@07:30:office', 'entry@22:00:kitchen'])
  assert.equal(p.markers[0].lines[0].note, 'pre-conditioned from 5:00 AM')
  // the option off: Release 4's Saturday
  const off = structuredClone(cfg)
  off.precondition.superOffPeak.weekend = false
  const po = tou.plan(off, { units: {}, ledger: {} }, tz, SAT, { live })
  assert.deepEqual(po.events, [])
  assert.deepEqual(po.entries.kitchen.map((x) => [x.folded, x.earlyMax ?? null]), [[null, 60], [null, null]])
})

test('E plan: boundary texts — already conditioned, scheduled off / Fan, skipped, a folded 06:30 entry, holiday', () => {
  const unit = (schedule, liveU, state = { units: {}, ledger: {} }, id = 'office') => {
    const cfg = cfgE()
    cfg.units.find((u) => u.id === id).schedule = schedule
    const p = tou.plan(cfg, state, tz, SAT, { live: { [id]: liveU } })
    return { u: p.events[0].units[id], entries: p.entries[id], markers: p.markers }
  }
  const cool74 = [{ at: '07:00', power: 'ON', mode: 'COOL', temp: 74 }]
  const keeps = unit(cool74, { power: 'ON', mode: 'COOL', temp: 68 })
  assert.deepEqual([keeps.u.precondition, keeps.u.restore], ['keeps 68° (already below the 71° target)', 'Cool 74°'])
  assert.equal(keeps.entries[0].folded, `${SAT}@07:00`, 'already conditioned still engages (power/mode held): the exit applies the entry')
  const offEntry = unit([{ at: '06:30', power: 'OFF' }], { power: 'ON', mode: 'HEAT', temp: 70 })
  assert.deepEqual([offEntry.u.precondition, offEntry.u.preStart, offEntry.entries[0].folded], ['skip: scheduled off', null, null])
  const fan = unit([{ at: '07:00', power: 'ON', mode: 'FAN' }], { power: 'OFF' })
  assert.deepEqual([fan.u.precondition, fan.entries[0].folded], ['skip: scheduled mode Fan', null], 'fires at 07:00 on its own (E1.7)')
  const skipped = unit(cool74, { power: 'OFF' }, { units: { office: { skipDate: SAT } }, ledger: {} })
  assert.deepEqual([skipped.u.shed, skipped.entries[0].folded], ['skipped', null], 'Skip today: the entry fires on time')
  const folded = unit([{ at: '06:30', power: 'ON', mode: 'HEAT', temp: 68 }], { power: 'OFF' })
  assert.deepEqual([folded.u.precondition, folded.u.restore, folded.entries[0].folded], ['heat +3° → 71° from 5:00 (scheduled Heat 68°)', 'Heat 68°', `${SAT}@07:00`])
  const m = folded.markers.find((x) => x.kind === 'folded')
  assert.deepEqual([m.at, m.lines[0].note], [ISOL(SAT, '07:00'), 'applies at 7:00 AM when the pre-condition ends'])
  const optOut = cfgE()
  optOut.units[2].shed = false
  optOut.units[2].precondition = false
  optOut.units[2].schedule = cool74
  const po = tou.plan(optOut, { units: {} }, tz, SAT, { live: {} })
  assert.deepEqual([po.events[0].units.office.shed, po.events[0].units.office.precondition, po.entries.office[0].folded], ['opted out', 'off', null])
  const labor = tou.plan(cfgE({ schedule: [{ at: '07:00', power: 'ON', mode: 'HEAT', temp: 70, days: 'weekday' }] }), { units: {} }, tz, LABOR, { live: { kitchen: { power: 'OFF' } } })
  assert.deepEqual([labor.dayType, labor.events.map((e) => e.kind), labor.entries.kitchen, labor.events[0].units.kitchen.precondition], ['holiday', ['boundary'], [], 'off'], "a days:'weekday' entry is absent on a holiday")
})

test('E plan: a weekday is unchanged by the option except events[].kind', () => {
  const { cfg } = withSched(KITCHEN_SCHED)
  const live = { kitchen: { power: 'ON', mode: 'HEAT', temp: 70 } }
  const off = tou.plan(cfg, { units: {} }, tz, THU, { live })
  const on = tou.plan({ ...cfg, precondition: { ...cfg.precondition, superOffPeak: { weekend: true } } }, { units: {} }, tz, THU, { live })
  assert.deepEqual(on, off)
  assert.deepEqual(off.events.map((e) => e.kind), ['peak', 'peak'])
})
