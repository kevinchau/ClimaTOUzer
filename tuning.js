// tuning.js — effective precondition parameters, freeze-at-TAKE snapshots, the optimizer's apply
// gate and the commit-time check/mutation of `state.units[id].tuning` (addendum §2.11, §5.2, §5.3,
// §5.8–§5.12, §7.1). PURE: no I/O, no clock (every `now` is passed in), never uses process-local Date
// getters; local dates come from the injected `tz` (tz.js).
//
// Imported by optimizer, by tou.plan through injection, and by a host's decision layer (the reference app's decide,
// views and insights). It imports tou (gateOpen needs activeEventFor), tz and validate — no I/O.
//
// ── Effective parameters (§5.2) ───────────────────────────────────────────────────────────────────
// effectivePrecondition(cfg, unitCfg, unitState, season) →
//   {season, deltaF, leadMin, clampF:{coolingMin, heatingMax}, earliestStart, suspended,
//    source:'config'|'tuned', deltaSource:'config'|'tuned', leadSource:'config'|'tuned',
//    clampedBy:null|'maxDeltaF'|'minDeltaF'|'minLeadMin'|'earliestStart'}
//   base = cfg.precondition.{deltaF,leadMin}[season]; season null/unknown ⇒ returned season null and
//   the heating values are used (H5). A tuned value (tuning[season].deltaF|leadMin, a number) replaces
//   its base value and is clamped at READ time to the current guardrails:
//     deltaF ∈ [optimizer.minDeltaF, min(optimizer.maxDeltaF, 6)],  leadMin ∈ [optimizer.minLeadMin, 240]
//   so tightening a guardrail takes effect at the next ownership with zero writes. Only the TUNED
//   parameter is clamped (see notes: a tuned lead never rewrites a user's base Δ). Provenance is per
//   parameter (addendum D X1.1): `source` is 'tuned' iff deltaSource or leadSource is (the display flag);
//   only a TUNED LEAD is held to optimizer.earliestStart — `clampedBy` names the first guardrail that bound
//   a tuned value; 'earliestStart' means the tuned lead would start before optimizer.earliestStart for the
//   earliest precondition peak, which tou.preconditionWindow then clamps (H6 — tou owns the window; leadMin
//   itself is not rewritten). A tuned Δ alone never moves the base start.
//
// Freeze-at-TAKE (§5.2, H5): the host (the reference app's engine/decide) stores `auto.params = snapshotParams(...)`
// in the same commit as `baseline`; while `auto.phase !== 'idle'` those frozen params are the only source
// (`activeParams`). Nothing — tuning, guardrails, base config — can retarget a held temp or move a
// running window.
//
// ── Season (§5.3) ─────────────────────────────────────────────────────────────────────────────────
// seasonOf(mode): HEAT ⇒ 'heating'; COOL, DRY ⇒ 'cooling'; anything else ⇒ null. Never the calendar.
//
// ── Apply gate (§5.10) ────────────────────────────────────────────────────────────────────────────
// gateOpen({cfg, tz, unitCfg, unitState, now, effMax}) → {open, until, reason, eventId}
//   open ⇔ auto.phase === 'idle' ∧ tou.activeEventFor(cfg, tz, unitCfg, now, effMax) == null.
//   reason: null | 'owned' | 'precondition' | 'shed'; until = peakEnd (ms) of the blocking event|null.
//   effMax (eff with max(old, new) leadMin) is supplied by insights; when omitted, both seasons'
//   effective params are tried. The gate ignores `suspended` (conservative: a resume can start one).
//
// ── Commit-time check (§5.9) ──────────────────────────────────────────────────────────────────────
// check(unitState, mutation, {cfg, state, now, tz, unitId?}) → 'ok' | refusal code, in this order:
//   invalid     malformed mutation (unknown kind, missing season/param, from === to, …)
//   not_enabled G1  (kinds change/suspend)   optimizer or unit disabled, unit not shed+precondition
//   not_live    G2  (kinds change/suspend)   automation.mode ≠ 'live' or !state.scheduleEnabled
//   observe         (kinds change/suspend)   applyDate < liveFrom (or no enable timestamp)
//   locked          (kinds change/suspend)   applyDate ∈ tuning.lockedDates
//   already         (kind change)            tuning[s].lastAnalysisDate === mutation.analysisDate
//   cooldown        (kind change)            applyDate < tuning.cooldown['<s>.<param>.<dir>']
//   frozen          (kind change)            applyDate < tuning.frozen['<s>.<dir>']
//   guardrail       (kind change)            target outside the current guardrails / step / 5-min grid
//   superseded      CAS: current effective value ≠ mutation.from (change); history[0].id ≠ id or
//                   current ≠ history[0].to (revert); lastRevert.id ≠ id, newer mutation or current ≠
//                   lastRevert.from (undo); pending.id ≠ id (cancel)
//   expired         (kind undo) asked more than 10 min after the revert: mutation.requestedAt (a gated undo
//                   keeps its request time through the pending slot), else now
//   state           suspend while suspended / resume while not suspended
// User/system kinds (revert, undo, reset, resume, cancel) skip the optimizer gates G1/G2/observe/lock:
// a Reset must work with the optimizer off (§5.12 "holding +4° … with a Reset action") and base-change
// resets must run in any automation mode; resume is comfort-safe (R4b bypasses observe).
//
// ── Mutation (§5.9, §5.11) ────────────────────────────────────────────────────────────────────────
// mutation = {kind:'change'|'revert'|'undo'|'reset'|'suspend'|'resume'|'cancel', id, season, param:
//             'deltaF'|'leadMin'|null, from, to, applyDate, analysisDate, rule, …}
// A reset clears the tuned values and history of `season`; with `seasons` (a non-empty list — the §5.12
// base change of several seasons at once, ONE gated mutation per unit so the seasons never fight over
// the single pending slot) of each listed season; with neither, of both seasons AND the dormancy
// suspension (the user's whole-unit Reset, §5.11). Only that whole-unit form clears `suspended`.
// applyMutation(tuning, mutation, now, {cfg, tz}?) mutates the tuning sub-object IN PLACE (call it inside
// the host's state-commit mutator, after check() returned 'ok') and returns a summary
// {kind, season, param, from, to, lockedDate, cooldownKey, cooldownUntil, frozenKey, frozenUntil}.
// Dates it needs come from the mutation first (lockDate ?? applyDate, cooldownDays, today), else from
// cfg/tz. Every kind but cancel bumps evidenceFrom; value-changing kinds set setAt; `pending` is cleared
// only when it IS this mutation (same id) — an unrelated pending entry is left for promotePending to
// re-check. A cancel (the person's Cancel, or Revert of the pending entry) of a pending CHANGE also sets
// that season's lastAnalysisDate to the entry's analysisDate (never backwards): the cancel is that
// date's decision (G6), so a re-run over the same analysis date holds 'already' instead of re-issuing
// the same change id. System drops (insights dropPending) do not go through here and set nothing.
// A change's history entry keeps `fromRaw` (the stored tuned value it replaced; null = config base)
// beside the effective `from`; revert restores `fromRaw` (legacy entries without it: `from`), so a base
// outside the current guardrails comes back as the base — never as a tuned copy the read-time clamp
// would bind (which would leave the value unchanged and refuse the Undo as superseded).
//
// ── Optimum start (addendum D E2.3) ────────────────────────────────────────────────────────────────
// optimumLead({season, room, target, rateFph, capMin, baseLeadMin}) → {leadMin, source:'learned'|'fixed'|null,
//   need}: need = s·(target − room) (°F to move; s = −1 cooling, +1 otherwise; null when either is unknown);
//   capMin ≤ 0 or need ≤ 1 ⇒ leadMin 0 (no early start); rateFph ≥ 0.5 with a known need ⇒ learned =
//   ceil5(60·need/rateFph); else fixed = min(baseLeadMin ?? 120, 60); leadMin = min(capMin, that) rounded
//   UP to the 5-minute grid. A measurement, never a tuned parameter (a host's optimum-start logic decides with it).
//
// Other exports: emptyTuning(), normalizeTuning(t), nextApplyDate(cfg, tz, now), guardrails(cfg),
// preconditionPeakStartMin(cfg), observeInfo({cfg, state, unitState, tz, now, applyDate}),
// snapshotParams(...), activeParams(...), currentValue(...), dirOf(from, to), mutationSeasons(m), toPending(...),
// pruneTuning(tuning, today, tz?), validateTuningCfg(cfg), KINDS, REFUSALS, UNDO_WINDOW_MS.

