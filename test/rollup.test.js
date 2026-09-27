// rollup.test.js — addendum §4.5/§4.6 (rollup.js): per-tier on/off/unknown time, room/band/setpoint
// stats, episode extraction (precondition, OFF-only drift fit after settle, comfort class, sensor flags,
// was_off/dry/released episodes, overrides with comfortDir + HomeKit `auto` pattern), outdoor back-fill,
// command counts, DST day lengths, the golden fixture and byte-identical rebuilds.
// Release 4.2 (Addendum F rule 10, A §4.6): a re-planned precondition reads its last phase_enter (replanned: true).
// Data comes from test/helpers/usage-gen.js (reference recorder: deterministic, no files) and from small
// hand-built record sets. Re-runs itself under TZ=UTC and TZ=Asia/Tokyo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeTz, addDays } from '../tz.js'
import { rollupDay, buildEpisodes, classify, driftFit, sensorFlags, ROLLUP_V } from '../rollup.js'
import { mirrorActivity } from '../records.js'
import { genDays, GOLDEN_DATE, GOLDEN_FILE } from './helpers/usage-gen.js'
import { specDefaultConfig } from './helpers/config.js'

const SELF = fileURLToPath(import.meta.url)
const CHILD = process.env.FK_TZ_CHILD === '1'

if (!CHILD) {
  for (const zone of ['UTC', 'Asia/Tokyo']) {
    test(`rollup suite passes with process TZ=${zone}`, () => {
      const env = { ...process.env, TZ: zone, FK_TZ_CHILD: '1' }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 180000 })
      assert.equal(r.status, 0, `child under TZ=${zone} failed:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /\bfail 0\b/)
    })
  }
}

const tz = makeTz('America/Los_Angeles')
const DAY = '2026-10-14' // Wednesday
const sec = (ms) => Math.floor(ms / 1000)
const at = (date, hhmm, plusSec = 0) => sec(tz.zonedToInstant(date, hhmm)) + plusSec

function cfgWith(unitIds = ['office'], patch = {}) {
  const cfg = specDefaultConfig()
  cfg.units = unitIds.map((id, i) => ({ id, name: id[0].toUpperCase() + id.slice(1), host: `${id}.test`, order: i, shed: true, precondition: true }))
  for (const id of unitIds) cfg.optimizer.units[id] = cfg.optimizer.units[id] ?? { enabled: true, comfortLowF: 68, comfortHighF: 78, sensorOffsetF: 0 }
  return Object.assign(cfg, patch)
}

async function gen(opts) {
  return genDays({ recorder: 'reference', ...opts })
}

async function roll(g, date, prevTail = null, extra = {}) {
  return rollupDay({ date, records: g.byDate[date] ?? [], cfg: g.cfg, tz, prevTail, builtAt: '2026-10-15T08:30:00.000Z', ...extra })
}

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ±${tol}, got ${actual}`)

// Hand-built records ------------------------------------------------------------------------------
function bucket(date, hhmm, fields = {}) {
  return { k: 's', t: at(date, hhmm), u: 'office', r: 70, n: 15, cv: 300, on: 300, p: 1, m: 'HEAT', sp: 70, f: 'LOW', ...fields }
}
function act(date, hhmm, plus, fields) {
  return { k: 'a', t: at(date, hhmm, plus), u: 'office', ac: 'scheduler', e: null, f: null, fr: null, to: null, res: null, ph: null, se: null, par: null, cl: null, why: null, ...fields }
}
/** Buckets from 'from' to 'to' (HH:MM, exclusive) produced by fn(i, t) → fields. */
function buckets(date, from, to, fn) {
  const out = []
  const a = at(date, from)
  const b = at(date, to)
  for (let t = a, i = 0; t < b; t += 300, i++) out.push({ k: 's', t, u: 'office', r: 70, n: 15, cv: 300, on: 300, p: 1, m: 'HEAT', sp: 70, f: 'LOW', ...fn(i, t) })
  return out
}

// ─────────────────────────────── full generated weekday ───────────────────────────────

test('generated heating weekday: on-time per tier within ±1 min of truth, room, setpoint, season', async () => {
  const g = await gen({ start: DAY, days: 1, seed: 3, units: [{ id: 'office', mode: 'HEAT', sp: 70 }] })
  const r = await roll(g, DAY)
  assert.equal(r.v, ROLLUP_V)
  assert.equal(r.complete, true)
  assert.equal(r.dayMinutes, 1440)
  assert.equal(r.dayType, 'weekday')
  const u = r.units.office
  const truth = g.truth.onMin.office[DAY]
  for (const k of ['peak', 'off_peak', 'super_off_peak', 'total']) near(u.onMin[k], truth[k], 1, `onMin.${k}`)
  // full coverage: on + off + unknown = the tier's minutes
  near(u.onMin.total + u.offMin.total + u.unknownMin.total, 1440, 0.5, 'minutes add up')
  near(u.coverage, 1, 0.01)
  const tr = g.truth.room.office[DAY]
  near(u.room.day.min, tr.min, 0.6, 'room min')
  near(u.room.day.max, tr.max, 0.6, 'room max')
  near(u.room.day.mean, tr.mean, 0.2, 'room mean')
  assert.equal(u.room.day.n, 288)
  assert.equal(u.room.peak.n + u.room.off_peak.n + u.room.super_off_peak.n, 288)
  assert.equal(u.season, 'heating')
  assert.deepEqual(Object.keys(u.modeMin), ['HEAT'])
  assert.equal(u.setpoint.min, 70)
  assert.equal(u.setpoint.max, 73)
  assert.ok(u.setpoint.mean > 70 && u.setpoint.mean < 71, `time-weighted setpoint ${u.setpoint.mean}`)
  assert.equal(u.jobs.writes, 6)
  assert.equal(u.jobs.verified, 6)
  assert.equal(u.changes.schedule, 6)
  assert.equal(u.spark.room.length, 96)
  assert.equal(u.spark.on.length, 96)
  assert.equal(u.spark.t0, r.start)
  assert.deepEqual(u.cfgSnapshot, { band: [68, 78], touRev: 1, system: { master: null, forcing: null, conflict: null } }, 'no constraint injected')
  assert.equal(r.tail.office.power, 'ON')
  assert.equal(r.tail.office.mode, 'HEAT')
})

test('episode extraction: par from phase_enter, offAt from the verified OFF write, eff/t90/reached, drift after settle', async () => {
  const g = await gen({ start: DAY, days: 1, seed: 3, units: [{ id: 'office', mode: 'HEAT', sp: 70 }] })
  const r = await roll(g, DAY)
  const [am, pm] = r.units.office.episodes
  const te = g.truth.events.office[am.ev]
  assert.equal(am.ev, `${DAY}@07:00`)
  assert.equal(am.status, 'done')
  assert.equal(am.season, 'heating')
  assert.equal(am.precondition, true)
  assert.deepEqual(am.par, { deltaF: 3, leadMin: 120 })
  assert.equal(am.preStart, at(DAY, '05:00'))
  assert.equal(am.peakStart, at(DAY, '07:00'))
  assert.equal(am.shed.offAt, sec(te.offAt), 'offAt = t of the verified scheduler ON→OFF write')
  assert.equal(am.shed.end, at(DAY, '10:00'))
  assert.equal(am.rec.onAt, sec(te.onAt))
  assert.equal(am.pre.orig, 70)
  assert.equal(am.pre.app, 73)
  assert.equal(am.pre.dApp, 3)
  assert.equal(am.pre.capped, false)
  assert.equal(am.pre.leadUsed, 120)
  near(am.pre.T0, te.T0, 0.3, 'T0')
  near(am.pre.Tpk, te.Tpk, 0.3, 'Tpk')
  near(am.pre.eff, te.eff, 0.1, 'eff')
  assert.equal(am.pre.reached, te.reached)
  assert.ok(am.pre.t90 > 0 && am.pre.t90 <= 120, `t90 ${am.pre.t90}`)
  assert.ok(am.pre.reachedMinBeforePeak > 0 && am.pre.reachedMinBeforePeak <= 120)
  // drift: OFF buckets only, starting ≥ 10 min after offAt, slope within ±0.05 °F/h of the analytic mid-shed slope
  assert.ok(am.shed.drift.ok)
  near(am.shed.drift.b, te.driftFph, 0.05, 'drift b')
  assert.equal(am.shed.driftFph, am.shed.drift.b)
  const firstDriftBucket = at(DAY, '07:15') // 07:10:00 < offAt + 600 (07:10:02) ⇒ first point is 07:15
  const expectedN = (at(DAY, '10:00') - firstDriftBucket) / 300
  assert.equal(am.shed.drift.n, expectedN)
  assert.equal(am.shed.drift.dropped, 0)
  near(am.shed.Tout, te.Tout, 0.5, 'Tout')
  near(am.shed.gap, am.shed.rBar - am.shed.Tout, 0.11, 'gap = r̄ − Tout')
  near(am.shed.x, am.shed.Tout - am.shed.rBar, 0.11, 'x = s·(Tout − r̄)')
  assert.equal(am.shed.flat, false)
  assert.equal(am.shed.jump, false)
  assert.equal(am.q, 'ok')
  // evening peak: shed only (no precondition ⇒ par/pre null) but still a full episode
  assert.equal(pm.ev, `${DAY}@17:00`)
  assert.equal(pm.precondition, false)
  assert.equal(pm.par, null)
  assert.equal(pm.pre, null)
  assert.equal(pm.status, 'done')
  assert.ok(pm.shed.drift.ok)
  near(pm.shed.drift.b, g.truth.events.office[pm.ev].driftFph, 0.05, 'evening drift')
})

test('unknownMin counts read gaps > 60 s; the shed episode keeps its partial coverage', async () => {
  const off0 = tz.zonedToInstant(DAY, '08:00')
  const off1 = tz.zonedToInstant(DAY, '09:00')
  const g = await gen({ start: DAY, days: 1, seed: 4, units: [{ id: 'office', offline: [[off0, off1]] }] })
  const u = (await roll(g, DAY)).units.office
  near(u.unknownMin.peak, 60, 2, 'one hour offline inside the peak')
  near(u.onMin.peak + u.offMin.peak + u.unknownMin.peak, 360, 0.5, 'both weekday peaks')
  near(u.onMin.total, g.truth.onMin.office[DAY].total, 1)
  const am = u.episodes[0]
  assert.ok(am.shed.cov < 0.7 && am.shed.cov >= 0.6, `cov ${am.shed.cov}`)
  assert.ok(am.shed.drift.n < 34)
  assert.equal(u.boots, 2, 'the first read after the outage writes a b snapshot')
})

test('dayMinutes and on+off+unknown on both DST days (1380 / 1500)', async () => {
  for (const [date, minutes] of [['2026-03-08', 1380], ['2026-11-01', 1500]]) {
    const g = await gen({ start: date, days: 1, seed: 9, units: [{ id: 'office' }] })
    const r = await roll(g, date)
    assert.equal(r.dayMinutes, minutes)
    const u = r.units.office
    near(u.onMin.total + u.offMin.total + u.unknownMin.total, minutes, 0.5, `${date} minutes`)
    near(u.coverage, 1, 0.01)
    assert.equal(u.spark.room.length, minutes / 15)
    assert.equal(r.dayType, 'weekend')
    assert.deepEqual(r.events, [])
    assert.deepEqual(u.episodes, [])
    near(u.onMin.total, g.truth.onMin.office[date].total, 1)
  }
})

// ─────────────────────────────── episode kinds ───────────────────────────────

test('was_off, dry-run and released episodes', async () => {
  const g = await gen({
    start: DAY, days: 3, seed: 7,
    units: [{ id: 'office', wasOff: [DAY], dryRun: ['2026-10-15'], overrides: [{ at: '08:30', field: 'power', to: 'ON', src: 'external', days: ['2026-10-16'] }] }],
  })
  // was_off: offAt = peakStart, pre = null, drift still fitted (feeds the model), not a parameter episode
  const [wo] = (await roll(g, DAY)).units.office.episodes
  assert.equal(wo.status, 'was_off')
  assert.equal(wo.shed.offAt, wo.peakStart)
  assert.equal(wo.pre, null)
  assert.ok(wo.shed.drift.ok)
  assert.equal(wo.rec, null, 'the unit stays off after a was_off shed')
  // dry-run: only would_write lines ⇒ status dry, q dry, nothing owned
  const dry = (await roll(g, '2026-10-15')).units.office.episodes
  for (const e of dry) {
    assert.equal(e.status, 'dry')
    assert.equal(e.dryRun, true)
    assert.equal(e.q, 'dry')
    assert.equal(e.shed, null)
    assert.equal(e.par, null)
  }
  // released by an external power ON at 08:30: the ON tail is excluded from every shed metric
  const [rel] = (await roll(g, '2026-10-16')).units.office.episodes
  const te = g.truth.events.office[rel.ev]
  assert.equal(rel.status, 'released')
  assert.equal(rel.shed.end, sec(te.shedEnd))
  assert.ok(rel.shed.end < rel.peakEnd)
  assert.equal(rel.rec.onAt, rel.released.t, 'onAt = t(released) when the release was a power ON')
  assert.deepEqual({ by: rel.released.by, f: rel.released.f, v: rel.released.v }, { by: 'external', f: 'power', v: 'ON' })
  assert.equal(rel.overrides.length, 1, 'c record and released line deduped')
  assert.equal(rel.overrides[0].f, 'power')
  assert.equal(rel.overrides[0].comfortDir, true, 'heating: power ON after offAt is a comfort override')
  assert.equal(rel.overrides[0].auto, false)
  assert.ok(rel.pre, 'the precondition before the release is still measured')
})

test('dry run as the engine logs it (phase_enter + would_write, no take) is a dry episode, never a done one', async () => {
  const D = DAY
  const am = `${D}@07:00`
  const pm = `${D}@17:00`
  const params = { season: 'heating', deltaF: 3, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, source: 'config' }
  // activity exactly as decide() logs it in automation.mode 'dry-run', mirrored by the real usage log
  const entry = (hhmm, fields) => ({ ts: new Date(at(D, hhmm) * 1000).toISOString(), unit: 'office', actor: 'scheduler', ...fields })
  const markers = [
    entry('05:00', { event: am, type: 'phase_enter', phase: 'precondition', season: 'heating', params, dryRun: true }),
    entry('05:00', { event: am, type: 'would_write', field: 'temp', from: 70, to: 73, kind: 'take' }),
    entry('07:00', { event: am, type: 'phase_enter', phase: 'shed', from: 'precondition', season: 'heating', params, dryRun: true }),
    entry('07:00', { event: am, type: 'would_write', field: 'power', from: 'ON', to: 'OFF', kind: 'take' }),
    entry('10:00', { event: am, type: 'phase_exit', phase: 'shed', reason: 'ended' }),
    entry('10:00', { event: am, type: 'would_write', field: 'power', from: 'OFF', to: 'ON', kind: 'return' }),
    // evening: the unit already reads OFF, so nothing would move — only phase_enter says the shed was simulated
    entry('17:00', { event: pm, type: 'phase_enter', phase: 'shed', season: 'heating', params, dryRun: true }),
    entry('20:00', { event: pm, type: 'phase_exit', phase: 'shed', reason: 'ended' }),
  ].map((a) => mirrorActivity(a, 0))
  const ext = { k: 'c', t: at(D, '07:30'), u: 'office', f: 'temp', o: 70, v: 74, s: 'external', e: am, gap: null }
  const recs = [...buckets(D, '04:00', '17:00', () => ({})), ...buckets(D, '17:00', '21:00', () => ({ on: 0, p: 0 })), ext, ...markers]
  const [a, p] = (await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })).units.office.episodes
  for (const ep of [a, p]) {
    assert.deepEqual({ status: ep.status, dryRun: ep.dryRun, q: ep.q, par: ep.par, pre: ep.pre, shed: ep.shed }, { status: 'dry', dryRun: true, q: 'dry', par: null, pre: null, shed: null }, ep.ev)
  }
  assert.equal(a.season, 'heating')
  assert.equal(a.overrides.length, 1, 'overrides are still listed for the report')
  // usage lines written before phase_enter carried the flag: would_write with no take and no scheduler write ⇒ dry
  const legacy = recs.map((r) => (r.k === 'a' ? (({ dry, ...rest }) => rest)(r) : r))
  const [la] = (await rollupDay({ date: D, records: legacy, cfg: cfgWith(), tz })).units.office.episodes
  assert.deepEqual({ status: la.status, dryRun: la.dryRun, q: la.q }, { status: 'dry', dryRun: true, q: 'dry' })
})

