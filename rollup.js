// rollup.js — daily usage rollup + peak-episode extraction (addendum §4.5, §4.6, §7.1). PURE:
// no I/O, no clock (the caller passes `builtAt`), no process-local Date getters (all wall-clock math
// goes through the injected `tz`, tz.js makeTz()). Deterministic: identical inputs ⇒ identical
// output object (fixed key order, fixed rounding) ⇒ identical bytes under JSON.stringify.
//
// Units: every instant INSIDE a rollup is integer-ish epoch SECONDS (same as the raw usage records,
// addendum §3.5); minutes are rounded to 0.1; temperatures to 0.1 (medians/means to 0.01).
//
// ── DailyRollup (one local date, all units) ─────────────────────────────────────────────────────
// { v: ROLLUP_V, date, complete: true, builtAt, dayType, dayMinutes (1380|1440|1500),
//   start, end,                                         // [local 00:00, next local 00:00) in s
//   segments: [{tier, start, end}], events: [{id, peakStart, peakEnd, precondition}],
//   outdoor: {min, max, mean, n, filled, coverage, hdd65, cdd65},    // coverage = covered slots / slots
//   outdoorCoverage,                                    // = outdoor.coverage (the §4.5/§4.7 name)
//   counts: {s, c, a, o, p, b, h, bad, m?},               // m only on a day with house-mode records (Addendum H)
//   units: { [unitId]: UnitRollup },
//   tail:  { [unitId]: Tail } }                          // pass as the next day's `prevTail`
//
// UnitRollup = { id, coverage (0..1), coveredMin,
//   onMin | fanMin | offMin | unknownMin: {peak, off_peak, super_off_peak, total},
//     (addendum B C-8: ON minutes of buckets with p = 1 ∧ m = 'FAN' — fan only, compressor off — count into fanMin,
//      not onMin; rollups built before it have no fanMin)
//   forcedMin | forcedFanMin | standbyMin: {peak, off_peak, super_off_peak, total} (addendum C C6.1 overlays: the ON
//     minutes of buckets inside the unit's forced intervals — conditioning buckets stay in onMin, Fan buckets in fanMin;
//     only standby buckets move out of onMin into standbyMin; readers treat a missing key as 0, ROLLUP_V stays 1)
//   modeMin: {[mode]: min} (ON minutes only, FAN included), season: 'heating'|'cooling'|null,
//   setpoint: {mean (time-weighted over ON), min, max, userChanges},
//   room: {peak|off_peak|super_off_peak|day: {min, max, mean, n}},
//   band: {L, H, insideMin, belowMin, aboveMin, peakInsideMin, peakCoveredMin, shedInsideMin, shedCoveredMin, awayMin?},
//     (Addendum H: a room bucket inside the unit's away intervals counts into awayMin, never into inside/below/above or the
//      peak counts — the four add up to the covered room minutes; an away episode's shed never counts into shedInside/
//      shedCovered. awayMin only on a day the unit was away)
//   changes: {schedule, user, system, external, gapped, total},
//     (C6.7: a mode `c` record within 90 s of a forced/unforced line of the unit with v ≈ its `to` — never an unforced
//      how 'person' — is reclassified s 'system': no override, no extMinutes, not a user change)
//   jobs: {writes, verified, wouldWrite, retries, verifyFail, failing, blocked, recovered, items:[{t, ty, cl, f, message}] (≤ 10)},
//   params: [{t, se, pa, fr, to, s, id}]                // 'p' records (tuning changes) of the day
//   spark: {t0, stepMin: 15, room: [n|null], on: [0..1|null]},     // dayMinutes/15 slots (96 on normal days)
//   episodes: [Episode], boots,
//   away?: [{mode: 'left-home'|'vacation', from, until}],   // Addendum H: the unit's away intervals of the day (clipped
//                                                       // to it, sorted) — the key only on a day the unit was away
//   cfgSnapshot: {band: [L, H], touRev, system: {master, forcing, conflict}} }
//
// Tail = {power, mode, temp, fan, at, ext: [{d, m: [minuteOfDay]}], forced, away?} — last bucket state plus the local
//   minute-of-day of external overrides on the last ≤ 6 event days (feeds the HomeKit `auto` flag, §4.6,
//   which needs "the last 7 event days"; chaining it through prevTail keeps rollups pure per day); forced =
//   {from, mode, by, kind:'rewrite', cause, sameSeason} | null, the forcing still open at the day end (C6.8: the next
//   day's intervals continue it from local midnight); away = {mode, since} — the unit's away interval still open at the
//   day end (Addendum H; since = the instant its away stretch began, kept across a Left Home ↔ Vacation switch; the key
//   only while one is open — a unit with no bucket that day keeps a tail for it).
//
// Away intervals (Addendum H, the house modes): the day's `m` records (records.js: {k:'m', t, mode, from, by, u}) in `t`
//   order, continued from prevTail.away at local midnight — a unit listed in `u` of a mode other than 'standard' is away
//   in that mode (a record naming the open mode is a no-op, one naming the other mode splits the interval — the stretch
//   keeps its since); any other record ends it (the return to Standard, or the unit left out of house modes).
// Forced intervals (addendum C C6.1, forcedIntervals below): 'rewrite' from the unit's forced/unforced `a` lines
//   (a forced line opens one — a repeated one is a no-op, one naming another mode splits it — an unforced line closes
//   it), 'standby' from the samples while the constraint is on (a follower bucket with p = 1 in a conditioning mode
//   while the master's bucket has p = 1 in a mode of ANOTHER season — by season, so a Dry master over a Cool follower
//   is never standby), each intersected with the unit's p = 1 buckets (forcing changes nothing on an OFF unit).
//
// Unit kinds (INJECTED — the core knows no device kind; reference-app Addendum G §2.2 §4.5 / §4.6): rollupDay({…,
//   unitRules}) takes (unitId) → {shed?: 'off' | 'setback', seasonOf?(mode) → season, floorF?} | null (null ⇒ a heat
//   pump's rules, every output as before). seasonOf decides UnitRollup.season (the majority of ON minutes by the kind's
//   season — a water heater's 'Heat Pump' is 'water') and an episode's fallback season; a phase line's se may be
//   'water' too. 's' records may carry rn (running seconds — the heater heating) and hw (the hot-water level 'full' |
//   'some' | 'low'): UnitRollup.runMin {peak, off_peak, super_off_peak, total} appears when any bucket has rn.
//   A setback unit (shed 'setback') is ON through its shed: the episode carries shedKind 'setback'; offAt = the
//   scheduler's verified shed TEMP write (at or after peakStart), shed.sp its setpoint; comfort points = every bucket
//   with a reading in [offAt, shedEnd); drift points stop at the first bucket at or below sp + 1 °F (the heater
//   restarted); class / violMin against floorF (the tank's comfortMinF) when given, else the band; rec.onAt = the
//   verified RETURN temp write after the shed's exit; shed gains {sp, floorMin (minutes at or below the floor), lowMin
//   (minutes at hot-water level 'low'), ranMin (minutes running, null without rn), levels {first, last} | null}; a
//   bucket with a level counts for coverage; q 'no_sensor' (after 'pre_only') when the event's window has neither a
//   reading nor a level. classify / comfortDirOf accept the 'water' season (the heating direction).
//
// Multi-split constraint (INJECTED — the core imports no device topology): rollupDay({…, constraint}) takes
//   {on, master, forcing, conflict}. On a multi-split system one outdoor unit serves several indoor units and the
//   master's mode can force a follower's; the reference app passes its system.constraint(cfg). `constraint` decides
//   which units are followers (on ∧ a configured unit ∧ not the master) for the samples rule above, and is recorded in
//   UnitRollup.cfgSnapshot.system {master, forcing, conflict}. Omitted or null ⇒ no constraint (snapshot {master: null,
//   forcing: null, conflict: null}); the 'rewrite' intervals from forced/unforced lines are read either way.
//
// Episode (per unit, per event of the day; §4.6) =
// { ev, date, unit, kind: 'peak'|'boundary', peakStart, peakEnd, precondition (event flag), preStart|null,
//   status: 'done'|'released'|'skipped'|'was_off'|'dry'|'absent', season, par: {deltaF, leadMin}|null, dryRun,
//   (was_off ⇔ the FIRST take power line is OFF → OFF, addendum B F3.21 C-12; season: phase_enter(precondition).se
//    first, then the take temp sign against base ?? fr (C-4), then the shed's se, then the mode at peakStart;
//    phase_enter(precondition) = the event's LAST one, and the take temp the first at or after it — see replanned)
//   (dryRun ⇔ an `a` phase_enter of the event has dry: true — entered in dry run — or, for lines logged before
//    that flag, would_write with no take and no scheduler write; ⇒ status 'dry', par null, q 'dry')
//   preSkipped: the notice's reason ('already conditioned', 'season_mismatch', …) else its code | null (CD-11),
//   conditioned: {keeps, target} | null   (C F3.11′: the silent 'already conditioned' line — no pre-conditioning ran),
//   preFromOff: bool   (B F3.21: the first take power line is OFF → ON — the precondition turned the unit on for an entry),
//   replanned: true — only when the event has more than one precondition phase_enter (Release 4.2, Addendum F rule 10: a
//    keep-mode precondition re-planned for a new season before anything was sent logs a second one, reason
//    'season_changed', with the new season's params and the window kept); season, par, preStart and pre then come from
//    the last one and the first take temp at or after it (the takes before it were un-owned unsent). The key is absent
//    otherwise (an episode with one phase_enter reads exactly as before); the optimizer leaves such an episode out of E
//    (its leadUsed runs from the re-plan instant, not par.leadMin),
//   away?: 'left-home'|'vacation'  (Addendum H, A §4.6: one of the unit's away intervals overlaps the episode's NOMINAL
//    window [start, peakEnd), start = preStart ?? the event's pre-condition window from the config (a pre-conditioned
//    event: tou.preconditionWindow with the configured lead — a return inside it pre-conditions nothing, H rule 4b, so the
//    window is judged as planned, not as run) ?? peakStart; an interval ending in the window counts, at its start too
//    (the return); the mode of the newest such interval; the key only then — q 'away' after 'dry' and 'forced'. The
//    episode itself reads as without the key: the optimizer's E and realisation leave it out, the drift fit keeps it),
//   pre:  {orig, app, dApp, capped, T0, T0room, Tpk, rise, eff, reached, t90, reachedMinBeforePeak, leadUsed} | null,
//    (orig = take(temp).base ?? fr — the scheduled setpoint when the bump came from an entry; T0room = the measured
//     room before preStart; T0 = orig for a preFromOff episode (C-3: rise/eff/t90 over the bump above the scheduled
//     setpoint), else T0room)
//   shed: {offAt, end, cov, rOff, drift: {b, a, n, se, r2, cov, dropped, ok}|null, driftFph,
//          Tmin, Tmax, m, violMin, class, Tout, rBar, gap, x, filled, flat, jump} | null,
//    (Tout = mean outdoor over [offAt, shedEnd) — each slot's real sample, else its hourly back-fill; filled ⇔ any slot
//     of the window was back-filled)
//    (violMin also counts the fan-only buckets, addendum B §0.5; class, m, Tmin/Tmax and cov stay on the OFF window)
//   fanOnly: {from, until, min} | null,   (addendum B F2.14: from = t of the verified scheduler write mode → FAN — or,
//    when the episode has none, of the shed phase_enter with rs adopted_fan / carried_dryout (C CD-6) —,
//    until = t(take power, rs 'dry-out ended by you') ?? offAt ?? shedEnd; offAt stays the scheduler's OFF)
//   rec:  {onAt, sp, minToSp, slope, jump} | null,
//   released: {t, by: 'user'|'external', f, v} | null,   (f/v from the line; a field-less line — logged before decide
//    put the person's power on it — is a power ON when a user/external power OFF → ON `c` record lies within 90 s,
//    else f 'power' when the owned power was dropped by a dashboard/external line at the same t — never by the
//    'system' un-own ahead of a mode-change release, addendum B N-15; onAt = t(released) for a power-ON release)
//   overrides: [{t, f, o, v, s: 'user'|'external', ty, comfortDir, auto}],   (an `a` line within 90 s of an item of
//    its field — or of any item, for a field-less release — is the same override)
//   forced: [{from, until, mode, by, kind:'rewrite'|'standby', sameSeason}]   (C6.1: the unit's forced intervals over
//    [preStart ?? peakStart, max(peakEnd, rec.onAt + minToSp)), clipped to it),
//   forcedBand: {outMin, worstF, byTier:{peak, off_peak, super_off_peak}|null} | null   (C6.2: room buckets out of the band
//    inside a forced interval that is not a same-season one ∩ p = 1; null without such an interval),
//   dryoutSkipped: {reason: 'follower_running'|'master_conditioning', units:[ids]} | null   (the event's dryout_skipped line),
//   jobs: {retries, failing, blocked},
//   q: 'dry'|'forced'|'away'|'pre_only'|'low_coverage'|'flat'|'jump'|'ok' }  // first applicable in that order (C6.2: forced ⇔
//                                                               // the non-same-season forced intervals cover ≥ 50 % of
//                                                               // the p = 1 buckets in [preStart ?? peakStart, peakEnd))
//
// Release 4.1 (addendum E E1.14): a BOUNDARY event (the weekend pre-condition: a weekend/holiday super off-peak →
//   off-peak step t, peakStart = peakEnd = t — told from the instants, nothing extra is mirrored) yields kind 'boundary':
//   pre as above (T0 over [preStart − 15 min, preStart), Tpk over [t − 15 min, t)); never a shed or a fan-only (shed,
//   fanOnly null — a return of power/mode to an overnight OFF/FAN after restore-now is no OFF window); rec only from a
//   scheduler power ON at/after t (a refused precondition ON the return delivered, N-23 — never a person's release);
//   overrides over [preStart, t + 5 min); forced over [preStart, t); q 'pre_only' after 'dry' and 'forced'. A unit that
//   never engaged (status 'absent': OFF, or ON in Fan/Auto, with no ON entry, E1.8) has no boundary episode (J23).
//   Peak episodes: kind 'peak' (older rollups have no kind — readers test kind === 'boundary').
//
// Window membership: a 5-min bucket (record `t` = bucket start) belongs to [a, b) when a ≤ t < b.
//   drift points  = buckets with on = 0 ∧ n ≥ 1 ∧ cv ≥ 120 in [offAt + 10 min, shedEnd)
//   comfort points = buckets with on = 0 ∧ n ≥ 1 in [offAt, shedEnd)  (no settle exclusion; shed.cov = 5·n / window min)
//   shed.violMin also counts the fan-only buckets except those inside a forced interval (C6.2: the master's decision)

