// test/helpers/config.js — the configuration the core suites and the usage generator start from: the spec §3.1 +
// addendum §2.10 defaults of every section the core reads, with NO units (a suite or genDays adds its own fixture
// units, and genDays gives each one an optimizer comfort band). Timezone America/Los_Angeles; the example rate table
// (weekday peaks 07:00–10:00 with pre-conditioning and 17:00–20:00 without, off-peak 10:00–17:00 and 20:00–23:00,
// super off-peak otherwise; weekends and holidays off-peak 07:00–23:00); a fixed list of 2026 holiday rows.

export function specDefaultConfig() {
  return {
    schemaVersion: 1,
    rev: 1,
    timezone: 'America/Los_Angeles',
    automation: { mode: 'dry-run' },
    units: [],
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
    holidays: {
      preset: 'us-federal',
      rows: [
        { date: '2026-10-12', name: 'Columbus Day', observed: false, source: 'preset' },
        { date: '2026-11-11', name: 'Veterans Day', observed: false, source: 'preset' },
        { date: '2026-11-26', name: 'Thanksgiving Day', observed: false, source: 'preset' },
        { date: '2026-12-25', name: 'Christmas Day', observed: false, source: 'preset' },
        { date: '2027-01-01', name: "New Year's Day", observed: false, source: 'preset' },
      ],
    },
    precondition: {
      modes: ['COOL', 'DRY', 'HEAT'],
      deltaF: { cooling: 3, heating: 3 },
      leadMin: { cooling: 120, heating: 120 },
      clampF: { coolingMin: 65, heatingMax: 76 },
      minLeadMin: 20,
      joinCutoffMin: 10,
    },
    shed: { minRemainingMin: 15, restoreStaggerSec: 20, minDwellSec: 180 },
    device: { pollSec: 20, tempToleranceF: 0.6, deviationMinGapSec: 15 },
    outdoor: { enabled: false, sampleMin: 15 },
    insights: { runAt: '01:30', windowDays: 14, modelDays: 45, reportKeepDays: 60 },
    optimizer: {
      enabled: false, observeDays: 3, minDeltaF: 1, maxDeltaF: 4, earliestStart: '04:30', minLeadMin: 60, maxStepDeltaF: 1,
      maxStepLeadMin: 30, marginF: 1, comfyMarginF: 2, revertCooldownDays: 3, minDaysBetweenOpposite: 3, dormantDays: 3,
      units: {},
    },
  }
}
