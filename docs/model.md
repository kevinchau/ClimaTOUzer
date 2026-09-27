# The ClimaTOUzer model

This is the full description of what the library computes: the rate model, the pre-conditioning window, the
per-season parameters, the daily rollup and episode extraction, the drift model and the tuning decision table. The
code is the reference; every module's header states its exact contract, and the section numbers in those headers
(`§5.2`, `addendum E`, ...) refer to the design documents this model was distilled from.

Conventions used throughout:

- Temperatures are °F. A season sign `s` is `+1` for heating and `−1` for cooling, and every formula works in
  *comfort coordinates* `z = s·room`, so "higher `z`" always means "more comfortable against the season". Heating
  and cooling are one code path.
- Instants passed in and out of `tou`, `tuning` and `optimizer` are epoch milliseconds. Inside rollups and
  episodes they are epoch **seconds** (the usage-record convention). Local dates are `'YYYY-MM-DD'` strings,
  local times `'HH:MM'`.
- Nothing reads the clock or the process time zone. `now` is an argument and all wall-clock math goes through a
  `tz` object from `makeTz(timezone)`. The suites re-run under `TZ=UTC` and `TZ=Asia/Tokyo` to prove it.

## 1. Time

`makeTz(timezone)` wraps one cached `Intl.DateTimeFormat` and gives:

- `localParts(ms)` → `{date, dow, minuteOfDay, hour, minute, hhmm, …}` and `offsetAt(ms)` (minutes east of UTC).
- `zonedToInstant(date, 'HH:MM')` → epoch ms with a two-pass offset solve. A time inside the spring-forward gap
  moves forward by the gap (2026-03-08 02:30 becomes 03:30 PDT); a time inside the fall-back overlap resolves to
  the **earlier** occurrence (2026-11-01 01:30 is 08:30Z); `'24:00'` is the next date's midnight.
- `addDays(date, n)` works on the calendar string (never `+86400000`), and `dayBounds(date)` returns 1380, 1440 or
  1500 minutes.

Every window in the model is a pair of absolute instants built with `zonedToInstant`, so nothing runs twice or is
skipped on a DST day, and event ids (keyed by local date and configured start time) are stable across restarts.

## 2. Rate tables, tiers and day types

A config holds two day tables, `tou.weekday` and `tou.weekendHoliday`: lists of windows
`{start, end, tier, precondition?}` with tiers `peak`, `off_peak` and `super_off_peak`. Gaps are filled with
`tou.defaultTier`. Windows are on the 5-minute grid, in time order, never overlapping, never crossing midnight;
`precondition: true` is allowed only on peak windows.

- **Day type** (`dayType`, the one definition is `validation.dayTypeOf`): `holiday` when the date is listed in
  `holidays.rows`, `weekend` when its weekday is in `tou.weekendDays` (default Sunday and Saturday), else
  `weekday`. Holidays and weekends use the weekend & holidays table.
- **Holidays** come from presets (`us-federal`: 11 federal holidays; `ca-utility-8`: the 8 holidays a typical
  utility tariff lists; `none`). Fixed-date holidays that fall on a Saturday move to Friday and on a Sunday to
  Monday, flagged `observed: true`; `generate(preset, year)` returns exactly the rows whose observed date falls in
  `year` (so generating 2027 includes 2027-12-31 for New Year 2028). `seed` merges without duplicates and never
  touches rows with `source: 'user'`. The rate model reads only `holidays.rows`.
- **Segments** (`segments(cfg, tz, date)`) are the gap-filled windows of that date as absolute instants, adjacent
  same-tier segments merged. `tierAt(cfg, tz, now)` gives the current tier with its full extent (across midnight).

The default table (`defaultConfig()`), a common two-peak residential plan: weekdays peak 07:00 to 10:00
(pre-conditioned) and 17:00 to 20:00 (not), off-peak 10:00 to 17:00 and 20:00 to 23:00, super off-peak otherwise;
weekends and holidays off-peak 07:00 to 23:00 and super off-peak otherwise.

