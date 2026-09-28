// tou.js — time-of-use tables → tiers, peak events, precondition windows, plan (spec §5.2,
// §9.4; addendum H6). PURE: no I/O, no clock; `now` is always passed in (epoch ms) and all
// wall-clock math goes through the injected `tz` (tz.js makeTz()).
//
// Units of the returned values:
//   segments/events/preconditionWindow/tierAt/activeEventFor/nextBoundaryAfter/dryOutUntilFor → epoch MS numbers
//   plan() is an API DTO (§4.4) → ISO-8601 UTC strings plus local 'HH:MM' labels.
//   firstPreconditionDate → local 'YYYY-MM-DD' | null (the first morning a tuning change can affect).
//
// Event model: an event is a maximal run of `peak` windows of one local date; windows that touch or
// are separated by a gap < tou.mergeGapMin merge (the gap becomes part of the event). kind 'peak'.
//   id = '<date>@<HH:MM of the first window start as configured>' (stable across DST/restarts).
//   Windows never cross midnight (validation), so events of different dates never merge.
// Boundary events (addendum E E1.2/E1.3): while cfg.precondition.superOffPeak.weekend === true, every date whose
//   dayType is not 'weekday' also has one event per super off-peak → off-peak transition of its segments
//   (validate.offPeakBoundaries; a transition at local 00:00 never counts): {id: '<date>@<HH:MM>', date,
//   kind:'boundary', peakStart = peakEnd = t, precondition: true, windows: []}, sorted with the peak events by
//   peakStart. The peak is EMPTY: activeEventFor yields 'precondition' on [preStart, t) and nothing from t (never
//   'shed'); a boundary is a previous event for the date's later events (preconditionWindow's prev clamp) and vice
//   versa; dryOutUntilFor is null; eventEntry admits the entry AT t (E1.6); entryPass (entryEffFor) gives a unit
//   without an ON entry E that does not read ON in a precondition mode (OFF, or ON in Fan/Auto) no window (E1.8,
//   J23, noPrecondition); eventOverlapping ignores an empty window.
//   With the option off events() is Release 4's (J25), each peak event now carrying kind 'peak'.
//
// Precondition window (§5.2 + H6):
//   preStart = max(peakStart − leadMin, previous same-day event end + mergeGapMin, 03:00 local,
//                  optimizer.earliestStart when the LEAD is tuned: (eff.leadSource ?? eff.source) === 'tuned',
//                  addendum D X1.1 — a tuned Δ alone never moves the base start; frozen params written before
//                  the upgrade carry only `source` and keep their window)
//   leadMin = eff?.leadMin ?? cfg.precondition.leadMin[season]; season null/unknown ⇒ 'heating'.
//   None when the event is not precondition-flagged, eff.suspended, or peakStart − preStart < minLeadMin.
//
// Fan-only dry-out (addendum B F2): a shed entered from a running unit first runs mode FAN until
//   dryOutUntil = min(entry read + shed.fanOnlyMin[season], peakEnd) (dryOutUntilFor; season from the
//   mode, AUTO/FAN ⇒ none; missing config ⇒ the shipped 60 cooling / 15 heating; peakEnd ≤ from ⇒ none — a
//   boundary event, addendum E E1.4), then turns OFF.
//   nextBoundaryAfter wakes at peakStart + fanOnlyMin for both seasons; PlanDay units carry fanOnlyUntil.
//
// Unit kinds (the reference app's Addendum G — the core never imports the host's kind table; the host injects it):
//   seasonOf is a REQUIRED input of entryEffFor (opts.seasonOf(mode) → season) and plan (opts.seasonOf(mode, unitCfg) →
//   season): a missing function throws TypeError('seasonOf required') — no silent Daikin season survives for a unit whose
//   kind the core does not know (a water heater's 'Heat Pump' is 'water', a Mysa always 'heating'). dryOutUntilFor and
//   preconditionWindow take the season itself; preconditionWindow reads leadMin[season] for 'water' too.
//   entryEffFor opts.preconditions?(event) → bool: whether this unit pre-conditions `event` whatever its flag (a water
//   heater pre-heats before every peak): the eff it returns (frozen params too) carries `precondition`, which
//   preconditionWindow / activeEventFor / eventOverlapping read in place of event.precondition.
//   plan opts.unitRules?(unitCfg) → {shed?: 'off' | 'setback', dryOut?: bool, preconditions?(event), preconditionMode?(mode),
//   bumpLimits?(season, caps) → {floor, ceiling} | null} | null — absent ⇒ a Daikin head's (shed 'off', dry-out, the
//   precondition.modes gate, clampF ∩ 61–90): PlanDay units[id].shed 'setback' for a setback unit (still 'opted out' |
//   'skipped' | 'released' first), fanOnlyUntil / dryout / entryDryOut none without dry-out.
//   bumpTarget(original, season, deltaF, limits, step = 1, tol = 0.6) → {target, moves} — THE bump (the host's decide
//   calls it with kinds.bumpLimits): heating / water ⇒ max(min(roundToStep(original + Δ), ceiling), floor); cooling ⇒
//   min(max(roundToStep(original − Δ), floor), ceiling); moves = the target moves the intended way by more than tol;
//   {target: null, moves: false} without limits, a season or a finite original. plan() bumps with tol 0.
//   resolveEntry / entryResolution read a NAMED mode's season only for an entry with the cool-to / heat-to pair, which
//   only a Daikin head carries (pairSeason, HEAT / COOL / DRY); a keep-mode entry's season is the run context's.
//
// Effective params (H6): tou does not import tuning.js (it would create an import cycle with
// tuning.gateOpen → activeEventFor), nor a host's multi-split / optimum-start modules (they import tou). plan() accepts
// `opts.effectivePrecondition` (inject tuning.effectivePrecondition); without it a faithful copy of
// addendum §5.2 is used.
//
// Day types (addendum D E1): dayType(cfg, date) delegates to validate.dayTypeOf — one partition.
//
// Daily scheduled settings (addendum B F3 + D E1/E2; times are epoch ms unless noted):
//   unitEntries(unitCfg) → [{at:'HH:MM', min, power:'ON'|'OFF', mode?, temp?, coolTo?, heatTo?, fan?, days}] normalised
//     (upper-case enums, booleans → ON/OFF, numeric temp / coolTo / heatTo; an Off entry carries nothing else),
//     malformed rows and slots dropped, sorted by time then all < weekday < weekend.
//   entryInstants(cfg, tz, unitCfg, date) → [{key:'s:<date>@<HH:MM>', at, date, hhmm, days, fields:{power,
//     mode?, temp?, coolTo?, heatTo?, fan?}}] — THE one place entries meet the calendar: an entry is dropped when its `days`
//     does not match the date's day type (entryOnDay); instants via zonedToInstant (DST like TOU windows);
//     of two rows that still collide on one key the first is kept.
//   latestEntryAtOrBefore(cfg, tz, unitCfg, instant, armedAt = −∞) → the latest instant ≤ `instant` over its
//     local date and D−1 with at > armedAt | null (B F3.11's E*, D's P). entryInEffect(cfg, tz, unitCfg, now,
//     armedAt) is the same rule at `now` (B F3.3/F3.4). armedAt: epoch ms or ISO.
//   nextEntry(cfg, tz, unitCfg, now, armedAt = −∞) → the earliest instant > now within 24 h (D, D+1), at > armedAt.
//   eventEntry(cfg, tz, unitCfg, event, preStart, now, armedAt = −∞) → the latest instant with preStart ≤ t ≤
//     max(peakStart, now) ∧ (t < peakEnd ∨ t = peakStart) ∧ t > armedAt | null (B F3.12: the precondition target at
//     now ≤ peakStart, the folded entry after; F3.4: an entry the arming passed is never the event's, so no restore
//     applies it; E E1.6: t = peakStart admits a boundary event's entry at its instant).
//   eventOverlapping(cfg, tz, unitCfg, from, to, eff?) → true when a participating event of the unit (D−1..D+1
//     of `to`; shed:false never participates; released/skipped make no difference) has preStart ≤ to ∧
//     peakEnd > from ∧ preStart < peakEnd (D E2.5, the optimum-start interval test; the last term only ever drops a
//     boundary event the unit does not pre-condition for, addendum E E1.10).
//   foldEventFor(cfg, tz, unitCfg, at, eff?) → the participating event whose [preStart, peakEnd) contains an
//     entry instant | null (B §1.7 step 2's fold decision = activeEventFor at E.at; PlanDay entries[].folded).
//   entryEffFor(cfg, tz, unitCfg, unitState, liveMode, {effectivePrecondition?, seasonOf?, armedAt?, livePower?}) →
//     (event) → eff — B §1.3 effFor with F3.11's two passes: while engaged with the event the frozen auto.params (H5);
//     else E* = latestEntryAtOrBefore(peakStart, armedAt), season = seasonOf(E*.power ON ? E*.mode ?? (a keep-mode E*,
//     Addendum F) unitState.stranded.fields.mode ?? liveMode : liveMode) (the host
//     injects its multi-split season rule through `seasonOf`), eff = effectivePrecondition(season ?? 'heating'); E = E* iff E*.at ≥
//     that window's preStart — then noPrecondition when E says OFF, suspended:false when E says ON (C-11); an E*
//     before preStart already fired: live rules. Addendum E E1.8/J23: for a BOUNDARY event, noPrecondition too when E
//     is not an ON entry and the unit does not read ON in a precondition mode (livePower 'ON' and liveMode Heat, Cool
//     or Dry; unknown counts as not) — only units with something to do engage.
//   armedAtOf(state, unitId) → max(state.scheduleArmedAt, units[id].scheduleEditedAt) in ms | −∞ (B F3.4).
//
// Instant rows (Addendum H rule 3 — a one-off row a host places deliberately, e.g. a house mode's rows):
//   a unit's schedule may also hold {atMs, power?, mode?, temp?, coolTo?, heatTo?, fan?, since?, dryOutMin?, meta?} beside
//   the daily {at:'HH:MM', …, days} rows. atMs is a finite epoch ms; power is optional (a row without it only sets a
//   running unit's setpoint — resolveEntry then resolves its pair from the run context and writes neither power nor
//   mode; labels read "heat to 62°", without "On ·"); `days` does not apply. unitEntries lists them after the daily rows
//   (normalised, since → epoch ms, meta untouched). instantRows(cfg, tz, unitCfg) → every instant row as an instant
//   {key: 'i:' + new Date(atMs).toISOString() (UTC — no collision in the repeated DST hour), at, date, hhmm (via tz),
//   fields, since?, dryOutMin?, meta?}; two rows at one instant share the key and the one that sorts last is kept.
//   entryInstants(date) includes the instant rows of that local date. latestEntryAtOrBefore / entryInEffect / nextEntry /
//   eventEntry consider every instant row directly (no D−1/D bound) and never disarm one by armedAt (the host's 12 h
//   fire horizon expires it); nextEntry keeps its 24 h bound. Ties at one instant: daily rows first, then instant rows
//   by since — the last is the one in effect. Nothing here reads meta: plan() passes it through (entries[u][j] gain
//   since (ISO), dryOutMin, meta and house = meta.house; an instant row never starts early) and a row carrying
//   meta.house marks the day as markers kind 'house' (a folded one stays 'folded'; lines carry `house`); entryDryOut
//   uses an Off instant row's dryOutMin when set. A plan without instant rows is byte-identical.
//
// Keep-mode entries and the cool-to / heat-to pair (Addendum F; the one definition — the reference app's system.js
// re-exports these and adds the run context it computes):
//   An On entry may omit `mode` — it KEEPS the mode (the unit runs whatever mode the host's run context gives it) — and
//   any On entry may carry the setpoint pair coolTo / heatTo in place of temp (either or both, with or without a mode):
//   whichever season the unit runs, that season's setpoint applies. A run context `rc` is the host's answer for one unit
//   at one instant: {masterMode, mode (the mode it will run), season: seasonOf(mode), writeMode (the mode the app may
//   send with its power ON, or null), source}.
//   keepsMode(fields) ⇔ power ON ∧ no mode; hasPair(fields) ⇔ coolTo or heatTo named; resolves(fields) ⇔ either — the
//     entries whose concrete fields depend on the moment.
//   setpointFor(fields, season) → temp when named (it applies whatever the season), else coolTo (cooling) / heatTo
//     (heating); undefined for a null season.
//   resolveEntry(fields, rc) → {power, mode?, temp?, fan?}: an Off entry or one without the pair that names a mode ⇒ a
//     copy of fields (identity); keep mode ⇒ mode = rc.writeMode, temp = setpointFor(fields, rc.season); a named mode
//     with the pair ⇒ that mode, the setpoint of its own season (a DRY season takes the cooling setpoint). Deterministic
//     from (fields, rc).
//   entryResolution(fields, rc) → {season, mode?, temp?} — the EntryDTO / activity line `resolved` (keys only when
//     present; season = rc.season for keep mode, the named mode's season otherwise).
//   plan(): opts.runContext {unitId: (at) → rc | null} (the host builds it from its reads and state; without it, or
//     when it returns null, the remembered mode — stranded, then the read's — and never a mode to write). Read only for
//     entries that resolve: a keep-mode precondition target is rc(peakStart)'s season and mode (season null ⇒
//     'skip: season unknown'; the base = setpointFor(E, season) ?? the read, as for a named mode with the pair); the
//     entry texts use entryLabel(fields, {season}) and PlanDay entry refs / entries carry `resolved`; `restore` is the
//     resolved entry ("Heat 68° · Low"). Entries without the pair that name a mode never read it (byte-identical).
//   activeEventFor's `eff` may be such a function (event) → eff; eff.noPrecondition ⇒ preStart = peakStart.