test('a release as the engine logs it: a power ON gives onAt, recovery and jump; the c record, released and drop lines are one override', async () => {
  const D = DAY
  const am = `${D}@07:00`
  const pm = `${D}@17:00`
  const params = { season: 'heating', deltaF: 3, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, source: 'config' }
  const entry = (ev, hhmm, plus, fields) => ({ ts: new Date(at(D, hhmm, plus) * 1000).toISOString(), unit: 'office', event: ev, actor: 'scheduler', ...fields })
  const pre = (ev, hhmm) => [
    entry(ev, hhmm, 0, { type: 'phase_enter', phase: 'precondition', season: 'heating', params }),
    entry(ev, hhmm, 0, { type: 'take', field: 'temp', original: 70, applied: 73 }),
    entry(ev, hhmm, 3, { type: 'write', field: 'temp', from: 70, to: 73, kind: 'take', result: 'verified' }),
  ]
  const shedAm = [
    ...pre(am, '05:00'),
    entry(am, '07:00', 0, { type: 'phase_enter', phase: 'shed', from: 'precondition', season: 'heating', params }),
    entry(am, '07:00', 0, { type: 'take', field: 'power', original: 'ON', applied: 'OFF' }),
    entry(am, '07:00', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }),
  ]
  // decide's release(): `released`, the drop of the owned power and `phase_exit`, all at one instant
  const powerOn = (plus, actor, released) => [
    entry(am, '08:30', plus, { actor, type: 'released', reason: `${actor}-power`, ...released }),
    entry(am, '08:30', plus, { actor, type: 'drop', field: 'power', live: 'ON' }),
    entry(am, '08:30', plus, { actor, type: 'phase_exit', phase: 'shed', reason: `${actor}-power` }),
  ]
  // evening: an Apple Home mode change during the pre-heat releases with no field (decide logs mode releases field-less)
  const modeRel = [
    ...pre(pm, '15:00'),
    entry(pm, '16:00', 30, { actor: 'external', type: 'released', reason: 'external-mode' }),
    entry(pm, '16:00', 30, { actor: 'external', type: 'phase_exit', phase: 'precondition', reason: 'external-mode' }),
  ]
  const modeC = { k: 'c', t: at(D, '16:00'), u: 'office', f: 'mode', o: 'HEAT', v: 'FAN', s: 'external', e: pm, gap: null }
  const records = (lines, onC) => [
    ...buckets(D, '04:00', '07:00', () => ({ sp: 73 })),
    ...buckets(D, '07:00', '08:30', (i) => ({ on: 0, p: 0, sp: 73, r: 72 - i * 0.2 })), // ≈ 68.7 in the last 10 OFF minutes
    ...buckets(D, '08:30', '21:00', () => ({ r: 72, sp: 70 })), // warm air at the sensor right after power ON ⇒ jump
    onC, modeC, ...[...shedAm, ...lines, ...modeRel].map((a) => mirrorActivity(a, 0)),
  ]
  const cases = [
    // as decide logs it: the release carries the person's power (external: confirmed ~30 s after the first sighting)
    ['external, power on the release line', powerOn(30, 'external', { field: 'power', to: 'ON' }), 30, 'external', -30],
    // lines logged before the release carried it: the c record (first sighting 30 s earlier) and the power drop tell
    ['external, field-less release (older lines)', powerOn(30, 'external', {}), 30, 'external', -30],
    // dashboard: the c record of the verified manual ON follows the release
    ['dashboard, field-less release (older lines)', powerOn(0, 'dashboard', {}), 0, 'user', 5],
  ]
  for (const [name, lines, plus, s, cAt] of cases) {
    const onC = { k: 'c', t: at(D, '08:30', plus + cAt), u: 'office', f: 'power', o: 'OFF', v: 'ON', s, e: am, gap: null }
    const [a, p] = (await rollupDay({ date: D, records: records(lines, onC), cfg: cfgWith(), tz })).units.office.episodes
    const t = at(D, '08:30', plus)
    assert.equal(a.status, 'released', name)
    assert.deepEqual(a.released, { t, by: s, f: 'power', v: 'ON' }, name)
    assert.equal(a.shed.end, t, `${name}: the ON tail is excluded from the shed`)
    assert.equal(a.rec?.onAt, t, `${name}: onAt = t(released) when the release was a power ON`)
    assert.ok(a.rec.minToSp != null, `${name}: recovery measured`)
    assert.equal(a.rec.jump, true, `${name}: jump compares the first minutes after power ON with the last OFF minutes`)
    assert.equal(a.shed.jump, true, name)
    assert.deepEqual(a.overrides.map((o) => [o.f, o.v, o.s, o.comfortDir]), [['power', 'ON', s, true]], `${name}: one override`)
    // field-less mode release: paired with the c record of the mode change, not listed twice
    assert.equal(p.status, 'released', name)
    assert.deepEqual(p.released, { t: at(D, '16:00', 30), by: 'external', f: null, v: null }, name)
    assert.equal(p.rec, null, `${name}: a mode release is no power ON`)
    assert.deepEqual(p.overrides.map((o) => [o.f, o.v, o.ty]), [['mode', 'FAN', 'change']], `${name}: one override`)
  }
})

// ─────────────────────────────── fan-only dry-out (addendum B F2) ───────────────────────────────

// decide + engine lines of a heating unit's morning with the pre-heat (fan High) and a 15-min fan-only dry-out, as
// they are logged (addendum B §3.3) and mirrored by the real usage log. `shed` replaces the lines from 07:00 on.
function fanOnlyMorning(D, shed) {
  const am = `${D}@07:00`
  const params = { season: 'heating', deltaF: 3, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, source: 'config' }
  const entry = (hhmm, plus, fields) => ({ ts: new Date(at(D, hhmm, plus) * 1000).toISOString(), unit: 'office', event: am, actor: 'scheduler', ...fields })
  const until = new Date(at(D, '07:15') * 1000).toISOString()
  const lines = [
    entry('05:00', 0, { type: 'phase_enter', phase: 'precondition', season: 'heating', params }),
    entry('05:00', 0, { type: 'take', field: 'temp', original: 70, applied: 73, phase: 'precondition', season: 'heating' }),
    entry('05:00', 0, { type: 'take', field: 'fan', original: 'LOW', applied: 'HIGH', phase: 'precondition', season: 'heating' }),
    entry('05:00', 3, { type: 'write', field: 'temp', from: 70, to: 73, kind: 'take', result: 'verified' }),
    entry('05:00', 6, { type: 'write', field: 'fan', from: 'LOW', to: 'HIGH', kind: 'take', result: 'verified' }),
    entry('07:00', 0, { type: 'phase_enter', phase: 'shed', from: 'precondition', season: 'heating', params, dryOutUntil: until }),
    entry('07:00', 0, { type: 'take', field: 'power', original: 'ON', applied: 'ON', phase: 'shed', until }),
    entry('07:00', 0, { type: 'take', field: 'mode', original: 'HEAT', applied: 'FAN', phase: 'shed', until }),
    ...shed(entry),
  ]
  return lines.map((a) => mirrorActivity(a, 0))
}

test('fan-only dry-out (addendum B F2.14): fanOnly from the verified FAN write to the OFF, fanMin not onMin, drift window unchanged, violations counted', async () => {
  const D = DAY
  const markers = fanOnlyMorning(D, (entry) => [
    entry('07:00', 3, { type: 'write', field: 'mode', from: 'HEAT', to: 'FAN', kind: 'take', result: 'verified' }),
    entry('07:15', 0, { type: 'take', field: 'power', original: 'ON', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out over' }),
    entry('07:15', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }),
    entry('10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }),
    entry('10:00', 2, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'return', result: 'verified' }),
    entry('10:00', 5, { type: 'write', field: 'mode', from: 'FAN', to: 'HEAT', kind: 'return', result: 'verified' }),
    entry('10:00', 8, { type: 'write', field: 'temp', from: 73, to: 70, kind: 'return', result: 'verified' }),
    entry('10:00', 11, { type: 'write', field: 'fan', from: 'HIGH', to: 'LOW', kind: 'return', result: 'verified' }),
  ])
  const recs = [
    ...buckets(D, '04:00', '07:00', () => ({ sp: 73, f: 'HIGH' })),
    // fan-only: power ON in mode FAN; the room dips below the 68° floor for the two buckets inside the window
    ...buckets(D, '07:00', '07:15', (i) => ({ m: 'FAN', sp: 73, f: 'HIGH', r: i ? 67 : 70 })),
    ...buckets(D, '07:15', '10:00', (i) => ({ on: 0, p: 0, m: 'FAN', sp: 73, f: 'HIGH', r: 71 - i * 0.02 })),
    ...buckets(D, '10:00', '11:00', () => ({})),
    ...markers,
  ]
  const u = (await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })).units.office
  const [am] = u.episodes
  assert.equal(am.status, 'done', 'the first take power line is ON → ON: not was_off (the later dry-out-over line does not flip it)')
  assert.deepEqual(am.fanOnly, { from: at(D, '07:00', 3), until: at(D, '07:15', 3), min: 15 })
  assert.equal(am.shed.offAt, at(D, '07:15', 3), 'offAt stays the verified scheduler OFF')
  // C-8: fan-only buckets (p = 1 ∧ m = FAN) count into fanMin, not onMin; offMin unchanged
  assert.deepEqual(u.onMin, { peak: 0, off_peak: 60, super_off_peak: 180, total: 240 })
  assert.deepEqual(u.fanMin, { peak: 15, off_peak: 0, super_off_peak: 0, total: 15 })
  assert.equal(u.offMin.peak, 165)
  assert.deepEqual(u.modeMin, { FAN: 15, HEAT: 240 })
  // drift: OFF buckets from offAt + 10 min (07:30 … 09:55) — the fan-only minutes never enter it
  assert.equal(am.shed.drift.n, 30)
  assert.equal(am.shed.cov, 0.97)
  // violations over fan-only ∪ OFF; the class, margin and coverage stay on the OFF window (§0.5)
  assert.equal(am.shed.violMin, 10)
  assert.deepEqual([am.shed.class, am.shed.Tmin], ['comfortable', 70.4])
  // the same morning without a dry-out has no fanOnly and the same shed physics
  const plain = recs.filter((r) => !(r.k === 'a' && r.ty === 'write' && r.f === 'mode'))
  const [p] = (await rollupDay({ date: D, records: plain, cfg: cfgWith(), tz })).units.office.episodes
  assert.equal(p.fanOnly, null)
  assert.deepEqual(p.shed.drift, am.shed.drift)
  assert.equal(p.shed.violMin, 0)
})

