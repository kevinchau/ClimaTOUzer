// config.js — a complete starting configuration for the sections the core reads. PURE: no clock, so the
// holiday years are an argument.
//
// defaultConfig({timezone = 'America/Los_Angeles', units = [], holidays = 'us-federal', years = [2026, 2027]}?) → cfg
//   units: [{id, name?, order?, shed? = true, precondition? = true, comfortLowF? = 68, comfortHighF? = 78}] — each
//   becomes a cfg.units row {id, name, order, shed, precondition, schedule: []} and an optimizer.units[id] comfort band
//   {enabled: true, comfortLowF, comfortHighF, sensorOffsetF: 0}.
//   The result (the reference app ships the same values for these sections):
//     timezone, automation {mode: 'dry-run'} (the optimizer only steps while mode is 'live'),
//     tou: the example rate table — weekdays peak 07:00–10:00 (pre-conditioned) and 17:00–20:00 (not), off-peak
//       10:00–17:00 and 20:00–23:00, super off-peak otherwise; weekends and holidays off-peak 07:00–23:00, super
//       off-peak otherwise; weekendDays [0, 6] (Sun, Sat); windows closer than mergeGapMin 30 merge into one event,
//     holidays {preset, rows} seeded for `years` (holidays.seed),
//     precondition: modes COOL/DRY/HEAT, deltaF 3 °F and leadMin 120 min for both seasons, clampF {coolingMin 65,
//       heatingMax 76}, minLeadMin 20, joinCutoffMin 10, fan 'HIGH', optimumStart 60, superOffPeak {weekend: false},
//     shed {fanOnlyMin: {cooling: 60, heating: 15}} (minutes of fan-only before a shed turns a unit off),
//     outdoor {enabled: false, sampleMin: 15}, insights {windowDays: 14, modelDays: 45},
//     optimizer: enabled false, observeDays 3, minDeltaF 1, maxDeltaF 4, earliestStart '04:30', minLeadMin 60,
//       maxStepDeltaF 1, maxStepLeadMin 30, marginF 1, comfyMarginF 2, revertCooldownDays 3,
//       minDaysBetweenOpposite 3, dormantDays 3, units {…}.
//   validate(defaultConfig(…)) reports no errors and no warnings.

import { seed } from './holidays.js'

export function defaultConfig({ timezone = 'America/Los_Angeles', units = [], holidays = 'us-federal', years = [2026, 2027] } = {}) {
  let rows = []
  for (const y of years) rows = seed({ preset: holidays, rows }, y, holidays).rows
  const list = (Array.isArray(units) ? units : []).filter((u) => u && typeof u.id === 'string' && u.id)
  return {
    schemaVersion: 1,
    rev: 1,
    timezone,
    automation: { mode: 'dry-run' },
    units: list.map((u, i) => ({
      id: u.id, name: u.name ?? u.id, order: u.order ?? i, shed: u.shed ?? true, precondition: u.precondition ?? true, schedule: [],
    })),
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
    holidays: { preset: holidays, rows },
    precondition: {
      modes: ['COOL', 'DRY', 'HEAT'],
      deltaF: { cooling: 3, heating: 3 },
      leadMin: { cooling: 120, heating: 120 },
      clampF: { coolingMin: 65, heatingMax: 76 },
      minLeadMin: 20,
      joinCutoffMin: 10,
      fan: 'HIGH',
      optimumStart: 60,
      superOffPeak: { weekend: false },
    },
    shed: { fanOnlyMin: { cooling: 60, heating: 15 } },
    outdoor: { enabled: false, sampleMin: 15 },
    insights: { windowDays: 14, modelDays: 45 },
    optimizer: {
      enabled: false,
      observeDays: 3,
      minDeltaF: 1, maxDeltaF: 4,
      earliestStart: '04:30', minLeadMin: 60,
      maxStepDeltaF: 1, maxStepLeadMin: 30,
      marginF: 1, comfyMarginF: 2,
      revertCooldownDays: 3, minDaysBetweenOpposite: 3, dormantDays: 3,
      units: Object.fromEntries(list.map((u) => [u.id, { enabled: true, comfortLowF: u.comfortLowF ?? 68, comfortHighF: u.comfortHighF ?? 78, sensorOffsetF: 0 }])),
    },
  }
}
