// climatouzer — time-of-use pre-conditioning for heat pumps: the rate model, the window math and the learning.
// Zero dependencies, Node ≥ 20, ES modules. Every module is PURE (no I/O, no clock: `now` is always an argument and
// wall-clock math goes through an injected `tz` from makeTz), so results never depend on the process time zone.
//
//   import { defaultConfig, validate, makeTz, tou, rollupDay, proposeFor } from 'climatouzer'
//
// Entry points (re-exported flat):
//   defaultConfig({timezone, units, holidays, years}) → a complete config (config.js)
//   validate(cfg) → {errors, warnings} for every section the core reads (validate.js)
//   makeTz(timezone) → the DST-safe clock arithmetic every other call takes as `tz` (tz.js)
//   effectivePrecondition(cfg, unitCfg, unitState, season) → the Δ/lead a unit pre-conditions with (tuning.js)
//   seasonOf(mode) → 'heating' | 'cooling' | null (tuning.js)
//   rollupDay({date, records, cfg, tz, prevTail?, outdoorFill?, builtAt?, constraint?}) → DailyRollup (rollup.js)
//   fitDriftModel(episodes) → the drift model of a unit's shed windows (optimizer.js)
//   proposeFor(ctx) → one guarded tuning proposal (or a hold) per unit and analysis date (optimizer.js)
//   rationale(rule, evidence, names?, tz?) → the one-sentence explanation of a change (explain.js)
//
// Namespaces (every export of the module; each file's header documents its contract):
//   tou         rate tables → tiers, day types, merged peak events, pre-condition windows, weekend boundary events,
//               daily scheduled entries, the daily plan
//   holidays    holiday presets (us-federal, ca-utility-8) and rows
//   tz          time-zone arithmetic: local parts, zoned instants across DST, day bounds, labels
//   tuning      effective parameters per season, freeze-at-take snapshots, the apply gate, check/apply of mutations
//   rollup      daily usage rollups and peak-episode extraction (rise, eff, t90, drift, comfort class, overrides)
//   optimizer   the drift model, the R1–R5 decision table, guardrailed steps, proposals, reverts/undo/reset
//   stats       small robust statistics (mean, median, MAD, OLS, one-pass robust OLS, interpolation)
//   explain     rationale sentences, hold texts and parameter labels
//   labels      tier / mode / fan / setting labels
//   records     the usage-record format rollupDay reads and the action-line → `a` record mirror
//   validation  the validators, section checkers and calendar helpers (dayTypeOf, entryOnDay, offPeakBoundaries)

export * as tou from './tou.js'
export * as holidays from './holidays.js'
export * as tz from './tz.js'
export * as tuning from './tuning.js'
export * as rollup from './rollup.js'
export * as optimizer from './optimizer.js'
export * as stats from './stats.js'
export * as explain from './explain.js'
export * as labels from './labels.js'
export * as records from './records.js'
export * as validation from './validate.js'

export { defaultConfig } from './config.js'
export { validate } from './validate.js'
export { makeTz } from './tz.js'
export { effectivePrecondition, seasonOf } from './tuning.js'
export { rollupDay } from './rollup.js'
export { fitDriftModel, proposeFor } from './optimizer.js'
export { rationale } from './explain.js'
