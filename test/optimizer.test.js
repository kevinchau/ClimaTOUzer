// test/optimizer.test.js — addendum §8.2 `optimizer.test.js`: table-driven decision tests run for
// heating AND the mirrored cooling case (one signed code path), the §5.5 worked-example Δ* vectors,
// evidence freshness, gates, an end-to-end check on real rollups (usage-gen → rollup.js → optimizer),
// and a seeded property suite over 2 000 contexts (+ its cooling mirror).
// Release 4.2 (Addendum F rule 10, D-check-6): a replanned episode is never E (qualifying / fresh).
// Release 4.3 (Addendum H, A §4.6/§5.4): an away episode is never E nor a realisation sample; the drift fit keeps it; a
// day away is no dormancy evidence.
//
// Mirror convention: every scenario is written in the heating view with comfort band 68–78 °F; the
// cooling twin reflects every room/outdoor temperature about 73 °F (T → 146 − T), flips HEAT → COOL and
// the drift sign, and uses clampF {heatingMax 76, coolingMin 70} (mirror images). The optimizer must
// then take the identical decision (same kind/param/from/to/rule/hold code).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as O from '../optimizer.js'
import * as tuning from '../tuning.js'
import { makeTz, addDays, hhmmToMin } from '../tz.js'
import { defaultConfig as coreDefaultConfig } from '../config.js'
import { rollupDay } from '../rollup.js'
import { genDays } from './helpers/usage-gen.js'
import { specDefaultConfig } from './helpers/config.js'

const tz = makeTz('America/Los_Angeles')
const C = 146 // mirror: T_cooling = 146 − T_heating (reflection about 73 °F)
const TODAY = '2026-10-22' // Thursday
const D = '2026-10-21' // Wednesday = analysisDate of a run on TODAY
const NOW = tz.zonedToInstant(TODAY, '01:30')
const ENABLED_AT = '2026-10-01T17:00:00.000Z'
const SEASONS = ['heating', 'cooling']
const WD = ['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-16', '2026-10-15'] // weekdays, newest first
const HOUR = 3600000
const DAY_MS = 86400000