test('fan-only dry-out ended early, not taken, or run to the peak end (addendum B F2.8/F2.9/F2.10)', async () => {
  const D = DAY
  const fanW = (plus, result = 'verified') => (entry) => entry('07:00', plus, { type: 'write', field: 'mode', from: 'HEAT', to: 'FAN', kind: 'take', result })
  const roll = async (shed, extra = []) => {
    const recs = [
      ...buckets(D, '04:00', '07:00', () => ({ sp: 73 })),
      ...buckets(D, '07:00', '07:10', () => ({ m: 'FAN', sp: 73 })),
      ...buckets(D, '07:10', '11:00', () => ({ on: 0, p: 0, m: 'FAN', sp: 73 })),
      ...fanOnlyMorning(D, shed), ...extra,
    ]
    return (await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })).units.office.episodes[0]
  }
  // F2.10: the person's Off at 07:08 — their own dashboard write turns the unit off: fanOnly ends at the take line,
  // offAt stays null (no app OFF), so the episode has no shed window
  const person = await roll((entry) => [
    fanW(3)(entry),
    entry('07:08', 3, { type: 'take', field: 'power', original: 'ON', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out ended by you', restoreAt: new Date(at(D, '10:00') * 1000).toISOString() }),
    { ...entry('07:08', 5, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'manual', result: 'verified' }), actor: 'dashboard' },
    entry('10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }),
  ])
  assert.deepEqual(person.fanOnly, { from: at(D, '07:00', 3), until: at(D, '07:08', 3), min: 8 })
  assert.deepEqual([person.status, person.shed], ['done', null])
  // …when their write never lands the shed's own take sends the OFF: the app's offAt, fanOnly still ends at their line
  const fallback = await roll((entry) => [
    fanW(3)(entry),
    entry('07:08', 3, { type: 'take', field: 'power', original: 'ON', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out ended by you' }),
    entry('07:09', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }),
  ])
  assert.deepEqual([fallback.fanOnly.until, fallback.shed.offAt], [at(D, '07:08', 3), at(D, '07:09', 3)])
  // F2.8: the FAN write was not taken ⇒ no fan-only at all; the OFF follows as the app's
  const notTaken = await roll((entry) => [
    fanW(3, 'not_applied')(entry),
    entry('07:00', 20, { type: 'drop', actor: 'system', field: 'mode', live: 'HEAT', reason: 'not_taken' }),
    entry('07:00', 20, { type: 'take', field: 'power', original: 'ON', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out over' }),
    entry('07:00', 23, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }),
  ])
  assert.deepEqual([notTaken.fanOnly, notTaken.shed.offAt, notTaken.overrides], [null, at(D, '07:00', 23), []])
  // F2.9: dryOutUntil = peakEnd — fan-only to the restore, never OFF (no shed window either)
  const whole = await roll((entry) => [
    fanW(6)(entry),
    entry('10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }),
    entry('10:00', 3, { type: 'write', field: 'mode', from: 'FAN', to: 'HEAT', kind: 'return', result: 'verified' }),
  ])
  assert.deepEqual([whole.fanOnly, whole.shed], [{ from: at(D, '07:00', 6), until: at(D, '10:00'), min: 179.9 }, null])
  // dry run: would_write only ⇒ no fanOnly
  const dry = await roll((entry) => [entry('07:00', 0, { type: 'would_write', field: 'mode', from: 'HEAT', to: 'FAN', kind: 'take' })])
  assert.equal(dry.fanOnly, null)
})

test('a mode-change release during fan-only (N-15): the system power un-own at the same instant leaves the release field-less — no power release, no power override', async () => {
  const D = DAY
  const pm = `${D}@17:00`
  const params = { season: 'heating', deltaF: 3, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, source: 'config' }
  const entry = (hhmm, plus, fields) => ({ ts: new Date(at(D, hhmm, plus) * 1000).toISOString(), unit: 'office', event: pm, actor: 'scheduler', ...fields })
  const until = new Date(at(D, '17:15') * 1000).toISOString()
  const lines = [
    entry('17:00', 0, { type: 'phase_enter', phase: 'shed', season: 'heating', params, dryOutUntil: until }),
    entry('17:00', 0, { type: 'take', field: 'power', original: 'ON', applied: 'ON', phase: 'shed', until }),
    entry('17:00', 0, { type: 'take', field: 'mode', original: 'HEAT', applied: 'FAN', phase: 'shed', until }),
    entry('17:00', 3, { type: 'write', field: 'mode', from: 'HEAT', to: 'FAN', kind: 'take', result: 'verified' }),
    // Heat pressed on the remote at 17:05, confirmed 30 s later: decide un-owns the power in place (actor system),
    // releases with the mode as theirs (field-less line) and drops the mode (actor external)
    entry('17:05', 30, { type: 'drop', actor: 'system', field: 'power', live: 'ON', reason: 'mode-change' }),
    entry('17:05', 30, { type: 'released', actor: 'external', reason: 'external-mode' }),
    entry('17:05', 30, { type: 'drop', actor: 'external', field: 'mode', live: 'HEAT' }),
    entry('17:05', 30, { type: 'phase_exit', phase: 'shed', actor: 'external', reason: 'external-mode' }),
  ].map((a) => mirrorActivity(a, 0))
  const modeC = { k: 'c', t: at(D, '17:05'), u: 'office', f: 'mode', o: 'FAN', v: 'HEAT', s: 'external', e: pm, gap: null }
  const recs = [...buckets(D, '16:00', '17:00', () => ({})), ...buckets(D, '17:00', '17:05', () => ({ m: 'FAN' })), ...buckets(D, '17:05', '21:00', () => ({})), modeC, ...lines]
  const [, ep] = (await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })).units.office.episodes
  assert.equal(ep.status, 'released')
  assert.deepEqual(ep.released, { t: at(D, '17:05', 30), by: 'external', f: null, v: null }, 'a mode release, not a power release')
  assert.equal(ep.rec, null, 'no power ON: onAt untouched')
  assert.deepEqual(ep.overrides.map((o) => [o.f, o.v, o.s, o.ty]), [['mode', 'HEAT', 'external', 'change']], 'one mode item, no power item')
  assert.deepEqual(ep.fanOnly, { from: at(D, '17:00', 3), until: at(D, '17:05', 30), min: 5.5 }, 'fan-only until the release ends the shed')
  // a dashboard/external power drop at the release instant is still read as a power release (older lines)
  const legacy = recs.map((r) => (r.k === 'a' && r.ty === 'drop' && r.f === 'power' ? { ...r, ac: 'external' } : r))
  const [, lp] = (await rollupDay({ date: D, records: legacy, cfg: cfgWith(), tz })).units.office.episodes
  assert.equal(lp.released.f, 'power')
})

// ─────────────────────────────── Release 4 (addenda B F3, C §3.4 / C6) ───────────────────────────────

const PARAMS_H = { season: 'heating', deltaF: 3, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, source: 'config' }
const PARAMS_C = { ...PARAMS_H, season: 'cooling' }
/** Activity lines of one unit (as decide logs them), mirrored by the real usage log. */
function lines(D, unit, event, list) {
  return list.map(([hhmm, plus, fields]) => mirrorActivity({
    ts: new Date(at(D, hhmm, plus) * 1000).toISOString(), unit, event, actor: 'scheduler', ...fields,
  }, 0))
}
const SYSTEM = { master: 'living-room', masterWaitSec: 120, probe: null }
// The multi-split constraint is injected into rollupDay (the core reads no cfg.system): what the reference app's
// system.constraint(cfg) derives from SYSTEM without a probe.
const CONSTRAINT = { on: true, master: 'living-room', forcing: 'master', conflict: 'rewritten' }

test('precondition from an OFF entry (addendum B F3.21): preFromOff, pre.orig from base, T0 = orig, T0room measured; released + a later entry ON ⇒ rec null', async () => {
  const D = DAY
  const am = `${D}@07:00`
  const iso = (hhmm) => new Date(at(D, hhmm) * 1000).toISOString()
  const entry = { key: `s:${D}@07:00`, fields: { power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' } }
  const pre = [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', season: 'heating', params: PARAMS_H, entry }],
    ['05:00', 0, { type: 'take', field: 'power', original: 'OFF', applied: 'ON', phase: 'precondition', entry: entry.key }],
    ['05:00', 0, { type: 'take', field: 'mode', original: 'COOL', applied: 'HEAT', phase: 'precondition', entry: entry.key }],
    ['05:00', 0, { type: 'take', field: 'temp', original: 68, applied: 73, base: 70, phase: 'precondition', entry: entry.key }],
    ['05:00', 23, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'take', result: 'verified' }],
    ['05:00', 40, { type: 'write', field: 'mode', from: 'COOL', to: 'HEAT', kind: 'take', result: 'verified' }],
    ['05:00', 43, { type: 'write', field: 'temp', from: 68, to: 73, kind: 'take', result: 'verified' }],
  ]
  const shed = [
    ['07:00', 0, { type: 'phase_enter', phase: 'shed', from: 'precondition', season: 'heating', params: PARAMS_H, dryOutUntil: iso('07:15') }],
    ['07:00', 0, { type: 'take', field: 'mode', original: 'COOL', from: 'HEAT', applied: 'FAN', phase: 'shed', reason: 'retarget' }],
    ['07:00', 3, { type: 'write', field: 'mode', from: 'HEAT', to: 'FAN', kind: 'take', result: 'verified' }],
    ['07:15', 0, { type: 'take', field: 'power', original: 'OFF', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out over' }],
    ['07:15', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }],
    ['10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }],
    ['10:00', 20, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'return', result: 'verified' }],
  ]
  const room = (i) => Math.round((62 + i * 0.4) * 10) / 10
  const recs = [
    ...buckets(D, '04:00', '05:00', () => ({ on: 0, p: 0, m: 'COOL', sp: 68, r: 62 })),
    ...buckets(D, '05:00', '07:00', (i) => ({ sp: 73, f: 'HIGH', r: room(i) })),
    ...buckets(D, '07:00', '07:15', () => ({ m: 'FAN', sp: 73, r: 71 })),
    ...buckets(D, '07:15', '10:00', (i) => ({ on: 0, p: 0, m: 'FAN', sp: 73, r: 71 - i * 0.02 })),
    ...buckets(D, '10:00', '11:00', () => ({ r: 70 })),
  ]
  const [ep] = (await rollupDay({ date: D, records: [...recs, ...lines(D, 'office', am, [...pre, ...shed])], cfg: cfgWith(), tz })).units.office.episodes
  assert.equal(ep.status, 'done')
  assert.equal(ep.preFromOff, true, 'the first take power line is OFF → ON')
  assert.equal(ep.season, 'heating')
  const Tpk = room(22)
  assert.deepEqual(
    { orig: ep.pre.orig, app: ep.pre.app, dApp: ep.pre.dApp, capped: ep.pre.capped, T0: ep.pre.T0, T0room: ep.pre.T0room, Tpk: ep.pre.Tpk },
    { orig: 70, app: 73, dApp: 3, capped: false, T0: 70, T0room: 62, Tpk },
    'orig = the scheduled setpoint the bump was computed from (take base), T0 = orig for the realisation, T0room = the measured room',
  )
  near(ep.pre.rise, Tpk - 70, 0.01, 'rise from orig')
  near(ep.pre.eff, (Tpk - 70) / 3, 0.01, 'eff over the bump above the scheduled setpoint')
  assert.equal(ep.shed.offAt, at(D, '07:15', 3))
  assert.deepEqual(ep.fanOnly, { from: at(D, '07:00', 3), until: at(D, '07:15', 3), min: 15 })

  // was_off only when the FIRST take power line is OFF → OFF (a shed taking an OFF unit)
  const wasOff = lines(D, 'office', am, [
    ['07:00', 0, { type: 'phase_enter', phase: 'shed', season: 'heating', params: PARAMS_H }],
    ['07:00', 0, { type: 'take', field: 'power', original: 'OFF', applied: 'OFF', phase: 'shed' }],
  ])
  const [wo] = (await rollupDay({ date: D, records: [...buckets(D, '06:00', '11:00', () => ({ on: 0, p: 0 })), ...wasOff], cfg: cfgWith(), tz })).units.office.episodes
  assert.deepEqual([wo.status, wo.preFromOff, wo.pre], ['was_off', false, null])

  // released by the person's Off at 05:30, the entry fires at 10:00 as an event-less schedule write: no recovery
  const rel = lines(D, 'office', am, [
    ...pre,
    ['05:30', 0, { type: 'released', actor: 'dashboard', field: 'power', from: 'ON', to: 'OFF', reason: 'dashboard-power' }],
    ['05:30', 0, { type: 'drop', actor: 'dashboard', field: 'power', live: 'OFF' }],
  ])
  const fire = lines(D, 'office', null, [['10:00', 20, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'schedule', intentKey: entry.key, result: 'verified' }]])
  const offAfter = [...buckets(D, '04:00', '05:00', () => ({ on: 0, p: 0 })), ...buckets(D, '05:00', '05:30', () => ({})), ...buckets(D, '05:30', '10:00', () => ({ on: 0, p: 0 })), ...buckets(D, '10:00', '11:00', () => ({}))]
  const [r] = (await rollupDay({ date: D, records: [...offAfter, ...rel, ...fire], cfg: cfgWith(), tz })).units.office.episodes
  assert.deepEqual([r.status, r.preFromOff, r.released.f, r.rec], ['released', true, 'power', null])

  // season: phase_enter(precondition).se first; else the take sign against base ?? fr (C-4: base 74, fr 70, to 71 ⇒ cooling)
  const sea = (withSe) => lines(D, 'office', am, [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', ...(withSe ? { season: 'cooling', params: PARAMS_C } : { params: { deltaF: 3, leadMin: 120 } }) }],
    ['05:00', 0, { type: 'take', field: 'temp', original: 70, applied: 71, base: 74, phase: 'precondition' }],
  ])
  for (const withSe of [true, false]) {
    const [s] = (await rollupDay({ date: D, records: [...buckets(D, '04:00', '10:00', () => ({ m: 'COOL' })), ...sea(withSe)], cfg: cfgWith(), tz })).units.office.episodes
    assert.deepEqual([s.season, s.pre.orig, s.pre.app, s.pre.dApp], ['cooling', 74, 71, 3], `withSe ${withSe}`)
  }
})

test('already conditioned (C F3.11′ / C6.5): preSkipped from the silent line, conditioned {keeps, target}, pre null, never was_off', async () => {
  const D = DAY
  const am = `${D}@07:00`
  const entry = { key: `s:${D}@07:00`, fields: { power: 'ON', mode: 'COOL', temp: 74 } }
  const recs = [
    ...buckets(D, '04:00', '07:00', () => ({ m: 'COOL', sp: 68, r: 69 })),
    ...buckets(D, '07:00', '10:00', () => ({ on: 0, p: 0, m: 'COOL', sp: 68, r: 70 })),
    ...lines(D, 'office', am, [
      ['05:00', 0, { type: 'phase_enter', phase: 'precondition', season: 'cooling', params: PARAMS_C, entry, skip: 'already conditioned', keeps: 68, target: 71 }],
      ['05:00', 0, { type: 'notice', actor: 'system', code: 'precondition_skipped', reason: 'already conditioned', live: 68, target: 71, message: 'Precondition skipped: already conditioned (68°, target 71°)' }],
      ['07:00', 0, { type: 'phase_enter', phase: 'shed', from: 'precondition', season: 'cooling', params: PARAMS_C }],
      ['07:00', 0, { type: 'take', field: 'power', original: 'ON', applied: 'OFF', phase: 'shed' }],
      ['07:00', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }],
    ]),
  ]
  const [ep] = (await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })).units.office.episodes
  assert.deepEqual([ep.status, ep.preSkipped, ep.pre], ['done', 'already conditioned', null])
  assert.deepEqual(ep.conditioned, { keeps: 68, target: 71 })
  assert.equal(ep.season, 'cooling')
  // any other skip keeps its notice reason (or the notice code when it has none); no conditioned
  const other = recs.map((x) => (x.k === 'a' && x.ty === 'notice' ? { ...x, rs: 'season_mismatch', fr: null } : x))
  const [o] = (await rollupDay({ date: D, records: other, cfg: cfgWith(), tz })).units.office.episodes
  assert.deepEqual([o.preSkipped, o.conditioned], ['season_mismatch', null])
})

