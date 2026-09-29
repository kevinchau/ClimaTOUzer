// optimizer.js — the auto-optimizer's PURE decision layer (addendum §5.3–§5.8, §5.13, §7.1).
//
// No I/O, no clock (every `now` is passed in), no randomness, never mutates its input, never uses
// process-local Date getters (local dates/labels come from the injected `tz`, tz.js). It never
// commands a device and never writes anything: it only PROPOSES one precondition-parameter step per
// unit per analysis date. The host applies a proposal (the reference app: insights.mutate() → engine.commit()),
// and its synchronous commit re-checks everything with tuning.check() (§5.9). Every non-observe change
// proposeFor() returns passes tuning.check() against the same state (property-tested).
//
// ── Context (§4.4 buildContext) ───────────────────────────────────────────────────────────────────
// proposeFor(ctx) and the helpers accept either a raw context or the object buildContext() returns
// (building is idempotent). Raw context fields:
//   cfg            full config (tou, precondition, optimizer, outdoor, insights, automation, units)
//   unitCfg        cfg.units[i] (or pass unitId / unit and it is looked up in cfg.units)
//   unitState      state.units[id] (tuning, auto…); defaults to state.units[id]
//   state?         full state — scheduleEnabled and insights are read from it when present
//   scheduleEnabled?  G2 input when `state` is not passed. When neither is given it is assumed true:
//                  the commit-time tuning.check() is the authoritative G2 guard (§5.9).
//   insightsState? state.insights (optimizerEnabledAt); defaults to state.insights
//   rollups        {date: DailyRollup|null} | Map | [DailyRollup] covering the model window
//   window?        report window: [date] | [DailyRollup] | n days (default cfg.insights.windowDays = 14)
//   model?         model window:  [date] | [DailyRollup] | n days (default cfg.insights.modelDays = 45)
//                  Both windows end at analysisDate unless given explicitly as date/rollup arrays.
//   forecast?      {fetchedAt (ISO|ms), hourly:[{t (s|ms), f °F}]} | null   (weather.forecast())
//   now            epoch ms (or ISO)          tz   makeTz() instance (default: cfg.timezone)
//   analysisDate?  D = the last closed local day (default: yesterday of `now`)
//   applyDate?     tuning.nextApplyDate(cfg, tz, now) by default
//   baseChangedAt? optional extra lower bound for evidence freshness (§5.4)
//
// ── Output of proposeFor (§7.1; `mode` and `model` are additive — a host's report reads both) ─────────
// { unit, season, observe, mode:'change'|'proposed'|'hold'|'guardrail',
//   hold:{code, text}|null,                       // §5.13 code + explain.js holdText()
//   signals:{R1, R5, R3, R2:bool, R4:'dormant'|'wake'|null, sensor:bool},
//   change:{id, kind:'change'|'suspend'|'resume', unit, season, param:'deltaF'|'leadMin'|'suspended',
//           from, to, applyDate, analysisDate, rule, rationale, evidence, since?}|null,
//   suggestion:{text}|null,                        // at_limit card (§5.7), worded per trigger R1/R5/R3
//   model: fitDriftModel() output | null }
// Invariants (test/optimizer.test.js property suite): change.param ∈ {deltaF, leadMin, suspended};
// `from` is the current effective value (tuning.currentValue — the CAS "current"); |ΔdeltaF| ≤ 1,
// |ΔleadMin| ≤ min(30, maxStepLeadMin); deltaF ∈ [minDeltaF, maxDeltaF] ∩ [1, 6]; leadMin on the
// 5-minute grid within [minLeadMin, peakStart − earliestStart] ∩ [20, 240]; hold/guardrail ⇒ change
// null; at most one change per (unit, season, analysisDate) and per applyDate; the forecast (R3) can
// only raise or veto, never cause a decrease; heating and cooling are one signed code path (s = ±1).
//
// ── Decision order (§5.6; first match wins) ──────────────────────────────────────────────────────
//   R4b resume (bypasses G1/G2, observe and the lock, like tuning.check) → G1 off → G2 not_live
//   → suspended → G5 locked → R4a dormant → G3 no_season → G6 already → G7 low_data
//   → UP (R1 > R5 > R3) → forced_by_master / learning (|F| = 0)
//   → R2 DOWN (need_n/tight · sensor · hysteresis · frozen · veto · guardrail · cooldown).
//   Disabling auto-tune (G1) freezes tuned deltaF/leadMin but never a dormancy pause: R4b still resumes.
//   Observe (§5.8) never changes the decision; it turns a change into a proposal (mode 'proposed').
//
// Interpretations recorded in the file (see the task's deviations for the full list):
//   • G6 also holds `already` when tuning[s].history[0].applyDate ≥ applyDate (one step per applyDate:
//     a manual afternoon run for tomorrow followed by tomorrow's 01:30 run cannot both step).
//   • R3 is off when the season's evidence bound (evidenceFrom) is after the end of D: the parameters
//     were changed after the analysed day (resume/revert/reset/change), so D's analysis is stale.
//   • Overrides flagged `auto` (probable HomeKit automation) are "surfaced, not counted" (§4.6) for R1
//     and R5 alike; ANY comfort-direction override (auto or not) blocks R2.
//   • G7 "latest episode" = the unit's latest precondition-event episode in the window (any status).
//   • The R3 veto compares the UNCLAMPED requirement ceil(Δ* − 0.25) (requiredDelta().deltaCeil) with
//     cur.deltaF, not the clamped Δ*int of §5.6's text: Δ*int is clamped up to minDeltaF, so at
//     Δ = minDeltaF it would veto every decrease (even Δ* < 0), the κ failure §0.1 dropped. R3 keeps
//     the clamped Δ*int (it can never ask for more than maxDeltaF).
//
// Release 4 evidence (addenda B F3 §0.5 C-3/C-10, C C6.3, D X1):
//   • forcedByMaster(ep): an episode with a forced interval (rollup C6.1) over [preStart ?? peakStart, peakEnd) whose mode
//     is of another season than the episode's, or Fan/Auto (a same-season substitution never counts) — the morning was
//     the master's decision. Such episodes leave E (qualifying), the realisation sample and the drift fit; when the
//     newest precondition episode of the window is one and F is empty the hold is forced_by_master, not learning.
//   • An episode with preSkipped set (incl. 'already conditioned': no pre-conditioning ran) leaves E and the realisation
//     sample (it stays in the drift fit): a morning where nothing was done says nothing about Δ.
//   • preFromOff (the precondition turned the unit on for an entry, its realisation measured from the scheduled
//     setpoint): E keeps the newest qualifying episode's regime only, and the realisation takes F[0]'s.
//   • X1: a change's "from …" label clamps the start to earliestStart only when the lead is (or becomes) tuned.
//   • X1.2: a CONFIGURED lead longer than peakStart − earliestStart is never tuned (the validator's warning): UP cannot
//     grow it and DOWN never picks it — not even when one step would land back inside — so DOWN steps Δ (else guardrail).
//
// Release 4.2 evidence (Addendum F rule 10, D-check-6):
//   • A replanned episode (rollup: a keep-mode entry's precondition re-planned for a new season before anything was
//     sent — its preStart is the re-plan instant, so leadUsed never tested par.leadMin and a missed target would be a
//     false R1_LEAD) leaves E (qualifying — so F, every UP/DOWN rule and its evidence). The drift fit keeps it (its shed
//     is an ordinary one) and so does the realisation (T0 and eff over the lead it did run are the room's physics) —
//     unless, re-planned out of an unknown season, it carries that morning's season_unknown notice (preSkipped).
//     The per-mode setpoint a forced mode change brings back (F rule 12) needs nothing here: the mirror never copies
//     `recalled`, and a morning forced by the master is already out of E (forcedByMaster).
//
// Release 4.3 evidence (Addendum H, A §4.6 / §5.4 — the house modes; rollup Episode.away, UnitRollup.away):
//   • An away episode (the house was on Left Home or Vacation over its nominal window, the return included) leaves E
//     (qualifying — so F, every UP/DOWN rule and its evidence: a 61° floor or a missing pre-condition says nothing about
//     Δ or the lead) and the realisation sample (a return inside the window is no pre-heat). The drift fit KEEPS it:
//     Newton cooling does not know who is home.
//   • R4a (dormancy) never counts a day the unit was away (UnitRollup.away): a unit idle through a Vacation was not
//     unused — its pre-conditioning is not paused behind the person's back, to wait for a resume after the return.
//
// Release 4.1 evidence (addendum E E1.15 — the weekend pre-condition's boundary episodes, rollup kind 'boundary'):
//   • A boundary episode (a weekend/holiday pre-condition toward the super off-peak → off-peak step, no shed) is never E
//     (qualifying/takesPart — so never F, R1/R2/R5 or any step's evidence: those rules read the shed's comfort class,
//     breach and overrides, which it does not have) and never a drift point (the fit's filter says so explicitly).
//   • The realisation (zPre, eff̂) KEEPS it: T0 before the bump and eff = rise/dApp over the lead are the same
//     measurement a weekday makes, parameter-independent physics of the room (same preSkipped / forced / preFromOff
//     rules). detectSeason keeps reading its take sign; G7's latest precondition episode may be one (a failing job
//     is a failing job); the forced_by_master hold judges the newest PEAK episode.
//   • R3's forecast window is the apply date's first pre-conditioning PEAK — a boundary event has no peak hours.
//
// The water season (reference-app Addendum G G1.11, G1.12; a host's hot-water tank — the core knows no unit kind):
//   • detectSeason returns 'water' for a unit whose latest participating episode says so (rollup's season 'water').
//   • E: a tank pre-heats before every peak — its episode takes part when it has `par`, whatever the event's flag; an
//     episode with q 'no_sensor' (neither a tank reading nor a hot-water level) is never E. With no fresh episode and
//     the newest water episode 'no_sensor', the hold is 'no_sensor'.
//   • No drift model (fitDriftModel fits heating / cooling only), so no R3 and no veto; the realisation reads the tank.
//   • R1 on the breach evidence: shed.floorMin > 0 (at or below water.comfortMinF) or shed.lowMin > 0 (hot water
//     'low'), or a comfort override during the shed; R2 after 3 comfortable peaks: floorMin 0, lowMin 0 and the class
//     comfortable (or, with no reading, a level). The guardrails are tuning.guardrails(cfg, 'water') (Δ 5–25 by 5,
//     water.earliestStart, every peak); stepFor steps Δ by water.tune.stepDeltaF and R1 never proposes Δ above
//     ceilingF − median(original) (J32; ctx.ceilingF — input.ceilingF, the host's kinds.ceilingF, else
//     min(water.maxSetpointF, 125 | 140 with water.mixingValve)); at the ceiling the hold is at_limit with the
//     scald-limit suggestion. clampStep reads guardrails.season 'water': Δ ≤ min(30, maxDeltaF), a step ≤ its step.
//   • The evidence band of a water change is [water.comfortMinF, ceilingF] ("floor 105°").
//
// ── User/system mutations as pure proposals (§5.10–§5.12) ────────────────────────────────────────
// proposeRevert / proposeUndo / proposeCancel / proposeReset / baseResets build the mutation objects
// insights.mutate() commits, with the CAS fields tuning.check() verifies, and pre-verify them with
// that same check (single source of truth). Each returns
//   {ok, code:'ok'|'not_found'|tuning refusal ('superseded'|'expired'|…), reason, effect, mutation|null,
//    message, undoUntil?}
// A revert of the PENDING change is a cancel (effect 'cancel'); nothing is ever applied here.