const r6 = (x) => Math.round(x * 1e6) / 1e6
const R = (season, v) => (v == null ? v : season === 'cooling' ? r6(C - v) : v)
const near = (actual, expected, tol, msg = '') => assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected} ±${tol}, got ${actual}`)

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

// ───────────────────────────── fixtures ─────────────────────────────

/** The core's shipped defaults with the fixture units: 'office' is tuned, 'living-room' is the multi-split master. */
function defaultConfig() {
  return coreDefaultConfig({ units: [{ id: 'living-room', name: 'Living Room' }, { id: 'office', name: 'Office' }] })
}

function baseCfg(patch) {
  const cfg = defaultConfig()
  cfg.automation.mode = 'live'
  cfg.optimizer.enabled = true
  cfg.outdoor.enabled = true
  cfg.precondition.clampF = { coolingMin: 70, heatingMax: 76 } // mirror images about 73 °F
  if (typeof patch === 'function') patch(cfg)
  return cfg
}

/** One rollup Episode (rollup.js shape) from a heating-view spec, reflected for cooling. */
function ep(season, o) {
  const s = season === 'cooling' ? -1 : 1
  const at = o.at ?? '07:00'
  const morning = hhmmToMin(at) < 720
  const ps = tz.zonedToInstant(o.date, at) / 1000
  const boundary = o.kind === 'boundary' // addendum E: a weekend boundary episode — an empty peak, no shed, q pre_only
  const pe = boundary ? ps : ps + 3 * 3600
  const par = !morning || o.par === null ? null : { deltaF: o.par?.deltaF ?? 3, leadMin: o.par?.leadMin ?? 120 }
  const low = o.low ?? 69.5
  const high = o.high ?? 72
  const cls = o.cls ?? 'ok'
  const orig = o.orig ?? 70
  const d = par?.deltaF ?? 3
  const app = o.app ?? orig + (o.capped ? d - 1 : d)
  const pre = !par || o.pre === null ? null : {
    orig: R(season, orig), app: R(season, app), dApp: Math.abs(app - orig), capped: !!o.capped,
    T0: R(season, o.T0 ?? 69.8), Tpk: R(season, o.Tpk ?? 72.3), rise: 2.5, eff: o.eff === undefined ? 0.83 : o.eff,
    reached: o.reached ?? false, t90: 85, reachedMinBeforePeak: o.rmbp ?? 0, leadUsed: par.leadMin,
  }
  const tout = o.tout ?? 45
  const rBar = o.rBar ?? 70.5
  const b = o.b ?? -0.9
  const shed = o.shed === null || boundary ? null : {
    offAt: ps, end: pe, cov: o.cov ?? 0.95, rOff: R(season, 72),
    drift: { b: s * b, a: R(season, 72), n: 30, se: 0.05, r2: 0.9, cov: 0.9, dropped: 0, ok: o.driftOk ?? false },
    driftFph: s * b,
    Tmin: s > 0 ? low : R(season, high), Tmax: s > 0 ? high : R(season, low),
    m: o.m ?? Math.round((low - 68) * 100) / 100, violMin: o.violMin ?? (cls === 'violated' ? 30 : 0), class: cls,
    Tout: R(season, tout), rBar: R(season, rBar), gap: r6(R(season, rBar) - R(season, tout)), x: r6(tout - rBar),
    filled: false, flat: !!o.flat, jump: !!o.jump,
  }
  const overrides = (o.overrides ?? []).map((x) => {
    const f = x.f ?? 'power'
    const item = {
      t: ps + (x.min ?? 30) * 60, f,
      o: f === 'temp' ? R(season, x.o ?? 73) : (x.o ?? 'OFF'),
      v: f === 'temp' ? R(season, x.v ?? 75) : (x.v ?? 'ON'),
      s: x.s ?? 'external', ty: 'change', comfortDir: x.comfortDir ?? true, auto: !!x.auto,
    }
    if (x.gap != null) item.gap = x.gap
    return item
  })
  const status = o.status ?? 'done'
  return {
    ev: `${o.date}@${at}`, date: o.date, unit: 'office', ...(o.kind ? { kind: o.kind } : {}), peakStart: ps, peakEnd: pe, precondition: o.precondition ?? morning,
    preStart: par ? ps - par.leadMin * 60 : null, status, season: o.season === undefined ? season : o.season, par,
    dryRun: !!o.dryRun, preSkipped: o.preSkipped ?? null, preFromOff: !!o.preFromOff, ...(o.replanned ? { replanned: true } : {}), ...(o.away ? { away: o.away } : {}), pre, shed, rec: null,
    released: status === 'released' ? { t: ps + 1800, by: 'external', f: 'power', v: 'ON' } : null,
    overrides, jobs: { retries: 0, failing: o.failing ?? 0, blocked: o.blocked ?? 0 }, q: o.q ?? (o.dryRun ? 'dry' : o.away ? 'away' : boundary ? 'pre_only' : 'ok'),
    // addendum C C6.1: forced intervals given as [{mode, sameSeason?, fromMin?, untilMin?}] minutes after preStart
    forced: (o.forced ?? []).map((f) => ({
      from: (par ? ps - par.leadMin * 60 : ps) + (f.fromMin ?? 30) * 60, until: (par ? ps - par.leadMin * 60 : ps) + (f.untilMin ?? 150) * 60,
      mode: f.mode, by: f.by ?? 'living-room', kind: f.kind ?? 'rewrite', sameSeason: !!f.sameSeason,
    })),
  }
}

/** modeMin in the heating view {main, opp, FAN} → season modes. */
function modeMinFor(season, mm) {
  const main = season === 'cooling' ? 'COOL' : 'HEAT'
  const opp = season === 'cooling' ? 'HEAT' : 'COOL'
  const out = {}
  for (const [k, v] of Object.entries(mm)) out[k === 'main' ? main : k === 'opp' ? opp : k] = v
  return out
}

function mkRollups(season, eps, { days = {}, end = D, n = 45 } = {}) {
  const out = {}
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(end, -i)
    const dd = days[d] ?? {}
    const on = dd.on ?? 300
    out[d] = {
      v: 1, date: d, complete: true,
      units: { office: { id: 'office', coverage: dd.cov ?? 0.95, onMin: { peak: 0, off_peak: 0, super_off_peak: on, total: on }, modeMin: modeMinFor(season, dd.modeMin ?? (on > 0 ? { main: on } : {})), episodes: [], ...(dd.away ? { away: [{ mode: dd.away, from: tz.zonedToInstant(d, '00:00') / 1000, until: tz.zonedToInstant(addDays(d, 1), '00:00') / 1000 }] } : {}) } },
    }
  }
  for (const e of eps) if (out[e.date]) out[e.date].units.office.episodes.push(e)
  return out
}

/** Hourly forecast (Open-Meteo shape via weather.forecast): heating-view °F, 48 h from TODAY 00:00. */
function mkForecast(season, { temp, agoH = 1, until = null, from = TODAY }, now) {
  const hourly = []
  const t0 = tz.zonedToInstant(from, '00:00')
  const stop = until ? tz.zonedToInstant(from, until) : t0 + 48 * HOUR
  for (let t = t0; t <= stop; t += HOUR) hourly.push({ t: t / 1000, f: R(season, typeof temp === 'function' ? temp(t) : temp) })
  return { fetchedAt: new Date(now - agoH * HOUR).toISOString(), hourly }
}

function mkCtx(season, o = {}) {
  const cfg = baseCfg(o.cfg)
  const unitCfg = cfg.units.find((u) => u.id === 'office')
  const t = tuning.emptyTuning()
  if (o.tuning) o.tuning(t, season)
  const now = o.now ?? NOW
  const state = {
    scheduleEnabled: o.scheduleEnabled ?? true,
    insights: { optimizerEnabledAt: o.enabledAt === undefined ? ENABLED_AT : o.enabledAt },
    units: { office: { tuning: t, auto: { phase: 'idle' } } },
  }
  const eps = (o.eps ?? []).map((spec) => ep(season, spec))
  const rollups = mkRollups(season, eps, { days: o.days, end: o.end ?? addDays(tz.localParts(now).date, -1) })
  const forecast = o.forecast == null ? null : mkForecast(season, o.forecast, now)
  return { cfg, unitCfg, unitState: state.units.office, state, rollups, forecast, now, tz }
}

function decision(r) {
  return {
    mode: r.mode,
    hold: r.hold?.code ?? null,
    kind: r.change?.kind ?? null,
    param: r.change?.param ?? null,
    from: r.change?.from ?? null,
    to: r.change?.to ?? null,
    rule: r.change?.rule ?? null,
  }
}

const CHANGE = (param, from, to, rule, mode = 'change') => ({ mode, hold: null, kind: 'change', param, from, to, rule })
const HOLD = (code, mode = 'hold') => ({ mode, hold: code, kind: null, param: null, from: null, to: null, rule: null })

/** Run a heating-view scenario for heating and the mirrored cooling case; both must decide `expected`. */
function both(name, spec, expected, extra) {
  for (const season of SEASONS) {
    test(`${name} [${season}]`, () => {
      const ctx = mkCtx(season, typeof spec === 'function' ? spec(season) : spec)
      const r = O.proposeFor(ctx)
      assert.deepEqual(decision(r), expected, JSON.stringify(r.hold ?? r.change?.rationale))
      if (extra) extra(r, ctx, season)
    })
  }
}

const breach = (o = {}) => ({ date: D, cls: 'violated', low: 66.5, reached: true, eff: 0.9, ...o })
const comfy = (date, o = {}) => ({ date, cls: 'comfortable', low: 70.5, high: 73, m: 2.5, cov: 0.95, reached: true, ...o })
const okEp = (date, o = {}) => ({ date, cls: 'ok', low: 69.5, m: 1.5, reached: true, ...o })

// Drift-model episodes: evening peaks (no precondition ⇒ never evidence), x = tout − 70, y = α + β·x exactly.
const ALPHA = -0.05
const BETA = 0.03
const modelEps = (alpha = ALPHA, beta = BETA, touts = [35, 38, 41, 44, 47, 50]) =>
  touts.map((tout, i) => ({ date: addDays('2026-10-05', i), at: '17:00', tout, rBar: 70, b: alpha + beta * (tout - 70), driftOk: true }))
// Mornings with T0 = 70 and eff = 0.8 ⇒ zPre = 70, eff̂ = 0.8 (the §5.5 worked example).
const r3Mornings = (cls = 'ok', o = {}) => WD.slice(0, 3).map((date) => ({ date, cls, low: cls === 'comfortable' ? 70.5 : 69.5, m: cls === 'comfortable' ? 2.5 : 1.5, T0: 70, eff: 0.8, reached: true, tout: 45, ...o }))

// ───────────────────────────── §5.5 closed form ─────────────────────────────

describe('requiredDelta — §5.5 worked examples (closed form by hand)', () => {
  const model = { alpha: ALPHA, beta: BETA }
  const g = { minDeltaF: 1, maxDeltaF: 4 }
  const base = { model, season: 'heating', band: [68, 78], marginF: 1, hours: 3, zPre: 70, effHat: 0.8, guardrails: g }

  test('heating, forecast 36 °F ⇒ z0Req 72.27, Δ* 2.83 ⇒ +3', () => {
    const r = O.requiredDelta({ ...base, forecastXOut: 36 })
    const zInf = 36 + ALPHA / BETA
    const z0 = zInf + (69 - zInf) * Math.exp(BETA * 3)
    near(r.z0Req, z0, 1e-9)
    near(r.z0Req, 72.27, 0.01)
    near(r.deltaStar, 2.83, 0.01)
    assert.equal(r.deltaInt, 3)
  })

  test('heating, forecast 28 °F ⇒ z0Req 73.02, Δ* 3.78 ⇒ +4', () => {
    const r = O.requiredDelta({ ...base, forecastXOut: 28, curDeltaF: 3 })
    near(r.z0Req, 73.02, 0.01)
    near(r.deltaStar, 3.78, 0.01)
    assert.equal(r.deltaInt, 4)
    // predicted room at 10:00 with the current +3°: z0 = 70 + 0.8·3, relaxing toward z∞ for 3 h
    const zInf = 28 + ALPHA / BETA
    near(r.predEnd, zInf + (72.4 - zInf) * Math.exp(-BETA * 3), 1e-9)
    assert.ok(r.predEnd < 69, 'at +3° the room ends below the 69° target')
  })

  test('cooling vector of §5.5 (s = −1, H 78, forecast 95 °F, α +0.05, β 0.03, room 76) by hand', () => {
    const r = O.requiredDelta({ model: { alpha: 0.05, beta: 0.03 }, forecastXOut: -95, season: 'cooling', band: [68, 78], marginF: 1, hours: 3, zPre: -76, effHat: 0.8, guardrails: g })
    const zTarget = -78 + 1
    const zInf = -95 + 0.05 / 0.03
    const z0Req = zInf + (zTarget - zInf) * Math.exp(0.09)
    near(r.z0Req, z0Req, 1e-9)
    near(r.z0Req, -75.46, 0.01)
    near(r.deltaStar, (z0Req + 76) / 0.8, 1e-9)
    assert.equal(r.deltaInt, Math.max(1, Math.ceil((z0Req + 76) / 0.8 - 0.25)))
  })

  test('exact cooling mirror of the heating vectors yields the identical Δ*', () => {
    for (const f of [36, 28]) {
      const h = O.requiredDelta({ ...base, forecastXOut: f, curDeltaF: 3 })
      const c = O.requiredDelta({ ...base, season: 'cooling', forecastXOut: -(C - f), zPre: -(C - 70), curDeltaF: 3 })
      near(c.deltaStar, h.deltaStar, 1e-9)
      assert.equal(c.deltaInt, h.deltaInt)
      near(c.predEnd, C - h.predEnd, 1e-9) // room °F, reflected
    }
  })

  test('β < 0.01 uses the linear form; Δ*int clamps to the guardrails', () => {
    const r = O.requiredDelta({ ...base, model: { alpha: -0.5, beta: 0.005 }, forecastXOut: 36 })
    near(r.z0Req, 69 - (-0.5 + 0.005 * (36 - 69)) * 3, 1e-9)
    const hot = O.requiredDelta({ ...base, forecastXOut: 90 })
    assert.equal(hot.deltaInt, 1)
    const cold = O.requiredDelta({ ...base, forecastXOut: -20 })
    assert.equal(cold.deltaInt, 4)
    // the veto compares the UNCLAMPED requirement: Δ* < 0 must not read as "minDeltaF is still needed"
    assert.equal(hot.deltaCeil, Math.ceil(hot.deltaStar - 0.25))
    assert.ok(hot.deltaCeil < 1, `hot deltaCeil ${hot.deltaCeil}`)
    assert.equal(cold.deltaCeil, Math.ceil(cold.deltaStar - 0.25))
    assert.ok(cold.deltaCeil > 4, `cold deltaCeil ${cold.deltaCeil}`)
    assert.equal(O.requiredDelta({ ...base, model: null, forecastXOut: 20 }), null)
    assert.equal(O.requiredDelta({ ...base, zPre: null, forecastXOut: 20 }), null)
  })
})

// ───────────────────────────── drift model ─────────────────────────────

describe('fitDriftModel — confidence gates (§5.5)', () => {
  const eps = (list, season = 'heating') => list.map((s) => ep(season, s))
  test('exact y = α + βx over 6 points ⇒ confident ols with α, β recovered', () => {
    const m = O.fitDriftModel(eps(modelEps()))
    assert.equal(m.kind, 'ols')
    assert.equal(m.confident, true)
    assert.equal(m.n, 6)
    near(m.alpha, ALPHA, 1e-9)
    near(m.beta, BETA, 1e-9)
    near(m.r2, 1, 1e-9)
    assert.ok(m.sigmaX >= 2)
    // the cooling mirror recovers the same α, β (y = s·b, x = s·(Tout − r̄))
    const mc = O.fitDriftModel(eps(modelEps(), 'cooling'))
    near(mc.alpha, ALPHA, 1e-9)
    near(mc.beta, BETA, 1e-9)
  })
  test('n < 5 ⇒ not confident (kind none)', () => {
    const m = O.fitDriftModel(eps(modelEps().slice(0, 4)))
    assert.equal(m.confident, false)
    assert.equal(m.kind, 'none')
    assert.equal(m.n, 4)
  })
  test('β ≤ 0 ⇒ not confident', () => {
    const m = O.fitDriftModel(eps(modelEps(-0.5, -0.03)))
    assert.ok(m.beta < 0)
    assert.equal(m.confident, false)
  })
  test('R² < 0.3 ⇒ not confident', () => {
    const noisy = modelEps().map((s, i) => ({ ...s, b: s.b + (i % 2 ? 1.5 : -1.5) }))
    const m = O.fitDriftModel(eps(noisy))
    assert.ok(m.r2 < 0.3)
    assert.equal(m.confident, false)
  })
  test('σx < 2 ⇒ not confident', () => {
    const m = O.fitDriftModel(eps(modelEps(ALPHA, BETA, [44, 44.5, 45, 45.5, 46, 46.5])))
    assert.ok(m.sigmaX < 2)
    assert.equal(m.confident, false)
  })
  test('excludes drift not ok, flat, jump and dry-run episodes', () => {
    const base = modelEps()
    const bad = [
      { date: '2026-10-13', at: '17:00', tout: 20, rBar: 70, b: 5, driftOk: false },
      { date: '2026-10-14', at: '17:00', tout: 20, rBar: 70, b: 5, driftOk: true, flat: true },
      { date: '2026-10-15', at: '17:00', tout: 20, rBar: 70, b: 5, driftOk: true, jump: true },
      { date: '2026-10-16', at: '17:00', tout: 20, rBar: 70, b: 5, driftOk: true, dryRun: true },
    ]
    const m = O.fitDriftModel(eps([...base, ...bad]))
    assert.equal(m.n, 6)
    near(m.beta, BETA, 1e-9)
  })
})

// ───────────────────────────── decision table (heating + mirrored cooling) ─────────────────────────────

describe('R1 breach ⇒ UP (§5.6, §5.7)', () => {
  both('violated latest fresh episode ⇒ +1 Δ', { eps: [breach()] }, CHANGE('deltaF', 3, 4, 'R1_DELTA'))
  both('released by a comfort-direction override during the shed ⇒ +1 Δ',
    { eps: [okEp(D, { status: 'released', overrides: [{ f: 'power', v: 'ON', min: 40 }] })] }, CHANGE('deltaF', 3, 4, 'R1_DELTA'))
  both('released by an `auto` (HomeKit-pattern) override is not counted', { eps: [okEp(D, { status: 'released', overrides: [{ f: 'power', v: 'ON', min: 40, auto: true }] })] }, HOLD('need_n'))
  both('!reached ∧ eff < 0.6 ⇒ start 30 min earlier', { eps: [breach({ reached: false, eff: 0.5 })] }, CHANGE('leadMin', 120, 150, 'R1_LEAD'))
  both('at max Δ ⇒ lead instead',
    { eps: [breach({ par: { deltaF: 4 } })], tuning: (t, s) => { t[s].deltaF = 4 } }, CHANGE('leadMin', 120, 150, 'R1_LEAD'))
  both('capped TAKE counts as Δ at limit ⇒ lead', { eps: [breach({ capped: true })] }, CHANGE('leadMin', 120, 150, 'R1_LEAD'))
  both('setpoint guard (orig 73 + 3 + 1 > heatingMax 76) ⇒ lead', { eps: [breach({ orig: 73 })] }, CHANGE('leadMin', 120, 150, 'R1_LEAD'))
  both('at every limit ⇒ hold at_limit + suggestion',
    { eps: [breach({ par: { deltaF: 4, leadMin: 150 } })], tuning: (t, s) => { t[s].deltaF = 4; t[s].leadMin = 150 } },
    HOLD('at_limit'),
    (r, ctx, season) => {
      assert.ok(r.suggestion && /at maximum pre-(heat|cool)/.test(r.suggestion.text))
      if (season === 'heating') assert.equal(r.suggestion.text, 'Office still drops to 66.5° at maximum pre-heat. Raise the max, widen the band, or opt Office out of the morning shed.')
      else assert.equal(r.suggestion.text, 'Office still rises to 79.5° at maximum pre-cool. Raise the max, widen the band, or opt Office out of the morning shed.')
    })
  both('lead step respects maxStepLeadMin and earliestStart (05:00 ⇒ max lead 120)',
    { eps: [breach({ reached: false, eff: 0.4, par: { deltaF: 4 } })], tuning: (t, s) => { t[s].deltaF = 4 }, cfg: (c) => { c.optimizer.earliestStart = '05:00' } },
    HOLD('at_limit'))
  both('maxStepLeadMin 15 ⇒ +15 min', { eps: [breach({ reached: false, eff: 0.4 })], cfg: (c) => { c.optimizer.maxStepLeadMin = 15 } }, CHANGE('leadMin', 120, 135, 'R1_LEAD'))
  both('flat/jump sensor (G4) never blocks UP', { eps: [breach({ flat: true }), okEp(WD[1], { jump: true }), okEp(WD[2], { flat: true })] }, CHANGE('deltaF', 3, 4, 'R1_DELTA'))
  both('a base Δ above the guardrail max, lead at its max ⇒ at_limit',
    { eps: [breach({ par: { deltaF: 5, leadMin: 150 } })], cfg: (c) => { c.precondition.deltaF = { heating: 5, cooling: 5 }; c.precondition.leadMin = { heating: 150, cooling: 150 } } },
    HOLD('at_limit'))
  both('a base Δ below minDeltaF: +1 lands outside the guardrails and clampStep cancels ⇒ guardrail mode',
    { eps: [breach({ par: { deltaF: 1 } })], cfg: (c) => { c.optimizer.minDeltaF = 3; c.precondition.deltaF = { heating: 1, cooling: 1 } } },
    HOLD('guardrail', 'guardrail'))
})

describe('R5 comfort overrides ⇒ UP', () => {
  const ov = (o = {}) => ({ f: 'power', v: 'ON', s: 'external', min: 60, ...o })
  both('comfort overrides on 2 distinct fresh days ⇒ +1 Δ (R5)',
    { eps: [okEp(WD[0], { overrides: [ov()] }), okEp(WD[1], { overrides: [ov({ f: 'temp', o: 73, v: 75, s: 'user' })] }), okEp(WD[2])] },
    CHANGE('deltaF', 3, 4, 'R5'),
    (r, ctx, season) => {
      assert.equal(r.change.evidence.overrideDays, 2)
      // mixed sources (Apple Home + dashboard) ⇒ no "(via …)" suffix
      if (season === 'heating') assert.equal(r.change.rationale, "Office was turned back on during 2 of the last 3 morning peaks. Treating that as 'too cold': +3° → +4°.")
    })
  both('two overrides on the same day are one day ⇒ no R5', { eps: [okEp(WD[0], { overrides: [ov(), ov({ min: 90 })] }), okEp(WD[1])] }, HOLD('need_n'))
  both('`auto` overrides are surfaced, not counted', { eps: [okEp(WD[0], { overrides: [ov({ auto: true })] }), okEp(WD[1], { overrides: [ov({ auto: true })] })] }, HOLD('need_n'))
  both('fan/vane-only changes (comfortDir false) are ignored', { eps: [okEp(WD[0], { overrides: [ov({ f: 'fan', comfortDir: false })] }), okEp(WD[1], { overrides: [ov({ f: 'fan', comfortDir: false })] })] }, HOLD('need_n'))
  both('`gap`-flagged overrides are ignored', { eps: [okEp(WD[0], { overrides: [ov({ gap: 420 })] }), okEp(WD[1], { overrides: [ov({ gap: 420 })] })] }, HOLD('need_n'))
  both('overrides on stale (non-fresh) episodes do not count',
    { eps: [okEp(WD[0], { overrides: [ov()] }), okEp(WD[1], { overrides: [ov()], par: { deltaF: 2 } })] }, HOLD('need_n'))
  both('R5 at every limit ⇒ at_limit suggestion names the overrides, not a breach',
    { eps: [okEp(WD[0], { overrides: [ov()], par: { deltaF: 4, leadMin: 150 } }), okEp(WD[1], { overrides: [ov()], par: { deltaF: 4, leadMin: 150 } })], tuning: (t, s) => { t[s].deltaF = 4; t[s].leadMin = 150 } },
    HOLD('at_limit'),
    (r, ctx, season) => {
      assert.equal(r.signals.R5, true)
      assert.doesNotMatch(r.suggestion.text, /drops to|rises to/)
      const noun = season === 'heating' ? 'pre-heat' : 'pre-cool'
      assert.equal(r.suggestion.text, `Office keeps being turned back on during the peak, but maximum ${noun} is reached. Raise the max, widen the band, or opt Office out of the morning shed.`)
    })
  both('R1 wins the rationale over R5',{ eps: [breach({ overrides: [ov()] }), okEp(WD[1], { overrides: [ov()] })] }, CHANGE('deltaF', 3, 4, 'R1_DELTA'))
})

describe('R3 forecast ⇒ UP by one step, or veto a DOWN', () => {
  both('confident model + forecast 28 °F (colder than any handled morning) ⇒ +1 Δ',
    { eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 28 } },
    CHANGE('deltaF', 3, 4, 'R3'),
    (r, ctx, season) => {
      assert.equal(r.model.confident, true)
      near(r.change.evidence.deltaStar, 3.77, 0.01)
      assert.equal(r.change.evidence.forecastPeakF, R(season, 28))
      if (season === 'heating') assert.equal(r.change.rationale, "Today 7–10 AM forecast is 28°F, colder than any recent morning. At +3° the model predicts 68.4° by 10:00, so +4°.")
    })
  both('forecast 36 °F ⇒ Δ*int = +3 = current ⇒ no R3 (need_n)', { eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 36 } }, HOLD('need_n'))
  both('R3 silent when the forecast is no colder than a fresh comfortable morning',
    { eps: [...r3Mornings('ok', { tout: 29 }), ...modelEps()], forecast: { temp: 28 } }, HOLD('need_n'))
  both('model not confident (n < 5) ⇒ R3 off', { eps: [...r3Mornings(), ...modelEps().slice(0, 4)], forecast: { temp: 20 } }, HOLD('need_n'))
  both('model not confident (β ≤ 0) ⇒ R3 off', { eps: [...r3Mornings(), ...modelEps(-1, -0.02)], forecast: { temp: 10 } }, HOLD('need_n'))
  both('stale forecast (fetched 7 h ago) ⇒ R3 off', { eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 28, agoH: 7 } }, HOLD('need_n'))
  both('forecast not covering 7–10 AM ⇒ R3 off', { eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 28, until: '09:00' } }, HOLD('need_n'))
  for (const [label, fmt] of [['ms', (t) => t * 1000], ['zoned ISO', (t) => new Date(t * 1000).toISOString()]]) {
    both(`forecast timestamps as ${label} are accepted`, (season) => ({ eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 28 } }), CHANGE('deltaF', 3, 4, 'R3'), (r, ctx) => {
      const fc = { ...ctx.forecast, hourly: ctx.forecast.hourly.map((p) => ({ ...p, t: fmt(p.t) })) }
      assert.deepEqual(decision(O.proposeFor({ ...ctx, forecast: fc })), CHANGE('deltaF', 3, 4, 'R3'))
      const naive = { ...ctx.forecast, hourly: ctx.forecast.hourly.map((p) => ({ ...p, t: new Date(p.t * 1000).toISOString().slice(0, 16) })) }
      assert.equal(O.proposeFor({ ...ctx, forecast: naive }).change, null, 'zone-less local ISO is ambiguous ⇒ unusable')
    })
  }
  both('outdoor disabled ⇒ R3 off', { eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 28 }, cfg: (c) => { c.outdoor.enabled = false } }, HOLD('need_n'))
  both('3 comfortable mornings + forecast still needing +3 ⇒ veto (no DOWN)', { eps: [...r3Mornings('comfortable'), ...modelEps()], forecast: { temp: 36 } }, HOLD('veto'))
  // The veto uses the unclamped ceil(Δ* − 0.25): Δ*int is clamped UP to minDeltaF, so at Δ = minDeltaF it
  // would veto every decrease even when the model says no pre-heat/pre-cool is needed at all (Δ* < 0).
  both('Δ at minDeltaF (1), mornings reached 60 min early + mild forecast (Δ* < 0) ⇒ R2_LEAD, not veto', {
    eps: [...r3Mornings('comfortable', { par: { deltaF: 1 }, rmbp: 60 }), ...modelEps()], forecast: { temp: 65 },
    cfg: (c) => { c.precondition.deltaF = { heating: 1, cooling: 1 } },
  }, CHANGE('leadMin', 120, 90, 'R2_LEAD'), (r, ctx, season) => {
    assert.equal(r.model.confident, true)
    assert.equal(r.change.evidence.forecastPeakF, R(season, 65), 'the forecast was usable')
    assert.ok(r.change.evidence.deltaStar < 0, `Δ* ${r.change.evidence.deltaStar}`)
  })
  both('Δ at maxDeltaF (4) + forecast needing Δ* ≈ 6 ⇒ veto', {
    eps: [...r3Mornings('comfortable', { par: { deltaF: 4 } }), ...modelEps()], forecast: { temp: 9 },
    tuning: (t, s) => { t[s].deltaF = 4 },
  }, HOLD('veto'))
  both('3 comfortable mornings, no forecast ⇒ R2 DOWN (the model alone never vetoes)', { eps: [...r3Mornings('comfortable'), ...modelEps()] }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  both('3 comfortable mornings + mild forecast ⇒ DOWN', { eps: [...r3Mornings('comfortable'), ...modelEps()], forecast: { temp: 60 } }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  // R3 needs Δ*int ≥ Δ + 1 (Δ*int ≤ maxDeltaF), so its at_limit is always the setpoint guard (orig 74 + 3
  // + 1 > heatingMax 76) with the lead at its max, never "maximum pre-heat"; the room stayed in band.
  both('R3 at_limit (setpoint guard, lead at max) ⇒ forecast suggestion, not a breach at maximum', {
    eps: [...r3Mornings('comfortable', { orig: 74, par: { leadMin: 150 } }), ...modelEps()], forecast: { temp: 20 },
    tuning: (t, s) => { t[s].leadMin = 150 },
  }, HOLD('at_limit'), (r, ctx, season) => {
    assert.equal(r.signals.R3, true)
    assert.ok(r.suggestion, 'at_limit carries a suggestion')
    assert.doesNotMatch(r.suggestion.text, /drops to|rises to|maximum/)
    const noun = season === 'heating' ? 'pre-heat' : 'pre-cool'
    assert.equal(r.suggestion.text, `The forecast calls for more ${noun} for Office, but the setpoint limit for ${noun} is reached. Raise the max, widen the band, or opt Office out of the morning shed.`)
  })
  both('Δ*int is clamped to maxDeltaF ⇒ no R3 once Δ is at the max', {
    eps: [...r3Mornings('ok', { par: { deltaF: 4 } }), ...modelEps()], forecast: { temp: -10 },
    tuning: (t, s) => { t[s].deltaF = 4 }, cfg: (c) => { c.optimizer.maxDeltaF = 4 },
  }, HOLD('need_n'))
})

describe('R2 comfortable ⇒ DOWN, and every block (§5.6)', () => {
  const three = [comfy(WD[0]), comfy(WD[1]), comfy(WD[2])]
  both('3 fresh comfortable episodes ⇒ −1 Δ', { eps: three }, CHANGE('deltaF', 3, 2, 'R2_DELTA'),
    (r, ctx, season) => {
      if (season === 'heating') assert.equal(r.change.rationale, 'Office stayed ≥ 70.5° through the last 3 peaks, 2.5° above your floor. Trying less pre-heat: +3° → +2°.')
      else assert.equal(r.change.rationale, 'Office stayed ≤ 75.5° through the last 3 peaks, 2.5° below your ceiling. Trying less pre-cool: −3° → −2°.')
    })
  both('reached ≥ 45 min before the peak ⇒ start 30 min later', { eps: three.map((e) => ({ ...e, rmbp: 60 })) }, CHANGE('leadMin', 120, 90, 'R2_LEAD'))
  both('only 2 comfortable ⇒ need_n with the reason string', { eps: three.slice(0, 2) }, HOLD('need_n'),
    (r, ctx, season) => assert.equal(r.hold.text, `Need 3 comfortable peaks at ${season === 'heating' ? '+' : '−'}3° from 5:00 (have 2)`))
  both('tight latest episode ⇒ tight', { eps: [{ date: WD[0], cls: 'tight', low: 68.6, m: 0.6 }, comfy(WD[1]), comfy(WD[2])] }, HOLD('tight'),
    (r, ctx, season) => assert.equal(r.hold.text, season === 'heating' ? 'Tight but in band (low 68.6°) — holding' : 'Tight but in band (high 77.4°) — holding'))
  both('low comfort coverage (cov < 0.6) does not count', { eps: [comfy(WD[0], { cov: 0.5 }), comfy(WD[1]), comfy(WD[2])] }, HOLD('need_n'))
  both('any comfort-direction override in F[0..2] (even `auto`) blocks DOWN',
    { eps: [comfy(WD[0], { overrides: [{ f: 'power', v: 'ON', auto: true }] }), comfy(WD[1]), comfy(WD[2])] }, HOLD('need_n'))
  both('G4 flat/jump on 2 of 3 ⇒ sensor', { eps: [comfy(WD[0], { flat: true }), comfy(WD[1], { jump: true }), comfy(WD[2])] }, HOLD('sensor'))
  both('G4 on 1 of 3 does not block', { eps: [comfy(WD[0], { flat: true }), comfy(WD[1]), comfy(WD[2])] }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  both('minDaysBetweenOpposite after an UP ⇒ hysteresis', { eps: three, tuning: (t) => { t.lastUpAt = '2026-10-20' } }, HOLD('hysteresis'))
  both('hysteresis window passed ⇒ DOWN', { eps: three, tuning: (t) => { t.lastUpAt = '2026-10-19' } }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  both('cooldown on the down direction ⇒ cooldown', { eps: three, tuning: (t, s) => { t.cooldown[`${s}.deltaF.down`] = '2026-10-24' } }, HOLD('cooldown'))
  both('cooldown expired (applyDate ≥ until) ⇒ DOWN', { eps: three, tuning: (t, s) => { t.cooldown[`${s}.deltaF.down`] = TODAY } }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  both('cooldown on the other season does not apply', { eps: three, tuning: (t, s) => { t.cooldown[`${s === 'heating' ? 'cooling' : 'heating'}.deltaF.down`] = '2026-10-30' } }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  both('frozen down direction ⇒ frozen', { eps: three, tuning: (t, s) => { t.frozen[`${s}.down`] = '2026-11-01' } }, HOLD('frozen'),
    (r) => assert.equal(r.hold.text, 'Lowering paused after two reverts until Sun'))
  // The hold names the frozen direction: an UP frozen on a breach morning must not say "Lowering".
  both('frozen up direction blocks an UP too', { eps: [breach()], tuning: (t, s) => { t.frozen[`${s}.up`] = '2026-11-01' } }, HOLD('frozen'),
    (r, ctx, season) => {
      assert.doesNotMatch(r.hold.text, /Lowering/)
      assert.equal(r.hold.text, `More ${season === 'heating' ? 'pre-heat' : 'pre-cool'} paused after two reverts until Sun`)
    })
  both('cooldown on up blocks the chosen UP param', { eps: [breach()], tuning: (t, s) => { t.cooldown[`${s}.deltaF.up`] = '2026-10-25' } }, HOLD('cooldown'))
  both('already at minDeltaF ⇒ guardrail', { eps: three.map((e) => ({ ...e, par: { deltaF: 1 } })), tuning: (t, s) => { t[s].deltaF = 1 } }, HOLD('guardrail', 'guardrail'))
  both('lead DOWN respects minLeadMin (90 − 30 < 60 ⇒ Δ instead)',
    { eps: three.map((e) => ({ ...e, rmbp: 60, par: { leadMin: 90 } })), tuning: (t, s) => { t[s].leadMin = 90 }, cfg: (c) => { c.optimizer.minLeadMin = 61 } },
    CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  // X1.2 (round 4 optimizer-guardrails-1): a configured lead longer than the room (07:00 − 04:30 = 150 min) is never
  // tuned, whatever the step — also one within a step of it (170 − 30 = 140 would land inside [60, 150]); Δ steps instead.
  const startOf = { 155: '4:25', 170: '4:10', 180: '4:00', 240: '3:00' }
  for (const lead of [155, 170, 180, 240]) {
    const base = (c) => { c.precondition.leadMin = { heating: lead, cooling: lead } }
    const early = three.map((e) => ({ ...e, rmbp: 60, par: { leadMin: lead } }))
    both(`a base lead ${lead} > room 150, reached early ⇒ −1 Δ, never R2_LEAD`, { eps: early, cfg: base }, CHANGE('deltaF', 3, 2, 'R2_DELTA'),
      (r) => assert.equal(r.change.evidence.fromLabel, `today ${startOf[lead]} AM`, 'the base start stands'))
    both(`a base lead ${lead} > room 150, reached early, Δ at minDeltaF ⇒ guardrail`,
      { eps: early.map((e) => ({ ...e, par: { deltaF: 1, leadMin: lead } })), cfg: base, tuning: (t, s) => { t[s].deltaF = 1 } }, HOLD('guardrail', 'guardrail'))
  }
  both('weekend boundary episodes reached early change nothing: a base lead 170 stays untuned', {
    now: tz.zonedToInstant('2026-10-20', '01:30'),
    eps: [
      ...['2026-10-19', '2026-10-16', '2026-10-15'].map((date) => comfy(date, { rmbp: 60, par: { leadMin: 170 } })),
      ...['2026-10-17', '2026-10-18'].map((date) => ({ date, kind: 'boundary', reached: true, rmbp: 90, par: { leadMin: 170 } })),
    ],
    cfg: (c) => { c.precondition.leadMin = { heating: 170, cooling: 170 } },
  }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  both('a base lead equal to the room (150) is still tuned',
    { eps: three.map((e) => ({ ...e, rmbp: 60, par: { leadMin: 150 } })), cfg: (c) => { c.precondition.leadMin = { heating: 150, cooling: 150 } } },
    CHANGE('leadMin', 150, 120, 'R2_LEAD'))
  both('a TUNED lead above the room is still stepped back inside (clampStep, unchanged)',
    { eps: three.map((e) => ({ ...e, rmbp: 60, par: { leadMin: 170 } })), tuning: (t, s) => { t[s].leadMin = 170 } },
    CHANGE('leadMin', 170, 140, 'R2_LEAD'))
  both('any UP signal blocks DOWN', { eps: [comfy(WD[0], { overrides: [{ f: 'power', v: 'ON', auto: false }] }), comfy(WD[1], { overrides: [{ f: 'power', v: 'ON' }] }), comfy(WD[2])] }, CHANGE('deltaF', 3, 4, 'R5'))
})

describe('R4 dormant / wake', () => {
  const dormantDays = { '2026-10-19': { on: 0, cov: 0.9 }, '2026-10-20': { on: 0, cov: 0.9 }, [D]: { on: 0, cov: 0.9 } }
  both('off for the last 3 full days ⇒ suspend (the day\'s change)', { days: dormantDays },
    { mode: 'change', hold: null, kind: 'suspend', param: 'suspended', from: false, to: true, rule: 'R4A' },
    (r, ctx, season) => {
      assert.equal(r.change.since, '2026-10-19')
      assert.equal(r.signals.R4, 'dormant')
      if (season === 'heating') assert.equal(r.change.rationale, "Office has been off for 3 days. Pre-heat paused until it's used again.")
      assert.equal(tuning.check(ctx.unitState, r.change, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), 'ok')
    })
  // not dormant (coverage 0.4 on Tue), and with no ON minutes in 3 days there is no season either
  both('dormancy needs coverage ≥ 0.5 on every day', { days: { ...dormantDays, '2026-10-20': { on: 0, cov: 0.4 } } }, HOLD('no_season'))
  both('dormancy needs coverage ≥ 0.5 on every day (season known from a TAKE)', { eps: [okEp(D)], days: { ...dormantDays, '2026-10-20': { on: 0, cov: 0.4 } } }, HOLD('need_n'))
  both('2 of 3 days off is not dormant', { days: { ...dormantDays, '2026-10-19': { on: 45 } } }, HOLD('learning'))
  both('dormant while observing ⇒ proposal only', { days: dormantDays, enabledAt: '2026-10-20T17:00:00.000Z' },
    { mode: 'proposed', hold: null, kind: 'suspend', param: 'suspended', from: false, to: true, rule: 'R4A' })
  both('suspended and used ≥ 60 min yesterday ⇒ resume', { days: { [D]: { on: 90 } }, tuning: (t) => { t.suspended = { since: '2026-10-10', changeId: 't_x' } } },
    { mode: 'change', hold: null, kind: 'resume', param: 'suspended', from: true, to: false, rule: 'R4B' },
    (r, ctx, season) => {
      if (season === 'heating') assert.equal(r.change.rationale, 'Office is in use again. Pre-heat resumed at +3° from 5:00.')
      assert.equal(tuning.check(ctx.unitState, r.change, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), 'ok')
    })
  both('resume bypasses observe and the lock', {
    days: { [D]: { on: 90 } }, enabledAt: '2026-10-21T17:00:00.000Z',
    tuning: (t) => { t.suspended = { since: '2026-10-10', changeId: 't_x' }; t.lockedDates = [TODAY] },
  }, { mode: 'change', hold: null, kind: 'resume', param: 'suspended', from: true, to: false, rule: 'R4B' },
  (r) => assert.equal(r.observe, false))
  both('suspended and still idle ⇒ hold suspended (excluded from learning)',
    { eps: [breach()], days: { [D]: { on: 30 } }, tuning: (t) => { t.suspended = { since: '2026-10-10', changeId: 't_x' } } }, HOLD('suspended'))
  // R4b is evaluated before G1/G2 (like tuning.check('resume')): auto-tune off freezes tuned values, not a dormancy pause
  const paused = (t) => { t.suspended = { since: '2026-10-10', changeId: 't_x' } }
  const offs = {
    'auto-tune off': { cfg: (c) => { c.optimizer.enabled = false }, code: 'off' },
    'unit opted out': { cfg: (c) => { c.optimizer.units.office.enabled = false }, code: 'off' },
    'dry-run': { cfg: (c) => { c.automation.mode = 'dry-run' }, code: 'not_live' },
    'schedule disabled': { scheduleEnabled: false, code: 'not_live' },
  }
  for (const [label, { code, ...o }] of Object.entries(offs)) {
    both(`${label}: suspended and used ≥ 60 min yesterday ⇒ still resume`, { ...o, eps: [breach()], days: { [D]: { on: 90 } }, tuning: paused },
      { mode: 'change', hold: null, kind: 'resume', param: 'suspended', from: true, to: false, rule: 'R4B' },
      (r, ctx) => {
        assert.equal(r.observe, false)
        assert.equal(tuning.check(ctx.unitState, r.change, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), 'ok')
      })
    both(`${label}: suspended and still idle ⇒ hold ${code}`, { ...o, eps: [breach()], days: { [D]: { on: 30 } }, tuning: paused }, HOLD(code))
  }
})

describe('gates G1–G7', () => {
  both('optimizer off ⇒ off', { eps: [breach()], cfg: (c) => { c.optimizer.enabled = false } }, HOLD('off'))
  both('unit opted out ⇒ off', { eps: [breach()], cfg: (c) => { c.optimizer.units.office.enabled = false } }, HOLD('off'))
  both('unit does not precondition ⇒ off', { eps: [breach()], cfg: (c) => { c.units.find((u) => u.id === 'office').precondition = false } }, HOLD('off'))
  both('unit does not shed ⇒ off', { eps: [breach()], cfg: (c) => { c.units.find((u) => u.id === 'office').shed = false } }, HOLD('off'))
  both('dry-run ⇒ not_live (and observe)', { eps: [breach()], cfg: (c) => { c.automation.mode = 'dry-run' } }, HOLD('not_live'),
    (r) => assert.equal(r.observe, true))
  both('schedule disabled ⇒ not_live', { eps: [breach()], scheduleEnabled: false }, HOLD('not_live'))
  both('applyDate locked after a revert ⇒ locked', { eps: [breach()], tuning: (t) => { t.lockedDates = [TODAY] } }, HOLD('locked'),
    (r) => assert.equal(r.hold.text, 'Locked today (you reverted)'))
  both('lastAnalysisDate === D ⇒ already', { eps: [breach()], tuning: (t, s) => { t[s].lastAnalysisDate = D } }, HOLD('already'),
    (r) => assert.equal(r.hold.text, "Already adjusted from Wed's data"))
  both('a change already targets this applyDate ⇒ already',
    { eps: [breach()], tuning: (t, s) => { t[s].history = [{ id: 't_a', param: 'deltaF', from: 2, to: 3, at: '2026-10-21T21:00:00.000Z', rule: 'R1_DELTA', applyDate: TODAY, analysisDate: '2026-10-20' }] } },
    HOLD('already'))
  both('coverage(D) < 0.6 ⇒ low_data', { eps: [breach()], days: { [D]: { cov: 0.4 } } }, HOLD('low_data'))
  both('failing job during the latest episode ⇒ low_data', { eps: [breach({ failing: 1 })] }, HOLD('low_data'))
  both('no fresh episode ⇒ learning', { eps: [] }, HOLD('learning'))
  test('no HEAT/COOL anywhere ⇒ no_season', () => {
    const r = O.proposeFor(mkCtx('heating', { days: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [addDays(D, -i), { modeMin: { FAN: 300 } }])) }))
    assert.deepEqual(decision(r), HOLD('no_season'))
  })
  test('the hold never carries a change and gate order is G1 before G2', () => {
    const r = O.proposeFor(mkCtx('heating', { eps: [breach()], cfg: (c) => { c.optimizer.enabled = false; c.automation.mode = 'dry-run' } }))
    assert.equal(r.hold.code, 'off')
    assert.equal(r.change, null)
  })
})

describe('season detection (§5.3) — never the calendar', () => {
  test('a HEAT unit in July is heating (TAKE sign wins over the mode mix)', () => {
    const now = tz.zonedToInstant('2026-07-15', '01:30')
    const days = { '2026-07-12': { modeMin: { opp: 300 } }, '2026-07-13': { modeMin: { opp: 300 } }, '2026-07-14': { modeMin: { opp: 300 } } }
    const ctx = mkCtx('heating', { now, eps: [{ ...breach(), date: '2026-07-14' }], days, enabledAt: '2026-06-01T17:00:00.000Z' })
    assert.equal(O.detectSeason(ctx), 'heating')
    const r = O.proposeFor(ctx)
    assert.equal(r.season, 'heating')
    assert.deepEqual(decision(r), CHANGE('deltaF', 3, 4, 'R1_DELTA'))
  })
  test('majority-ON mode over the last 3 days: HEAT ⇒ heating, COOL/DRY ⇒ cooling, FAN ⇒ null, tie ⇒ null', () => {
    const at = (modeMin) => O.detectSeason(mkCtx('heating', { days: { [D]: { modeMin }, '2026-10-20': { modeMin }, '2026-10-19': { modeMin } } }))
    assert.equal(at({ main: 200, opp: 50 }), 'heating')
    assert.equal(at({ DRY: 150, COOL: 100, main: 200 }), 'cooling')
    assert.equal(at({ FAN: 400, main: 100 }), null)
    assert.equal(at({ main: 100, opp: 100 }), null)
    assert.equal(at({}), null)
  })
  test('the most recent participating episode within 3 days decides; older ones do not', () => {
    const ctx = mkCtx('heating', { eps: [{ ...breach(), date: '2026-10-15' }], days: { [D]: { modeMin: { opp: 300 } }, '2026-10-20': { modeMin: { opp: 300 } }, '2026-10-19': { modeMin: { opp: 300 } } } })
    assert.equal(O.detectSeason(ctx), 'cooling')
  })
})

describe('evidence freshness (§5.4) and one step per analysis date', () => {
  both('episodes measured under different params never count', { eps: [breach({ par: { deltaF: 2 } })] }, HOLD('learning'))
  both('episodes before evidenceFrom never count', { eps: [breach()], tuning: (t, s) => { t[s].evidenceFrom = '2026-10-21T20:00:00.000Z' } }, HOLD('learning'))
  both('per-unit enabledAt is an evidence bound too', { eps: [breach()], tuning: (t) => { t.enabledAt = '2026-10-21T20:00:00.000Z' } }, HOLD('learning'))
  both('baseChangedAt is an evidence bound', (season) => ({ eps: [breach()] }), CHANGE('deltaF', 3, 4, 'R1_DELTA'), (r, ctx) => {
    const r2 = O.proposeFor({ ...ctx, baseChangedAt: '2026-10-21T20:00:00.000Z' })
    assert.equal(r2.hold?.code, 'learning')
  })

  for (const season of SEASONS) {
    test(`one cold morning does not re-fire on consecutive runs; learning until an episode at the new params [${season}]`, () => {
      const cold = breach()
      // run 1 (Thu 01:30): breach on Wed ⇒ +1
      const ctx1 = mkCtx(season, { eps: [cold] })
      const r1 = O.proposeFor(ctx1)
      assert.deepEqual(decision(r1), CHANGE('deltaF', 3, 4, 'R1_DELTA'))
      assert.equal(tuning.check(ctx1.unitState, r1.change, { cfg: ctx1.cfg, state: ctx1.state, now: ctx1.now, tz }), 'ok')
      const t = structuredClone(ctx1.unitState.tuning)
      tuning.applyMutation(t, r1.change, ctx1.now, { cfg: ctx1.cfg, tz })
      const keep = (tt) => Object.assign(tt, structuredClone(t))
      // same day again (manual run) ⇒ already
      assert.equal(O.proposeFor(mkCtx(season, { eps: [cold], tuning: keep })).hold.code, 'already')
      // run 2 (Fri 01:30, D = Thu): no episode at +4 yet ⇒ learning (not R1 again)
      for (const [day, extra] of [['2026-10-23', []], ['2026-10-24', []]]) {
        const now = tz.zonedToInstant(day, '01:30')
        const r = O.proposeFor(mkCtx(season, { now, eps: [cold, ...extra], tuning: keep }))
        assert.deepEqual(decision(r), HOLD('learning'), day)
      }
      // run 4 (Tue 01:30, D = Mon): Mon ran at +4 and was comfortable ⇒ need_n (have 1), still no step
      const now4 = tz.zonedToInstant('2026-10-27', '01:30')
      const r4 = O.proposeFor(mkCtx(season, { now: now4, eps: [cold, comfy('2026-10-26', { par: { deltaF: 4 } })], tuning: keep }))
      assert.deepEqual(decision(r4), HOLD('need_n'))
      assert.match(r4.hold.text, /\(have 1\)$/)
      // …and a new cold morning at +4 ⇒ the next step
      const r5 = O.proposeFor(mkCtx(season, { now: now4, eps: [cold, breach({ date: '2026-10-26', par: { deltaF: 4 } })], tuning: keep }))
      assert.deepEqual(decision(r5), CHANGE('leadMin', 120, 150, 'R1_LEAD')) // +5 > maxDeltaF 4 ⇒ lead
    })

    test(`manual afternoon run for tomorrow, then tomorrow's 01:30 run cannot step again [${season}]`, () => {
      const now = tz.zonedToInstant(TODAY, '14:00') // applyDate = tomorrow, D = Wed
      const ctx1 = mkCtx(season, { now, eps: [breach()] })
      const r1 = O.proposeFor(ctx1)
      assert.equal(r1.change.applyDate, '2026-10-23')
      const t = structuredClone(ctx1.unitState.tuning)
      tuning.applyMutation(t, r1.change, now, { cfg: ctx1.cfg, tz })
      // next 01:30 run (D = Thu): Thu's morning was at the old params ⇒ learning; a colder forecast (R3) also cannot step twice
      const now2 = tz.zonedToInstant('2026-10-23', '01:30')
      const r2 = O.proposeFor(mkCtx(season, {
        now: now2, eps: [breach(), okEp(TODAY, { T0: 70, eff: 0.8 }), okEp(D, { T0: 70, eff: 0.8, cls: 'violated' }), ...modelEps()],
        forecast: { temp: 10, from: '2026-10-23' }, tuning: (tt) => Object.assign(tt, structuredClone(t)),
      }))
      assert.equal(r2.change, null)
      assert.equal(r2.hold.code, 'already')
    })
  }
})