import * as tou from './tou.js'
import { addDays } from './tz.js'
import { median, mean, ols, robustOls } from './stats.js'

export const ROLLUP_V = 1

// The multi-split constraint is injected (rollupDay's `constraint`, see the header): the core knows no device topology.
const NO_CONSTRAINT = Object.freeze({ on: false, master: null, forcing: null, conflict: null })

function constraintOf(c) {
  if (!c || typeof c !== 'object') return NO_CONSTRAINT
  const master = typeof c.master === 'string' && c.master ? c.master : null
  return { on: c.on === true && master != null, master, forcing: c.forcing ?? null, conflict: c.conflict ?? null }
}

/** 'master' | 'follower' | null: null while the constraint is off or for a unit that is not configured. */
function roleIn(c, cfg, unitId) {
  if (!c.on || !(Array.isArray(cfg?.units) ? cfg.units : []).some((u) => u && u.id === unitId)) return null
  return unitId === c.master ? 'master' : 'follower'
}

const TIERS = ['peak', 'off_peak', 'super_off_peak']
const SEASONS3 = new Set(['heating', 'cooling', 'water']) // an episode's season (a host's water heater: 'water')
const BUCKET = 300 // s
const SETTLE = 600 // s (10 min)
const MAX_JOB_ITEMS = 10
const EXT_DAYS = 6 // previous event days kept in the tail (+ today = the "last 7 event days")

// ───────────────────────────── small math (pure) ─────────────────────────────

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
const round1 = (x) => (isNum(x) ? Math.round(Number(x) * 10) / 10 + 0 : null)
const round2 = (x) => (isNum(x) ? Math.round(Number(x) * 100) / 100 + 0 : null)
const round3 = (x) => (isNum(x) ? Math.round(Number(x) * 1000) / 1000 + 0 : null)
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ───────────────────────────── helpers ─────────────────────────────

const up = (v) => (v == null ? '' : String(v).toUpperCase())
const seasonSign = (season) => (season === 'cooling' ? -1 : 1)

function seasonOfMode(mode) {
  const m = up(mode)
  if (m === 'HEAT') return 'heating'
  if (m === 'COOL' || m === 'DRY') return 'cooling'
  return null
}

function bandOf(band) {
  if (Array.isArray(band)) return { L: Number(band[0]), H: Number(band[1]) }
  if (band && typeof band === 'object') return { L: Number(band.L ?? band.lowF ?? band[0]), H: Number(band.H ?? band.highF ?? band[1]) }
  return { L: 68, H: 78 }
}

function inWin(t, a, b) { return t >= a && t < b }

/** Seconds from a {t} that may be seconds or milliseconds (defensive for outdoorFill). */
function toSec(t) { const x = Number(t); return x > 1e11 ? x / 1000 : x }

function unitBand(cfg, unitId) {
  const oc = cfg?.optimizer?.units?.[unitId] ?? {}
  const off = isNum(oc.sensorOffsetF) ? Number(oc.sensorOffsetF) : 0
  const L = (isNum(oc.comfortLowF) ? Number(oc.comfortLowF) : 68) + off
  const H = (isNum(oc.comfortHighF) ? Number(oc.comfortHighF) : 78) + off
  return [round1(L), round1(H)]
}

function emptyTiers() { return { peak: 0, off_peak: 0, super_off_peak: 0 } }
function roundTiers(o) {
  const out = {}
  let total = 0
  for (const k of TIERS) { out[k] = round1(o[k]); total += o[k] }
  out.total = round1(total)
  return out
}

function stat(values) {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return { min: null, max: null, mean: null, n: 0 }
  let mn = Infinity
  let mx = -Infinity
  let s = 0
  for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; s += x }
  return { min: round1(mn), max: round1(mx), mean: round2(s / v.length), n: v.length }
}

// Merge 's' records sharing one bucket start (a restart mid-bucket emits two partial buckets).
function normBuckets(list) {
  list.sort((a, b) => a.t - b.t)
  const out = []
  for (const r of list) {
    const b = {
      t: Number(r.t),
      r: isNum(r.r) ? Number(r.r) : null,
      n: isNum(r.n) ? Number(r.n) : 0,
      cv: clampNum(isNum(r.cv) ? Number(r.cv) : 0, 0, BUCKET),
      on: 0,
      p: r.p == null ? null : Number(r.p) ? 1 : 0,
      m: r.m ?? null,
      sp: isNum(r.sp) ? Number(r.sp) : null,
      f: r.f ?? null,
    }
    if (isNum(r.rn)) b.rn = clampNum(Number(r.rn), 0, b.cv) // a host's running seconds (a water heater's, G §3.2)
    if (typeof r.hw === 'string') b.hw = r.hw // the hot-water level (full | some | low)
    b.on = clampNum(isNum(r.on) ? Number(r.on) : 0, 0, b.cv)
    const last = out[out.length - 1]
    if (last && last.t === b.t) {
      const n = last.n + b.n
      if (b.r != null && last.r != null && n > 0) last.r = round2((last.r * last.n + b.r * b.n) / n)
      else if (last.r == null) last.r = b.r
      last.n = n
      last.cv = Math.min(BUCKET, last.cv + b.cv)
      last.on = Math.min(last.cv, last.on + b.on)
      if (b.p != null) { last.p = b.p; last.m = b.m; last.sp = b.sp; last.f = b.f }
      if (b.rn != null) last.rn = Math.min(last.cv, (last.rn ?? 0) + b.rn)
      if (b.hw != null) last.hw = b.hw
      continue
    }
    out.push(b)
  }
  return out
}