test('forced intervals (C6.1): from the lines and from the samples by season, ∩ p = 1; overlays forcedMin / forcedFanMin / standbyMin; c records paired to system (C6.7); tail.forced across midnight (C6.8)', async () => {
  const D = DAY
  const D1 = addDays(D, 1)
  const cfg = cfgWith(['living-room', 'office'], { system: SYSTEM })
  const off = (u) => (fields = {}) => ({ u, on: 0, p: 0, ...fields })
  const on = (u) => (fields = {}) => ({ u, ...fields })
  const recs = [
    // office (follower)
    ...buckets(D, '14:00', '21:00', () => on('office')({ m: 'COOL', sp: 72, r: 72 })),
    ...buckets(D, '21:00', '22:00', () => on('office')({ m: 'FAN', sp: 72, r: 72 })),
    ...buckets(D, '22:00', '22:30', () => off('office')({ m: 'FAN', r: 72 })),
    ...buckets(D, '22:30', '23:05', () => on('office')({ m: 'FAN', r: 72 })),
    ...buckets(D, '23:05', '23:30', () => on('office')({ m: 'COOL', r: 72 })),
    ...buckets(D, '23:30', '24:00', () => on('office')({ m: 'FAN', r: 72 })),
    // living room (the master): Heat 14–15 (the office's Cool idles: standby), Dry 15–16 (same season: not standby)
    ...buckets(D, '14:00', '15:00', () => on('living-room')({ m: 'HEAT' })),
    ...buckets(D, '15:00', '16:00', () => on('living-room')({ m: 'DRY' })),
    ...buckets(D, '16:00', '21:00', () => on('living-room')({ m: 'COOL' })),
    ...buckets(D, '21:00', '23:00', () => on('living-room')({ m: 'FAN' })),
    ...buckets(D, '23:00', '23:30', () => off('living-room')({ m: 'FAN' })),
    ...buckets(D, '23:30', '24:00', () => on('living-room')({ m: 'FAN' })),
    ...lines(D, 'office', null, [
      ['21:00', 45, { type: 'forced', actor: 'system', field: 'mode', from: 'COOL', to: 'FAN', by: 'living-room', cause: 'master', sameSeason: false, gated: true }],
      ['21:10', 0, { type: 'forced', actor: 'system', field: 'mode', from: 'COOL', to: 'FAN', by: 'living-room', cause: 'master', sameSeason: false, gated: true }],
      ['23:00', 30, { type: 'unforced', actor: 'system', field: 'mode', value: 'COOL', by: 'living-room', how: 'observed' }],
      ['23:30', 40, { type: 'forced', actor: 'system', field: 'mode', from: 'COOL', to: 'FAN', by: 'living-room', cause: 'master', sameSeason: false, gated: true }],
    ]),
    { k: 'c', t: at(D, '21:00', 5), u: 'office', f: 'mode', o: 'COOL', v: 'FAN', s: 'external', e: null, gap: null },
    { k: 'c', t: at(D, '23:00', 10), u: 'office', f: 'mode', o: 'FAN', v: 'COOL', s: 'external', e: null, gap: null },
    { k: 'c', t: at(D, '23:30', 5), u: 'office', f: 'mode', o: 'COOL', v: 'FAN', s: 'external', e: null, gap: null },
  ]
  const r = await rollupDay({ date: D, records: recs, cfg, tz, constraint: CONSTRAINT })
  const u = r.units.office
  assert.deepEqual(u.forcedMin, { peak: 0, off_peak: 60, super_off_peak: 0, total: 60 }, 'the standby hour (a Cool follower idling under a heating master)')
  assert.deepEqual(u.forcedFanMin, { peak: 0, off_peak: 85, super_off_peak: 30, total: 115 }, 'Fan minutes inside the forced intervals, the OFF half hour excluded')
  assert.deepEqual(u.standbyMin, { peak: 0, off_peak: 60, super_off_peak: 0, total: 60 })
  assert.deepEqual(u.onMin, { peak: 180, off_peak: 180, super_off_peak: 25, total: 385 }, 'standby moved out of onMin; forced conditioning minutes stay on-time')
  assert.deepEqual(u.fanMin, { peak: 0, off_peak: 90, super_off_peak: 35, total: 125 })
  assert.deepEqual(u.changes, { schedule: 0, user: 0, system: 3, external: 0, gapped: 0, total: 3 }, 'mode changes paired with forced / unforced lines are the system’s')
  assert.deepEqual(r.tail.office.forced, { from: at(D, '23:30', 40), mode: 'FAN', by: 'living-room', kind: 'rewrite', cause: 'master', sameSeason: false })
  assert.deepEqual(r.units['living-room'].forcedMin.total, 0, 'the master is never forced')
  assert.equal(r.tail['living-room'].forced, null)
  assert.deepEqual(u.cfgSnapshot.system, { master: 'living-room', forcing: 'master', conflict: 'rewritten' })
  // the next day continues the open interval from local midnight until its unforced line
  const next = [
    ...buckets(D1, '00:00', '00:35', () => on('office')({ m: 'FAN' })),
    ...buckets(D1, '00:35', '02:00', () => on('office')({ m: 'COOL' })),
    ...buckets(D1, '00:00', '02:00', () => off('living-room')({ m: 'FAN' })),
    ...lines(D1, 'office', null, [['00:30', 30, { type: 'unforced', actor: 'system', field: 'mode', value: 'COOL', by: 'living-room', how: 'observed' }]]),
  ]
  const r1 = await rollupDay({ date: D1, records: next, cfg, tz, prevTail: r.tail, constraint: CONSTRAINT })
  assert.deepEqual(r1.units.office.forcedFanMin, { peak: 0, off_peak: 0, super_off_peak: 35, total: 35 })
  assert.equal(r1.tail.office.forced, null)
  // the same day with the constraint off: no samples rule, no pairing, nothing forced
  const offCfg = cfgWith(['living-room', 'office'])
  const u0 = (await rollupDay({ date: D, records: recs.filter((x) => x.ty !== 'forced' && x.ty !== 'unforced'), cfg: offCfg, tz })).units.office
  assert.deepEqual([u0.forcedMin.total, u0.standbyMin.total, u0.onMin.total, u0.changes.external], [0, 0, 445, 3])
  assert.deepEqual(u0.cfgSnapshot.system, { master: null, forcing: null, conflict: null })
})

test('forced episodes (C6.1–C6.3): forced ∩ p = 1 over the episode, q forced at ≥ 50 % (after dry, before low_coverage), forcedBand, a paired c record is no override', async () => {
  const D = DAY
  const am = `${D}@07:00`
  const cfg = cfgWith(['living-room', 'office'], { system: SYSTEM })
  const recs = (sameSeason = false) => [
    ...buckets(D, '04:00', '05:30', (i, t) => ({ sp: t < at(D, '05:00') ? 70 : 73, r: 69.5 })),
    ...buckets(D, '05:30', '06:00', () => ({ m: 'FAN', sp: 73, r: 68.5 })),
    ...buckets(D, '06:00', '07:00', (i) => ({ m: 'FAN', sp: 73, r: i === 6 ? 66.5 : 67 })),
    ...buckets(D, '07:00', '10:00', () => ({ on: 0, p: 0, m: 'FAN', r: 67 })),
    ...buckets(D, '10:00', '11:00', () => ({ r: 68 })),
    ...buckets(D, '04:00', '05:30', () => ({ u: 'living-room' })),
    ...buckets(D, '05:30', '09:00', () => ({ u: 'living-room', m: 'FAN' })),
    ...buckets(D, '09:00', '11:00', () => ({ u: 'living-room', on: 0, p: 0, m: 'FAN' })),
    ...lines(D, 'office', am, [
      ['05:00', 0, { type: 'phase_enter', phase: 'precondition', season: 'heating', params: PARAMS_H }],
      ['05:00', 0, { type: 'take', field: 'temp', original: 70, applied: 73, phase: 'precondition' }],
      ['05:00', 3, { type: 'write', field: 'temp', from: 70, to: 73, kind: 'take', result: 'verified' }],
      ['05:30', 45, { type: 'drop', actor: 'system', field: 'temp', live: 73, reason: 'forced' }],
      ['05:30', 45, { type: 'forced', actor: 'system', field: 'mode', from: 'HEAT', to: 'FAN', by: 'living-room', cause: 'master', sameSeason, gated: true }],
      ['07:00', 0, { type: 'phase_enter', phase: 'shed', from: 'precondition', season: 'heating', params: PARAMS_H }],
      ['07:00', 0, { type: 'take', field: 'power', original: 'ON', applied: 'OFF', phase: 'shed' }],
      ['07:00', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }],
      ['09:00', 10, { type: 'unforced', actor: 'system', field: 'mode', value: 'HEAT', by: 'living-room', how: 'stranded' }],
      ['10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }],
      ['10:00', 20, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'return', result: 'verified' }],
    ]),
    { k: 'c', t: at(D, '05:30', 5), u: 'office', f: 'mode', o: 'HEAT', v: 'FAN', s: 'external', e: am, gap: null },
  ]
  const u = (await rollupDay({ date: D, records: recs(), cfg, tz, constraint: CONSTRAINT })).units.office
  const [ep] = u.episodes
  assert.deepEqual(ep.forced, [{ from: at(D, '05:30', 45), until: at(D, '07:00'), mode: 'FAN', by: 'living-room', kind: 'rewrite', sameSeason: false }], 'cut where the unit turned off')
  assert.equal(ep.q, 'forced', '17 of the 24 p = 1 buckets in [preStart, peakEnd) are forced')
  assert.deepEqual(ep.forcedBand, { outMin: 60, worstF: 66.5, byTier: { peak: 0, off_peak: 0, super_off_peak: 60 } })
  assert.deepEqual(ep.overrides, [], 'the forced change is not the person’s')
  assert.equal(u.changes.system, 1)
  // a dry episode stays 'dry' (dry ranks first); a same-season substitution is information: no q forced, no forcedBand
  const dry = recs().map((x) => (x.k === 'a' && x.ty === 'phase_enter' ? { ...x, dry: true } : x))
  assert.equal((await rollupDay({ date: D, records: dry, cfg, tz, constraint: CONSTRAINT })).units.office.episodes[0].q, 'dry')
  const [same] = (await rollupDay({ date: D, records: recs(true), cfg, tz, constraint: CONSTRAINT })).units.office.episodes
  assert.deepEqual([same.q === 'forced', same.forcedBand, same.forced[0].sameSeason], [false, null, true])
})

test('fan-only carried into the shed (CD-6): from the shed phase_enter with rs adopted_fan / carried_dryout; until unchanged; master dryoutSkipped', async () => {
  const D = DAY
  const am = `${D}@07:00`
  const pm = `${D}@17:00`
  const cfg = cfgWith(['living-room', 'office'], { system: SYSTEM })
  const recs = [
    ...buckets(D, '04:00', '07:00', () => ({ m: 'COOL', sp: 72, r: 72 })),
    ...buckets(D, '07:00', '08:00', () => ({ m: 'FAN', sp: 72, r: 72 })),
    ...buckets(D, '08:00', '10:00', () => ({ on: 0, p: 0, m: 'FAN', r: 73 })),
    ...buckets(D, '10:00', '16:30', () => ({ m: 'COOL', sp: 72, r: 72 })),
    ...buckets(D, '16:30', '17:30', () => ({ m: 'FAN', sp: 72, r: 72 })),
    ...buckets(D, '17:30', '21:00', () => ({ on: 0, p: 0, m: 'FAN', r: 73 })),
    ...buckets(D, '04:00', '21:00', () => ({ u: 'living-room', m: 'COOL' })),
    // C3.3: the office adopted the master's own dry-out FAN at its shed entry — no FAN write of its own
    ...lines(D, 'office', am, [
      ['07:00', 5, { type: 'phase_enter', phase: 'shed', season: 'cooling', params: PARAMS_C, reason: 'adopted_fan', dryOutUntil: new Date(at(D, '08:00') * 1000).toISOString() }],
      ['07:00', 5, { type: 'take', field: 'power', original: 'ON', applied: 'ON', phase: 'shed' }],
      ['08:00', 0, { type: 'take', field: 'power', original: 'ON', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out over' }],
      ['08:00', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }],
    ]),
    // F2′ at 16:30 (an event-less schedule FAN) carried into the 17:00 shed
    ...lines(D, 'office', null, [['16:30', 3, { type: 'write', field: 'mode', from: 'COOL', to: 'FAN', kind: 'schedule', dryOut: true, result: 'verified' }]]),
    ...lines(D, 'office', pm, [
      ['17:00', 5, { type: 'phase_enter', phase: 'shed', season: 'cooling', params: PARAMS_C, reason: 'carried_dryout' }],
      ['17:00', 5, { type: 'take', field: 'power', original: 'ON', applied: 'ON', phase: 'shed' }],
      ['17:30', 0, { type: 'take', field: 'power', original: 'OFF', from: 'ON', applied: 'OFF', phase: 'shed', reason: 'dry-out over' }],
      ['17:30', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }],
    ]),
    // the master went straight off at 07:00: a shed:false follower kept cooling
    ...lines(D, 'living-room', am, [
      ['07:00', 5, { type: 'phase_enter', phase: 'shed', season: 'cooling', params: PARAMS_C }],
      ['07:00', 5, { type: 'notice', actor: 'system', code: 'dryout_skipped', reason: 'follower_running', units: ['office'], season: 'cooling', message: 'Fan-only skipped: Office keeps cooling' }],
      ['07:00', 5, { type: 'take', field: 'power', original: 'ON', applied: 'OFF', phase: 'shed' }],
    ]),
  ]
  const r = await rollupDay({ date: D, records: recs, cfg, tz, constraint: CONSTRAINT })
  const [a, p] = r.units.office.episodes
  assert.deepEqual(a.fanOnly, { from: at(D, '07:00', 5), until: at(D, '08:00', 3), min: 60 })
  assert.deepEqual(p.fanOnly, { from: at(D, '17:00', 5), until: at(D, '17:30', 3), min: 30 })
  assert.deepEqual([a.status, p.status], ['done', 'done'])
  assert.deepEqual([a.dryoutSkipped, p.dryoutSkipped], [null, null])
  assert.deepEqual(r.units['living-room'].episodes[0].dryoutSkipped, { reason: 'follower_running', units: ['office'] })
})