describe('observe-only (§5.8)', () => {
  both('enabled Tue ⇒ Thu run is observe: proposal only', { eps: [breach()], enabledAt: '2026-10-20T17:00:00.000Z' },
    CHANGE('deltaF', 3, 4, 'R1_DELTA', 'proposed'),
    (r, ctx) => {
      assert.equal(r.observe, true)
      assert.equal(tuning.check(ctx.unitState, r.change, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), 'observe')
    })
  both('observeDays 0 ⇒ live the next day', { eps: [breach()], enabledAt: '2026-10-21T17:00:00.000Z', cfg: (c) => { c.optimizer.observeDays = 0 } },
    // evidence bound = enable instant (Wed 10:00 local) is after Wed's 07:00 peak ⇒ nothing fresh yet
    HOLD('learning'))
  both('per-unit enabledAt restarts observe', { eps: [breach()], tuning: (t) => { t.enabledAt = '2026-10-19T13:00:00.000Z' } },
    CHANGE('deltaF', 3, 4, 'R1_DELTA', 'proposed'))
  both('never enabled ⇒ observing', { eps: [breach()], enabledAt: null }, CHANGE('deltaF', 3, 4, 'R1_DELTA', 'proposed'))
})

describe('rationale snapshots (shared/insights-text.js wording)', () => {
  test('R1_DELTA heating / cooling', () => {
    const h = O.proposeFor(mkCtx('heating', { eps: [breach()] }))
    assert.equal(h.change.rationale, 'Office dropped to 66.5° during Wed\'s morning peak (floor 68°). Pre-heat +3° → +4° from today 5:00 AM.')
    const c = O.proposeFor(mkCtx('cooling', { eps: [breach()] }))
    assert.equal(c.change.rationale, 'Office rose to 79.5° during Wed\'s morning peak (ceiling 78°). Pre-cool −3° → −4° from today 5:00 AM.')
  })
  test('weekend / holiday applyDate: "from …" names the first pre-conditioning morning, not the applyDate', () => {
    // Sat 01:30 run on a Fri breach: applyDate is Sat (weekendHoliday table, no pre-heat) ⇒ first acts Mon
    const sat = O.proposeFor(mkCtx('heating', { now: tz.zonedToInstant('2026-10-24', '01:30'), eps: [breach({ date: '2026-10-23' })] }))
    assert.equal(sat.change.applyDate, '2026-10-24', 'applyDate itself is unchanged (G5/G6 key on it)')
    assert.equal(sat.change.evidence.fromLabel, 'Mon 5:00 AM')
    assert.equal(sat.change.rationale, 'Office dropped to 66.5° during Fri\'s morning peak (floor 68°). Pre-heat +3° → +4° from Mon 5:00 AM.')
    // Veterans Day (Wed 2026-11-11): a 01:30 run that day first acts on Thu = tomorrow
    const vet = O.proposeFor(mkCtx('cooling', { now: tz.zonedToInstant('2026-11-11', '01:30'), eps: [breach({ date: '2026-11-10' })] }))
    assert.equal(vet.change.applyDate, '2026-11-11')
    assert.equal(vet.change.rationale, 'Office rose to 79.5° during Tue\'s morning peak (ceiling 78°). Pre-cool −3° → −4° from tomorrow 5:00 AM.')
  })
  test('R1_LEAD (bump not realised) and R1 lead at max Δ', () => {
    const a = O.proposeFor(mkCtx('heating', { eps: [breach({ reached: false, eff: 0.5, Tpk: 72.3, app: 73 })] }))
    assert.equal(a.change.rationale, 'Office only reached 72.3° of its 73° target by 7:00. Pre-heat now starts 4:30 (was 5:00).')
    const b = O.proposeFor(mkCtx('heating', { eps: [breach({ par: { deltaF: 4 } })], tuning: (t) => { t.heating.deltaF = 4 } }))
    assert.equal(b.change.rationale, 'Office dropped to 66.5° during Wed\'s morning peak (floor 68°). Pre-heat now starts 4:30 (was 5:00).')
  })
  test('R2_LEAD', () => {
    const r = O.proposeFor(mkCtx('heating', { eps: [comfy(WD[0], { rmbp: 50 }), comfy(WD[1], { rmbp: 60 }), comfy(WD[2], { rmbp: 70 })] }))
    assert.equal(r.change.rationale, 'Office reached its target ~60 min before peak on recent mornings. Starting later: 5:00 → 5:30.')
  })
  test('hold texts', () => {
    assert.equal(O.proposeFor(mkCtx('heating', { eps: [] })).hold.text, '0 mornings at +3° from 5:00 since Thu')
    assert.equal(O.proposeFor(mkCtx('heating', { eps: [breach()], cfg: (c) => { c.optimizer.enabled = false } })).hold.text, 'Auto-tune off for Office')
    assert.equal(O.proposeFor(mkCtx('heating', { eps: [...r3Mornings('comfortable'), ...modelEps()], forecast: { temp: 36 } })).hold.text, 'Forecast model says +3° from 5:00 is still needed')
  })
})