import { addDays as addDaysStr, hhmmToMin, makeTz } from './tz.js'
import * as tou from './tou.js'
import { median, mean, ols } from './stats.js'
import { check as tuningCheck, currentValue, effectivePrecondition, emptyTuning, guardrails as tuningGuardrails, nextApplyDate, observeInfo, seasonOf, UNDO_WINDOW_MS } from './tuning.js'
import * as T from './explain.js'

export const HOLD_CODES = Object.freeze(['off', 'not_live', 'no_season', 'learning', 'forced_by_master', 'low_data', 'locked', 'already', 'tight', 'need_n', 'cooldown', 'hysteresis', 'veto', 'sensor', 'at_limit', 'frozen', 'suspended', 'guardrail', 'no_sensor'])
export const RULES = Object.freeze(['R1_DELTA', 'R1_LEAD', 'R5', 'R3', 'R2_DELTA', 'R2_LEAD', 'R4A', 'R4B'])
export const CHANGE_PARAMS = Object.freeze(['deltaF', 'leadMin', 'suspended'])

// §5 thresholds (fixed by the spec; the configurable ones come from cfg.optimizer)
const R2_NEED = 3 // fresh comfortable episodes for a decrease
const R5_DAYS = 2 // distinct event days with comfort overrides
const R5_LOOK = 5 // among F[0..4]
const SEASON_LOOK_DAYS = 3 // §5.3
const MODEL_MIN_N = 5
const MODEL_MIN_R2 = 0.3
const MODEL_MIN_SIGMA_X = 2
const BETA_EXP_MIN = 0.01 // §5.5: exponential solution only when β ≥ 0.01
const FORECAST_TTL_MS = 6 * 3600 * 1000
const FORECAST_STEP_MS = 15 * 60 * 1000
const FORECAST_MAX_GAP_MS = 3 * 3600 * 1000
const RESUME_ON_MIN = 60 // R4b
const DORMANT_COV = 0.5 // R4a
const LOW_DATA_COV = 0.6 // G7
const COMFY_COV = 0.6 // R2
const EFF_DEFAULT = 0.7
const EFF_MIN = 0.3
const EFF_MAX = 1.0
const REAL_N = 5 // realisation: last 5 same-season episodes
const R3_COLDER = 2 // °F colder than any handled fresh morning
const LEAD_EFF_MAX = 0.6 // UP: lead first when the bump was not realised
const EARLY_MIN = 45 // DOWN: lead first when reached ≥ 45 min before the peak
const HARD_DELTA = [1, 6]
const WATER_HARD_MAX = 30 // the tank's Δ (validate: water.tune.maxDeltaF 10–30)
const HARD_LEAD = [20, 240]
const LEAD_STEP_CAP = 30
const DEFAULT_BAND = [68, 78]
const DEFAULT_CLAMP = { coolingMin: 65, heatingMax: 76 }
const BUILT = Symbol('optimizer.ctx')

// ───────────────────────────── small helpers (pure) ─────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const numOr = (v, d) => (isNum(v) ? v : d)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const round1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 + 0 : null)
const round2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 + 0 : null)
const sgn = (season) => (season === 'cooling' ? -1 : 1)
const floor5 = (x) => Math.floor(x / 5 + 1e-9) * 5
const ceil5 = (x) => Math.ceil(x / 5 - 1e-9) * 5
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toMs(v) {
  if (isNum(v)) return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN }
  return NaN
}

const ZONED_ISO_RE = /(?:[zZ]|[+-]\d\d:?\d\d)$/

/** Instants inside rollups/episodes are epoch SECONDS; forecasts may be s, ms or zoned ISO. → ms. */
function secToMs(t) {
  if (typeof t === 'string' && ZONED_ISO_RE.test(t)) { const ms = Date.parse(t); return Number.isFinite(ms) ? ms : NaN }
  const x = Number(t)
  if (!Number.isFinite(x)) return NaN
  return x > 1e11 ? x : x * 1000
}

const tzCache = new Map()
function tzFor(cfg, tz) {
  if (tz && typeof tz.localParts === 'function') return tz
  const zone = typeof cfg?.timezone === 'string' && cfg.timezone ? cfg.timezone : 'America/Los_Angeles'
  let z = tzCache.get(zone)
  if (!z) { z = makeTz(zone); tzCache.set(zone, z) }
  return z
}

function addDays(tz, date, n) { return typeof tz?.addDays === 'function' ? tz.addDays(date, n) : addDaysStr(date, n) }

function dateRange(tz, end, n) {
  const out = []
  if (typeof end !== 'string' || !DATE_RE.test(end)) return out
  const k = Math.max(0, Math.floor(n))
  for (let i = k - 1; i >= 0; i--) out.push(addDays(tz, end, -i))
  return out
}

function localDate(tz, v) {
  if (typeof v === 'string' && DATE_RE.test(v)) return v
  const ms = toMs(v)
  return Number.isFinite(ms) ? tz.localParts(ms).date : null
}

function weekday(tz, date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return ''
  try { return tz.formatLocal(tz.zonedToInstant(date, '12:00'), 'weekday') } catch { return date }
}

function safeMin(hhmm, fallback) {
  try { return hhmmToMin(hhmm) } catch { return fallback }
}

/** Deterministic change id (FNV-1a 32 → base36): same proposal ⇒ same id (proposeFor stays pure). */
function changeId(parts) {
  let h = 0x811c9dc5
  const s = parts.map((p) => (p === undefined ? '' : String(p))).join('|')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `t_${h.toString(36).padStart(7, '0')}`
}

/** 'Mon' / 'today' / 'tomorrow' for a local date relative to `today`. */
function dayWord(tz, today, date) {
  if (date === today) return 'today'
  if (today && date === addDays(tz, today, 1)) return 'tomorrow'
  return weekday(tz, date)
}

/** "7–10 AM" / "5–8 PM" / "11 AM–2 PM" for [a, b) epoch ms. */
function rangeLabel(tz, a, b) {
  const p = (ms) => {
    const lp = tz.localParts(ms)
    const h12 = lp.hour % 12 === 0 ? 12 : lp.hour % 12
    return { t: lp.minute ? `${h12}:${String(lp.minute).padStart(2, '0')}` : `${h12}`, ap: lp.hour < 12 ? 'AM' : 'PM' }
  }
  const x = p(a)
  const y = p(b)
  return x.ap === y.ap ? `${x.t}–${y.t} ${y.ap}` : `${x.t} ${x.ap}–${y.t} ${y.ap}`
}

function splitSentence(text) {
  const s = String(text ?? '')
  const i = s.indexOf('. ')
  return i < 0 ? [s, ''] : [s.slice(0, i + 1), s.slice(i + 2)]
}

// ───────────────────────────── context ─────────────────────────────

function rollupMap(...sources) {
  const m = new Map()
  const put = (r, key) => { if (r && typeof r === 'object') m.set(key ?? r.date, r) }
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    if (src instanceof Map) { for (const [k, v] of src) if (v) put(v, k) } else if (Array.isArray(src)) { for (const r of src) if (isObj(r) && typeof r.date === 'string') put(r) } else { for (const [k, v] of Object.entries(src)) if (v) put(v, k) }
  }
  return m
}

function windowDates(tz, spec, end, n) {
  if (Array.isArray(spec)) {
    const ds = spec.map((x) => (typeof x === 'string' ? x : isObj(x) ? x.date : null)).filter((d) => typeof d === 'string' && DATE_RE.test(d))
    return [...new Set(ds)].sort()
  }
  if (isNum(spec)) return dateRange(tz, end, spec)
  return dateRange(tz, end, n)
}

/**
 * Normalise a raw §4.4 context (see header) into the read-only object every helper uses. Idempotent.
 * Pure: reads its input, never mutates it.
 */