import { activeEventFor, events as touEvents } from './tou.js'
import { addDays as addDaysStr, hhmmToMin, makeTz } from './tz.js'
import { validateOptimizer } from './validate.js'

export const SEASONS = ['heating', 'cooling']
export const PARAMS = ['deltaF', 'leadMin']
export const KINDS = ['change', 'revert', 'undo', 'reset', 'suspend', 'resume', 'cancel']
export const REFUSALS = ['invalid', 'not_enabled', 'not_live', 'observe', 'locked', 'already', 'cooldown', 'frozen', 'guardrail', 'superseded', 'expired', 'state']
export const UNDO_WINDOW_MS = 10 * 60 * 1000
export const HISTORY_MAX = 5
export const REVERTS_MAX = 10
export const FREEZE_DAYS = 14
export const PRUNE_DAYS = 14

const DAY_MS = 86400000
const HARD_DELTA = [1, 6] // core validation range of precondition.deltaF
const HARD_LEAD = [20, 240] // core validation range of precondition.leadMin
const DEFAULTS = { deltaF: 3, leadMin: 120, coolingMin: 65, heatingMax: 76, minDeltaF: 1, maxDeltaF: 4, minLeadMin: 60, earliestStart: '04:30', maxStepDeltaF: 1, maxStepLeadMin: 30, observeDays: 3, revertCooldownDays: 3, mergeGapMin: 30, peakStartMin: 420 }

function isNum(v) { return typeof v === 'number' && Number.isFinite(v) }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function numOr(v, d) { return isNum(v) ? v : d }
function seasonKey(season) { return season === 'cooling' ? 'cooling' : 'heating' }

function pick(v, season) {
  if (v == null) return undefined
  if (typeof v === 'number') return v
  return isObj(v) ? v[season] : undefined
}

function toMs(now) {
  if (isNum(now)) return now
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'string') { const t = Date.parse(now); return Number.isFinite(t) ? t : NaN }
  return NaN
}

function iso(ms) { return new Date(ms).toISOString() }

const tzCache = new Map()
function tzFor(cfg, tz) {
  if (tz) return tz
  const zone = typeof cfg?.timezone === 'string' && cfg.timezone ? cfg.timezone : 'America/Los_Angeles'
  let t = tzCache.get(zone)
  if (!t) { t = makeTz(zone); tzCache.set(zone, t) }
  return t
}

function addDays(tz, date, n) { return typeof tz?.addDays === 'function' ? tz.addDays(date, n) : addDaysStr(date, n) }