describe('Release 4 evidence (addenda B F3, C C6.3, D X1)', () => {
  const other = (season) => (season === 'heating' ? 'COOL' : 'HEAT')
  const same = (season) => (season === 'heating' ? 'HEAT' : 'DRY')
  test('qualifying excludes other-season / Fan forced episodes and preSkipped ones; a same-season interval never excludes', () => {
    for (const season of SEASONS) {
      const q = (spec) => O.qualifying(mkCtx(season, { eps: [spec] }), season).length
      assert.equal(q(okEp(D)), 1, season)
      assert.equal(q(okEp(D, { forced: [{ mode: 'FAN' }] })), 0, `${season}: forced to Fan`)
      assert.equal(q(okEp(D, { forced: [{ mode: other(season) }] })), 0, `${season}: forced into the other season`)
      assert.equal(q(okEp(D, { forced: [{ mode: same(season), sameSeason: true }] })), 1, `${season}: a same-season substitution`)
      assert.equal(q(okEp(D, { forced: [{ mode: 'FAN', fromMin: 200, untilMin: 400 }] })), 0, `${season}: overlapping the shed`)
      assert.equal(q(okEp(D, { forced: [{ mode: 'FAN', fromMin: 320, untilMin: 400 }] })), 1, `${season}: after peakEnd (the recovery) does not count`)
      assert.equal(q(okEp(D, { preSkipped: 'already conditioned', pre: null })), 0, `${season}: nothing was pre-conditioned`)
    }
  })
  both('the newest episode forced by the master and nothing fresh ⇒ hold forced_by_master (not learning)',
    { eps: [breach({ forced: [{ mode: 'FAN' }] })] }, HOLD('forced_by_master'),
    (r) => assert.equal(r.hold.text, 'Office was forced by Living Room on Wed — not counted'))
  both('an older forced episode with nothing fresh is plain learning', { eps: [breach({ date: WD[3], forced: [{ mode: 'FAN' }] }), okEp(D, { preSkipped: 'already conditioned', pre: null })] }, HOLD('learning'))
  both('R2 never steps DOWN on three already-conditioned mornings', { eps: [comfy(WD[0]), comfy(WD[1]), comfy(WD[2])].map((e) => ({ ...e, preSkipped: 'already conditioned', pre: null })) }, HOLD('learning'))
  both('preFromOff: only episodes of the newest one’s regime qualify (B C-10)', { eps: [comfy(WD[0], { preFromOff: true }), comfy(WD[1]), comfy(WD[2])] }, HOLD('need_n'),
    (r) => assert.match(r.hold.text, /\(have 1\)$/))
  both('three preFromOff mornings still step DOWN', { eps: [comfy(WD[0]), comfy(WD[1]), comfy(WD[2])].map((e) => ({ ...e, preFromOff: true })) }, CHANGE('deltaF', 3, 2, 'R2_DELTA'))
  test('the drift fit and the realisation sample exclude forced episodes; the realisation keeps F[0]’s preFromOff regime', () => {
    for (const season of SEASONS) {
      const fit = (eps) => O.proposeFor(mkCtx(season, { eps })).model
      assert.equal(fit(modelEps()).n, 6)
      assert.equal(fit(modelEps().map((e, i) => (i < 2 ? { ...e, forced: [{ mode: 'FAN', fromMin: 0, untilMin: 180 }] } : e))).n, 4, season)
      const mornings = (o) => WD.slice(0, 3).map((date, i) => ({ date, cls: 'ok', T0: 68 + i, eff: 0.5 + i / 10, ...o(i) }))
      const real = (eps, f0) => O.realisation(mkCtx(season, { eps }), season, f0)
      const all = real(mornings(() => ({})), false)
      assert.deepEqual(all.events.length, 3)
      assert.equal(real(mornings((i) => (i === 0 ? { forced: [{ mode: 'FAN' }] } : {})), false).events.length, 2, `${season}: forced`)
      assert.equal(real(mornings((i) => (i === 1 ? { preSkipped: 'precondition_skipped' } : {})), false).events.length, 2, `${season}: preSkipped`)
      assert.equal(real(mornings((i) => ({ preFromOff: i === 0 })), true).events.length, 1, `${season}: the preFromOff regime`)
      assert.equal(real(mornings((i) => ({ preFromOff: i === 0 })), null).events.length, 3, `${season}: no regime without F[0]`)
    }
  })
  test('X1: a Δ step never names a clamped start — the base lead is not tuned; a lead step (or a tuned lead) is clamped', () => {
    const cfg = (c) => { c.precondition.leadMin = { heating: 240, cooling: 240 } }
    const d = O.proposeFor(mkCtx('heating', { cfg, eps: [breach({ par: { leadMin: 240 } })] }))
    assert.deepEqual(decision(d), CHANGE('deltaF', 3, 4, 'R1_DELTA'))
    assert.equal(d.change.evidence.fromLabel, 'today 3:00 AM', 'the base start (240 min before 7:00) stands')
    const t = O.proposeFor(mkCtx('heating', { eps: [breach({ par: { leadMin: 180 } })], tuning: (x) => { x.heating.leadMin = 180 } }))
    assert.deepEqual(decision(t), CHANGE('deltaF', 3, 4, 'R1_DELTA'))
    assert.equal(t.change.evidence.fromLabel, 'today 4:30 AM', 'a tuned lead is held to earliestStart')
  })
})