## 3. Peak events

An **event** is a maximal run of peak windows of one local date. Windows that touch, or that are separated by a
gap shorter than `tou.mergeGapMin` (default 30), merge, and the gap becomes part of the event.

- `id = '<date>@<HH:MM of the first window's configured start>'`, stable across DST and restarts.
- `precondition` is true when any merged window is flagged.
- `events(cfg, tz, date)` lists the date's events by `peakStart`, each `{id, date, kind: 'peak', peakStart,
  peakEnd, precondition, windows}`.

## 4. The pre-condition window

Before a pre-conditioned event the unit runs harder (a setpoint `deltaF` degrees toward comfort) for `leadMin`
minutes, then sheds (turns off) through the peak. `preconditionWindow(cfg, tz, event, season, eff)`:

```
preStart = max( peakStart − leadMin,
                previous same-day event end + mergeGapMin,
                03:00 local,
                optimizer.earliestStart            (only when the lead is tuned) )
leadMin  = eff.leadMin ?? precondition.leadMin[season]        (season null ⇒ heating)
```

There is no window when the event is not flagged, when `eff.suspended` is set, or when
`peakStart − preStart < precondition.minLeadMin`. The 03:00 floor keeps every start out of the 01:00 to 03:00
daylight-saving band; the validator warns when a lead would otherwise start there or when a window is not all super
off-peak. `activeEventFor(cfg, tz, unitCfg, now, eff)` answers "which event is this unit in right now, and in which
phase" (`precondition` on `[preStart, peakStart)`, `shed` on `[peakStart, peakEnd)`), scanning the previous, current
and next local date; `nextBoundaryAfter` gives the next instant at which anything in the schedule can change.

**Fan-only dry-out.** A shed entered from a running unit may first run the fan for `shed.fanOnlyMin[season]`
minutes (default 60 cooling, 15 heating) to dry the coil, then turn off:
`dryOutUntil = min(entry + fanOnlyMin[season], peakEnd)` (`dryOutUntilFor`); no dry-out for Auto or Fan modes.

**Weekend boundary events (optional).** With `precondition.superOffPeak.weekend: true`, every weekend and holiday
date also gets one *boundary event* per super off-peak to off-peak step of its table (`kind: 'boundary'`,
`peakStart = peakEnd = t`). Its peak is empty: a unit pre-conditions on `[preStart, t)` with the same window math
and simply stops at `t`, banking super off-peak energy before the tier rises, with nothing to shed. Only units
with something to do engage (a unit that reads ON in a pre-conditioning mode, or has an ON scheduled entry).

**Daily scheduled entries.** A unit may carry entries `{at: 'HH:MM', power, mode?, temp?, coolTo?, heatTo?, fan?, days?}` with
`days` `all`, `weekday` or `weekend` (weekend covers holidays); `unitEntries` normalises them and drops malformed
rows. `entryInstants` places them on the calendar; `entryInEffect`, `latestEntryAtOrBefore`, `nextEntry` and
`eventEntry` answer the usual questions. The entry in
effect at `peakStart` decides the season and the base setpoint of that morning's pre-conditioning
(`entryEffFor`): an OFF entry means no pre-conditioning, an ON entry means pre-condition toward its mode.

An ON entry may also **keep the mode** (name none) and carry a setpoint per season, `coolTo` and `heatTo`, in place
of `temp` (with or without a mode). What such an entry means depends on the moment: the host supplies a *run
context* `{mode, season, writeMode}` — the mode the unit will run and the mode the app may send with its power ON —
and `resolveEntry(fields, rc)` turns the entry into concrete fields (`setpointFor` picks the season's setpoint). An
entry that names a mode without the pair resolves to itself. `plan` takes the run context per unit as
`opts.runContext`; without it a keep-mode entry is read in the unit's remembered mode.

`plan(cfg, state, tz, date, opts)` assembles all of the above into one printable day: segments, events with
per-unit texts ("heat +3° → 73° from 5:00"), entries and markers.

## 5. Parameters per season

**Season** comes from the mode, never the calendar: `seasonOf('HEAT') = 'heating'`, `COOL` and `DRY` are
`'cooling'`, anything else is `null` (no pre-conditioning). A unit in a mild climate may heat most of the year.

**Effective parameters** (`effectivePrecondition(cfg, unitCfg, unitState, season)`): the base comes from
`precondition.deltaF[season]` and `precondition.leadMin[season]`. A tuned value in `unitState.tuning[season]`
replaces its base and is clamped at **read time** to the current guardrails
(`deltaF ∈ [minDeltaF, min(maxDeltaF, 6)]`, `leadMin ∈ [minLeadMin, 240]`), so tightening a guardrail takes effect
at the next run with zero writes. Provenance is kept per parameter (`deltaSource`, `leadSource`), and only a
**tuned lead** is held to `optimizer.earliestStart`.

**Freeze at take.** When a run starts, the host stores `snapshotParams(...)` with the run; while the run lasts,
those frozen parameters are the only source (`activeParams`). No tuning change, guardrail edit or config edit can
retarget a held setpoint or move a running window, and every episode is measured under exactly one parameter set.

The pre-conditioning target is the base setpoint `± deltaF`, clamped to `precondition.clampF` (`heatingMax` for
heating, `coolingMin` for cooling); `tou.plan` shows that target, and a host skips the run when the clamped target
does not move in the intended direction.

## 6. Usage records

`rollupDay` reads one local day of records (one JSON object per line in a host's log; `t` in epoch seconds; a
record belongs to the log of the local date of its `t`):

| `k` | Record | Fields |
|---|---|---|
| `s` | 5-minute sample bucket of one unit | `u`, `r` mean room °F, `n` reads, `cv` covered seconds, `on` running seconds, `p` power 1/0, `m` mode, `sp` setpoint, `f` fan |
| `c` | settings change | `u`, `f` field, `o` from, `v` to, `s` source (`schedule`, `user`, `system`, `external`), `e` event id, `gap` |
| `o` | outdoor temperature | `f` °F |
| `a` | action line | `u`, `ty` type, `ac` actor, `e` event, `f`, `fr`, `to`, `res`, `ph` phase, `se` season, `par` `{deltaF, leadMin}`, … |
| `p` | tuning change | `u`, `se`, `pa`, `fr`, `to`, `s`, `id` |
| `b` / `h` | boot snapshot / boot header | unit state at boot, boot id |

`records.mirrorActivity(line)` maps an action line to its `a` record. The lines rollup reads to tell the story of a
morning are: `phase_enter` (phase `precondition` with `params`, or `shed`), `take` (the automation takes a field:
`original → applied`), `write` (`from → to`, `result: 'verified'`), `phase_exit`, and a person's `released`,
`drop` or `deferred`.

## 7. The daily rollup

Per unit and local day `d` (`rollupDay`), with `band = [comfortLowF, comfortHighF] + sensorOffsetF`:

- **On time** `onMin[tier] = Σ on/60` (fan-only buckets go to `fanMin`), `offMin[tier] = Σ (cv − on)/60`,
  `unknownMin[tier] = tierMinutes − Σ cv/60`; `coverage = Σ cv / (dayMinutes·60)`.
- **Setpoint** time-weighted over ON seconds; **room** `{min, max, mean, n}` per tier; **band minutes** inside,
  below and above the band.
- **Changes** by source, **jobs** from `write` / `retry` / `failing` / `blocked` lines.
- **Outdoor** `{min, max, mean, n, coverage}` with hourly back-fill for missing slots, plus `hdd65`, `cdd65`.
- **Episodes**: one per event of the day (below).
- `tail`: the last bucket's state, carried into the next day as `prevTail`.

Rollups are deterministic: identical inputs give identical bytes.

## 8. Episodes

One episode per unit and event. Markers are the `a` records of that event; `s` is the season sign.

| Quantity | Definition |
|---|---|
| `par` | the frozen `{deltaF, leadMin}` of the event's last `phase_enter(precondition)` line (a keep-mode entry's precondition re-planned for a new season before anything was sent logs a second one: the episode is then `replanned`, and `preStart` and the setpoint take are the last one's) |
| `T0` | median room over `[preStart − 15 min, preStart)` (for a run that turned the unit on from an entry: the scheduled setpoint) |
| `Tpk` | median room over `[peakStart − 15 min, peakStart)` |
| `dApp` | `|applied − original|` of the setpoint take |
| **rise** | `s·(Tpk − T0)`, how far the room actually moved |
| **eff** | `clamp(rise / dApp, −0.5, 1.5)`, how much of the bump the room realised |
| `reached` | `s·(Tpk − applied) ≥ −0.5` |
| **t90** | minutes from `preStart` to the first bucket with `s·(r − T0) ≥ 0.9·rise` (null when `rise < 0.3`) |
| `reachedMinBeforePeak` | minutes before `peakStart` at which the room first came within 0.5° of the target |
| `offAt`, `shedEnd` | the verified scheduler power OFF; the earliest of `peakEnd`, a release, the verified power ON, `phase_exit` |

**Drift while shed.** Points are OFF buckets (`on = 0`, `n ≥ 1`, `cv ≥ 120 s`) in `[offAt + 10 min, shedEnd)`,
`x = (t + 150 − offAt)/3600` hours (bucket midpoint), `y = r`. Ordinary least squares gives `b` (°F/h), `a`, `se_b`,
`R²`; one robust pass drops points whose residual lies more than `max(1.0, 3·1.4826·MAD)` from the median residual
and refits. `cov = 5·n / minutes(offAt + 10 min, shedEnd)`. The fit is **ok** when `n ≥ 6`, the span is at least
45 minutes, `cov ≥ 0.6`, `se_b ≤ 0.4` and the sensor is not flat.

**Sensor flags.** `flat`: 12 or more consecutive OFF buckets with an identical reading while
`|Tout − r̄| ≥ 10` and the shed lasted 60 minutes or more. `jump`: the median room in the first 10 minutes after the
unit came back on differs from the last 10 OFF minutes by 2.0°F or more (the sensor was reading stratified air).

**Comfort class** over the OFF window, with `zEdge = heating ? L : −H`:
`m = min(z) − zEdge` (heating `Tmin − L`, cooling `H − Tmax`), `violMin = 5 × #(z < zEdge)`, and

