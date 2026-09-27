// test/dst.test.js — the rate model and the rollup across both 2026 DST days in America/Los_Angeles
// (addendum §4.2, §8.2 "dst.test.js"; spec §5.1):
//   2026-11-01 (fall back, 25 h): dayMinutes 1500, on + off + unknown = 1500 per unit, the samples of both 01:xx
//     hours belong to that one local date, in time order.
//   2026-03-08 (spring forward, 23 h): dayMinutes 1380, no 02:xx samples; zonedToInstant windows (tier segments, the
//     next weekday's pre-heat window, a tuned lead held to earliestStart, nextApplyDate).
// Days come from the reference recorder of test/helpers/usage-gen.js. The suite re-runs itself under process TZ=UTC and
// TZ=Asia/Tokyo (logic must never use process-local getters).
import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { genDays } from './helpers/usage-gen.js'
import { specDefaultConfig } from './helpers/config.js'
import { rollupDay } from '../rollup.js'
import { makeTz } from '../tz.js'
import * as tou from '../tou.js'
import * as tuning from '../tuning.js'

const SELF = fileURLToPath(import.meta.url)
const CHILD = process.env.FK_TZ_CHILD === '1'

if (!CHILD) {
  for (const zone of ['UTC', 'Asia/Tokyo']) {
    test(`dst suite passes with process TZ=${zone}`, () => {
      const env = { ...process.env, TZ: zone, FK_TZ_CHILD: '1' }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, ['--test', SELF], { env, encoding: 'utf8', timeout: 240000 })
      assert.equal(r.status, 0, `child under TZ=${zone} failed:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /\bfail 0\b/)
    })
  }
}

const tz = makeTz('America/Los_Angeles')
const Z = (s) => Date.parse(s)
const at = (date, hhmm) => tz.zonedToInstant(date, hhmm)
const iso = (ms) => new Date(ms).toISOString()

const OFFICE = { id: 'office', name: 'Office', mode: 'HEAT', sp: 70, par: { deltaF: 3, leadMin: 120 }, thermal: { alpha: 0.4, beta: 0.05, heatFph: 5 } }
const KITCHEN = { id: 'kitchen', name: 'Kitchen', mode: 'COOL', sp: 74, par: { deltaF: 3, leadMin: 120 }, thermal: { alpha: -0.4, beta: 0.05, heatFph: 5 } }

function baseCfg() {
  const c = specDefaultConfig()
  c.optimizer.units = {}
  return c
}

/** One generated DST day through the reference recorder → {g, cfg, recs}. */
async function genDay(date, units = [OFFICE, KITCHEN]) {
  const g = await genDays({ recorder: 'reference', cfg: baseCfg(), start: date, days: 1, seed: 3, outdoor: () => 45, units })
  return { g, cfg: g.cfg, recs: g.byDate[date] ?? [] }
}

// ───────────────────────────── samples + rollup on the DST days ─────────────────────────────

describe('2026-11-01 — fall back (25 h day)', () => {
  it('dayMinutes 1500; on + off + unknown = 1500 per unit; both 01:xx hours in the one local date, in time order', async () => {
    const { g, cfg, recs } = await genDay('2026-11-01')
    assert.deepEqual(Object.keys(g.byDate), ['2026-11-01'])
    const start = at('2026-11-01', '00:00') / 1000
    const end = at('2026-11-02', '00:00') / 1000
    assert.equal(end - start, 25 * 3600)
    for (const u of ['office', 'kitchen']) {
      const s = recs.filter((r) => r.k === 's' && r.u === u)
      assert.ok(s.every((r) => r.t >= start && r.t < end), `${u}: every sample belongs to the local day`)
      for (let i = 1; i < s.length; i++) assert.ok(s[i].t > s[i - 1].t, `${u}: samples in time order`)
      assert.equal(s.length, 300, `${u}: 1500 min / 5`)
      const oneAm = s.filter((r) => tz.localParts(r.t * 1000).hour === 1)
      assert.equal(oneAm.length, 24, `${u}: 12 buckets in EACH of the two 01:xx hours`)
      assert.equal(oneAm.filter((r) => tz.offsetAt(r.t * 1000) === -420).length, 12, 'first 01:xx hour (PDT)')
      assert.equal(oneAm.filter((r) => tz.offsetAt(r.t * 1000) === -480).length, 12, 'second 01:xx hour (PST)')
    }
    const r = await rollupDay({ date: '2026-11-01', records: recs, cfg, tz, builtAt: '2026-11-02T09:30:00.000Z' })
    assert.equal(r.dayMinutes, 1500)
    for (const u of ['office', 'kitchen']) {
      const x = r.units[u]
      const sum = x.onMin.total + x.offMin.total + x.unknownMin.total
      assert.ok(Math.abs(sum - 1500) <= 0.5, `${u}: on ${x.onMin.total} + off ${x.offMin.total} + unknown ${x.unknownMin.total} = ${sum}`)
      assert.ok(x.coverage > 0.98)
    }
  })
})

describe('2026-03-08 — spring forward (23 h day)', () => {
  it('dayMinutes 1380; on + off + unknown = 1380 per unit; no 02:xx samples', async () => {
    const { cfg, recs } = await genDay('2026-03-08')
    for (const u of ['office', 'kitchen']) {
      const s = recs.filter((r) => r.k === 's' && r.u === u)
      assert.equal(s.length, 276, `${u}: 1380 min / 5`)
      assert.equal(s.filter((r) => tz.localParts(r.t * 1000).hour === 2).length, 0)
    }
    const r = await rollupDay({ date: '2026-03-08', records: recs, cfg, tz, builtAt: '2026-03-09T09:30:00.000Z' })
    assert.equal(r.dayMinutes, 1380)
    for (const u of ['office', 'kitchen']) {
      const x = r.units[u]
      const sum = x.onMin.total + x.offMin.total + x.unknownMin.total
      assert.ok(Math.abs(sum - 1380) <= 0.5, `${u}: ${sum}`)
    }
  })

  it('zonedToInstant windows: tier segments, the next weekday\'s pre-heat window, nextApplyDate', () => {
    const cfg = baseCfg()
    const seg = (date) => tou.segments(cfg, tz, date).map((s) => [s.tier, iso(s.start), iso(s.end)])
    assert.deepEqual(seg('2026-03-08'), [
      ['super_off_peak', '2026-03-08T08:00:00.000Z', '2026-03-08T14:00:00.000Z'], // 6 h (02:00 does not exist)
      ['off_peak', '2026-03-08T14:00:00.000Z', '2026-03-09T06:00:00.000Z'],
      ['super_off_peak', '2026-03-09T06:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ])
    assert.deepEqual(seg('2026-11-01'), [
      ['super_off_peak', '2026-11-01T07:00:00.000Z', '2026-11-01T15:00:00.000Z'], // 8 h (01:xx twice)
      ['off_peak', '2026-11-01T15:00:00.000Z', '2026-11-02T07:00:00.000Z'],
      ['super_off_peak', '2026-11-02T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
    ])
    for (const [date, pre, peak] of [['2026-03-09', '2026-03-09T12:00:00.000Z', '2026-03-09T14:00:00.000Z'], ['2026-11-02', '2026-11-02T13:00:00.000Z', '2026-11-02T15:00:00.000Z']]) {
      const ev = tou.events(cfg, tz, date).find((e) => e.precondition)
      assert.equal(iso(ev.peakStart), peak)
      assert.equal(iso(tou.preconditionWindow(cfg, tz, ev, 'heating').preStart), pre)
      // a tuned +30 min lead is clamped to earliestStart 04:30 local
      const eff = tuning.effectivePrecondition(cfg, null, { tuning: { ...tuning.emptyTuning(), heating: { ...tuning.emptyTuning().heating, leadMin: 180 } } }, 'heating')
      assert.equal(tz.formatLocal(tou.preconditionWindow(cfg, tz, ev, 'heating', eff).preStart, 'hhmm'), '04:30')
    }
    assert.equal(tuning.nextApplyDate(cfg, tz, Z('2026-11-01T12:29:00Z')), '2026-11-01') // 04:29 PST
    assert.equal(tuning.nextApplyDate(cfg, tz, Z('2026-11-01T12:30:00Z')), '2026-11-02') // 04:30 PST
    assert.equal(tuning.nextApplyDate(cfg, tz, Z('2026-03-08T11:29:00Z')), '2026-03-08') // 04:29 PDT
    assert.equal(tuning.nextApplyDate(cfg, tz, Z('2026-03-08T11:30:00Z')), '2026-03-09') // 04:30 PDT
  })
})