export function buildContext(input) {
  if (input && input[BUILT]) return input
  const i = isObj(input) ? input : {}
  const cfg = isObj(i.cfg) ? i.cfg : {}
  const tz = tzFor(cfg, i.tz)
  const units = Array.isArray(cfg.units) ? cfg.units : []
  const wantId = i.unitCfg?.id ?? i.unitId ?? (typeof i.unit === 'string' ? i.unit : null)
  const unitCfg = isObj(i.unitCfg) ? i.unitCfg : (units.find((u) => u && u.id === wantId) ?? null)
  const unitId = unitCfg?.id ?? wantId ?? null
  const state = isObj(i.state) ? i.state : null
  const unitState = isObj(i.unitState) ? i.unitState : (state?.units?.[unitId] ?? null)
  const tuning = isObj(unitState?.tuning) ? unitState.tuning : emptyTuning()
  const insights = isObj(i.insightsState) ? i.insightsState : (isObj(state?.insights) ? state.insights : null)
  const scheduleEnabled = typeof i.scheduleEnabled === 'boolean' ? i.scheduleEnabled : typeof state?.scheduleEnabled === 'boolean' ? state.scheduleEnabled : true
  const now = toMs(i.now)
  const today = Number.isFinite(now) ? tz.localParts(now).date : null
  const analysisDate = typeof i.analysisDate === 'string' && DATE_RE.test(i.analysisDate) ? i.analysisDate : (today ? addDays(tz, today, -1) : null)
  const applyDate = typeof i.applyDate === 'string' && DATE_RE.test(i.applyDate) ? i.applyDate : (Number.isFinite(now) ? nextApplyDate(cfg, tz, now) : null)
  const opt = isObj(cfg.optimizer) ? cfg.optimizer : {}
  const oUnit = isObj(opt.units?.[unitId]) ? opt.units[unitId] : {}
  const g = tuningGuardrails(cfg)
  const offset = numOr(oUnit.sensorOffsetF, 0)
  const lowF = numOr(oUnit.comfortLowF, DEFAULT_BAND[0])
  const highF = numOr(oUnit.comfortHighF, DEFAULT_BAND[1])
  const cf = isObj(cfg.precondition?.clampF) ? cfg.precondition.clampF : {}
  const ins = isObj(cfg.insights) ? cfg.insights : {}
  const winDates = windowDates(tz, i.window, analysisDate, numOr(ins.windowDays, 14))
  const modDates = [...new Set([...windowDates(tz, i.model, analysisDate, numOr(ins.modelDays, 45)), ...winDates])].sort()
  const names = {}
  for (const u of units) if (u && typeof u.id === 'string') names[u.id] = typeof u.name === 'string' && u.name ? u.name : u.id
  const enabled = !!opt.enabled && !!unitCfg && oUnit.enabled !== false && unitCfg.shed !== false && unitCfg.precondition !== false
  const live = cfg.automation?.mode === 'live' && scheduleEnabled
  const stateLike = state ?? { scheduleEnabled, insights: insights ?? {} }
  return Object.freeze({
    [BUILT]: true,
    cfg, tz, unitCfg, unitId, unitState, tuning, state: stateLike, insights,
    scheduleEnabled, enabled, live,
    now, today, analysisDate, applyDate,
    guardrails: g,
    peakStartMin: g.peakStartMin ?? 420,
    marginF: numOr(opt.marginF, 1),
    comfyMarginF: numOr(opt.comfyMarginF, 2),
    minDaysBetweenOpposite: Math.max(0, Math.floor(numOr(opt.minDaysBetweenOpposite, 3))),
    dormantDays: Math.max(1, Math.floor(numOr(opt.dormantDays, 3))),
    band: [lowF + offset, highF + offset], // sensor coordinates (same as rollup classification)
    bandCfg: [lowF, highF], // setpoint coordinates (setpoint guard)
    clampF: { coolingMin: numOr(cf.coolingMin, DEFAULT_CLAMP.coolingMin), heatingMax: numOr(cf.heatingMax, DEFAULT_CLAMP.heatingMax) },
    outdoorEnabled: cfg.outdoor?.enabled === true,
    forecast: isObj(i.forecast) ? i.forecast : null,
    // the water season (a host's hot-water tank): its scald ceiling (injected — the host's kinds.ceilingF — else from
    // cfg.water) and its reading floor water.comfortMinF
    ceilingF: isNum(i.ceilingF) ? i.ceilingF : Math.min(numOr(cfg.water?.maxSetpointF, 140), cfg.water?.mixingValve === true ? 140 : 125),
    waterFloorF: numOr(cfg.water?.comfortMinF, 105),
    baseChangedAt: i.baseChangedAt ?? null,
    windowDates: winDates,
    modelDates: modDates,
    rollups: rollupMap(i.rollups, i.window, i.model),
    names,
  })
}

function unitRollup(c, date) {
  const r = c.rollups.get(date)
  return isObj(r?.units?.[c.unitId]) ? r.units[c.unitId] : null
}