function localDateOf(tz, value) {
  const ms = toMs(value)
  return Number.isFinite(ms) ? tz.localParts(ms).date : null
}

function safeMin(hhmm, fallback) {
  try { return hhmmToMin(hhmm) } catch { return fallback }
}

// ---- season, shapes ------------------------------------------------------------------------------

/** HEAT ⇒ 'heating'; COOL/DRY ⇒ 'cooling'; else null (case-insensitive). */
export function seasonOf(mode) {
  const m = String(mode ?? '').trim().toUpperCase()
  if (m === 'HEAT') return 'heating'
  if (m === 'COOL' || m === 'DRY') return 'cooling'
  return null
}

function emptySeason() {
  return { deltaF: null, leadMin: null, setAt: null, evidenceFrom: null, lastAnalysisDate: null, history: [] }
}

/** The §2.11 `units[id].tuning` shape with nothing tuned (fresh objects on every call). */
export function emptyTuning() {
  return {
    enabledAt: null,
    heating: emptySeason(),
    cooling: emptySeason(),
    suspended: null,
    pending: null,
    lockedDates: [],
    cooldown: {},
    frozen: {},
    lastUpAt: null,
    lastRevert: null,
    reverts: [],
  }
}

/**
 * Fill missing/invalid fields of a (possibly partial or legacy) tuning object IN PLACE, keeping every
 * valid existing value; returns it. A non-object yields a fresh emptyTuning().
 */
export function normalizeTuning(t) {
  if (!isObj(t)) return emptyTuning()
  const base = emptyTuning()
  for (const k of Object.keys(base)) {
    if (SEASONS.includes(k)) {
      if (!isObj(t[k])) t[k] = base[k]
      else {
        const s = t[k]
        for (const f of Object.keys(base[k])) if (s[f] === undefined) s[f] = base[k][f]
        if (!Array.isArray(s.history)) s.history = []
        for (const p of PARAMS) if (s[p] != null && !isNum(s[p])) s[p] = null
      }
    } else if (Array.isArray(base[k])) {
      if (!Array.isArray(t[k])) t[k] = base[k]
    } else if (isObj(base[k])) {
      if (!isObj(t[k])) t[k] = base[k]
    } else if (t[k] === undefined) t[k] = base[k]
  }
  return t
}

// ---- guardrails ----------------------------------------------------------------------------------

/**
 * Earliest peakStart (minutes after local midnight) of any precondition-flagged merged peak event in
 * the weekday or weekend/holiday table | null when no event pre-conditions.
 */
export function preconditionPeakStartMin(cfg) {
  const gap = Math.max(0, numOr(cfg?.tou?.mergeGapMin, DEFAULTS.mergeGapMin))
  let best = null
  for (const key of ['weekday', 'weekendHoliday']) {
    const rows = Array.isArray(cfg?.tou?.[key]) ? cfg.tou[key] : []
    const peaks = []
    for (const r of rows) {
      if (!r || r.tier !== 'peak') continue
      const s = safeMin(r.start, null)
      const e = safeMin(r.end, null)
      if (s == null || e == null || e <= s) continue
      peaks.push({ s, e, pre: !!r.precondition })
    }
    peaks.sort((a, b) => a.s - b.s)
    let cur = null
    const evs = []
    for (const p of peaks) {
      if (cur && (p.s <= cur.e || p.s - cur.e < gap)) { cur.e = Math.max(cur.e, p.e); cur.pre = cur.pre || p.pre; continue }
      cur = { ...p }
      evs.push(cur)
    }
    for (const ev of evs) if (ev.pre && (best === null || ev.s < best)) best = ev.s
  }
  return best
}

/**
 * Current optimizer guardrails with defaults and hard ranges applied:
 * {minDeltaF, maxDeltaF, minLeadMin, maxLeadMin, earliestStart, earliestStartMin, peakStartMin,
 *  maxStepDeltaF, maxStepLeadMin}. maxLeadMin = min(240, peakStartMin − earliestStartMin).
 */
export function guardrails(cfg) {
  const opt = isObj(cfg?.optimizer) ? cfg.optimizer : {}
  const maxDeltaF = Math.max(HARD_DELTA[0], Math.min(numOr(opt.maxDeltaF, DEFAULTS.maxDeltaF), HARD_DELTA[1]))
  const minDeltaF = Math.min(Math.max(numOr(opt.minDeltaF, DEFAULTS.minDeltaF), HARD_DELTA[0]), maxDeltaF)
  const earliestStart = typeof opt.earliestStart === 'string' ? opt.earliestStart : DEFAULTS.earliestStart
  const earliestStartMin = safeMin(earliestStart, safeMin(DEFAULTS.earliestStart, 270))
  const peakStartMin = preconditionPeakStartMin(cfg)
  const minLeadMin = Math.max(HARD_LEAD[0], Math.min(numOr(opt.minLeadMin, DEFAULTS.minLeadMin), HARD_LEAD[1]))
  const room = (peakStartMin ?? DEFAULTS.peakStartMin) - earliestStartMin
  const maxLeadMin = Math.max(minLeadMin, Math.min(HARD_LEAD[1], room))
  return {
    minDeltaF, maxDeltaF, minLeadMin, maxLeadMin, earliestStart, earliestStartMin, peakStartMin,
    maxStepDeltaF: Math.max(0, numOr(opt.maxStepDeltaF, DEFAULTS.maxStepDeltaF)),
    maxStepLeadMin: Math.max(0, numOr(opt.maxStepLeadMin, DEFAULTS.maxStepLeadMin)),
  }
}

// ---- effective parameters and freeze-at-TAKE -----------------------------------------------------