const hasRoom = (b) => b.n >= 1 && b.r != null

/** Last bucket starting at or before t (buckets sorted by t) | null. */
function bucketAt(buckets, t) {
  let hit = null
  for (const b of buckets) { if (b.t > t) break; hit = b }
  return hit
}

// ───────────────────────────── outdoor ─────────────────────────────

function interpAt(fill, t) {
  if (!fill.length) return null
  if (t < fill[0].t || t > fill[fill.length - 1].t) return null
  for (let i = 0; i < fill.length; i++) {
    const p = fill[i]
    if (p.t === t) return p.f
    if (p.t > t) {
      const q = fill[i - 1]
      if (!q || p.t - q.t > 2 * 3600) return null
      return q.f + ((p.f - q.f) * (t - q.t)) / (p.t - q.t)
    }
  }
  return null
}

/** Real 'o' samples plus hourly back-fill for empty slots → {samples:[{t, f, filled}], coverage, filled}. */
function outdoorSeries(oRecs, outdoorFill, t0, t1, slotSec) {
  const fill = (Array.isArray(outdoorFill) ? outdoorFill : [])
    .filter((p) => p && isNum(p.t) && isNum(p.f))
    .map((p) => ({ t: toSec(p.t), f: Number(p.f) }))
    .sort((a, b) => a.t - b.t)
  const real = oRecs.slice().sort((a, b) => a.t - b.t)
  const slots = Math.max(1, Math.round((t1 - t0) / slotSec))
  const samples = []
  let covered = 0
  let filled = 0
  let j = 0
  for (let i = 0; i < slots; i++) {
    const a = t0 + i * slotSec
    const b = i === slots - 1 ? t1 : a + slotSec
    let any = false
    while (j < real.length && real[j].t < b) {
      if (real[j].t >= a) { samples.push({ t: real[j].t, f: real[j].f, filled: false }); any = true }
      j++
    }
    if (any) { covered++; continue }
    const v = interpAt(fill, a)
    if (v != null) { samples.push({ t: a, f: round1(v), filled: true }); covered++; filled++ }
  }
  return { samples, coverage: round2(covered / slots), filled }
}

// ───────────────────────────── episode pieces (exported, pure) ─────────────────────────────

/**
 * Comfort class over the OFF-window points (§4.6). points: [{r}] ; band [L, H] | {L, H};
 * season 'heating'|'cooling'|null; cov = comfort coverage of the OFF window (default 1).
 * → {class: 'violated'|'unknown'|'tight'|'ok'|'comfortable', m, violMin, Tmin, Tmax}
 * A violation counts with any coverage; tight/ok/comfortable need cov ≥ 0.6.
 */
export function classify(points, band, season, marginF = 1, comfyMarginF = 2, cov = 1) {
  const rs = (points ?? []).map((p) => (p && typeof p === 'object' ? p.r : p)).filter(isNum).map(Number)
  if (!rs.length) return { class: 'unknown', m: null, violMin: 0, Tmin: null, Tmax: null }
  const Tmin = Math.min(...rs)
  const Tmax = Math.max(...rs)
  if (season !== 'heating' && season !== 'cooling' && season !== 'water') return { class: 'unknown', m: null, violMin: 0, Tmin: round1(Tmin), Tmax: round1(Tmax) }
  const { L, H } = bandOf(band)
  const s = seasonSign(season)
  const zEdge = s > 0 ? L : -H
  let zMin = Infinity
  let viol = 0
  for (const r of rs) {
    const z = s * r
    if (z < zMin) zMin = z
    if (z < zEdge - 1e-9) viol++
  }
  const m = round2(zMin - zEdge)
  const violMin = 5 * viol
  let cls
  if (violMin >= 10) cls = 'violated'
  else if (!(Number(cov) >= 0.6)) cls = 'unknown'
  else if (m < Number(marginF)) cls = 'tight'
  else if (m >= Number(comfyMarginF)) cls = 'comfortable'
  else cls = 'ok'
  return { class: cls, m, violMin, Tmin: round1(Tmin), Tmax: round1(Tmax) }
}

/**
 * OLS drift fit over OFF-window points (§4.6). points: [{t (bucket start, s), r}] already restricted to
 * the drift window [offAt + 10 min, shedEnd); offAt in s. x = (t + 150 − offAt)/3600 h, y = r.
 * One robust pass (stats.robustOls) drops points whose residual lies more than max(1.0, 3·1.4826·MAD)
 * from the median residual, and refits. opts.end = shedEnd (for cov; default the
 * end of the last point's bucket); opts.flat = sensor flat flag (ok requires !flat).
 * → {b (°F/h), a, n, se, r2, cov, dropped, ok} | null (fewer than 3 points or no x spread)
 */
export function driftFit(points, offAt, opts = {}) {
  const pts = (points ?? []).filter((p) => p && isNum(p.t) && isNum(p.r)).map((p) => ({ t: Number(p.t), r: Number(p.r) })).sort((a, b) => a.t - b.t)
  if (pts.length < 3 || !isNum(offAt)) return null
  const off = Number(offAt)
  const xs = pts.map((p) => (p.t + BUCKET / 2 - off) / 3600)
  const ys = pts.map((p) => p.r)
  // one robust pass (stats.robustOls: MAD threshold max(1.0, 3·1.4826·MAD), refit when anything dropped)
  const fit = robustOls(xs, ys, { floorF: 1.0, k: 3 }) ?? ols(xs, ys)
  if (!fit) return null
  const dropped = fit.dropped ?? 0
  const gone = new Set(fit.droppedIdx ?? [])
  const kept = xs.filter((_, i) => !gone.has(i))
  const end = isNum(opts.end) ? Number(opts.end) : pts[pts.length - 1].t + BUCKET
  const winMin = (end - (off + SETTLE)) / 60
  const cov = winMin > 0 ? Math.min(1, (5 * fit.n) / winMin) : 0
  const spanMin = (Math.max(...kept) - Math.min(...kept)) * 60
  const ok = fit.n >= 6 && spanMin >= 45 - 1e-9 && cov >= 0.6 && fit.se <= 0.4 && !opts.flat
  return { b: round2(fit.b), a: round1(fit.a), n: fit.n, se: round3(fit.se), r2: round2(fit.r2), cov: round2(cov), dropped, ok }
}

/**
 * Sensor flags (§4.6). points: drift-window OFF points [{t, r}] (sorted or not); Tout °F|null; onAt s|null;
 * bucketsAfterOn: buckets (any; filtered to [onAt, onAt + 10 min)).
 * opts: {offAt, shedEnd, offPoints (comfort points for r̄ and the pre-ON median; default points)}.
 * flat ⇔ ≥ 12 consecutive (5-min adjacent) points with identical r ∧ |Tout − r̄| ≥ 10 ∧ shed ≥ 60 min.
 * jump ⇔ onAt ≠ null ∧ |median r [onAt, onAt+10 min) − median r [shedEnd−10 min, shedEnd)| ≥ 2.0.
 */
export function sensorFlags(points, Tout, onAt, bucketsAfterOn, opts = {}) {
  const pts = (points ?? []).filter((p) => p && isNum(p.t) && isNum(p.r)).map((p) => ({ t: Number(p.t), r: Number(p.r) })).sort((a, b) => a.t - b.t)
  const offPts = (opts.offPoints ?? pts).filter((p) => p && isNum(p.t) && isNum(p.r)).map((p) => ({ t: Number(p.t), r: Number(p.r) })).sort((a, b) => a.t - b.t)
  let flat = false
  if (pts.length >= 12 && isNum(Tout)) {
    let run = 1
    let best = 1
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t === BUCKET && Math.abs(pts[i].r - pts[i - 1].r) < 1e-9) run++
      else run = 1
      if (run > best) best = run
    }
    const rBar = mean(offPts.map((p) => p.r))
    const offAt = isNum(opts.offAt) ? Number(opts.offAt) : (offPts[0]?.t ?? pts[0].t)
    const end = isNum(opts.shedEnd) ? Number(opts.shedEnd) : pts[pts.length - 1].t + BUCKET
    flat = best >= 12 && rBar != null && Math.abs(Number(Tout) - rBar) >= 10 && end - offAt >= 3600
  }
  let jump = false
  if (isNum(onAt)) {
    const on = Number(onAt)
    const after = (bucketsAfterOn ?? []).filter((b) => b && isNum(b.t) && isNum(b.r) && (b.n == null || b.n >= 1) && inWin(Number(b.t), on, on + 600)).map((b) => Number(b.r))
    const end = isNum(opts.shedEnd) ? Number(opts.shedEnd) : (offPts.length ? offPts[offPts.length - 1].t + BUCKET : null)
    const before = end == null ? [] : offPts.filter((p) => inWin(p.t, end - 600, end)).map((p) => p.r)
    const ma = median(after)
    const mb = median(before)
    jump = ma != null && mb != null && Math.abs(ma - mb) >= 2.0 - 1e-9
  }
  return { flat, jump }
}

// ───────────────────────────── forced intervals (addendum C C6.1) ─────────────────────────────

/** p = 1 bucket runs [{a, b}] of sorted normalised buckets (b = the end of the run's last bucket). */
function onRuns(B) {
  const out = []
  for (const b of B) {
    if (b.p !== 1) continue
    const last = out[out.length - 1]
    if (last && last.b === b.t) last.b = b.t + BUCKET
    else out.push({ a: b.t, b: b.t + BUCKET })
  }
  return out
}

