// test/usage-gen.test.js — self-tests of the usage-log fixture generator (test/helpers/usage-gen.js, addendum §8.1)
// the rollup, optimizer and DST suites are built on: the golden fixture is reproducible, the golden day is a valid §3.5
// record stream, generated days carry the engine's writes and the truth the suites check against, a seed is
// deterministic, and the reference recorder follows the §3.2 attribution rules.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeTz } from '../tz.js'
import { genDays, goldenRecords, toJsonl, GOLDEN_DATE, GOLDEN_FILE, createReferenceRecorder } from './helpers/usage-gen.js'
import { specDefaultConfig } from './helpers/config.js'

describe('usage-gen', () => {
  const tz = makeTz('America/Los_Angeles')
  const hhmm = (t) => tz.localParts(t * 1000).hhmm

  it('the golden fixture is exactly what the generator produces (reproducible)', async () => {
    const g = await goldenRecords()
    assert.equal(g.recorder, 'reference')
    assert.equal(toJsonl(g.byDate[GOLDEN_DATE]), readFileSync(GOLDEN_FILE, 'utf8'))
  })

  it('the golden day is a valid §3.5 record stream: precondition, shed, restore, one external override, outdoor', () => {
    const recs = readFileSync(GOLDEN_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const r of recs) {
      assert.ok(['s', 'c', 'o', 'a', 'p', 'b', 'h'].includes(r.k))
      assert.ok(Number.isInteger(r.t))
      assert.equal(tz.localParts(r.t * 1000).date, GOLDEN_DATE, 'file = local date of t')
    }
    const by = (k) => recs.filter((r) => r.k === k)
    assert.equal(by('h').length, 1)
    assert.equal(by('b').length, 1)
    const s = by('s')
    assert.ok(s.every((r) => r.u === 'office' && r.t % 300 === 0))
    assert.ok(s.filter((r) => r.n === 15 && r.cv === 300).length >= 60, 'steady 20 s polling ⇒ n=15, cv=300')
    const bucket = (h) => s.find((r) => hhmm(r.t) === h)
    assert.equal(bucket('06:00').on, 300)
    assert.equal(bucket('07:00').on, 2, 'OFF verified 2 s into the peak')
    assert.equal(bucket('08:30').on, 0)
    assert.equal(bucket('10:00').on, 198, 'staggered restore (order 5 × 20 s) at 10:01:42')
    const pe = by('a').filter((r) => r.ty === 'phase_enter')
    assert.deepEqual(pe.map((r) => [r.ph, r.se, r.par]), [['precondition', 'heating', { deltaF: 3, leadMin: 120 }], ['shed', 'heating', { deltaF: 3, leadMin: 120 }]])
    const c = by('c')
    assert.deepEqual(c.map((r) => [r.f, r.o, r.v, r.s, hhmm(r.t)]), [
      ['temp', 70, 73, 'schedule', '05:00'], ['power', 'ON', 'OFF', 'schedule', '07:00'], ['temp', 73, 75, 'external', '08:00'], ['power', 'OFF', 'ON', 'schedule', '10:01'],
    ])
    assert.ok(c.every((r) => r.e === '2026-10-14@07:00' && r.gap === null))
    assert.ok(by('a').some((r) => r.ty === 'drop' && r.ac === 'external' && r.f === 'temp'))
    assert.equal(by('a').filter((r) => r.ty === 'write' && r.res === 'verified').length, 3)
    assert.ok(by('o').length >= 10)
  })

  it('a generated weekday: 6 automation writes per unit, 0 on a holiday/weekend, truth on-time and drift', async () => {
    // Fri, Sat, Sun, Mon (Columbus Day). Generator behaviour is pinned to the reference recorder; a host's real
    // usage log is cross-checked by the host's own suite.
    const g = await genDays({ start: '2026-10-09', days: 4, seed: 2, recorder: 'reference', units: [{ id: 'kitchen' }, { id: 'office', order: 5 }] })
    const writes = (u, d) => g.truth.writes.filter((w) => w.unitId === u && tz.localParts(w.at).date === d)
    assert.equal(writes('kitchen', '2026-10-09').length, 6)
    assert.equal(writes('office', '2026-10-09').length, 6)
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12']) assert.equal(writes('kitchen', d).length, 0, d)
    const on = g.truth.onMin.kitchen['2026-10-09']
    assert.ok(on.peak < 0.2, `OFF through both peaks (${on.peak})`)
    assert.ok(Math.abs(on.total - (1440 - 360)) < 1, `total ${on.total}`)
    assert.equal(g.truth.onMin.kitchen['2026-10-10'].total, 1440)
    const e = g.truth.events.kitchen['2026-10-09@07:00']
    assert.equal(e.status, 'done')
    assert.deepEqual([e.orig, e.app], [70, 73])
    assert.ok(e.driftFph < 0 && e.driftFph > -2, `heating drift ${e.driftFph}`)
    assert.ok(Math.abs(e.driftFph - e.driftOlsFph) < 0.05)
    const s = g.records.filter((r) => r.k === 's' && r.u === 'kitchen' && hhmm(r.t) === '12:00')
    assert.ok(s.every((r) => r.n === 15 && r.cv === 300 && r.on === 300))
    assert.equal(g.records.filter((r) => r.k === 'o').length, 4 * 96)
  })

  it('is deterministic for a seed and reacts to overrides, dry-run, was-off, offline and flat sensors', async () => {
    const off0 = tz.zonedToInstant('2026-10-15', '06:30')
    const off1 = tz.zonedToInstant('2026-10-15', '07:30')
    const opts = () => ({
      start: '2026-10-13', days: 4, seed: 9, recorder: 'reference',
      units: [
        { id: 'kitchen', overrides: [{ at: '08:30', field: 'power', to: 'ON', src: 'external', days: ['2026-10-13'] }, { at: '08:10', field: 'temp', to: 74, src: 'user', days: ['2026-10-14'] }] },
        { id: 'living-room', offline: [[off0, off1]], wasOff: ['2026-10-16'], dryRun: ['2026-10-14'] },
        { id: 'office', sensor: 'flat' },
      ],
    })
    const g = await genDays(opts())
    const g2 = await genDays(opts())
    assert.equal(toJsonl(g.records), toJsonl(g2.records), 'same seed ⇒ identical records')
    const a = (u, ty, d) => g.records.filter((r) => r.k === 'a' && r.u === u && r.ty === ty && (!d || tz.localParts(r.t * 1000).date === d))
    // external power ON during the shed: c external at first sighting, engine release, CAS temp return
    const ext = g.records.find((r) => r.k === 'c' && r.u === 'kitchen' && r.s === 'external' && r.f === 'power')
    assert.equal(hhmm(ext.t), '08:30')
    assert.equal(a('kitchen', 'released', '2026-10-13')[0].ac, 'external')
    assert.equal(g.truth.events.kitchen['2026-10-13@07:00'].status, 'released')
    assert.ok(g.records.some((r) => r.k === 'c' && r.u === 'kitchen' && r.f === 'temp' && r.o === 73 && r.v === 70 && hhmm(r.t) === '08:30'))
    // user temp during shed OFF ⇒ deferred, applied after power ON
    assert.equal(a('kitchen', 'deferred', '2026-10-14').length, 1)
    assert.ok(g.records.some((r) => r.k === 'c' && r.u === 'kitchen' && r.f === 'temp' && r.v === 74 && hhmm(r.t) === '10:00'))
    // dry-run: only would_write
    assert.equal(a('living-room', 'take', '2026-10-14').length, 0)
    assert.deepEqual(a('living-room', 'would_write', '2026-10-14').map((r) => r.f), ['temp', 'power', 'power'])
    // offline: offline/online lines, warming reads skipped, new b snapshot, shed joined late
    assert.equal(a('living-room', 'device_offline', '2026-10-15').length, 1)
    assert.equal(a('living-room', 'device_online', '2026-10-15').length, 1)
    assert.ok(g.records.some((r) => r.k === 'b' && r.u === 'living-room' && hhmm(r.t) === '07:30'))
    assert.ok(a('living-room', 'take', '2026-10-15').some((r) => r.f === 'power' && hhmm(r.t) === '07:30'))
    // was-off: take power OFF→OFF, no power write that morning
    const wo = a('living-room', 'take', '2026-10-16').find((r) => r.f === 'power' && hhmm(r.t) === '07:00')
    assert.deepEqual([wo.fr, wo.to], ['OFF', 'OFF'])
    assert.equal(g.truth.events['living-room']['2026-10-16@07:00'].status, 'was_off')
    // flat sensor: identical readings through the shed
    const flat = g.records.filter((r) => r.k === 's' && r.u === 'office' && tz.localParts(r.t * 1000).date === '2026-10-13' && hhmm(r.t) >= '07:10' && hhmm(r.t) < '10:00')
    assert.equal(new Set(flat.map((r) => r.r)).size, 1)
  })

  it('reference recorder: attribution rules of §3.2 (expected ⇒ schedule/user, external needs 2 reads ≥ 15 s, gap flag)', () => {
    const files = new Map()
    const rec = createReferenceRecorder({ tz, cfg: specDefaultConfig(), files, activeEventId: () => 'E' })
    const t0 = tz.zonedToInstant('2026-10-14', '12:00')
    const live = (o) => ({ ok: true, ready: true, power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW', room: 70, ...o })
    const obs = (dt, o, extra = {}) => rec.onObserved({ unitId: 'u', live: live(o), at: t0 + dt, warming: false, ...extra })
    rec.start(t0)
    obs(0, {})
    rec.onWrite({ unitId: 'u', field: 'temp', value: 72, actor: 'dashboard', eventId: null, at: t0 + 1000 })
    obs(3000, { temp: 72 })
    obs(20000, { temp: 75 }) // first sighting
    obs(30000, { temp: 75 }) // only 10 s later: not yet
    obs(40000, { temp: 75 }) // ≥ 15 s after first sighting ⇒ external
    obs(60000, { temp: 75 }, { warming: true }) // ignored
    obs(60000 + 400000, { temp: 76 }) // after a 400 s gap
    obs(60000 + 420000, { temp: 76 })
    const c = [...files.values()].flat().filter((r) => r.k === 'c')
    assert.deepEqual(c.map((r) => [r.o, r.v, r.s, r.t - t0 / 1000, r.gap]), [[70, 72, 'user', 3, null], [72, 75, 'external', 20, null], [75, 76, 'external', 460, 420]])
    assert.equal([...files.values()].flat().filter((r) => r.k === 'b').length, 1, 'first observe ⇒ b, never c')
  })
})