describe('Release 4.1 boundary episodes (addendum E E1.15): realisation only', () => {
  const SAT = '2026-10-17'
  const SUN = '2026-10-18'
  const FRI = '2026-10-16'
  const MON = tz.zonedToInstant('2026-10-19', '01:30') // D = Sunday: the newest precondition episodes are boundary ones
  const bnd = (date, o = {}) => ({ date, kind: 'boundary', reached: true, ...o })
  test('qualifying and fresh exclude them; the peak evidence is unchanged', () => {
    for (const season of SEASONS) {
      const peaks = [okEp(D), okEp(WD[1])]
      const ids = (eps) => eps.map((e) => e.ev)
      const withB = mkCtx(season, { eps: [...peaks, bnd(SAT), bnd(SUN)] })
      const without = mkCtx(season, { eps: peaks })
      assert.deepEqual(ids(O.qualifying(withB, season)), [`${D}@07:00`, `${WD[1]}@07:00`], season)
      assert.deepEqual(ids(O.qualifying(withB, season)), ids(O.qualifying(without, season)))
      assert.deepEqual(ids(O.fresh(withB, season)), ids(O.fresh(without, season)))
    }
  })
  test('the realisation keeps them: zPre and eff̂ move with a Saturday’s T0 and eff', () => {
    for (const season of SEASONS) {
      const peaks = [okEp(D, { T0: 68, eff: 0.6 }), okEp(WD[1], { T0: 72, eff: 1.0 })]
      const r0 = O.realisation(mkCtx(season, { eps: peaks }), season, false)
      const r1 = O.realisation(mkCtx(season, { eps: [...peaks, bnd(SAT, { T0: 71, eff: 0.9 })] }), season, false)
      assert.deepEqual(r1.events, [`${D}@07:00`, `${WD[1]}@07:00`, `${SAT}@07:00`], season)
      near(r1.zPre - r0.zPre, 1, 1e-9, `${season}: median s·T0 70 → 71`)
      near(r0.effHat, 0.8, 1e-9)
      near(r1.effHat, 0.9, 1e-9, `${season}: median eff 0.8 → 0.9`)
    }
  })
  test('the drift fit never takes one — even one carrying a drift', () => {
    for (const season of SEASONS) {
      const fit = (ctx) => O.proposeFor(ctx).model
      assert.equal(fit(mkCtx(season, { eps: modelEps() })).n, 6)
      assert.equal(fit(mkCtx(season, { eps: [...modelEps(), bnd(SAT), bnd(SUN)] })).n, 6)
      const ctx = mkCtx(season, { eps: modelEps() })
      ctx.rollups['2026-10-05'].units.office.episodes[0].kind = 'boundary'
      assert.equal(fit(ctx).n, 5, `${season}: the explicit kind filter`)
    }
  })
  test('detectSeason reads a boundary episode’s take sign (a valid season signal)', () => {
    const days = { [SUN]: { modeMin: { opp: 300 } }, [SAT]: { modeMin: { opp: 300 } }, [FRI]: { modeMin: { opp: 300 } } }
    for (const season of SEASONS) {
      assert.equal(O.detectSeason(mkCtx(season, { now: MON, days })), season === 'heating' ? 'cooling' : 'heating', 'the mode mix alone')
      assert.equal(O.detectSeason(mkCtx(season, { now: MON, days, eps: [bnd(SUN)] })), season, 'the Sunday take sign wins')
    }
  })
  both('a Sunday analysis whose newest precondition episodes are boundary ones is judged on Friday’s peak (R1 from its breach)',
    { now: MON, eps: [breach({ date: FRI }), bnd(SAT), bnd(SUN)] }, CHANGE('deltaF', 3, 4, 'R1_DELTA'),
    (r) => {
      assert.deepEqual(r.change.evidence.events, [`${FRI}@07:00`])
      assert.equal(r.change.evidence.dayLabel, 'Fri')
    })
  both('…and when that peak was the master’s decision, the hold names it (forced_by_master), not learning',
    { now: MON, eps: [breach({ date: FRI, forced: [{ mode: 'FAN' }] }), bnd(SAT), bnd(SUN)] }, HOLD('forced_by_master'),
    (r) => assert.equal(r.hold.text, 'Office was forced by Living Room on Fri — not counted'))
  both('G7 reads the newest precondition episode, a boundary one included (a failing job is a failing job)',
    { now: MON, eps: [okEp(FRI), bnd(SUN, { failing: 1 })] }, HOLD('low_data'))
  // R3 forecasts the first PEAK of the apply date: a user weekend table with a 16:00 pre-conditioning peak and the
  // option on has the 07:00 boundary first — never the forecast window (it has no peak hours)
  const weekendPeak = (on) => (c) => {
    c.tou.weekendHoliday = [
      { start: '07:00', end: '16:00', tier: 'off_peak' },
      { start: '16:00', end: '19:00', tier: 'peak', precondition: true },
      { start: '19:00', end: '23:00', tier: 'off_peak' },
    ]
    c.precondition.superOffPeak = { weekend: on }
  }
  const SAT_RUN = tz.zonedToInstant('2026-10-24', '01:30') // applyDate = Saturday 2026-10-24
  both('R3 on a Saturday apply date forecasts its 16:00 peak with the option on as off',
    { now: SAT_RUN, eps: [...r3Mornings(), ...modelEps()], forecast: { temp: 28, from: '2026-10-24' }, cfg: weekendPeak(true) },
    CHANGE('deltaF', 3, 4, 'R3'),
    (r, ctx) => {
      assert.equal(r.change.evidence.windowLabel, '4–7 PM')
      const off = O.proposeFor({ ...ctx, cfg: baseCfg(weekendPeak(false)) })
      assert.deepEqual(decision(off), decision(r))
      assert.equal(off.change.evidence.windowLabel, '4–7 PM')
    })
})

describe('Release 4.2 evidence (Addendum F rule 10, D-check-6): a re-planned precondition is never E', () => {
  test('qualifying and fresh drop a replanned episode; episodes without the key are unchanged', () => {
    for (const season of SEASONS) {
      const ids = (eps) => eps.map((e) => e.ev)
      const peaks = [okEp(D), okEp(WD[1])]
      const ctx = mkCtx(season, { eps: [okEp(D, { replanned: true }), okEp(WD[1])] })
      assert.deepEqual(ids(O.qualifying(ctx, season)), [`${WD[1]}@07:00`], season)
      assert.deepEqual(ids(O.fresh(ctx, season)), [`${WD[1]}@07:00`], season)
      assert.deepEqual(ids(O.qualifying(mkCtx(season, { eps: peaks }), season)), [`${D}@07:00`, `${WD[1]}@07:00`], `${season}: no key, as before`)
    }
  })
  // its preStart is the re-plan instant: leadUsed never tested par.leadMin, so a missed target says nothing about the lead
  both('a re-planned morning that missed its target never proposes leadMin (R1_LEAD) — nothing fresh is left: learning',
    { eps: [breach({ reached: false, eff: 0.5, Tpk: 72.3, app: 73, replanned: true })] }, HOLD('learning'))
  both('the same morning without the re-plan steps the lead (the control)',
    { eps: [breach({ reached: false, eff: 0.5, Tpk: 72.3, app: 73 })] }, CHANGE('leadMin', 120, 150, 'R1_LEAD'))
})

describe('Release 4.3 evidence (Addendum H, A §4.6/§5.4): a peak while away is never E', () => {
  test('qualifying, fresh and the realisation drop an away episode; the drift fit keeps it; episodes without the key are unchanged', () => {
    for (const season of SEASONS) {
      const ids = (eps) => eps.map((e) => e.ev)
      const ctx = mkCtx(season, { eps: [okEp(D, { away: 'left-home' }), okEp(WD[1]), okEp(WD[2], { away: 'vacation', q: 'forced' })] })
      assert.deepEqual(ids(O.qualifying(ctx, season)), [`${WD[1]}@07:00`], season)
      assert.deepEqual(ids(O.fresh(ctx, season)), [`${WD[1]}@07:00`], season)
      assert.deepEqual(O.realisation(ctx, season, false).events, [`${WD[1]}@07:00`], `${season}: a return inside the window is no pre-heat`)
      const home = mkCtx(season, { eps: [okEp(D), okEp(WD[1])] })
      assert.deepEqual(ids(O.qualifying(home, season)), [`${D}@07:00`, `${WD[1]}@07:00`], `${season}: no key, as before`)
      const fit = (eps) => O.proposeFor(mkCtx(season, { eps })).model
      assert.equal(fit(modelEps().map((e) => ({ ...e, away: 'vacation' }))).n, 6, `${season}: Newton cooling does not know who is home`)
    }
  })
  both('a breach while away never raises — nothing fresh is left: learning', { eps: [breach({ away: 'left-home' })] }, HOLD('learning'))
  both('the same breach at home raises (the control)', { eps: [breach()] }, CHANGE('deltaF', 3, 4, 'R1_DELTA'))
  both('three comfortable mornings of a Vacation never step DOWN', { eps: [comfy(WD[0]), comfy(WD[1]), comfy(WD[2])].map((e) => ({ ...e, away: 'vacation' })) }, HOLD('learning'))
  const idle = { on: 0, cov: 0.9 }
  both('three idle days on Vacation are no dormancy (the house was away, the unit not unused)',
    { days: { '2026-10-19': { ...idle, away: 'vacation' }, '2026-10-20': { ...idle, away: 'vacation' }, [D]: { ...idle, away: 'vacation' } } }, HOLD('no_season'))
  both('one of the three idle days away is enough to hold off R4a', { days: { '2026-10-19': idle, '2026-10-20': idle, [D]: { ...idle, away: 'left-home' } } }, HOLD('no_season'))
})