function episodesIn(c, dates) {
  const out = []
  const seen = new Set()
  for (const d of dates) {
    const u = unitRollup(c, d)
    for (const ep of Array.isArray(u?.episodes) ? u.episodes : []) {
      if (!isObj(ep)) continue
      const key = ep.ev ?? `${d}@${ep.peakStart}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ep)
    }
  }
  out.sort((a, b) => secToMs(b.peakStart) - secToMs(a.peakStart))
  return out
}

// ───────────────────────────── season, evidence ─────────────────────────────

function takeSign(ep) {
  const p = ep?.pre
  if (!p || !isNum(p.orig) || !isNum(p.app) || p.app === p.orig) return null
  return p.app > p.orig ? 'heating' : 'cooling'
}

/**
 * §5.3: season of the most recent participating precondition episode (TAKE sign) within the last 3
 * closed days; else the majority-ON mode over those 3 rollup days (HEAT ⇒ heating, COOL/DRY ⇒ cooling);
 * else null. Never the calendar.
 */
export function detectSeason(ctx) {
  const c = buildContext(ctx)
  const days = dateRange(c.tz, c.analysisDate, SEASON_LOOK_DAYS)
  for (const ep of episodesIn(c, days)) {
    if (ep.dryRun || ep.status === 'absent' || ep.status === 'dry' || ep.status === 'was_off') continue
    if (ep.season === 'water') return 'water' // a tank's episode says its season (a pre-heat's sign reads 'heating')
    const s = takeSign(ep)
    if (s) return s
    if (ep.par && (ep.season === 'heating' || ep.season === 'cooling')) return ep.season
  }
  const tot = {}
  for (const d of days) {
    const mm = unitRollup(c, d)?.modeMin
    if (!isObj(mm)) continue
    for (const [k, v] of Object.entries(mm)) {
      if (!isNum(v) || v <= 0) continue
      const key = String(k).toUpperCase() === 'DRY' ? 'COOL' : String(k).toUpperCase()
      tot[key] = (tot[key] ?? 0) + v
    }
  }
  let best = null
  let tie = false
  for (const [k, v] of Object.entries(tot)) {
    if (best === null || v > tot[best]) { best = k; tie = false } else if (v === tot[best]) tie = true
  }
  if (tie) return null // no majority: ambiguous, and season-symmetric (no alphabetical tie-break)
  if (best === 'HEAT') return 'heating'
  if (best === 'COOL') return 'cooling'
  return null
}

/**
 * Addendum C C6.3: the episode's first forced interval over [preStart ?? peakStart, peakEnd) of another season than
 * the episode's, or Fan/Auto (a same-season substitution never counts) | null.
 */
export function forcedByMaster(ep) {
  if (!isObj(ep)) return null
  const a = Number(ep.preStart ?? ep.peakStart)
  const b = Number(ep.peakEnd)
  return (Array.isArray(ep.forced) ? ep.forced : []).find((f) =>
    isObj(f) && !f.sameSeason && seasonOf(f.mode) !== ep.season && Number(f.from) < b && Number(f.until) > a) ?? null
}

// A participating precondition-event episode of the season (E before the Release 4 evidence filters); never a boundary
// episode (addendum E E1.15: no shed window — its realisation is used by realisation() only)
// The water season: a tank pre-heats before every peak (its episode's par, not the event's flag) and an episode with
// neither a tank reading nor a hot-water level (q 'no_sensor') is never evidence (G1.11)
const takesPart = (ep, season) => ep.season === season && (ep.precondition === true || (season === 'water' && isObj(ep.par))) && !ep.dryRun &&
  (ep.status === 'done' || ep.status === 'released') && ep.q !== 'dry' && ep.q !== 'no_sensor' && ep.kind !== 'boundary'

/**
 * §5.4 E: episodes of this unit in the report window with season = s, a precondition event, not
 * dry-run, status ∈ {done, released}, q ≠ 'dry'; newest first. Release 4 (see the header): no preSkipped
 * episode, none forced by the master, and only the newest qualifying episode's preFromOff regime.
 * Release 4.1: never a boundary episode (kind 'boundary', addendum E E1.15).
 * Release 4.2: never a replanned one (Addendum F rule 10, see the header). Release 4.3: never an away one (Addendum H).
 */
export function qualifying(ctx, season) {
  const c = buildContext(ctx)
  const base = episodesIn(c, c.windowDates).filter((ep) => takesPart(ep, season) && !ep.preSkipped && !ep.replanned && !ep.away && !forcedByMaster(ep))
  const regime = !!base[0]?.preFromOff
  return base.filter((ep) => !!ep.preFromOff === regime)
}

/** max(tuning[s].evidenceFrom, tuning.enabledAt, insights.optimizerEnabledAt, baseChangedAt) in ms | −∞. */
function evidenceFromMs(c, season) {
  const cands = [c.tuning?.[season]?.evidenceFrom, c.tuning?.enabledAt, c.insights?.optimizerEnabledAt, c.baseChangedAt]
  let best = -Infinity
  for (const v of cands) { const ms = toMs(v); if (Number.isFinite(ms) && ms > best) best = ms }
  return best
}

function curParams(c, season) {
  return effectivePrecondition(c.cfg, c.unitCfg, c.unitState, season)
}

/**
 * §5.4 F ⊆ E: peakStart ≥ evidenceFrom(s) and the episode's frozen params equal the current effective
 * {deltaF, leadMin}. `eps` defaults to qualifying(ctx, season).
 */
export function fresh(ctx, season, eps) {
  const c = buildContext(ctx)
  const list = Array.isArray(eps) ? eps : qualifying(c, season)
  const from = evidenceFromMs(c, season)
  const cur = curParams(c, season)
  return list.filter((ep) => {
    const ps = secToMs(ep?.peakStart)
    if (!Number.isFinite(ps) || ps < from) return false
    const par = ep.par
    return !!par && isNum(par.deltaF) && isNum(par.leadMin) && Math.abs(par.deltaF - cur.deltaF) < 1e-9 && Math.abs(par.leadMin - cur.leadMin) < 1e-9
  })
}

// ───────────────────────────── drift model, required Δ ─────────────────────────────

/**
 * §5.5 drift model over same-season episodes (caller passes the model-window episodes): points
 * (x, y) = (s·(Tout − r̄), s·b) from episodes with drift.ok ∧ !flat ∧ !jump (dry-run excluded; an away one kept —
 * Addendum H: the room's physics).
 * → {kind:'ols'|'none', confident, alpha, beta, r2, n, sigma, sigmaX, xMean, points:[{x, y, date, ev, tout, room}]}
 * confident ⇔ n ≥ 5 ∧ β > 0 ∧ R² ≥ 0.3 ∧ σx ≥ 2; not confident ⇒ kind 'none' (numbers kept for display).
 */
export function fitDriftModel(episodes) {
  const points = []
  const seen = new Set()
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    if (!isObj(ep) || ep.dryRun) continue
    const sh = ep.shed
    if (!isObj(sh) || !isObj(sh.drift) || sh.drift.ok !== true || sh.flat || sh.jump) continue
    if (ep.season !== 'heating' && ep.season !== 'cooling') continue
    const s = sgn(ep.season)
    const b = isNum(sh.drift.b) ? sh.drift.b : (isNum(sh.driftFph) ? sh.driftFph : null)
    const x = isNum(sh.x) ? sh.x : (isNum(sh.Tout) && isNum(sh.rBar) ? s * (sh.Tout - sh.rBar) : null)
    if (!isNum(b) || !isNum(x)) continue
    const key = ep.ev ?? `${ep.date}@${ep.peakStart}`
    if (seen.has(key)) continue
    seen.add(key)
    points.push({ x, y: s * b, date: ep.date ?? null, ev: ep.ev ?? null, tout: isNum(sh.Tout) ? sh.Tout : null, room: isNum(sh.rBar) ? sh.rBar : null })
  }
  // oldest first for a stable, readable point order (the fit itself is order-independent)
  points.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || String(a.ev ?? '').localeCompare(String(b.ev ?? '')))
  const f = ols(points.map((p) => p.x), points.map((p) => p.y))
  if (!f) return { kind: 'none', confident: false, alpha: null, beta: null, r2: null, n: points.length, sigma: null, sigmaX: null, xMean: null, points }
  const sigmaX = Math.sqrt(f.sxx / f.n)
  const confident = f.n >= MODEL_MIN_N && f.b > 0 && f.r2 >= MODEL_MIN_R2 && sigmaX >= MODEL_MIN_SIGMA_X
  return { kind: confident ? 'ols' : 'none', confident, alpha: f.a, beta: f.b, r2: f.r2, n: f.n, sigma: f.sigma, sigmaX, xMean: f.xMean, points }
}

/**
 * §5.5 required start level and Δ for the coming peak (single signed code path, z = s·room).
 * args: {model:{alpha, beta}, forecastXOut (= s·mean forecast °F), season, band:[L, H], marginF, hours (D),
 *        zPre (median s·T0), effHat, guardrails:{minDeltaF, maxDeltaF}, curDeltaF? (for predEnd)}
 * → {deltaStar, deltaInt, deltaCeil, z0Req, predEnd (room °F at peak end with curDeltaF | null), explain} | null
 * deltaInt = clamp(ceil(Δ* − 0.25), minDeltaF, maxDeltaF) sizes R3; deltaCeil = ceil(Δ* − 0.25) unclamped
 * (may be ≤ 0 or > maxDeltaF) is what the R2 veto compares with the current Δ.
 */
export function requiredDelta({ model, forecastXOut, season, band, marginF = 1, hours = 3, zPre, effHat = EFF_DEFAULT, guardrails, curDeltaF } = {}) {
  if (!model || !isNum(model.alpha) || !isNum(model.beta) || !isNum(forecastXOut) || !isNum(zPre)) return null
  const s = sgn(season)
  const L = Array.isArray(band) && isNum(band[0]) ? band[0] : DEFAULT_BAND[0]
  const H = Array.isArray(band) && isNum(band[1]) ? band[1] : DEFAULT_BAND[1]
  const alpha = model.alpha
  const beta = model.beta
  const D = isNum(hours) && hours > 0 ? hours : 3
  const xOut = forecastXOut
  const zEdge = s > 0 ? L : -H
  const zTarget = zEdge + numOr(marginF, 1)
  let zInf = null
  let z0Req
  if (beta >= BETA_EXP_MIN) {
    zInf = xOut + alpha / beta
    z0Req = zInf + (zTarget - zInf) * Math.exp(beta * D)
  } else {
    z0Req = zTarget - (alpha + beta * (xOut - zTarget)) * D
  }
  const eff = clamp(numOr(effHat, EFF_DEFAULT), EFF_MIN, EFF_MAX)
  const deltaStar = (z0Req - zPre) / eff
  const lo = Math.max(HARD_DELTA[0], numOr(guardrails?.minDeltaF, 1))
  const hi = Math.min(HARD_DELTA[1], numOr(guardrails?.maxDeltaF, 4))
  const deltaCeil = Math.ceil(deltaStar - 0.25)
  const deltaInt = clamp(deltaCeil, lo, Math.max(lo, hi))
  const predict = (delta) => {
    const z0 = zPre + eff * delta
    const zD = beta >= BETA_EXP_MIN ? zInf + (z0 - zInf) * Math.exp(-beta * D) : z0 + (alpha + beta * (xOut - z0)) * D
    return s * zD
  }
  const predEnd = isNum(curDeltaF) ? predict(curDeltaF) : null
  return { deltaStar, deltaInt, deltaCeil, z0Req, predEnd, explain: { s, zEdge, zTarget, zInf, xOut, alpha, beta, hours: D, zPre, effHat: eff } }
}

/** Forecast for the first precondition event of applyDate (§5.5): usable ⇔ outdoor on ∧ fresh ∧ covering. */
function forecastFor(c) {
  if (!c.outdoorEnabled) return { usable: false, reason: 'disabled' }
  const fc = c.forecast
  if (!fc || !Array.isArray(fc.hourly)) return { usable: false, reason: 'missing' }
  const fetched = toMs(fc.fetchedAt)
  if (!Number.isFinite(fetched) || !Number.isFinite(c.now) || fetched < c.now - FORECAST_TTL_MS) return { usable: false, reason: 'stale' }
  if (!c.applyDate) return { usable: false, reason: 'no_event' }
  let ev = null // the first pre-conditioning PEAK (addendum E: a boundary event has no peak hours to forecast)
  try { ev = tou.events(c.cfg, c.tz, c.applyDate).find((e) => e.precondition && e.kind !== 'boundary') ?? null } catch { ev = null }
  if (!ev) return { usable: false, reason: 'no_event' }
  const pts = fc.hourly
    .filter((p) => isObj(p) && isNum(p.f))
    .map((p) => ({ t: secToMs(p.t), f: p.f }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  if (!pts.length || pts[0].t > ev.peakStart) return { usable: false, reason: 'uncovered' }
  const vals = []
  let j = 0
  for (let t = ev.peakStart; t < ev.peakEnd; t += FORECAST_STEP_MS) {
    while (j + 1 < pts.length && pts[j + 1].t <= t) j++
    const a = pts[j]
    let v = null
    if (a.t === t) v = a.f
    else if (j + 1 < pts.length) {
      const b = pts[j + 1]
      if (a.t <= t && b.t > t && b.t - a.t <= FORECAST_MAX_GAP_MS) v = a.f + ((b.f - a.f) * (t - a.t)) / (b.t - a.t)
    }
    if (v == null) return { usable: false, reason: 'uncovered' }
    vals.push(v)
  }
  if (!vals.length) return { usable: false, reason: 'uncovered' }
  return { usable: true, meanF: mean(vals), hours: (ev.peakEnd - ev.peakStart) / 3600000, event: ev, fetchedAt: fetched }
}

/**
 * zPre = median(s·T0), eff̂ = clamp(median eff, 0.3, 1.0) (default 0.7) over the last 5 same-season pre-episodes —
 * never a preSkipped, forced or away one (Addendum H), and (`preFromOff` boolean: F[0]'s) only of that regime (B C-3;
 * null = any).
 * Boundary episodes (addendum E E1.15) are included: their T0 and eff are the same measurement as a weekday's.
 * → {zPre, effHat, events}.
 */
export function realisation(ctx, season, preFromOff = null) {
  const c = buildContext(ctx)
  const s = sgn(season)
  const eps = episodesIn(c, c.modelDates).filter((ep) => ep.season === season && !ep.dryRun && isObj(ep.pre) && isNum(ep.pre.T0) &&
    !ep.preSkipped && !ep.away && !forcedByMaster(ep) && (preFromOff == null || !!ep.preFromOff === !!preFromOff)).slice(0, REAL_N)
  const zPre = median(eps.map((ep) => s * ep.pre.T0))
  const effMed = median(eps.map((ep) => ep.pre.eff).filter(isNum))
  return { zPre, effHat: clamp(effMed ?? EFF_DEFAULT, EFF_MIN, EFF_MAX), events: eps.map((ep) => ep.ev ?? null) }
}

// ───────────────────────────── step choice and guardrails ─────────────────────────────

function stepGuardrails(ctx) {
  if (isObj(ctx?.guardrails)) return ctx.guardrails
  return tuningGuardrails(ctx?.cfg ?? {})
}

/**
 * §5.7 parameter choice for one step in `dir` ('up' | 'down'). ctx: {season, F (fresh, newest first),
 * E? (qualifying, setpoint-guard fallback), guardrails | cfg, bandCfg | band ([L, H]), clampF}.
 * cur: {deltaF, leadMin, leadSource?} (current effective). → {param, from, to} (before clampStep) | {hold:'at_limit'}
 * (UP with nothing left to raise) | {hold:'guardrail'} (DOWN already at the minimum). X1.2: DOWN never picks a
 * config lead (`leadSource ?? source` 'config') longer than peakStart − earliestStart; a tuned one is clampStep's.
 */
export function stepFor(dir, ctx, cur) {
  const F = Array.isArray(ctx?.F) ? ctx.F : Array.isArray(ctx?.fresh) ? ctx.fresh : []
  const g = stepGuardrails(ctx)
  const water = ctx?.season === 'water'
  const season = ctx?.season === 'cooling' ? 'cooling' : 'heating'
  const dStep = water ? Math.max(1, numOr(g.maxStepDeltaF, 5)) : 1 // the tank steps Δ by water.tune.stepDeltaF
  const pk = numOr(g.peakStartMin, 420)
  const earliest = numOr(g.earliestStartMin, 270)
  const stepLead = Math.max(0, Math.min(LEAD_STEP_CAP, numOr(g.maxStepLeadMin, LEAD_STEP_CAP)))
  const deltaF = cur?.deltaF
  const leadMin = cur?.leadMin
  const f0 = F[0]
  if (dir === 'up') {
    const leadCanGrow = isNum(leadMin) && stepLead > 0 && leadMin + stepLead <= Math.min(pk - earliest, HARD_LEAD[1])
    const pre0 = isObj(f0?.pre) ? f0.pre : null
    if (pre0 && pre0.reached === false && isNum(pre0.eff) && pre0.eff < LEAD_EFF_MAX && leadCanGrow) return { param: 'leadMin', from: leadMin, to: leadMin + stepLead }
    const capped = !!pre0?.capped
    const band = Array.isArray(ctx?.bandCfg) ? ctx.bandCfg : Array.isArray(ctx?.band) ? ctx.band : DEFAULT_BAND
    const cf = isObj(ctx?.clampF) ? ctx.clampF : (isObj(ctx?.cfg?.precondition?.clampF) ? ctx.cfg.precondition.clampF : DEFAULT_CLAMP)
    let origMed = median(F.map((e) => e?.pre?.orig).filter(isNum))
    if (origMed == null && Array.isArray(ctx?.E)) origMed = median(ctx.E.map((e) => e?.pre?.orig).filter(isNum))
    let guard = true
    if (water && origMed != null && isNum(deltaF)) guard = origMed + deltaF + dStep <= numOr(ctx?.ceilingF, 125) + 1e-9 // J32
    else if (origMed != null && isNum(deltaF)) {
      guard = season === 'heating'
        ? origMed + deltaF + 1 <= Math.min(numOr(band[1], DEFAULT_BAND[1]), numOr(cf.heatingMax, DEFAULT_CLAMP.heatingMax)) + 1e-9
        : origMed - deltaF - 1 >= Math.max(numOr(band[0], DEFAULT_BAND[0]), numOr(cf.coolingMin, DEFAULT_CLAMP.coolingMin)) - 1e-9
    }
    if (isNum(deltaF) && deltaF + dStep <= numOr(g.maxDeltaF, 4) + 1e-9 && guard && !capped) return { param: 'deltaF', from: deltaF, to: deltaF + dStep }
    if (leadCanGrow) return { param: 'leadMin', from: leadMin, to: leadMin + stepLead }
    return { hold: 'at_limit' }
  }
  if (dir === 'down') {
    const early = median(F.slice(0, R2_NEED).map((e) => e?.pre?.reachedMinBeforePeak).filter(isNum))
    const baseTooLong = (cur?.leadSource ?? cur?.source) === 'config' && leadMin > pk - earliest
    if (early != null && early >= EARLY_MIN && isNum(leadMin) && !baseTooLong && stepLead > 0 && leadMin - stepLead >= numOr(g.minLeadMin, 60)) return { param: 'leadMin', from: leadMin, to: leadMin - stepLead }
    if (isNum(deltaF) && deltaF - dStep >= numOr(g.minDeltaF, 1) - 1e-9) return { param: 'deltaF', from: deltaF, to: deltaF - dStep }
    return { hold: 'guardrail' }
  }
  return { hold: 'guardrail' }
}

/**
 * Defensive final clamp (§5.7): deltaF ∈ [minDeltaF, maxDeltaF] ∩ [1, 6], |Δ| ≤ min(1, maxStepDeltaF);
 * leadMin on the 5-min grid ∈ [minLeadMin, peakStart − earliestStart] ∩ [20, 240], |Δ| ≤ min(30,
 * maxStepLeadMin). `from` is always cur[param]. → {param, from, to} | null when clamping cancels or
 * reverses the move (⇒ mode 'guardrail', no change).
 */
export function clampStep(cur, next, guardrails, peakStartMin) {
  if (!isObj(next) || (next.param !== 'deltaF' && next.param !== 'leadMin') || !isNum(next.to)) return null
  const from = cur?.[next.param]
  if (!isNum(from)) return null
  const dir = Math.sign(next.to - from)
  if (dir === 0) return null
  const g = isObj(guardrails) ? guardrails : {}
  let to = next.to
  if (next.param === 'deltaF') {
    const water = g.season === 'water' // the tank's guardrails (tuning.guardrails(cfg, 'water')): Δ 5–25 by 5
    const lo = Math.max(HARD_DELTA[0], numOr(g.minDeltaF, 1))
    const hi = water ? Math.min(WATER_HARD_MAX, numOr(g.maxDeltaF, 25)) : Math.min(HARD_DELTA[1], numOr(g.maxDeltaF, 4))
    const stepMax = water ? Math.max(0, numOr(g.maxStepDeltaF, 5)) : Math.min(1, Math.max(0, numOr(g.maxStepDeltaF, 1)))
    if (lo > hi || stepMax <= 0) return null
    to = clamp(to, lo, hi)
    if (Math.abs(to - from) > stepMax + 1e-9) to = from + dir * stepMax
    if (to < lo - 1e-9 || to > hi + 1e-9) return null
  } else {
    const pk = numOr(peakStartMin, numOr(g.peakStartMin, 420))
    const room = pk - numOr(g.earliestStartMin, 270)
    const lo = ceil5(Math.max(HARD_LEAD[0], numOr(g.minLeadMin, 60)))
    const hi = floor5(Math.min(HARD_LEAD[1], room))
    const stepMax = Math.min(LEAD_STEP_CAP, Math.max(0, numOr(g.maxStepLeadMin, LEAD_STEP_CAP)))
    if (lo > hi || stepMax <= 0) return null
    to = dir > 0 ? floor5(to) : ceil5(to)
    to = clamp(to, lo, hi)
    if (Math.abs(to - from) > stepMax + 1e-9) to = dir > 0 ? floor5(from + stepMax) : ceil5(from - stepMax)
    if (to < lo || to > hi) return null
  }
  to = Math.round(to * 1e6) / 1e6
  if (Math.sign(to - from) !== dir) return null
  return { param: next.param, from, to }
}

// ───────────────────────────── signals ─────────────────────────────

const countedOverride = (o) => isObj(o) && o.comfortDir === true && !o.auto && o.gap == null

/** R1: latest fresh episode violated, or released by a comfort-direction override during the shed. */
function breach(ep) {
  if (!ep) return false
  if (ep.season === 'water' && (numOr(ep.shed?.floorMin, 0) > 0 || numOr(ep.shed?.lowMin, 0) > 0)) return true // G1.11
  if (ep.shed?.class === 'violated') return true
  if (ep.status !== 'released') return false
  const off = isNum(ep.shed?.offAt) ? ep.shed.offAt : Number(ep.peakStart)
  const end = Number(ep.peakEnd) + 300
  return (ep.overrides ?? []).some((o) => countedOverride(o) && isNum(o.t) && o.t >= off && o.t < end)
}

/** R5: comfort overrides (comfortDir ∧ !auto ∧ gap == null) on ≥ 2 distinct event days among F[0..4]. */
function r5Signal(F) {
  const look = F.slice(0, R5_LOOK)
  const days = new Set()
  const items = []
  for (const ep of look) {
    const os = (ep.overrides ?? []).filter(countedOverride)
    if (!os.length) continue
    days.add(ep.date ?? ep.ev)
    items.push(...os)
  }
  return { fire: days.size >= R5_DAYS, days: days.size, of: look.length, items }
}

function comfortable(ep, cc) {
  const sh = ep?.shed
  const noOverride = !(ep?.overrides ?? []).some((o) => isObj(o) && o.comfortDir === true)
  // the tank: never at or below its floor, never 'low' — comfortable by its reading, or (no reading) by its level
  if (ep?.season === 'water') {
    return !!sh && noOverride && numOr(sh.floorMin, 0) === 0 && numOr(sh.lowMin, 0) === 0 &&
      ((sh.class === 'comfortable' && isNum(sh.cov) && sh.cov >= cc) || (sh.class === 'unknown' && isObj(sh.levels)))
  }
  return !!sh && sh.class === 'comfortable' && isNum(sh.cov) && sh.cov >= cc && noOverride
}

/** R4a: the last dormantDays closed days each have a rollup with onMin.total = 0 and coverage ≥ 0.5 — none away (H). */
function dormancy(c) {
  const days = dateRange(c.tz, c.analysisDate, c.dormantDays)
  if (days.length < c.dormantDays) return null
  for (const d of days) {
    const r = c.rollups.get(d)
    if (r && r.complete === false) return null
    const u = unitRollup(c, d)
    if (!u || !isNum(u.onMin?.total) || u.onMin.total > 0 || !isNum(u.coverage) || u.coverage < DORMANT_COV || u.away) return null
  }
  return { since: days[0], days: days.length }
}

// ───────────────────────────── result builders ─────────────────────────────

function holdCtx(c, season, extra) {
  const cur = season ? curParams(c, season) : null
  const obs = observeInfo({ cfg: c.cfg, state: c.state, unitState: c.unitState, tz: c.tz, now: c.now, applyDate: c.applyDate })
  return {
    unitName: c.names[c.unitId] ?? c.unitId ?? 'This unit',
    season: season ?? 'heating',
    paramLabel: cur ? T.paramLabel({ season, deltaF: cur.deltaF, leadMin: cur.leadMin, peakStartMin: c.peakStartMin }) : undefined,
    days: c.dormantDays,
    daysLeft: obs.daysLeft ?? undefined,
    ...extra,
  }
}

function setHold(res, c, code, extra = {}) {
  res.mode = code === 'guardrail' ? 'guardrail' : 'hold'
  res.hold = { code, text: T.holdText(code, holdCtx(c, res.season, extra)) }
  res.change = null
  return res
}

function setChange(res, change, observe) {
  res.observe = observe
  res.change = change
  res.hold = null
  res.mode = observe ? 'proposed' : 'change'
  return res
}

/**
 * "today 5:00 AM" / "Mon 5:00 AM" — local start of the new window on the first pre-conditioning
 * morning on/after applyDate (a weekend/holiday applyDate has none — unless the weekend pre-condition is on, addendum
 * E E1.13: then that morning is the first affected one, and its window ends at the boundary — the weekend table's
 * super off-peak → off-peak step, not the weekday peak start (E-5); a tuned LEAD ⇒ ≥ earliestStart, addendum D X1: a
 * Δ step never moves the base start).
 */
function startWhen(c, leadMin, tunedLead) {
  if (!c.applyDate || !isNum(leadMin)) return null
  let date = c.applyDate
  try { date = tou.firstPreconditionDate(c.cfg, c.tz, c.applyDate) ?? c.applyDate } catch { /* keep applyDate */ }
  let peakMin = c.peakStartMin
  try {
    const first = tou.events(c.cfg, c.tz, date).find((e) => e.precondition)
    if (first?.kind === 'boundary') peakMin = c.tz.localParts(Number(first.peakStart)).minuteOfDay
  } catch { /* keep the weekday peak start */ }
  const startMin = tunedLead ? Math.max(peakMin - leadMin, c.guardrails.earliestStartMin ?? 0) : peakMin - leadMin
  let time = ''
  try { time = c.tz.formatLocal(c.tz.zonedToInstant(date, startMin), 'time') } catch { time = T.clockLabel(startMin) }
  return `${dayWord(c.tz, c.today, date)} ${time}`.trim()
}

function eventLabelOf(c, ep) {
  const ms = secToMs(ep?.peakStart)
  if (!Number.isFinite(ms)) return 'morning peak'
  return c.tz.localParts(ms).minuteOfDay < 720 ? 'morning peak' : 'evening peak'
}

function rationaleFor(c, rule, ch, ev, f0) {
  const base = { ...ev, unit: c.unitId, season: ch.season ?? ev.season ?? 'heating', param: ch.param, from: ch.from, to: ch.to, peakStartMin: c.peakStartMin }
  const say = (r) => T.rationale(r, base, c.names, c.tz)
  if (ch.param !== 'leadMin' || (rule === 'R1_LEAD' && f0?.pre?.reached === false) || rule === 'R2_LEAD') {
    return say(rule)
  }
  // An UP step on the start time: the trigger's first sentence + the R1_LEAD "starts earlier" sentence.
  const why = rule === 'R1_LEAD' ? 'R1_DELTA' : rule
  const first = splitSentence(say(why))[0]
  const second = splitSentence(say('R1_LEAD'))[1]
  return second ? `${first} ${second}` : say(null)
}

function makeChange(c, { kind, season, param, from, to, rule, evidence, since, f0 }) {
  const ch = {
    id: changeId([c.unitId, season, kind, param, from, to, c.applyDate, c.analysisDate, rule]),
    kind,
    unit: c.unitId,
    season: season ?? null,
    param,
    from,
    to,
    applyDate: c.applyDate,
    analysisDate: c.analysisDate,
    rule,
    rationale: '',
    evidence,
  }
  if (since !== undefined) ch.since = since
  ch.rationale = rationaleFor(c, rule, ch, evidence, f0)
  return ch
}

function modelEvidence(model) {
  if (!model || !isNum(model.alpha) || !isNum(model.beta)) return null
  return { a: round2(model.alpha), b: round2(model.beta), r2: round2(model.r2), n: model.n }
}

// ───────────────────────────── proposeFor ─────────────────────────────

/**
 * §5.6 decision for one unit (see the header for the order and the output shape). Pure: same input ⇒
 * deep-equal output; never mutates the input.
 */
export function proposeFor(input) {
  const c = buildContext(input)
  const t = c.tuning
  const D = c.analysisDate
  const res = {
    unit: c.unitId,
    season: null,
    observe: true,
    mode: 'hold',
    hold: null,
    signals: { R1: false, R5: false, R3: false, R2: false, R4: null, sensor: false },
    change: null,
    suggestion: null,
    model: null,
  }
  const season = detectSeason(c)
  res.season = season
  const obs = observeInfo({ cfg: c.cfg, state: c.state, unitState: c.unitState, tz: c.tz, now: c.now, applyDate: c.applyDate })
  res.observe = obs.observe || !c.live
  if (season) res.model = fitDriftModel(episodesIn(c, c.modelDates).filter((ep) => ep.season === season && !forcedByMaster(ep) && ep.kind !== 'boundary'))
  const water = season === 'water' // G1.12: no drift model (fitDriftModel never fits 'water'), no R3, no veto

  // R4b resume (comfort-safe: bypasses G1/G2, observe and the lock, exactly like tuning.check('resume')):
  // auto-tune off freezes tuned values, never a dormancy pause on a unit that is used again.
  if (t.suspended) {
    const onD = unitRollup(c, D)?.onMin?.total
    if (isNum(onD) && onD >= RESUME_ON_MIN) {
      res.signals.R4 = 'wake'
      const sSeason = season ?? 'heating'
      const cur = curParams(c, sSeason)
      const evidence = { season: sSeason, deltaF: cur.deltaF, leadMin: cur.leadMin, onMin: onD, events: [] }
      return setChange(res, makeChange(c, { kind: 'resume', season: null, param: 'suspended', from: true, to: false, rule: 'R4B', evidence }), false)
    }
  }

  // G1, G2
  if (!c.enabled) return setHold(res, c, 'off')
  if (!c.live) return setHold(res, c, 'not_live')
  if (t.suspended) return setHold(res, c, 'suspended')

  // G5 locked (after a revert/reset)
  if (c.applyDate && Array.isArray(t.lockedDates) && t.lockedDates.includes(c.applyDate)) {
    return setHold(res, c, 'locked', { dayLabel: c.applyDate === c.today ? 'today' : weekday(c.tz, c.applyDate) })
  }

  // R4a dormant (counts as the day's change; observe applies)
  const dorm = dormancy(c)
  if (dorm) {
    res.signals.R4 = 'dormant'
    const evidence = { season: season ?? 'heating', days: dorm.days, since: dorm.since, events: [] }
    return setChange(res, makeChange(c, { kind: 'suspend', season: null, param: 'suspended', from: false, to: true, rule: 'R4A', evidence, since: dorm.since }), res.observe)
  }

  // G3 season
  if (!season) return setHold(res, c, 'no_season')
  const s = sgn(season)
  const st = isObj(t[season]) ? t[season] : { history: [] }

  // G6 already (one change per (unit, season, analysisDate) and per applyDate)
  const h0 = Array.isArray(st.history) ? st.history[0] : null
  if (st.lastAnalysisDate && st.lastAnalysisDate === D) return setHold(res, c, 'already', { dayLabel: weekday(c.tz, D) })
  if (h0 && typeof h0.applyDate === 'string' && c.applyDate && h0.applyDate >= c.applyDate) {
    return setHold(res, c, 'already', { dayLabel: weekday(c.tz, h0.analysisDate ?? D) })
  }

  // G7 low data
  const covD = unitRollup(c, D)?.coverage
  const latestPre = episodesIn(c, c.windowDates).find((ep) => ep.precondition === true)
  const jobsBad = !!latestPre && (numOr(latestPre.jobs?.failing, 0) > 0 || numOr(latestPre.jobs?.blocked, 0) > 0)
  if (!isNum(covD) || covD < LOW_DATA_COV || jobsBad) return setHold(res, c, 'low_data')

  // evidence
  const g = water ? tuningGuardrails(c.cfg, 'water') : c.guardrails
  const cur = curParams(c, season)
  const E = qualifying(c, season)
  const F = fresh(c, season, E)
  const F3 = F.slice(0, R2_NEED)
  const f0 = F[0] ?? null
  const G4 = F3.filter((ep) => ep.shed?.flat || ep.shed?.jump).length >= 2
  res.signals.sensor = G4

  // model + forecast (R3 / veto)
  const model = res.model
  const fc = model?.confident ? forecastFor(c) : null
  const real = model?.confident ? realisation(c, season, f0 ? !!f0.preFromOff : null) : null
  let req = null
  if (model?.confident && fc?.usable && real?.zPre != null) {
    req = requiredDelta({ model, forecastXOut: s * fc.meanF, season, band: c.band, marginF: c.marginF, hours: fc.hours, zPre: real.zPre, effHat: real.effHat, guardrails: g, curDeltaF: cur.deltaF })
  }
  const endOfD = D ? c.tz.zonedToInstant(addDays(c.tz, D, 1), '00:00') : Infinity
  const staleAnalysis = evidenceFromMs(c, season) >= endOfD

  // signals
  const R1 = !!f0 && breach(f0)
  const r5 = r5Signal(F)
  let R3 = false
  if (req && !staleAnalysis && isNum(cur.deltaF) && req.deltaInt >= cur.deltaF + 1) {
    const handled = F.filter((ep) => (ep.shed?.class === 'ok' || ep.shed?.class === 'comfortable') && isNum(ep.shed?.Tout)).map((ep) => s * ep.shed.Tout)
    R3 = handled.length === 0 || s * fc.meanF <= Math.min(...handled) - R3_COLDER
  }
  // veto on the unclamped requirement: the clamped Δ*int ≥ minDeltaF would veto every decrease at Δ = min
  const veto = !!req && isNum(cur.deltaF) && req.deltaCeil >= cur.deltaF
  let have = 0
  for (const ep of F3) { if (comfortable(ep, COMFY_COV)) have++; else break }
  res.signals.R1 = R1
  res.signals.R5 = r5.fire
  res.signals.R3 = R3
  res.signals.R2 = have >= R2_NEED

  const band = water ? [c.waterFloorF, c.ceilingF] : [c.band[0], c.band[1]]
  const worstOf = (eps) => {
    const vals = eps.map((ep) => (s > 0 ? ep.shed?.Tmin : ep.shed?.Tmax)).filter(isNum)
    if (!vals.length) return null
    return s > 0 ? Math.min(...vals) : Math.max(...vals)
  }
  const roomKey = s > 0 ? 'minRoom' : 'maxRoom'
  const overrideVerb = (items) => items.some((o) => o.f === 'power') ? 'turned back on'
    : items.some((o) => o.f === 'temp') ? (s > 0 ? 'turned up' : 'turned down') : (s > 0 ? 'switched to heat' : 'switched to cool')
  const cooldownUntil = (param, dir) => {
    const v = t.cooldown?.[`${season}.${param}.${dir}`]
    return typeof v === 'string' && c.applyDate && c.applyDate < v ? v : null
  }
  const frozenUntil = (dir) => {
    const v = t.frozen?.[`${season}.${dir}`]
    return typeof v === 'string' && c.applyDate && c.applyDate < v ? v : null
  }

  // ── UP (R1 > R5 > R3); any UP signal blocks DOWN ──
  if (R1 || r5.fire || R3) {
    const trig = R1 ? 'R1' : r5.fire ? 'R5' : 'R3'
    const fz = frozenUntil('up')
    if (fz) return setHold(res, c, 'frozen', { dir: 'up', untilLabel: weekday(c.tz, fz) })
    const step = stepFor('up', { season, F, E, guardrails: g, bandCfg: c.bandCfg, clampF: c.clampF, ceilingF: c.ceilingF }, cur)
    if (step.hold) {
      if (step.hold === 'at_limit' && water) {
        const name = c.names[c.unitId] ?? c.unitId ?? 'This unit'
        const worst = worstOf(f0 ? [f0] : [])
        const why = worst != null ? `${name}'s tank still drops to ${T.temp(worst)} during the peak.` : `${name}'s hot water still runs low during the peak.`
        res.suggestion = { text: `${why} It can't pre-heat more — the ${T.temp(c.ceilingF)} scald limit; tell the app if a mixing valve is installed.` }
        return setHold(res, c, step.hold, { ceilingF: c.ceilingF })
      }
      if (step.hold === 'at_limit') {
        // Worded per trigger: only R1 is a breach, and "maximum" only when +1 Δ would pass the guardrail
        // max (stepFor's test); otherwise the setpoint guard or a capped TAKE stopped it — always so for
        // R3, whose Δ*int ≤ maxDeltaF (§5.7).
        const W = s > 0 ? { moved: 'drops', noun: 'pre-heat' } : { moved: 'rises', noun: 'pre-cool' }
        const name = c.names[c.unitId] ?? c.unitId ?? 'This unit'
        const atMax = isNum(cur.deltaF) && cur.deltaF + 1 > g.maxDeltaF + 1e-9
        const limit = atMax ? `maximum ${W.noun}` : `the setpoint limit for ${W.noun}`
        let why
        if (trig === 'R1') {
          const worst = worstOf(f0 ? [f0] : [])
          why = `${name} ${worst != null ? `still ${W.moved} to ${T.temp(worst)}` : 'is still uncomfortable'} at ${limit}.`
        } else if (trig === 'R5') why = `${name} keeps being ${overrideVerb(r5.items)} during the peak, but ${limit} is reached.`
        else why = `The forecast calls for more ${W.noun} for ${name}, but ${limit} is reached.`
        res.suggestion = { text: `${why} Raise the max, widen the band, or opt ${name} out of the morning shed.` }
      }
      return setHold(res, c, step.hold)
    }
    const cd = cooldownUntil(step.param, 'up')
    if (cd) return setHold(res, c, 'cooldown', { untilLabel: weekday(c.tz, cd) })
    const cl = clampStep(cur, step, g, g.peakStartMin ?? c.peakStartMin)
    if (!cl) return setHold(res, c, 'guardrail')
    const rule = trig === 'R1' ? (cl.param === 'leadMin' ? 'R1_LEAD' : 'R1_DELTA') : trig
    const evidence = {
      season,
      events: trig === 'R3' ? F.slice(0, R2_NEED).map((ep) => ep.ev) : trig === 'R5' ? F.slice(0, R5_LOOK).map((ep) => ep.ev) : [f0.ev],
      [roomKey]: worstOf(f0 ? [f0] : []),
      band,
      eff: isNum(f0?.pre?.eff) ? f0.pre.eff : null,
      roomAtPeak: isNum(f0?.pre?.Tpk) ? f0.pre.Tpk : null,
      target: isNum(f0?.pre?.app) ? f0.pre.app : null,
      dayLabel: f0 ? weekday(c.tz, f0.date ?? localDate(c.tz, secToMs(f0.peakStart))) : null,
      eventLabel: f0 ? eventLabelOf(c, f0) : 'morning peak',
      overrides: r5.items.length,
      model: modelEvidence(model),
      forecastPeakF: fc?.usable ? round1(fc.meanF) : null,
      deltaStar: req ? round2(req.deltaStar) : null,
      fromLabel: startWhen(c, cl.param === 'leadMin' ? cl.to : cur.leadMin, cl.param === 'leadMin' || (cur.leadSource ?? cur.source) === 'tuned'),
    }
    if (trig === 'R5') {
      evidence.overrideDays = r5.days
      evidence.ofDays = r5.of
      evidence.overrideVerb = overrideVerb(r5.items)
      evidence.via = r5.items.every((o) => o.s === 'external') ? 'Apple Home or remote' : r5.items.every((o) => o.s === 'user') ? 'dashboard' : null
    }
    if (trig === 'R3' && fc?.usable) {
      evidence.predEndF = req && isNum(req.predEnd) ? round1(req.predEnd) : null
      evidence.dayWord = (() => { const w = dayWord(c.tz, c.today, c.applyDate); return w ? w[0].toUpperCase() + w.slice(1) : w })()
      evidence.windowLabel = rangeLabel(c.tz, fc.event.peakStart, fc.event.peakEnd)
      evidence.peakEndLabel = T.clockLabel(c.tz.localParts(fc.event.peakEnd).minuteOfDay)
    }
    const ch = makeChange(c, { kind: 'change', season, param: cl.param, from: cl.from, to: cl.to, rule, evidence, f0 })
    return setChange(res, ch, res.observe)
  }

  // ── G3 learning: R1/R2/R5 need at least one fresh episode (C6.3: forced_by_master when the newest was the master's) ──
  if (!F.length) {
    // G1.11: a tank reporting neither its temperature nor a hot-water level can't be learned from
    const newestW = water ? episodesIn(c, c.windowDates).find((ep) => ep.season === 'water' && isObj(ep.par) && !ep.dryRun) : null
    if (newestW?.q === 'no_sensor') return setHold(res, c, 'no_sensor')
    const newest = episodesIn(c, c.windowDates).find((ep) => takesPart(ep, season))
    const fz = newest ? forcedByMaster(newest) : null
    if (fz) return setHold(res, c, 'forced_by_master', { byName: c.names[fz.by] ?? fz.by ?? undefined, dayLabel: weekday(c.tz, newest.date ?? localDate(c.tz, secToMs(newest.peakStart))) })
    const ef = evidenceFromMs(c, season)
    return setHold(res, c, 'learning', { n: 0, sinceLabel: Number.isFinite(ef) ? weekday(c.tz, localDate(c.tz, ef)) : undefined })
  }

  // ── R2 DOWN ──
  if (have < R2_NEED) {
    if (f0.shed?.class === 'tight') return setHold(res, c, 'tight', { lowF: f0.shed.Tmin, highF: f0.shed.Tmax })
    return setHold(res, c, 'need_n', { need: R2_NEED, have })
  }
  if (G4) return setHold(res, c, 'sensor')
  const lastUp = localDate(c.tz, t.lastUpAt)
  if (lastUp && c.applyDate && c.applyDate < addDays(c.tz, lastUp, c.minDaysBetweenOpposite)) return setHold(res, c, 'hysteresis')
  const fz = frozenUntil('down')
  if (fz) return setHold(res, c, 'frozen', { dir: 'down', untilLabel: weekday(c.tz, fz) })
  if (veto) return setHold(res, c, 'veto')
  const step = stepFor('down', { season, F, E, guardrails: g, bandCfg: c.bandCfg, clampF: c.clampF, ceilingF: c.ceilingF }, cur)
  if (step.hold) return setHold(res, c, 'guardrail')
  const cd = cooldownUntil(step.param, 'down')
  if (cd) return setHold(res, c, 'cooldown', { untilLabel: weekday(c.tz, cd) })
  const cl = clampStep(cur, step, g, g.peakStartMin ?? c.peakStartMin)
  if (!cl) return setHold(res, c, 'guardrail')
  const rule = cl.param === 'leadMin' ? 'R2_LEAD' : 'R2_DELTA'
  const ms = F3.map((ep) => ep.shed?.m).filter(isNum)
  const evidence = {
    season,
    events: F3.map((ep) => ep.ev),
    [roomKey]: worstOf(F3),
    band,
    marginF: ms.length ? round1(Math.min(...ms)) : null,
    n: F3.length,
    eff: isNum(f0?.pre?.eff) ? f0.pre.eff : null,
    reachedMinBeforePeak: median(F3.map((ep) => ep?.pre?.reachedMinBeforePeak).filter(isNum)),
    overrides: 0,
    model: modelEvidence(model),
    forecastPeakF: fc?.usable ? round1(fc.meanF) : null,
    deltaStar: req ? round2(req.deltaStar) : null,
    fromLabel: startWhen(c, cl.param === 'leadMin' ? cl.to : cur.leadMin, cl.param === 'leadMin' || (cur.leadSource ?? cur.source) === 'tuned'),
  }
  const ch = makeChange(c, { kind: 'change', season, param: cl.param, from: cl.from, to: cl.to, rule, evidence, f0 })
  return setChange(res, ch, res.observe)
}