const inIntervals = (list, t) => list.some((x) => t >= x.from && t < x.until)

/**
 * A unit's forced intervals of one day (see the header) → {intervals: [{from, until, mode, by, kind, sameSeason}] sorted
 * by from, open: tail.forced | null}. PURE. buckets: the unit's 's' records; markers: its 'a' records; masterBuckets:
 * the master's 's' records (only for a follower while the constraint is on — the samples rule), masterId; prevTail: the
 * unit's previous-day tail; start / end: the day [local 00:00, next 00:00) in s.
 */
export function forcedIntervals({ buckets, markers, masterBuckets = null, masterId = null, prevTail = null, start, end }) {
  const B = normBuckets((buckets ?? []).slice())
  const A = (markers ?? []).filter((a) => a && (a.ty === 'forced' || a.ty === 'unforced')).slice().sort((a, b) => a.t - b.t)
  const raw = []
  const piece = (o, until) => ({ from: o.at, until, mode: o.mode, by: o.by ?? null, kind: 'rewrite', sameSeason: !!o.sameSeason })
  const pf = prevTail?.forced
  let open = pf && pf.mode ? { origin: Number(pf.from ?? start), at: start, mode: up(pf.mode), by: pf.by ?? masterId, cause: pf.cause ?? 'master', sameSeason: !!pf.sameSeason } : null
  for (const a of A) {
    const t = Number(a.t)
    if (a.ty === 'unforced') {
      if (open) { raw.push(piece(open, t)); open = null }
      continue
    }
    const mode = up(a.to)
    if (open && open.mode === mode) continue // a repeated line, or the master's same mode: the same forcing (C-14)
    if (open) raw.push(piece(open, t)) // the master moved to a third mode: the record goes on in the new one
    open = { origin: open?.origin ?? t, at: t, mode, by: a.by ?? open?.by ?? masterId, cause: a.rs ?? open?.cause ?? 'master', sameSeason: a.ss === true }
  }
  if (open) raw.push(piece(open, end))
  const rewrite = raw.slice()
  if (masterBuckets) {
    const M = new Map(normBuckets(masterBuckets.slice()).map((b) => [b.t, b]))
    let cur = null
    for (const b of B) {
      const mb = M.get(b.t)
      const fs = seasonOfMode(b.m)
      const hit = b.p === 1 && fs != null && !!mb && mb.p === 1 && seasonOfMode(mb.m) !== fs && !inIntervals(rewrite, b.t)
      if (hit && cur && cur.until === b.t && cur.mode === up(mb.m)) cur.until = b.t + BUCKET
      else if (hit) { cur = { from: b.t, until: b.t + BUCKET, mode: up(mb.m), by: masterId, kind: 'standby', sameSeason: false }; raw.push(cur) }
      else cur = null
    }
  }
  const runs = onRuns(B)
  const intervals = []
  for (const x of raw) {
    for (const r of runs) {
      const from = Math.max(x.from, r.a)
      const until = Math.min(x.until, r.b)
      if (until > from) intervals.push({ ...x, from, until })
    }
  }
  intervals.sort((x, y) => x.from - y.from || x.until - y.until)
  const tailForced = open ? { from: open.origin, mode: open.mode, by: open.by ?? null, kind: 'rewrite', cause: open.cause, sameSeason: !!open.sameSeason } : null
  return { intervals, open: tailForced }
}

// ───────────────────────────── away intervals (Addendum H) ─────────────────────────────

/**
 * One unit's away intervals of the day (see the header) → {intervals: [{mode, from, until}] sorted, open: {mode, since} |
 * null (the tail's away)}. marks: the day's `m` records sorted by t; start / end: the day in s.
 */
function awayIntervals(marks, unitId, prevTail, start, end) {
  const intervals = []
  const pa = prevTail?.away
  let open = pa && typeof pa.mode === 'string' && pa.mode ? { mode: pa.mode, since: isNum(pa.since) ? Number(pa.since) : start, at: start } : null
  const close = (t) => { if (t > open.at) intervals.push({ mode: open.mode, from: open.at, until: t }) }
  for (const m of marks) {
    const t = Number(m.t)
    const held = m.mode !== 'standard' && m.u.includes(unitId)
    if (open && held && m.mode === open.mode) continue // the same mode again (a re-mint, a boot): no-op
    if (open) close(t)
    open = held ? { mode: m.mode, since: open?.since ?? t, at: t } : null // Left Home ↔ Vacation: the stretch goes on
  }
  if (open) close(end)
  return { intervals, open: open ? { mode: open.mode, since: open.since } : null }
}

/**
 * The start of an episode's nominal window (see the header): the pre-condition it ran, else the window the config gives a
 * pre-conditioned event, else the peak. e: the event (ms or s), ps: its peakStart in s.
 */
function nominalStart(cfg, tz, e, ps, pe, preStart, season) {
  if (preStart != null) return preStart
  if (!e.precondition || !cfg?.tou || !tz) return ps
  try {
    const w = tou.preconditionWindow(cfg, tz, { ...e, peakStart: ps * 1000, peakEnd: pe * 1000 }, season)
    return w ? Math.round(w.preStart / 1000) : ps
  } catch {
    return ps
  }
}

// ───────────────────────────── episodes ─────────────────────────────

function findMarker(M, pred) { for (const a of M) if (pred(a)) return a; return null }

function comfortDirOf(o, season, offAt) {
  const s = season === 'heating' || season === 'water' ? 1 : season === 'cooling' ? -1 : 0
  if (o.f === 'power') return up(o.v) === 'ON' && offAt != null && o.t >= offAt
  if (o.f === 'temp') return s !== 0 && isNum(o.v) && isNum(o.o) && s * (Number(o.v) - Number(o.o)) > 0
  if (o.f === 'mode') return (season === 'heating' && up(o.v) === 'HEAT') || (season === 'cooling' && (up(o.v) === 'COOL' || up(o.v) === 'DRY'))
  return false
}

/**
 * Episodes of one unit for the day's events (§4.6).
 * @param {object} a
 * @param {string} a.unitId
 * @param {Array} a.buckets   the unit's 's' records (normalised or raw), any order
 * @param {Array} a.changes   the unit's 'c' records
 * @param {Array} a.markers   the unit's 'a' records
 * @param {Array} a.events    tou.events(cfg, tz, date) (epoch ms) or episode-shaped {id, peakStart, peakEnd} in s
 *                            (peakEnd ≤ peakStart ⇒ a boundary event, addendum E)
 * @param {Array|object} a.band  [L, H] (comfort band + sensorOffsetF)
 * @param {Array} a.outdoor   [{t (s), f, filled?}] outdoor samples of the day
 * @param {number} a.marginF, a.comfyMarginF
 * @param {object} [a.tz]     makeTz() instance (local minute-of-day for the `auto` flag)
 * @param {Array} [a.extHistory]  [{d, m:[minuteOfDay]}] external-override minutes of the previous ≤ 6 event days
 * @param {object} [a.prevTail]   previous day's tail for this unit (mode fallback for `season`)
 * @param {string} [a.date]
 * @param {Array} [a.forced]  the unit's forced intervals of the day (forcedIntervals().intervals; addendum C C6.1)
 * @param {Function} [a.tierOf]  bucket start (s) → tier (forcedBand.byTier; without it byTier is null)
 * @param {Array} [a.away]    the unit's away intervals of the day ([{mode, from, until}] in s; Addendum H — see the header)
 * @param {object} [a.cfg]    the config (the nominal pre-condition window of an away episode; without it the peak)
 * @returns {Array} Episode[]
 */