import { isHoliday } from './holidays.js'
import { dayTypeOf, entryOnDay, ENTRY_DAYS, offPeakBoundaries } from './validate.js'
import { entryLabel, modeLabel, settingLabel } from './labels.js'
import { addDays, dowOf, hhmmToMin, minToHHMM } from './tz.js'
import { clamp, roundToStep } from './util.js'

export const TIERS = ['peak', 'off_peak', 'super_off_peak']
const MIN_MS = 60000
const MINUS = '−'
const SETPOINTS = ['temp', 'coolTo', 'heatTo'] // an entry's setpoint fields (Addendum F: temp, or the pair)
const FAN_ONLY_MIN = { cooling: 60, heating: 15 } // shipped shed.fanOnlyMin (store.defaultConfig)

function pick(v, season) {
  if (v == null) return undefined
  if (typeof v === 'number') return v
  return v[season]
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString() }
function up(v) { return String(v ?? '').toUpperCase() }
function msOf(v) {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

/** 'weekday' | 'weekend' | 'holiday' (holiday = date listed in holidays.rows) — validate.dayTypeOf. */
export function dayType(cfg, date) {
  return dayTypeOf({ weekendDays: cfg?.tou?.weekendDays, holidayDates: { has: (d) => !!isHoliday(cfg?.holidays, d) } }, date)
}

function tableFor(cfg, date) {
  const t = dayType(cfg, date) === 'weekday' ? cfg?.tou?.weekday : cfg?.tou?.weekendHoliday
  return Array.isArray(t) ? t : []
}

// Gap-filled, unmerged minute segments of one local date: [{tier, startMin, endMin, precondition}].
function rawSegments(cfg, date) {
  const rows = []
  for (const w of tableFor(cfg, date)) {
    let startMin, endMin
    try { startMin = hhmmToMin(w.start); endMin = hhmmToMin(w.end) } catch { continue } // validation rejects these
    if (endMin > startMin) rows.push({ tier: w.tier, startMin, endMin, precondition: w.tier === 'peak' && !!w.precondition })
  }
  rows.sort((a, b) => a.startMin - b.startMin)
  const def = cfg?.tou?.defaultTier ?? 'super_off_peak'
  const out = []
  let cur = 0
  for (const w of rows) {
    const s = Math.max(w.startMin, cur) // overlapping rows are clipped (validation rejects overlaps)
    if (s >= w.endMin) continue
    if (s > cur) out.push({ tier: def, startMin: cur, endMin: s, precondition: false })
    out.push({ ...w, startMin: s })
    cur = w.endMin
  }
  if (cur < 1440) out.push({ tier: def, startMin: cur, endMin: 1440, precondition: false })
  return out
}

// Raw segments with instants; boundaries forced monotonic (a DST-gap boundary maps forward and may
// collapse a segment to zero length — those are dropped).
function timedSegments(cfg, tz, date) {
  const out = []
  let prev = -Infinity
  for (const r of rawSegments(cfg, date)) {
    const start = Math.max(tz.zonedToInstant(date, r.startMin), prev)
    const end = Math.max(tz.zonedToInstant(date, r.endMin), start)
    prev = end
    if (end > start) out.push({ ...r, start, end, localStart: minToHHMM(r.startMin), localEnd: minToHHMM(r.endMin) })
  }
  return out
}

/** Gap-filled tier segments of one local date, adjacent same-tier segments merged. */
export function segments(cfg, tz, date) {
  const out = []
  for (const s of timedSegments(cfg, tz, date)) {
    const last = out[out.length - 1]
    if (last && last.tier === s.tier && last.end === s.start) {
      last.end = s.end
      last.localEnd = s.localEnd
      continue
    }
    out.push({ tier: s.tier, start: s.start, end: s.end, localStart: s.localStart, localEnd: s.localEnd })
  }
  return out
}

/**
 * Events of one local date, by peakStart: merged peak events {id, date, kind:'peak', peakStart, peakEnd,
 * precondition, windows} and, with the weekend pre-condition on, boundary events (see header).
 */
export function events(cfg, tz, date) {
  const gapMs = Math.max(0, Number(cfg?.tou?.mergeGapMin ?? 30)) * MIN_MS
  const segs = timedSegments(cfg, tz, date)
  const out = []
  let cur = null
  for (const s of segs) {
    if (s.tier !== 'peak') continue
    const win = { start: s.start, end: s.end, localStart: s.localStart, localEnd: s.localEnd, precondition: s.precondition }
    if (cur && (s.start <= cur.peakEnd || s.start - cur.peakEnd < gapMs)) {
      cur.peakEnd = Math.max(cur.peakEnd, s.end)
      cur.precondition = cur.precondition || s.precondition
      cur.windows.push(win)
      continue
    }
    cur = { id: `${date}@${s.localStart}`, date, kind: 'peak', peakStart: s.start, peakEnd: s.end, precondition: s.precondition, windows: [win] }
    out.push(cur)
  }
  if (cfg?.precondition?.superOffPeak?.weekend !== true || dayType(cfg, date) === 'weekday') return out
  for (const t of offPeakBoundaries(segs)) {
    const s = segs.find((x) => x.start === t)
    out.push({ id: `${date}@${s.localStart}`, date, kind: 'boundary', peakStart: t, peakEnd: t, precondition: true, windows: [] })
  }
  return out.sort((a, b) => a.peakStart - b.peakStart)
}

/**
 * First local date ≥ fromDate (scanning `maxDays` dates) that has a precondition-flagged event, else
 * null — the first morning a tuning change applied from `fromDate` can affect (weekends and holidays
 * of the default tables have none).
 */
export function firstPreconditionDate(cfg, tz, fromDate, maxDays = 8) {
  let d = fromDate
  for (let i = 0; i < maxDays; i++, d = addDays(d, 1)) {
    if (events(cfg, tz, d).some((e) => e.precondition)) return d
  }
  return null
}

/**
 * Precondition window of `event` for a unit in `season` ('heating'|'cooling'|null), optionally with
 * effective params `eff` ({leadMin, source, suspended, ...} from tuning.effectivePrecondition or the
 * frozen auto.params). → {preStart, peakStart, leadMin, season} | null
 */
export function preconditionWindow(cfg, tz, event, season, eff) {
  if (!event || !(eff?.precondition ?? event.precondition)) return null
  if (eff?.suspended) return null
  const s = season === 'cooling' || season === 'water' ? season : 'heating'
  const date = event.date ?? String(event.id).split('@')[0]
  const pc = cfg?.precondition ?? {}
  let leadMin = Number(eff?.leadMin ?? pick(pc.leadMin, s) ?? 120)
  if (!Number.isFinite(leadMin)) leadMin = 120
  const peakStart = event.peakStart
  let preStart = peakStart - leadMin * MIN_MS
  const gapMs = Math.max(0, Number(cfg?.tou?.mergeGapMin ?? 30)) * MIN_MS
  let prev = null
  for (const e of events(cfg, tz, date)) if (e.id !== event.id && e.peakEnd <= peakStart) prev = e
  if (prev) preStart = Math.max(preStart, prev.peakEnd + gapMs)
  preStart = Math.max(preStart, tz.zonedToInstant(date, '03:00'))
  if ((eff?.leadSource ?? eff?.source) === 'tuned') {
    // eff.earliestStart (present on tuning.effectivePrecondition output, and on auto.params when the
    // engine snapshots it) wins over the live config, so a frozen ownership keeps its window.
    let earliest
    try { earliest = tz.zonedToInstant(date, eff.earliestStart ?? cfg?.optimizer?.earliestStart ?? '04:30') } catch { earliest = tz.zonedToInstant(date, '04:30') }
    preStart = Math.max(preStart, earliest)
  }
  const minLead = Number(pc.minLeadMin ?? 20)
  if (peakStart - preStart < minLead * MIN_MS) return null
  return { preStart, peakStart, leadMin: Math.round((peakStart - preStart) / MIN_MS), season: s }
}

/**
 * Fan-only dry-out deadline (addendum B F2.5): min(from + shed.fanOnlyMin[season] minutes, event.peakEnd)
 * in epoch ms, or null when `season` ('cooling'|'heating') has none — season null (AUTO/FAN) or
 * fanOnlyMin 0. `from` defaults to peakStart (the plan); the host passes the fresh read that enters shed.
 */
export function dryOutUntilFor(cfg, event, season, from = event?.peakStart) {
  if (!event || event.peakEnd <= from) return null // a boundary event (addendum E E1.4): no shed, no dry-out
  if (season !== 'cooling' && season !== 'heating') return null
  const min = Number(pick(cfg?.shed?.fanOnlyMin, season) ?? FAN_ONLY_MIN[season])
  if (!Number.isFinite(min) || min <= 0 || !Number.isFinite(from)) return null
  return Math.min(from + min * MIN_MS, event.peakEnd)
}

/** Current tier with its full contiguous extent (extends across midnight): {kind, since, until}. */
export function tierAt(cfg, tz, now) {
  const date = tz.localParts(now).date
  let list = segments(cfg, tz, date)
  let idx = list.findIndex((s) => now >= s.start && now < s.end)
  if (idx < 0) return { kind: cfg?.tou?.defaultTier ?? 'super_off_peak', since: now, until: now + MIN_MS }
  const kind = list[idx].tier
  let since = list[idx].start
  let until = list[idx].end
  let d = date
  let i = idx
  for (let guard = 0; i === 0 && guard < 8; guard++) {
    d = addDays(d, -1)
    const prev = segments(cfg, tz, d)
    const last = prev[prev.length - 1]
    if (!last || last.tier !== kind || last.end !== since) break
    since = last.start
    i = prev.length - 1
  }
  d = date
  i = idx
  for (let guard = 0; i === list.length - 1 && guard < 8; guard++) {
    d = addDays(d, 1)
    const next = segments(cfg, tz, d)
    const first = next[0]
    if (!first || first.tier !== kind || first.start !== until) break
    until = first.end
    list = next
    i = 0
  }
  return { kind, since, until }
}

/**
 * Next instant > now at which the schedule can change: tier boundaries, peak start/end, base
 * precondition starts and fan-only deadlines peakStart + fanOnlyMin (both seasons, addendum B F2), every
 * unit's daily-schedule entry instants (addendum B §5.2) and local midnights. Tuned per-unit precondition
 * starts, late-join deadlines and optimum starts are not included (a host re-ticks at least every 30 s and
 * predicts early starts itself).
 */
export function nextBoundaryAfter(cfg, tz, now) {
  const date = tz.localParts(now).date
  for (const d of [date, addDays(date, 1), addDays(date, 2)]) {
    let best = Infinity
    const consider = (t) => { if (t > now && t < best) best = t }
    consider(tz.zonedToInstant(d, '00:00'))
    consider(tz.zonedToInstant(addDays(d, 1), '00:00'))
    for (const s of segments(cfg, tz, d)) { consider(s.start); consider(s.end) }
    for (const e of events(cfg, tz, d)) {
      consider(e.peakStart)
      consider(e.peakEnd)
      for (const season of ['heating', 'cooling']) {
        const w = preconditionWindow(cfg, tz, e, season)
        if (w) consider(w.preStart)
        const dry = dryOutUntilFor(cfg, e, season)
        if (dry != null) consider(dry)
      }
    }
    for (const u of Array.isArray(cfg?.units) ? cfg.units : []) for (const x of entryInstants(cfg, tz, u, d)) consider(x.at)
    if (best < Infinity) return best
  }
  return now + 86400000
}

/**
 * The event a unit is in at `now` (scans local D−1, D, D+1):
 * {event, phase:'precondition'|'shed', preStart} | null. `unitCfg` null ⇒ whole-system level (all flags on);
 * missing unit flags default to true. `eff` supplies season/leadMin/suspended (H5/H6); without it the
 * heating base lead is used.
 */
export function activeEventFor(cfg, tz, unitCfg, now, eff) {
  if (unitCfg && unitCfg.shed === false) return null
  const date = tz.localParts(now).date
  for (const d of [addDays(date, -1), date, addDays(date, 1)]) {
    for (const e of events(cfg, tz, d)) {
      if (now >= e.peakEnd) continue
      const preStart = preStartOf(cfg, tz, unitCfg, e, eff)
      if (now >= preStart) return { event: e, phase: now < e.peakStart ? 'precondition' : 'shed', preStart }
    }
  }
  return null
}

// The unit's window start for `e`: the precondition window's start when the unit and the event pre-condition
// and the (per-event) eff allows it, else peakStart. `eff` may be a function (event) → eff (B §1.3).
function preStartOf(cfg, tz, unitCfg, e, eff) {
  const ef = typeof eff === 'function' ? eff(e) : eff
  if (unitCfg && unitCfg.precondition === false) return e.peakStart
  if (!(ef?.precondition ?? e.precondition) || ef?.noPrecondition) return e.peakStart
  const w = preconditionWindow(cfg, tz, e, ef?.season ?? null, ef)
  return w ? w.preStart : e.peakStart
}

/** D E2.5 interval test (see header). */
export function eventOverlapping(cfg, tz, unitCfg, from, to, eff) {
  if (unitCfg && unitCfg.shed === false) return false
  const date = tz.localParts(to).date
  for (const d of [addDays(date, -1), date, addDays(date, 1)]) {
    for (const e of events(cfg, tz, d)) {
      if (e.peakEnd <= from) continue
      const pre = preStartOf(cfg, tz, unitCfg, e, eff)
      if (pre <= to && pre < e.peakEnd) return true
    }
  }
  return false
}

/** B §1.7 step 2: the participating event an entry instant folds into (see header). */
export function foldEventFor(cfg, tz, unitCfg, at, eff) {
  return activeEventFor(cfg, tz, unitCfg, at, eff)?.event ?? null
}

// ---- daily scheduled settings (addendum B F3, D E1) ----------------------------------------------

const DAYS_RANK = Object.fromEntries(ENTRY_DAYS.map((d, i) => [d, i]))

/** Normalised, sorted entries of a unit: the daily rows, then the instant rows (see header). */
export function unitEntries(unitCfg) {
  const list = Array.isArray(unitCfg?.schedule) ? unitCfg.schedule : []
  const out = []
  const inst = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    if (x.atMs !== undefined) { const r = instantRow(x); if (r) inst.push(r); continue }
    let min
    try { min = hhmmToMin(x.at) } catch { continue }
    if (min >= 1440 || !/^\d{2}:\d{2}$/.test(x.at)) continue
    const power = typeof x.power === 'boolean' ? (x.power ? 'ON' : 'OFF') : String(x.power ?? '').toUpperCase()
    if (power !== 'ON' && power !== 'OFF') continue
    const e = { at: x.at, min, power }
    if (power === 'ON') {
      if (x.mode != null && x.mode !== '') e.mode = String(x.mode).toUpperCase()
      for (const k of SETPOINTS) if (x[k] != null && x[k] !== '' && Number.isFinite(Number(x[k]))) e[k] = Number(x[k])
      if (x.fan != null && x.fan !== '') e.fan = String(x.fan).toUpperCase()
    }
    e.days = x.days ?? 'all'
    out.push(e)
  }
  out.sort((a, b) => a.min - b.min || (DAYS_RANK[a.days] ?? 9) - (DAYS_RANK[b.days] ?? 9))
  return inst.length ? [...out, ...inst.sort(byAtThenSince('atMs'))] : out
}