// ───────────────────────────── user/system mutations (pure proposals) ─────────────────────────────

function unitArgs(a) {
  const cfg = isObj(a?.cfg) ? a.cfg : {}
  const tz = tzFor(cfg, a?.tz)
  const units = Array.isArray(cfg.units) ? cfg.units : []
  const unitCfg = isObj(a?.unitCfg) ? a.unitCfg : (units.find((u) => u && u.id === a?.unitId) ?? null)
  const unitId = unitCfg?.id ?? a?.unitId ?? null
  const unitState = isObj(a?.unitState) ? a.unitState : null
  const tuning = isObj(unitState?.tuning) ? unitState.tuning : emptyTuning()
  const now = toMs(a?.now)
  const names = {}
  for (const u of units) if (u && typeof u.id === 'string') names[u.id] = typeof u.name === 'string' && u.name ? u.name : u.id
  return { cfg, tz, unitCfg, unitId, unitState, tuning, now, names, today: Number.isFinite(now) ? tz.localParts(now).date : null }
}

function verdict(u, mutation, effect, extra = {}) {
  const code = tuningCheck(u.unitState, mutation, { cfg: u.cfg, now: u.now, tz: u.tz, unitId: u.unitId })
  return { ok: code === 'ok', code, reason: extra.reason ?? null, effect, mutation, message: extra.message ?? null, ...(extra.undoUntil ? { undoUntil: extra.undoUntil } : {}) }
}