export function buildEpisodes({ unitId, buckets, changes, markers, events, band, outdoor, marginF = 1, comfyMarginF = 2, tz, extHistory = [], prevTail = null, date = null, forced = [], tierOf = null, away = [], cfg = null, rules = null }) {
  const setback = rules?.shed === 'setback'
  const seasonOfM = typeof rules?.seasonOf === 'function' ? rules.seasonOf : seasonOfMode
  const B = normBuckets((buckets ?? []).slice())
  const C = (changes ?? []).slice().sort((a, b) => a.t - b.t)
  const A = (markers ?? []).slice().sort((a, b) => a.t - b.t)
  const O = (outdoor ?? []).filter((o) => o && isNum(o.t) && isNum(o.f))
  const bnd = bandOf(band)
  const out = []
  for (const e of events ?? []) {
    const msEvent = Number(e.peakStart) > 1e11
    const ps = msEvent ? Number(e.peakStart) / 1000 : Number(e.peakStart)
    const pe = msEvent ? Number(e.peakEnd) / 1000 : Number(e.peakEnd)
    const boundary = pe <= ps // addendum E: a boundary event — an empty peak, precondition only (see the header)
    const M = A.filter((a) => a.e === e.id)
    // Addendum F rule 10: a precondition re-planned for a new season before anything was sent logs a second phase_enter
    // (reason 'season_changed'); the episode is the last one's — its season, params, preStart and the first temp take
    // at or after it (the takes before it were dropped unsent) — and says so (replanned)
    const pres = M.filter((a) => a.ty === 'phase_enter' && a.ph === 'precondition')
    const pePre = pres.length ? pres[pres.length - 1] : null
    const replanned = pres.length > 1
    const peShed = findMarker(M, (a) => a.ty === 'phase_enter' && a.ph === 'shed')
    const takeTemp = findMarker(pePre ? M.slice(M.indexOf(pePre)) : M, (a) => a.ty === 'take' && a.f === 'temp')
    const takePower = findMarker(M, (a) => a.ty === 'take' && a.f === 'power')
    const released = findMarker(M, (a) => a.ty === 'released')
    const skipped = findMarker(M, (a) => a.ty === 'skipped')
    const would = M.some((a) => a.ty === 'would_write')
    const preNotice = findMarker(M, (a) => a.ty === 'notice' && String(a.why ?? '').startsWith('precondition_'))
    const dryNotice = findMarker(M, (a) => a.ty === 'notice' && a.why === 'dryout_skipped')
    const owned = !!(pePre || peShed || takeTemp || takePower)
    // dry run: a phase entered in dry run (`dry`), or — lines logged before phase_enter carried it — would_write
    // with no take and no scheduler write. Never a real episode (status 'dry', par null, q 'dry'; §4.6).
    const dryRun = !!(pePre?.dry || peShed?.dry) || (would && !takeTemp && !takePower && !M.some((a) => a.ty === 'write' && a.ac === 'scheduler'))
    // A release line without a field (lines logged before decide put the person's power on it): a power ON when the
    // person's OFF → ON `c` record lies within 90 s (external: first sighting before the confirmation; dashboard: the
    // verified manual ON after it), else a power release when the owned power was dropped at the same instant.
    let rel = released
    if (released && released.f == null) {
      const rt = Number(released.t)
      const on = C.find((c) => c.f === 'power' && (c.s === 'user' || c.s === 'external') && up(c.o) === 'OFF' && up(c.v) === 'ON' && Math.abs(Number(c.t) - rt) <= 90)
      if (on) rel = { ...released, f: 'power', to: 'ON' }
      else if (M.some((a) => a.ty === 'drop' && a.f === 'power' && Number(a.t) === rt && (a.ac === 'dashboard' || a.ac === 'external'))) rel = { ...released, f: 'power' }
    }

    // season: phase_enter(precondition).se → take(temp) sign against base ?? fr (addendum B C-4: a precondition from an
    // entry bumps the scheduled setpoint, not the overnight one) → the shed's se → mode at peakStart → null
    const takeBase = takeTemp ? (isNum(takeTemp.bs) ? takeTemp.bs : takeTemp.fr) : null
    let season = null
    if (SEASONS3.has(pePre?.se)) season = pePre.se
    else if (takeTemp && isNum(takeBase) && isNum(takeTemp.to) && Number(takeTemp.to) !== Number(takeBase)) {
      season = Number(takeTemp.to) > Number(takeBase) ? 'heating' : 'cooling'
    } else if (SEASONS3.has(peShed?.se)) season = peShed.se
    else {
      const b = bucketAt(B, ps)
      season = seasonOfM(b ? b.m : prevTail?.mode)
    }
    const s = seasonSign(season)

    // F3.21: the FIRST take power line decides — OFF → OFF the shed took an OFF unit (was_off); OFF → ON the precondition
    // turned it on for an entry (preFromOff); a later retarget line (dry-out over) never flips either
    const preFromOff = !!takePower && up(takePower.fr) === 'OFF' && up(takePower.to) === 'ON'
    let status
    if (dryRun) status = 'dry'
    else if (!owned) status = skipped ? 'skipped' : 'absent'
    else if (takePower && up(takePower.fr) === 'OFF' && up(takePower.to) === 'OFF') status = 'was_off'
    else if (released) status = 'released'
    else if (skipped) status = 'skipped'
    else status = 'done'
    if (boundary && status === 'absent') continue // J23: the unit never had the event (no phase, no line, no episode)

    const par = !dryRun && pePre?.par && isNum(pePre.par.deltaF) ? { deltaF: Number(pePre.par.deltaF), leadMin: isNum(pePre.par.leadMin) ? Number(pePre.par.leadMin) : null } : null
    const preStart = pePre ? Number(pePre.t) : null

    let offAt = null
    let shedSp = null // a setback's setpoint (the verified shed temp write's)
    const exitShed = findMarker(M, (a) => a.ty === 'phase_exit' && a.ph === 'shed')
    if (status === 'was_off') offAt = ps
    else if (!boundary && setback) {
      // A §4.6 (G): a setback sheds the setpoint — offAt = the scheduler's verified shed temp write
      const w = findMarker(M, (a) => a.ty === 'write' && a.f === 'temp' && a.ac === 'scheduler' && a.res === 'verified' && Number(a.t) >= ps && Number(a.t) < (exitShed ? Number(exitShed.t) : pe))
      offAt = w ? Number(w.t) : null
      shedSp = w && isNum(w.to) ? Number(w.to) : null
    } else if (!boundary) {
      const w = findMarker(M, (a) => a.ty === 'write' && a.f === 'power' && up(a.to) === 'OFF' && (a.fr == null || up(a.fr) === 'ON') && a.ac === 'scheduler' && a.res === 'verified')
      offAt = w ? Number(w.t) : null
    }
    // (never a precondition's own power ON from an entry, addendum B F3.11: a restore ON comes after the shed began) — a
    // setback's recovery starts at its verified RETURN temp write (after the shed's exit)
    const onWrite = setback
      ? (offAt != null && exitShed ? findMarker(M, (a) => a.ty === 'write' && a.f === 'temp' && a.ac === 'scheduler' && a.res === 'verified' && Number(a.t) >= Number(exitShed.t)) : null)
      : findMarker(M, (a) => a.ty === 'write' && a.f === 'power' && up(a.to) === 'ON' && a.ac === 'scheduler' && a.res === 'verified' && a.t >= (offAt ?? ps))
    let shedEnd = pe
    for (const c of [released?.t, setback ? null : onWrite?.t, exitShed?.t]) if (isNum(c) && Number(c) < shedEnd) shedEnd = Number(c)
    if (offAt != null && shedEnd < offAt) shedEnd = offAt
    let onAt = onWrite ? Number(onWrite.t) : null
    if (onAt == null && !boundary && rel && rel.f === 'power' && up(rel.to) === 'ON') onAt = Number(rel.t)

    // ── fan-only dry-out (addendum B F2.14): the verified FAN write until the person ended it, the app's OFF or the
    // shed's end (a FAN write that did not take, or a dry run, has none)
    // (C CD-6: an adopted master FAN or an F2′ fan-only carried into the shed has no FAN write inside the episode —
    // the shed phase_enter's reason starts it)
    let fanOnly = null
    const fanW = dryRun || boundary ? null : findMarker(M, (a) => a.ty === 'write' && a.f === 'mode' && up(a.to) === 'FAN' && a.ac === 'scheduler' && a.res === 'verified')
    const fanFrom = fanW ?? (!dryRun && (peShed?.rs === 'adopted_fan' || peShed?.rs === 'carried_dryout') ? peShed : null)
    if (fanFrom) {
      const ended = findMarker(M, (a) => a.ty === 'take' && a.f === 'power' && a.rs === 'dry-out ended by you')
      const from = Number(fanFrom.t)
      const until = Math.max(from, ended ? Number(ended.t) : offAt ?? shedEnd)
      fanOnly = { from, until, min: round1((until - from) / 60) }
    }

    // ── precondition ──
    let pre = null
    // addendum B: pre.orig = take(temp).base ?? fr; a preFromOff episode measures the realisation from the scheduled
    // setpoint (T0 := orig), keeping the measured room as T0room (C-3)
    if (par && takeTemp && status !== 'was_off' && isNum(takeBase) && isNum(takeTemp.to)) {
      const orig = Number(takeBase)
      const app = Number(takeTemp.to)
      const dApp = Math.abs(app - orig)
      const capped = dApp < par.deltaF - 0.01
      const T0room = preStart != null ? median(B.filter((b) => hasRoom(b) && inWin(b.t, preStart - 900, preStart)).map((b) => b.r)) : null
      const T0 = preFromOff ? orig : T0room
      const Tpk = median(B.filter((b) => hasRoom(b) && inWin(b.t, ps - 900, ps)).map((b) => b.r))
      const rise = T0 != null && Tpk != null ? s * (Tpk - T0) : null
      const eff = rise != null && dApp > 0 ? clampNum(rise / dApp, -0.5, 1.5) : null
      const reached = Tpk != null ? s * (Tpk - app) >= -0.5 - 1e-9 : null
      const during = preStart != null ? B.filter((b) => hasRoom(b) && inWin(b.t, preStart, ps)) : []
      let t90 = null
      if (rise != null && rise >= 0.3) {
        const hit = during.find((b) => s * (b.r - T0) >= 0.9 * rise - 1e-9)
        if (hit) t90 = Math.round((hit.t - preStart) / 60)
      }
      const reach = during.find((b) => s * (b.r - app) >= -0.5 - 1e-9)
      const reachedMinBeforePeak = reach ? Math.round((ps - reach.t) / 60) : 0
      pre = {
        orig, app, dApp: round1(dApp), capped,
        T0: round2(T0), T0room: round2(T0room), Tpk: round2(Tpk), rise: round2(rise), eff: round2(eff), reached,
        t90, reachedMinBeforePeak, leadUsed: preStart != null ? Math.round((ps - preStart) / 60) : null,
      }
    }

    // ── shed ──
    let shed = null
    let flags = { flat: false, jump: false }
    if (offAt != null) {
      // a setback unit stays ON: every bucket with a reading is a comfort point; the drift runs while the heater is quiet
      // (the reading above the setback + 1 °F) and ends at the first bucket at or below it
      const comfortPts = B.filter((b) => (setback || b.on === 0) && hasRoom(b) && inWin(b.t, offAt, shedEnd))
      let driftPts = comfortPts.filter((b) => b.cv >= 120 && b.t >= offAt + SETTLE)
      if (setback && shedSp != null) {
        const stop = comfortPts.find((b) => s * (b.r - (shedSp + 1)) <= 1e-9)
        driftPts = driftPts.filter((b) => stop == null || b.t < stop.t)
      }
      const winMin = (shedEnd - offAt) / 60
      const cov = winMin > 0 ? Math.min(1, (5 * comfortPts.length) / winMin) : 0
      const rBar = mean(comfortPts.map((b) => b.r))
      // the outdoor series already holds each slot's real sample, else its back-fill (outdoorSeries): a partial outage
      // keeps the filled slots in Tout, as the day's outdoor.mean does
      const oWin = O.filter((o) => inWin(Number(o.t), offAt, shedEnd))
      const filled = oWin.some((o) => o.filled)
      const Tout = oWin.length ? mean(oWin.map((o) => Number(o.f))) : null
      flags = sensorFlags(driftPts, Tout, onAt, B, { offAt, shedEnd, offPoints: comfortPts })
      const drift = driftFit(driftPts, offAt, { end: shedEnd, flat: flags.flat })
      const floorF = setback && isNum(rules?.floorF) ? Number(rules.floorF) : null // the tank's comfortMinF (a reading floor)
      const cls = classify(comfortPts, floorF != null ? { L: floorF, H: Infinity } : bnd, season, marginF, comfyMarginF, cov)
      // violations also count the fan-only buckets (the compressor is off there too, §0.5); the class, margin and
      // coverage stay on the OFF window, whose physics the evidence is about
      const fanPts = fanOnly ? B.filter((b) => hasRoom(b) && inWin(b.t, fanOnly.from, fanOnly.until) && !inIntervals(forced, b.t)) : []
      const violMin = cls.violMin + classify(fanPts, bnd, season).violMin
      const offB = bucketAt(B.filter(hasRoom), offAt)
      shed = {
        offAt, end: shedEnd, cov: round2(cov), rOff: offB ? offB.r : null,
        drift, driftFph: drift ? drift.b : null,
        Tmin: cls.Tmin, Tmax: cls.Tmax, m: cls.m, violMin, class: cls.class,
        Tout: round1(Tout), rBar: round2(rBar),
        gap: rBar != null && Tout != null ? round1(rBar - Tout) : null,
        x: rBar != null && Tout != null && season ? round1(s * (Tout - rBar)) : null,
        filled, flat: flags.flat, jump: flags.jump,
      }
      if (setback) {
        // G1.11 evidence: minutes at or below the floor (the tank's comfortMinF, a room's band floor), at the hot-water
        // level 'low', and with the heater running (a host's rn seconds) — over the whole setback window
        const L = floorF ?? bnd.L
        const win = B.filter((b) => inWin(b.t, offAt, shedEnd))
        const hasRn = win.some((b) => b.rn != null)
        Object.assign(shed, {
          sp: shedSp,
          floorMin: 5 * comfortPts.filter((b) => s > 0 ? b.r <= L + 1e-9 : b.r >= bnd.H - 1e-9).length,
          lowMin: 5 * win.filter((b) => b.hw === 'low').length,
          ranMin: hasRn ? round1(win.reduce((m, b) => m + (b.rn ?? 0), 0) / 60) : null,
          levels: win.some((b) => b.hw != null) ? { first: win.find((b) => b.hw != null).hw, last: win.filter((b) => b.hw != null).at(-1).hw } : null,
        })
      }
    }

    // ── recovery ──
    let rec = null
    if (onAt != null) {
      const after = B.filter((b) => b.t >= onAt)
      const spB = after.find((b) => b.p === 1 && b.sp != null) ?? after.find((b) => b.sp != null)
      const sp = spB ? spB.sp : null
      let minToSp = null
      let slope = null
      if (season && sp != null) {
        const hit = after.find((b) => hasRoom(b) && b.t <= onAt + 180 * 60 && s * (b.r - sp) >= -1 - 1e-9)
        if (hit) minToSp = Math.min(180, Math.round((hit.t - onAt) / 60))
      }
      if (season) {
        const pts = after.filter((b) => hasRoom(b) && inWin(b.t, onAt + 300, onAt + 2100))
        const f = ols(pts.map((b) => (b.t + BUCKET / 2 - onAt) / 3600), pts.map((b) => b.r))
        if (f) slope = round2(s * f.b)
      }
      rec = { onAt, sp, minToSp, slope, jump: flags.jump }
    }

    // ── overrides ──
    const from = preStart ?? ps
    const to = pe + 300
    const items = []
    const seen = new Set()
    for (const c of C) {
      if (!(c.s === 'user' || c.s === 'external') || c.gap != null || !inWin(c.t, from, to)) continue
      const key = `${c.f}|${Math.floor(c.t / 60)}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ t: Number(c.t), f: c.f ?? null, o: c.o ?? null, v: c.v ?? null, s: c.s, ty: 'change' })
    }
    for (const line of A) {
      const a = line === released ? rel : line
      if (!(a.ty === 'released' || a.ty === 'drop' || a.ty === 'deferred')) continue
      if (!(a.ac === 'dashboard' || a.ac === 'external') || !inWin(a.t, from, to)) continue
      const f = a.f ?? null
      const key = `${f}|${Math.floor(a.t / 60)}`
      // the engine confirms an external change ≥ 15 s after its first sighting: pair with the 'c' record too; a
      // field-less release (mode, restore-now) pairs with any item within 90 s (the change that caused it)
      if (seen.has(key) || items.some((x) => (x.f === f || f == null) && Math.abs(x.t - a.t) <= 90)) continue
      seen.add(key)
      let o = a.fr ?? null
      if (o == null && f === 'temp') o = bucketAt(B, a.t)?.sp ?? null
      items.push({ t: Number(a.t), f, o, v: a.to ?? null, s: a.ac === 'dashboard' ? 'user' : 'external', ty: a.ty })
    }
    items.sort((x, y) => x.t - y.t)
    const overrides = items.map((o) => ({ ...o, comfortDir: comfortDirOf(o, season, offAt), auto: false }))

    let retries = 0
    let failing = 0
    let blocked = 0
    for (const a of A) {
      if (!inWin(a.t, from, to) && a.e !== e.id) continue
      if (a.ty === 'retry') retries++
      else if (a.ty === 'failing') failing++
      else if (a.ty === 'blocked') blocked++
    }

    // ── forced (addendum C C6.1/C6.2): the unit's forced intervals over the episode, incl. its recovery ──
    const spanEnd = boundary ? pe : Math.max(pe, rec ? Number(rec.onAt) + (isNum(rec.minToSp) ? Number(rec.minToSp) * 60 : 0) : pe)
    const epForced = forced.filter((x) => x.until > from && x.from < spanEnd).map((x) => ({ ...x, from: Math.max(x.from, from), until: Math.min(x.until, spanEnd) }))
    const hard = epForced.filter((x) => !x.sameSeason) // a same-season substitution is information, never forcing
    const onBs = B.filter((b) => b.p === 1 && inWin(b.t, from, pe))
    const forcedQ = onBs.length > 0 && onBs.filter((b) => inIntervals(hard, b.t)).length / onBs.length >= 0.5 - 1e-9
    let forcedBand = null
    if (hard.length) {
      const outs = B.filter((b) => b.p === 1 && hasRoom(b) && inIntervals(hard, b.t) && (b.r < bnd.L - 1e-9 || b.r > bnd.H + 1e-9))
      const dist = (b) => (b.r < bnd.L ? bnd.L - b.r : b.r - bnd.H)
      const worst = outs.reduce((w, b) => (w == null || dist(b) > dist(w) ? b : w), null)
      let byTier = null
      if (typeof tierOf === 'function') {
        byTier = emptyTiers()
        for (const b of outs) { const k = tierOf(b.t); if (k in byTier) byTier[k] += 5 }
      }
      forcedBand = { outMin: 5 * outs.length, worstF: worst ? round1(worst.r) : null, byTier }
    }

    // Addendum H: away when an away interval overlaps the nominal window (the return, ending inside it, too)
    let awayMode = null
    if (away.length) {
      const a = nominalStart(cfg, tz, e, ps, pe, preStart, season)
      for (const x of away) if (x.from < (boundary ? ps : pe) && x.until >= a) awayMode = x.mode
    }
    // G1.11: a setback unit with neither a reading nor a hot-water level in the event's window is no evidence at all
    const noSensor = setback && !B.some((b) => inWin(b.t, preStart ?? ps, pe) && (hasRoom(b) || b.hw != null))
    const lowCov = !shed || (shed.cov < 0.6 && !(setback && shed.levels))
    const q = dryRun || status === 'dry' ? 'dry' : forcedQ ? 'forced' : awayMode ? 'away' : boundary ? 'pre_only' : noSensor ? 'no_sensor' : lowCov ? 'low_coverage' : shed.flat ? 'flat' : shed.jump ? 'jump' : 'ok'
    out.push({
      ev: e.id, date: date ?? (typeof e.id === 'string' ? e.id.split('@')[0] : null), unit: unitId ?? null,
      kind: boundary ? 'boundary' : 'peak', peakStart: ps, peakEnd: pe, precondition: !!e.precondition, preStart,
      status, season, ...(setback ? { shedKind: 'setback' } : {}), par, dryRun, preSkipped: preNotice ? String(preNotice.rs ?? preNotice.why) : null,
      conditioned: preNotice?.rs === 'already conditioned' ? { keeps: isNum(preNotice.to) ? Number(preNotice.to) : null, target: isNum(preNotice.fr) ? Number(preNotice.fr) : null } : null,
      preFromOff, ...(replanned ? { replanned: true } : {}), ...(awayMode ? { away: awayMode } : {}),
      pre, shed, fanOnly, rec,
      released: rel ? { t: Number(rel.t), by: rel.ac === 'dashboard' ? 'user' : 'external', f: rel.f ?? null, v: rel.to ?? null } : null,
      overrides,
      forced: epForced,
      forcedBand,
      dryoutSkipped: dryNotice ? { reason: dryNotice.rs ?? null, units: dryNotice.to ? String(dryNotice.to).split(',').filter(Boolean) : [] } : null,
      jobs: { retries, failing, blocked },
      q,
    })
  }

  // HomeKit-style automation flag: an external override at the same local HH:MM (±2 min) on ≥ 3 of the
  // last 7 event days (today + the ≤ 6 previous event days carried in extHistory).
  if (tz && typeof tz.localParts === 'function') {
    const hist = (extHistory ?? []).slice(-EXT_DAYS)
    for (const ep of out) {
      for (const o of ep.overrides) {
        if (o.s !== 'external') continue
        const mod = tz.localParts(o.t * 1000).minuteOfDay
        let days = 1
        for (const h of hist) if ((h.m ?? []).some((m) => Math.abs(m - mod) <= 2)) days++
        o.auto = days >= 3
      }
    }
  }
  return out
}

/** Local minutes-of-day of the day's external overrides (sorted, unique) — the tail's `ext` entry. */
function extMinutes(episodes, tz) {
  const set = new Set()
  if (tz && typeof tz.localParts === 'function') {
    for (const ep of episodes) for (const o of ep.overrides) if (o.s === 'external') set.add(tz.localParts(o.t * 1000).minuteOfDay)
  }
  return [...set].sort((a, b) => a - b)
}

// ───────────────────────────── rollupDay ─────────────────────────────

const JOB_TYPES = { write: 'Write', retry: 'Retry', failing: 'Failing', blocked: 'Blocked', verify_fail: 'Not applied', recovered: 'Recovered' }

/** One unit's rollup for the day → {rollup: UnitRollup, tail: Tail|null}. */
function unitRollup({ id, S, C: Craw, A, P, nBoots, segs, tierMin, evs, t0, dayMinutes, band, cfg, tz, prevTail, outdoor, date, masterS = null, constraint: c = NO_CONSTRAINT, marks = [], rules = null }) {
  const B = normBuckets(S)
  // Addendum H: the unit's away intervals (the house modes' m records, continued from prevTail.away)
  const W = awayIntervals(marks, id, prevTail, t0, t0 + dayMinutes * 60)
  const awayL = W.intervals
  // addendum C C6.1: the unit's forced intervals (the samples rule for a follower while the constraint is on)
  const F = forcedIntervals({
    buckets: B, markers: A, masterBuckets: roleIn(c, cfg, id) === 'follower' ? masterS : null, masterId: c.master,
    prevTail, start: t0, end: t0 + dayMinutes * 60,
  })
  const standbyL = F.intervals.filter((x) => x.kind === 'standby')
  // C6.7: an outside mode change paired with a forced/unforced line of the unit is the system's
  const FL = A.filter((a) => a.ty === 'forced' || (a.ty === 'unforced' && a.rs !== 'person'))
  const C = Craw.map((x) => (x.f === 'mode' && (x.s === 'user' || x.s === 'external') && FL.some((a) => Math.abs(Number(a.t) - Number(x.t)) <= 90 && up(a.to) === up(x.v))
    ? { ...x, s: 'system' } : x))
  let si = 0
  const tierOf = (t) => {
    while (si < segs.length - 1 && segs[si].end <= t) si++
    while (si > 0 && segs[si].start > t) si--
    const g = segs[si]
    return g && t >= g.start && t < g.end ? g.tier : (cfg?.tou?.defaultTier ?? 'super_off_peak')
  }
  const on = emptyTiers()
  const fan = emptyTiers() // fan-only ON minutes (addendum B C-8)
  const forcedT = emptyTiers() // C6.1 overlays
  const forcedFan = emptyTiers()
  const standby = emptyTiers()
  const off = emptyTiers()
  const run = emptyTiers() // a host's running seconds (rn): a water heater heating (G §3.2)
  let anyRn = false
  const cvT = emptyTiers()
  const roomT = { peak: [], off_peak: [], super_off_peak: [] }
  const modeMin = {}
  let cvSum = 0
  let spOn = 0
  let spW = 0
  let spMin = null
  let spMax = null
  const bandCnt = { inside: 0, below: 0, above: 0, peakInside: 0, peakCovered: 0, away: 0 }
  for (const b of B) {
    const tier = tierOf(b.t)
    const isFan = b.p === 1 && up(b.m) === 'FAN'
    if (isFan) fan[tier] += b.on / 60
    else if (inIntervals(standbyL, b.t)) standby[tier] += b.on / 60 // idling beside the master: not on-time
    else on[tier] += b.on / 60
    if (b.p === 1 && inIntervals(F.intervals, b.t)) (isFan ? forcedFan : forcedT)[tier] += b.on / 60
    off[tier] += (b.cv - b.on) / 60
    if (b.rn != null) { run[tier] += b.rn / 60; anyRn = true }
    cvT[tier] += b.cv / 60
    cvSum += b.cv
    if (b.on > 0) {
      if (b.m != null) modeMin[up(b.m)] = (modeMin[up(b.m)] ?? 0) + b.on / 60
      if (b.sp != null) {
        spOn += b.sp * b.on
        spW += b.on
        spMin = spMin == null ? b.sp : Math.min(spMin, b.sp)
        spMax = spMax == null ? b.sp : Math.max(spMax, b.sp)
      }
    }
    if (hasRoom(b)) {
      roomT[tier].push(b.r)
      const inside = b.r >= band[0] - 1e-9 && b.r <= band[1] + 1e-9
      if (awayL.length && inIntervals(awayL, b.t)) bandCnt.away++ // Addendum H: counted apart, never a comfort miss
      else {
        if (inside) bandCnt.inside++
        else if (b.r < band[0]) bandCnt.below++
        else bandCnt.above++
        if (tier === 'peak') { bandCnt.peakCovered++; if (inside) bandCnt.peakInside++ }
      }
    }
  }
  const unknown = emptyTiers()
  for (const k of TIERS) unknown[k] = Math.max(0, (tierMin[k] ?? 0) - cvT[k])
  const onMin = roundTiers(on)
  const modeOut = {}
  for (const k of Object.keys(modeMin).sort()) modeOut[k] = round1(modeMin[k])
  const heat = modeMin.HEAT ?? 0
  const cool = (modeMin.COOL ?? 0) + (modeMin.DRY ?? 0)
  const onTotal = on.peak + on.off_peak + on.super_off_peak
  let season = onTotal < 30 ? null : heat > onTotal / 2 ? 'heating' : cool > onTotal / 2 ? 'cooling' : null
  if (typeof rules?.seasonOf === 'function') { // a host's unit kind (G: a Mysa 'heating', the water heater 'water')
    const bySeason = {}
    for (const [m, min] of Object.entries(modeMin)) { const se = rules.seasonOf(m); if (se) bySeason[se] = (bySeason[se] ?? 0) + min }
    season = onTotal < 30 ? null : Object.keys(bySeason).find((se) => bySeason[se] > onTotal / 2) ?? null
  }

  const changes = { schedule: 0, user: 0, system: 0, external: 0, gapped: 0, total: 0 }
  let userChanges = 0
  for (const c of C) {
    if (c.s in changes) changes[c.s]++
    changes.total++
    if (c.gap != null) changes.gapped++
    if (c.f === 'temp' && (c.s === 'user' || c.s === 'external')) userChanges++
  }

  const jobs = { writes: 0, verified: 0, wouldWrite: 0, retries: 0, verifyFail: 0, failing: 0, blocked: 0, recovered: 0, items: [] }
  for (const a of A) {
    let item = false
    switch (a.ty) {
      case 'write': jobs.writes++; if (a.res === 'verified') jobs.verified++; else item = true; break
      case 'would_write': jobs.wouldWrite++; break
      case 'retry': jobs.retries++; item = true; break
      case 'verify_fail': jobs.verifyFail++; item = true; break
      case 'failing': jobs.failing++; item = true; break
      case 'blocked': jobs.blocked++; item = true; break
      case 'recovered': jobs.recovered++; break
      default: break
    }
    if (item && jobs.items.length < MAX_JOB_ITEMS) {
      const what = [a.f ? `${a.f}` : null, a.cl ? `${a.cl}` : a.res && a.res !== 'verified' ? `${a.res}` : null].filter(Boolean).join(' · ')
      jobs.items.push({ t: Number(a.t), ty: a.ty, cl: a.cl ?? null, f: a.f ?? null, message: `${JOB_TYPES[a.ty] ?? a.ty}${what ? `: ${what}` : ''}` })
    }
  }

  // spark: 15-min slots from local midnight
  const nSlots = Math.max(1, Math.round(dayMinutes / 15))
  const sRoom = new Array(nSlots).fill(null)
  const sOn = new Array(nSlots).fill(null)
  {
    const acc = Array.from({ length: nSlots }, () => ({ rs: 0, rn: 0, on: 0, cv: 0 }))
    for (const b of B) {
      const i = Math.floor((b.t - t0) / 900)
      if (i < 0 || i >= nSlots) continue
      if (hasRoom(b)) { acc[i].rs += b.r; acc[i].rn++ }
      acc[i].on += b.on
      acc[i].cv += b.cv
    }
    for (let i = 0; i < nSlots; i++) {
      if (acc[i].rn) sRoom[i] = round1(acc[i].rs / acc[i].rn)
      if (acc[i].cv > 0) sOn[i] = round2(acc[i].on / acc[i].cv)
    }
  }

  const marginF = isNum(cfg?.optimizer?.marginF) ? Number(cfg.optimizer.marginF) : 1
  const comfyMarginF = isNum(cfg?.optimizer?.comfyMarginF) ? Number(cfg.optimizer.comfyMarginF) : 2
  const extHistory = Array.isArray(prevTail?.ext) ? prevTail.ext : []
  const episodes = buildEpisodes({ unitId: id, buckets: B, changes: C, markers: A, events: evs, band, outdoor, marginF, comfyMarginF, tz, extHistory, prevTail, date, forced: F.intervals, tierOf, away: awayL, cfg, rules })

  // shed-window band minutes (comfort points of participating episodes) — the report's bandPct basis; a peak while away
  // is never a comfort miss (Addendum H)
  let shedInside = 0
  let shedCovered = 0
  for (const ep of episodes) {
    if (!ep.shed || !(ep.status === 'done' || ep.status === 'released') || ep.away) continue
    for (const b of B) {
      if (b.on !== 0 || !hasRoom(b) || !inWin(b.t, ep.shed.offAt, ep.shed.end)) continue
      shedCovered++
      if (b.r >= band[0] - 1e-9 && b.r <= band[1] + 1e-9) shedInside++
    }
  }

  let tail
  const last = B[B.length - 1]
  const away = W.open ? { away: W.open } : {} // Addendum H: an away interval still open at the day end
  if (last) {
    let ext = extHistory.slice()
    if (evs.length) ext = [...ext, { d: date, m: extMinutes(episodes, tz) }]
    tail = { power: last.p == null ? null : last.p ? 'ON' : 'OFF', mode: last.m, temp: last.sp, fan: last.f, at: last.t, ext: ext.slice(-EXT_DAYS), forced: F.open, ...away }
  } else if (prevTail) {
    const { away: _prevAway, ...rest } = prevTail // today's intervals decide the away
    tail = { ...rest, ext: extHistory.slice(-EXT_DAYS), forced: F.open, ...away }
  } else {
    tail = W.open ? { power: null, mode: null, temp: null, fan: null, at: null, ext: [], forced: F.open, ...away } : null
  }

  const rollup = {
    id,
    coverage: round2(cvSum / (dayMinutes * 60)),
    coveredMin: round1(cvSum / 60),
    onMin,
    fanMin: roundTiers(fan),
    forcedMin: roundTiers(forcedT),
    forcedFanMin: roundTiers(forcedFan),
    standbyMin: roundTiers(standby),
    offMin: roundTiers(off),
    ...(anyRn ? { runMin: roundTiers(run) } : {}),
    unknownMin: roundTiers(unknown),
    modeMin: modeOut,
    season,
    setpoint: { mean: spW > 0 ? round1(spOn / spW) : null, min: spMin, max: spMax, userChanges },
    room: {
      peak: stat(roomT.peak), off_peak: stat(roomT.off_peak), super_off_peak: stat(roomT.super_off_peak),
      day: stat([...roomT.peak, ...roomT.off_peak, ...roomT.super_off_peak]),
    },
    band: {
      L: band[0], H: band[1],
      insideMin: 5 * bandCnt.inside, belowMin: 5 * bandCnt.below, aboveMin: 5 * bandCnt.above,
      peakInsideMin: 5 * bandCnt.peakInside, peakCoveredMin: 5 * bandCnt.peakCovered,
      shedInsideMin: 5 * shedInside, shedCoveredMin: 5 * shedCovered,
      ...(awayL.length ? { awayMin: 5 * bandCnt.away } : {}),
    },
    changes,
    jobs,
    params: P.map((p) => ({ t: Number(p.t), se: p.se ?? null, pa: p.pa ?? null, fr: p.fr ?? null, to: p.to ?? null, s: p.s ?? null, id: p.id ?? null })),
    spark: { t0, stepMin: 15, room: sRoom, on: sOn },
    episodes,
    boots: nBoots,
    ...(awayL.length ? { away: awayL } : {}),
    cfgSnapshot: { band: [band[0], band[1]], touRev: cfg?.rev ?? null, system: { master: c.master, forcing: c.forcing, conflict: c.conflict } },
  }
  return { rollup, tail }
}

function orderedUnitIds(cfg, seen) {
  const cfgUnits = (Array.isArray(cfg?.units) ? cfg.units : [])
    .map((u, i) => ({ u, i }))
    .sort((a, b) => (a.u.order ?? a.i) - (b.u.order ?? b.i) || a.i - b.i)
    .map((x) => x.u.id)
    .filter((id) => typeof id === 'string')
  const extra = [...seen].filter((id) => !cfgUnits.includes(id)).sort()
  return [...cfgUnits, ...extra]
}

/**
 * Roll up one closed local day (§4.5). Async only to consume `records` (an async or sync iterable of
 * parsed usage records — `usage.readDay(date)` — or an array; JSON strings are parsed; torn/unknown lines
 * are counted in `counts.bad` and skipped).
 * @param {object} a
 * @param {string} a.date        'YYYY-MM-DD' local date
 * @param {AsyncIterable|Iterable} a.records
 * @param {object} a.cfg         config snapshot (tou, holidays, optimizer bands/margins, outdoor.sampleMin, units, rev)
 * @param {object} a.tz          makeTz() instance
 * @param {object|null} [a.prevTail]  previous day's rollup `tail` ({[unitId]: Tail})
 * @param {Array|null} [a.outdoorFill] hourly [{t (s), f}] (weather.hourlyFor(date)) for missing outdoor slots
 * @param {number|string|null} [a.builtAt]  stamped verbatim (ISO string; numbers are converted to ISO)
 * @param {object|null} [a.constraint]  the multi-split constraint {on, master, forcing, conflict} (see the header); null ⇒ none
 * @param {Function|null} [a.unitRules]  (unitId) → the unit's kind rules {shed?: 'setback', seasonOf?(mode), floorF?} | null
 *                                         (see the header: "Unit kinds")
 * @returns {Promise<object>} DailyRollup
 */
export async function rollupDay({ date, records, cfg, tz, prevTail = null, outdoorFill = null, builtAt = null, constraint = null, unitRules = null }) {
  const startMs = tz.zonedToInstant(date, '00:00')
  const endMs = tz.zonedToInstant(addDays(date, 1), '00:00')
  const t0 = Math.round(startMs / 1000)
  const t1 = Math.round(endMs / 1000)
  const dayMinutes = Math.round((endMs - startMs) / 60000)
  const segsMs = tou.segments(cfg, tz, date)
  const segs = segsMs.map((s) => ({ tier: s.tier, start: Math.round(s.start / 1000), end: Math.round(s.end / 1000) }))
  const tierMin = emptyTiers()
  for (const s of segs) if (s.tier in tierMin) tierMin[s.tier] += (s.end - s.start) / 60
  const evsMs = tou.events(cfg, tz, date)

  const per = new Map()
  const perUnit = (u) => {
    let x = per.get(u)
    if (!x) per.set(u, (x = { S: [], C: [], A: [], P: [], b: 0 }))
    return x
  }
  const oRecs = []
  const marks = [] // Addendum H: the house modes' m records (every unit reads them: `u` names the units a mode holds)
  const counts = { s: 0, c: 0, a: 0, o: 0, p: 0, b: 0, h: 0, bad: 0 }
  for await (const raw of records ?? []) {
    let r = raw
    if (typeof r === 'string') { try { r = JSON.parse(r) } catch { counts.bad++; continue } }
    if (!r || typeof r !== 'object' || !isNum(r.t)) { counts.bad++; continue }
    const t = Number(r.t)
    if (t < t0 || t >= t1) { counts.bad++; continue }
    switch (r.k) {
      case 's': if (typeof r.u !== 'string') { counts.bad++; break } counts.s++; perUnit(r.u).S.push(r); break
      case 'c': if (typeof r.u !== 'string') { counts.bad++; break } counts.c++; perUnit(r.u).C.push({ ...r, t }); break
      case 'a': counts.a++; if (typeof r.u === 'string') perUnit(r.u).A.push({ ...r, t }); break
      case 'p': counts.p++; if (typeof r.u === 'string') perUnit(r.u).P.push({ ...r, t }); break
      case 'b': counts.b++; if (typeof r.u === 'string') perUnit(r.u).b++; break
      case 'h': counts.h++; break
      case 'm': if (typeof r.mode !== 'string' || !Array.isArray(r.u)) { counts.bad++; break } marks.push({ ...r, t }); break
      case 'o': if (isNum(r.f)) { counts.o++; oRecs.push({ t, f: Number(r.f) }) } else counts.bad++; break
      default: counts.bad++
    }
  }
  const stable = (arr) => arr.map((x, i) => ({ x, i })).sort((a, b) => a.x.t - b.x.t || a.i - b.i).map((y) => y.x)

  const slotMin = [15, 30, 60].includes(Number(cfg?.outdoor?.sampleMin)) ? Number(cfg.outdoor.sampleMin) : 15
  const od = outdoorSeries(oRecs, outdoorFill, t0, t1, slotMin * 60)
  const ofs = od.samples.map((x) => x.f)
  const oMean = mean(ofs)
  const outdoor = {
    min: ofs.length ? round1(Math.min(...ofs)) : null,
    max: ofs.length ? round1(Math.max(...ofs)) : null,
    mean: round1(oMean), n: ofs.length, filled: od.filled, coverage: od.coverage,
    hdd65: oMean == null ? null : round1(Math.max(0, 65 - oMean)),
    cdd65: oMean == null ? null : round1(Math.max(0, oMean - 65)),
  }

  const units = {}
  const tail = {}
  const sys = constraintOf(constraint)
  const masterId = sys.master
  for (const id of orderedUnitIds(cfg, per.keys())) {
    const x = per.get(id) ?? { S: [], C: [], A: [], P: [], b: 0 }
    const u = unitRollup({
      id, S: x.S, C: stable(x.C), A: stable(x.A), P: stable(x.P), nBoots: x.b, segs, tierMin, evs: evsMs, t0, dayMinutes,
      band: unitBand(cfg, id), cfg, tz, prevTail: prevTail?.[id] ?? null, outdoor: od.samples, date,
      masterS: masterId != null && masterId !== id ? per.get(masterId)?.S ?? [] : null, constraint: sys, marks: stable(marks),
      rules: typeof unitRules === 'function' ? unitRules(id) ?? null : null,
    })
    units[id] = u.rollup
    tail[id] = u.tail
  }

  return {
    v: ROLLUP_V,
    date,
    complete: true,
    builtAt: typeof builtAt === 'number' ? new Date(builtAt).toISOString() : (builtAt ?? null),
    dayType: tou.dayType(cfg, date),
    dayMinutes,
    start: t0,
    end: t1,
    segments: segs,
    events: evsMs.map((e) => ({ id: e.id, peakStart: Math.round(e.peakStart / 1000), peakEnd: Math.round(e.peakEnd / 1000), precondition: !!e.precondition })),
    outdoor,
    outdoorCoverage: outdoor.coverage,
    counts: marks.length ? { ...counts, m: marks.length } : counts,
    units,
    tail,
  }
}
