// tuning.test.js — addendum §8.2: effectivePrecondition base vs tuned; read-time clamp when maxDeltaF is
// lowered (clampedBy); suspended; earliestStart clamps preStart only for a tuned lead (D X1); optimumLead (D E2.3); gateOpen false in
// [preStart(max lead), peakEnd) and while phase ≠ idle, true at 01:30; check returns each refusal code;
// applyMutation shapes; nextApplyDate around earliestStart. Plus property-style bounds over 2 000 seeded
// contexts (deltaF within [min, max], preStart ≥ earliestStart, heating/cooling mirrored) and the
// freeze-at-TAKE helpers. Re-runs itself under TZ=UTC and TZ=Asia/Tokyo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeTz } from '../tz.js'
import * as tou from '../tou.js'
import {
  seasonOf, emptyTuning, normalizeTuning, effectivePrecondition, snapshotParams, activeParams, currentValue,
  nextApplyDate, gateOpen, check, applyMutation, toPending, pruneTuning, validateTuningCfg, guardrails,
  preconditionPeakStartMin, observeInfo, dirOf, KINDS, REFUSALS, UNDO_WINDOW_MS, optimumLead,
  SEASONS, WATER_SEASON, ALL_SEASONS, mutationSeasons,
} from '../tuning.js'

const SELF = fileURLToPath(import.meta.url)
if (process.env.FK_TZ_CHILD !== '1') {
  for (const zone of ['UTC', 'Asia/Tokyo']) {
    test(`tuning suite passes with process TZ=${zone}`, () => {
      const env = { ...process.env, TZ: zone, FK_TZ_CHILD: '1' }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 120000 })
      assert.equal(r.status, 0, `child under TZ=${zone} failed:\n${r.stdout}\n${r.stderr}`)
    })
  }
}

const tz = makeTz('America/Los_Angeles')
const L = (date, hhmm) => tz.zonedToInstant(date, hhmm)
const ISO = (ms) => new Date(ms).toISOString()
const MON = '2026-09-21'
const TUE = '2026-09-22'
const WED = '2026-09-23'
const THU = '2026-09-24'
const FRI = '2026-09-25'
const SAT = '2026-09-26'
const SUN = '2026-09-27'