describe('stepFor / clampStep (§5.7)', () => {
  const g = tuning.guardrails(baseCfg())
  test('clampStep: bounds, 5-minute grid, step caps, direction never reversed', () => {
    assert.deepEqual(O.clampStep({ deltaF: 3, leadMin: 120 }, { param: 'deltaF', to: 4 }, g, 420), { param: 'deltaF', from: 3, to: 4 })
    assert.equal(O.clampStep({ deltaF: 4, leadMin: 120 }, { param: 'deltaF', to: 5 }, g, 420), null) // above maxDeltaF 4
    assert.deepEqual(O.clampStep({ deltaF: 3, leadMin: 120 }, { param: 'deltaF', to: 6 }, { ...g, maxDeltaF: 6 }, 420), { param: 'deltaF', from: 3, to: 4 }) // |Δ| ≤ 1
    assert.equal(O.clampStep({ deltaF: 6, leadMin: 120 }, { param: 'deltaF', to: 5 }, g, 420), null) // 5 still > max 4 and |Δ| ≤ 1
    assert.deepEqual(O.clampStep({ deltaF: 3, leadMin: 122 }, { param: 'leadMin', to: 152 }, g, 420), { param: 'leadMin', from: 122, to: 150 })
    assert.deepEqual(O.clampStep({ deltaF: 3, leadMin: 122 }, { param: 'leadMin', to: 92 }, g, 420), { param: 'leadMin', from: 122, to: 95 })
    assert.equal(O.clampStep({ deltaF: 3, leadMin: 150 }, { param: 'leadMin', to: 180 }, g, 420), null) // 07:00 − 180 < 04:30
    assert.deepEqual(O.clampStep({ deltaF: 3, leadMin: 180 }, { param: 'leadMin', to: 150 }, g, 420), { param: 'leadMin', from: 180, to: 150 }) // back inside
    assert.equal(O.clampStep({ deltaF: 3, leadMin: 60 }, { param: 'leadMin', to: 30 }, g, 420), null) // below minLeadMin 60
    assert.equal(O.clampStep({ deltaF: 3, leadMin: 120 }, { param: 'fan', to: 3 }, g, 420), null)
    assert.equal(O.clampStep({ deltaF: 3, leadMin: 120 }, { param: 'deltaF', to: 3 }, g, 420), null)
  })
  test('stepFor UP order: lead when not realised → Δ → lead → at_limit; DOWN: lead when early → Δ → guardrail', () => {
    const e = (pre) => ({ pre: { orig: 70, reached: true, eff: 0.9, capped: false, reachedMinBeforePeak: 0, ...pre } })
    const sctx = (F, season = 'heating') => ({ season, F, guardrails: g, bandCfg: [68, 78], clampF: { heatingMax: 76, coolingMin: 70 } })
    assert.deepEqual(O.stepFor('up', sctx([e({ reached: false, eff: 0.5 })]), { deltaF: 3, leadMin: 120 }), { param: 'leadMin', from: 120, to: 150 })
    assert.deepEqual(O.stepFor('up', sctx([e()]), { deltaF: 3, leadMin: 120 }), { param: 'deltaF', from: 3, to: 4 })
    assert.deepEqual(O.stepFor('up', sctx([e()]), { deltaF: 4, leadMin: 120 }), { param: 'leadMin', from: 120, to: 150 })
    assert.deepEqual(O.stepFor('up', sctx([e()]), { deltaF: 4, leadMin: 150 }), { hold: 'at_limit' })
    assert.deepEqual(O.stepFor('up', sctx([]), { deltaF: 3, leadMin: 120 }), { param: 'deltaF', from: 3, to: 4 })
    assert.deepEqual(O.stepFor('down', sctx([e({ reachedMinBeforePeak: 50 }), e({ reachedMinBeforePeak: 45 }), e({ reachedMinBeforePeak: 10 })]), { deltaF: 3, leadMin: 120 }), { param: 'leadMin', from: 120, to: 90 })
    assert.deepEqual(O.stepFor('down', sctx([e()]), { deltaF: 3, leadMin: 120 }), { param: 'deltaF', from: 3, to: 2 })
    assert.deepEqual(O.stepFor('down', sctx([e()]), { deltaF: 1, leadMin: 120 }), { hold: 'guardrail' })
    // X1.2: a config lead longer than the room (150) is never the DOWN step — Δ, else guardrail; a tuned one still is
    const early = sctx([e({ reachedMinBeforePeak: 60 }), e({ reachedMinBeforePeak: 60 }), e({ reachedMinBeforePeak: 60 })])
    assert.deepEqual(O.stepFor('down', early, { deltaF: 3, leadMin: 170, leadSource: 'config' }), { param: 'deltaF', from: 3, to: 2 })
    assert.deepEqual(O.stepFor('down', early, { deltaF: 1, leadMin: 170, leadSource: 'config' }), { hold: 'guardrail' })
    assert.deepEqual(O.stepFor('down', early, { deltaF: 3, leadMin: 150, leadSource: 'config' }), { param: 'leadMin', from: 150, to: 120 })
    assert.deepEqual(O.stepFor('down', early, { deltaF: 3, leadMin: 170, leadSource: 'tuned' }), { param: 'leadMin', from: 170, to: 140 })
    // cooling setpoint guard mirrors: orig 76 − 3 − 1 = 72 ≥ max(L 68, coolingMin 70) ok; orig 73 − 4 = 69 < 70 ⇒ lead
    assert.equal(O.stepFor('up', sctx([{ pre: { orig: 76, reached: true, eff: 0.9 } }], 'cooling'), { deltaF: 3, leadMin: 120 }).param, 'deltaF')
    assert.equal(O.stepFor('up', sctx([{ pre: { orig: 73, reached: true, eff: 0.9 } }], 'cooling'), { deltaF: 3, leadMin: 120 }).param, 'leadMin')
  })
})

describe('purity and scope', () => {
  test('deep-frozen input: no mutation, deterministic output, deterministic change id', () => {
    for (const season of SEASONS) {
      const ctx = mkCtx(season, { eps: [breach(), ...modelEps()], forecast: { temp: 28 } })
      const { tz: z, ...rest } = ctx
      deepFreeze(rest)
      const a = O.proposeFor({ ...rest, tz: z })
      const b = O.proposeFor({ ...rest, tz: z })
      assert.deepEqual(a, b)
      assert.match(a.change.id, /^t_[0-9a-z]{7,}$/)
    }
  })
  test('buildContext is idempotent and helpers accept either form', () => {
    const ctx = mkCtx('heating', { eps: [breach()] })
    const built = O.buildContext(ctx)
    assert.equal(O.buildContext(built), built)
    assert.deepEqual(O.proposeFor(built), O.proposeFor(ctx))
    assert.equal(O.qualifying(ctx, 'heating').length, 1)
    assert.equal(O.fresh(built, 'heating').length, 1)
  })
  test('accepts the insights §4.4 shape (full state, window/model as rollup arrays, unitId lookup)', () => {
    const ctx = mkCtx('heating', { eps: [breach()] })
    const rolls = Object.values(ctx.rollups)
    const r = O.proposeFor({ cfg: ctx.cfg, unitId: 'office', state: ctx.state, rollups: null, window: rolls.slice(-14), model: rolls, forecast: null, applyDate: TODAY, analysisDate: D, now: NOW, tz, insightsState: ctx.state.insights })
    assert.deepEqual(decision(r), CHANGE('deltaF', 3, 4, 'R1_DELTA'))
  })
})

// ───────────────────────────── revert / undo / cancel / reset (pure CAS proposals) ─────────────────────────────

describe('user/system mutations as pure proposals (§5.10–§5.12, CAS via tuning.check)', () => {
  const AT = (hhmm, date = TODAY) => tz.zonedToInstant(date, hhmm)
  const iso = (ms) => new Date(ms).toISOString()
  function setup(season) {
    const cfg = baseCfg()
    const unitCfg = cfg.units.find((u) => u.id === 'office')
    const t = tuning.emptyTuning()
    t[season].deltaF = 4
    t[season].leadMin = 150
    t[season].history = [
      { id: 't_a', param: 'deltaF', from: 3, to: 4, at: iso(AT('01:30')), rule: 'R1_DELTA', applyDate: TODAY, analysisDate: D },
      { id: 't_0', param: 'leadMin', from: 120, to: 150, at: iso(AT('01:30', '2026-10-15')), rule: 'R1_LEAD', applyDate: '2026-10-15', analysisDate: '2026-10-14' },
    ]
    const unitState = { tuning: t, auto: { phase: 'idle' } }
    return { cfg, unitCfg, unitState, tz }
  }
  const sign = (season) => (season === 'heating' ? '+' : '−')

  for (const season of SEASONS) {
    test(`revert history[0] → value back, lock + cooldown, next run holds locked; undo within 10 min restores [${season}]`, () => {
      const a = setup(season)
      const now = AT('15:12')
      const rv = O.proposeRevert({ ...a, now, id: 't_a' })
      assert.equal(rv.ok, true, JSON.stringify(rv))
      assert.equal(rv.effect, 'revert')
      assert.deepEqual({ kind: rv.mutation.kind, season: rv.mutation.season, param: rv.mutation.param, from: rv.mutation.from, to: rv.mutation.to, lockDate: rv.mutation.lockDate },
        { kind: 'revert', season, param: 'deltaF', from: 4, to: 3, lockDate: '2026-10-23' })
      assert.equal(rv.message, `Office pre-${season === 'heating' ? 'heat' : 'cool'} back to ${sign(season)}3° · optimizer locked for Fri`)
      assert.equal(rv.undoUntil, iso(now + 10 * 60000))
      tuning.applyMutation(a.unitState.tuning, rv.mutation, now, { cfg: a.cfg, tz })
      const t = a.unitState.tuning
      assert.equal(t[season].deltaF, 3)
      assert.equal(t[season].history[0].id, 't_0')
      assert.deepEqual(t.lockedDates, ['2026-10-23'])
      assert.equal(t.cooldown[`${season}.deltaF.up`], '2026-10-26')
      // reverting it again: already reverted
      assert.deepEqual([O.proposeRevert({ ...a, now, id: 't_a' }).code, O.proposeRevert({ ...a, now, id: 't_a' }).reason], ['superseded', 'reverted'])
      // the next 01:30 run (applyDate Fri) holds `locked`, even with a fresh breach at the reverted value
      const now2 = AT('01:30', '2026-10-23')
      const ctx = mkCtx(season, { now: now2, eps: [breach({ date: TODAY, par: { deltaF: 3, leadMin: 150 } })], tuning: (tt) => Object.assign(tt, structuredClone(t)) })
      assert.equal(O.proposeFor(ctx).hold.code, 'locked')
      // undo within 10 minutes
      const un = O.proposeUndo({ ...a, now: now + 9 * 60000, id: 't_a' })
      assert.equal(un.ok, true, JSON.stringify(un))
      assert.deepEqual({ kind: un.mutation.kind, from: un.mutation.from, to: un.mutation.to }, { kind: 'undo', from: 3, to: 4 })
      tuning.applyMutation(t, un.mutation, now + 9 * 60000, { cfg: a.cfg, tz })
      assert.equal(t[season].deltaF, 4)
      assert.equal(t[season].history[0].id, 't_a')
      assert.deepEqual(t.lockedDates, [])
      assert.equal(t.cooldown[`${season}.deltaF.up`], undefined)
      assert.equal(O.proposeRevert({ ...a, now, id: 't_a' }).ok, true, 'revertable again after the undo')
    })

    test(`undo refusals: window passed ⇒ expired; newer mutation ⇒ superseded; unknown ⇒ not_found [${season}]`, () => {
      const a = setup(season)
      const now = AT('15:12')
      tuning.applyMutation(a.unitState.tuning, O.proposeRevert({ ...a, now, id: 't_a' }).mutation, now, { cfg: a.cfg, tz })
      assert.equal(O.proposeUndo({ ...a, now: now + 11 * 60000, id: 't_a' }).code, 'expired')
      assert.equal(O.proposeUndo({ ...a, now, id: 't_zz' }).code, 'not_found')
      assert.equal(O.proposeUndo({ ...a, now, id: 't_0' }).code, 'superseded') // exists, but is not the last revert
      // a newer change lands after the revert ⇒ the undo is superseded
      const t = a.unitState.tuning
      t[season].history.unshift({ id: 't_b', param: 'leadMin', from: 150, to: 120, at: iso(now + 60000), rule: 'R2_LEAD', applyDate: '2026-10-23', analysisDate: TODAY })
      t[season].leadMin = 120
      assert.equal(O.proposeUndo({ ...a, now: now + 120000, id: 't_a' }).code, 'superseded')
    })

    test(`revert refusals: history[1] ⇒ superseded/newer; value changed since ⇒ superseded/changed; unknown ⇒ not_found [${season}]`, () => {
      const a = setup(season)
      const now = AT('15:12')
      assert.deepEqual([O.proposeRevert({ ...a, now, id: 't_0' }).code, O.proposeRevert({ ...a, now, id: 't_0' }).reason], ['superseded', 'newer'])
      assert.equal(O.proposeRevert({ ...a, now, id: 't_missing' }).code, 'not_found')
      // lowering the max Δ read-time clamps the tuned +4 to +3: the value changed since the change
      a.cfg.optimizer.maxDeltaF = 3
      const r = O.proposeRevert({ ...a, now, id: 't_a' })
      assert.deepEqual([r.ok, r.code, r.reason], [false, 'superseded', 'changed'])
    })

    test(`revert of the pending change = cancel; cancel of anything else ⇒ not_found [${season}]`, () => {
      const a = setup(season)
      const now = AT('06:00')
      a.unitState.tuning.pending = tuning.toPending({ kind: 'change', id: 't_p', season, param: 'deltaF', from: 4, to: 3, applyDate: TODAY, analysisDate: D }, { now, reason: 'in event until 10:00 AM', actor: 'optimizer' })
      const r = O.proposeRevert({ ...a, now, id: 't_p' })
      assert.deepEqual([r.ok, r.effect, r.mutation.kind], [true, 'cancel', 'cancel'])
      tuning.applyMutation(a.unitState.tuning, r.mutation, now, { cfg: a.cfg, tz })
      assert.equal(a.unitState.tuning.pending, null)
      assert.equal(a.unitState.tuning[season].deltaF, 4, 'nothing to undo: the value never changed')
      assert.equal(O.proposeCancel({ ...a, now, id: 't_p' }).code, 'not_found')
    })

    test(`two same-direction reverts within 14 days ⇒ that direction frozen [${season}]`, () => {
      const a = setup(season)
      const t = a.unitState.tuning
      const now = AT('15:12')
      tuning.applyMutation(t, O.proposeRevert({ ...a, now, id: 't_a' }).mutation, now, { cfg: a.cfg, tz })
      // four days later the optimizer raises again, and the user reverts again
      const later = now + 4 * DAY_MS
      tuning.applyMutation(t, { kind: 'change', id: 't_c', season, param: 'deltaF', from: 3, to: 4, applyDate: '2026-10-27', analysisDate: '2026-10-25' }, later, { cfg: a.cfg, tz })
      const rv = O.proposeRevert({ ...a, now: later + HOUR, id: 't_c' })
      assert.equal(rv.ok, true)
      tuning.applyMutation(t, rv.mutation, later + HOUR, { cfg: a.cfg, tz })
      assert.ok(t.frozen[`${season}.up`] > '2026-10-27')
      const ctx = mkCtx(season, { now: AT('01:30', '2026-10-29'), eps: [breach({ date: '2026-10-28', par: { deltaF: 3, leadMin: 150 } })], tuning: (tt) => Object.assign(tt, structuredClone(t)) })
      assert.equal(O.proposeFor(ctx).hold.code, 'frozen')
    })

    test(`reset (user locks the next apply date; base reset does not) and baseResets [${season}]`, () => {
      const a = setup(season)
      const now = AT('15:12')
      const r = O.proposeReset({ ...a, now, season })
      assert.equal(r.ok, true)
      assert.equal(r.message, `Office pre-${season === 'heating' ? 'heat' : 'cool'} reset to the default ${sign(season)}3° from 5:00.`)
      const t1 = structuredClone(a.unitState.tuning)
      tuning.applyMutation(t1, r.mutation, now, { cfg: a.cfg, tz })
      assert.deepEqual([t1[season].deltaF, t1[season].leadMin, t1[season].history.length, t1.lockedDates], [null, null, 0, ['2026-10-23']])
      const next = baseCfg((c) => { c.precondition.deltaF[season] = 4 })
      const state = { units: { office: a.unitState, kitchen: { tuning: tuning.emptyTuning() } } }
      const list = O.baseResets(a.cfg, next, state, { tz, now })
      assert.equal(list.length, 1)
      assert.deepEqual([list[0].unit, list[0].season, list[0].ok, list[0].mutation.lock], ['office', season, true, false])
      assert.equal(list[0].message, `Default pre-${season === 'heating' ? 'heat' : 'cool'} changed to ${sign(season)}4°, so auto-tuned values were cleared.`)
      const t2 = structuredClone(a.unitState.tuning)
      tuning.applyMutation(t2, list[0].mutation, now, { cfg: next, tz })
      assert.deepEqual([t2[season].deltaF, t2[season].history.length, t2.lockedDates], [null, 0, []])
      assert.deepEqual(O.baseResets(a.cfg, baseCfg(), state, { tz, now }), [], 'no base change ⇒ nothing')
    })
  }

  test('property: every ok proposal passes tuning.check and applying it moves exactly to its `to` (300 random states)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed * 7 + 3)
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
      const season = pick(SEASONS)
      const a = setup(season)
      const t = a.unitState.tuning
      if (rnd() < 0.3) t[season].deltaF = pick([3, 4, 5]) // value may have drifted from history[0].to
      if (rnd() < 0.3) a.cfg.optimizer.maxDeltaF = pick([3, 4, 5, 6])
      const now = AT('15:12') + Math.floor(rnd() * 3 * HOUR)
      if (rnd() < 0.5) tuning.applyMutation(t, O.proposeRevert({ ...a, now, id: 't_a' }).mutation ?? { kind: 'cancel', id: 'none' }, now, { cfg: a.cfg, tz })
      const id = pick(['t_a', 't_0', 't_x'])
      const later = now + Math.floor(rnd() * 20 * 60000)
      for (const fn of [O.proposeRevert, O.proposeUndo, O.proposeCancel, O.proposeReset]) {
        const r = fn({ ...a, now: later, id, season: pick([season, null]) })
        if (!r.mutation) { assert.equal(r.ok, false); continue }
        assert.equal(r.ok, tuning.check(a.unitState, r.mutation, { cfg: a.cfg, now: later, tz, unitId: 'office' }) === 'ok', `seed ${seed} ${fn.name}`)
        if (!r.ok || r.mutation.kind === 'reset' || r.mutation.kind === 'cancel') continue
        const t2 = structuredClone(t)
        tuning.applyMutation(t2, r.mutation, later, { cfg: a.cfg, tz })
        assert.equal(tuning.currentValue(a.cfg, a.unitCfg, { tuning: t2 }, r.mutation.season, r.mutation.param), r.mutation.to, `seed ${seed} ${fn.name} lands on to`)
      }
    }
  })
})

