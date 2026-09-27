# ClimaTOUzer

**Time-of-use pre-conditioning for heat pumps: the rate model, the window math and the learning behind a scheduler
that banks cheap energy before the peak and coasts through it.**

![tests](https://img.shields.io/badge/tests-460%20passing-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933)
![license](https://img.shields.io/badge/license-MIT-blue)

Status: extracted 2026-09 from a working home app; the API may still move.

## The idea

Many utilities price electricity by the hour. A typical residential time-of-use plan charges the most on weekday
mornings and evenings (the example table in this library: peak 7 to 10 AM and 5 to 8 PM), a middle rate through the
day and late evening, and the least overnight (super off-peak). A heat pump that simply follows its thermostat buys
its most expensive kilowatt-hours exactly when people wake up and come home.

A house stores heat. Run the heat pump a little harder in the cheap hours right before a peak (say 3°F above the
setpoint from 5 AM), switch it off for the peak, and the walls, floors and air coast through the expensive window
while the room drifts back toward the comfort floor. The building is the battery. The hard part is sizing the
charge: too little and the room leaves its comfort band before the peak ends, too much and you pay for heat you
never needed.

The right charge differs per room and per day. A bedroom with one outside wall loses heat slowly, a room with big
windows loses it fast, and a frosty morning needs more than a mild one. So the library measures every morning (how
far the room rose while pre-heating, how fast it drifted while off, whether it left the band or someone turned it
back on), fits a simple heat-loss model per room, reads the forecast, and moves each room's pre-conditioning one
small, explained step at a time.

## What you get

Pure functions, zero dependencies, no clock: `now` is always an argument and every wall-clock computation goes
through an injected time zone, so results are identical on any machine.

- **Rate tables to tiers, day types and holidays.** Gap-filled tier segments (`tou.segments`, `tou.tierAt`),
  weekday / weekend / holiday day types (`tou.dayType`), and holiday presets (`us-federal`, `ca-utility-8`) with the
  observed-date rule (`holidays.generate`, `holidays.seed`).
- **Merged peak events and pre-condition windows.** `tou.events` merges peak windows closer than `mergeGapMin`;
  `tou.preconditionWindow` places the window from the lead, the merge gap after an earlier event, a 3:00 AM floor
  that keeps starts out of the daylight-saving band, and an earliest start for a tuned lead. `tou.activeEventFor`
  and `tou.nextBoundaryAfter` drive a scheduler loop. Every window is a pair of absolute instants built DST-safely
  by `makeTz`.
- **Weekend boundary events.** Optional pre-conditioning before the weekend step from super off-peak to off-peak,
  a window with nothing to shed.
- **Daily plans with entries.** Scheduled daily settings per unit (`tou.unitEntries`, `tou.entryInstants`,
  `tou.entryInEffect`, `tou.nextEntry`, `tou.entryEffFor`) and `tou.plan`, one printable day with per-unit texts.
  An On entry may keep the mode and carry a cool-to / heat-to pair; `tou.resolveEntry` turns it into concrete
  settings for the mode the unit will run, which the host supplies as a run context.
- **Effective parameters per season, frozen at take.** `tuning.effectivePrecondition` resolves the base or tuned
  Δ and lead with a read-time guardrail clamp; `tuning.snapshotParams` freezes them when a run starts so nothing can
  move a running window.
- **Episode extraction.** `rollupDay` turns a day of 5-minute samples and action lines into per-unit rollups and
  one episode per event: T0, Tpk, rise, eff, t90, reached, drift while shed, comfort class, overrides, sensor flags.
- **The drift model.** `optimizer.fitDriftModel` fits Newton cooling per room; `optimizer.requiredDelta` turns an
  outdoor forecast into the Δ the next peak needs.
- **The tuning decision table.** `proposeFor` applies R1 breach, R5 overrides, R3 forecast and R2 comfortable with
  guardrails: one step per unit per night, bounded steps and ranges, cooldowns after a person reverts, observe-only
  days, and fresh evidence only (mornings measured after the last change, under the current parameters).
- **Explainable rationale strings.** Every change carries one sentence (`explain.rationale`), every hold a short
  text (`explain.holdText`).
- **Validation and defaults.** `validate(cfg)` checks every section the library reads; `defaultConfig()` builds a
  complete starting config.

## Quick start

```sh
npm install github:kevinchau/ClimaTOUzer
```

The example builds a config, asks for today's events and a pre-heat window, then feeds three synthetic mornings to
the rollup and the optimizer. It lives in [`examples/quickstart.js`](examples/quickstart.js).

```js
import { defaultConfig, validate, makeTz, tou, tuning, records, rollupDay, proposeFor } from 'climatouzer'

// 1. A config with the default rate table (weekday peaks 7-10 AM and 5-8 PM) and one heat pump.
const cfg = defaultConfig({ timezone: 'America/Los_Angeles', units: [{ id: 'den', name: 'Den' }] })
cfg.automation.mode = 'live' // the optimizer only tunes a live schedule
cfg.optimizer.enabled = true
console.log('config valid:', validate(cfg).errors.length === 0)

// 2. Today's peak events and the den's pre-heat window.
const tz = makeTz(cfg.timezone)
const today = '2026-10-08' // a Thursday
const hm = (ms) => tz.formatLocal(ms, 'hmm')
for (const e of tou.events(cfg, tz, today)) {
  console.log(`peak ${e.id}: ${hm(e.peakStart)}-${hm(e.peakEnd)}, pre-condition ${e.precondition}`)
}
const morning = tou.events(cfg, tz, today).find((e) => e.precondition)
const eff = tuning.effectivePrecondition(cfg, cfg.units[0], {}, 'heating')
const win = tou.preconditionWindow(cfg, tz, morning, 'heating', eff)
console.log(`pre-heat ${hm(win.preStart)}-${hm(win.peakStart)}: +${eff.deltaF}°F over ${eff.leadMin} min`)

// 3. Three synthetic mornings: 5-minute samples plus the scheduler's action lines. The den is pre-heated
//    70 -> 73°F from 5:00, switched off at 7:00, and sags below its 68°F comfort floor before 10:00.
function dayRecords(date) {
  const at = (hhmm, sec = 0) => Math.floor(tz.zonedToInstant(date, hhmm) / 1000) + sec
  const out = []
  for (let t = at('00:00'); t < at('24:00'); t += 300) {
    const h = (t - at('00:00')) / 3600
    const off = h >= 7 && h < 10
    const room = h < 5 ? 70 : h < 7 ? 70 + 1.5 * (h - 5) : off ? 73 - 2.1 * (h - 7) : 70
    out.push({ k: 's', t, u: 'den', r: Math.round(room * 10) / 10, n: 15, cv: 300, on: off ? 0 : 300,
      p: off ? 0 : 1, m: 'HEAT', sp: h >= 5 && h < 7 ? 73 : 70, f: 'AUTO' })
    if (t % 3600 === 0) out.push({ k: 'o', t, f: 38 }) // outdoor °F
  }
  const line = (hhmm, sec, fields) => records.mirrorActivity({ ts: at(hhmm, sec) * 1000, unit: 'den',
    event: `${date}@07:00`, actor: 'scheduler', ...fields })
  out.push(
    line('05:00', 0, { type: 'phase_enter', phase: 'precondition', season: 'heating', params: { deltaF: 3, leadMin: 120 } }),
    line('05:00', 1, { type: 'take', field: 'temp', original: 70, applied: 73 }),
    line('07:00', 0, { type: 'phase_enter', phase: 'shed', season: 'heating' }),
    line('07:00', 1, { type: 'take', field: 'power', original: 'ON', applied: 'OFF' }),
    line('07:00', 3, { type: 'write', field: 'power', from: 'ON', to: 'OFF', result: 'verified' }),
    line('10:00', 0, { type: 'phase_exit', phase: 'shed', reason: 'ended' }),
    line('10:00', 3, { type: 'write', field: 'power', from: 'OFF', to: 'ON', result: 'verified' }),
  )
  return out
}

// 4. Roll the days up into episodes, then ask the optimizer for tonight's step.
const rollups = {}
for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) {
  rollups[date] = await rollupDay({ date, records: dayRecords(date), cfg, tz })
}
const [ep] = rollups['2026-10-07'].units.den.episodes
console.log(`Wed: rise ${ep.pre.rise}°F, eff ${ep.pre.eff}, drift ${ep.shed.drift.b}°F/h, low ${ep.shed.Tmin}°F: ${ep.shed.class}`)

const state = {
  scheduleEnabled: true,
  insights: { optimizerEnabledAt: '2026-09-28T12:00:00Z' },
  units: { den: { tuning: tuning.emptyTuning(), auto: { phase: 'idle' } } },
}
const p = proposeFor({ cfg, unitId: 'den', state, rollups, tz, now: tz.zonedToInstant(today, '01:30') })
console.log(`${p.mode}: ${p.change.rule} ${p.change.param} ${p.change.from} -> ${p.change.to}`)
console.log(p.change.rationale)
```

Output (`node examples/quickstart.js`, checked by the test suite):

```text
config valid: true
peak 2026-10-08@07:00: 7:00-10:00, pre-condition true
peak 2026-10-08@17:00: 17:00-20:00, pre-condition false
pre-heat 5:00-7:00: +3°F over 120 min
Wed: rise 2.8°F, eff 0.93, drift -2.1°F/h, low 66.9°F: violated
change: R1_DELTA deltaF 3 -> 4
Den dropped to 66.9° during Wed's morning peak (floor 68°). Pre-heat +3° → +4° from today 5:00 AM.
```

The pre-heat raised the den 2.8°F (93 % of the 3°F bump), but with the heat off it lost 2.1°F an hour and bottomed
out at 66.9°F, under its 68°F floor: a comfort breach (R1). The optimizer answers with one step, a stronger
pre-heat for the next morning, and says why.

## How the learning works

Each morning becomes an **episode**. In comfort coordinates (`s = +1` heating, `−1` cooling; `z = s·room`, so up
is always "more comfortable"):

| Quantity | Definition |
|---|---|
| T0, Tpk | median room over the 15 minutes before the pre-heat starts, and before the peak starts |
| rise | `s·(Tpk − T0)`: how far the room moved |
| eff | `clamp(rise / dApp, −0.5, 1.5)`: the share of the setpoint bump `dApp` the room realised |
| t90 | minutes from the pre-heat start until the room covered 90 % of its rise |
| drift b | OLS slope of the room over the OFF window `[offAt + 10 min, shedEnd)` in °F/h, one robust pass (drop points more than `max(1.0, 3·1.4826·MAD)` from the median residual, refit); ok when `n ≥ 6`, span ≥ 45 min, coverage ≥ 0.6, `se ≤ 0.4` |
| comfort class | `violated` (10 min or more outside the band), else `unknown` (coverage < 0.6), `tight` (margin < 1°), `comfortable` (margin ≥ 2°) or `ok` |
| drift model | `dz/dt = α + β·(xOut − z)`, Newton cooling, fit per room over 45 days of mornings: points `(s·(Tout − r̄), s·b)` |
| confidence gate | `n ≥ 5 ∧ β > 0 ∧ R² ≥ 0.3 ∧ σx ≥ 2`; below it the forecast rule is off |
| required Δ | `z∞ = xOut + α/β`, `z0Req = z∞ + (zEdge + margin − z∞)·e^(βD)`, `Δ* = (z0Req − zPre)/eff̂`, rounded `ceil(Δ* − 0.25)` into `[minΔ, maxΔ]` |

**Decision precedence** (first match wins; at most one step per unit per night):

1. resume a unit that was paused as dormant and is in use again;
2. hold for the gates: auto-tune off, schedule not live, paused, date locked by a person's revert;
3. pause pre-conditioning for a unit that has been off for 3 days;
4. hold when there is no season, the day was already analysed, or yesterday's data is thin;
5. **UP** on R1 breach (the newest fresh morning left the band, or someone turned the room back on during the shed),
   then R5 overrides (comfort-direction changes on 2 of the last 5 mornings), then R3 forecast (the model is
   confident and tomorrow is colder than any morning already handled);
6. hold `learning` while there is no fresh evidence;
7. **DOWN** on R2 comfortable (3 fresh mornings in a row with 2° or more to spare, no overrides, and the forecast
   does not veto);
8. otherwise hold, with the reason.

**Guardrails.** A step changes one parameter by at most 1°F or 30 minutes; Δ stays within `[minDeltaF, maxDeltaF]`
(1 to 4 by default, never beyond 1 to 6) and the lead never starts before `earliestStart`. Only fresh evidence
counts: mornings measured after the last change and under the current parameters. The first days after enabling
are observe-only. A person's revert locks the next morning and starts a cooldown in that direction; two reverts
freeze it for 14 days. The forecast can raise Δ or veto a decrease, never lower it. Every proposal passes the same
commit-time check (`tuning.check`) a host runs before applying it.

The full model, with the rollup math, every episode field and the worked examples, is in
[docs/model.md](docs/model.md).

## Used by

ClimaTOUzer's private home app runs this library in production against six Daikin heat pumps controlled through
Faikin modules (small boards that put a Daikin indoor unit on the local network); a Rheem heat-pump water heater
and Mysa thermostats are next. The app owns everything around the library: device I/O and write verification, the
scheduler loop, persistence, the dashboard and notifications. The library is the part that decides.

## API reference

Everything is importable from the package root: the entry points flat, each module as a namespace
(`import { tou, optimizer } from 'climatouzer'`), or a module by path (`climatouzer/tou`). Instants are epoch
milliseconds unless noted; `tz` is a `makeTz()` object; each file's header documents the full contract.

**Entry points** (package root)

| Export | Returns |
|---|---|
| `defaultConfig({timezone, units, holidays, years})` | a complete config: the example rate table, us-federal holidays for `years`, pre-conditioning Δ 3°F and lead 120 min, guardrails, one comfort band per unit |
| `validate(cfg)` | `{errors, warnings}` for every section the library reads |
| `makeTz(timezone)` | the time-zone object every other call takes |
| `effectivePrecondition`, `seasonOf` | from `tuning` |
| `rollupDay` | from `rollup` |
| `fitDriftModel`, `proposeFor` | from `optimizer` |
| `rationale` | from `explain` |

**tou**: rate model, events, windows, entries, plans

| Function | Returns |
|---|---|
| `dayType(cfg, date)` | `'weekday'`, `'weekend'` or `'holiday'` |
| `segments(cfg, tz, date)` | gap-filled tier segments `[{tier, start, end, localStart, localEnd}]` |
| `events(cfg, tz, date)` | the date's events `[{id, date, kind, peakStart, peakEnd, precondition, windows}]` |
| `firstPreconditionDate(cfg, tz, fromDate, maxDays = 8)` | the first local date with a pre-conditioned event, or null |
| `preconditionWindow(cfg, tz, event, season, eff?)` | `{preStart, peakStart, leadMin, season}` or null |
| `dryOutUntilFor(cfg, event, season, from?)` | the fan-only dry-out deadline, or null |
| `tierAt(cfg, tz, now)` | `{kind, since, until}` |
| `nextBoundaryAfter(cfg, tz, now)` | the next instant at which the schedule can change |
| `activeEventFor(cfg, tz, unitCfg, now, eff?)` | `{event, phase: 'precondition' \| 'shed', preStart}` or null |
| `eventOverlapping(cfg, tz, unitCfg, from, to, eff?)` | true when a participating event overlaps `[from, to]` |
| `foldEventFor(cfg, tz, unitCfg, at, eff?)` | the event whose window contains an entry instant, or null |
| `unitEntries(unitCfg)` | the unit's daily entries, normalised and sorted |
| `entryInstants(cfg, tz, unitCfg, date)` | that date's entries as instants `[{key, at, date, hhmm, days, fields}]` |
| `latestEntryAtOrBefore(cfg, tz, unitCfg, instant, armedAt?)` | the latest entry at or before `instant`, or null |
| `entryInEffect(cfg, tz, unitCfg, now, armedAt?)` | the entry in effect at `now`, or null |
| `nextEntry(cfg, tz, unitCfg, now, armedAt?)` | the next entry within 24 hours, or null |
| `eventEntry(cfg, tz, unitCfg, event, preStart, now, armedAt?)` | the entry that sets an event's target, or null |
| `armedAtOf(state, unitId)` | when the unit's schedule was last armed, or −∞ |
| `entryEffFor(cfg, tz, unitCfg, unitState, liveMode, opts?)` | `(event) => eff`, per-event parameters for `activeEventFor` |
| `keepsMode(fields)`, `hasPair(fields)`, `resolves(fields)` | an On entry that keeps the mode (names none); one that carries `coolTo`/`heatTo`; either |
| `setpointFor(fields, season)` | the setpoint an entry gives a season: `temp`, else `coolTo` (cooling) / `heatTo` (heating) |
| `resolveEntry(fields, rc)` | the concrete `{power, mode?, temp?, fan?}` an entry means for a run context `{mode, season, writeMode}` (identity for an entry that names a mode without the pair) |
| `entryResolution(fields, rc)` | `{season, mode?, temp?}`, the resolution as plans and activity lines show it |
| `plan(cfg, state, tz, date, opts?)` | one printable day: segments, events with per-unit texts, entries, markers (`opts.runContext` resolves entries that keep the mode) |

**tuning**: parameters, snapshots, the commit-time check

| Function | Returns |
|---|---|
| `seasonOf(mode)` | `'heating'` (HEAT), `'cooling'` (COOL, DRY) or null |
| `effectivePrecondition(cfg, unitCfg, unitState, season)` | `{season, deltaF, leadMin, clampF, earliestStart, suspended, source, deltaSource, leadSource, clampedBy}` |
| `snapshotParams(cfg, unitCfg, unitState, mode, opts?)` | the parameters to freeze when a run starts |
| `activeParams(cfg, unitCfg, unitState, live)` | the frozen parameters while engaged, else the effective ones |
| `currentValue(cfg, unitCfg, unitState, season, param)` | the current effective `deltaF`, `leadMin` or `suspended` |
| `guardrails(cfg)` | `{minDeltaF, maxDeltaF, minLeadMin, maxLeadMin, earliestStart, …}` with defaults applied |
| `preconditionPeakStartMin(cfg)` | the earliest pre-conditioned peak start in minutes, or null |
| `optimumLead({season, room, target, rateFph, capMin, baseLeadMin})` | `{leadMin, source, need}`: how early to start a unit that is off |
| `nextApplyDate(cfg, tz, now)` | the first local date a change made now can affect |
| `observeInfo({cfg, state, unitState, tz, now, applyDate})` | `{enabledAt, liveFrom, applyDate, observe, daysLeft}` |
| `gateOpen({cfg, tz, unitCfg, unitState, now, effMax})` | `{open, until, reason, eventId}`: may a change apply now |
| `check(unitState, mutation, ctx)` | `'ok'` or a refusal code from `REFUSALS` |
| `applyMutation(tuning, mutation, now, ctx?)` | applies a checked mutation in place, returns a summary |
| `emptyTuning()`, `normalizeTuning(t)` | the per-unit tuning state |
| `toPending(mutation, {now, reason, actor})` | a gated (pending) entry |
| `pruneTuning(tuning, today, tz?)` | drops expired locks, reverts and cooldowns; true when anything changed |
| `dirOf(from, to)`, `mutationSeasons(m)` | `'up'`, `'down'` or null; the seasons a mutation touches |
| `validateTuningCfg(cfg)` | the optimizer section's errors |

Constants: `SEASONS`, `PARAMS`, `KINDS`, `REFUSALS`, `UNDO_WINDOW_MS`, `HISTORY_MAX`, `REVERTS_MAX`, `FREEZE_DAYS`,
`PRUNE_DAYS`.

**rollup**: daily rollups and episodes

| Function | Returns |
|---|---|
| `rollupDay({date, records, cfg, tz, prevTail?, outdoorFill?, builtAt?, constraint?})` | a Promise of the DailyRollup: per-unit minutes by tier, room, band, setpoint, changes, jobs, episodes, tail |
| `buildEpisodes({unitId, buckets, changes, markers, events, band, outdoor, tz, …})` | the episodes of one unit and day |
| `classify(points, band, season, marginF?, comfyMarginF?, cov?)` | `{class, m, violMin, Tmin, Tmax}` |
| `driftFit(points, offAt, opts?)` | `{b, a, n, se, r2, cov, dropped, ok}` or null |
| `sensorFlags(points, Tout, onAt, bucketsAfterOn, opts?)` | `{flat, jump}` |
| `forcedIntervals({buckets, markers, masterBuckets, masterId, prevTail, start, end})` | `{intervals, open}`: when a multi-split master forced the unit's mode |

Constant: `ROLLUP_V`.

**optimizer**: the drift model and the decision table

| Function | Returns |
|---|---|
| `proposeFor(ctx)` | `{unit, season, observe, mode: 'change' \| 'proposed' \| 'hold' \| 'guardrail', hold, signals, change, suggestion, model}` |
| `buildContext(input)` | the normalised context every helper shares |
| `detectSeason(ctx)` | the unit's current season, or null |
| `qualifying(ctx, season)` | usable episodes, newest first |
| `fresh(ctx, season, eps?)` | the qualifying episodes measured after the last change under the current parameters |
| `forcedByMaster(ep)` | the forced interval that disqualifies an episode, or null |
| `fitDriftModel(episodes)` | `{kind, confident, alpha, beta, r2, n, sigma, sigmaX, xMean, points}` |
| `requiredDelta({model, forecastXOut, season, band, marginF, hours, zPre, effHat, guardrails, curDeltaF})` | `{deltaStar, deltaInt, deltaCeil, z0Req, predEnd, explain}` or null |
| `realisation(ctx, season, preFromOff?)` | `{zPre, effHat, events}` |
| `stepFor(dir, ctx, cur)` | `{param, from, to}` or `{hold}` |
| `clampStep(cur, next, guardrails, peakStartMin)` | `{param, from, to}` or null when the limits cancel the step |
| `proposeRevert(args)`, `proposeUndo(args)`, `proposeCancel(args)`, `proposeReset(args)` | `{ok, code, reason, effect, mutation, message, undoUntil?}` |
| `baseResets(prevCfg, nextCfg, state, {tz, now})` | the resets owed when a base Δ or lead changed |

Constants: `HOLD_CODES`, `RULES`, `CHANGE_PARAMS`.

**stats**: small robust statistics (non-finite entries ignored, null for no answer)

| Function | Returns |
|---|---|
| `mean(a)`, `median(a)`, `quantile(a, q)`, `mad(a)`, `sum(a)`, `minMax(a)` | a number, `{min, max}`, or null |
| `ols(xs, ys)` | `{a, b, n, xMean, yMean, sxx, sxy, syy, sse, se, sigma, r2}` or null |
| `robustOls(xs, ys, {floorF, k})` | `ols` plus `{dropped, droppedIdx}` after one robust pass, or null |
| `pearson(xs, ys)` | r, or null |
| `interp(points, t)`, `meanOver(points, t0, t1, {full})` | linear interpolation; time-weighted mean |
| `bucketStart(t, step)`, `bucketMeans(points, t0, t1, step)`, `groupMeans(values, size)` | bucketing helpers |
| `round(x, digits)`, `clamp(x, lo, hi)`, `stableStringify(obj, {digits})` | helpers; byte-stable JSON |

Constant: `BUCKET_SEC` (300).

**tz**: time-zone arithmetic

| Function | Returns |
|---|---|
| `makeTz(timezone)` | `{timezone, localParts(ms), offsetAt(ms), zonedToInstant(date, hhmm), addDays, formatLocal(ms, preset), dayBounds(date), selfTest()}` |
| `parseDate(date)` | `{y, m, d}`; throws on an impossible date |
| `isValidDate(date)`, `isValidTimezone(timezone)` | boolean |
| `addDays(date, n)`, `dowOf(date)` | a calendar date string; 0 (Sunday) to 6 |
| `hhmmToMin(hhmm)`, `minToHHMM(min)` | `'HH:MM'` to minutes and back |

**holidays**

| Function | Returns |
|---|---|
| `generate(preset, year)` | the rows whose (observed) date falls in `year` |
| `seed(holidaysCfg, year, preset?)` | `{rows, added}`: merged without duplicates, user rows untouched |
| `isHoliday(holidaysCfg, date)` | the row, or null |
| `missingYearWarning(holidaysCfg, today)` | a warning when the next 60 days reach a year with no rows, or null |

Constants: `PRESETS`, `PRESET_LABELS`.

**explain**, **labels**, **records**

| Function | Returns |
|---|---|
| `explain.rationale(rule, evidence, names?, tz?)` | one sentence for R1_DELTA, R1_LEAD, R5, R3, R2_DELTA, R2_LEAD, R4A, R4B, RESET, REVERT |
| `explain.holdText(code, ctx?)` | the short text of a hold code |
| `explain.changeSummary({season, param, from, to, peakStartMin})` | "Pre-heat +3° → +4°" |
| `explain.paramLabel`, `valueLabel`, `deltaLabel`, `startLabel`, `clockLabel`, `temp`, `num` | "+4° from 5:00", "4:30", "66.5°" |
| `explain.seasonWords(season)`, `nameOf(names, unitId)`, `plural(word, n)` | wording helpers |
| `labels.tierLabel`, `modeLabel`, `fanLabel` | "Super off-peak", "Heat", "Medium (auto)" |
| `labels.settingLabel(fields, opts?)`, `entryLabel(fields, opts?)`, `daysLabel(days)` | "Heat 70° · Low", "On · Heat 70° · Low", "weekdays"; `opts.season` words an entry that keeps the mode or carries `coolTo`/`heatTo`: "heat to 68°", "cool to 74° / heat to 68°", "keep mode" |
| `records.mirrorActivity(entry, nowMs)` | the `a` record of an action line, or null |

Constants: `labels.TIER_LABELS`, `MODE_LABELS`, `FAN_LABELS`; `records.RECORD_KINDS`, `MIRRORED_TYPES`.

**validation**

| Function | Returns |
|---|---|
| `validate(cfg)` | `{errors, warnings}` over timezone, units, tou, holidays, precondition, shed.fanOnlyMin, optimizer |
| `validateOptimizer(cfg)` | the optimizer section's errors |
| `dayTypeOf({weekendDays, holidayDates}, date)` | `'weekday'`, `'weekend'` or `'holiday'` |
| `entryOnDay(days, dayType)`, `daysOverlap(a, b)` | the day rules of daily entries |
| `offPeakBoundaries(list)` | the starts of off-peak segments that follow super off-peak |
| `checkTou`, `checkHolidays`, `checkPrecondition`, `checkFanOnly`, `checkOptimizer`, `checkLeadRoom`, `tableEvents` | section checkers for a host that validates more sections of its own |
| `collector`, `num`, `bool`, `oneOf`, `hhmm`, `toMin`, `clock`, `validDate`, `validTimezone`, `isObj`, `isNum` | the building blocks of those checkers |

Constants: `TIERS`, `PRECONDITION_MODES`, `PRECONDITION_FANS`, `HOLIDAY_PRESETS`, `ENTRY_DAYS`, `DST_LO`, `DST_HI`.

## Testing

```sh
npm test            # node --test test/*.test.js
```

460 tests, no network, no files written. Every suite that touches wall-clock time re-runs
itself under `TZ=UTC` and `TZ=Asia/Tokyo` and must pass unchanged. Beyond the unit tests:

- **Property suites.** The optimizer runs 2 000 seeded contexts (plus 500 focused on the forecast rule), each in
  heating and in its mirrored cooling twin, with the weekend option on and off. Every run must stay in scope (only
  Δ, lead or the pause), within every guardrail, deterministic and non-mutating; every change must pass
  `tuning.check` against the same state and move exactly to its `to`; the forecast must never cause a decrease;
  heating and cooling must decide identically; boundary episodes must never be evidence. The tuning suite runs 2 000
  seeded contexts for the parameter bounds and the window's earliest start, heating and cooling mirrored.
- **A generated world.** `test/helpers/usage-gen.js` simulates rooms with Newton cooling, an engine that
  pre-conditions and sheds, sensor noise and quirks (flat, jumpy), outages, overrides and dry runs, and records
  exactly what a real usage log would. The rollup and optimizer suites run on it end to end, and a golden day is
  pinned byte for byte.
- **DST days.** Both 2026 transitions: 23-hour and 25-hour days, windows, rollups and apply dates.
- **Purity.** Every module imports only its siblings and never reads the clock, the process or randomness.
- **The README.** The quick start above is run and its output compared with this file, and every export must
  appear in the API reference.

## License

MIT, see [LICENSE](LICENSE).