| class | when |
|---|---|
| `violated` | `violMin ≥ 10` (with any coverage) |
| `unknown` | coverage below 0.6 |
| `tight` | `m < marginF` (default 1°) |
| `comfortable` | `m ≥ comfyMarginF` (default 2°) |
| `ok` | otherwise |

**Overrides.** A person's changes during `[preStart, peakEnd + 5 min)` (from `c` records and release lines,
deduplicated) are tagged `comfortDir` when they push toward comfort (power back ON after `offAt`, a setpoint move
in the season's direction, a switch to the season's mode). An external override at the same clock time on 3 or
more of the last 7 event days is flagged `auto` (probably another automation): surfaced, not counted.

**Quality** `q`, first match wins: `dry` (entered in dry run), `forced` (a multi-split master rewrote the unit's
mode for half or more of the running time), `pre_only` (a boundary episode), `low_coverage`, `flat`, `jump`, `ok`.

**Multi-split constraint.** On a system where one outdoor unit serves several indoor units, the master's mode can
force a follower's. The host passes the constraint to `rollupDay` (`{on, master, forcing, conflict}`); the rollup
then marks forced intervals and standby minutes, and the optimizer keeps those mornings out of its evidence.

## 9. The drift model

Newton cooling in comfort coordinates, `xOut = s·Tout`:

```
dz/dt = α + β·(xOut − z)          α: internal gains (°F/h), β: loss coefficient (1/h, expected > 0)
```

`fitDriftModel(episodes)` fits it over every same-season episode of the model window (default 45 days) whose
drift fit is ok and whose sensor is neither flat nor jumpy: points `(x, y) = (s·(Tout − r̄), s·b)`, OLS
`β = Sxy/Sxx`, `α = ȳ − β·x̄`, `R²`, `σ`, `σx = √(Sxx/n)`.

**Confident ⇔ n ≥ 5 ∧ β > 0 ∧ R² ≥ 0.3 ∧ σx ≥ 2.** Without confidence the forecast rule is off and cannot veto.

**Required start level** for a peak of `D` hours with a forecast `xOut` (`requiredDelta`):

```
zTarget = zEdge + marginF
β ≥ 0.01:  z∞ = xOut + α/β ;  z0Req = z∞ + (zTarget − z∞)·e^(βD)
else:      z0Req = zTarget − (α + β·(xOut − zTarget))·D
zPre = median(s·T0) over the last 5 same-season episodes     (parameter independent: T0 precedes the bump)
eff̂  = clamp(median eff over the same, 0.3, 1.0)             (default 0.7)
Δ*   = (z0Req − zPre) / eff̂ ;   Δ*int = clamp(ceil(Δ* − 0.25), minDeltaF, maxDeltaF)
```