test('comfortDir: cooling setpoint down is comfort, setpoint up is not; fan-only never counts', async () => {
  const g = await gen({
    start: '2026-07-15', days: 1, seed: 8, outdoor: () => 90,
    units: [{ id: 'office', mode: 'COOL', sp: 74, overrides: [{ at: '08:00', field: 'temp', to: 69, src: 'user' }, { at: '17:30', field: 'fan', to: 'HIGH', src: 'external' }] }],
  })
  const [am, pm] = (await roll(g, '2026-07-15')).units.office.episodes
  assert.equal(am.season, 'cooling', 'season from the take sign (applied < original)')
  assert.equal(am.pre.app, 71)
  const o = am.overrides.find((x) => x.f === 'temp')
  assert.equal(o.s, 'user')
  assert.equal(o.ty, 'deferred', 'dashboard temp while shed OFF is deferred (no c record yet)')
  assert.equal(o.o, 71, 'from = setpoint in force (bucket sp) when the activity line has no from')
  assert.equal(o.comfortDir, true)
  const fan = pm.overrides.find((x) => x.f === 'fan')
  assert.equal(fan.comfortDir, false)
  // up-direction setpoint on a cooling unit: not comfort
  const eps = buildEpisodes({
    unitId: 'office', buckets: buckets('2026-07-15', '06:00', '11:00', () => ({ m: 'COOL', sp: 71, on: 0, p: 0, r: 75 })),
    changes: [{ k: 'c', t: at('2026-07-15', '08:00'), u: 'office', f: 'temp', o: 71, v: 76, s: 'external', e: null, gap: null }],
    markers: [act('2026-07-15', '07:00', 0, { ty: 'phase_enter', e: '2026-07-15@07:00', ph: 'shed', se: 'cooling' })],
    events: [{ id: '2026-07-15@07:00', peakStart: tz.zonedToInstant('2026-07-15', '07:00'), peakEnd: tz.zonedToInstant('2026-07-15', '10:00'), precondition: true }],
    band: [68, 78], outdoor: [], tz,
  })
  assert.equal(eps[0].overrides[0].comfortDir, false)
})

test('gap-flagged changes are excluded from overrides; overrides outside [preStart, peakEnd + 5 min) are ignored', () => {
  const D = DAY
  const ev = { id: `${D}@07:00`, peakStart: tz.zonedToInstant(D, '07:00'), peakEnd: tz.zonedToInstant(D, '10:00'), precondition: true }
  const eps = buildEpisodes({
    unitId: 'office',
    buckets: buckets(D, '04:00', '11:00', () => ({})),
    changes: [
      { k: 'c', t: at(D, '07:30'), u: 'office', f: 'temp', o: 70, v: 74, s: 'external', e: ev.id, gap: 420 },
      { k: 'c', t: at(D, '07:40'), u: 'office', f: 'temp', o: 70, v: 74, s: 'external', e: ev.id, gap: null },
      { k: 'c', t: at(D, '07:40', 30), u: 'office', f: 'temp', o: 74, v: 75, s: 'external', e: ev.id, gap: null }, // same minute ⇒ deduped
      { k: 'c', t: at(D, '10:04'), u: 'office', f: 'power', o: 'OFF', v: 'ON', s: 'user', e: null, gap: null },
      { k: 'c', t: at(D, '10:06'), u: 'office', f: 'power', o: 'ON', v: 'OFF', s: 'user', e: null, gap: null },
      { k: 'c', t: at(D, '04:30'), u: 'office', f: 'temp', o: 70, v: 71, s: 'user', e: null, gap: null },
      { k: 'c', t: at(D, '08:00'), u: 'office', f: 'temp', o: 70, v: 73, s: 'schedule', e: ev.id, gap: null },
    ],
    markers: [act(D, '05:00', 0, { ty: 'phase_enter', e: ev.id, ph: 'precondition', se: 'heating', par: { deltaF: 3, leadMin: 120 } })],
    events: [ev], band: [68, 78], outdoor: [], tz,
  })
  const ov = eps[0].overrides
  assert.deepEqual(ov.map((o) => [o.f, o.v]), [['temp', 74], ['power', 'ON']])
})

// ─────────────────────────────── comfort class, drift, sensor flags ───────────────────────────────

test('classify thresholds: violated at 10 min, tight, ok, comfortable, unknown when cov < 0.6 (heating + cooling mirror)', () => {
  const pts = (rs) => rs.map((r) => ({ r }))
  const band = [68, 78]
  // heating: edge L = 68
  assert.equal(classify(pts([69, 67.5, 70]), band, 'heating', 1, 2).class, 'tight', 'one bucket (5 min) below is not a violation')
  const v = classify(pts([69, 67.5, 67.9, 70]), band, 'heating', 1, 2)
  assert.deepEqual(v, { class: 'violated', m: -0.5, violMin: 10, Tmin: 67.5, Tmax: 70 })
  assert.equal(classify(pts([68.5, 70]), band, 'heating', 1, 2).class, 'tight') // m 0.5 < marginF
  assert.equal(classify(pts([69, 70]), band, 'heating', 1, 2).class, 'ok') // m 1.0
  assert.equal(classify(pts([69.9, 70]), band, 'heating', 1, 2).class, 'ok') // m 1.9 < comfy
  assert.equal(classify(pts([70, 71]), band, 'heating', 1, 2).class, 'comfortable') // m 2.0
  assert.equal(classify(pts([70, 71]), band, 'heating', 1, 2, 0.5).class, 'unknown', 'comfort needs cov ≥ 0.6')
  assert.equal(classify(pts([67, 66, 70]), band, 'heating', 1, 2, 0.2).class, 'violated', 'a violation counts with any coverage')
  // cooling mirror: edge H = 78, m = H − Tmax
  assert.deepEqual(classify(pts([77, 78.5, 78.2]), band, 'cooling', 1, 2), { class: 'violated', m: -0.5, violMin: 10, Tmin: 77, Tmax: 78.5 })
  assert.equal(classify(pts([77.5]), band, 'cooling', 1, 2).class, 'tight')
  assert.equal(classify(pts([77]), band, 'cooling', 1, 2).class, 'ok')
  assert.equal(classify(pts([76]), band, 'cooling', 1, 2).class, 'comfortable')
  assert.equal(classify([], band, 'heating').class, 'unknown')
  assert.equal(classify(pts([70]), band, null).class, 'unknown')
})

test('driftFit: OLS slope, one robust pass drops a spike, ok gates (n, span, cov, se, flat)', () => {
  const off = 1_000_000
  const line = (n, b, a = 72, start = 600) => Array.from({ length: n }, (_, i) => {
    const t = off + start + i * 300
    return { t, r: a + b * ((t + 150 - off) / 3600) }
  })
  const f = driftFit(line(20, -1.2), off, { end: off + 600 + 20 * 300 })
  assert.equal(f.b, -1.2)
  assert.equal(f.a, 72)
  assert.equal(f.n, 20)
  assert.equal(f.r2, 1)
  assert.equal(f.cov, 1)
  assert.equal(f.ok, true)
  // +5 °F spike is dropped and the slope recovered
  const spiky = line(20, -1.2)
  spiky[10] = { ...spiky[10], r: spiky[10].r + 5 }
  const s = driftFit(spiky, off, { end: off + 600 + 20 * 300 })
  assert.equal(s.dropped, 1)
  near(s.b, -1.2, 0.02)
  // gates
  assert.equal(driftFit(line(5, -1), off, { end: off + 600 + 5 * 300 }).ok, false, 'n < 6')
  assert.equal(driftFit(line(8, -1), off, { end: off + 600 + 8 * 300 }).ok, false, 'span 35 min < 45')
  assert.equal(driftFit(line(10, -1), off, { end: off + 600 + 10 * 300 }).ok, true, 'span 45 min')
  assert.equal(driftFit(line(10, -1), off, { end: off + 600 + 20 * 300 }).ok, false, 'cov 0.5 < 0.6')
  assert.equal(driftFit(line(20, -1), off, { end: off + 600 + 20 * 300, flat: true }).ok, false, 'flat sensor ⇒ not ok')
  const noisy = line(8, 0).map((p, i) => ({ ...p, r: p.r + (i % 2 ? 1.5 : -1.5) }))
  const nf = driftFit(noisy.concat(line(4, 0, 72, 600 + 8 * 300)), off)
  assert.ok(nf.se > 0.4 && nf.ok === false, `se gate (se ${nf.se})`)
  assert.equal(driftFit(line(2, -1), off), null)
  assert.equal(driftFit([{ t: off + 900, r: 70 }, { t: off + 900, r: 71 }, { t: off + 900, r: 72 }], off), null, 'no x spread')
})

/** 5-min bucket means of a linearly drifting room read every 20 s and quantised to 1 °F (no noise). */
function quantisedShed(offAt, fromF, toF, hours = 3) {
  const end = offAt + hours * 3600
  const out = []
  for (let b = offAt + 600; b + 300 <= end; b += 300) {
    let s = 0
    let n = 0
    for (let t = b; t < b + 300; t += 20) { s += Math.round(fromF + ((toF - fromF) * (t - offAt)) / (hours * 3600)); n++ }
    out.push({ t: b, r: Math.round((s / n) * 10) / 10, n, cv: 300, on: 0 })
  }
  return out
}

test('sensorFlags: flat needs 12 identical OFF buckets ∧ |Tout − r̄| ≥ 10 ∧ shed ≥ 60 min; 1 °F quantisation is not flat', () => {
  const off = at(DAY, '07:00')
  const end = off + 3 * 3600
  const frozen = Array.from({ length: 34 }, (_, i) => ({ t: off + 600 + i * 300, r: 72 }))
  assert.equal(sensorFlags(frozen, 45, null, [], { offAt: off, shedEnd: end }).flat, true)
  assert.equal(sensorFlags(frozen, 63, null, [], { offAt: off, shedEnd: end }).flat, false, '|Tout − r̄| = 9 < 10')
  assert.equal(sensorFlags(frozen, null, null, [], { offAt: off, shedEnd: end }).flat, false, 'no outdoor data ⇒ cannot call it flat')
  assert.equal(sensorFlags(frozen.slice(0, 11), 45, null, [], { offAt: off, shedEnd: end }).flat, false, '11 identical')
  assert.equal(sensorFlags(frozen.slice(0, 12), 45, null, [], { offAt: off, shedEnd: off + 3000 }).flat, false, 'shed < 60 min')
  const gapped = frozen.filter((_, i) => i !== 6)
  assert.equal(sensorFlags(gapped.slice(0, 13), 45, null, [], { offAt: off, shedEnd: end }).flat, false, 'a gap breaks the run')
  // well-insulated room: 3 °F over 3 h, 1 °F resolution, no noise ⇒ runs of 11 identical buckets at most
  const q = quantisedShed(off, 72.4, 69.4)
  assert.ok(Math.max(...q.map((p) => p.r)) - Math.min(...q.map((p) => p.r)) >= 2.5)
  assert.equal(sensorFlags(q, 40, null, [], { offAt: off, shedEnd: end }).flat, false)
})

test('sensorFlags: jump compares [onAt, onAt+10 min) with the last 10 OFF minutes (±2.0 °F)', () => {
  const off = at(DAY, '07:00')
  const end = off + 3 * 3600
  const offPts = Array.from({ length: 34 }, (_, i) => ({ t: off + 600 + i * 300, r: 71 - i * 0.05 }))
  const lastOff = 71 - 33 * 0.05 // ≈ 69.35
  const after = (d) => [{ t: end + 300, r: lastOff - 2 - d, n: 15 }, { t: end + 600, r: lastOff - 2 - d, n: 15 }, { t: end + 1200, r: 50, n: 15 }]
  assert.equal(sensorFlags(offPts, 40, end + 100, after(0.2), { offAt: off, shedEnd: end }).jump, true)
  assert.equal(sensorFlags(offPts, 40, end + 100, after(-0.3), { offAt: off, shedEnd: end }).jump, false)
  assert.equal(sensorFlags(offPts, 40, null, after(1), { offAt: off, shedEnd: end }).jump, false, 'no onAt ⇒ no jump')
})