/** §5.2 effective precondition params of one unit in `season` (see header). Pure; never throws. */
export function effectivePrecondition(cfg, unitCfg, unitState, season) {
  const valid = season === 'heating' || season === 'cooling'
  const s = seasonKey(season)
  const pc = isObj(cfg?.precondition) ? cfg.precondition : {}
  const opt = isObj(cfg?.optimizer) ? cfg.optimizer : {}
  const tuned = isObj(unitState?.tuning?.[s]) ? unitState.tuning[s] : null
  const tunedDelta = isNum(tuned?.deltaF) ? tuned.deltaF : null
  const tunedLead = isNum(tuned?.leadMin) ? tuned.leadMin : null
  let deltaF = tunedDelta ?? numOr(pick(pc.deltaF, s), DEFAULTS.deltaF)
  let leadMin = tunedLead ?? numOr(pick(pc.leadMin, s), DEFAULTS.leadMin)
  const deltaSource = tunedDelta != null ? 'tuned' : 'config'
  const leadSource = tunedLead != null ? 'tuned' : 'config'
  const source = tunedDelta != null || tunedLead != null ? 'tuned' : 'config'
  let clampedBy = null
  if (tunedDelta != null) {
    const hi = Math.min(numOr(opt.maxDeltaF, DEFAULTS.maxDeltaF), HARD_DELTA[1])
    const lo = numOr(opt.minDeltaF, DEFAULTS.minDeltaF)
    if (deltaF > hi) { deltaF = hi; clampedBy = 'maxDeltaF' } else if (deltaF < lo) { deltaF = lo; clampedBy = 'minDeltaF' }
  }
  if (tunedLead != null) {
    const lo = numOr(opt.minLeadMin, DEFAULTS.minLeadMin)
    if (leadMin < lo) { leadMin = lo; clampedBy = clampedBy ?? 'minLeadMin' } else if (leadMin > HARD_LEAD[1]) leadMin = HARD_LEAD[1]
  }
  const earliestStart = typeof opt.earliestStart === 'string' ? opt.earliestStart : DEFAULTS.earliestStart
  if (leadSource === 'tuned' && clampedBy === null) {
    const peak = preconditionPeakStartMin(cfg)
    const earliest = safeMin(earliestStart, null)
    if (peak != null && earliest != null && peak - leadMin < earliest) clampedBy = 'earliestStart'
  }
  const cf = isObj(pc.clampF) ? pc.clampF : {}
  return {
    season: valid ? season : null,
    deltaF,
    leadMin,
    clampF: { coolingMin: numOr(cf.coolingMin, DEFAULTS.coolingMin), heatingMax: numOr(cf.heatingMax, DEFAULTS.heatingMax) },
    earliestStart,
    suspended: !!unitState?.tuning?.suspended,
    source,
    deltaSource,
    leadSource,
    clampedBy,
  }
}

/**
 * The frozen `auto.params` object to store at ownership start (H5): effective params for the season of
 * the fresh read's `mode` (null season ⇒ heating values, season null). Plain JSON, no shared refs. Addendum B
 * §1.12: the pre-condition fan and fanOnlyMin are not snapshotted (auto.dryOutUntil is persisted instead).
 * Release 4: the host (the reference app's decide) passes `mode` = E*.mode ?? live.mode (B F3.11); opts.suspendedOverride (false for an ON
 * entry at peak, B C-11) replaces `suspended`; opts.season, when the key is present (even null), replaces
 * seasonOf(mode) — the seasonFor hook (C §1.3: a follower's season is the master's while it runs); the
 * snapshot carries deltaSource/leadSource (D X1.1: tou clamps a frozen window by leadSource ?? source).
 */
export function snapshotParams(cfg, unitCfg, unitState, mode, opts = {}) {
  const o = isObj(opts) ? opts : {}
  const season = 'season' in o ? o.season : seasonOf(mode)
  const e = effectivePrecondition(cfg, unitCfg, unitState, season)
  return {
    season: e.season,
    deltaF: e.deltaF,
    leadMin: e.leadMin,
    clampF: { ...e.clampF },
    earliestStart: e.earliestStart,
    suspended: typeof o.suspendedOverride === 'boolean' ? o.suspendedOverride : e.suspended,
    source: e.source,
    deltaSource: e.deltaSource,
    leadSource: e.leadSource,
  }
}

/** Addendum D E2.3 optimum-start lead (see header). Pure. */
export function optimumLead({ season, room, target, rateFph, capMin, baseLeadMin } = {}) {
  const s = season === 'cooling' ? -1 : 1
  const need = isNum(room) && isNum(target) ? Math.round(s * (target - room) * 1000) / 1000 : null
  if (!isNum(capMin) || capMin <= 0 || (need != null && need <= 1)) return { leadMin: 0, source: null, need }
  const ceil5 = (m) => Math.ceil(m / 5 - 1e-9) * 5
  const learned = isNum(rateFph) && rateFph >= 0.5 && need != null
  const lead = learned ? ceil5((60 * need) / rateFph) : Math.min(numOr(baseLeadMin, 120), 60)
  return { leadMin: ceil5(Math.min(capMin, lead)), source: learned ? 'learned' : 'fixed', need }
}

/**
 * Params in force for a unit: the frozen `auto.params` while it owns an event (phase ≠ idle), else the
 * effective params for the season of the last valid read (fallback heating, H5).
 */
export function activeParams(cfg, unitCfg, unitState, live) {
  const auto = unitState?.auto
  if (auto && auto.phase && auto.phase !== 'idle' && isObj(auto.params)) return auto.params
  const e = effectivePrecondition(cfg, unitCfg, unitState, seasonOf(live?.mode) ?? 'heating')
  return e
}