// Addendum H: one instant row {atMs, power?, mode?, temp?, coolTo?, heatTo?, fan?, since?, dryOutMin?, meta?} normalised
// like a daily row (an Off row carries no other field) | null (atMs not a finite epoch ms, a named power not ON/OFF, or
// no field at all). since → epoch ms; dryOutMin a number ≥ 0; meta passed through untouched.
function instantRow(x) {
  if (typeof x.atMs !== 'number' || !Number.isFinite(x.atMs)) return null
  const e = { atMs: x.atMs }
  if (x.power != null && x.power !== '') {
    e.power = typeof x.power === 'boolean' ? (x.power ? 'ON' : 'OFF') : String(x.power).toUpperCase()
    if (e.power !== 'ON' && e.power !== 'OFF') return null
  }
  if (e.power !== 'OFF') {
    if (x.mode != null && x.mode !== '') e.mode = String(x.mode).toUpperCase()
    for (const k of SETPOINTS) if (x[k] != null && x[k] !== '' && Number.isFinite(Number(x[k]))) e[k] = Number(x[k])
    if (x.fan != null && x.fan !== '') e.fan = String(x.fan).toUpperCase()
  }
  if (Object.keys(e).length === 1) return null
  const since = msOf(x.since)
  if (since != null) e.since = since
  if (x.dryOutMin != null && x.dryOutMin !== '' && Number(x.dryOutMin) >= 0) e.dryOutMin = Number(x.dryOutMin)
  if (x.meta && typeof x.meta === 'object') e.meta = x.meta
  return e
}