function cfgDefault() {
  return {
    schemaVersion: 1,
    rev: 1,
    timezone: 'America/Los_Angeles',
    automation: { mode: 'live' },
    units: [
      { id: 'kitchen', name: 'Kitchen', host: '198.51.100.21', order: 0, shed: true, precondition: true },
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
    holidays: { preset: 'us-federal', rows: [{ date: '2026-11-26', name: 'Thanksgiving Day', observed: false, source: 'preset' }] },
    precondition: {
      modes: ['COOL', 'DRY', 'HEAT'],
      deltaF: { cooling: 3, heating: 3 },
      leadMin: { cooling: 120, heating: 120 },
      clampF: { coolingMin: 65, heatingMax: 76 },
      minLeadMin: 20,
      joinCutoffMin: 10,
    },
    shed: { minRemainingMin: 15, restoreStaggerSec: 20, minDwellSec: 180 },
    device: { pollSec: 20, pollSecWithClients: 10, statusPollSec: 300, verifyPollSec: [2, 4, 7, 11, 16], tempToleranceF: 0.6, warmupSec: 90, deviationReads: 2, deviationMinGapSec: 15, wevents: false },
    limits: { maxSentPerField: { precondition: 1, shed: 3, restore: 3, manual: 3 }, automationWritesPerDay: 24, manualWarnPerDay: 80, manualIntentTtlSec: 600 },
    retry: { backoffSec: [5, 15, 30, 60, 120, 300], jitterPct: 20, failingAfterAttempts: 4, notifyAfterSec: 180 },
    notify: { ntfyUrl: null, onFailure: true, onRecovery: true },
    usage: { enabled: true, flushSec: 300, retentionDays: 400, compressAfterDays: 1, maxRawMB: 200 },
    outdoor: { enabled: true, lat: 0, lon: 0, sampleMin: 15 },
    insights: { runAt: '01:30', windowDays: 14, modelDays: 45, reportKeepDays: 60 },
    optimizer: {
      enabled: true, observeDays: 3, minDeltaF: 1, maxDeltaF: 4, earliestStart: '04:30', minLeadMin: 60,
      maxStepDeltaF: 1, maxStepLeadMin: 30, marginF: 1, comfyMarginF: 2, revertCooldownDays: 3,
      minDaysBetweenOpposite: 3, dormantDays: 3,
      units: {
        kitchen: { enabled: true, comfortLowF: 68, comfortHighF: 78, sensorOffsetF: 0 },
        office: { enabled: true, comfortLowF: 68, comfortHighF: 78, sensorOffsetF: 0 },
      },
    },
  }
}

const unitCfgOf = (cfg, id = 'office') => cfg.units.find((u) => u.id === id)
function unitWith(tuningPatch = {}, auto = { phase: 'idle', eventId: null, params: null }) {
  const t = emptyTuning()
  for (const [k, v] of Object.entries(tuningPatch)) {
    if (k === 'heating' || k === 'cooling') Object.assign(t[k], v)
    else t[k] = v
  }
  return { auto, tuning: t }
}
function world({ cfgPatch, tuning, enabledAt = '2026-09-01T12:00:00Z', scheduleEnabled = true } = {}) {
  const cfg = cfgDefault()
  if (cfgPatch) cfgPatch(cfg)
  const office = unitWith(tuning)
  const state = { scheduleEnabled, insights: { optimizerEnabledAt: enabledAt }, units: { office, kitchen: unitWith() } }
  return { cfg, state, office }
}
const change = (over = {}) => ({ kind: 'change', unit: 'office', id: 't_1', season: 'heating', param: 'deltaF', from: 3, to: 4, applyDate: WED, analysisDate: TUE, rule: 'R1_DELTA', ...over })

// mulberry32
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- season, shapes -------------------------------------------------------------------------------

test('seasonOf: from the unit mode, never the calendar', () => {
  assert.equal(seasonOf('HEAT'), 'heating')
  assert.equal(seasonOf('heat'), 'heating')
  assert.equal(seasonOf('COOL'), 'cooling')
  assert.equal(seasonOf('DRY'), 'cooling')
  for (const m of ['FAN', 'AUTO', 'OFF', '', null, undefined, 42]) assert.equal(seasonOf(m), null)
})

test('emptyTuning: §2.11 shape, fresh objects; normalizeTuning fills gaps and keeps values', () => {
  const s = { deltaF: null, leadMin: null, setAt: null, evidenceFrom: null, lastAnalysisDate: null, history: [] }
  assert.deepEqual(emptyTuning(), {
    enabledAt: null, heating: s, cooling: s, suspended: null, pending: null, lockedDates: [], cooldown: {}, frozen: {},
    lastUpAt: null, lastRevert: null, reverts: [],
  })
  const a = emptyTuning()
  const b = emptyTuning()
  a.heating.history.push(1)
  a.lockedDates.push(WED)
  assert.deepEqual(b.heating.history, [])
  assert.deepEqual(b.lockedDates, [])
  assert.notEqual(a.heating, a.cooling)

  const legacy = { heating: { deltaF: 4 }, lockedDates: 'junk', suspended: { since: WED, changeId: 'x' } }
  const n = normalizeTuning(legacy)
  assert.equal(n, legacy, 'normalised in place')
  assert.equal(n.heating.deltaF, 4)
  assert.equal(n.heating.leadMin, null)
  assert.deepEqual(n.heating.history, [])
  assert.deepEqual(n.cooling, s)
  assert.deepEqual(n.lockedDates, [])
  assert.deepEqual(n.suspended, { since: WED, changeId: 'x' })
  assert.equal(n.lastRevert, null)
  assert.deepEqual(normalizeTuning(null), emptyTuning())
  assert.equal(normalizeTuning({ heating: { deltaF: 'x' } }).heating.deltaF, null)
})

// ---- effective parameters -------------------------------------------------------------------------

test('effectivePrecondition: base config values per season; null season uses heating values', () => {
  const cfg = cfgDefault()
  cfg.precondition.deltaF.cooling = 2
  cfg.precondition.leadMin.cooling = 90
  const u = unitCfgOf(cfg)
  assert.deepEqual(effectivePrecondition(cfg, u, null, 'heating'), {
    season: 'heating', deltaF: 3, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, earliestStart: '04:30',
    suspended: false, source: 'config', deltaSource: 'config', leadSource: 'config', clampedBy: null,
  })
  const c = effectivePrecondition(cfg, u, unitWith(), 'cooling')
  assert.equal(c.season, 'cooling')
  assert.equal(c.deltaF, 2)
  assert.equal(c.leadMin, 90)
  assert.equal(c.source, 'config')
  const n = effectivePrecondition(cfg, u, unitWith(), null)
  assert.equal(n.season, null)
  assert.equal(n.deltaF, 3)
  assert.equal(n.leadMin, 120)
  assert.equal(effectivePrecondition(cfg, u, unitWith(), 'spring').season, null)
  // clampF is a copy, never the config object
  const e = effectivePrecondition(cfg, u, null, 'heating')
  e.clampF.heatingMax = 99
  assert.equal(cfg.precondition.clampF.heatingMax, 76)
  // an empty/missing config still yields the documented defaults (never throws)
  const d = effectivePrecondition({}, null, null, 'heating')
  assert.equal(d.deltaF, 3)
  assert.equal(d.leadMin, 120)
  assert.equal(d.earliestStart, '04:30')
})

test('effectivePrecondition: tuned values override per season and are marked tuned', () => {
  const cfg = cfgDefault()
  const u = unitCfgOf(cfg)
  const us = unitWith({ heating: { deltaF: 4 } })
  const h = effectivePrecondition(cfg, u, us, 'heating')
  assert.equal(h.deltaF, 4)
  assert.equal(h.leadMin, 120)
  assert.equal(h.source, 'tuned')
  assert.deepEqual([h.deltaSource, h.leadSource], ['tuned', 'config'], 'X1.1: provenance per parameter')
  assert.equal(h.clampedBy, null)
  const c = effectivePrecondition(cfg, u, us, 'cooling')
  assert.equal(c.deltaF, 3, 'heating tuning never leaks into cooling')
  assert.equal(c.source, 'config')
  const lead = effectivePrecondition(cfg, u, unitWith({ cooling: { leadMin: 150 } }), 'cooling')
  assert.equal(lead.leadMin, 150)
  assert.equal(lead.deltaF, 3)
  assert.equal(lead.source, 'tuned')
  assert.deepEqual([lead.deltaSource, lead.leadSource], ['config', 'tuned'])
})

test('effectivePrecondition: read-time clamp when guardrails tighten (clampedBy)', () => {
  const cfg = cfgDefault()
  const u = unitCfgOf(cfg)
  const us = unitWith({ heating: { deltaF: 4 } })
  cfg.optimizer.maxDeltaF = 3
  let e = effectivePrecondition(cfg, u, us, 'heating')
  assert.equal(e.deltaF, 3)
  assert.equal(e.clampedBy, 'maxDeltaF')
  assert.equal(us.tuning.heating.deltaF, 4, 'state is never rewritten by a read')
  cfg.optimizer.maxDeltaF = 8 // hard cap 6
  e = effectivePrecondition(cfg, u, unitWith({ heating: { deltaF: 7 } }), 'heating')
  assert.equal(e.deltaF, 6)
  assert.equal(e.clampedBy, 'maxDeltaF')
  cfg.optimizer.maxDeltaF = 4
  cfg.optimizer.minDeltaF = 3
  e = effectivePrecondition(cfg, u, unitWith({ heating: { deltaF: 2 } }), 'heating')
  assert.equal(e.deltaF, 3)
  assert.equal(e.clampedBy, 'minDeltaF')
  cfg.optimizer.minDeltaF = 1
  cfg.optimizer.minLeadMin = 90
  e = effectivePrecondition(cfg, u, unitWith({ heating: { leadMin: 60 } }), 'heating')
  assert.equal(e.leadMin, 90)
  assert.equal(e.clampedBy, 'minLeadMin')
  cfg.optimizer.minLeadMin = 60
  // a tuned lead that would start before earliestStart: flagged, window clamped by tou (not rewritten here)
  e = effectivePrecondition(cfg, u, unitWith({ heating: { leadMin: 180 } }), 'heating')
  assert.equal(e.leadMin, 180)
  assert.equal(e.clampedBy, 'earliestStart')
  // X1.1: a tuned Δ over a base lead of 180 is never 'earliestStart' — only a tuned lead is held to it
  cfg.precondition.leadMin.heating = 180
  e = effectivePrecondition(cfg, u, unitWith({ heating: { deltaF: 4 } }), 'heating')
  assert.equal(e.clampedBy, null)
  cfg.precondition.leadMin.heating = 120
  // only TUNED parameters are clamped: a user's base Δ 5 (> maxDeltaF 4) survives a tuned lead
  cfg.precondition.deltaF.heating = 5
  e = effectivePrecondition(cfg, u, unitWith({ heating: { leadMin: 150 } }), 'heating')
  assert.equal(e.deltaF, 5)
  assert.equal(e.leadMin, 150)
  assert.equal(e.source, 'tuned')
  assert.equal(e.clampedBy, null)
  e = effectivePrecondition(cfg, u, unitWith(), 'heating')
  assert.equal(e.deltaF, 5, 'base values are never clamped by optimizer guardrails')
  assert.equal(e.source, 'config')
})

test('effectivePrecondition: suspended; tou then drops the precondition window', () => {
  const cfg = cfgDefault()
  const us = unitWith({ suspended: { since: WED, changeId: 't_s' } })
  const e = effectivePrecondition(cfg, unitCfgOf(cfg), us, 'heating')
  assert.equal(e.suspended, true)
  const ev = tou.events(cfg, tz, WED)[0]
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', e), null)
  assert.equal(effectivePrecondition(cfg, unitCfgOf(cfg), unitWith(), 'heating').suspended, false)
})

test('earliestStart clamps preStart only for a tuned LEAD (X1.1; tou.preconditionWindow with eff)', () => {
  const cfg = cfgDefault()
  cfg.precondition.leadMin.heating = 180 // user base: 04:00
  const ev = tou.events(cfg, tz, WED)[0]
  const base = effectivePrecondition(cfg, unitCfgOf(cfg), unitWith(), 'heating')
  assert.equal(base.source, 'config')
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', base).preStart, L(WED, '04:00'))
  // a tuned Δ alone never moves the person's start (the judge's case: it was clamped to 04:30)
  const deltaOnly = effectivePrecondition(cfg, unitCfgOf(cfg), unitWith({ heating: { deltaF: 4 } }), 'heating')
  assert.equal(deltaOnly.source, 'tuned')
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', deltaOnly).preStart, L(WED, '04:00'))
  // frozen auto.params written before the upgrade carry only `source`: they keep their old window
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', { leadMin: 180, source: 'tuned' }).preStart, L(WED, '04:30'))
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', { leadMin: 180, source: 'tuned', leadSource: 'config' }).preStart, L(WED, '04:00'))
  const tuned = effectivePrecondition(cfg, unitCfgOf(cfg), unitWith({ heating: { leadMin: 180 } }), 'heating')
  assert.equal(tuned.source, 'tuned')
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', tuned).preStart, L(WED, '04:30'))
  const ok = effectivePrecondition(cfg, unitCfgOf(cfg), unitWith({ heating: { leadMin: 150 } }), 'heating')
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', ok).preStart, L(WED, '04:30'))
  const later = effectivePrecondition(cfg, unitCfgOf(cfg), unitWith({ heating: { leadMin: 90 } }), 'heating')
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', later).preStart, L(WED, '05:30'))
})

test('property: 2 000 seeded contexts — bounds, preStart ≥ earliestStart, heating/cooling mirrored', () => {
  const r = rng(20260923)
  const pickOf = (arr) => arr[Math.floor(r() * arr.length)]
  const dates = [WED, THU, FRI, '2026-03-09', '2026-11-02', '2026-11-03', '2027-01-04']
  const allowedClamp = new Set([null, 'maxDeltaF', 'minDeltaF', 'minLeadMin', 'earliestStart'])
  for (let i = 0; i < 2000; i++) {
    const cfg = cfgDefault()
    const o = cfg.optimizer
    o.maxDeltaF = 1 + Math.floor(r() * 8) // 1..8 (hard cap 6)
    o.minDeltaF = 1 + Math.floor(r() * Math.min(o.maxDeltaF, 6))
    o.minLeadMin = 20 + 5 * Math.floor(r() * 25) // 20..140
    const latest = 420 - o.minLeadMin
    const esMin = 180 + 5 * Math.floor(r() * ((latest - 180) / 5 + 1)) // 03:00..latest (validation bound)
    o.earliestStart = `${String(Math.floor(esMin / 60)).padStart(2, '0')}:${String(esMin % 60).padStart(2, '0')}`
    cfg.precondition.deltaF = { heating: 1 + Math.floor(r() * 6), cooling: 1 + Math.floor(r() * 6) }
    cfg.precondition.leadMin = { heating: 20 + 10 * Math.floor(r() * 23), cooling: 20 + 10 * Math.floor(r() * 23) }
    const tunedFor = () => ({
      deltaF: r() < 0.5 ? null : Math.floor(r() * 10),
      leadMin: r() < 0.5 ? null : 5 * Math.floor(r() * 61),
    })
    const heating = tunedFor()
    const cooling = tunedFor()
    const us = unitWith({ heating, cooling, suspended: r() < 0.1 ? { since: WED, changeId: 'x' } : null })
    const season = pickOf(['heating', 'cooling'])
    const e = effectivePrecondition(cfg, unitCfgOf(cfg), us, season)
    const g = guardrails(cfg)
    const tuned = us.tuning[season]
    const ctx = `#${i} ${JSON.stringify({ o: { min: o.minDeltaF, max: o.maxDeltaF, minLead: o.minLeadMin, es: o.earliestStart }, season, tuned })}`
    assert.ok(allowedClamp.has(e.clampedBy), ctx)
    assert.equal(e.source, tuned.deltaF != null || tuned.leadMin != null ? 'tuned' : 'config', ctx)
    assert.equal(e.source, e.deltaSource === 'tuned' || e.leadSource === 'tuned' ? 'tuned' : 'config', ctx)
    assert.equal(e.leadSource, tuned.leadMin != null ? 'tuned' : 'config', ctx)
    if (e.clampedBy === 'earliestStart') assert.equal(e.leadSource, 'tuned', ctx)
    if (tuned.deltaF != null) {
      assert.ok(e.deltaF >= o.minDeltaF && e.deltaF <= Math.min(o.maxDeltaF, 6), `deltaF ${e.deltaF} out of bounds ${ctx}`)
      assert.ok(e.deltaF >= g.minDeltaF && e.deltaF <= g.maxDeltaF, ctx)
    } else assert.equal(e.deltaF, cfg.precondition.deltaF[season], ctx)
    if (tuned.leadMin != null) assert.ok(e.leadMin >= o.minLeadMin && e.leadMin <= 240, `leadMin ${e.leadMin} ${ctx}`)
    else assert.equal(e.leadMin, cfg.precondition.leadMin[season], ctx)
    assert.ok(g.maxLeadMin >= g.minLeadMin && g.maxLeadMin <= 240, ctx)
    assert.ok(420 - g.maxLeadMin >= esMin || g.maxLeadMin === g.minLeadMin, ctx)

    // the window a tuned unit gets never starts before earliestStart (and a suspended one has none)
    const date = pickOf(dates)
    const ev = tou.events(cfg, tz, date).find((x) => x.precondition)
    const w = tou.preconditionWindow(cfg, tz, ev, season, e)
    if (e.suspended) assert.equal(w, null, ctx)
    else if (e.leadSource === 'tuned' && w) assert.ok(w.preStart >= L(date, o.earliestStart), `preStart ${ISO(w.preStart)} < ${o.earliestStart} ${ctx}`)
    if (w && e.clampedBy === 'earliestStart') assert.equal(w.preStart, L(date, o.earliestStart), ctx)
    // X1 / J16: a lead that is not tuned gives the base window, whatever Δ is tuned to
    if (!e.suspended && e.leadSource === 'config') {
      const base = effectivePrecondition(cfg, unitCfgOf(cfg), unitWith(), season)
      const bw = tou.preconditionWindow(cfg, tz, ev, season, base)
      assert.equal(w?.preStart ?? null, bw?.preStart ?? null, `Δ-only tuning moved the start ${ctx}`)
    }

    // mirrored: swap the seasons everywhere ⇒ identical result except the season label
    const mcfg = structuredClone(cfg)
    mcfg.precondition.deltaF = { heating: cfg.precondition.deltaF.cooling, cooling: cfg.precondition.deltaF.heating }
    mcfg.precondition.leadMin = { heating: cfg.precondition.leadMin.cooling, cooling: cfg.precondition.leadMin.heating }
    const mus = unitWith({ heating: { ...cooling }, cooling: { ...heating }, suspended: us.tuning.suspended })
    const other = season === 'heating' ? 'cooling' : 'heating'
    const m = effectivePrecondition(mcfg, unitCfgOf(mcfg), mus, other)
    assert.deepEqual({ ...m, season: season }, e, `mirror ${ctx}`)

    // and the gate never opens inside that window
    if (w) {
      const inside = w.preStart + Math.floor(r() * (ev.peakEnd - w.preStart))
      const gate = gateOpen({ cfg, tz, unitCfg: unitCfgOf(cfg), unitState: us, now: inside, effMax: e })
      assert.equal(gate.open, false, `gate open at ${ISO(inside)} ${ctx}`)
      assert.equal(gate.until, ev.peakEnd, ctx)
    }
  }
})

test('optimumLead (addendum D E2.3): need, learned vs fixed, cap, 5-minute grid, cooling mirror', () => {
  const L0 = (o) => optimumLead({ season: 'heating', room: 66, target: 70, rateFph: 4.5, capMin: 60, baseLeadMin: 120, ...o })
  assert.deepEqual(L0(), { leadMin: 55, source: 'learned', need: 4 }, '4 °F at 4.5 °F/h = 53.3 min ⇒ 55')
  assert.deepEqual(L0({ room: 69 }), { leadMin: 0, source: null, need: 1 }, 'need ≤ 1 ⇒ no early start')
  assert.deepEqual(L0({ room: 71 }), { leadMin: 0, source: null, need: -1 })
  assert.equal(L0({ room: 64, rateFph: 3 }).leadMin, 60, '6 °F at 3 °F/h = 120 min ⇒ the cap 60')
  assert.deepEqual(L0({ rateFph: null }), { leadMin: 60, source: 'fixed', need: 4 }, 'no evidence ⇒ min(lead, 60)')
  assert.deepEqual(L0({ rateFph: 0.4 }), { leadMin: 60, source: 'fixed', need: 4 }, 'a slope < 0.5 is no evidence')
  assert.equal(L0({ rateFph: null, baseLeadMin: 45 }).leadMin, 45)
  assert.equal(L0({ rateFph: null, baseLeadMin: 42 }).leadMin, 45, 'rounded up to the 5-minute grid')
  assert.deepEqual(L0({ room: null }), { leadMin: 60, source: 'fixed', need: null }, 'room unknown ⇒ fixed')
  assert.deepEqual(L0({ capMin: 0 }), { leadMin: 0, source: null, need: 4 }, 'cap 0 = off')
  assert.equal(L0({ capMin: 120, room: 60, rateFph: 12 }).leadMin, 50, '10 °F at 12 °F/h = 50 min')
  assert.equal(L0({ capMin: 120, room: 66.5, rateFph: 3.5 }).leadMin, 60, '3.5 °F at 3.5 °F/h = exactly 60')
  // cooling mirror: room 80, target 74, rate 3 ⇒ 120 ⇒ the cap
  assert.deepEqual(optimumLead({ season: 'cooling', room: 80, target: 74, rateFph: 3, capMin: 60, baseLeadMin: 120 }), { leadMin: 60, source: 'learned', need: 6 })
  assert.deepEqual(optimumLead({ season: 'cooling', room: 74.5, target: 74, rateFph: 3, capMin: 60 }), { leadMin: 0, source: null, need: 0.5 })
})

test('snapshotParams / activeParams: freeze-at-TAKE', () => {
  const cfg = cfgDefault()
  const u = unitCfgOf(cfg)
  const us = unitWith({ heating: { deltaF: 4 } })
  const snap = snapshotParams(cfg, u, us, 'HEAT')
  assert.deepEqual(snap, {
    season: 'heating', deltaF: 4, leadMin: 120, clampF: { coolingMin: 65, heatingMax: 76 }, earliestStart: '04:30', suspended: false,
    source: 'tuned', deltaSource: 'tuned', leadSource: 'config',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'plain JSON')
  assert.notEqual(snap.clampF, cfg.precondition.clampF)
  const fan = snapshotParams(cfg, u, us, 'FAN')
  assert.equal(fan.season, null)
  assert.equal(fan.deltaF, 4, 'null season ⇒ the heating values (H5; same as tou fallback) — timing only, targets are {}')
  assert.equal(fan.source, 'tuned')
  assert.equal(snapshotParams(cfg, u, us, 'DRY').season, 'cooling')
  // addendum B F3.11 / C-11: an ON entry at peak overrides a suspension; C §1.3: decide may hand in the
  // resolved season (seasonFor — a follower's is the master's) in place of the mode's own
  const sus = unitWith({ suspended: { since: WED, changeId: 'x' } })
  assert.equal(snapshotParams(cfg, u, sus, 'HEAT').suspended, true)
  assert.equal(snapshotParams(cfg, u, sus, 'HEAT', { suspendedOverride: false }).suspended, false)
  const followed = snapshotParams(cfg, u, us, 'HEAT', { season: 'cooling' })
  assert.equal(followed.season, 'cooling')
  assert.equal(followed.deltaF, 3, 'the cooling parameters, not the tuned heating Δ')
  assert.equal(snapshotParams(cfg, u, us, 'HEAT', { season: null }).season, null, 'an explicit null season (master in Fan)')

  // owned: frozen params win over any later tuning/guardrail/base edit
  us.auto = { phase: 'precondition', eventId: `${WED}@07:00`, params: snap }
  us.tuning.heating.deltaF = 2
  cfg.optimizer.maxDeltaF = 3
  cfg.precondition.deltaF.heating = 6
  assert.equal(activeParams(cfg, u, us, { mode: 'HEAT' }), snap)
  assert.equal(activeParams(cfg, u, us, { mode: 'HEAT' }).deltaF, 4)
  // idle: live effective params for the live mode's season (fallback heating)
  us.auto = { phase: 'idle', eventId: null, params: null }
  assert.equal(activeParams(cfg, u, us, { mode: 'HEAT' }).deltaF, 2)
  assert.equal(activeParams(cfg, u, us, { mode: 'COOL' }).season, 'cooling')
  assert.equal(activeParams(cfg, u, us, null).season, 'heating')
  // the frozen window: tou with the snapshot keeps the TAKE-time lead even if tuning moved
  const ev = tou.events(cfg, tz, WED)[0]
  const frozen = snapshotParams(cfgDefault(), u, unitWith({ heating: { leadMin: 150 } }), 'HEAT')
  assert.equal(tou.preconditionWindow(cfg, tz, ev, 'heating', frozen).preStart, L(WED, '04:30'))
})

test('currentValue / dirOf / guardrails / preconditionPeakStartMin', () => {
  const cfg = cfgDefault()
  const us = unitWith({ heating: { deltaF: 5 } })
  assert.equal(currentValue(cfg, unitCfgOf(cfg), us, 'heating', 'deltaF'), 4, 'effective (clamped) value is the CAS truth')
  assert.equal(currentValue(cfg, unitCfgOf(cfg), us, 'heating', 'leadMin'), 120)
  assert.equal(currentValue(cfg, unitCfgOf(cfg), us, 'heating', 'suspended'), null)
  assert.equal(dirOf(3, 4), 'up')
  assert.equal(dirOf(150, 120), 'down')
  assert.equal(dirOf(3, 3), null)
  assert.equal(dirOf(null, 3), null)
  assert.deepEqual(guardrails(cfg), {
    minDeltaF: 1, maxDeltaF: 4, minLeadMin: 60, maxLeadMin: 150, earliestStart: '04:30', earliestStartMin: 270,
    peakStartMin: 420, maxStepDeltaF: 1, maxStepLeadMin: 30,
  })
  assert.equal(preconditionPeakStartMin(cfg), 420)
  const merged = cfgDefault()
  merged.tou.weekday = [
    { start: '06:30', end: '07:00', tier: 'peak' },
    { start: '07:00', end: '10:00', tier: 'peak', precondition: true },
    { start: '17:00', end: '20:00', tier: 'peak', precondition: true },
  ]
  assert.equal(preconditionPeakStartMin(merged), 390, 'merged event starts at its first window')
  const none = cfgDefault()
  none.tou.weekday[0].precondition = false
  assert.equal(preconditionPeakStartMin(none), null)
  assert.equal(guardrails(none).maxLeadMin, 150, 'default 07:00 peak when nothing pre-conditions')
  const g = guardrails({})
  assert.equal(g.maxDeltaF, 4)
  assert.equal(g.earliestStartMin, 270)
})

// ---- dates, observe ---------------------------------------------------------------------------------

test('nextApplyDate: today before earliestStart, else tomorrow (DST-safe)', () => {
  const cfg = cfgDefault()
  assert.equal(nextApplyDate(cfg, tz, L(WED, '00:00')), WED)
  assert.equal(nextApplyDate(cfg, tz, L(WED, '01:30')), WED)
  assert.equal(nextApplyDate(cfg, tz, L(WED, '04:29')), WED)
  assert.equal(nextApplyDate(cfg, tz, L(WED, '04:29') + 59999), WED)
  assert.equal(nextApplyDate(cfg, tz, L(WED, '04:30')), THU)
  assert.equal(nextApplyDate(cfg, tz, L(WED, '14:00')), THU)
  assert.equal(nextApplyDate(cfg, tz, L(WED, '23:59')), THU)
  cfg.optimizer.earliestStart = '05:00'
  assert.equal(nextApplyDate(cfg, tz, L(WED, '04:45')), WED)
  cfg.optimizer.earliestStart = '04:30'
  // DST days: 23 h and 25 h
  assert.equal(nextApplyDate(cfg, tz, Date.parse('2026-03-08T09:30:00Z')), '2026-03-08') // 01:30 PST
  assert.equal(nextApplyDate(cfg, tz, Date.parse('2026-03-08T10:00:00Z')), '2026-03-08') // 03:00 PDT
  assert.equal(nextApplyDate(cfg, tz, Date.parse('2026-11-01T08:30:00Z')), '2026-11-01') // first 01:30
  assert.equal(nextApplyDate(cfg, tz, Date.parse('2026-11-01T09:30:00Z')), '2026-11-01') // second 01:30
  assert.equal(nextApplyDate(cfg, tz, L('2026-11-01', '12:00')), '2026-11-02')
  assert.equal(nextApplyDate(cfg, tz, L('2026-12-31', '05:00')), '2027-01-01')
  // tz defaults from cfg.timezone when not injected; accepts ISO strings
  assert.equal(nextApplyDate(cfg, undefined, ISO(L(WED, '01:30'))), WED)
})

test('observeInfo: later of global/per-unit enable, liveFrom = date + observeDays + 1', () => {
  const cfg = cfgDefault()
  // enabled Wednesday afternoon ⇒ Thu/Fri/Sat observe, Sunday's run is the first that may change anything
  const state = { insights: { optimizerEnabledAt: ISO(L(WED, '15:00')) } }
  for (const [date, obs] of [[THU, true], [FRI, true], [SAT, true], [SUN, false]]) {
    const o = observeInfo({ cfg, state, unitState: unitWith(), tz, now: L(date, '01:30') })
    assert.equal(o.liveFrom, SUN)
    assert.equal(o.applyDate, date)
    assert.equal(o.observe, obs, date)
  }
  assert.equal(observeInfo({ cfg, state, unitState: unitWith(), tz, now: L(THU, '01:30') }).daysLeft, 3)
  assert.equal(observeInfo({ cfg, state, unitState: unitWith(), tz, now: L(SUN, '01:30') }).daysLeft, 0)
  // per-unit enabledAt later than the global one restarts observe for that unit
  const late = unitWith({ enabledAt: ISO(L(SAT, '09:00')) })
  const o2 = observeInfo({ cfg, state, unitState: late, tz, now: L(SUN, '01:30') })
  assert.equal(o2.liveFrom, '2026-09-30')
  assert.equal(o2.observe, true)
  // an older per-unit stamp does not hide a newer global re-enable
  const old = unitWith({ enabledAt: '2026-08-01T00:00:00Z' })
  assert.equal(observeInfo({ cfg, state, unitState: old, tz, now: L(FRI, '01:30') }).observe, true)
  // no enable timestamp at all ⇒ observing (conservative)
  const none = observeInfo({ cfg, state: { insights: {} }, unitState: unitWith(), tz, now: L(SUN, '01:30') })
  assert.equal(none.liveFrom, null)
  assert.equal(none.observe, true)
  // observeDays 0 ⇒ live from the day after enabling
  cfg.optimizer.observeDays = 0
  assert.equal(observeInfo({ cfg, state, unitState: unitWith(), tz, now: L(THU, '01:30') }).observe, false)
})

// ---- gate -------------------------------------------------------------------------------------------

test('gateOpen: closed in [preStart(max lead), peakEnd) and while owned; open at 01:30', () => {
  const cfg = cfgDefault()
  const u = unitCfgOf(cfg)
  const idle = unitWith()
  const g = (now, extra = {}) => gateOpen({ cfg, tz, unitCfg: u, unitState: idle, now, ...extra })
  assert.deepEqual(g(L(WED, '01:30')), { open: true, until: null, reason: null, eventId: null })
  assert.equal(g(L(WED, '04:59')).open, true)
  assert.deepEqual(g(L(WED, '05:00')), { open: false, until: L(WED, '10:00'), reason: 'precondition', eventId: `${WED}@07:00` })
  assert.equal(g(L(WED, '07:00')).reason, 'shed')
  assert.equal(g(L(WED, '09:59')).open, false)
  assert.equal(g(L(WED, '10:00')).open, true)
  assert.equal(g(L(WED, '16:59')).open, true, 'evening peak has no precondition')
  assert.deepEqual(g(L(WED, '17:30')), { open: false, until: L(WED, '20:00'), reason: 'shed', eventId: `${WED}@17:00` })
  assert.equal(g(L(WED, '20:00')).open, true)
  assert.equal(g(L(SAT, '08:00')).open, true, 'no events on weekends')
  // effMax = eff with max(old, new) leadMin: a tuned 150-min lead closes the gate from 04:30
  const effMax = effectivePrecondition(cfg, u, unitWith({ heating: { leadMin: 150 } }), 'heating')
  assert.equal(g(L(WED, '04:29'), { effMax }).open, true)
  assert.equal(g(L(WED, '04:30'), { effMax }).open, false)
  // without effMax both seasons' effective params are considered
  const coolTuned = unitWith({ cooling: { leadMin: 150 } })
  assert.equal(gateOpen({ cfg, tz, unitCfg: u, unitState: coolTuned, now: L(WED, '04:40') }).open, false)
  // suspension does not open the gate during the would-be precondition window (conservative)
  const susp = unitWith({ suspended: { since: WED, changeId: 'x' } })
  assert.equal(gateOpen({ cfg, tz, unitCfg: u, unitState: susp, now: L(WED, '05:30') }).open, false)
  // phase ≠ idle ⇒ closed, until the owned event's end (null once it is over)
  const owned = unitWith({}, { phase: 'shed', eventId: `${WED}@07:00`, params: null })
  assert.deepEqual(gateOpen({ cfg, tz, unitCfg: u, unitState: owned, now: L(WED, '08:00') }), { open: false, until: L(WED, '10:00'), reason: 'owned', eventId: `${WED}@07:00` })
  const restoring = unitWith({}, { phase: 'restoring', eventId: `${WED}@07:00`, params: null })
  assert.deepEqual(gateOpen({ cfg, tz, unitCfg: u, unitState: restoring, now: L(WED, '10:01') }), { open: false, until: null, reason: 'owned', eventId: `${WED}@07:00` })
  assert.equal(gateOpen({ cfg, tz, unitCfg: u, unitState: owned, now: L(WED, '01:30') }).open, false)
  // unit flags: no shed ⇒ never in an event; no precondition ⇒ only the peak itself
  assert.equal(gateOpen({ cfg, tz, unitCfg: { ...u, shed: false }, unitState: idle, now: L(WED, '08:00') }).open, true)
  assert.equal(gateOpen({ cfg, tz, unitCfg: { ...u, precondition: false }, unitState: idle, now: L(WED, '05:30') }).open, true)
  assert.equal(gateOpen({ cfg, tz, unitCfg: { ...u, precondition: false }, unitState: idle, now: L(WED, '07:30') }).open, false)
  // missing auto ⇒ idle
  assert.equal(gateOpen({ cfg, tz, unitCfg: u, unitState: {}, now: L(WED, '01:30') }).open, true)
  // DST: spring-forward Monday 2026-03-09 morning window still 05:00–10:00 local
  assert.equal(g(L('2026-03-09', '04:59')).open, true)
  assert.equal(g(L('2026-03-09', '05:00')).open, false)
})

// ---- check ------------------------------------------------------------------------------------------

test('check: ok path and every refusal code for an optimizer change', () => {
  const now = L(WED, '01:30')
  const run = (w, m = change(), extra = {}) => check(w.state.units.office, m, { cfg: w.cfg, state: w.state, now, tz, ...extra })
  assert.equal(run(world()), 'ok')

  // invalid
  assert.equal(run(world(), change({ kind: 'bogus' })), 'invalid')
  assert.equal(run(world(), change({ season: undefined })), 'invalid')
  assert.equal(run(world(), change({ param: 'fan' })), 'invalid')
  assert.equal(run(world(), change({ to: 3 })), 'invalid')
  assert.equal(run(world(), null), 'invalid')

  // not_enabled (G1)
  assert.equal(run(world({ cfgPatch: (c) => { c.optimizer.enabled = false } })), 'not_enabled')
  assert.equal(run(world({ cfgPatch: (c) => { c.optimizer.units.office.enabled = false } })), 'not_enabled')
  assert.equal(run(world({ cfgPatch: (c) => { c.units[1].precondition = false } })), 'not_enabled')
  assert.equal(run(world({ cfgPatch: (c) => { c.units[1].shed = false } })), 'not_enabled')
  assert.equal(run(world({ cfgPatch: (c) => { c.units = c.units.slice(0, 1) } })), 'not_enabled')
  assert.equal(run(world({ cfgPatch: (c) => { delete c.optimizer.units.office } })), 'ok', 'missing per-unit key = defaults (enabled)')

  // not_live (G2)
  assert.equal(run(world({ cfgPatch: (c) => { c.automation.mode = 'dry-run' } })), 'not_live')
  assert.equal(run(world({ scheduleEnabled: false })), 'not_live')
  const w0 = world()
  assert.equal(check(w0.office, change(), { cfg: w0.cfg, now, tz }), 'not_live', 'no state ⇒ not live')

  // observe
  assert.equal(run(world({ enabledAt: ISO(L(TUE, '15:00')) })), 'observe')
  assert.equal(run(world({ tuning: { enabledAt: ISO(L(TUE, '15:00')) } })), 'observe', 'per-unit enable restarts observe')
  assert.equal(run(world({ enabledAt: null })), 'observe', 'never enabled ⇒ observe')
  assert.equal(run(world({ enabledAt: ISO(L('2026-09-19', '15:00')) })), 'ok', 'Sat + 4 = Wed ⇒ live')

  // locked
  assert.equal(run(world({ tuning: { lockedDates: [WED] } })), 'locked')
  assert.equal(run(world({ tuning: { lockedDates: [THU] } })), 'ok')

  // already
  assert.equal(run(world({ tuning: { heating: { lastAnalysisDate: TUE } } })), 'already')
  assert.equal(run(world({ tuning: { cooling: { lastAnalysisDate: TUE } } })), 'ok', 'per season')

  // cooldown (direction + param specific; blocked while applyDate < value)
  assert.equal(run(world({ tuning: { cooldown: { 'heating.deltaF.up': THU } } })), 'cooldown')
  assert.equal(run(world({ tuning: { cooldown: { 'heating.deltaF.up': WED } } })), 'ok')
  assert.equal(run(world({ tuning: { cooldown: { 'heating.deltaF.down': THU } } })), 'ok')
  assert.equal(run(world({ tuning: { cooldown: { 'heating.leadMin.up': THU } } })), 'ok')

  // frozen (season + direction)
  assert.equal(run(world({ tuning: { frozen: { 'heating.up': '2026-10-05' } } })), 'frozen')
  assert.equal(run(world({ tuning: { frozen: { 'heating.down': '2026-10-05' } } })), 'ok')
  assert.equal(run(world({ tuning: { frozen: { 'cooling.up': '2026-10-05' } } })), 'ok')

  // guardrail (defence in depth at commit time)
  assert.equal(run(world({ cfgPatch: (c) => { c.optimizer.maxDeltaF = 3 } })), 'guardrail')
  assert.equal(run(world({ cfgPatch: (c) => { c.optimizer.maxDeltaF = 6 } }), change({ to: 5 })), 'guardrail', 'step > 1')
  assert.equal(run(world(), change({ param: 'leadMin', from: 120, to: 150 })), 'ok')
  assert.equal(run(world(), change({ param: 'leadMin', from: 120, to: 90 })), 'ok')
  assert.equal(run(world(), change({ param: 'leadMin', from: 120, to: 147 })), 'guardrail', '5-min grid')
  assert.equal(run(world(), change({ param: 'leadMin', from: 120, to: 160 })), 'guardrail', 'step > 30')
  assert.equal(run(world({ tuning: { heating: { leadMin: 150 } } }), change({ param: 'leadMin', from: 150, to: 180 })), 'guardrail', 'before earliestStart')
  assert.equal(run(world({ tuning: { heating: { leadMin: 60 } } }), change({ param: 'leadMin', from: 60, to: 30 })), 'guardrail', 'below minLeadMin')

  // superseded (CAS on the current effective value)
  assert.equal(run(world(), change({ from: 2, to: 3 })), 'superseded')
  assert.equal(run(world({ tuning: { heating: { deltaF: 4 } } })), 'superseded')
  assert.equal(run(world({ tuning: { heating: { deltaF: 5 } } }), change({ from: 4, to: 3 })), 'ok', 'clamped 5 → 4 is the current value')

  // order: the first failing gate wins
  assert.equal(run(world({ cfgPatch: (c) => { c.automation.mode = 'off' }, enabledAt: null })), 'not_live')
  assert.equal(run(world({ tuning: { lockedDates: [WED], heating: { lastAnalysisDate: TUE } } })), 'locked')
  assert.equal(run(world({ tuning: { heating: { lastAnalysisDate: TUE }, cooldown: { 'heating.deltaF.up': THU } } })), 'already')
  assert.equal(run(world({ tuning: { cooldown: { 'heating.deltaF.up': THU }, frozen: { 'heating.up': THU } } })), 'cooldown')
  assert.equal(run(world({ tuning: { frozen: { 'heating.up': THU } } }), change({ from: 2 })), 'frozen')

  // applyDate defaults to nextApplyDate(now): at 14:00 the change targets Thursday
  const w = world({ tuning: { lockedDates: [THU] } })
  assert.equal(check(w.office, change({ applyDate: undefined }), { cfg: w.cfg, state: w.state, now: L(WED, '14:00'), tz }), 'locked')
  // unit id resolved from ctx.unitId or by identity in state.units
  const w2 = world()
  const anon = change({ unit: undefined })
  assert.equal(check(w2.office, anon, { cfg: w2.cfg, state: w2.state, now, tz }), 'ok')
  assert.equal(check(w2.office, anon, { cfg: w2.cfg, state: w2.state, now, tz, unitId: 'kitchen' }), 'ok')
  assert.equal(check({ tuning: emptyTuning() }, anon, { cfg: w2.cfg, state: w2.state, now, tz }), 'not_enabled', 'unknown unit')
  // tz falls back to cfg.timezone
  assert.equal(check(w2.office, change(), { cfg: w2.cfg, state: w2.state, now }), 'ok')
  for (const code of ['not_enabled', 'not_live', 'observe', 'locked', 'already', 'cooldown', 'frozen', 'superseded', 'guardrail', 'invalid']) assert.ok(REFUSALS.includes(code))
})

test('check: suspend / resume / reset / revert / undo / cancel', () => {
  const now = L(WED, '01:30')
  const ctx = (w, extra = {}) => ({ cfg: w.cfg, state: w.state, now, tz, ...extra })
  const suspend = { kind: 'suspend', unit: 'office', id: 't_s', applyDate: WED, analysisDate: TUE }
  const resume = { kind: 'resume', unit: 'office', id: 't_r', applyDate: WED, analysisDate: TUE }
  let w = world()
  assert.equal(check(w.office, suspend, ctx(w)), 'ok')
  w = world({ tuning: { suspended: { since: MON, changeId: 't_0' } } })
  assert.equal(check(w.office, suspend, ctx(w)), 'state')
  assert.equal(check(w.office, resume, ctx(w)), 'ok')
  w = world()
  assert.equal(check(w.office, resume, ctx(w)), 'state')
  // suspend is optimizer-driven: observe/lock apply; resume is comfort-safe and bypasses them
  w = world({ enabledAt: ISO(L(TUE, '15:00')), tuning: { suspended: { since: MON, changeId: 't_0' } } })
  assert.equal(check(w.office, resume, ctx(w)), 'ok')
  w = world({ enabledAt: ISO(L(TUE, '15:00')) })
  assert.equal(check(w.office, suspend, ctx(w)), 'observe')
  w = world({ tuning: { lockedDates: [WED] } })
  assert.equal(check(w.office, suspend, ctx(w)), 'locked')

  // user/system kinds work with the optimizer off and in dry-run
  const off = world({
    cfgPatch: (c) => { c.optimizer.enabled = false; c.automation.mode = 'dry-run' },
    tuning: { heating: { deltaF: 4, history: [{ id: 't_1', param: 'deltaF', from: 3, to: 4, at: ISO(L(TUE, '01:30')) }] } },
  })
  assert.equal(check(off.office, { kind: 'reset', unit: 'office', season: 'heating' }, ctx(off)), 'ok')
  assert.equal(check(off.office, { kind: 'reset', unit: 'office' }, ctx(off)), 'ok')
  assert.equal(check(off.office, { kind: 'reset', unit: 'office', season: 'winter' }, ctx(off)), 'invalid')
  assert.equal(check(off.office, { kind: 'revert', unit: 'office', id: 't_1', season: 'heating' }, ctx(off)), 'ok')
  assert.equal(check(off.office, { kind: 'revert', unit: 'office', id: 't_1' }, ctx(off)), 'ok', 'season found from history')
  assert.equal(check(off.office, { kind: 'revert', unit: 'office', id: 't_1', season: 'cooling' }, ctx(off)), 'superseded')
  assert.equal(check(off.office, { kind: 'revert', unit: 'office', id: 't_1', from: 3 }, ctx(off)), 'superseded')
  assert.equal(check(off.office, { kind: 'revert', unit: 'office' }, ctx(off)), 'invalid')

  // cancel only matches the pending slot
  const p = world({ tuning: { pending: toPending(change({ id: 't_p' }), { now, reason: 'in event until 10:00 AM', actor: 'optimizer' }) } })
  assert.equal(check(p.office, { kind: 'cancel', id: 't_p' }, ctx(p)), 'ok')
  assert.equal(check(p.office, { kind: 'cancel', id: 't_x' }, ctx(p)), 'superseded')
  assert.equal(check(world().office, { kind: 'cancel', id: 't_p' }, ctx(world())), 'superseded')
  assert.deepEqual([...KINDS].sort(), ['cancel', 'change', 'reset', 'resume', 'revert', 'suspend', 'undo'])
})

// ---- applyMutation ---------------------------------------------------------------------------------

test('applyMutation: change shape, history cap, lastUpAt, pending handling', () => {
  const w = world()
  const t = w.office.tuning
  const now = L(WED, '01:30')
  assert.equal(check(w.office, change(), { cfg: w.cfg, state: w.state, now, tz }), 'ok')
  const sum = applyMutation(t, change(), now, { cfg: w.cfg, tz })
  assert.equal(sum.kind, 'change')
  assert.equal(sum.from, 3)
  assert.equal(sum.to, 4)
  assert.equal(t.heating.deltaF, 4)
  assert.equal(t.heating.leadMin, null)
  assert.equal(t.heating.setAt, ISO(now))
  assert.equal(t.heating.evidenceFrom, ISO(now))
  assert.equal(t.heating.lastAnalysisDate, TUE)
  assert.deepEqual(t.heating.history, [{ id: 't_1', param: 'deltaF', from: 3, fromRaw: null, to: 4, at: ISO(now), rule: 'R1_DELTA', applyDate: WED, analysisDate: TUE }], 'fromRaw: the stored value replaced (null = base)')
  assert.equal(t.lastUpAt, WED)
  assert.deepEqual(t.cooling, emptyTuning().cooling, 'other season untouched')
  assert.equal(effectivePrecondition(w.cfg, unitCfgOf(w.cfg), w.office, 'heating').deltaF, 4)
  // the same change cannot be applied twice (already + superseded)
  assert.equal(check(w.office, change(), { cfg: w.cfg, state: w.state, now, tz }), 'already')
  assert.equal(check(w.office, change({ analysisDate: WED, applyDate: THU }), { cfg: w.cfg, state: w.state, now, tz }), 'superseded')

  // a DOWN change does not move lastUpAt
  applyMutation(t, change({ id: 't_2', from: 4, to: 3, applyDate: THU, analysisDate: WED }), L(THU, '01:30'), { cfg: w.cfg, tz })
  assert.equal(t.lastUpAt, WED)
  assert.equal(t.heating.history[0].id, 't_2')
  // history keeps the newest 5
  for (let i = 3; i <= 9; i++) applyMutation(t, change({ id: `t_${i}`, from: i % 2 ? 3 : 4, to: i % 2 ? 4 : 3 }), now + i * 1000, { cfg: w.cfg, tz })
  assert.deepEqual(t.heating.history.map((h) => h.id), ['t_9', 't_8', 't_7', 't_6', 't_5'])

  // pending is cleared only when it IS this mutation
  t.pending = toPending(change({ id: 'p1' }), { now, reason: 'in event until 10:00 AM', actor: 'optimizer' })
  applyMutation(t, change({ id: 't_10', from: 4, to: 3 }), now + 20000, { cfg: w.cfg, tz })
  assert.equal(t.pending.id, 'p1', 'unrelated pending left for promotePending to re-check')
  applyMutation(t, change({ id: 'p1', from: 3, to: 4 }), now + 30000, { cfg: w.cfg, tz })
  assert.equal(t.pending, null)

  // malformed input throws (the mutator must not half-apply)
  assert.throws(() => applyMutation(null, change(), now), TypeError)
  assert.throws(() => applyMutation(emptyTuning(), { kind: 'change' }, now), TypeError)
  assert.throws(() => applyMutation(emptyTuning(), change(), 'not a time'), TypeError)
})

test('applyMutation: revert → lock + cooldown + undo window; undo restores exactly', () => {
  const w = world()
  const t = w.office.tuning
  const c = (m, now) => check(w.office, m, { cfg: w.cfg, state: w.state, now, tz })
  applyMutation(t, change(), L(WED, '01:30'), { cfg: w.cfg, tz })
  const before = structuredClone(t)

  // revert at 08:12 (M would gate it until 10:00; the mutation itself is date-driven)
  const at = L(WED, '10:12')
  const revert = { kind: 'revert', unit: 'office', id: 't_1', season: 'heating', applyDate: THU }
  assert.equal(c(revert, at), 'ok')
  const sum = applyMutation(t, revert, at, { cfg: w.cfg, tz })
  assert.equal(t.heating.deltaF, null, 'the change was made from the base: back to the base, not a tuned copy')
  assert.deepEqual([currentValue(w.cfg, unitCfgOf(w.cfg), w.office, 'heating', 'deltaF'), effectivePrecondition(w.cfg, unitCfgOf(w.cfg), w.office, 'heating').source], [3, 'config'])
  assert.deepEqual(t.heating.history, [])
  assert.equal(t.heating.evidenceFrom, ISO(at))
  assert.deepEqual(t.lockedDates, [THU])
  assert.deepEqual(t.cooldown, { 'heating.deltaF.up': SUN }, 'THU + revertCooldownDays(3)')
  assert.deepEqual(t.reverts, [{ at: ISO(at), season: 'heating', param: 'deltaF', dir: 'up' }])
  assert.equal(t.lastRevert.id, 't_1')
  assert.equal(t.lastRevert.from, 3)
  assert.equal(t.lastRevert.to, 4)
  assert.deepEqual(t.frozen, {})
  assert.equal(sum.lockedDate, THU)
  assert.equal(sum.cooldownKey, 'heating.deltaF.up')
  assert.equal(sum.cooldownUntil, SUN)
  assert.equal(sum.from, 4)
  assert.equal(sum.to, 3)
  // a second revert of the same change is superseded; the optimizer is locked for THU and UP is cooling down
  assert.equal(c(revert, at + 1000), 'superseded')
  const next = change({ id: 't_2', applyDate: THU, analysisDate: WED })
  assert.equal(c(next, L(THU, '01:30')), 'locked')
  assert.equal(c(change({ id: 't_2', applyDate: FRI, analysisDate: THU }), L(FRI, '01:30')), 'cooldown')
  assert.equal(c(change({ id: 't_2', applyDate: SUN, analysisDate: SAT }), L(SUN, '01:30')), 'ok', 'cooldown over')
  assert.equal(c(change({ id: 't_2', from: 3, to: 2, applyDate: FRI, analysisDate: THU }), L(FRI, '01:30')), 'ok', 'other direction allowed')

  // undo within 10 minutes
  const undo = { kind: 'undo', unit: 'office', id: 't_1' }
  assert.equal(c(undo, at + UNDO_WINDOW_MS + 1), 'expired')
  assert.equal(c({ ...undo, id: 't_x' }, at + 60000), 'superseded')
  // a gated undo is judged at its request (requestedAt), not at its promotion after the peak
  assert.equal(c({ ...undo, requestedAt: ISO(at + 5 * 60000) }, at + 5 * 3600000), 'ok', 'asked inside the window, promoted hours later')
  assert.equal(c({ ...undo, requestedAt: ISO(at + UNDO_WINDOW_MS + 1) }, at + 5 * 3600000), 'expired', 'asked after the window')
  assert.equal(c({ ...undo, requestedAt: 'not a time' }, at + UNDO_WINDOW_MS + 1), 'expired', 'unreadable requestedAt ⇒ now')
  assert.equal(c(undo, at + 5 * 60000), 'ok')
  applyMutation(t, undo, at + 5 * 60000, { cfg: w.cfg, tz })
  assert.equal(t.heating.deltaF, 4)
  assert.deepEqual(t.heating.history, before.heating.history, 'the same change is back on top (revertable again)')
  assert.deepEqual(t.lockedDates, [])
  assert.deepEqual(t.cooldown, {})
  assert.deepEqual(t.reverts, [])
  assert.equal(t.lastRevert, null)
  assert.equal(t.heating.evidenceFrom, ISO(at + 5 * 60000))
  assert.equal(c(undo, at + 6 * 60000), 'superseded', 'nothing left to undo')
  assert.equal(c(revert, at + 7 * 60000), 'ok', 'revertable again')

  // undo refused after a newer mutation
  applyMutation(t, revert, at + 8 * 60000, { cfg: w.cfg, tz })
  applyMutation(t, change({ id: 't_3', param: 'leadMin', from: 120, to: 150, applyDate: THU, analysisDate: WED }), at + 9 * 60000, { cfg: w.cfg, tz })
  assert.equal(t.lastRevert, null)
  assert.equal(c(undo, at + 9 * 60000 + 1000), 'superseded')
})

test('applyMutation: revert restores the RAW prior value — a base outside the guardrails is not read-time clamped; undo works', () => {
  const eff = (w, s = 'heating') => effectivePrecondition(w.cfg, unitCfgOf(w.cfg), w.office, s)
  const at = L(WED, '10:12')
  const cases = [
    { name: 'deltaF: base +5 above maxDeltaF 4', patch: (c) => { c.precondition.deltaF.heating = 5 }, param: 'deltaF', from: 5, to: 4 },
    { name: 'leadMin: base 45 below minLeadMin 60', patch: (c) => { c.precondition.leadMin.heating = 45 }, param: 'leadMin', from: 45, to: 75 },
  ]
  for (const k of cases) {
    const w = world({ cfgPatch: k.patch })
    const t = w.office.tuning
    const c = (m, now) => check(w.office, m, { cfg: w.cfg, state: w.state, now, tz })
    assert.deepEqual([eff(w)[k.param], eff(w).source], [k.from, 'config'], `${k.name}: the base itself is never clamped`)
    const m = change({ param: k.param, from: k.from, to: k.to })
    assert.equal(c(m, L(WED, '01:30')), 'ok', k.name)
    applyMutation(t, m, L(WED, '01:30'), { cfg: w.cfg, tz })
    assert.equal(currentValue(w.cfg, unitCfgOf(w.cfg), w.office, 'heating', k.param), k.to, k.name)
    const revert = { kind: 'revert', unit: 'office', id: 't_1', season: 'heating', applyDate: THU }
    assert.equal(c(revert, at), 'ok', k.name)
    applyMutation(t, revert, at, { cfg: w.cfg, tz })
    assert.deepEqual([eff(w)[k.param], eff(w).source, eff(w).clampedBy], [k.from, 'config', null], `${k.name}: the revert really restored the base`)
    assert.equal(t.heating[k.param], null, `${k.name}: back to the config base (null), not a tuned copy of it`)
    const undo = { kind: 'undo', unit: 'office', id: 't_1' }
    assert.equal(c(undo, at + 60000), 'ok', `${k.name}: Undo is not refused as superseded`)
    applyMutation(t, undo, at + 60000, { cfg: w.cfg, tz })
    assert.equal(t.heating[k.param], k.to, k.name)
    assert.equal(t.heating.history[0].id, 't_1', k.name)
    assert.equal(c(revert, at + 2 * 60000), 'ok', `${k.name}: revertable again`)
  }

  // a tuned prior value comes back exactly (raw), even while a tightened guardrail clamps it at read time
  const w = world({ tuning: { heating: { deltaF: 5 } } })
  const t = w.office.tuning
  assert.equal(eff(w).deltaF, 4, 'tuned 5 read-time clamped to maxDeltaF 4')
  applyMutation(t, change({ from: 4, to: 3 }), L(WED, '01:30'), { cfg: w.cfg, tz })
  applyMutation(t, { kind: 'revert', unit: 'office', id: 't_1', season: 'heating', applyDate: THU }, at, { cfg: w.cfg, tz })
  assert.equal(t.heating.deltaF, 5)
  assert.equal(check(w.office, { kind: 'undo', unit: 'office', id: 't_1' }, { cfg: w.cfg, state: w.state, now: at + 60000, tz }), 'ok')
  // a legacy history entry without fromRaw reverts to its (effective) `from`
  const legacy = world({ tuning: { heating: { deltaF: 4, history: [{ id: 't_0', param: 'deltaF', from: 3, to: 4, at: ISO(L(TUE, '01:30')) }] } } })
  applyMutation(legacy.office.tuning, { kind: 'revert', unit: 'office', id: 't_0', season: 'heating', applyDate: THU }, at, { cfg: legacy.cfg, tz })
  assert.equal(legacy.office.tuning.heating.deltaF, 3)
})

test('applyMutation: revert CAS — history[1] and changed values are superseded; lock only once', () => {
  const w = world()
  const t = w.office.tuning
  const c = (m, now) => check(w.office, m, { cfg: w.cfg, state: w.state, now, tz })
  applyMutation(t, change({ id: 't_1' }), L(MON, '01:30'), { cfg: w.cfg, tz })
  applyMutation(t, change({ id: 't_2', param: 'leadMin', from: 120, to: 150 }), L(TUE, '01:30'), { cfg: w.cfg, tz })
  assert.equal(c({ kind: 'revert', unit: 'office', id: 't_1', season: 'heating' }, L(TUE, '12:00')), 'superseded', 'history[1]')
  assert.equal(c({ kind: 'revert', unit: 'office', id: 't_2', season: 'heating' }, L(TUE, '12:00')), 'ok')
  // a guardrail edit that clamps the current value makes the change non-revertable ("value changed since")
  w.cfg.optimizer.minLeadMin = 60
  w.cfg.optimizer.earliestStart = '05:00'
  assert.equal(c({ kind: 'revert', unit: 'office', id: 't_2', season: 'heating' }, L(TUE, '12:00')), 'ok', 'earliestStart flags but does not rewrite leadMin')
  w.cfg.optimizer.minLeadMin = 180
  assert.equal(c({ kind: 'revert', unit: 'office', id: 't_2', season: 'heating' }, L(TUE, '12:00')), 'superseded')
  w.cfg.optimizer.minLeadMin = 60
  // an already-locked date is not duplicated and undo keeps the older lock
  t.lockedDates = [WED]
  applyMutation(t, { kind: 'revert', unit: 'office', id: 't_2', season: 'heating', applyDate: WED }, L(TUE, '12:00'), { cfg: w.cfg, tz })
  assert.deepEqual(t.lockedDates, [WED])
  applyMutation(t, { kind: 'undo', id: 't_2' }, L(TUE, '12:01'), { cfg: w.cfg, tz })
  assert.deepEqual(t.lockedDates, [WED], 'a lock that pre-dated the revert survives its undo')
})

test('applyMutation: second same-direction revert within 14 days freezes that direction', () => {
  const w = world()
  const t = w.office.tuning
  const ctx = { cfg: w.cfg, tz }
  applyMutation(t, change({ id: 't_1' }), L(MON, '01:30'), ctx)
  applyMutation(t, { kind: 'revert', id: 't_1', season: 'heating' }, L(MON, '12:00'), ctx)
  assert.deepEqual(t.frozen, {})
  applyMutation(t, change({ id: 't_2', param: 'leadMin', from: 120, to: 150, applyDate: FRI, analysisDate: THU }), L(FRI, '01:30'), ctx)
  const sum = applyMutation(t, { kind: 'revert', id: 't_2', season: 'heating' }, L(FRI, '12:00'), ctx)
  assert.deepEqual(t.frozen, { 'heating.up': '2026-10-09' }, 'FRI + 14')
  assert.equal(sum.frozenKey, 'heating.up')
  assert.equal(sum.frozenUntil, '2026-10-09')
  assert.equal(t.reverts.length, 2)
  // the freeze blocks UP changes of either parameter in that season (and only that season/direction)
  const c = (m, now) => check(w.office, m, { cfg: w.cfg, state: w.state, now, tz })
  const later = '2026-10-01'
  assert.equal(c(change({ id: 't_3', applyDate: later, analysisDate: '2026-09-30' }), L(later, '01:30')), 'frozen')
  assert.equal(c(change({ id: 't_3', from: 3, to: 2, applyDate: later, analysisDate: '2026-09-30' }), L(later, '01:30')), 'ok')
  assert.equal(c(change({ id: 't_3', season: 'cooling', applyDate: later, analysisDate: '2026-09-30' }), L(later, '01:30')), 'ok')
  assert.equal(c(change({ id: 't_3', applyDate: '2026-10-09', analysisDate: '2026-10-08' }), L('2026-10-09', '01:30')), 'ok', 'freeze over')
  // undo of the freezing revert lifts the freeze again
  applyMutation(t, { kind: 'undo', id: 't_2' }, L(FRI, '12:05'), ctx)
  assert.deepEqual(t.frozen, {})
  assert.equal(t.reverts.length, 1)
  // reverts older than 14 days do not count
  const w2 = world()
  const t2 = w2.office.tuning
  applyMutation(t2, change({ id: 'a' }), L('2026-09-01', '01:30'), ctx)
  applyMutation(t2, { kind: 'revert', id: 'a', season: 'heating' }, L('2026-09-01', '12:00'), ctx)
  applyMutation(t2, change({ id: 'b' }), L(WED, '01:30'), ctx)
  applyMutation(t2, { kind: 'revert', id: 'b', season: 'heating' }, L(WED, '12:00'), ctx)
  assert.deepEqual(t2.frozen, {})
})

test('applyMutation: reset / suspend / resume / cancel shapes', () => {
  const w = world({ tuning: { heating: { deltaF: 4, leadMin: 150, history: [{ id: 't_1', param: 'deltaF', from: 3, to: 4, at: ISO(L(TUE, '01:30')) }] }, cooling: { deltaF: 2 } } })
  const t = w.office.tuning
  const ctx = { cfg: w.cfg, tz }
  const now = L(WED, '12:00')
  let sum = applyMutation(t, { kind: 'reset', season: 'heating' }, now, ctx)
  assert.equal(t.heating.deltaF, null)
  assert.equal(t.heating.leadMin, null)
  assert.deepEqual(t.heating.history, [])
  assert.equal(t.heating.evidenceFrom, ISO(now))
  assert.equal(t.cooling.deltaF, 2, 'season-scoped reset')
  assert.deepEqual(t.lockedDates, [THU], 'locks nextApplyDate')
  assert.equal(sum.lockedDate, THU)
  assert.equal(effectivePrecondition(w.cfg, unitCfgOf(w.cfg), w.office, 'heating').source, 'config')

  t.suspended = { since: MON, changeId: 't_s' }
  applyMutation(t, { kind: 'reset', lock: false }, now + 1000, ctx)
  assert.equal(t.cooling.deltaF, null)
  assert.equal(t.suspended, null, 'a whole-unit reset also resumes')
  assert.deepEqual(t.lockedDates, [THU], 'lock:false adds no lock')

  sum = applyMutation(t, { kind: 'suspend', id: 't_s2', applyDate: WED, analysisDate: TUE }, now + 2000, ctx)
  assert.deepEqual(t.suspended, { since: WED, changeId: 't_s2' })
  assert.equal(t.heating.evidenceFrom, ISO(now + 2000))
  assert.equal(t.cooling.evidenceFrom, ISO(now + 2000))
  assert.equal(sum.param, 'suspended')
  assert.equal(effectivePrecondition(w.cfg, unitCfgOf(w.cfg), w.office, 'heating').suspended, true)
  applyMutation(t, { kind: 'resume', id: 't_r' }, now + 3000, ctx)
  assert.equal(t.suspended, null)

  t.pending = toPending({ kind: 'resume', id: 'p2' }, { now, reason: 'in event until 10:00 AM' })
  assert.equal(t.pending.param, 'suspended')
  applyMutation(t, { kind: 'cancel', id: 'other' }, now + 4000, ctx)
  assert.equal(t.pending.id, 'p2')
  applyMutation(t, { kind: 'cancel', id: 'p2' }, now + 5000, ctx)
  assert.equal(t.pending, null)
})

test("applyMutation: cancelling a pending change is that analysis date's decision (G6 already); nothing else moves", () => {
  const w = world()
  const t = w.office.tuning
  const now = L(WED, '05:30')
  const ctx = { cfg: w.cfg, state: w.state, now, tz }
  t.pending = toPending(change(), { now, reason: 'in event until 10:00 AM', actor: 'optimizer' })
  applyMutation(t, { kind: 'cancel', id: 'other' }, now + 1000, { cfg: w.cfg, tz })
  assert.equal(t.heating.lastAnalysisDate, null, 'a cancel of another id changes nothing')
  applyMutation(t, { kind: 'cancel', id: 't_1' }, now + 2000, { cfg: w.cfg, tz })
  assert.equal(t.pending, null)
  assert.equal(t.heating.lastAnalysisDate, TUE, 'the cancelled change took its analysis date')
  assert.equal(t.heating.deltaF, null, 'no value change')
  assert.deepEqual(t.heating.history, [])
  assert.equal(t.heating.setAt, null)
  assert.equal(t.heating.evidenceFrom, null, 'evidence not restarted')
  assert.equal(t.cooling.lastAnalysisDate, null, 'other season untouched')
  assert.equal(check(w.office, change(), ctx), 'already', 'the same change cannot come back for that date')
  assert.equal(check(w.office, change({ id: 't_2', analysisDate: WED, applyDate: THU }), ctx), 'ok', 'the next analysis date may propose again')

  // never moves lastAnalysisDate backwards; a non-change pending entry (suspend) takes no date
  t.heating.lastAnalysisDate = WED
  t.pending = toPending(change({ id: 't_old' }), { now })
  applyMutation(t, { kind: 'cancel', id: 't_old' }, now + 3000, { cfg: w.cfg, tz })
  assert.equal(t.heating.lastAnalysisDate, WED)
  t.pending = toPending({ kind: 'suspend', id: 't_s', season: null, applyDate: THU, analysisDate: THU }, { now })
  applyMutation(t, { kind: 'cancel', id: 't_s' }, now + 4000, { cfg: w.cfg, tz })
  assert.equal(t.pending, null)
  assert.equal(t.heating.lastAnalysisDate, WED)
  assert.equal(t.cooling.lastAnalysisDate, null)
})

test('applyMutation: a multi-season base reset (`seasons`) clears both seasons but never the suspension', () => {
  const w = world({ tuning: { heating: { deltaF: 4, history: [{ id: 't_1', param: 'deltaF', from: 3, fromRaw: null, to: 4, at: ISO(L(TUE, '01:30')) }] }, cooling: { deltaF: 2, leadMin: 90 }, suspended: { since: MON, changeId: 't_s' } } })
  const t = w.office.tuning
  const now = L(WED, '12:00')
  const m = { kind: 'reset', unit: 'office', id: 't_b', season: null, seasons: ['heating', 'cooling'], reason: 'base', lock: false }
  assert.equal(check(w.office, m, { cfg: w.cfg, state: w.state, now, tz }), 'ok')
  applyMutation(t, m, now, { cfg: w.cfg, tz })
  for (const s of ['heating', 'cooling']) {
    assert.equal(t[s].deltaF, null, s)
    assert.equal(t[s].leadMin, null, s)
    assert.deepEqual(t[s].history, [], s)
    assert.equal(t[s].evidenceFrom, ISO(now), s)
  }
  assert.deepEqual(t.suspended, { since: MON, changeId: 't_s' }, 'only a whole-unit reset (no season, no seasons) resumes')
  assert.deepEqual(t.lockedDates, [], 'lock:false adds no lock')
  assert.equal(check(w.office, { ...m, seasons: ['winter'] }, { cfg: w.cfg, state: w.state, now, tz }), 'invalid', 'seasons must name known seasons')
})

test('applyMutation: dates from the mutation when no cfg/tz is given', () => {
  const t = emptyTuning()
  applyMutation(t, change(), L(WED, '01:30'))
  applyMutation(t, { kind: 'revert', id: 't_1', season: 'heating', applyDate: THU, cooldownDays: 5, today: WED }, L(WED, '11:00'))
  assert.deepEqual(t.lockedDates, [THU])
  assert.deepEqual(t.cooldown, { 'heating.deltaF.up': '2026-09-29' })
})

test('toPending / pruneTuning / validateTuningCfg', () => {
  const now = L(WED, '05:30')
  assert.deepEqual(toPending(change(), { now, reason: 'in event until 10:00 AM', actor: 'optimizer' }), {
    id: 't_1', kind: 'change', season: 'heating', param: 'deltaF', from: 3, to: 4, applyDate: WED, analysisDate: TUE,
    rule: 'R1_DELTA', queuedAt: ISO(now), reason: 'in event until 10:00 AM', actor: 'optimizer',
  })

  const t = emptyTuning()
  t.lockedDates = ['2026-09-01', '2026-09-09', WED]
  t.reverts = [{ at: ISO(L('2026-09-08', '12:00')), season: 'heating', param: 'deltaF', dir: 'up' }, { at: ISO(L(TUE, '12:00')), season: 'heating', param: 'deltaF', dir: 'down' }]
  t.cooldown = { 'heating.deltaF.up': WED, 'heating.deltaF.down': FRI }
  t.frozen = { 'heating.up': '2026-09-20', 'cooling.down': '2026-10-01' }
  assert.equal(pruneTuning(t, WED, tz), true)
  assert.deepEqual(t.lockedDates, ['2026-09-09', WED])
  assert.equal(t.reverts.length, 1)
  assert.deepEqual(t.cooldown, { 'heating.deltaF.down': FRI })
  assert.deepEqual(t.frozen, { 'cooling.down': '2026-10-01' })
  assert.equal(pruneTuning(t, WED, tz), false, 'idempotent')
  assert.equal(pruneTuning(null, WED), false)

  assert.deepEqual(validateTuningCfg(cfgDefault()), [])
  const bad = cfgDefault()
  bad.optimizer.maxDeltaF = 7
  bad.optimizer.earliestStart = '06:30'
  const paths = validateTuningCfg(bad).map((e) => e.path)
  assert.ok(paths.includes('optimizer.maxDeltaF'))
  assert.ok(paths.includes('optimizer.earliestStart'))
})

// ---- the water season (reference-app Addendum G G1.10, G1.12; §2.2 §5.2) ---------------------------------------

const waterWorld = (patch) => world({
  cfgPatch: (c) => {
    c.precondition.deltaF.water = 15
    c.precondition.leadMin.water = 180
    c.water = { mixingValve: false, maxSetpointF: 140, minSetpointF: 110, comfortMinF: 105, differentialF: 8, preheatAllPeaks: true, earliestStart: '03:30', tune: { minDeltaF: 5, maxDeltaF: 25, stepDeltaF: 5 } }
    patch?.(c)
  },
})

test('water: the third season key — base Δ 15 / lead 180, the water guardrails, water.earliestStart; the room seasons untouched', () => {
  assert.deepEqual(SEASONS, ['heating', 'cooling'])
  assert.equal(WATER_SEASON, 'water')
  assert.deepEqual(ALL_SEASONS, ['heating', 'cooling', 'water'])
  const w = waterWorld()
  const u = unitCfgOf(w.cfg)
  const e = effectivePrecondition(w.cfg, u, w.office, 'water')
  assert.deepEqual([e.season, e.deltaF, e.leadMin, e.earliestStart, e.source], ['water', 15, 180, '03:30', 'config'])
  assert.deepEqual([effectivePrecondition(cfgDefault(), u, null, 'water').deltaF, effectivePrecondition(cfgDefault(), u, null, 'water').leadMin], [15, 180], 'defaults without the keys')
  const h = effectivePrecondition(w.cfg, u, w.office, 'heating')
  assert.deepEqual([h.season, h.deltaF, h.leadMin, h.earliestStart], ['heating', 3, 120, '04:30'])
  // tuned values clamp to the WATER guardrails (Δ 5–25), never the rooms' 1–4
  const t = { water: { deltaF: 30, leadMin: 300 } }
  const us = { auto: { phase: 'idle' }, tuning: { ...emptyTuning(), water: { deltaF: 30, leadMin: 300, history: [] } } }
  const hi = effectivePrecondition(w.cfg, u, us, 'water')
  assert.deepEqual([hi.deltaF, hi.leadMin, hi.clampedBy], [25, 240, 'maxDeltaF'])
  us.tuning.water = { deltaF: 2, leadMin: 150, history: [] }
  const lo = effectivePrecondition(w.cfg, u, us, 'water')
  assert.deepEqual([lo.deltaF, lo.clampedBy, lo.deltaSource], [5, 'minDeltaF', 'tuned'])
  assert.ok(t)
  // snapshotParams freezes the water season through the host's season
  const sp = snapshotParams(w.cfg, u, w.office, 'Heat Pump', { season: 'water' })
  assert.deepEqual([sp.season, sp.deltaF, sp.leadMin], ['water', 15, 180])
  const ap = activeParams(w.cfg, u, w.office, { mode: 'HEAT PUMP' }, { seasonOf: () => 'water' })
  assert.equal(ap.season, 'water')
})

test('water: guardrails(cfg, "water") — Δ 5–25 by 5, earliestStart 03:30, every peak pre-heats (the evening too)', () => {
  const w = waterWorld()
  const g = guardrails(w.cfg, 'water')
  assert.deepEqual([g.minDeltaF, g.maxDeltaF, g.maxStepDeltaF, g.earliestStart, g.peakStartMin], [5, 25, 5, '03:30', 420])
  assert.equal(g.maxLeadMin, 210, '07:00 − 03:30')
  assert.deepEqual([guardrails(w.cfg).minDeltaF, guardrails(w.cfg).maxDeltaF, guardrails(w.cfg).earliestStart], [1, 4, '04:30'], 'the rooms unchanged')
  const only17 = waterWorld((c) => { c.tou.weekday = c.tou.weekday.filter((r) => r.start !== '07:00') })
  assert.equal(guardrails(only17.cfg, 'water').peakStartMin, 17 * 60, 'preheatAllPeaks: the evening peak counts')
  assert.equal(preconditionPeakStartMin(only17.cfg), null, 'no flagged peak for the rooms')
  assert.equal(preconditionPeakStartMin(only17.cfg, { allPeaks: true }), 17 * 60)
})

test('water: check / applyMutation — a +5 step is ok, +10 is a guardrail; the water season is created on the first mutation; a whole-unit reset clears it', () => {
  const now = L(WED, '01:30')
  const w = waterWorld()
  const m = change({ season: 'water', from: 15, to: 20 })
  assert.equal(check(w.state.units.office, m, { cfg: w.cfg, state: w.state, now, tz }), 'ok')
  assert.equal(check(w.state.units.office, change({ season: 'water', from: 15, to: 25 }), { cfg: w.cfg, state: w.state, now, tz }), 'guardrail', 'one step is 5')
  assert.equal(check(w.state.units.office, change({ season: 'water', from: 15, to: 30 }), { cfg: w.cfg, state: w.state, now, tz }), 'guardrail')
  assert.equal(check(w.state.units.office, change({ season: 'water', from: 14, to: 19 }), { cfg: w.cfg, state: w.state, now, tz }), 'superseded')
  assert.equal(emptyTuning().water, undefined, 'a room never carries the water key')
  const tn = w.state.units.office.tuning
  applyMutation(tn, m, now, { cfg: w.cfg, tz })
  assert.equal(tn.water.deltaF, 20)
  assert.equal(tn.water.history[0].to, 20)
  assert.equal(effectivePrecondition(w.cfg, unitCfgOf(w.cfg), w.state.units.office, 'water').deltaF, 20)
  assert.deepEqual(mutationSeasons({ kind: 'reset', season: 'water' }), ['water'])
  normalizeTuning(tn)
  assert.equal(tn.water.deltaF, 20, 'normalize keeps it')
  applyMutation(tn, { kind: 'reset', id: 'r1' }, now, { cfg: w.cfg, tz })
  assert.equal(tn.water.deltaF, null, 'a whole-unit reset clears the water season too')
  assert.equal(check(w.state.units.office, { kind: 'reset', season: 'water' }, { cfg: w.cfg, state: w.state, now, tz }), 'ok')
})

test('water: gateOpen takes the host\'s seasons — a tank closes the gate from 04:00 (lead 180)', () => {
  const w = waterWorld()
  const u = unitCfgOf(w.cfg)
  const at = L(WED, '04:10')
  assert.equal(gateOpen({ cfg: w.cfg, tz, unitCfg: u, unitState: w.office, now: at }).open, true, 'the rooms: 05:00')
  const g = gateOpen({ cfg: w.cfg, tz, unitCfg: u, unitState: w.office, now: at, seasons: ['water'] })
  assert.deepEqual([g.open, g.reason], [false, 'precondition'])
})