/** Current effective value of `param` ('deltaF'|'leadMin'|'suspended') — the CAS "current". */
export function currentValue(cfg, unitCfg, unitState, season, param) {
  if (param === 'suspended') return unitState?.tuning?.suspended ?? null
  const e = effectivePrecondition(cfg, unitCfg, unitState, season)
  return param === 'leadMin' ? e.leadMin : param === 'deltaF' ? e.deltaF : undefined
}

/** 'up' (more pre-conditioning) | 'down' | null. Both params: larger = up (deltaF is a magnitude). */
export function dirOf(from, to) {
  if (!isNum(from) || !isNum(to) || from === to) return null
  return to > from ? 'up' : 'down'
}

/** Seasons a mutation touches: its `seasons` list (multi-season base reset), else [season], else both. */
export function mutationSeasons(m) {
  if (Array.isArray(m?.seasons)) return m.seasons
  return SEASONS.includes(m?.season) ? [m.season] : SEASONS
}

// ---- dates ---------------------------------------------------------------------------------------

/** First local date whose morning a change made at `now` can affect: today before earliestStart, else tomorrow. */
export function nextApplyDate(cfg, tz, now) {
  const z = tzFor(cfg, tz)
  const ms = toMs(now)
  const today = z.localParts(ms).date
  const hhmm = typeof cfg?.optimizer?.earliestStart === 'string' ? cfg.optimizer.earliestStart : DEFAULTS.earliestStart
  let at
  try { at = z.zonedToInstant(today, hhmm) } catch { at = z.zonedToInstant(today, DEFAULTS.earliestStart) }
  return ms < at ? today : addDays(z, today, 1)
}

function dayDiff(a, b) { // whole days from date a to date b
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / DAY_MS)
}

/**
 * Observe-only status (§5.8): the later of state.insights.optimizerEnabledAt and tuning.enabledAt,
 * liveFrom = addDays(localDate(that), observeDays + 1), observe ⇔ applyDate < liveFrom. Without any
 * enable timestamp the unit is observing (liveFrom null). → {enabledAt, liveFrom, applyDate, observe,
 * daysLeft} (daysLeft from today when `now` is given, else null).
 */
export function observeInfo({ cfg, state, unitState, tz, now, applyDate } = {}) {
  const z = tzFor(cfg, tz)
  const cands = [state?.insights?.optimizerEnabledAt, unitState?.tuning?.enabledAt].filter((v) => Number.isFinite(toMs(v)))
  let enabledAt = null
  for (const c of cands) if (enabledAt === null || toMs(c) > toMs(enabledAt)) enabledAt = c
  const observeDays = Math.max(0, Math.floor(numOr(cfg?.optimizer?.observeDays, DEFAULTS.observeDays)))
  const liveFrom = enabledAt === null ? null : addDays(z, localDateOf(z, enabledAt), observeDays + 1)
  const ms = toMs(now)
  const ad = applyDate ?? (Number.isFinite(ms) ? nextApplyDate(cfg, z, ms) : null)
  const observe = liveFrom === null || ad === null || ad < liveFrom
  let daysLeft = null
  if (Number.isFinite(ms) && liveFrom !== null) daysLeft = Math.max(0, dayDiff(z.localParts(ms).date, liveFrom))
  return { enabledAt: enabledAt === null ? null : (typeof enabledAt === 'string' ? enabledAt : iso(toMs(enabledAt))), liveFrom, applyDate: ad, observe, daysLeft }
}

// ---- apply gate ----------------------------------------------------------------------------------

function eventEnd(cfg, tz, eventId) {
  if (typeof eventId !== 'string' || !eventId.includes('@')) return null
  const date = eventId.split('@')[0]
  try {
    const e = touEvents(cfg, tz, date).find((x) => x.id === eventId)
    return e ? e.peakEnd : null
  } catch { return null }
}

/** §5.10 gate: {open, until, reason:null|'owned'|'precondition'|'shed', eventId}. */
export function gateOpen({ cfg, tz, unitCfg, unitState, now, effMax } = {}) {
  const z = tzFor(cfg, tz)
  const ms = toMs(now)
  const auto = unitState?.auto
  const phase = auto?.phase ?? 'idle'
  if (phase !== 'idle') {
    const end = eventEnd(cfg, z, auto?.eventId)
    return { open: false, until: end != null && end > ms ? end : null, reason: 'owned', eventId: auto?.eventId ?? null }
  }
  const effs = effMax ? [effMax] : SEASONS.map((s) => effectivePrecondition(cfg, unitCfg, unitState, s))
  let hit = null
  for (const e of effs) {
    const a = activeEventFor(cfg, z, unitCfg ?? null, ms, { ...e, suspended: false })
    if (a && (!hit || a.preStart < hit.preStart)) hit = a
  }
  if (hit) return { open: false, until: hit.event.peakEnd, reason: hit.phase, eventId: hit.event.id }
  return { open: true, until: null, reason: null, eventId: null }
}

// ---- commit-time check ---------------------------------------------------------------------------

function findUnitId(state, unitState) {
  if (!isObj(state?.units) || !unitState) return null
  for (const [id, u] of Object.entries(state.units)) if (u === unitState) return id
  return null
}