function refuse(code, reason = null) { return { ok: false, code, reason, effect: null, mutation: null, message: null } }

function findHistory(t, id) {
  for (const season of ['heating', 'cooling']) {
    const h = Array.isArray(t?.[season]?.history) ? t[season].history : []
    const i = h.findIndex((e) => e && e.id === id)
    if (i >= 0) return { season, index: i, entry: h[i] }
  }
  return null
}

/**
 * §5.11 Revert: only tuning[s].history[0], and only while the current effective value is still its `to`
 * (else 'superseded' with reason 'newer' | 'changed' | 'reverted'); a revert of the pending change is a
 * cancel. The mutation locks nextApplyDate(now) and carries the cooldown length and local `today` so
 * applyMutation needs nothing else. args: {cfg, unitCfg | unitId, unitState, tz, now, id}
 */
export function proposeRevert(args) {
  const u = unitArgs(args)
  const id = args?.id
  if (id == null) return refuse('not_found')
  if (isObj(u.tuning.pending) && u.tuning.pending.id === id) return proposeCancel(args)
  const hit = findHistory(u.tuning, id)
  if (!hit) return isObj(u.tuning.lastRevert) && u.tuning.lastRevert.id === id ? refuse('superseded', 'reverted') : refuse('not_found')
  if (hit.index > 0) return refuse('superseded', 'newer')
  const h = hit.entry
  const cur = currentValue(u.cfg, u.unitCfg, u.unitState, hit.season, h.param)
  if (cur !== h.to) return refuse('superseded', 'changed')
  const lockDate = Number.isFinite(u.now) ? nextApplyDate(u.cfg, u.tz, u.now) : null
  const cooldownDays = Math.max(0, Math.floor(numOr(u.cfg.optimizer?.revertCooldownDays, 3)))
  const mutation = {
    kind: 'revert', id, unit: u.unitId, season: hit.season, param: h.param, from: h.to, to: h.from,
    applyDate: lockDate, lockDate, cooldownDays, today: u.today, rule: 'REVERT',
  }
  const pk = numOr(tuningGuardrails(u.cfg).peakStartMin, 420)
  const message = T.rationale('REVERT', { unit: u.unitId, season: hit.season, param: h.param, from: h.to, to: h.from, peakStartMin: pk, lockedLabel: lockDate ? weekday(u.tz, lockDate) : null }, u.names, u.tz)
  const undoUntil = Number.isFinite(u.now) ? new Date(u.now + UNDO_WINDOW_MS).toISOString() : null
  return verdict(u, mutation, 'revert', { message, undoUntil })
}