// ───────────────────────────── end to end on real rollups ─────────────────────────────

describe('end to end: usage-gen → rollup.js → optimizer', () => {
  async function rollupsFor(outdoor, thermal, days = 10, weekend = false) {
    const cfg = specDefaultConfig()
    cfg.units = [{ id: 'office', name: 'Office', host: 'office.test', order: 0, shed: true, precondition: true }]
    cfg.precondition.superOffPeak = { weekend } // addendum E
    const g = await genDays({ recorder: 'reference', cfg, start: '2026-10-12', days, seed: 11, outdoor, units: [{ id: 'office', mode: 'HEAT', sp: 70, par: { deltaF: 3, leadMin: 120 }, band: [68, 78], thermal, noise: 0.2 }] })
    const rollups = {}
    let prevTail = null
    for (const d of g.dates) {
      const r = await rollupDay({ date: d, records: g.byDate[d] ?? [], cfg: g.cfg, tz, prevTail, builtAt: null })
      rollups[d] = r
      prevTail = r.tail
    }
    const c = structuredClone(g.cfg)
    c.automation.mode = 'live'
    c.optimizer.enabled = true
    c.outdoor.enabled = true
    const state = { scheduleEnabled: true, insights: { optimizerEnabledAt: ENABLED_AT }, units: { office: { tuning: tuning.emptyTuning(), auto: { phase: 'idle' } } } }
    return { cfg: c, unitCfg: c.units[0], unitState: state.units.office, state, rollups, now: NOW, tz, forecast: null }
  }

  test('cold mornings (outdoor 20 °F, leaky room) ⇒ R1 raises one step and the model is confident', async () => {
    // outdoor varies by day so the drift model has x spread
    const outdoor = (ms) => 18 + 3 * (Math.floor((ms - tz.zonedToInstant('2026-10-12', '00:00')) / DAY_MS) % 5)
    const ctx = await rollupsFor(outdoor, { alpha: 0, beta: 0.08, heatFph: 4 })
    const r = O.proposeFor(ctx)
    assert.equal(r.season, 'heating')
    assert.equal(r.change?.kind, 'change', JSON.stringify(r.hold))
    assert.match(r.change.rule, /^R1_/)
    assert.ok(r.change.to > r.change.from)
    assert.equal(tuning.check(ctx.unitState, r.change, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), 'ok')
    assert.equal(r.model.confident, true, JSON.stringify({ n: r.model.n, beta: r.model.beta, r2: r.model.r2, sx: r.model.sigmaX }))
    near(r.model.beta, 0.08, 0.03, 'β recovered')
  })

  test('mild mornings (outdoor 60 °F, tight room) ⇒ R2 lowers one step after 3 fresh comfortable peaks', async () => {
    const ctx = await rollupsFor(() => 60, { alpha: 0, beta: 0.02, heatFph: 4 })
    const E = O.qualifying(ctx, 'heating')
    assert.ok(E.length >= 3)
    assert.ok(E.slice(0, 3).every((e) => e.shed?.class === 'comfortable'), JSON.stringify(E.map((e) => e.shed?.class)))
    const r = O.proposeFor(ctx)
    assert.equal(r.change?.kind, 'change', JSON.stringify(r.hold))
    assert.match(r.change.rule, /^R2_/)
    assert.ok(r.change.to < r.change.from)
    assert.equal(tuning.check(ctx.unitState, r.change, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), 'ok')
  })

  test('the weekend pre-condition on (addendum E E1.15): Saturday/Sunday boundary episodes reach the realisation only — E and the decision are the option-off ones', async () => {
    const off = await rollupsFor(() => 60, { alpha: 0, beta: 0.02, heatFph: 4 })
    const on = await rollupsFor(() => 60, { alpha: 0, beta: 0.02, heatFph: 4 }, 10, true)
    const eps = Object.values(on.rollups).flatMap((r) => r.units.office.episodes)
    const b = (d) => [`${d}@07:00`, 'done', 'pre_only', true]
    assert.deepEqual(eps.filter((e) => e.kind === 'boundary').map((e) => [e.ev, e.status, e.q, !!e.pre]), [b('2026-10-12'), b('2026-10-17'), b('2026-10-18')], 'the Columbus Day holiday and the weekend')
    const ids = (ctx) => O.qualifying(ctx, 'heating').map((e) => e.ev)
    assert.deepEqual(ids(on), ids(off))
    assert.ok(O.realisation(on, 'heating').events.includes('2026-10-18@07:00'), JSON.stringify(O.realisation(on, 'heating').events))
    assert.deepEqual(decision(O.proposeFor(on)), decision(O.proposeFor(off)))
    assert.match(O.proposeFor(on).change.rule, /^R2_/)
  })
})

// ───────────────────────────── property suite (§8.2: 2 000 seeded contexts) ─────────────────────────────

const FORBIDDEN_KEYS = new Set(['tou', 'holidays', 'weekday', 'weekendHoliday', 'shed', 'precondition', 'automation', 'scheduleEnabled', 'skipDate', 'units', 'tuning', 'auto', 'clampF', 'optimizer'])

function keysDeep(o, out = new Set()) {
  if (Array.isArray(o)) for (const v of o) keysDeep(v, out)
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.add(k); keysDeep(v, out) }
  return out
}

/** A random heating-view scenario; buildScenario() turns it into a context for either season. */
function genScenario(seed, { focusR3 = false } = {}) {
  const rnd = mulberry32(seed)
  const chance = (p) => rnd() < p
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const r2 = (x) => Math.round(x * 100) / 100
  const maxDeltaF = int(1, 6)
  const minDeltaF = int(1, maxDeltaF)
  const minLeadMin = pick([20, 30, 45, 60, 90, 120])
  const earliestStart = pick(['02:30', '03:00', '03:30', '04:00', '04:30', '05:00', '05:30', '06:00'].filter((h) => 420 - hhmmToMin(h) >= minLeadMin))
  const marginF = pick([0.5, 1, 1.5, 2])
  const opt = {
    maxDeltaF, minDeltaF, minLeadMin, earliestStart, marginF, comfyMarginF: Math.max(marginF, pick([1, 2, 3])),
    maxStepLeadMin: pick([5, 10, 15, 30]), minDaysBetweenOpposite: int(0, 5), dormantDays: int(1, 4), observeDays: int(0, 5),
  }
  const base = { deltaF: int(1, 6), leadMin: pick([20, 45, 60, 90, 120, 125, 150, 180, 240]) }
  const flags = { mode: chance(0.9) ? 'live' : 'dry-run', optEnabled: chance(0.93), unitEnabled: chance(0.95), outdoor: chance(0.8), shed: chance(0.97), precondition: chance(0.97), scheduleEnabled: chance(0.93) }
  const bandW = int(2, 6)
  const nowMin = chance(0.7) ? 90 : int(0, 1439)
  const now = tz.zonedToInstant(TODAY, nowMin)
  const iso = (ms) => new Date(ms).toISOString()
  const randInstant = (daysBack) => now - Math.floor(rnd() * daysBack * DAY_MS)
  const tun = {
    deltaF: chance(0.4) ? int(1, 6) : null,
    leadMin: chance(0.4) ? pick([30, 60, 90, 95, 120, 150, 180, 210]) : null,
    evidenceFrom: chance(0.5) ? iso(randInstant(20)) : null,
    lastAnalysisDate: chance(0.1) ? D : chance(0.2) ? addDays(D, -int(1, 5)) : null,
    history: chance(0.3) ? [{ id: 't_h', param: pick(['deltaF', 'leadMin']), from: 2, to: 3, at: iso(randInstant(10)), rule: 'R1_DELTA', applyDate: pick([TODAY, addDays(TODAY, 1), addDays(TODAY, -2), addDays(TODAY, -6)]), analysisDate: addDays(D, -int(0, 6)) }] : [],
    lockedDates: chance(0.1) ? [pick([TODAY, addDays(TODAY, 1)])] : [],
    cooldown: chance(0.15) ? { [`${pick(['deltaF', 'leadMin'])}.${pick(['up', 'down'])}`]: addDays(TODAY, int(-2, 4)) } : {},
    frozen: chance(0.1) ? { [pick(['up', 'down'])]: addDays(TODAY, int(-2, 10)) } : {},
    suspended: chance(0.1) ? { since: addDays(D, -3), changeId: 't_s' } : null,
    lastUpAt: chance(0.3) ? addDays(TODAY, -int(0, 6)) : null,
    enabledAt: chance(0.15) ? iso(randInstant(8)) : null,
  }
  const optimizerEnabledAt = chance(0.92) ? iso(randInstant(25)) : null
  const override = () => ({ f: pick(['power', 'temp', 'fan', 'mode']), s: pick(['user', 'external']), comfortDir: chance(0.6), auto: chance(0.2), gap: chance(0.1) ? 400 : null, min: int(0, 170), o: 72, v: 74 })
  const episode = (date, at) => {
    const low = r2(60 + rnd() * 15)
    return {
      date, at,
      par: chance(0.7) ? 'cur' : { deltaF: int(1, 6), leadMin: pick([60, 90, 120, 150]) },
      cls: pick(['violated', 'tight', 'ok', 'comfortable', 'comfortable', 'unknown']),
      low, high: r2(low + rnd() * 6), m: r2(rnd() * 5 - 1), cov: pick([0.3, 0.7, 0.95]),
      status: pick(['done', 'done', 'done', 'released', 'was_off', 'skipped', 'absent', 'dry']),
      reached: chance(0.5), eff: pick([null, 0.2, 0.5, 0.7, 0.9, 1.2]), T0: r2(66 + rnd() * 6), Tpk: r2(68 + rnd() * 6),
      rmbp: pick([0, 20, 45, 60, 90]), capped: chance(0.15), orig: int(64, 76),
      tout: r2(15 + rnd() * 55), rBar: r2(66 + rnd() * 8), b: r2(-2.5 + rnd() * 3), driftOk: chance(0.5),
      flat: chance(0.1), jump: chance(0.1), failing: chance(0.04) ? 1 : 0,
      overrides: Array.from({ length: pick([0, 0, 0, 1, 2]) }, override),
    }
  }
  const eps = []
  for (let i = 0; i < 14; i++) {
    const date = addDays(D, -i)
    if (chance(0.75)) eps.push(episode(date, '07:00'))
    if (chance(0.3)) eps.push(episode(date, '17:00'))
  }
  // model-window mornings/evenings with a physical drift model (sometimes non-physical)
  const alpha = -0.5 + rnd()
  const beta = chance(0.7) ? 0.01 + rnd() * 0.08 : -0.02 + rnd() * 0.02
  for (let i = 3; i < 45; i++) {
    if (!chance(0.3)) continue
    const tout = r2(15 + rnd() * 50)
    const rBar = r2(66 + rnd() * 8)
    eps.push({ ...episode(addDays(D, -i), chance(0.5) ? '07:00' : '17:00'), tout, rBar, b: r2(alpha + beta * (tout - rBar) + (rnd() - 0.5) * 0.2), driftOk: true, flat: false, jump: false })
  }
  const days = {}
  for (let i = 0; i < 45; i++) {
    const d = addDays(D, -i)
    const on = chance(0.12) ? 0 : int(0, 600)
    const r = rnd()
    days[d] = { on, cov: pick([0.3, 0.55, 0.7, 0.95, 1]), modeMin: r < 0.08 ? { FAN: 200 } : r < 0.14 ? { opp: 250, main: 50 } : r < 0.2 ? { main: 100, opp: 100 } : undefined }
  }
  // a comfortable streak on the three newest mornings (exercises R2 and its blocks)
  if (chance(0.3)) {
    for (const date of [D, addDays(D, -1), addDays(D, -2)]) {
      const i = eps.findIndex((e) => e.date === date && e.at === '07:00')
      const e = { ...episode(date, '07:00'), par: 'cur', cls: 'comfortable', cov: 0.95, status: 'done', flat: false, jump: chance(0.1), failing: 0, overrides: chance(0.9) ? [] : [override()] }
      if (i >= 0) eps[i] = e
      else eps.push(e)
    }
  }
  if (chance(0.12)) for (let i = 0; i < opt.dormantDays; i++) days[addDays(D, -i)] = { on: 0, cov: 0.9 }
  if (tun.suspended && chance(0.5)) days[D] = { on: int(60, 400), cov: 0.9 }
  const forecast = chance(0.7) ? { temp: r2(chance(0.4) ? -10 + rnd() * 30 : 5 + rnd() * 65), agoH: pick([0.5, 1, 3, 5.9, 6.5, 8]), until: chance(0.9) ? null : '09:00' } : null
  const sc = { opt, base, flags, bandW, now, tun, optimizerEnabledAt, eps, days, forecast, beps: boundaryEps(seed, eps) }
  if (focusR3) {
    // live, enabled, unlocked, a confident physical model and a usable (often cold) forecast: R3 / veto territory
    Object.assign(sc.flags, { mode: 'live', optEnabled: true, unitEnabled: true, outdoor: true, shed: true, precondition: true, scheduleEnabled: true })
    Object.assign(sc.tun, { lastAnalysisDate: null, history: [], lockedDates: [], suspended: null, evidenceFrom: null, enabledAt: null })
    sc.optimizerEnabledAt = new Date(now - 20 * DAY_MS).toISOString()
    const a = -0.3 + rnd() * 0.6
    const b = 0.02 + rnd() * 0.06
    for (let i = 3; i < 13; i++) {
      const tout = r2(10 + rnd() * 50)
      sc.eps.push({ ...episode(addDays(D, -i), '17:00'), tout, rBar: 70, b: r2(a + b * (tout - 70)), driftOk: true, flat: false, jump: false })
    }
    for (let i = 0; i < 3; i++) sc.days[addDays(D, -i)] = { on: 300, cov: 0.95 }
    sc.forecast = { temp: r2(-15 + rnd() * 70), agoH: 1, until: null }
  }
  return sc
}