function malformed(m) {
  if (!isObj(m) || !KINDS.includes(m.kind)) return true
  switch (m.kind) {
    case 'change':
      return !SEASONS.includes(m.season) || !PARAMS.includes(m.param) || !isNum(m.from) || !isNum(m.to) || m.from === m.to
    case 'revert':
    case 'undo':
      return m.id == null
    case 'reset':
      return (m.season != null && !SEASONS.includes(m.season)) ||
        (m.seasons != null && (!Array.isArray(m.seasons) || !m.seasons.length || m.seasons.some((s) => !SEASONS.includes(s))))
    case 'cancel':
      return m.id == null
    default:
      return false
  }
}

/** §5.9 commit-time re-check: 'ok' | refusal code (order in the header). Never mutates. */
export function check(unitState, mutation, ctx = {}) {
  const m = mutation
  if (malformed(m)) return 'invalid'
  const cfg = ctx.cfg ?? {}
  const state = ctx.state
  const z = tzFor(cfg, ctx.tz)
  const now = toMs(ctx.now)
  const kind = m.kind
  const t = isObj(unitState?.tuning) ? unitState.tuning : emptyTuning()
  const unitId = m.unit ?? ctx.unitId ?? findUnitId(state, unitState)
  const unitCfg = (Array.isArray(cfg.units) ? cfg.units : []).find((u) => u && u.id === unitId) ?? null
  const opt = isObj(cfg.optimizer) ? cfg.optimizer : {}

  if (kind === 'change' || kind === 'suspend') {
    if (!opt.enabled || !unitCfg || opt.units?.[unitId]?.enabled === false || unitCfg.shed === false || unitCfg.precondition === false) return 'not_enabled'
    if (cfg.automation?.mode !== 'live' || !state?.scheduleEnabled) return 'not_live'
    const applyDate = m.applyDate ?? (Number.isFinite(now) ? nextApplyDate(cfg, z, now) : null)
    if (observeInfo({ cfg, state, unitState, tz: z, applyDate }).observe) return 'observe'
    if (applyDate && Array.isArray(t.lockedDates) && t.lockedDates.includes(applyDate)) return 'locked'
    if (kind === 'change') {
      const st = isObj(t[m.season]) ? t[m.season] : emptySeason()
      if (typeof m.analysisDate === 'string' && m.analysisDate && st.lastAnalysisDate === m.analysisDate) return 'already'
      const dir = dirOf(m.from, m.to)
      const cd = t.cooldown?.[`${m.season}.${m.param}.${dir}`]
      if (cd && applyDate && applyDate < cd) return 'cooldown'
      const fr = t.frozen?.[`${m.season}.${dir}`]
      if (fr && applyDate && applyDate < fr) return 'frozen'
      const g = guardrails(cfg)
      const step = Math.abs(m.to - m.from)
      if (m.param === 'deltaF' && (m.to < g.minDeltaF || m.to > g.maxDeltaF || step > Math.max(g.maxStepDeltaF, 1) + 1e-9)) return 'guardrail'
      if (m.param === 'leadMin' && (m.to < g.minLeadMin || m.to > g.maxLeadMin || m.to % 5 !== 0 || step > g.maxStepLeadMin)) return 'guardrail'
      if (currentValue(cfg, unitCfg, unitState, m.season, m.param) !== m.from) return 'superseded'
      return 'ok'
    }
    return t.suspended ? 'state' : 'ok' // suspend
  }

  switch (kind) {
    case 'revert': {
      const s = m.season ?? findSeasonOfChange(t, m.id)
      const st = s && isObj(t[s]) ? t[s] : null
      const h = st?.history?.[0]
      if (!h || h.id !== m.id) return 'superseded'
      if (currentValue(cfg, unitCfg, unitState, s, h.param) !== h.to) return 'superseded'
      if (isNum(m.from) && m.from !== h.to) return 'superseded'
      return 'ok'
    }
    case 'undo': {
      const lr = t.lastRevert
      if (!isObj(lr) || lr.id !== m.id) return 'superseded'
      const st = isObj(t[lr.season]) ? t[lr.season] : null
      const h0 = st?.history?.[0]
      if (h0 && toMs(h0.at) >= toMs(lr.at)) return 'superseded'
      if (currentValue(cfg, unitCfg, unitState, lr.season, lr.param) !== lr.from) return 'superseded'
      // judged at the request: a gated undo keeps requestedAt through the pending slot (promoted after the peak)
      const asked = toMs(m.requestedAt)
      const ref = Number.isFinite(asked) ? asked : now
      if (!Number.isFinite(ref) || ref - toMs(lr.at) > UNDO_WINDOW_MS) return 'expired'
      return 'ok'
    }
    case 'cancel':
      return isObj(t.pending) && t.pending.id === m.id ? 'ok' : 'superseded'
    case 'resume':
      return t.suspended ? 'ok' : 'state'
    case 'reset':
    default:
      return 'ok'
  }
}

function findSeasonOfChange(t, id) {
  for (const s of SEASONS) if (Array.isArray(t?.[s]?.history) && t[s].history.some((h) => h && h.id === id)) return s
  return null
}

// ---- mutation ------------------------------------------------------------------------------------

function bump(t, seasons, at) {
  for (const s of seasons) t[s].evidenceFrom = at
}

/**
 * Apply a checked mutation to the tuning sub-object IN PLACE (inside the host's state-commit mutator).
 * `now` = epoch ms (or ISO/Date). ctx = {cfg, tz} supplies dates the mutation does not carry.
 * Returns a summary for activity lines; throws TypeError on a non-object `tuning` or a malformed mutation.
 */