/**
 * §5.11 Undo revert: while tuning.lastRevert.id === id, within 10 minutes, with no newer mutation and the
 * value still at the reverted-to value. args: {cfg, unitCfg | unitId, unitState, tz, now, id}
 */
export function proposeUndo(args) {
  const u = unitArgs(args)
  const lr = u.tuning.lastRevert
  if (!isObj(lr) || lr.id !== args?.id) return refuse(findHistory(u.tuning, args?.id) ? 'superseded' : 'not_found', 'no_revert')
  const mutation = { kind: 'undo', id: lr.id, unit: u.unitId, season: lr.season, param: lr.param, from: lr.from, to: lr.to, today: u.today, rule: 'UNDO' }
  const pk = numOr(tuningGuardrails(u.cfg).peakStartMin, 420)
  const message = `${u.names[u.unitId] ?? u.unitId ?? 'This unit'}: ${T.changeSummary({ season: lr.season, param: lr.param, from: lr.from, to: lr.to, peakStartMin: pk })} again (undo)`
  return verdict(u, mutation, 'undo', { message })
}

/** §5.10 Cancel a pending (gated) entry by id. args: {cfg?, unitCfg | unitId, unitState, tz?, now?, id} */
export function proposeCancel(args) {
  const u = unitArgs(args)
  const p = u.tuning.pending
  if (!isObj(p) || p.id !== args?.id) return refuse('not_found')
  const mutation = { kind: 'cancel', id: p.id, unit: u.unitId, season: p.season ?? null, param: p.param ?? null, from: p.from ?? null, to: p.to ?? null, rule: 'CANCEL' }
  return verdict(u, mutation, 'cancel', { message: `${u.names[u.unitId] ?? u.unitId ?? 'This unit'}: pending change cancelled` })
}