test('generated sensors: flat and jump are detected; an ok sensor in a well-insulated room is neither', async () => {
  const flat = (await roll(await gen({ start: DAY, days: 1, seed: 5, outdoor: () => 40, units: [{ id: 'office', sensor: 'flat' }] }), DAY)).units.office.episodes
  for (const e of flat) {
    assert.equal(e.shed.flat, true)
    assert.equal(e.shed.drift.ok, false, 'a flat episode never feeds the model')
    assert.equal(e.q, 'flat')
  }
  const jump = (await roll(await gen({ start: DAY, days: 1, seed: 5, outdoor: () => 40, units: [{ id: 'office', sensor: 'jump', thermal: { heatFph: 1 } }] }), DAY)).units.office.episodes
  for (const e of jump) {
    assert.equal(e.shed.jump, true)
    assert.equal(e.rec.jump, true)
    assert.equal(e.shed.flat, false)
    assert.equal(e.q, 'jump')
  }
  const calm = (await roll(await gen({ start: DAY, days: 1, seed: 6, outdoor: () => 40, units: [{ id: 'office', quantize: 1, thermal: { alpha: 0, beta: 0.035 } }] }), DAY)).units.office.episodes
  for (const e of calm) {
    assert.equal(e.shed.flat, false)
    assert.equal(e.shed.jump, false)
    assert.ok(e.shed.Tmax - e.shed.Tmin >= 2.5 && e.shed.Tmax - e.shed.Tmin <= 4, `range ${e.shed.Tmin}–${e.shed.Tmax}`)
  }
})

// ─────────────────────────────── HomeKit auto pattern ───────────────────────────────