// Sort by instant, ties daily first, then instant rows by since (the later one is the one in effect).
function byAtThenSince(k) {
  const isI = (x) => ((x.key ? x.key.startsWith('i:') : x.atMs !== undefined) ? 1 : 0)
  return (a, b) => a[k] - b[k] || isI(a) - isI(b) || (a.since ?? a[k]) - (b.since ?? b[k])
}

function entryFields(e) {
  const f = e.power !== undefined ? { power: e.power } : {}
  for (const k of ['mode', 'temp', 'coolTo', 'heatTo', 'fan']) if (e[k] !== undefined) f[k] = e[k]
  return f
}

// ---- Addendum F: entries that keep the mode / carry the cool-to / heat-to pair (see header) ----------------

/** An On entry that names no mode: it keeps the mode (rule 1). */
export function keepsMode(fields) { return !!fields && up(fields.power) === 'ON' && (fields.mode == null || fields.mode === '') }
/** The entry carries coolTo and/or heatTo. */
export function hasPair(fields) { return !!fields && (fields.coolTo != null || fields.heatTo != null) }
/** The entry's concrete fields depend on the moment (keepsMode ∨ hasPair). */
export function resolves(fields) { return keepsMode(fields) || hasPair(fields) }

/** The setpoint an entry gives a season: temp (whatever the season), else coolTo (cooling) / heatTo (heating). */
export function setpointFor(fields, season) {
  if (!fields) return undefined
  if (fields.temp != null) return fields.temp
  return season === 'cooling' ? fields.coolTo : season === 'heating' ? fields.heatTo : undefined
}

/** rule 3: the concrete fields an entry means for a run context rc {mode, season, writeMode} (see header). */
export function resolveEntry(fields, rc) {
  if (!fields || typeof fields !== 'object') return fields
  const bare = fields.power == null // Addendum H: an instant row naming no power — it sets a running unit's setpoint
  if ((!bare && up(fields.power) !== 'ON') || (!hasPair(fields) && !keepsMode(fields))) return { ...fields }
  const m = keepsMode(fields) ? rc?.writeMode ?? null : fields.mode
  const t = setpointFor(fields, followsRun(fields) ? rc?.season ?? null : pairSeason(fields.mode))
  return { ...(bare ? {} : { power: fields.power }), ...(m ? { mode: m } : {}), ...(t != null ? { temp: t } : {}), ...(fields.fan != null ? { fan: fields.fan } : {}) }
}

/** The EntryDTO / activity-line view of a resolution: {season, mode?, temp?} (keys only when present). */
export function entryResolution(fields, rc) {
  const R = resolveEntry(fields, rc) ?? {}
  const season = followsRun(fields) ? rc?.season ?? null : pairSeason(fields?.mode)
  return { season, ...(R.mode != null ? { mode: R.mode } : {}), ...(R.temp != null ? { temp: R.temp } : {}) }
}

// The season of an entry's NAMED mode when it carries the cool-to / heat-to pair — only a Daikin head carries the pair
// (the reference app refuses it for other kinds: 'One setpoint for this unit'), so the mode is a Daikin mode by
// construction: HEAT ⇒ heating, COOL / DRY ⇒ cooling. Never used for a keep-mode entry (the run context's season).
function pairSeason(mode) {
  const m = String(mode ?? '').toUpperCase()
  return m === 'HEAT' ? 'heating' : m === 'COOL' || m === 'DRY' ? 'cooling' : null
}

// The entry's season is the run context's: it keeps the mode, or it is a row without power that names no mode (H).
function followsRun(fields) { return keepsMode(fields) || (!!fields && fields.power == null && (fields.mode == null || fields.mode === '')) }

// The run context a projection uses when the host injects none (opts.runContext): the remembered mode — the stranded
// one, then the read's — for a unit that is off; the read's for a unit that is on. Never a mode to write.
function rememberedRc(us, live, sOf) {
  const on = up(live?.power) === 'ON'
  const m = (on ? live?.mode : us?.stranded?.fields?.mode ?? live?.mode) ?? null
  return { masterMode: null, mode: m == null ? null : up(m), season: sOf(m) ?? null, writeMode: null, source: m == null ? null : on ? 'live' : 'remembered' }
}

/** Entry instants of one local date: the daily rows filtered by day type and the instant rows of that date (see header). */
export function entryInstants(cfg, tz, unitCfg, date) {
  const out = dailyInstants(cfg, tz, unitCfg, date)
  const inst = instantRows(cfg, tz, unitCfg).filter((x) => x.date === date)
  return inst.length ? [...out, ...inst].sort(byAtThenSince('at')) : out
}

/** Addendum H: every instant row of a unit, whatever its date (see header). */
export function instantRows(cfg, tz, unitCfg) {
  const byKey = new Map()
  for (const e of unitEntries(unitCfg)) {
    if (e.atMs === undefined) continue
    const p = tz.localParts(e.atMs)
    const x = { key: `i:${new Date(e.atMs).toISOString()}`, at: e.atMs, date: p.date, hhmm: p.hhmm, fields: entryFields(e) }
    for (const k of ['since', 'dryOutMin', 'meta']) if (e[k] !== undefined) x[k] = e[k]
    byKey.delete(x.key) // two rows at one instant share its key: the one that sorts last is the row
    byKey.set(x.key, x)
  }
  return [...byKey.values()]
}