Worked example (heating, `β = 0.03/h`, `α = −0.05`, floor `L = 68`, `marginF = 1` so `zTarget = 69`, `zPre = 70`,
`eff̂ = 0.8`, a 3-hour peak):

- forecast 36°F: `z∞ = 34.33`, `z0Req = 34.33 + 34.67·e^0.09 = 72.27`, `Δ* = 2.83`, so **+3**.
- forecast 28°F: `z∞ = 26.33`, `z0Req = 73.02`, `Δ* = 3.78`, so **+4**.

The cooling mirror (`s = −1`, ceiling `H = 78`, forecast 95°F, `α = +0.05`) gives the same `Δ*` on `z = −room`.

## 10. The decision table

`proposeFor(ctx)` makes at most **one** parameter step per unit per analysis date (the last closed local day `D`),
applied from `applyDate` (today before `earliestStart`, else tomorrow). Evidence:

- **E** (`qualifying`): this unit's episodes in the report window (default 14 days) with the current season, a
  pre-conditioned event, not dry run, status `done` or `released`, not skipped because the room was already
  conditioned, not forced by a multi-split master, not a boundary episode. Newest first.
- **F** (`fresh`), the only evidence a step may use: episodes of E measured **after the last change**
  (`peakStart ≥ evidenceFrom`, bumped by every mutation) and **under the current parameters**
  (`par` equal to the current effective `{deltaF, leadMin}`).

Order of evaluation (first match wins):