export function applyMutation(tuning, mutation, now, ctx = {}) {
  if (!isObj(tuning)) throw new TypeError('applyMutation: tuning must be an object')
  if (malformed(mutation)) throw new TypeError(`applyMutation: malformed mutation ${JSON.stringify(mutation?.kind ?? null)}`)
  const t = normalizeTuning(tuning)
  const m = mutation
  const ms = toMs(now)
  if (!Number.isFinite(ms)) throw new TypeError('applyMutation: now must be a time')
  const at = iso(ms)
  const cfg = ctx.cfg
  const z = cfg || ctx.tz ? tzFor(cfg, ctx.tz) : null
  const today = m.today ?? (z ? z.localParts(ms).date : null)
  const lockDate = m.lockDate ?? m.applyDate ?? (z ? nextApplyDate(cfg, z, ms) : null)
  const summary = { kind: m.kind, season: m.season ?? null, param: m.param ?? null, from: m.from ?? null, to: m.to ?? null, lockedDate: null, cooldownKey: null, cooldownUntil: null, frozenKey: null, frozenUntil: null }
  const clearPendingIfMine = () => { if (!t.pending || t.pending.id === m.id) t.pending = null }

  switch (m.kind) {
    case 'change': {
      const st = t[m.season]
      const fromRaw = st[m.param] ?? null // the stored value it replaces (null = config base); revert restores it
      st[m.param] = m.to
      st.setAt = at
      st.evidenceFrom = at
      if (m.analysisDate != null) st.lastAnalysisDate = m.analysisDate
      st.history.unshift({ id: m.id ?? null, param: m.param, from: m.from, fromRaw, to: m.to, at, rule: m.rule ?? null, applyDate: m.applyDate ?? null, analysisDate: m.analysisDate ?? null })
      if (st.history.length > HISTORY_MAX) st.history.length = HISTORY_MAX
      if (dirOf(m.from, m.to) === 'up') t.lastUpAt = m.applyDate ?? today ?? t.lastUpAt
      t.lastRevert = null
      clearPendingIfMine()
      return summary
    }

    case 'revert': {
      const s = m.season ?? findSeasonOfChange(t, m.id)
      if (!s) throw new TypeError('applyMutation: revert of an unknown change')
      const st = t[s]
      const h = st.history[0]
      if (!h || h.id !== m.id) throw new TypeError('applyMutation: revert target is not history[0] (run check() first)')
      const dir = dirOf(h.from, h.to)
      st[h.param] = h.fromRaw === null || isNum(h.fromRaw) ? h.fromRaw : h.from // legacy entries: effective `from`
      st.setAt = at
      st.evidenceFrom = at
      st.history.shift()
      Object.assign(summary, { season: s, param: h.param, from: h.to, to: h.from })
      // lock the next apply date
      let lockAdded = false
      if (lockDate && !t.lockedDates.includes(lockDate)) { t.lockedDates.push(lockDate); t.lockedDates.sort(); lockAdded = true }
      summary.lockedDate = lockDate ?? null
      // cooldown on the reverted direction
      let cooldownKey = null
      let cooldownPrev
      if (dir && lockDate) {
        const days = Math.max(0, Math.floor(numOr(m.cooldownDays, numOr(cfg?.optimizer?.revertCooldownDays, DEFAULTS.revertCooldownDays))))
        cooldownKey = `${s}.${h.param}.${dir}`
        cooldownPrev = t.cooldown[cooldownKey]
        const until = addDays(z, lockDate, days)
        if (!cooldownPrev || cooldownPrev < until) t.cooldown[cooldownKey] = until
        Object.assign(summary, { cooldownKey, cooldownUntil: t.cooldown[cooldownKey] })
      }
      // freeze after 2 same-direction reverts within 14 days
      let frozenKey = null
      let frozenPrev
      const rev = { at, season: s, param: h.param, dir }
      if (dir) {
        const sameDir = t.reverts.filter((r) => r && r.season === s && r.dir === dir && ms - toMs(r.at) <= FREEZE_DAYS * DAY_MS)
        if (sameDir.length >= 1) {
          const base = today ?? lockDate
          if (base) {
            frozenKey = `${s}.${dir}`
            frozenPrev = t.frozen[frozenKey]
            const until = addDays(z, base, FREEZE_DAYS)
            if (!frozenPrev || frozenPrev < until) t.frozen[frozenKey] = until
            Object.assign(summary, { frozenKey, frozenUntil: t.frozen[frozenKey] })
          }
        }
      }
      t.reverts.push(rev)
      if (t.reverts.length > REVERTS_MAX) t.reverts.splice(0, t.reverts.length - REVERTS_MAX)
      t.lastRevert = {
        id: h.id, at, season: s, param: h.param, from: h.from, to: h.to, dir,
        entry: { ...h },
        lockedDate: lockAdded ? lockDate : null,
        cooldownKey, cooldownPrev: cooldownPrev ?? null,
        frozenKey, frozenPrev: frozenPrev ?? null,
      }
      clearPendingIfMine()
      return summary
    }

    case 'undo': {
      const lr = t.lastRevert
      if (!isObj(lr) || lr.id !== m.id) throw new TypeError('applyMutation: nothing to undo (run check() first)')
      const st = t[lr.season]
      st[lr.param] = lr.to
      st.setAt = at
      st.evidenceFrom = at
      st.history.unshift(isObj(lr.entry) ? { ...lr.entry } : { id: lr.id, param: lr.param, from: lr.from, to: lr.to, at: lr.at, rule: null, applyDate: null, analysisDate: null })
      if (st.history.length > HISTORY_MAX) st.history.length = HISTORY_MAX
      if (lr.lockedDate) t.lockedDates = t.lockedDates.filter((d) => d !== lr.lockedDate)
      if (lr.cooldownKey) { if (lr.cooldownPrev) t.cooldown[lr.cooldownKey] = lr.cooldownPrev; else delete t.cooldown[lr.cooldownKey] }
      if (lr.frozenKey) { if (lr.frozenPrev) t.frozen[lr.frozenKey] = lr.frozenPrev; else delete t.frozen[lr.frozenKey] }
      const i = t.reverts.findIndex((r) => r && r.at === lr.at && r.season === lr.season && r.param === lr.param)
      if (i >= 0) t.reverts.splice(i, 1)
      if (lr.dir === 'up') t.lastUpAt = lr.entry?.applyDate ?? today ?? t.lastUpAt
      Object.assign(summary, { season: lr.season, param: lr.param, from: lr.from, to: lr.to })
      t.lastRevert = null
      clearPendingIfMine()
      return summary
    }

    case 'reset': {
      const seasons = mutationSeasons(m)
      for (const s of seasons) {
        const st = t[s]
        st.deltaF = null
        st.leadMin = null
        st.history = []
        st.setAt = at
      }
      bump(t, seasons, at)
      if (!m.season && m.seasons == null) t.suspended = null // whole-unit Reset only; a base change never resumes
      if (m.lock !== false && lockDate && !t.lockedDates.includes(lockDate)) { t.lockedDates.push(lockDate); t.lockedDates.sort() }
      summary.lockedDate = m.lock !== false ? lockDate ?? null : null
      t.lastRevert = null
      clearPendingIfMine()
      return summary
    }

    case 'suspend': {
      t.suspended = { since: m.since ?? m.applyDate ?? today, changeId: m.id ?? null }
      bump(t, m.season ? [m.season] : SEASONS, at)
      Object.assign(summary, { param: 'suspended', from: false, to: true })
      clearPendingIfMine()
      return summary
    }

    case 'resume': {
      t.suspended = null
      bump(t, m.season ? [m.season] : SEASONS, at)
      Object.assign(summary, { param: 'suspended', from: true, to: false })
      clearPendingIfMine()
      return summary
    }

    case 'cancel': {
      const p = t.pending
      if (!p || p.id !== m.id) return summary
      // the person's cancel is D's decision for the season (G6): a re-run over D must not re-issue it
      const st = p.kind === 'change' && SEASONS.includes(p.season) ? t[p.season] : null
      if (st && typeof p.analysisDate === 'string' && p.analysisDate && (typeof st.lastAnalysisDate !== 'string' || st.lastAnalysisDate < p.analysisDate)) st.lastAnalysisDate = p.analysisDate
      t.pending = null
      return summary
    }

    default:
      throw new TypeError(`applyMutation: unknown kind ${m.kind}`)
  }
}