test('auto: an external override at the same clock time (±2 min) on ≥ 3 of the last 7 event days, chained through prevTail', async () => {
  const days = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']
  const g = await gen({
    start: days[0], days: days.length, seed: 11,
    units: [{ id: 'office', overrides: [{ at: '07:40', field: 'temp', to: 75, src: 'external', days: ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-19'] }] }],
  })
  let tail = null
  const flags = {}
  for (const d of days) {
    const r = await roll(g, d, tail)
    tail = r.tail
    flags[d] = r.units.office.episodes.flatMap((e) => e.overrides.filter((o) => o.s === 'external').map((o) => o.auto))
  }
  assert.deepEqual(flags['2026-10-13'], [false])
  assert.deepEqual(flags['2026-10-14'], [false])
  assert.deepEqual(flags['2026-10-15'], [true], 'third event day at 07:40')
  assert.deepEqual(flags['2026-10-16'], [])
  assert.deepEqual(flags['2026-10-17'], [], 'weekend: no events')
  assert.deepEqual(flags['2026-10-19'], [true], 'weekend days do not age the pattern out')
  assert.equal(tail.office.ext.length, 5, 'one entry per event day (weekends skipped)')
  assert.ok(tail.office.ext.every((x) => Array.isArray(x.m)))
  // without the chain the pattern is unknown ⇒ auto stays false
  const alone = await roll(g, '2026-10-19', null)
  assert.deepEqual(alone.units.office.episodes.flatMap((e) => e.overrides.map((o) => o.auto)), [false])
})

// ─────────────────────────────── outdoor, commands, robustness ───────────────────────────────

test('missing outdoor slots are back-filled from hourly data and flagged', async () => {
  const D = DAY
  const recs = [
    ...buckets(D, '06:30', '10:30', (i, t) => (t >= at(D, '07:00') && t < at(D, '10:00') ? { on: 0, p: 0, r: 72 - (t - at(D, '07:00')) / 3600 } : {})),
    act(D, '07:00', 0, { ty: 'phase_enter', e: `${D}@07:00`, ph: 'shed', se: 'heating' }),
    act(D, '07:00', 0, { ty: 'take', e: `${D}@07:00`, f: 'power', fr: 'ON', to: 'OFF' }),
    act(D, '07:00', 2, { ty: 'write', e: `${D}@07:00`, f: 'power', fr: 'ON', to: 'OFF', res: 'verified' }),
    { k: 'o', t: at(D, '06:00'), f: 40 }, // one real sample, before the shed
  ]
  const fill = []
  for (let h = 0; h <= 24; h++) fill.push({ t: sec(tz.zonedToInstant(D, '00:00')) + h * 3600, f: 30 + h })
  const cfg = cfgWith()
  const r = await rollupDay({ date: D, records: recs, cfg, tz, outdoorFill: fill, builtAt: null })
  assert.equal(r.outdoor.n, 96)
  assert.equal(r.outdoor.filled, 95)
  assert.equal(r.outdoor.coverage, 1)
  const ep = r.units.office.episodes[0]
  assert.equal(ep.shed.filled, true)
  near(ep.shed.Tout, 38.5, 0.3, 'mean of the hourly curve over 07:00–10:00')
  // without fill: no outdoor for the shed
  const r2 = await rollupDay({ date: D, records: recs, cfg, tz })
  assert.equal(r2.outdoor.n, 1)
  assert.equal(r2.outdoor.filled, 0)
  assert.equal(r2.units.office.episodes[0].shed.Tout, null)
  assert.equal(r2.outdoor.hdd65, 25)
  assert.equal(r2.outdoorCoverage, r2.outdoor.coverage)
})

test('shed Tout: the real sample of each slot, else its back-fill — a partial outage keeps the filled slots (usage-rollup-1)', async () => {
  const D = DAY
  const recs = (outdoor) => [
    ...buckets(D, '06:30', '10:30', (i, t) => (t >= at(D, '07:00') && t < at(D, '10:00') ? { on: 0, p: 0, r: 72 - (t - at(D, '07:00')) / 3600 } : {})),
    act(D, '07:00', 0, { ty: 'phase_enter', e: `${D}@07:00`, ph: 'shed', se: 'heating' }),
    act(D, '07:00', 0, { ty: 'take', e: `${D}@07:00`, f: 'power', fr: 'ON', to: 'OFF' }),
    act(D, '07:00', 2, { ty: 'write', e: `${D}@07:00`, f: 'power', fr: 'ON', to: 'OFF', res: 'verified' }),
    ...outdoor,
  ]
  // hourly back-fill rising 3 °F/h: 51 at 07:00 … 60 at 10:00 (the 15-min slots in the shed read 51.8 … 59.3)
  const fill = []
  for (let h = 0; h <= 24; h++) fill.push({ t: sec(tz.zonedToInstant(D, '00:00')) + h * 3600, f: 30 + 3 * h })
  const cfg = cfgWith()
  const shedOf = async (outdoor) => (await rollupDay({ date: D, records: recs(outdoor), cfg, tz, outdoorFill: fill, builtAt: null })).units.office.episodes[0].shed
  // one real sample (07:15, 52 °F) inside the shed, the other ten slots of [07:00:02, 10:00) back-filled:
  // Tout = (52 + 52.5 + 53.3 + 54 + 54.8 + 55.5 + 56.3 + 57 + 57.8 + 58.5 + 59.3) / 11 = 55.5 — not the lone real 52
  const mixed = await shedOf([{ k: 'o', t: at(D, '07:15'), f: 52 }])
  assert.equal(mixed.Tout, 55.5, 'the back-filled slots count next to the real sample')
  assert.equal(mixed.filled, true, 'filled ⇔ any slot of the shed window was back-filled')
  assert.equal(mixed.gap, Math.round((mixed.rBar - mixed.Tout) * 10) / 10, 'gap = r̄ − Tout')
  assert.equal(mixed.x, Math.round((mixed.Tout - mixed.rBar) * 10) / 10, 'x = s·(Tout − r̄)')
  // no real sample in the shed: every slot back-filled (unchanged)
  const none = await shedOf([{ k: 'o', t: at(D, '06:00'), f: 40 }])
  assert.equal(none.Tout, 55.5)
  assert.equal(none.filled, true)
  // every slot real: the back-fill is never consulted (unchanged)
  const real = []
  for (let i = 1; i <= 11; i++) real.push({ k: 'o', t: at(D, '07:00', i * 900), f: 40 + i })
  const all = await shedOf(real)
  assert.equal(all.Tout, 46, 'mean of the eleven real samples 41 … 51')
  assert.equal(all.filled, false)
})

test('command counts from mirrored activity; failing/blocked tagged on the episode', async () => {
  const D = DAY
  const e = `${D}@07:00`
  const recs = [
    ...buckets(D, '06:00', '11:00', () => ({})),
    act(D, '07:00', 0, { ty: 'phase_enter', e, ph: 'shed', se: 'heating' }),
    act(D, '07:00', 1, { ty: 'take', e, f: 'power', fr: 'ON', to: 'OFF' }),
    act(D, '07:00', 5, { ty: 'write', e, f: 'power', fr: 'ON', to: 'OFF', res: 'not_applied' }),
    act(D, '07:00', 6, { ty: 'retry', e, f: 'power', cl: 'not_applied' }),
    act(D, '07:01', 0, { ty: 'verify_fail', e, f: 'power', cl: 'not_applied' }),
    act(D, '07:02', 0, { ty: 'failing', e, f: 'power', cl: 'timeout' }),
    act(D, '07:03', 0, { ty: 'blocked', e, cl: 'identity_mismatch' }),
    act(D, '07:30', 0, { ty: 'recovered', e }),
    act(D, '07:30', 5, { ty: 'write', e, f: 'power', fr: 'ON', to: 'OFF', res: 'verified' }),
    act(D, '12:00', 0, { ty: 'would_write', f: 'temp', fr: 70, to: 73 }),
  ]
  const r = await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })
  const j = r.units.office.jobs
  assert.deepEqual({ ...j, items: j.items.length }, { writes: 2, verified: 1, wouldWrite: 1, retries: 1, verifyFail: 1, failing: 1, blocked: 1, recovered: 1, items: 5 })
  assert.equal(j.items[0].ty, 'write')
  assert.match(j.items[3].message, /Failing: power · timeout/)
  const ep = r.units.office.episodes[0]
  assert.deepEqual(ep.jobs, { retries: 1, failing: 1, blocked: 1 })
  assert.equal(ep.shed.offAt, at(D, '07:30', 5), 'offAt from the VERIFIED write only')
  assert.equal(ep.status, 'done')
})

test('status absent / skipped, torn lines, foreign days and duplicate buckets', async () => {
  const D = DAY
  const recs = [
    ...buckets(D, '06:00', '08:00', () => ({})),
    bucket(D, '06:00', { n: 5, cv: 100, on: 100, r: 72 }), // same bucket re-emitted after a restart ⇒ merged
    '{"k":"s","t":', // torn
    'not json',
    { k: 's', t: at(addDays(D, 1), '00:05'), u: 'office', r: 70, n: 15, cv: 300, on: 300, p: 1 }, // next day
    act(D, '17:00', 0, { ty: 'skipped', e: `${D}@17:00` }),
    { k: 'h', t: at(D, '06:00'), boot: 'b_x' },
    { k: 'p', t: at(D, '01:30'), u: 'office', se: 'heating', pa: 'deltaF', fr: 3, to: 4, s: 'optimizer', id: 't_1' },
  ]
  const r = await rollupDay({ date: D, records: recs, cfg: cfgWith(), tz })
  assert.equal(r.counts.bad, 3)
  assert.equal(r.counts.h, 1)
  const u = r.units.office
  assert.equal(u.room.day.n, 24, 'duplicate bucket merged')
  const merged = u.spark.room[24] // 06:00 slot mean
  assert.ok(merged > 70 && merged < 72)
  assert.deepEqual(u.episodes.map((e) => e.status), ['absent', 'skipped'])
  assert.deepEqual(u.params, [{ t: at(D, '01:30'), se: 'heating', pa: 'deltaF', fr: 3, to: 4, s: 'optimizer', id: 't_1' }])
})

test('async iterable input (usage.readDay) gives the same rollup as an array', async () => {
  const g = await gen({ start: DAY, days: 1, seed: 3, units: [{ id: 'office' }] })
  const a = await roll(g, DAY)
  const b = await rollupDay({ date: DAY, records: g.usage.readDay(DAY), cfg: g.cfg, tz, builtAt: '2026-10-15T08:30:00.000Z' })
  assert.equal(JSON.stringify(b), JSON.stringify(a))
})

test('units: config order first, unknown record units appended; units without data get empty rollups', async () => {
  const cfg = cfgWith(['kitchen', 'office'])
  const recs = [bucket(DAY, '06:00'), { ...bucket(DAY, '06:00'), u: 'attic' }]
  const r = await rollupDay({ date: DAY, records: recs, cfg, tz })
  assert.deepEqual(Object.keys(r.units), ['kitchen', 'office', 'attic'])
  assert.equal(r.units.kitchen.coverage, 0)
  assert.equal(r.units.kitchen.episodes.length, 2)
  assert.ok(r.units.kitchen.episodes.every((e) => e.status === 'absent'))
  assert.equal(r.tail.kitchen, null)
  assert.deepEqual(r.units.kitchen.band, { L: 68, H: 78, insideMin: 0, belowMin: 0, aboveMin: 0, peakInsideMin: 0, peakCoveredMin: 0, shedInsideMin: 0, shedCoveredMin: 0 })
})

test('band = comfort band + sensorOffsetF; band minutes over covered buckets', async () => {
  const cfg = cfgWith()
  cfg.optimizer.units.office = { enabled: true, comfortLowF: 69, comfortHighF: 75, sensorOffsetF: 1 }
  const recs = buckets(DAY, '12:00', '13:00', (i) => ({ r: 69 + i })) // 69 … 80
  const u = (await rollupDay({ date: DAY, records: recs, cfg, tz })).units.office
  assert.equal(u.band.L, 70)
  assert.equal(u.band.H, 76)
  assert.equal(u.band.belowMin, 5)
  assert.equal(u.band.insideMin, 35)
  assert.equal(u.band.aboveMin, 20)
  assert.deepEqual(u.cfgSnapshot.band, [70, 76])
})

test('setpoint: time-weighted over ON seconds only; userChanges counts user/external temp changes', async () => {
  const recs = [
    ...buckets(DAY, '12:00', '13:00', () => ({ sp: 70 })), // 12 × 300 s ON at 70
    ...buckets(DAY, '13:00', '13:30', () => ({ sp: 73 })), // 6 × 300 s ON at 73
    ...buckets(DAY, '13:30', '14:00', () => ({ sp: 75, on: 0, p: 0 })), // OFF: ignored
    ...buckets(DAY, '14:00', '14:10', () => ({ sp: 64, on: 150, cv: 300 })), // 2 × 150 s ON at 64
    { k: 'c', t: at(DAY, '13:00'), u: 'office', f: 'temp', o: 70, v: 73, s: 'user', e: null, gap: null },
    { k: 'c', t: at(DAY, '13:30'), u: 'office', f: 'temp', o: 73, v: 75, s: 'external', e: null, gap: null },
    { k: 'c', t: at(DAY, '14:00'), u: 'office', f: 'temp', o: 75, v: 64, s: 'schedule', e: null, gap: null },
  ]
  const u = (await rollupDay({ date: DAY, records: recs, cfg: cfgWith(), tz })).units.office
  // (70·3600 + 73·1800 + 64·300) / 5700
  assert.equal(u.setpoint.mean, Math.round(((70 * 3600 + 73 * 1800 + 64 * 300) / 5700) * 10) / 10)
  assert.deepEqual([u.setpoint.min, u.setpoint.max, u.setpoint.userChanges], [64, 73, 2])
  assert.equal(u.onMin.total, 95)
  assert.equal(u.offMin.total, 35)
})

// ─────────────────────────────── golden + determinism ───────────────────────────────

test('golden fixture 2026-10-14 snapshot', async () => {
  const lines = readFileSync(GOLDEN_FILE, 'utf8').split('\n').filter(Boolean)
  const cfg = cfgWith()
  const r = await rollupDay({ date: GOLDEN_DATE, records: lines, cfg, tz, builtAt: '2026-10-15T08:30:04.000Z' })
  assert.deepEqual(r.counts, { s: 73, c: 4, a: 10, o: 12, p: 0, b: 1, h: 1, bad: 0 })
  const u = r.units.office
  assert.deepEqual(u.onMin, { peak: 0, off_peak: 43, super_off_peak: 140, total: 183 })
  assert.equal(u.coverage, 0.25)
  assert.deepEqual(u.setpoint, { mean: 73.1, min: 70, max: 75, userChanges: 1 })
  assert.deepEqual(u.changes, { schedule: 3, user: 0, system: 0, external: 1, gapped: 0, total: 4 })
  const [am, pm] = u.episodes
  assert.deepEqual(
    { ev: am.ev, status: am.status, season: am.season, par: am.par, preStart: am.preStart, q: am.q },
    { ev: '2026-10-14@07:00', status: 'done', season: 'heating', par: { deltaF: 3, leadMin: 120 }, preStart: 1791979200, q: 'ok' },
  )
  assert.deepEqual(am.pre, { orig: 70, app: 73, dApp: 3, capped: false, T0: 70, T0room: 70, Tpk: 72.1, rise: 2.1, eff: 0.7, reached: false, t90: 90, reachedMinBeforePeak: 0, leadUsed: 120 })
  assert.deepEqual(am.shed.drift, { b: -1, a: 72.1, n: 33, se: 0.027, r2: 0.98, cov: 0.97, dropped: 0, ok: true })
  assert.deepEqual(
    { offAt: am.shed.offAt, end: am.shed.end, cov: am.shed.cov, Tmin: am.shed.Tmin, Tmax: am.shed.Tmax, m: am.shed.m, violMin: am.shed.violMin, class: am.shed.class, Tout: am.shed.Tout, flat: am.shed.flat, jump: am.shed.jump },
    { offAt: 1791986402, end: 1791997200, cov: 0.97, Tmin: 69.2, Tmax: 72, m: 1.2, violMin: 0, class: 'ok', Tout: 42.9, flat: false, jump: false },
  )
  assert.deepEqual(am.rec, { onAt: 1791997302, sp: 75, minToSp: null, slope: 1.1, jump: false })
  assert.deepEqual(am.overrides, [{ t: 1791990000, f: 'temp', o: 73, v: 75, s: 'external', ty: 'change', comfortDir: true, auto: false }])
  assert.equal(pm.status, 'absent', 'the fixture window ends at 10:45')
  assert.deepEqual(r.tail.office, { power: 'ON', mode: 'HEAT', temp: 75, fan: 'LOW', at: 1791999600, ext: [{ d: '2026-10-14', m: [480] }], forced: null })
})

test('identical bytes on rebuild; builtAt stamped verbatim', async () => {
  const g = await gen({ start: DAY, days: 2, seed: 12, units: [{ id: 'office' }, { id: 'kitchen', mode: 'COOL', sp: 74 }] })
  const a1 = await roll(g, DAY)
  const a2 = await roll(g, DAY)
  assert.equal(JSON.stringify(a2), JSON.stringify(a1))
  const b1 = await roll(g, '2026-10-15', a1.tail)
  const b2 = await roll(g, '2026-10-15', a2.tail)
  assert.equal(JSON.stringify(b2), JSON.stringify(b1))
  assert.equal(a1.builtAt, '2026-10-15T08:30:00.000Z')
  const c = await rollupDay({ date: DAY, records: g.byDate[DAY], cfg: g.cfg, tz, builtAt: Date.parse('2026-10-15T08:30:00Z') })
  assert.equal(c.builtAt, '2026-10-15T08:30:00.000Z')
  assert.ok(JSON.stringify(a1).length < 64 * 1024, 'a two-unit rollup stays small')
})

// ─────────────────────────────── Release 4.1 (addendum E): boundary episodes ───────────────────────────────

const SAT = '2026-09-26' // Saturday; the default weekend table's super off-peak → off-peak step at 07:00
const BEV = `${SAT}@07:00`
/** cfgWith + precondition.superOffPeak.weekend (the helper addendum E §5 calls cfgE). */
function cfgE(unitIds = ['office'], weekend = true) {
  const cfg = cfgWith(unitIds)
  cfg.precondition.superOffPeak = { weekend }
  return cfg
}

test('Release 4.1 (E1.14): a generated Saturday — one boundary episode measured to 7:00, no shed, q pre_only; an OFF unit has none (J23); the option off has none (J25)', async () => {
  const units = [{ id: 'office', mode: 'HEAT', sp: 70 }, { id: 'kitchen', power: 'OFF' }]
  const g = await gen({ cfg: cfgE(['office', 'kitchen']), start: SAT, days: 2, seed: 3, units })
  const r = await roll(g, SAT)
  assert.equal(r.dayType, 'weekend')
  assert.deepEqual(r.events, [{ id: BEV, peakStart: at(SAT, '07:00'), peakEnd: at(SAT, '07:00'), precondition: true }])
  const [ep, ...more] = r.units.office.episodes
  assert.deepEqual(more, [])
  const te = g.truth.events.office[BEV]
  assert.deepEqual(
    { ev: ep.ev, kind: ep.kind, status: ep.status, season: ep.season, par: ep.par, precondition: ep.precondition, preStart: ep.preStart, peakStart: ep.peakStart, peakEnd: ep.peakEnd },
    { ev: BEV, kind: 'boundary', status: 'done', season: 'heating', par: { deltaF: 3, leadMin: 120 }, precondition: true, preStart: at(SAT, '05:00'), peakStart: at(SAT, '07:00'), peakEnd: at(SAT, '07:00') },
  )
  assert.deepEqual([ep.pre.orig, ep.pre.app, ep.pre.dApp, ep.pre.leadUsed, ep.preFromOff], [70, 73, 3, 120, false])
  near(ep.pre.T0, te.T0, 0.3, 'T0 over [04:45, 05:00)')
  near(ep.pre.Tpk, te.Tpk, 0.3, 'Tpk over [06:45, 07:00)')
  near(ep.pre.eff, te.eff, 0.1, 'eff')
  assert.equal(ep.pre.reached, te.reached)
  assert.deepEqual([ep.shed, ep.fanOnly, ep.rec, ep.released, ep.q], [null, null, null, null, 'pre_only'])
  assert.deepEqual(r.units.kitchen.episodes, [], 'an OFF unit without an ON entry never has the event: no episode (J23)')
  assert.equal(r.units.office.band.shedCoveredMin, 0, 'no shed-window band minutes')
  const sun = await roll(g, addDays(SAT, 1), r.tail)
  assert.deepEqual(sun.units.office.episodes.map((e) => [e.ev, e.kind, e.q]), [[`${addDays(SAT, 1)}@07:00`, 'boundary', 'pre_only']])
  // J25: the option off ⇒ Release 4's weekend (no events, no episodes, the unit follows its setting)
  const off = await gen({ cfg: cfgE(['office', 'kitchen'], false), start: SAT, days: 1, seed: 3, units })
  const ro = await roll(off, SAT)
  assert.deepEqual([ro.events, ro.units.office.episodes, ro.units.kitchen.episodes], [[], [], []])
})

test('Release 4.1 (E1.14): a weekday rolls up byte-identically with the option on or off; its episodes are kind peak', async () => {
  const g = await gen({ start: DAY, days: 1, seed: 3, units: [{ id: 'office', mode: 'HEAT', sp: 70 }] })
  const on = await rollupDay({ date: DAY, records: g.byDate[DAY], cfg: cfgE(), tz, builtAt: '2026-10-15T08:30:00.000Z' })
  const off = await rollupDay({ date: DAY, records: g.byDate[DAY], cfg: cfgE(['office'], false), tz, builtAt: '2026-10-15T08:30:00.000Z' })
  assert.equal(JSON.stringify(on), JSON.stringify(off))
  assert.deepEqual(on.units.office.episodes.map((e) => [e.ev, e.kind]), [[`${DAY}@07:00`, 'peak'], [`${DAY}@17:00`, 'peak']])
})

test('Release 4.1 (E1.14): boundary episodes as decide logs them — running, from an entry, the refused ON (rec from the return), overrides to 7:05, forced, dry run', async () => {
  const cfg = cfgE()
  const roll1 = async (recs) => (await rollupDay({ date: SAT, records: recs, cfg, tz })).units.office.episodes
  const B = true
  const room = (i) => Math.round((68 + i * 0.14) * 100) / 100 // 05:00 → 06:55: 68 → 71.22
  const warm = [
    ...buckets(SAT, '04:00', '05:00', () => ({ r: 68 })),
    ...buckets(SAT, '05:00', '07:00', (i) => ({ sp: 73, f: 'HIGH', r: room(i) })),
    ...buckets(SAT, '07:00', '09:00', () => ({ r: 71 })),
  ]
  // (a) running: temp + fan taken at 05:00, returned at 07:00 — nothing turns off
  const running = lines(SAT, 'office', BEV, [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', boundary: B, season: 'heating', params: PARAMS_H }],
    ['05:00', 0, { type: 'take', field: 'temp', original: 70, applied: 73, phase: 'precondition', boundary: B }],
    ['05:00', 0, { type: 'take', field: 'fan', original: 'LOW', applied: 'HIGH', phase: 'precondition', boundary: B }],
    ['05:00', 3, { type: 'write', field: 'temp', from: 70, to: 73, kind: 'take', result: 'verified' }],
    ['05:00', 5, { type: 'write', field: 'fan', from: 'LOW', to: 'HIGH', kind: 'take', result: 'verified' }],
    ['07:00', 0, { type: 'phase_exit', phase: 'precondition', reason: 'ended', boundary: B }],
    ['07:00', 3, { type: 'write', field: 'temp', from: 73, to: 70, kind: 'return', result: 'verified' }],
    ['07:00', 5, { type: 'write', field: 'fan', from: 'HIGH', to: 'LOW', kind: 'return', result: 'verified' }],
    ['07:00', 20, { type: 'restored', fields: ['temp', 'fan'], boundary: B }],
  ])
  const changes = [
    { k: 'c', t: at(SAT, '04:55'), u: 'office', f: 'temp', o: 70, v: 71, s: 'user', e: null, gap: null }, // before preStart
    { k: 'c', t: at(SAT, '06:10'), u: 'office', f: 'temp', o: 73, v: 74, s: 'external', e: BEV, gap: null },
    { k: 'c', t: at(SAT, '07:04'), u: 'office', f: 'fan', o: 'LOW', v: 'AUTO', s: 'user', e: null, gap: null },
    { k: 'c', t: at(SAT, '07:06'), u: 'office', f: 'temp', o: 70, v: 72, s: 'user', e: null, gap: null }, // after t + 5 min
  ]
  const [a] = await roll1([...warm, ...running, ...changes])
  assert.deepEqual(
    { kind: a.kind, status: a.status, season: a.season, preStart: a.preStart, preFromOff: a.preFromOff, shed: a.shed, fanOnly: a.fanOnly, rec: a.rec, q: a.q, forced: a.forced },
    { kind: 'boundary', status: 'done', season: 'heating', preStart: at(SAT, '05:00'), preFromOff: false, shed: null, fanOnly: null, rec: null, q: 'pre_only', forced: [] },
  )
  const Tpk = room(22) // the median of the 06:45, 06:50, 06:55 buckets
  assert.deepEqual(
    { orig: a.pre.orig, app: a.pre.app, T0: a.pre.T0, T0room: a.pre.T0room, Tpk: a.pre.Tpk, reached: a.pre.reached, leadUsed: a.pre.leadUsed },
    { orig: 70, app: 73, T0: 68, T0room: 68, Tpk, reached: false, leadUsed: 120 },
    'T0 over [04:45, 05:00), Tpk over [06:45, 07:00)',
  )
  near(a.pre.eff, (Tpk - 68) / 3, 0.01, 'eff = rise / dApp')
  assert.deepEqual(a.overrides.map((o) => [o.f, o.v]), [['temp', 74], ['fan', 'AUTO']], 'overrides over [preStart, t + 5 min)')

  // (b) from an OFF unit with the 07:00 entry: power/mode/temp/fan taken, the power return is quiet ⇒ no rec
  const entry = { key: `s:${BEV}`, fields: { power: 'ON', mode: 'HEAT', temp: 70, fan: 'LOW' } }
  const fromOff = (refused) => lines(SAT, 'office', BEV, [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', boundary: B, season: 'heating', params: PARAMS_H, entry }],
    ['05:00', 0, { type: 'take', field: 'power', original: 'OFF', applied: 'ON', phase: 'precondition', entry: entry.key, boundary: B }],
    ['05:00', 0, { type: 'take', field: 'mode', original: 'FAN', applied: 'HEAT', phase: 'precondition', entry: entry.key, boundary: B }],
    ['05:00', 0, { type: 'take', field: 'temp', original: 70, applied: 73, base: 70, phase: 'precondition', entry: entry.key, boundary: B }],
    ['05:00', 0, { type: 'take', field: 'fan', original: 'LOW', applied: 'HIGH', phase: 'precondition', entry: entry.key, boundary: B }],
    ...(refused
      ? [['05:00', 23, { type: 'verify_fail', actor: 'system', field: 'power', class: 'not_applied' }]]
      : [
        ['05:00', 23, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'take', result: 'verified' }],
        ['05:00', 43, { type: 'write', field: 'mode', from: 'FAN', to: 'HEAT', kind: 'take', result: 'verified' }],
        ['05:00', 45, { type: 'write', field: 'temp', from: 70, to: 73, kind: 'take', result: 'verified' }],
      ]),
    ['07:00', 0, { type: 'phase_exit', phase: 'precondition', reason: 'ended', boundary: B }],
    ...(refused
      ? [
        ['07:00', 0, { type: 'notice', actor: 'system', code: 'precondition_skipped', reason: 'not_on', boundary: B, message: 'Precondition skipped: the unit did not turn on' }],
        ['07:00', 23, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'return', result: 'verified' }],
        ['07:00', 43, { type: 'write', field: 'mode', from: 'FAN', to: 'HEAT', kind: 'return', result: 'verified' }],
      ]
      : [['07:00', 3, { type: 'write', field: 'temp', from: 73, to: 70, kind: 'return', result: 'verified' }]]),
  ])
  const offNight = buckets(SAT, '04:00', '05:00', () => ({ on: 0, p: 0, m: 'FAN', r: 66 }))
  const [b] = await roll1([...offNight, ...buckets(SAT, '05:00', '07:00', (i) => ({ sp: 73, f: 'HIGH', r: 66 + i * 0.2 })), ...buckets(SAT, '07:00', '09:00', () => ({ r: 70 })), ...fromOff(false)])
  assert.deepEqual([b.kind, b.status, b.preFromOff, b.pre.orig, b.pre.T0, b.pre.T0room, b.rec, b.shed, b.q], ['boundary', 'done', true, 70, 70, 66, null, null, 'pre_only'])
  // the refused ON: not_on at 7:00, the RETURN writes power ON over the OFF ⇒ rec from that ON (N-23)
  const onAt = at(SAT, '07:00', 23)
  const refusedDay = [...offNight, ...buckets(SAT, '05:00', '07:00', () => ({ on: 0, p: 0, m: 'FAN', r: 66 })), ...buckets(SAT, '07:00', '09:00', (i) => ({ sp: 70, r: 66 + i * 0.3 }))]
  const [c] = await roll1([...refusedDay, ...fromOff(true)])
  assert.deepEqual([c.kind, c.status, c.preFromOff, c.preSkipped, c.pre.reached, c.shed, c.q], ['boundary', 'done', true, 'not_on', false, null, 'pre_only'])
  assert.equal(c.rec.onAt, onAt, 'rec from the scheduler power ON at/after t')
  assert.deepEqual([c.rec.sp, c.rec.minToSp], [70, 50])
  // …and its forced intervals stay on [preStart, t): the return's recovery is not the pre-condition's
  const masterForces = lines(SAT, 'office', BEV, [
    ['06:00', 0, { type: 'forced', actor: 'system', field: 'mode', from: 'HEAT', to: 'FAN', by: 'living-room', cause: 'master', sameSeason: false }],
    ['07:40', 0, { type: 'unforced', actor: 'system', field: 'mode', value: 'HEAT', by: 'living-room', how: 'stranded' }],
  ])
  const [c2] = (await rollupDay({ date: SAT, records: [...refusedDay, ...fromOff(true), ...masterForces], cfg: Object.assign(cfgE(['living-room', 'office']), { system: SYSTEM }), tz, constraint: CONSTRAINT })).units.office.episodes
  assert.deepEqual([c2.rec.onAt, c2.forced, c2.q], [onAt, [], 'pre_only'], 'the forced 07:00–07:40 (∩ ON) lies after t')

  // restore-now at 06:00 returns power OFF and mode FAN under the boundary id: never a shed, a fan-only or a rec (J22)
  const restoreNow = lines(SAT, 'office', BEV, [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', boundary: B, season: 'heating', params: PARAMS_H, entry }],
    ['05:00', 0, { type: 'take', field: 'power', original: 'OFF', applied: 'ON', phase: 'precondition', entry: entry.key, boundary: B }],
    ['05:00', 0, { type: 'take', field: 'mode', original: 'FAN', applied: 'HEAT', phase: 'precondition', entry: entry.key, boundary: B }],
    ['05:00', 0, { type: 'take', field: 'temp', original: 70, applied: 73, base: 70, phase: 'precondition', entry: entry.key, boundary: B }],
    ['05:00', 23, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'take', result: 'verified' }],
    ['06:00', 0, { type: 'phase_exit', phase: 'precondition', reason: 'restore-now', boundary: B }],
    ['06:00', 3, { type: 'write', field: 'temp', from: 73, to: 70, kind: 'return', result: 'verified' }],
    ['06:00', 5, { type: 'write', field: 'mode', from: 'HEAT', to: 'FAN', kind: 'return', result: 'verified' }],
    ['06:00', 25, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'return', result: 'verified' }],
  ])
  const [d] = await roll1([...offNight, ...buckets(SAT, '05:00', '06:00', () => ({ sp: 73 })), ...buckets(SAT, '06:00', '07:00', () => ({ on: 0, p: 0, m: 'FAN' })), ...buckets(SAT, '07:00', '09:00', () => ({})), ...restoreNow])
  assert.deepEqual([d.kind, d.status, d.shed, d.fanOnly, d.rec, d.q], ['boundary', 'done', null, null, null, 'pre_only'])
  // a person's power ON before t releases the unit: rec comes only from a scheduler ON at/after t
  const personOn = lines(SAT, 'office', BEV, [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', boundary: B, season: 'heating', params: PARAMS_H, entry }],
    ['05:00', 0, { type: 'take', field: 'power', original: 'OFF', applied: 'ON', phase: 'precondition', entry: entry.key, boundary: B }],
    ['06:00', 0, { type: 'released', actor: 'external', field: 'power', from: 'OFF', to: 'ON', reason: 'external-power', boundary: B }],
  ])
  const [e] = await roll1([...offNight, ...buckets(SAT, '05:00', '06:00', () => ({ on: 0, p: 0, m: 'FAN' })), ...buckets(SAT, '06:00', '09:00', () => ({})), ...personOn])
  assert.deepEqual([e.kind, e.status, e.released.f, e.released.v, e.rec, e.q], ['boundary', 'released', 'power', 'ON', null, 'pre_only'])

  // forced by the master over ≥ 50 % of [preStart, t) ⇒ q forced (dry > forced > pre_only); the span ends at t
  const forced = [
    ...running.filter((x) => at(SAT, '07:00') > x.t),
    ...lines(SAT, 'office', BEV, [
      ['05:10', 0, { type: 'forced', actor: 'system', field: 'mode', from: 'HEAT', to: 'FAN', by: 'living-room', cause: 'master', sameSeason: false }],
      ['07:30', 0, { type: 'unforced', actor: 'system', field: 'mode', value: 'HEAT', by: 'living-room', how: 'stranded' }],
    ]),
  ]
  const [f] = (await rollupDay({ date: SAT, records: [...warm, ...forced], cfg: Object.assign(cfgE(['living-room', 'office']), { system: SYSTEM }), tz, constraint: CONSTRAINT })).units.office.episodes
  assert.equal(f.q, 'forced')
  assert.deepEqual(f.forced.map((x) => [x.from, x.until, x.mode]), [[at(SAT, '05:10'), at(SAT, '07:00'), 'FAN']], 'clipped to [preStart, t)')
  const dry = [...warm, ...running].map((x) => (x.k === 'a' && x.ty === 'phase_enter' ? { ...x, dry: true } : x))
  const [g] = await roll1(dry)
  assert.deepEqual([g.kind, g.status, g.q], ['boundary', 'dry', 'dry'])
})