/**
 * §5.11 Reset unit (user; locks nextApplyDate) or §5.12 base-config reset (reason 'base'; no lock):
 * tuned values and history of `season` (both seasons + suspension when season is null) go back to the
 * config base. args: {cfg, unitCfg | unitId, unitState, tz, now, season?, reason?:'user'|'base'}
 */
export function proposeReset(args) {
  const u = unitArgs(args)
  const season = args?.season === 'heating' || args?.season === 'cooling' ? args.season : null
  const reason = args?.reason === 'base' ? 'base' : 'user'
  const lockDate = Number.isFinite(u.now) ? nextApplyDate(u.cfg, u.tz, u.now) : null
  const mutation = {
    kind: 'reset', id: changeId([u.unitId, 'reset', season, reason, u.now]), unit: u.unitId, season, param: null, from: null, to: null,
    lock: reason !== 'base', lockDate, applyDate: lockDate, today: u.today, reason, rule: 'RESET',
  }
  const s0 = season ?? 'heating'
  const eff = effectivePrecondition(u.cfg, u.unitCfg, { ...(u.unitState ?? {}), tuning: emptyTuning() }, s0)
  const pk = numOr(tuningGuardrails(u.cfg).peakStartMin, 420)
  const message = T.rationale('RESET', { unit: u.unitId, season: s0, reason, baseDeltaF: eff.deltaF, deltaF: eff.deltaF, leadMin: eff.leadMin, peakStartMin: pk }, u.names, u.tz)
  return verdict(u, mutation, 'reset', { message })
}

/**
 * §5.12 row "precondition.deltaF[s] or leadMin[s] changed": for every unit with a tuned value in a
 * season whose base changed, a gated reset of that season (reason 'base', no lock).
 * → [{unit, season, ...proposeReset result}]
 */
export function baseResets(prevCfg, nextCfg, state, { tz, now } = {}) {
  const out = []
  const pick = (cfg, key, s) => { const v = cfg?.precondition?.[key]; return isNum(v) ? v : isObj(v) ? v[s] : undefined }
  for (const s of ['heating', 'cooling']) {
    if (pick(prevCfg, 'deltaF', s) === pick(nextCfg, 'deltaF', s) && pick(prevCfg, 'leadMin', s) === pick(nextCfg, 'leadMin', s)) continue
    for (const unitCfg of Array.isArray(nextCfg?.units) ? nextCfg.units : []) {
      const unitState = state?.units?.[unitCfg?.id]
      const st = unitState?.tuning?.[s]
      if (!isObj(st) || (st.deltaF == null && st.leadMin == null)) continue
      out.push({ unit: unitCfg.id, season: s, ...proposeReset({ cfg: nextCfg, unitCfg, unitState, tz, now, season: s, reason: 'base' }) })
    }
  }
  return out
}