/**
 * The §2.11 `tuning.pending` entry for a gated mutation:
 * {id, kind, season, param, from, to, applyDate, analysisDate, queuedAt, reason, actor} (+ rule).
 */
export function toPending(mutation, { now, reason = null, actor = null } = {}) {
  const m = mutation ?? {}
  const ms = toMs(now)
  return {
    id: m.id ?? null,
    kind: m.kind ?? 'change',
    season: m.season ?? null,
    param: m.param ?? (m.kind === 'suspend' || m.kind === 'resume' ? 'suspended' : null),
    from: m.from ?? null,
    to: m.to ?? null,
    applyDate: m.applyDate ?? null,
    analysisDate: m.analysisDate ?? null,
    rule: m.rule ?? null,
    queuedAt: Number.isFinite(ms) ? iso(ms) : null,
    reason,
    actor: actor ?? m.actor ?? null,
  }
}

/**
 * Housekeeping (§3.7 step 4 / §2.11): drop lockedDates and reverts older than 14 days (local dates via
 * the optional tz), and cooldown/frozen entries that no longer block (value ≤ today). Mutates in place;
 * returns true if anything changed.
 */
export function pruneTuning(tuning, today, tz) {
  if (!isObj(tuning) || typeof today !== 'string') return false
  let changed = false
  const cutoff = addDaysStr(today, -PRUNE_DAYS)
  if (Array.isArray(tuning.lockedDates)) {
    const kept = tuning.lockedDates.filter((d) => typeof d === 'string' && d >= cutoff)
    if (kept.length !== tuning.lockedDates.length) { tuning.lockedDates = kept; changed = true }
  }
  if (Array.isArray(tuning.reverts)) {
    // Local midnight of the cutoff date via tz; without tz a lenient bound (UTC midnight − 1 day)
    // keeps a revert at most one extra day — harmless, the freeze rule itself uses a 14-day ms window.
    const [y, mo, d] = cutoff.split('-').map(Number)
    const cutoffMs = tz ? tz.zonedToInstant(cutoff, '00:00') : Date.UTC(y, mo - 1, d) - DAY_MS
    const kept = tuning.reverts.filter((r) => r && Number.isFinite(toMs(r.at)) && toMs(r.at) >= cutoffMs)
    if (kept.length !== tuning.reverts.length) { tuning.reverts = kept; changed = true }
  }
  for (const k of ['cooldown', 'frozen']) {
    if (!isObj(tuning[k])) continue
    for (const [key, until] of Object.entries(tuning[k])) {
      if (typeof until !== 'string' || until <= today) { delete tuning[k][key]; changed = true }
    }
  }
  return changed
}

/** The optimizer section's errors (guardrails, earliestStart vs the first peak, comfort bands): validate.validateOptimizer. */
export function validateTuningCfg(cfg) {
  return validateOptimizer(cfg)
}