test('Release 4.2 (Addendum F rule 10, A §4.6): a re-planned precondition — the last phase_enter, the first temp take at or after it, replanned: true; one phase_enter has no replanned key', async () => {
  const D = DAY
  const am = `${D}@07:00`
  // the master bedroom's 07:00 On · keep mode · cool to 74° / heat to 70°, OFF overnight remembering Cool at 72: engaged at
  // 05:00 for cooling (nothing sent — the ON waits for its 05:00:40 slot); the living room turned on in Heat at 05:00:30,
  // so the next step (05:00:35) re-planned for heating: the unsent temp take un-owned as system, a second mirrored
  // precondition phase_enter with the heating params (its own Δ, the window kept), the heating takes, then the one-frame ON
  const entry = { key: `s:${D}@07:00`, fields: { power: 'ON', coolTo: 74, heatTo: 70 } }
  const PARAMS_H4 = { ...PARAMS_H, deltaF: 4 }
  const replan = (withSecond) => lines(D, 'office', am, [
    ['05:00', 0, { type: 'phase_enter', phase: 'precondition', season: 'cooling', params: PARAMS_C, entry: { ...entry, season: 'cooling', resolved: { season: 'cooling', temp: 74 } } }],
    ['05:00', 0, { type: 'take', field: 'power', original: 'OFF', applied: 'ON', phase: 'precondition', entry: entry.key }],
    ['05:00', 0, { type: 'take', field: 'temp', original: 72, applied: 71, base: 74, phase: 'precondition', entry: entry.key }],
    ['05:00', 0, { type: 'take', field: 'fan', original: 'LOW', applied: 'HIGH', phase: 'precondition', entry: entry.key }],
    ...(withSecond
      ? [
        ['05:00', 35, { type: 'drop', actor: 'system', field: 'temp', live: 72, reason: 'season', season: 'cooling' }],
        ['05:00', 35, { type: 'phase_enter', phase: 'precondition', reason: 'season_changed', season: 'heating', params: PARAMS_H4, entry: { ...entry, season: 'heating', resolved: { season: 'heating', mode: 'HEAT', temp: 70 } }, by: 'living-room', byMode: 'HEAT' }],
        ['05:00', 35, { type: 'take', field: 'mode', original: 'COOL', applied: 'HEAT', phase: 'precondition', entry: entry.key }],
        ['05:00', 35, { type: 'take', field: 'temp', original: 72, applied: 74, base: 70, phase: 'precondition', entry: entry.key }],
        ['05:00', 43, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'take', withMode: 'HEAT', result: 'verified' }],
        ['05:00', 46, { type: 'write', field: 'temp', from: 72, to: 74, kind: 'take', result: 'verified' }],
      ]
      : [
        ['05:00', 43, { type: 'write', field: 'power', from: 'OFF', to: 'ON', kind: 'take', result: 'verified' }],
        ['05:00', 46, { type: 'write', field: 'temp', from: 72, to: 71, kind: 'take', result: 'verified' }],
      ]),
    ['07:00', 0, { type: 'phase_enter', phase: 'shed', from: 'precondition', season: withSecond ? 'heating' : 'cooling', params: withSecond ? PARAMS_H4 : PARAMS_C }],
    ['07:00', 0, { type: 'take', field: 'power', original: 'OFF', from: 'ON', applied: 'OFF', phase: 'shed' }],
    ['07:00', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', kind: 'take', result: 'verified' }],
    ['10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }],
  ])
  const room = (i) => Math.round((64 + i * 0.25) * 100) / 100
  const recs = [
    ...buckets(D, '04:00', '05:05', () => ({ on: 0, p: 0, m: 'COOL', sp: 72, r: 64 })),
    ...buckets(D, '05:05', '07:00', (i) => ({ sp: 74, f: 'HIGH', r: room(i) })),
    ...buckets(D, '07:00', '10:00', (i) => ({ on: 0, p: 0, sp: 74, r: 69 - i * 0.02 })),
  ]
  const [ep] = (await rollupDay({ date: D, records: [...recs, ...replan(true)], cfg: cfgWith(), tz })).units.office.episodes
  assert.equal(ep.replanned, true, 'more than one precondition phase_enter')
  assert.deepEqual(
    { status: ep.status, season: ep.season, par: ep.par, preStart: ep.preStart, preFromOff: ep.preFromOff, preSkipped: ep.preSkipped },
    { status: 'done', season: 'heating', par: { deltaF: 4, leadMin: 120 }, preStart: at(D, '05:00', 35), preFromOff: true, preSkipped: null },
    'season, par and preStart from the last phase_enter; the first power take still decides preFromOff',
  )
  assert.deepEqual(
    { orig: ep.pre.orig, app: ep.pre.app, dApp: ep.pre.dApp, capped: ep.pre.capped, T0: ep.pre.T0, T0room: ep.pre.T0room, leadUsed: ep.pre.leadUsed },
    { orig: 70, app: 74, dApp: 4, capped: false, T0: 70, T0room: 64, leadUsed: 119 },
    'the heating take after the re-plan (base 70), never the dropped cooling one; leadUsed from the re-plan instant',
  )
  // a re-plan that took no setpoint after it (the new season's target already met): the dropped take is never the episode's
  const noTake = replan(true).filter((a) => !(a.ty === 'take' && a.f === 'temp' && a.bs === 70))
  const [nt] = (await rollupDay({ date: D, records: [...recs, ...noTake], cfg: cfgWith(), tz })).units.office.episodes
  assert.deepEqual([nt.replanned, nt.season, nt.preStart, nt.pre], [true, 'heating', at(D, '05:00', 35), null])
  // one precondition phase_enter (no re-plan): no replanned key at all — the episode reads exactly as before Addendum F
  const [one] = (await rollupDay({ date: D, records: [...recs, ...replan(false)], cfg: cfgWith(), tz })).units.office.episodes
  assert.ok(!('replanned' in one), 'no replanned key')
  assert.deepEqual([one.season, one.preStart, one.pre.orig, one.pre.app, one.par], ['cooling', at(D, '05:00'), 74, 71, { deltaF: 3, leadMin: 120 }])
})