/**
 * Addendum E: the weekend boundary episodes of a scenario's 45 days (option on only), drawn from their own stream so
 * the peak scenario of a seed is the same with the option on or off. Never a failing job (see the J25-style check),
 * never on a date whose synthetic scenario has a 07:00 peak episode (real ids never collide, E1.17).
 */
function boundaryEps(seed, peaks) {
  const rnd = mulberry32((seed ^ 0x2e4f1a7) >>> 0)
  const chance = (p) => rnd() < p
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const r2 = (x) => Math.round(x * 100) / 100
  const out = []
  for (let i = 0; i < 45; i++) {
    const date = addDays(D, -i)
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay()
    if ((dow !== 0 && dow !== 6) || !chance(0.7) || peaks.some((e) => e.date === date && e.at === '07:00')) continue
    out.push({
      date, at: '07:00', kind: 'boundary', par: chance(0.7) ? 'cur' : { deltaF: pick([2, 3, 4]), leadMin: pick([90, 120, 150]) },
      status: pick(['done', 'done', 'released', 'dry']), reached: chance(0.5), eff: pick([null, 0.3, 0.6, 0.9, 1.2]),
      T0: r2(66 + rnd() * 6), Tpk: r2(68 + rnd() * 6), capped: chance(0.1), orig: pick([68, 70, 72]), preFromOff: chance(0.3),
      overrides: chance(0.2) ? [{ f: 'temp', s: 'external', comfortDir: true, min: -60 }] : [], failing: 0,
    })
  }
  return out
}

/** Property-check one heating-view scenario in both seasons (returns the heating result); `weekend` = the addendum E option. */
function checkScenario(sc, seed, weekend = false) {
  const out = {}
  for (const season of SEASONS) {
    const label = `seed ${seed} ${season}${weekend ? ' weekend' : ''}`
    const ctx = buildScenario(sc, season, weekend)
    const { tz: z, ...rest } = ctx
    deepFreeze(rest) // any attempt to mutate the input throws (strict-mode ES module)
    const r = O.proposeFor(ctx)
    assert.deepEqual(O.proposeFor(ctx), r, `${label}: pure`)
    checkInvariants(r, ctx, label)
    out[season] = r

    // forecast never drives a decrease; R3 only raises
    const ch = r.change
    const isDown = !!ch && ch.kind === 'change' && ch.to < ch.from
    const r0 = O.proposeFor({ ...ctx, forecast: null })
    const down0 = !!r0.change && r0.change.kind === 'change' && r0.change.to < r0.change.from
    if (isDown) assert.deepEqual(decision(r0), decision(r), `${label}: a decrease must not depend on the forecast`)
    if (!down0) assert.ok(!isDown, `${label}: forecast created a decrease`)
    if (ch?.rule === 'R3') assert.ok(ch.to > ch.from)

    // no double step from the same analysisDate: apply (the commit check passed above) and rerun
    if (ch && !r.observe) {
      const unitState = structuredClone(ctx.unitState)
      const state = { ...structuredClone(ctx.state), units: { office: unitState } }
      tuning.applyMutation(unitState.tuning, ch, ctx.now, { cfg: ctx.cfg, tz })
      const again = O.proposeFor({ ...ctx, unitState, state })
      assert.equal(again.change, null, `${label}: second step from the same analysisDate ${JSON.stringify(decision(again))}`)
    }
  }
  // heating/cooling mirror: identical decision
  assert.deepEqual(decision(out.cooling), decision(out.heating), `seed ${seed}: mirror`)
  assert.deepEqual(out.cooling.signals, out.heating.signals, `seed ${seed}: mirror signals`)
  assert.equal(out.cooling.observe, out.heating.observe, `seed ${seed}: mirror observe`)
  return out.heating
}

/**
 * Addendum E E1.15, J25: the option on (with weekend boundary episodes) decides like the option off unless the
 * realisation or G7 could see a boundary episode — with no forecast (no R3, no veto) and no failing job, never.
 */
function checkWeekend(sc, seed) {
  const off = checkScenario(sc, seed)
  const on = checkScenario(sc, seed, true)
  if (sc.forecast == null && !sc.eps.some((e) => e.failing)) {
    assert.deepEqual(decision(on), decision(off), `seed ${seed}: boundary episodes are never evidence`)
    assert.deepEqual(on.signals, off.signals, `seed ${seed}: signals`)
  }
  return off
}

function buildScenario(sc, season, weekend = false) {
  const cfg = baseCfg((c) => {
    Object.assign(c.optimizer, sc.opt)
    c.optimizer.enabled = sc.flags.optEnabled
    c.optimizer.units.office = { enabled: sc.flags.unitEnabled, comfortLowF: 73 - sc.bandW, comfortHighF: 73 + sc.bandW, sensorOffsetF: 0 }
    c.precondition.deltaF = { heating: sc.base.deltaF, cooling: sc.base.deltaF }
    c.precondition.leadMin = { heating: sc.base.leadMin, cooling: sc.base.leadMin }
    c.automation.mode = sc.flags.mode
    c.outdoor.enabled = sc.flags.outdoor
    const u = c.units.find((x) => x.id === 'office')
    u.shed = sc.flags.shed
    u.precondition = sc.flags.precondition
    c.precondition.superOffPeak = { weekend }
  })
  const t = tuning.emptyTuning()
  Object.assign(t[season], { deltaF: sc.tun.deltaF, leadMin: sc.tun.leadMin, evidenceFrom: sc.tun.evidenceFrom, lastAnalysisDate: sc.tun.lastAnalysisDate, history: structuredClone(sc.tun.history) })
  t.lockedDates = [...sc.tun.lockedDates]
  for (const [k, v] of Object.entries(sc.tun.cooldown)) t.cooldown[`${season}.${k}`] = v
  for (const [k, v] of Object.entries(sc.tun.frozen)) t.frozen[`${season}.${k}`] = v
  t.suspended = sc.tun.suspended ? { ...sc.tun.suspended } : null
  t.lastUpAt = sc.tun.lastUpAt
  t.enabledAt = sc.tun.enabledAt
  const unitCfg = cfg.units.find((u) => u.id === 'office')
  const unitState = { tuning: t, auto: { phase: 'idle' } }
  const cur = tuning.effectivePrecondition(cfg, unitCfg, unitState, season)
  const state = { scheduleEnabled: sc.flags.scheduleEnabled, insights: { optimizerEnabledAt: sc.optimizerEnabledAt }, units: { office: unitState } }
  const eps = [...sc.eps, ...(weekend ? sc.beps : [])].map((e) => ep(season, { ...e, par: e.par === 'cur' ? { deltaF: cur.deltaF, leadMin: cur.leadMin } : e.par, dryRun: e.status === 'dry' }))
  const rollups = mkRollups(season, eps, { days: sc.days, end: D })
  const forecast = sc.forecast ? mkForecast(season, sc.forecast, sc.now) : null
  return { cfg, unitCfg, unitState, state, rollups, forecast, now: sc.now, tz }
}

function checkInvariants(r, ctx, label) {
  const msg = (m) => `${label}: ${m} — ${JSON.stringify({ d: decision(r), ch: r.change })}`
  assert.ok(['change', 'proposed', 'hold', 'guardrail'].includes(r.mode), msg('mode'))
  assert.equal(r.hold === null, r.mode === 'change' || r.mode === 'proposed', msg('hold ⇔ mode'))
  assert.equal(r.change === null, r.hold !== null, msg('hold ⇒ no change'))
  if (r.mode === 'proposed') assert.equal(r.observe, true, msg('proposed ⇒ observe'))
  if (r.hold) assert.ok(O.HOLD_CODES.includes(r.hold.code), msg('hold code'))
  for (const k of keysDeep(r)) assert.ok(!FORBIDDEN_KEYS.has(k), msg(`forbidden key ${k}`))
  const ch = r.change
  if (!ch) return
  assert.ok(O.CHANGE_PARAMS.includes(ch.param), msg('param'))
  const boundaryIds = new Set(Object.values(ctx.rollups).flatMap((d) => d.units.office.episodes).filter((e) => e.kind === 'boundary').map((e) => e.ev))
  for (const id of ch.evidence?.events ?? []) assert.ok(!boundaryIds.has(id), msg(`a boundary episode (${id}) is never evidence (E1.15)`))
  assert.ok(O.RULES.includes(ch.rule), msg('rule'))
  assert.equal(ch.unit, 'office')
  assert.equal(ch.applyDate, tuning.nextApplyDate(ctx.cfg, tz, ctx.now), msg('applyDate'))
  assert.equal(ch.analysisDate, addDays(tz.localParts(ctx.now).date, -1), msg('analysisDate'))
  assert.equal(typeof ch.rationale, 'string')
  assert.ok(ch.rationale.length > 10 && !/undefined|NaN|null/.test(ch.rationale), msg('rationale'))
  if (ch.param === 'suspended') {
    assert.ok((ch.kind === 'suspend' && ch.from === false && ch.to === true) || (ch.kind === 'resume' && ch.from === true && ch.to === false), msg('suspend shape'))
  } else {
    assert.equal(ch.kind, 'change')
    const g = tuning.guardrails(ctx.cfg)
    assert.equal(ch.from, tuning.currentValue(ctx.cfg, ctx.unitCfg, ctx.unitState, ch.season, ch.param), msg('CAS from'))
    assert.notEqual(ch.to, ch.from, msg('moves'))
    if (ch.param === 'deltaF') {
      assert.ok(Math.abs(ch.to - ch.from) <= 1 + 1e-9, msg('|ΔdeltaF| ≤ 1'))
      assert.ok(ch.to >= Math.max(1, g.minDeltaF) && ch.to <= Math.min(6, g.maxDeltaF), msg('deltaF bounds'))
    } else {
      assert.ok(Math.abs(ch.to - ch.from) <= Math.min(30, ctx.cfg.optimizer.maxStepLeadMin) + 1e-9, msg('|ΔleadMin| ≤ 30'))
      assert.equal(ch.to % 5, 0, msg('5-minute grid'))
      assert.ok(ch.to >= Math.max(20, g.minLeadMin) && ch.to <= 240, msg('leadMin bounds'))
      assert.ok((g.peakStartMin ?? 420) - ch.to >= g.earliestStartMin, msg('preStart ≥ earliestStart'))
    }
    if (ch.rule.startsWith('R2')) assert.ok(ch.to < ch.from, msg('R2 lowers'))
    else assert.ok(ch.to > ch.from, msg('R1/R3/R5 raise'))
  }
  // the commit-time re-check agrees (§5.9): proposals are refused as observe, everything else is ok
  const expected = r.observe && ch.kind !== 'resume' ? 'observe' : 'ok'
  assert.equal(tuning.check(ctx.unitState, ch, { cfg: ctx.cfg, state: ctx.state, now: ctx.now, tz }), expected, msg('tuning.check'))
}

describe('property: 2 000 seeded contexts (+ cooling mirror, + the weekend pre-condition on and off)', () => {
  test('scope, guardrails, purity, CAS, freshness, forecast-never-decreases, heating/cooling mirror, boundary episodes never evidence', () => {
    const N = 2000
    const tally = { change: 0, proposed: 0, hold: 0, guardrail: 0, R3: 0, down: 0, up: 0, suspend: 0, resume: 0, lead: 0 }
    for (let seed = 1; seed <= N; seed++) {
      const r = checkWeekend(genScenario(seed), seed)
      const ch = r.change
      tally[r.mode]++
      if (ch?.rule === 'R3') tally.R3++
      if (ch?.kind === 'suspend') tally.suspend++
      if (ch?.kind === 'resume') tally.resume++
      if (ch?.param === 'leadMin') tally.lead++
      if (ch && ch.kind === 'change') tally[ch.to < ch.from ? 'down' : 'up']++
    }
    if (process.env.OPT_TALLY) console.log(JSON.stringify(tally))
    for (const k of ['change', 'proposed', 'hold', 'guardrail', 'R3', 'down', 'up', 'suspend', 'resume', 'lead']) assert.ok(tally[k] > 0, `branch ${k} never exercised: ${JSON.stringify(tally)}`)
  })

  test('R3 focus: 500 contexts with a confident model and a usable forecast', () => {
    const tally = { R3: 0, veto: 0, down: 0, other: 0 }
    for (let seed = 10001; seed <= 10500; seed++) {
      const r = checkWeekend(genScenario(seed, { focusR3: true }), seed)
      if (r.change?.rule === 'R3') tally.R3++
      else if (r.hold?.code === 'veto') tally.veto++
      else if (r.change && r.change.to < r.change.from) tally.down++
      else tally.other++
    }
    if (process.env.OPT_TALLY) console.log(JSON.stringify(tally))
    assert.ok(tally.R3 >= 20 && tally.veto >= 5, JSON.stringify(tally))
  })
})
