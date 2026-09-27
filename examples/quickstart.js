import { defaultConfig, validate, makeTz, tou, tuning, records, rollupDay, proposeFor } from '../index.js'

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