// The daily rows of one local date as instants (the pre-H entryInstants).
function dailyInstants(cfg, tz, unitCfg, date) {
  const dt = dayType(cfg, date)
  const seen = new Set()
  const out = []
  for (const e of unitEntries(unitCfg)) {
    if (e.atMs !== undefined || !entryOnDay(e.days, dt)) continue
    const key = `s:${date}@${e.at}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, at: tz.zonedToInstant(date, e.min), date, hhmm: e.at, days: e.days, fields: entryFields(e) })
  }
  return out.sort((a, b) => a.at - b.at)
}

function armedMs(armedAt) {
  if (armedAt == null) return -Infinity
  const t = msOf(armedAt)
  return t == null ? -Infinity : t
}

/** B F3.11 E* / D P: the latest instant ≤ `instant` over its date and D−1 (see header). */
export function latestEntryAtOrBefore(cfg, tz, unitCfg, instant, armedAt) {
  const armed = armedMs(armedAt)
  const date = tz.localParts(instant).date
  let best = null
  for (const d of [addDays(date, -1), date]) {
    for (const x of dailyInstants(cfg, tz, unitCfg, d)) if (x.at <= instant && x.at > armed && (!best || x.at >= best.at)) best = x
  }
  for (const x of instantRows(cfg, tz, unitCfg)) if (x.at <= instant && (!best || x.at >= best.at)) best = x
  return best
}

/** B F3.3/F3.4: the entry in effect at `now` (see header). */
export function entryInEffect(cfg, tz, unitCfg, now, armedAt) {
  return latestEntryAtOrBefore(cfg, tz, unitCfg, now, armedAt)
}

/** D E2.11: the next entry instant after `now` within 24 h (see header). */
export function nextEntry(cfg, tz, unitCfg, now, armedAt) {
  const armed = armedMs(armedAt)
  const date = tz.localParts(now).date
  let best = null
  for (const d of [date, addDays(date, 1)]) {
    for (const x of dailyInstants(cfg, tz, unitCfg, d)) if (!best && x.at > now && x.at > armed && x.at <= now + 86400000) best = x
  }
  for (const x of instantRows(cfg, tz, unitCfg)) if (x.at > now && x.at <= now + 86400000 && (!best || x.at <= best.at)) best = x
  return best
}

/** B F3.12 + E E1.6: the latest entry with preStart ≤ t ≤ max(peakStart, now) ∧ (t < peakEnd ∨ t = peakStart) ∧ t > armedAt (see header). */
export function eventEntry(cfg, tz, unitCfg, event, preStart, now, armedAt) {
  if (!event) return null
  const armed = armedMs(armedAt)
  const hi = Math.max(event.peakStart, Number.isFinite(now) ? now : -Infinity)
  const date = event.date ?? String(event.id).split('@')[0]
  const inWindow = (x) => x.at >= preStart && x.at <= hi && (x.at < event.peakEnd || x.at === event.peakStart)
  let best = null
  for (const d of [addDays(date, -1), date]) {
    for (const x of dailyInstants(cfg, tz, unitCfg, d)) if (inWindow(x) && x.at > armed && (!best || x.at >= best.at)) best = x
  }
  for (const x of instantRows(cfg, tz, unitCfg)) if (inWindow(x) && (!best || x.at >= best.at)) best = x
  return best
}

/** B F3.4 arming instant of a unit (see header). */
export function armedAtOf(state, unitId) {
  const a = msOf(state?.scheduleArmedAt)
  const b = msOf(state?.units?.[unitId]?.scheduleEditedAt)
  return Math.max(a ?? -Infinity, b ?? -Infinity)
}

// B F3.11's two passes for one unit and event (not engaged): (1) E* = the latest entry at or before peakStart and
// after armedAt (F3.4: an entry the arming passed is no entry today);
// (2) season = seasonOf(E*.power ON ? E*.mode : liveMode), the window from that season's params (a suspension
// ignored for the test), E = E* iff E*.at ≥ preStart (else it already fired: live rules). eff carries
// noPrecondition for an OFF E and suspended:false for an ON E (C-11); for a boundary event also when E is not an
// ON entry and the unit does not read ON in a precondition mode — its own mode's season, Fan/Auto/unknown have none
// (addendum E E1.8, J23). → {star, E, season, eff}
function entryPass(cfg, tz, unitCfg, unitState, e, liveMode, effFn, seasonFn, armedAt, livePower, preconditions = null) {
  const r = entryPassCore(cfg, tz, unitCfg, unitState, e, liveMode, effFn, seasonFn, armedAt, preconditions)
  const onLive = String(livePower ?? '').toUpperCase() === 'ON' && seasonFn(liveMode) != null
  if (e.kind === 'boundary' && r.E?.fields.power !== 'ON' && !onLive) r.eff = { ...r.eff, noPrecondition: true }
  return r
}

function entryPassCore(cfg, tz, unitCfg, unitState, e, liveMode, effFn, seasonFn, armedAt, preconditions) {
  const star = latestEntryAtOrBefore(cfg, tz, unitCfg, e.peakStart, armedAt)
  const on = star?.fields.power === 'ON'
  // Addendum F: a keep-mode E* names no mode — its season is the remembered mode's (stranded, then the read), through
  // the injected seasonOf (a follower's running master decides there)
  const season = seasonFn(on ? (star.fields.mode ?? unitState?.stranded?.fields?.mode ?? liveMode) : liveMode) ?? null
  const eff0 = effFn(cfg, unitCfg, unitState, season ?? 'heating')
  const eff = typeof preconditions === 'function' ? { ...eff0, precondition: !!preconditions(e) } : eff0
  if (!star) return { star, E: null, season, eff }
  const pre = preStartOf(cfg, tz, unitCfg, e, { ...eff, season, suspended: false })
  const E = star.at >= pre ? star : null
  if (!E) return { star, E, season, eff }
  return { star, E, season, eff: on ? { ...eff, suspended: false } : { ...eff, noPrecondition: true } }
}

/** B §1.3 effFor for one unit (see header). */
export function entryEffFor(cfg, tz, unitCfg, unitState, liveMode, { effectivePrecondition, seasonOf, armedAt, livePower, preconditions } = {}) {
  if (typeof seasonOf !== 'function') throw new TypeError('seasonOf required')
  const effFn = typeof effectivePrecondition === 'function' ? effectivePrecondition : fallbackEff
  const pre = typeof preconditions === 'function' ? preconditions : null
  const auto = unitState?.auto
  return (e) => {
    if (auto && auto.phase && auto.phase !== 'idle' && auto.eventId === e.id && auto.params) return pre ? { ...auto.params, precondition: !!pre(e) } : auto.params
    return entryPass(cfg, tz, unitCfg, unitState, e, liveMode, effFn, seasonOf, armedAt, livePower, pre).eff
  }
}

// ---- plan (PlanDay DTO, §4.4 + H6) ------------------------------------------------------------

// Faithful copy of addendum §5.2 effectivePrecondition (used when tuning.js is not injected): per-parameter
// provenance and read-time clamps of the TUNED parameter only, as tuning.js (addendum D X1.1, A-11).
function fallbackEff(cfg, unitCfg, unitState, season) {
  const s = season === 'cooling' ? 'cooling' : 'heating'
  const pc = cfg?.precondition ?? {}
  const opt = cfg?.optimizer ?? {}
  const tuned = unitState?.tuning?.[s]
  const deltaSource = typeof tuned?.deltaF === 'number' ? 'tuned' : 'config'
  const leadSource = typeof tuned?.leadMin === 'number' ? 'tuned' : 'config'
  let deltaF = deltaSource === 'tuned' ? tuned.deltaF : pick(pc.deltaF, s) ?? 3
  let leadMin = leadSource === 'tuned' ? tuned.leadMin : pick(pc.leadMin, s) ?? 120
  const source = deltaSource === 'tuned' || leadSource === 'tuned' ? 'tuned' : 'config'
  let clampedBy = null
  if (deltaSource === 'tuned') {
    const lo = opt.minDeltaF ?? 1
    const hi = Math.min(opt.maxDeltaF ?? 4, 6)
    if (deltaF > hi) { deltaF = hi; clampedBy = 'maxDeltaF' } else if (deltaF < lo) { deltaF = lo; clampedBy = 'minDeltaF' }
  }
  if (leadSource === 'tuned') leadMin = clamp(leadMin, opt.minLeadMin ?? 60, 240)
  return {
    season, deltaF, leadMin,
    clampF: pc.clampF ?? { coolingMin: 65, heatingMax: 76 },
    earliestStart: opt.earliestStart ?? '04:30',
    suspended: !!unitState?.tuning?.suspended,
    source, deltaSource, leadSource, clampedBy,
  }
}

function fmtNum(n) {
  const r = Math.round(Number(n) * 10) / 10
  return (r < 0 ? MINUS : '') + String(Math.abs(r))
}

function hmm(tz, ms) { const p = tz.localParts(ms); return `${p.hour}:${String(p.minute).padStart(2, '0')}` }

/** THE §2.4 bump with injected limits (see header — Addendum G: the host's kinds.bumpLimits). */
export function bumpTarget(original, season, deltaF, limits, step = 1, tol = 0.6) {
  const o = Number(original)
  if (!Number.isFinite(o) || !limits || (season !== 'cooling' && season !== 'heating' && season !== 'water')) return { target: null, moves: false }
  const cool = season === 'cooling'
  const d = Math.abs(Number.isFinite(Number(deltaF)) && deltaF !== null && deltaF !== '' ? Number(deltaF) : 0)
  const s = Number(step) > 0 ? Number(step) : 1
  const t0 = roundToStep(o + (cool ? -d : d), s)
  const t = cool ? Math.min(Math.max(t0, limits.floor), limits.ceiling) : Math.max(Math.min(t0, limits.ceiling), limits.floor)
  const tl = Number(tol) || 0
  return { target: t, moves: cool ? t < o - tl - 1e-9 : t > o + tl + 1e-9 }
}

// A head's bump limits in a plan (no device caps): clampF ∩ 61–90 — the host's kinds.bumpLimits for a Daikin head.
function headLimits(season, clampF) {
  if (season === 'cooling') return { floor: Math.max(Number(clampF?.coolingMin ?? 65), 61), ceiling: 90 }
  if (season === 'heating') return { floor: 61, ceiling: Math.min(Number(clampF?.heatingMax ?? 76), 90) }
  return null
}

// PlanDay fanOnlyUntil (addendum B §3.4): while the unit is in shed for `e`, the persisted auto.dryOutUntil
// (a late join dries out from its entry read); otherwise predicted from `src` (the phase-entry read while
// engaged, else live; a unit an ON precondition entry turns on runs in the entry's mode) by the F2.7 rule —
// running in COOL/DRY/HEAT with FAN in the unit's caps (unknown caps count as having it) ⇒ dryOutUntilFor
// from peakStart. null when the unit does not shed `e` or goes straight to OFF.
function planDryOut(cfg, e, shed, auto, active, src, caps, sOf, dryOut = true) {
  if (shed !== 'off' || !dryOut) return null
  if (active && auto.phase === 'shed') return msOf(auto.dryOutUntil)
  if (!src || String(src.power ?? '').toUpperCase() !== 'ON') return null
  if (!hasFan(caps)) return null
  return dryOutUntilFor(cfg, e, sOf(src.mode))
}

function hasFan(caps) {
  const modes = caps?.modes
  return !(Array.isArray(modes) && modes.length && !modes.some((m) => String(m).toUpperCase() === 'FAN'))
}

function timeLabel(tz, ms) { return typeof tz.formatLocal === 'function' ? tz.formatLocal(ms, 'time') : hmm(tz, ms) }

// {key, at, atLabel, label, resolved?} of an entry instant (tou's own, or a persisted auto.entry {key, at ISO, fields,
// season?, resolved?}); `resolved` (Addendum F) only for an entry that resolves — auto.entry's own, else from `rc`.
function entryRef(tz, x, rc) {
  if (!x) return null
  const at = msOf(x.at)
  const out = { key: x.key ?? null, at: iso(at), atLabel: at == null ? '' : hmm(tz, at), label: rowLabel(x.fields) }
  if (!resolves(x.fields)) return out
  out.resolved = resolutionOf(x, rc)
  out.label = rowLabel(x.fields, { season: out.resolved.season })
  return out
}

// entryLabel, but a row naming no power (Addendum H's setpoint-only instant row) reads without "On ·": "heat to 62°".
function rowLabel(fields, opts) { return fields?.power == null ? settingLabel(fields, opts) : entryLabel(fields, opts) }

// {season, mode?, temp?} of a resolving entry: a persisted auto.entry carries its own (decide's), else from rc.
function resolutionOf(x, rc) {
  if (!x.resolved) return entryResolution(x.fields, rc)
  const R = x.resolved
  return { season: x.season ?? null, ...(R.mode != null ? { mode: R.mode } : {}), ...(R.temp != null ? { temp: R.temp } : {}) }
}

function dryoutSkipText(v) {
  const names = Array.isArray(v) ? v : Array.isArray(v?.units) ? v.units : []
  if (!names.length) return null
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const verb = v?.season === 'heating' ? 'heating' : 'cooling'
  return `skipped if ${list} ${names.length === 1 ? 'is' : 'are'} ${verb}`
}

function unitPlan(cfg, tz, e, u, us, ledgerEntry, live, effFn, dryoutSkip, armedAt, unitLedger, rcAt, sOf, rules) {
  const R0 = rules ?? {}
  const dryOut = R0.dryOut !== false
  const preconditions = typeof R0.preconditions === 'function' ? R0.preconditions : null
  let shed = R0.shed === 'setback' ? 'setback' : 'off' // Addendum G: a setback unit's shed is its setpoint
  if (u.shed === false) shed = 'opted out'
  else if (us?.skipDate === e.date || ledgerEntry?.status === 'skipped') shed = 'skipped'
  else if (ledgerEntry?.status === 'released') shed = 'released'

  const auto = us?.auto
  const active = !!auto && auto.eventId === e.id && auto.phase && auto.phase !== 'idle'
  const src = active ? (auto.baseline ?? live) : live
  // addendum B F3.11: the window's season comes from E* (the latest entry at or before peakStart) when it says ON
  const pass = active && auto.params ? null : entryPass(cfg, tz, u, us, e, src?.mode, effFn, sOf, armedAt, earlyStraddles(unitLedger, e) ? null : src?.power, preconditions)
  const season = pass ? pass.season : auto.params.season
  const eff = pass ? pass.eff : preconditions ? { ...auto.params, precondition: !!preconditions(e) } : auto.params
  const winStart = preStartOf(cfg, tz, u, e, eff)
  const E = active ? (auto.entry ?? null) : shed === 'opted out' ? null : pass.E
  const R = shed === 'opted out' || shed === 'skipped' ? null : active ? (auto.entry ?? null) : eventEntry(cfg, tz, u, e, Math.min(winStart, pass.E?.at ?? Infinity), e.peakEnd - 1, armedAt)
  const eOn = E?.fields?.power === 'ON'
  // Addendum F: a keep-mode E runs the run context's mode at peakStart, in its season (auto.entry's while engaged)
  const eKeep = eOn && keepsMode(E.fields)
  const rcPeak = eOn && resolves(E.fields) ? rcAt(e.peakStart) : null
  const eSeason = !eOn ? null : eKeep ? (E.season !== undefined ? E.season : rcPeak?.season ?? null) : sOf(E.fields.mode)
  const eMode = !eKeep ? E?.fields?.mode : sOf(rcPeak?.mode) === eSeason ? up(rcPeak.mode) : eSeason === 'heating' ? 'HEAT' : eSeason === 'cooling' ? 'COOL' : null
  const runSrc = !active && eOn && !(shed !== 'off') ? { power: 'ON', mode: eMode } : src
  const restoreOf = (x) => (resolves(x.fields) ? x.resolved ?? resolveEntry(x.fields, rcAt(msOf(x.at))) : x.fields)
  const res = {
    precondition: 'off', shed, preStart: null, target: null, source: null,
    fanOnlyUntil: iso(planDryOut(cfg, e, shed, auto, active, runSrc, live?.caps, sOf, dryOut)),
    entry: entryRef(tz, E, rcPeak),
    // a row without power (H) restores its season's setpoint in F's verb form ("heat to 62°")
    restore: !R ? null : R.fields?.power === 'OFF' ? 'stays off' : R.fields?.power == null ? settingLabel(R.fields, { season: resolutionOf(R, rcAt(msOf(R.at))).season }) : settingLabel(restoreOf(R)),
    dryout: shed === 'off' && dryOut && e.kind !== 'boundary' ? dryoutSkipText(dryoutSkip) : null, // a boundary never sheds (E1.4)
  }
  if (!(preconditions ? preconditions(e) : e.precondition) || u.shed === false || u.precondition === false) return res

  if (!active && E?.fields.power === 'OFF') { res.precondition = 'skip: scheduled off'; return res }
  if (eff?.suspended) { res.precondition = 'skip: paused (unit idle for days)'; return res }
  const win = eff?.noPrecondition ? null : preconditionWindow(cfg, tz, e, season, eff)
  if (!win) return res
  res.preStart = iso(win.preStart)
  res.source = eff?.source ?? 'config'
  const tail = ` from ${hmm(tz, win.preStart)}${res.source === 'tuned' ? ' · auto-tuned' : ''}`
  const verbOf = (s) => (s === 'cooling' ? 'cool' : 'heat')
  const modes = Array.isArray(cfg?.precondition?.modes) ? cfg.precondition.modes : ['COOL', 'DRY', 'HEAT']
  const preMode = typeof R0.preconditionMode === 'function' ? (m) => !!R0.preconditionMode(m) : (m) => modes.includes(m)
  const limitsOf = typeof R0.bumpLimits === 'function' ? (s, clampF) => R0.bumpLimits(s, live?.caps ?? null, clampF) : headLimits
  const sched = eOn ? ` (scheduled ${settingLabel(E.fields, { fan: false, season: eSeason })})` : ''
  const owned = active ? auto.owned?.temp : null
  if (owned && Number.isFinite(Number(owned.original)) && Number.isFinite(Number(owned.applied))) {
    const sp = eOn ? setpointFor(E.fields, eSeason) : undefined
    const base = eOn && Number.isFinite(Number(sp)) ? Number(sp) : Number(owned.original)
    const d = Number(owned.applied) - base
    res.target = Number(owned.applied)
    res.precondition = `${verbOf(season)} ${d < 0 ? MINUS : '+'}${fmtNum(Math.abs(d))}° → ${fmtNum(owned.applied)}°${tail}${sched}`
    return res
  }
  const deltaF = Number(eff?.deltaF ?? 3)
  const clampF = eff?.clampF ?? cfg?.precondition?.clampF
  const step = Number(src?.tempStep) || 1
  if (eOn) {
    // addendum B F3.11 + C F3.11′: the target is the entry's setting; a running unit already past the bumped
    // target in the entry's season keeps its setpoint (never un-condition); the unit may be OFF (the entry
    // authorizes the ON). Addendum F: a keep-mode entry pre-conditions in the run context's season (unknown ⇒
    // none); the base is the season's setpoint of the pair (setpointFor), else the read.
    const mode = up(eMode)
    const s = eSeason
    if (eKeep && !s) { res.precondition = 'skip: season unknown'; return res }
    if (eKeep && !preMode(mode)) { res.precondition = `skip: mode ${mode || 'unknown'}`; return res }
    if (!s || !preMode(mode)) { res.precondition = `skip: scheduled mode ${modeLabel(mode) || 'unknown'}`; return res }
    const sp = setpointFor(E.fields, s)
    const base = Number.isFinite(Number(sp)) ? Number(sp) : Number(src?.temp)
    if (!Number.isFinite(base)) { res.precondition = `±${fmtNum(deltaF)}°${tail}${sched}`; return res }
    const { target, moves } = bumpTarget(base, s, deltaF, limitsOf(s, clampF), step, 0)
    if (target == null) { res.precondition = `±${fmtNum(deltaF)}°${tail}${sched}`; return res }
    const lt = Number(src?.temp)
    const running = String(src?.power ?? '').toUpperCase() === 'ON' && sOf(src?.mode) === s && Number.isFinite(lt)
    const kept = running ? (s === 'cooling' ? Math.min(target, lt) : Math.max(target, lt)) : target
    if (running && Math.abs(kept - lt) < 1e-9) {
      res.precondition = `keeps ${fmtNum(lt)}° (already ${s === 'cooling' ? 'below' : 'above'} the ${fmtNum(target)}° target)`
      return res
    }
    if (!moves && !running) { res.precondition = s === 'cooling' ? 'skip: already at floor' : 'skip: already at ceiling'; return res }
    res.target = kept
    const from = running ? lt : base
    res.precondition = `${verbOf(s)} ${kept < from ? MINUS : '+'}${fmtNum(Math.abs(kept - from))}° → ${fmtNum(kept)}°${tail}${sched}`
    return res
  }
  if (!src) { res.precondition = `±${fmtNum(deltaF)}°${tail}`; return res }
  if (String(src.power ?? '').toUpperCase() !== 'ON') { res.precondition = 'skip: unit off'; return res }
  const mode = String(src.mode ?? '').toUpperCase()
  if (!season || !preMode(mode)) { res.precondition = `skip: mode ${mode || 'unknown'}`; return res }
  const original = Number(src.temp)
  if (!Number.isFinite(original)) { res.precondition = `±${fmtNum(deltaF)}°${tail}`; return res }
  const { target, moves } = bumpTarget(original, season, deltaF, limitsOf(season, clampF), step, 0)
  if (target == null) { res.precondition = `±${fmtNum(deltaF)}°${tail}`; return res }
  if (!moves) { res.precondition = season === 'cooling' ? 'skip: already at floor' : 'skip: already at ceiling'; return res }
  res.target = target
  res.precondition = `${verbOf(season)} ${season === 'cooling' ? MINUS : '+'}${fmtNum(Math.abs(target - original))}° → ${fmtNum(target)}°${tail}`
  return res
}

// Addendum E E1.10 (decide's effFor rule): a unit reading ON because of our own optimum start for an entry after a
// boundary — an early ledger record (reason 'optimum-start' or 'dry-run', with startedAt) with startedAt < t < instant —
// does not count as ON for that boundary event (livePower null): the early start runs as it does without the option.
function earlyStraddles(ledger, e) {
  if (e?.kind !== 'boundary' || !ledger) return false
  return Object.entries(ledger).some(([k, v]) => k.startsWith('s:') && v && v.startedAt != null && (v.reason === 'optimum-start' || v.reason === 'dry-run') &&
    msOf(v.startedAt) < e.peakStart && e.peakStart < msOf(v.instant))
}

// PlanDay.entries[unitId] (addendum B §3.4 + D E1.7/E2.11): the unit's entry instants of the date with the
// event that folds each (null = fires on time; a skipped event never folds), `days`, and for ON entries the
// optimum start: startAt/lead from opts.early for the one entry its result names, else earlyMax = the cap
// when an early start is possible at all (cap > 0, the unit pre-conditions, not folded, no window overlaps
// [at − cap, at]).
function planEntries(cfg, tz, date, u, us, ledger, live, effFn, earlyRes, armedAt, rcAt, sOf, rules) {
  const opts = { effectivePrecondition: effFn, armedAt, seasonOf: sOf, ...(typeof rules?.preconditions === 'function' ? { preconditions: rules.preconditions } : {}) }
  const onFor = entryEffFor(cfg, tz, u, us, live?.mode, { ...opts, livePower: live?.power })
  const offFor = entryEffFor(cfg, tz, u, us, live?.mode, { ...opts, livePower: null })
  const effFor = (e) => (earlyStraddles(ledger, e) ? offFor : onFor)(e) // E1.10, as decide's effFor
  const cap = Number(cfg?.precondition?.optimumStart)
  return entryInstants(cfg, tz, u, date).map((x) => {
    const ev = foldEventFor(cfg, tz, u, x.at, effFor)
    const skipped = ev && (us?.skipDate === ev.date || ledger?.[ev.id]?.status === 'skipped')
    const out = { key: x.key, at: iso(x.at), atLabel: hmm(tz, x.at), label: rowLabel(x.fields), fields: x.fields, folded: ev && !skipped ? ev.id : null, days: x.days }
    const instant = x.key.startsWith('i:')
    if (instant) { // Addendum H: an instant row has no day types; since/dryOutMin/meta ride along, meta.house as `house`
      delete out.days
      if (x.since !== undefined) out.since = iso(x.since)
      if (x.dryOutMin !== undefined) out.dryOutMin = x.dryOutMin
      if (x.meta !== undefined) { out.meta = x.meta; if (x.meta.house !== undefined) out.house = x.meta.house }
    }
    if (x.fields.power === 'OFF') return out
    if (resolves(x.fields)) { // Addendum F: the resolution at the entry's instant, and the label in its season
      out.resolved = entryResolution(x.fields, rcAt(x.at))
      out.label = rowLabel(x.fields, { season: out.resolved.season })
    }
    if (instant) return out // a one-off row never starts early
    if (earlyRes && earlyRes.entry?.key === x.key && Number.isFinite(msOf(earlyRes.startAt))) {
      out.startAt = iso(msOf(earlyRes.startAt))
      out.lead = earlyRes.lead ?? null
    } else if (cap > 0 && u.precondition !== false && !out.folded && !eventOverlapping(cfg, tz, u, x.at - cap * MIN_MS, x.at, effFor)) {
      out.earlyMax = cap
    }
    return out
  })
}

// PlanDay.units[id].entryDryOut (addendum C §3.5, CD-5): one prediction per unit from its live read — a unit
// reading ON in a conditioning mode, FAN in caps (unknown caps count), fanOnlyMin[season] > 0 — dries out
// after its next OFF entry of the date (at > opts.now): until = X.at + fanOnlyMin[season]. tou's own
// mode→season helper (a follower's live mode already is the master's; a master in Fan leaves it reading Fan).
function planEntryDryOut(cfg, live, list, now, sOf, dryOut = true) {
  if (!dryOut || !live || String(live.power ?? '').toUpperCase() !== 'ON' || !hasFan(live.caps)) return undefined
  const s = sOf(live.mode)
  const x = s ? list.find((y) => y.fields.power === 'OFF' && msOf(y.at) > now) : null
  const min = x ? Number(x.dryOutMin ?? pick(cfg?.shed?.fanOnlyMin, s) ?? FAN_ONLY_MIN[s]) : 0 // an instant row's own minutes (H)
  return min > 0 ? { until: iso(msOf(x.at) + min * MIN_MS) } : undefined
}

// PlanDay.markers (addendum D E4.4/§1.6): entry marks grouped by (kind, at) across units, with structured lines.
// `evById`: the PlanDay events by id. A folded entry marks the event's end; for a boundary event (addendum E §3.4)
// the entry at t notes the unit's pre-condition start, one before t that it applies when the pre-condition ends.
function planMarkers(cfg, tz, units, entries, perUnit, evById, liveOf) {
  const out = []
  const add = (m) => {
    const hit = out.find((o) => o.kind === m.kind && o.at === m.at && o.end === m.end)
    if (hit) { hit.units.push(...m.units); hit.lines.push(...m.lines) } else out.push(m)
  }
  for (const u of units) {
    const list = entries[u.id] ?? []
    const dry = perUnit[u.id]?.entryDryOut ?? null
    const untilMs = msOf(dry?.until)
    let dryEntry = null
    if (untilMs != null) for (const x of list) if (x.fields.power === 'OFF' && msOf(x.at) < untilMs && (!dryEntry || msOf(x.at) > msOf(dryEntry.at))) dryEntry = x
    for (const x of list) {
      const line = { unit: u.id, name: u.name ?? u.id, at: x.at, label: x.label, note: null, ...(x.house !== undefined ? { house: x.house } : {}) }
      if (x.folded) {
        const ev = evById.get(x.folded)
        const end = msOf(ev?.peakEnd)
        if (ev?.kind === 'boundary') {
          line.note = msOf(x.at) < end ? `applies at ${timeLabel(tz, end)} when the pre-condition ends` : `pre-conditioned from ${timeLabel(tz, msOf(ev.units[u.id]?.preStart ?? ev.preStart))}`
        } else line.note = end != null ? `applies at ${timeLabel(tz, end)} when the peak ends` : 'applies when the peak ends'
        add({ at: iso(end ?? msOf(x.at)), kind: 'folded', units: [u.id], lines: [line] })
        continue
      }
      if (x.startAt) {
        const room = Number(liveOf(u.id)?.room)
        line.note = `starts ~${timeLabel(tz, msOf(x.startAt))}${Number.isFinite(room) ? ` (room ${fmtNum(room)}°)` : ''}`
      } else if (x.earlyMax) line.note = `may start up to ${x.earlyMax} min early`
      else if (x === dryEntry) line.note = `fan-only, then off at ${timeLabel(tz, untilMs)}`
      add({ at: x.at, kind: x.house !== undefined ? 'house' : 'entry', units: [u.id], lines: [line] })
      if (x.startAt) add({ at: x.startAt, end: x.at, kind: 'start', units: [u.id], lines: [] })
      if (x === dryEntry) add({ at: x.at, end: dry.until, kind: 'dryout', units: [u.id], lines: [] })
    }
  }
  return out.sort((a, b) => msOf(a.at) - msOf(b.at))
}

/**
 * PlanDay (§4.4) for a local date.
 * @param opts.live  map {unitId: live} or function unitId → live|null (the host's live reads); used for the
 *                   per-unit precondition text when the unit does not own the event.
 * @param opts.effectivePrecondition  inject tuning.effectivePrecondition (else §5.2 fallback).
 * @param opts.seasonOf  REQUIRED (mode, unitCfg) → 'heating' | 'cooling' | 'water' | null — the host's season of a mode on
 *                   a unit (TypeError 'seasonOf required' without it; see the header's unit kinds).
 * @param opts.unitRules  (unitCfg) → {shed?, dryOut?, preconditions?(event), preconditionMode?(mode), bumpLimits?(season,
 *                   caps, clampF)} | null — what a non-Daikin unit kind does (header); absent ⇒ a head's rules.
 * @param opts.early  {unitId: early.optimumStart result | null} (addendum D E2.11, injected like the eff).
 * @param opts.dryoutSkip  {unitId: [names] | {units:[names], season}} — the master's keepsConditioning forecast,
 *                   computed by the host (the reference app's multi-split module, addendum C CD-5); tou only words it.
 * @param opts.now  epoch ms: entryDryOut looks at OFF entries after it (default: the whole date).
 * @param opts.runContext  {unitId: (at: epoch ms) → {masterMode, mode, season, writeMode} | null} (Addendum F, injected like
 *                   the eff): what a keep-mode / pair entry resolves to at an instant; read only for those entries.
 * Per-unit event entries: {precondition:text, shed:text, preStart:ISO|null, target:number|null, source,
 *   fanOnlyUntil:ISO|null, entry:{key, at, atLabel, label, resolved?}|null, restore:"Heat 70° · Low"|"stays off"|null,
 *   dryout:'skipped if <unit> is cooling'|null} (fanOnlyUntil: planDryOut — the fan-only deadline, null =
 *   straight to OFF; entry: the precondition target entry — auto.entry while engaged; restore: what the
 *   folded entry leaves the unit at when the peak ends).
 * Precondition texts: "cool −3° → 71° from 5:00", "heat +4° → 74° from 4:30 · auto-tuned",
 * "heat +3° → 73° from 5:00 (scheduled Heat 70°)", "keeps 68° (already below the 71° target)",
 * "skip: scheduled off", "skip: scheduled mode Fan", "skip: unit off", "skip: mode FAN", "skip: season unknown" (F),
 * "heat +3° → 71° from 5:00 (scheduled heat to 68°)" (F: a keep-mode / pair entry in its resolved season),
 * "skip: already at floor|ceiling", "off". Shed texts: "off" | "opted out" | "skipped" | "released".
 * PlanDay also carries entries {unitId: [{key, at, atLabel, label, fields, folded, days, startAt?, lead?,
 * earlyMax?, resolved?}]} (planEntries; `resolved` {season, mode?, temp?} only for an entry that resolves), units {unitId: {entryDryOut?: {until}}} and markers [{at, end?, kind:'entry'|
 * 'folded'|'start'|'dryout', units, lines:[{unit, name, at, label, note}]}] (planMarkers).
 * Addendum E: events[] carry kind 'peak' | 'boundary'; a boundary event's units have fanOnlyUntil null and dryout
 * null, `precondition` 'off' for a unit it does not engage (E1.8); entries[u][j].folded = the boundary's id for the
 * unit's ON entry at t when it pre-conditions (see plan()); folded-marker notes "pre-conditioned from 5:00 AM" (the
 * entry at t) / "applies at 7:00 AM when the pre-condition ends" (an entry inside the window).
 * A unit whose ON read is our own optimum start for an entry after the boundary (its early ledger record straddles t)
 * is judged not ON for that boundary (E1.10, decide's effFor rule), so the plan shows no pre-condition for it.
 */
export function plan(cfg, state, tz, date, opts = {}) {
  if (typeof opts?.seasonOf !== 'function') throw new TypeError('seasonOf required')
  const seasonFnOf = (u) => (m) => opts.seasonOf(m, u) ?? null // Addendum G: the host's season of a mode on unit u
  const rulesOf = (u) => (typeof opts.unitRules === 'function' ? opts.unitRules(u) ?? null : null)
  const liveOf = typeof opts.live === 'function' ? opts.live : (id) => opts.live?.[id] ?? null
  const effFn = typeof opts.effectivePrecondition === 'function' ? opts.effectivePrecondition : fallbackEff
  const now = Number.isFinite(opts.now) ? opts.now : -Infinity
  // Addendum F: the host's run context per unit, (at) → {masterMode, mode, season, writeMode} | null; the remembered
  // mode without it. Read only for entries that resolve (keep the mode / carry the pair).
  const rcFor = (u, us) => {
    const f = opts.runContext?.[u.id]
    return (at) => (typeof f === 'function' ? f(at) : null) ?? rememberedRc(us, liveOf(u.id), seasonFnOf(u))
  }
  const units = (Array.isArray(cfg?.units) ? cfg.units : [])
    .map((u, i) => ({ u, i }))
    .sort((a, b) => (a.u.order ?? a.i) - (b.u.order ?? b.i) || a.i - b.i)
    .map((x) => x.u)
  const holiday = isHoliday(cfg?.holidays, date)
  const dayEvents = events(cfg, tz, date)
  const evs = dayEvents.map((e) => {
    const perUnit = {}
    let unitPre = null
    for (const u of units) {
      const us = state?.units?.[u.id] ?? null
      const entry = unitPlan(cfg, tz, e, u, us, state?.ledger?.[u.id]?.[e.id] ?? null, liveOf(u.id), effFn, opts.dryoutSkip?.[u.id], armedAtOf(state, u.id), state?.ledger?.[u.id], rcFor(u, us), seasonFnOf(u), rulesOf(u))
      perUnit[u.id] = entry
      if (entry.preStart && (unitPre === null || entry.preStart < unitPre)) unitPre = entry.preStart
    }
    let preStart = unitPre
    if (preStart === null && e.precondition) {
      const w = [preconditionWindow(cfg, tz, e, 'heating'), preconditionWindow(cfg, tz, e, 'cooling')].filter(Boolean)
      if (w.length) preStart = iso(Math.min(...w.map((x) => x.preStart)))
    }
    return { id: e.id, kind: e.kind, preStart, peakStart: iso(e.peakStart), peakEnd: iso(e.peakEnd), precondition: !!e.precondition, units: perUnit }
  })
  const entries = {}
  const perUnit = {}
  for (const u of units) {
    const us = state?.units?.[u.id] ?? null
    entries[u.id] = planEntries(cfg, tz, date, u, us, state?.ledger?.[u.id], liveOf(u.id), effFn, opts.early?.[u.id] ?? null, armedAtOf(state, u.id), rcFor(u, us), seasonFnOf(u), rulesOf(u))
    const dry = planEntryDryOut(cfg, liveOf(u.id), entries[u.id], now, seasonFnOf(u), rulesOf(u)?.dryOut !== false)
    perUnit[u.id] = dry ? { entryDryOut: dry } : {}
  }
  // addendum E §3.4: a unit's ON entry AT a boundary is its pre-condition's target, applied by the return at t — it
  // folds into the boundary event when the unit pre-conditions for it (text neither 'off' nor a skip) and the event
  // is not skipped (a skipped event never folds); foldEventFor alone never folds it (the event is over at t)
  for (const e of evs) {
    if (e.kind !== 'boundary') continue
    for (const u of units) {
      const pu = e.units[u.id]
      if (pu.shed === 'skipped' || pu.precondition === 'off' || /^skip/.test(pu.precondition)) continue
      const x = entries[u.id].find((y) => y.fields.power === 'ON' && y.at === e.peakStart)
      if (x) x.folded = e.id
    }
  }
  // an entry of this date folds only into an event of this date (windows never cross midnight; preStart ≥ 03:00)
  const evById = new Map(evs.map((e) => [e.id, e]))
  return {
    date,
    dow: dowOf(date),
    dayType: dayType(cfg, date),
    holiday: holiday ? holiday.name : null,
    segments: segments(cfg, tz, date).map((s) => ({ tier: s.tier, start: iso(s.start), end: iso(s.end), localStart: s.localStart, localEnd: s.localEnd })),
    events: evs,
    entries,
    units: perUnit,
    markers: planMarkers(cfg, tz, units, entries, perUnit, evById, liveOf),
  }
}