| Step | Condition | Result |
|---|---|---|
| R4b resume | suspended and the unit ran ≥ 60 min on `D` | resume (bypasses the gates below) |
| G1 | optimizer or unit disabled, unit does not shed or pre-condition | hold `off` |
| G2 | schedule not live | hold `not_live` |
| suspended | still dormant | hold `suspended` |
| G5 | `applyDate` locked by a person's revert | hold `locked` |
| R4a dormant | no running minutes for `dormantDays` (3) full days | suspend pre-conditioning |
| G3 | no season | hold `no_season` |
| G6 | `D` already analysed | hold `already` |
| G7 | coverage of `D` below 0.6, or a failing job during the latest episode | hold `low_data` |
| **R1 breach** | `F[0]` violated the band, or was released with a comfort override during the shed | **UP** |
| **R5 overrides** | comfort-direction overrides (not `auto`) on 2 or more event days among `F[0..4]` | **UP** |
| **R3 forecast** | model confident, forecast usable, `Δ*int ≥ deltaF + 1`, and colder than any morning already handled at the current parameters | **UP** one step |
| learning | `F` is empty | hold `learning` (or `forced_by_master` when the newest morning was the master's decision) |
| **R2 comfortable** | 3 or more fresh episodes, `F[0..2]` all `comfortable` with coverage, no comfort overrides, no sensor flag, past the hysteresis and cooldowns, and no R3 veto (`confident ∧ ceil(Δ* − 0.25) ≥ deltaF`) | **DOWN** |
| otherwise | | hold with the reason (`need_n`, `tight`, `sensor`, `hysteresis`, `frozen`, `veto`, `cooldown`, `guardrail`) |

Any UP signal blocks DOWN; the rationale shown is the strongest (R1, then R5, then R3). The forecast can raise or
veto, never lower.

## 11. Steps and guardrails

`stepFor(dir, ctx, cur)` chooses the parameter:

- **UP**: if the room did not reach the target and realised less than 60 % of the bump (`!reached ∧ eff < 0.6`) and
  the lead can grow, `leadMin += 30` (start earlier); else if `deltaF + 1 ≤ maxDeltaF` and the setpoint stays
  within the band and `clampF`, `deltaF += 1`; else if the lead can grow, `leadMin += 30`; else hold `at_limit`
  with a suggestion (raise the maximum, widen the band, or opt the unit out of the shed).
- **DOWN**: if the room reached its target 45 minutes or more before the peak (median over `F[0..2]`) and
  `leadMin − 30 ≥ minLeadMin`, `leadMin −= 30` (start later); else if `deltaF − 1 ≥ minDeltaF`, `deltaF −= 1`.

`clampStep` then applies the hard limits: `deltaF ∈ [minDeltaF, maxDeltaF] ∩ [1, 6]` in steps of at most 1°;
`leadMin` on the 5-minute grid within `[minLeadMin, peakStart − earliestStart] ∩ [20, 240]`, in steps of at most
`maxStepLeadMin` (30). A step the clamp cancels becomes a `guardrail` hold.

**Observe first.** For `observeDays` (3) after the optimizer is enabled, decisions are made and logged as
proposals (mode `proposed`) but nothing changes.

**People win.** A revert locks the next apply date and starts a cooldown (`revertCooldownDays`, 3) in that
direction; two reverts in the same direction freeze it for 14 days; a reversal of direction waits
`minDaysBetweenOpposite` (3) days. An undo is possible for 10 minutes.

**Commit-time check.** The optimizer only proposes. A host applies a proposal inside its own state commit, and
re-checks it there with `tuning.check(unitState, mutation, ctx)` (refusals: `invalid`, `not_enabled`, `not_live`,
`observe`, `locked`, `already`, `cooldown`, `frozen`, `guardrail`, `superseded`, `expired`, `state`) before
`tuning.applyMutation`. Every change `proposeFor` returns passes that check against the same state (the property
tests prove it). A change is gated out of an imminent or running event (`tuning.gateOpen`), so every episode has
one unambiguous parameter set.

## 12. Explanations

Every proposal carries `rationale`, one sentence built by `explain.rationale(rule, evidence, names, tz)`, and
every hold carries `explain.holdText(code, ctx)`:

- R1_DELTA: "Den dropped to 66.9° during Wed's morning peak (floor 68°). Pre-heat +3° → +4° from today 5:00 AM."
- R1_LEAD: "Den only reached 70.1° of its 73° target by 7:00. Pre-heat now starts 4:30 (was 5:00)."
- R3: "Tomorrow 7–10 AM forecast is 36°F, colder than any recent morning. At +3° the model predicts 67.2° by 10:00, so +4°."
- R2_DELTA: "Den stayed ≥ 70.5° through the last 3 peaks, 2.5° above your floor. Trying less pre-heat: +4° → +3°."
- R5: "Den was turned back on during 2 of the last 3 morning peaks. Treating that as 'too cold': +3° → +4°."
- hold `need_n`: "Need 3 comfortable peaks at +3° (have 1)".
