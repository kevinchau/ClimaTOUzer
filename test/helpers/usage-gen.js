/**
 * test/helpers/usage-gen.js — deterministic usage-log fixture generator (addendum §8.1).
 *
 *   const g = await genDays({ start: '2026-10-12', days: 14, seed: 7,
 *     outdoor: (ms) => 45,
 *     units: [{ id: 'office', mode: 'HEAT', sp: 70, par: { deltaF: 3, leadMin: 120 }, band: [68, 78],
 *               thermal: { alpha: 0.4, beta: 0.05, heatFph: 4 }, sensor: 'ok', quantize: 1, noise: 0.3,
 *               offline: [[fromMs, toMs]], overrides: [{ at: '08:00', field: 'temp', to: 75, src: 'external', days: ['2026-10-14'] }],
 *               wasOff: ['2026-10-15'], dryRun: ['2026-10-16'], dormant: ['2026-10-20'] }] })
 *   g.records            every usage record read back from the log, by local date then file order
 *   g.byDate[date]       the same, per file
 *   g.truth              { onMin[unit][date]{peak,off_peak,super_off_peak,total}, room[unit][date]{min,max,mean},
 *                          events[unit][eventId]{status, season, par, preStart, offAt, onAt, shedEnd, orig, app,
 *                          T0, Tpk, eff, reached, Tmin, Tmax, driftFph, driftOlsFph, Tout, overrides}, episodes[] }
 *   g.usage              the (stopped) usage log instance: readDay(date), hasRaw(date), listRawDates()
 *   await g.cleanup()    removes the temp data dir (real recorder)
 *
 * Physics (room units, s = +1 for a HEAT unit, −1 for COOL/DRY): the spec §5.5 comfort-coordinate model
 * dz/dt = α + β(xOut − z) with z = s·room, xOut = s·Tout, i.e. droom/dt = s·α + β(Tout − room) + heater, integrated
 * at dt ≤ pollSec. `thermal.alpha`/`beta` are therefore exactly what optimizer.fitDriftModel should recover
 * (default α = s·0.4, i.e. +0.4 °F/h of internal gains; a cooling α is negative when gains warm the room).
 * While ON the unit's heater/cooler adds `heatFph` toward its setpoint and then holds the setpoint (thermostat).
 * Reported room = quantize(room + N(0, noise)) with seeded mulberry32 noise; sensor 'flat' freezes the reading while
 * the unit is OFF, 'jump' reads s·2.5 °F off (stratified air) while OFF.
 *
 * Engine emulation (spec §2.5/§6.2 + addendum H1–H3; what engine.js emits on the bus):
 *   observed {unitId, live, source:'poll'|'verify', warming, at}  every pollSec per unit (+ one verify read 2 s after
 *            each write); none while the unit is offline; the first 2 reads after offline→online carry warming:true.
 *   write    {unitId, field, value, actor, kind, eventId, at}      after the write-ahead persist, before the GET.
 *   activity {ts, seq, unit, event, actor, type, …}               phase_enter (phase, season, params), take (field,
 *            original, applied), write (from, to, result:'verified', attempt, ms), would_write (dry-run days: owns
 *            nothing; their phase_enter lines carry dryRun:true, as decide logs them), notice (code
 *            'precondition_skipped'), released / drop / deferred (overrides; the person's value is `live` on a drop and
 *            `value` on a deferred line, as decide logs them), phase_exit, device_offline / device_online.
 *   Per event: precondition TAKE temp at preStart (tou.preconditionWindow with the unit's par), shed TAKE power at
 *   peakStart, restore at peakEnd + order × restoreStaggerSec (power ON, then deferred fields, then temp CAS return).
 *   A boundary event (addendum E: cfg.precondition.superOffPeak.weekend on, a weekend/holiday super off-peak → off-peak
 *   step, peakStart = peakEnd) has no shed: the precondition TAKE at preStart, the temp return at the boundary; a unit
 *   that reads OFF at preStart never engages (E1.8 — the generator models no schedule entries).
 *   External overrides are confirmed by the engine on the 2nd poll ≥ 15 s after the change (§7.3); a power/mode
 *   change during an event releases it, a temp change on an owned temp drops it. User (dashboard) overrides act at
 *   once (manual write; deferred while shed OFF).
 *   Actions falling in an offline window are postponed until 2 reads after the unit is back (join guards applied).
 *
 * Recorder: a host's REAL usage log when `usageModule` ({createUsageLog}, e.g. the reference app's src/usage.js) is
 * passed (fake bus + fake clock + temp dataDir; `storeModule` may supply atomicWriteFile/readJson); otherwise the
 * built-in reference recorder below (a direct transcription of addendum §3.2/§3.3/§3.5, in memory). Force with
 * `recorder: 'real' | 'reference'` ('auto', the default, picks real exactly when usageModule is given). `window: ['HH:MM', 'HH:MM']` limits the service to that local window each day
 * (one boot per window: `h` + `b` records); windows must not cut an event.
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile, rename, readFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeTz, addDays } from '../../tz.js'
import * as tou from '../../tou.js'
import { approxEqual } from '../../util.js'
import { createFakeClock } from './fake-clock.js'
import { mulberry32 } from './rng.js'
import { specDefaultConfig } from './config.js'

const MIN = 60000
const HOUR = 3600000
const BUCKET_MS = 300000
const WATCHED = ['power', 'mode', 'temp', 'fan']
/** Activity types mirrored as `a` records (addendum §3.5); `tuning_*` too; `notice` only for precondition_* codes. */
export const MIRRORED_ACTIVITY = Object.freeze([
  'take', 'write', 'would_write', 'verify_fail', 'retry', 'failing', 'blocked', 'recovered', 'drop', 'released', 'resumed',
  'restored', 'skipped', 'deferred', 'phase_enter', 'phase_exit', 'notice', 'device_offline', 'device_online',
])
export const GOLDEN_DATE = '2026-10-14'
export const GOLDEN_FILE = new URL(`../fixtures/usage/golden-${GOLDEN_DATE}.jsonl`, import.meta.url)

const sec = (ms) => Math.floor(ms / 1000)
const round1 = (x) => Math.round(x * 10) / 10
const round2 = (x) => Math.round(x * 100) / 100
const iso = (ms) => new Date(ms).toISOString()
const seasonSign = (mode) => (String(mode).toUpperCase() === 'HEAT' ? 1 : -1)

/** Default outdoor temperature: a mild October diurnal curve (min ≈ 41 °F at 04:00, max ≈ 53 °F at 16:00 PDT). */
export function defaultOutdoor(ms) {
  const h = (((ms / HOUR - 7) % 24) + 24) % 24 // PDT hour of day (fixed offset: synthetic data only)
  return 47 + 6 * Math.sin((2 * Math.PI * (h - 10)) / 24)
}

function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function gaussian(rng) {
  let u = 0
  while (u <= 1e-12) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

class Queue {
  constructor() { this.a = []; this.seq = 0 }
  get size() { return this.a.length }
  push(at, fn, kind = 'action') {
    const it = { at, seq: this.seq++, fn, kind }
    const a = this.a
    a.push(it)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (less(a[p], a[i])) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
    return it
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && less(a[l], a[m])) m = l
        if (r < a.length && less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}
function less(x, y) { return x.at < y.at || (x.at === y.at && x.seq < y.seq) }

function toMsAt(tz, date, at) {
  if (typeof at === 'number') return at
  return tz.zonedToInstant(date, at)
}

function normUnit(u, i, cfg) {
  const oc = cfg?.optimizer?.units?.[u.id] ?? null
  return {
    id: u.id ?? `unit-${i}`,
    name: u.name ?? u.id ?? `Unit ${i}`,
    order: u.order ?? i,
    mode: String(u.mode ?? 'HEAT').toUpperCase(),
    sp: u.sp ?? 70,
    fan: u.fan ?? 'LOW',
    par: u.par ?? { deltaF: 3, leadMin: 120 },
    band: u.band ?? (oc ? [oc.comfortLowF, oc.comfortHighF] : [68, 78]),
    // default α = s·0.4: the same +0.4 °F/h internal gains expressed in comfort coordinates (negative for cooling)
    thermal: { alpha: seasonSign(u.mode ?? 'HEAT') * 0.4, beta: 0.05, heatFph: 4, ...(u.thermal ?? {}) },
    sensor: u.sensor ?? 'ok',
    quantize: u.quantize ?? 1,
    noise: u.noise ?? 0.3,
    offline: (u.offline ?? []).map(([a, b]) => [Number(a), Number(b)]),
    overrides: u.overrides ?? [],
    wasOff: new Set(u.wasOff ?? []),
    dryRun: new Set(u.dryRun ?? []),
    dormant: new Set(u.dormant ?? []),
    precondition: u.precondition ?? true,
    shed: u.shed ?? true,
    room0: u.room0 ?? null,
    power0: u.power ?? 'ON',
  }
}

function parFor(unit, date) {
  const p = unit.par
  if (typeof p === 'function') return p(date, unit.id)
  if (p && typeof p === 'object' && !('deltaF' in p) && !('leadMin' in p)) return p[date] ?? p.default ?? { deltaF: 3, leadMin: 120 }
  return p
}

// ───────────────────────────── reference recorder (addendum §3.2 / §3.3 / §3.5) ─────────────────────────────

/**
 * In-memory transcription of the usage log's capture algorithm. Used when no host usage log is injected (or forced),
 * and to build the golden fixture. Interface mirrors the parts of createUsageLog the generator drives.
 * One deliberate reading of §3.2: `gap` is measured before the FIRST sighting of an external change (the
 * stated property "changes first seen after > 300 s without a valid read carry gap"), not before the confirming read.
 */
export function createReferenceRecorder({ tz, cfg, bootId = 'b_ref', activeEventId = () => null, files = new Map() } = {}) {
  const tol = cfg?.device?.tempToleranceF ?? 0.6
  const minGapMs = (cfg?.device?.deviationMinGapSec ?? 15) * 1000
  const units = new Map()
  const st = (u) => {
    let s = units.get(u)
    if (!s) {
      s = { cur: null, cand: {}, exp: { power: [], mode: [], temp: [], fan: [] }, lastValidAt: null, bkt: null, prev: null }
      units.set(u, s)
    }
    return s
  }
  const put = (rec) => {
    const date = tz.localParts(rec.t * 1000).date
    let list = files.get(date)
    if (!list) files.set(date, (list = []))
    list.push(rec)
  }
  const actorToSrc = (a) => (a === 'dashboard' ? 'user' : a === 'system' ? 'system' : 'schedule')

  function commit(u, s, f, from, to, src, ev, at, gap) {
    s.cur[f] = to
    put({ k: 'c', t: sec(at), u, f, o: from, v: to, s: src, e: ev ?? null, gap: gap ?? null })
  }

  function emitSample(u, b) {
    put({
      k: 's', t: (b.b * BUCKET_MS) / 1000, u, r: b.n ? round1(b.sumR / b.n) : null, n: b.n, cv: Math.round(b.cvMs / 1000),
      on: Math.round(b.onMs / 1000), p: b.last?.p ?? null, m: b.last?.m ?? null, sp: b.last?.sp ?? null, f: b.last?.f ?? null,
    })
  }

  function accumulate(u, s, o) {
    const b = Math.floor(o.at / BUCKET_MS)
    let carry = null
    if (s.prev && o.at - s.prev.at <= 60000) {
      const pb = Math.floor(s.prev.at / BUCKET_MS)
      const on = s.prev.power === 'ON'
      if (pb === b) {
        carry = { cv: o.at - s.prev.at, on }
      } else {
        const boundary = b * BUCKET_MS
        if (s.bkt && s.bkt.b === pb) {
          s.bkt.cvMs += boundary - s.prev.at
          if (on) s.bkt.onMs += boundary - s.prev.at
        }
        carry = { cv: o.at - boundary, on }
      }
    }
    if (s.bkt && s.bkt.b !== b) { emitSample(u, s.bkt); s.bkt = null }
    if (!s.bkt) s.bkt = { b, n: 0, sumR: 0, cvMs: 0, onMs: 0, last: null }
    if (carry) { s.bkt.cvMs += carry.cv; if (carry.on) s.bkt.onMs += carry.cv }
    if (Number.isFinite(o.live.room)) { s.bkt.n++; s.bkt.sumR += o.live.room }
    s.bkt.last = { p: o.live.power === 'ON' ? 1 : 0, m: o.live.mode, sp: o.live.temp, f: o.live.fan }
    s.prev = { at: o.at, power: o.live.power }
  }

  return {
    kind: 'reference',
    files,
    start(now) { put({ k: 'h', t: sec(now), boot: bootId }) },
    onWrite(w) {
      const s = st(w.unitId)
      if (!s.exp[w.field]) return
      s.exp[w.field].push({ value: w.value, src: actorToSrc(w.actor), ev: w.eventId ?? null, until: w.at + 90000 })
    },
    onObserved(o) {
      if (!o.live?.ok || !o.live.ready || o.warming) return
      const u = o.unitId
      const s = st(u)
      const gapSec = s.lastValidAt != null ? (o.at - s.lastValidAt) / 1000 : null
      s.lastValidAt = o.at
      for (const f of WATCHED) s.exp[f] = s.exp[f].filter((x) => x.until >= o.at)
      if (!s.cur) {
        s.cur = { power: o.live.power, mode: o.live.mode, temp: o.live.temp, fan: o.live.fan }
        s.cand = {}
        put({ k: 'b', t: sec(o.at), u, p: o.live.power === 'ON' ? 1 : 0, m: o.live.mode, sp: o.live.temp, f: o.live.fan, r: o.live.room ?? null, boot: bootId })
        accumulate(u, s, o)
        return
      }
      for (const f of WATCHED) {
        const v = o.live[f]
        if (v == null) continue
        if (approxEqual(f, v, s.cur[f], tol)) { s.cand[f] = null; continue }
        const i = s.exp[f].findIndex((x) => approxEqual(f, x.value, v, tol))
        if (i >= 0) {
          const e = s.exp[f][i]
          s.exp[f].splice(i, 1)
          commit(u, s, f, s.cur[f], v, e.src, e.ev, o.at, null)
          s.cand[f] = null
          continue
        }
        const c = s.cand[f]
        if (!c || !approxEqual(f, c.v, v, tol)) { s.cand[f] = { v, firstAt: o.at, gapSec }; continue }
        if (o.at - c.firstAt >= minGapMs) {
          commit(u, s, f, s.cur[f], v, 'external', activeEventId(u, c.firstAt), c.firstAt, c.gapSec > 300 ? Math.round(c.gapSec) : null)
          s.cand[f] = null
        }
      }
      accumulate(u, s, o)
    },
    onActivity(e) {
      if (e.unit && (e.type === 'device_offline')) {
        const s = st(e.unit)
        s.cur = null
      }
      const mirrored = MIRRORED_ACTIVITY.includes(e.type) || String(e.type).startsWith('tuning_')
      if (!mirrored) return
      if (e.type === 'notice' && !String(e.code ?? '').startsWith('precondition_')) return
      const t = sec(typeof e.ts === 'number' ? e.ts : Date.parse(e.ts))
      put({
        k: 'a', t, u: e.unit ?? null, ty: e.type, ac: e.actor ?? null, e: e.event ?? null, f: e.field ?? null,
        fr: e.from ?? e.original ?? null, to: e.to ?? e.applied ?? e.value ?? e.live ?? null, res: e.result ?? null, ph: e.phase ?? null,
        se: e.season ?? e.params?.season ?? null, par: e.params ? { deltaF: e.params.deltaF, leadMin: e.params.leadMin } : null,
        cl: e.class ?? e.lastError?.class ?? null, why: e.code ?? null,
        ...(e.dryRun === true ? { dry: true } : {}),
        ...(e.type === 'take' && e.reason != null ? { rs: e.reason } : {}),
      })
    },
    record(rec) { put(rec) },
    onTick(now) {
      for (const [u, s] of units) {
        if (s.bkt && now > (s.bkt.b + 1) * BUCKET_MS + 60000) { emitSample(u, s.bkt); s.bkt = null }
      }
    },
    stop() {
      for (const [u, s] of units) if (s.bkt) { emitSample(u, s.bkt); s.bkt = null }
    },
  }
}

/** Reader over reference-recorder files, shaped like the usage log's read API. */
function referenceReader(files) {
  return {
    async *readDay(date) { for (const r of files.get(date) ?? []) yield r },
    async hasRaw(date) { return (files.get(date) ?? []).length > 0 },
    async listRawDates() { return [...files.keys()].sort() },
  }
}

// ───────────────────────────── real recorder (a host's usage log, injected) ─────────────────────────────

async function atomicWriteFileLocal(absPath, data) {
  await mkdir(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.tmp`
  const fh = await open(tmp, 'w')
  try { await fh.writeFile(data); await fh.sync() } finally { await fh.close() }
  await rename(tmp, absPath)
}

async function makeStubStore({ dataDir, cfg, tz, bootId, storeMod = null }) {
  const atomicWriteFile = storeMod?.atomicWriteFile ?? atomicWriteFileLocal
  const readJson = storeMod?.readJson ?? (async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback } })
  return {
    config: cfg, rev: cfg.rev ?? 1, tz, dataDir,
    state: { schemaVersion: 1, bootId, seq: 0, scheduleEnabled: true, units: {}, ledger: {}, alerts: {}, insights: { housekeepingFailures: 0 } },
    atomicWriteFile, readJson,
    appendActivity() { return 0 },
    async persist() {},
  }
}

function silentLog() {
  const noop = () => {}
  return { level: 'error', debug: noop, info: noop, warn: noop, error: noop }
}

// ───────────────────────────── the generator ─────────────────────────────

/**
 * Generate `days` local days of engine-shaped activity for `units` and push it through a usage log.
 * @returns {Promise<{records, byDate, truth, usage, recorder:'real'|'reference', dataDir, dates, cfg, cleanup}>}
 */
export async function genDays(opts = {}) {
  const tz = opts.tz ?? makeTz(opts.cfg?.timezone ?? 'America/Los_Angeles')
  const cfg = opts.cfg ? structuredClone(opts.cfg) : specDefaultConfig()
  const unitsIn = opts.units ?? [{ id: 'office' }]
  const startDate = typeof opts.start === 'number' ? tz.localParts(opts.start).date : (opts.start ?? GOLDEN_DATE)
  const nDays = opts.days ?? 1
  const pollMs = (opts.pollSec ?? 20) * 1000
  const seed = opts.seed ?? 1
  const outdoorFn = opts.outdoor === null ? null : (opts.outdoor ?? defaultOutdoor)
  const outdoorEveryMs = (opts.outdoorEveryMin ?? cfg.outdoor?.sampleMin ?? 15) * MIN
  const staggerMs = (cfg.shed?.restoreStaggerSec ?? 20) * 1000
  const log = opts.log ?? silentLog()

  // config: make sure every generated unit exists (host is never contacted: the generator has no device I/O)
  cfg.units = Array.isArray(cfg.units) ? cfg.units : []
  unitsIn.forEach((u, i) => {
    if (!cfg.units.some((x) => x.id === u.id)) {
      cfg.units.push({ id: u.id, name: u.name ?? u.id, host: `${u.id}.test`, order: u.order ?? i, shed: u.shed ?? true, precondition: u.precondition ?? true })
    }
  })
  if (cfg.optimizer) {
    cfg.optimizer.units = cfg.optimizer.units ?? {}
    for (const u of unitsIn) {
      if (!cfg.optimizer.units[u.id]) {
        const band = u.band ?? [68, 78]
        cfg.optimizer.units[u.id] = { enabled: true, comfortLowF: band[0], comfortHighF: band[1], sensorOffsetF: 0 }
      }
    }
  }
  const units = unitsIn.map((u, i) => normUnit(u, i, cfg))

  const dates = Array.from({ length: nDays }, (_, i) => addDays(startDate, i))
  const t0 = tz.zonedToInstant(startDate, '00:00')
  const t1 = tz.zonedToInstant(addDays(startDate, nDays), '00:00')

  // service (boot) intervals
  const boots = []
  if (opts.window) {
    for (const d of dates) boots.push([tz.zonedToInstant(d, opts.window[0]), tz.zonedToInstant(d, opts.window[1])])
  } else {
    boots.push([t0, t1])
  }
  const inService = (t) => boots.some(([a, b]) => t >= a && t < b)

  // tiers across the span (for truth on-time)
  const segs = []
  for (const d of dates) for (const s of tou.segments(cfg, tz, d)) segs.push({ ...s, date: d })

  // recorder selection
  const usageMod = opts.usageModule ?? null
  let recorderKind = opts.recorder ?? 'auto'
  if (recorderKind === 'real' && !usageMod?.createUsageLog) throw new Error('usage-gen: recorder "real" needs opts.usageModule ({createUsageLog}, the host\'s usage log)')
  if (recorderKind === 'auto') recorderKind = usageMod?.createUsageLog ? 'real' : 'reference'
  const refFiles = new Map()
  let dataDir = opts.dataDir ?? null
  let ownsDir = false
  if (recorderKind === 'real' && !dataDir) { dataDir = await mkdtemp(path.join(tmpdir(), 'usage-gen-')); ownsDir = true }
  const clock = createFakeClock(t0 - 1000)

  // ── per-unit runtime ──
  const sim = units.map((u) => {
    const s = seasonSign(u.mode)
    const rng = mulberry32((seed * 7919 + hashStr(u.id)) >>> 0)
    return {
      u, s, season: s > 0 ? 'heating' : 'cooling', rng,
      dev: { power: u.power0, mode: u.mode, temp: u.sp, fan: u.fan, vane: '1', room: u.room0 ?? u.sp - s * 0.2 },
      lastT: t0, segIdx: 0, frozenR: null,
      eng: { phase: 'idle', event: null, owned: {}, released: false, deferred: {}, params: null },
      reach: { offline: false, fails: 0, warming: 0 },
      epoch: 0,
    }
  })
  const byId = new Map(sim.map((x) => [x.u.id, x]))

  // ── truth ──
  const truth = { onMin: {}, room: {}, events: {}, episodes: [], overrides: [], writes: [] }
  const roomAcc = {}
  for (const x of sim) {
    truth.onMin[x.u.id] = {}
    truth.room[x.u.id] = {}
    truth.events[x.u.id] = {}
    roomAcc[x.u.id] = {}
    for (const d of dates) {
      truth.onMin[x.u.id][d] = { peak: 0, off_peak: 0, super_off_peak: 0, total: 0 }
      roomAcc[x.u.id][d] = { min: Infinity, max: -Infinity, sum: 0, w: 0 }
    }
  }

  // ── thermal integration + truth accumulation ──
  function heaterStep(x, room, passive, dtH) {
    const d = x.dev
    if (d.power !== 'ON' || !Number.isFinite(d.temp)) return room + passive * dtH
    const m = d.mode
    const cap = x.u.thermal.heatFph
    if (m === 'HEAT' || (m === 'AUTO' && room < d.temp)) {
      if (room < d.temp) return Math.min(d.temp, room + (passive + cap) * dtH)
      return passive > 0 ? room + passive * dtH : Math.max(d.temp, room + passive * dtH)
    }
    if (m === 'COOL' || m === 'DRY' || m === 'AUTO') {
      if (room > d.temp) return Math.max(d.temp, room + (passive - cap) * dtH)
      return passive < 0 ? room + passive * dtH : Math.min(d.temp, room + passive * dtH)
    }
    return room + passive * dtH // FAN
  }

  function advanceUnit(x, to) {
    if (to <= x.lastT) return
    const th = x.u.thermal
    const gains = x.s * th.alpha
    let t = x.lastT
    while (t < to) {
      while (x.segIdx < segs.length - 1 && segs[x.segIdx].end <= t) x.segIdx++
      const seg = segs[x.segIdx]
      const stepEnd = Math.min(to, t + pollMs, seg && seg.end > t ? seg.end : Infinity)
      const dt = stepEnd - t
      if (seg && t >= seg.start && t < seg.end) {
        const on = truth.onMin[x.u.id][seg.date]
        const ra = roomAcc[x.u.id][seg.date]
        if (x.dev.power === 'ON') { on[seg.tier] += dt / MIN; on.total += dt / MIN }
        ra.min = Math.min(ra.min, x.dev.room)
        ra.max = Math.max(ra.max, x.dev.room)
        ra.sum += x.dev.room * dt
        ra.w += dt
      }
      const tout = outdoorFn ? outdoorFn(t) : x.dev.room
      const passive = gains + th.beta * (tout - x.dev.room)
      x.dev.room = heaterStep(x, x.dev.room, passive, dt / HOUR)
      t = stepEnd
    }
    x.lastT = to
  }

  function reportedRoom(x) {
    const d = x.dev
    const q = x.u.quantize > 0 ? x.u.quantize : 0.1
    const noisy = d.room + (x.u.noise > 0 ? gaussian(x.rng) * x.u.noise : 0)
    let r = Math.round(noisy / q) * q
    if (d.power === 'OFF' && x.u.sensor === 'flat') {
      if (x.frozenR == null) x.frozenR = r
      r = x.frozenR
    } else if (d.power === 'OFF' && x.u.sensor === 'jump') {
      r = Math.round((noisy + x.s * 2.5) / q) * q
    }
    if (d.power !== 'OFF') x.frozenR = null
    return Math.round(r * 10) / 10
  }

  // ── recorder plumbing ──
  let rec = null // current boot's recorder facade
  let lastReader = null
  let actSeq = 0
  const queue = new Queue()

  function activeEventId(unitId, ms) {
    const x = byId.get(unitId)
    const ev = x?.plan?.find((p) => ms >= (p.preStart ?? p.e.peakStart) && ms < p.e.peakEnd)
    return ev ? ev.e.id : null
  }

  async function bootRecorder(i, at) {
    const bootId = `b_gen${String(seed).padStart(2, '0')}${String(i).padStart(2, '0')}`
    clock.setNow(Math.max(clock.now(), at))
    if (recorderKind === 'reference') {
      const r = createReferenceRecorder({ tz, cfg, bootId, activeEventId, files: refFiles })
      r.start(at)
      lastReader = referenceReader(refFiles)
      return {
        observed: (o) => r.onObserved(o), write: (w) => r.onWrite(w), activity: (e) => r.onActivity(e),
        record: (x) => r.record(x), tick: (now) => r.onTick(now), flush: async () => {}, stop: async () => r.stop(),
      }
    }
    const bus = new EventEmitter()
    bus.setMaxListeners(50)
    const store = await makeStubStore({ dataDir, cfg, tz, bootId, storeMod: opts.storeModule ?? null })
    const usage = usageMod.createUsageLog({ dataDir, cfgRef: () => cfg, tz, clock, log, bus, store })
    await usage.start?.()
    lastReader = usage
    return {
      observed: (o) => bus.emit('observed', o), write: (w) => bus.emit('write', w), activity: (e) => bus.emit('activity', e),
      record: (x) => usage.record(x), tick: (now) => usage.onTick?.(now), flush: () => usage.flush?.(), stop: () => usage.stop?.(),
      usage,
    }
  }

  const sink = {
    observed(o) { if (rec) rec.observed(o) },
    write(w) { truth.writes.push(w); if (rec) rec.write(w) },
    activity(e) { if (rec) rec.activity(e) },
  }

  function emitActivity(x, now, fields) {
    const event = 'event' in fields ? fields.event : (x?.eng.event?.id ?? null)
    const entry = { ts: iso(now), seq: ++actSeq, unit: x ? x.u.id : null, actor: 'scheduler', ...fields, event }
    sink.activity(entry)
    return entry
  }

  function liveOf(x, now) {
    return {
      ok: true, readAt: iso(now), epoch: ++x.epoch, ready: true, hostname: `hp-${x.u.id}`, firmware: 'test-1.0', useF: 1, tempStep: 1,
      power: x.dev.power, mode: x.dev.mode, temp: x.dev.temp, room: reportedRoom(x), fan: x.dev.fan, vane: x.dev.vane, preset: null,
      caps: { modes: ['DRY', 'COOL', 'HEAT', 'FAN'], fanModes: ['LOW', 'MEDIUM', 'HIGH', 'AUTO'], vaneModes: ['1', '2', '3', '4', '5', 'SWING'], tempMin: 61, tempMax: 90 },
    }
  }

  function isOffline(x, t) { return x.u.offline.some(([a, b]) => t >= a && t < b) }
  function offlineEnd(x, t) { const w = x.u.offline.find(([a, b]) => t >= a && t < b); return w ? w[1] : null }

  function observe(x, now, source) {
    if (!inService(now) || isOffline(x, now)) return false
    advanceUnit(x, now)
    const warming = x.reach.warming > 0
    if (warming) x.reach.warming--
    sink.observed({ unitId: x.u.id, live: liveOf(x, now), source, warming, at: now })
    return true
  }

  // Device-truth trajectory during each shed's OFF window (1-min samples; ≤ 180 points per event).
  function sampleTruth(x, now) {
    if ((now - t0) % MIN !== 0 || x.dev.power !== 'OFF' || !x.plan) return
    const p = x.plan.find((q) => now >= q.e.peakStart && now < q.e.peakEnd)
    const te = p && truth.events[x.u.id][p.e.id]
    if (!te || te.status === 'dry' || te.status === 'absent') return
    if (te.offAt == null || now < te.offAt || (te.shedEnd != null && now >= te.shedEnd)) return
    advanceUnit(x, now)
    te._pts.push({ t: now, room: x.dev.room, tout: outdoorFn ? outdoorFn(now) : x.dev.room })
  }

  // poll: every pollMs per unit (one grid item for all units, in config order)
  function poll(now) {
    for (const x of sim) sampleTruth(x, now)
    if (inService(now)) {
      for (const x of sim) {
        if (isOffline(x, now)) {
          x.reach.fails++
          if (x.reach.fails === 3 && !x.reach.offline) {
            x.reach.offline = true
            emitActivity(x, now, { actor: 'system', type: 'device_offline', message: `${x.u.name} is not answering` })
          }
          continue
        }
        if (x.reach.offline) {
          x.reach.offline = false
          x.reach.warming = 2
          emitActivity(x, now, { actor: 'system', type: 'device_online', message: `${x.u.name} is back` })
        }
        x.reach.fails = 0
        observe(x, now, 'poll')
      }
    }
    if (now + pollMs < t1) queue.push(now + pollMs, poll, 'poll')
  }

  function nextPollAtOrAfter(t) { return t0 + Math.ceil((t - t0) / pollMs) * pollMs }

  // Run an engine action now, or postpone it while the unit is offline (after the 2 warming reads).
  function act(x, at, fn, { guard } = {}) {
    queue.push(at, (now) => {
      if (!inService(now)) return
      const end = offlineEnd(x, now) ?? (x.reach.offline ? now : null)
      if (end != null) {
        const back = nextPollAtOrAfter(Math.max(end, now + 1)) + 2 * pollMs + 100
        act(x, back, fn, { guard })
        return
      }
      if (guard && !guard(now)) return
      fn(now)
    })
  }

  // One verified device write (H1 order: bus 'write' → GET → verify read at +2 s → activity 'write').
  function deviceWrite(x, now, field, value, { kind = 'take', actor, eventId, then } = {}) {
    const a = actor ?? (kind === 'manual' ? 'dashboard' : kind === 'correct' ? 'system' : 'scheduler')
    advanceUnit(x, now)
    const from = x.dev[field]
    sink.write({ unitId: x.u.id, field, value, actor: a, kind, eventId: eventId ?? x.eng.event?.id ?? null, at: now })
    queue.push(now + 10, (t) => { advanceUnit(x, t); x.dev[field] = value })
    queue.push(now + 2000, (t) => {
      observe(x, t, 'verify')
      emitActivity(x, t + 5, { actor: a, event: eventId ?? x.eng.event?.id ?? null, type: 'write', field, from, to: value, result: 'verified', attempt: 1, ms: 2000 })
      if (field === 'power') x.eng.lastPowerChangeAt = t
      if (then) then(t + 50)
    })
  }

  function bumpFor(x, sp, par) {
    const cl = cfg.precondition?.clampF ?? { coolingMin: 65, heatingMax: 76 }
    if (x.s > 0) return Math.min(Math.round(sp + par.deltaF), cl.heatingMax ?? 76, 90)
    return Math.max(Math.round(sp - par.deltaF), cl.coolingMin ?? 65, 61)
  }

  function paramsOf(x, par) {
    return { season: x.season, deltaF: par.deltaF, leadMin: par.leadMin, clampF: { ...(cfg.precondition?.clampF ?? { coolingMin: 65, heatingMax: 76 }) }, source: par.source ?? 'config' }
  }

  function truthEvent(x, p) {
    const id = p.e.id
    let t = truth.events[x.u.id][id]
    if (!t) {
      t = truth.events[x.u.id][id] = {
        unit: x.u.id, id, date: p.date, status: 'absent', season: x.season, par: p.pw ? { deltaF: p.par.deltaF, leadMin: p.par.leadMin } : null,
        dryRun: p.dry, preStart: p.pw?.preStart ?? null, peakStart: p.e.peakStart, peakEnd: p.e.peakEnd, offAt: null, onAt: null, shedEnd: null,
        orig: null, app: null, T0: null, Tpk: null, rise: null, eff: null, reached: null, Tmin: null, Tmax: null, driftFph: null, driftOlsFph: null,
        Tout: null, overrides: [], _pts: [],
      }
      truth.episodes.push(t)
    }
    return t
  }

  // ── engine emulation per event ──
  function planEvent(x, date, e) {
    const u = x.u
    if (!u.shed) return
    const par = parFor(u, date)
    const dry = u.dryRun.has(date)
    const wantPre = e.precondition && u.precondition && par
    const pw = wantPre ? tou.preconditionWindow(cfg, tz, e, x.season, { leadMin: par.leadMin, source: par.source ?? 'config', earliestStart: par.earliestStart }) : null
    const p = { e, date, par, dry, pw, preStart: pw?.preStart ?? null, boundary: e.peakEnd <= e.peakStart }
    x.plan = x.plan ?? []
    x.plan.push(p)
    const joinCut = (cfg.precondition?.joinCutoffMin ?? 10) * MIN
    const minRem = (cfg.shed?.minRemainingMin ?? 15) * MIN

    if (pw) act(x, pw.preStart + 300, (now) => preconditionStart(x, p, now), { guard: (now) => now < e.peakStart - joinCut })
    if (!p.boundary) act(x, e.peakStart + 300, (now) => shedStart(x, p, now), { guard: (now) => now < e.peakEnd - minRem || x.eng.event === e })
    act(x, e.peakEnd + 250, (now) => eventEnd(x, p, now))
  }

  function preconditionStart(x, p, now) {
    const te = truthEvent(x, p)
    advanceUnit(x, now)
    te.T0 = x.dev.room
    if (x.eng.event === p.e) return
    const modes = cfg.precondition?.modes ?? ['COOL', 'DRY', 'HEAT']
    const eligible = x.dev.power === 'ON' && modes.includes(x.dev.mode) && seasonSign(x.dev.mode) === x.s
    const target = eligible ? bumpFor(x, x.dev.temp, p.par) : null
    const moves = eligible && (x.s > 0 ? target > x.dev.temp : target < x.dev.temp)
    if (p.boundary && x.dev.power !== 'ON') return // addendum E E1.8: an OFF unit without an ON entry never engages
    if (p.dry) {
      te.status = 'dry'
      emitActivity(x, now, { event: p.e.id, type: 'phase_enter', phase: 'precondition', season: x.season, params: paramsOf(x, p.par), dryRun: true })
      if (moves) emitActivity(x, now, { event: p.e.id, type: 'would_write', field: 'temp', from: x.dev.temp, to: target, message: 'dry-run' })
      return
    }
    x.eng = { phase: 'precondition', event: p.e, owned: {}, released: false, deferred: {}, params: paramsOf(x, p.par), p }
    emitActivity(x, now, { type: 'phase_enter', phase: 'precondition', season: x.season, params: x.eng.params })
    if (!moves) {
      const why = x.dev.power !== 'ON' ? 'unit off' : !modes.includes(x.dev.mode) ? `mode ${x.dev.mode}` : 'already at limit'
      emitActivity(x, now + 1, { type: 'notice', code: 'precondition_skipped', message: `Precondition skipped: ${why}` })
      return
    }
    const orig = x.dev.temp
    x.eng.owned.temp = { original: orig, applied: target }
    te.orig = orig
    te.app = target
    emitActivity(x, now + 1, { type: 'take', field: 'temp', original: orig, applied: target })
    deviceWrite(x, now + 10, 'temp', target, { kind: 'take' })
  }

  /** Truth of the precondition's realisation at peakStart (the shed's start, or a boundary event's instant). */
  function truthAtPeak(x, te, now) {
    advanceUnit(x, now)
    te.Tpk = x.dev.room
    if (te.orig != null && te.T0 != null) {
      const dApp = Math.abs(te.app - te.orig)
      te.rise = x.s * (te.Tpk - te.T0)
      te.eff = dApp > 0 ? Math.max(-0.5, Math.min(1.5, te.rise / dApp)) : null
      te.reached = x.s * (te.Tpk - te.app) >= -0.5
    }
  }

  function shedStart(x, p, now) {
    const te = truthEvent(x, p)
    truthAtPeak(x, te, now)
    if (x.eng.released && x.eng.event === p.e) return
    if (p.dry) {
      te.status = 'dry'
      emitActivity(x, now, { event: p.e.id, type: 'phase_enter', phase: 'shed', season: x.season, params: paramsOf(x, p.par), dryRun: true })
      if (x.dev.power === 'ON') emitActivity(x, now, { event: p.e.id, type: 'would_write', field: 'power', from: 'ON', to: 'OFF', message: 'dry-run' })
      return
    }
    if (x.eng.event !== p.e) {
      // H5: params are frozen in the same commit as baseline/eventId, also for a shed-only event
      x.eng = { phase: 'shed', event: p.e, owned: {}, released: false, deferred: {}, params: paramsOf(x, p.par), p }
    } else {
      emitActivity(x, now, { type: 'phase_exit', phase: 'precondition' })
      x.eng.phase = 'shed'
    }
    emitActivity(x, now + 1, { type: 'phase_enter', phase: 'shed', season: x.season, params: x.eng.params })
    if (x.dev.power !== 'ON') {
      x.eng.owned.power = { original: 'OFF', applied: 'OFF' }
      emitActivity(x, now + 2, { type: 'take', field: 'power', original: 'OFF', applied: 'OFF' })
      te.status = 'was_off'
      te.offAt = p.e.peakStart
      te.pre = null
      return
    }
    x.eng.owned.power = { original: 'ON', applied: 'OFF' }
    te.status = 'done'
    emitActivity(x, now + 2, { type: 'take', field: 'power', original: 'ON', applied: 'OFF' })
    deviceWrite(x, now + 10, 'power', 'OFF', { kind: 'take', then: (t) => { te.offAt = t - 50 } })
  }

  // RETURN everything still owned (power ON first, then deferred fields, then temp CAS) → idle.
  function returnAll(x, now, { powerOn = true } = {}) {
    const e = x.eng.event
    const steps = []
    const own = x.eng.owned
    if (powerOn && own.power && own.power.original === 'ON' && x.dev.power === 'OFF') steps.push(['power', 'ON', 'return'])
    for (const f of ['mode', 'temp', 'fan']) if (x.eng.deferred[f] != null) steps.push([f, x.eng.deferred[f], 'deferred'])
    if (own.temp && x.eng.deferred.temp == null && approxEqual('temp', x.dev.temp, own.temp.applied)) steps.push(['temp', own.temp.original, 'return'])
    const finish = (t) => {
      emitActivity(x, t, { event: e?.id ?? null, type: 'phase_exit', phase: x.eng.phase })
      x.eng = { phase: 'idle', event: x.eng.released ? e : null, owned: {}, released: x.eng.released, deferred: {}, params: null }
    }
    const run = (i, t) => {
      if (i >= steps.length) return finish(t)
      const [f, v, kind] = steps[i]
      if (f !== 'power' && x.dev.power !== 'ON') return run(i + 1, t) // never write non-power fields to an OFF unit
      deviceWrite(x, t, f, v, {
        kind,
        eventId: e?.id ?? null,
        then: (tt) => {
          const te = e && truth.events[x.u.id][e.id]
          if (te && f === 'power' && v === 'ON' && te.onAt == null) te.onAt = tt - 50
          run(i + 1, tt)
        },
      })
    }
    run(0, now)
  }

  function eventEnd(x, p, now) {
    const te = truthEvent(x, p)
    if (p.boundary && te.T0 != null && te.Tpk == null) truthAtPeak(x, te, now)
    if (te.shedEnd == null) te.shedEnd = p.e.peakEnd
    if (x.eng.event !== p.e || x.eng.phase === 'idle') return
    if (x.eng.released) return
    const own = x.eng.owned
    const needsPowerOn = own.power && own.power.original === 'ON' && x.dev.power === 'OFF'
    const at = needsPowerOn ? Math.max(now, p.e.peakEnd + x.u.order * staggerMs + 300) : now
    act(x, at, (t) => { if (x.eng.event === p.e && !x.eng.released && x.eng.phase !== 'idle') returnAll(x, t) })
  }

  // ── overrides ──
  function noteOverride(x, now, fields, before, src) {
    const o = { unit: x.u.id, at: now, fields: { ...fields }, before, src, event: activeEventId(x.u.id, now) }
    truth.overrides.push(o)
    if (o.event) truth.events[x.u.id][o.event]?.overrides.push(o)
  }

  // Outside change (Apple Home / IR remote): the device changes now; the engine confirms it on the 2nd clean
  // poll ≥ deviationMinGapSec after the first sighting (§7.3) and reacts (release / drop).
  function applyExternal(x, now, fields) {
    advanceUnit(x, now)
    const before = {}
    for (const [f, v] of Object.entries(fields)) { before[f] = x.dev[f]; x.dev[f] = v }
    noteOverride(x, now, fields, before, 'external')
    const first = nextPollAtOrAfter(now) // a change queued at a poll instant is seen by that poll
    const confirm = first + Math.max(pollMs, Math.ceil(((cfg.device?.deviationMinGapSec ?? 15) * 1000) / pollMs) * pollMs) + 50
    act(x, confirm, (t) => {
      for (const [f, v] of Object.entries(fields)) if (!approxEqual(f, x.dev[f], v)) return // reverted meanwhile
      if (engineReact(x, t, fields, 'external')) returnAll(x, t + 100, { powerOn: false })
    })
  }

  function engineReact(x, now, fields, actor) {
    const eng = x.eng
    if (eng.phase === 'idle' || eng.released) return false
    const e = eng.event
    const te = truth.events[x.u.id][e.id]
    const releasing = ('power' in fields) || ('mode' in fields && x.dev.power === 'ON')
    if (releasing) {
      const f = 'power' in fields ? 'power' : 'mode'
      eng.released = true
      emitActivity(x, now, { actor, event: e.id, type: 'released', field: f, from: f === 'power' ? eng.owned.power?.applied ?? null : null, to: fields[f], message: `Released by ${actor}` })
      if (te) {
        if (te.shedEnd == null && now < e.peakEnd && now >= e.peakStart) te.shedEnd = now
        if (f === 'power' && fields.power === 'ON' && te.onAt == null && now >= e.peakStart) te.onAt = now
        if (te.status !== 'was_off' && te.status !== 'dry') te.status = 'released'
      }
      delete eng.owned[f]
      return true
    }
    for (const f of Object.keys(fields)) {
      if (eng.owned[f]) {
        emitActivity(x, now, { actor, event: e.id, type: 'drop', field: f, from: eng.owned[f].applied, live: fields[f] })
        delete eng.owned[f]
      }
    }
    return false
  }

  function planOverride(x, ov, date) {
    const at = toMsAt(tz, date, ov.at)
    const fields = { [ov.field]: ov.to }
    if (ov.src === 'user') {
      act(x, at, (now) => {
        const eng = x.eng
        const active = eng.phase !== 'idle' && !eng.released
        if (active && eng.phase === 'shed' && x.dev.power === 'OFF' && ov.field !== 'power') {
          // §7.2 deferred: zero device writes now; applied right after power returns ON
          eng.deferred[ov.field] = ov.to
          if (eng.owned.temp && ov.field === 'temp') delete eng.owned.temp
          noteOverride(x, now, fields, { [ov.field]: x.dev[ov.field] }, 'user')
          emitActivity(x, now, { actor: 'dashboard', event: eng.event.id, type: 'deferred', field: ov.field, value: ov.to })
          return
        }
        const released = active ? engineReact(x, now, fields, 'dashboard') : false
        noteOverride(x, now, fields, { [ov.field]: x.dev[ov.field] }, 'user')
        deviceWrite(x, now + 20, ov.field, ov.to, {
          kind: 'manual',
          eventId: x.eng.event?.id ?? null,
          then: (t) => { if (released) returnAll(x, t, { powerOn: false }) },
        })
      })
    } else {
      queue.push(at, (now) => applyExternal(x, now, fields))
    }
  }

  // schedule everything
  for (const x of sim) {
    for (const d of dates) {
      if (x.u.dormant.has(d) && !x.u.dormant.has(addDays(d, -1))) {
        queue.push(tz.zonedToInstant(d, '00:00') + 1000, (now) => { if (x.dev.power === 'ON') applyExternal(x, now, { power: 'OFF' }) })
      }
      if (!x.u.dormant.has(d) && x.u.dormant.has(addDays(d, -1))) {
        queue.push(tz.zonedToInstant(d, '00:00') + 1000, (now) => { if (x.dev.power === 'OFF') applyExternal(x, now, { power: 'ON' }) })
      }
      const evs = tou.events(cfg, tz, d)
      if (x.u.wasOff.has(d) && evs.length) {
        const e0 = evs[0]
        queue.push(e0.peakStart - 3 * HOUR, (now) => { if (x.dev.power === 'ON') applyExternal(x, now, { power: 'OFF' }) })
        queue.push(e0.peakEnd + 30 * MIN, (now) => { if (x.dev.power === 'OFF') applyExternal(x, now, { power: 'ON' }) })
      }
      for (const e of evs) planEvent(x, d, e)
      for (const ov of x.u.overrides) {
        if (typeof ov.at === 'number') { if (tz.localParts(ov.at).date === d) planOverride(x, ov, d); continue }
        if (ov.days && !ov.days.includes(d)) continue
        planOverride(x, ov, d)
      }
    }
  }

  // outdoor samples (weather.js calls usage.record({k:'o'}) at :00/:15/:30/:45 + 20 s)
  if (outdoorFn) {
    for (let t = t0 + 20000; t < t1; t += outdoorEveryMs) {
      queue.push(t, (now) => { if (inService(now) && rec) rec.record({ k: 'o', t: sec(now - 20000), f: round1(outdoorFn(now - 20000)) }) }, 'outdoor')
    }
  }
  // scheduler ticks (every 30 s) → usage.onTick
  for (let t = t0 + 30000; t < t1 + 120000; t += 30000) queue.push(t, (now) => { if (rec && inService(now)) rec.tick(now) }, 'tick')
  queue.push(t0, poll, 'poll')

  // boots
  boots.forEach(([a, b], i) => {
    queue.push(a - 1, async (now) => { rec = await bootRecorder(i, now + 1) }, 'boot')
    queue.push(b, async (now) => { if (rec) { rec.tick(now); await rec.stop(); rec = null } }, 'shutdown')
  })

  // ── run ──
  let lastFlushHour = null
  while (queue.size) {
    const it = queue.pop()
    if (it.at > t1 + 120000) break
    if (it.at > clock.now()) clock.advance(it.at - clock.now())
    const r = it.fn(it.at)
    if (r && typeof r.then === 'function') await r
    if (rec && recorderKind === 'real') {
      const hour = Math.floor(it.at / HOUR)
      if (hour !== lastFlushHour) { lastFlushHour = hour; await rec.flush() }
    }
  }
  if (rec) { await rec.stop(); rec = null }
  for (const x of sim) advanceUnit(x, t1)

  // ── finish truth ──
  for (const x of sim) {
    for (const d of dates) {
      const ra = roomAcc[x.u.id][d]
      truth.room[x.u.id][d] = ra.w ? { min: round2(ra.min), max: round2(ra.max), mean: round2(ra.sum / ra.w) } : null
      const o = truth.onMin[x.u.id][d]
      for (const k of Object.keys(o)) o[k] = round2(o[k])
    }
  }

  // Episode truth from the sampled OFF-window trajectory.
  function finishEpisodes() {
    for (const te of truth.episodes) {
      const pts = te._pts
      delete te._pts
      if (te.shedEnd == null) te.shedEnd = te.peakEnd
      for (const k of ['T0', 'Tpk', 'rise', 'eff']) if (te[k] != null) te[k] = round2(te[k])
      if (!pts.length) continue
      const x = byId.get(te.unit)
      te.Tmin = round2(Math.min(...pts.map((p) => p.room)))
      te.Tmax = round2(Math.max(...pts.map((p) => p.room)))
      te.Tout = round2(pts.reduce((a, p) => a + p.tout, 0) / pts.length)
      const settle = (te.offAt ?? te.peakStart) + 10 * MIN
      const fit = pts.filter((p) => p.t >= settle && p.t < te.shedEnd)
      if (fit.length >= 2) {
        const mid = (settle + te.shedEnd) / 2
        const pm = fit.reduce((best, p) => (Math.abs(p.t - mid) < Math.abs(best.t - mid) ? p : best), fit[0])
        te.driftFph = round2(x.s * x.u.thermal.alpha + x.u.thermal.beta * (pm.tout - pm.room))
        const xs = fit.map((p) => (p.t - settle) / HOUR)
        const ys = fit.map((p) => p.room)
        const xm = xs.reduce((a, b) => a + b, 0) / xs.length
        const ym = ys.reduce((a, b) => a + b, 0) / ys.length
        let sxx = 0
        let sxy = 0
        for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - xm) ** 2; sxy += (xs[i] - xm) * (ys[i] - ym) }
        te.driftOlsFph = sxx > 0 ? round2(sxy / sxx) : null
      }
    }
  }
  finishEpisodes()

  // ── read back ──
  const byDate = {}
  const records = []
  const reader = lastReader ?? referenceReader(refFiles)
  const listed = typeof reader.listRawDates === 'function' ? await reader.listRawDates() : null
  const readDates = listed ?? [addDays(startDate, -1), ...dates, addDays(startDate, nDays)]
  for (const d of readDates) {
    const list = []
    for await (const r of reader.readDay(d)) list.push(r)
    if (list.length) { byDate[d] = list; records.push(...list) }
  }

  return {
    records, byDate, truth, dates, cfg, tz, dataDir, recorder: recorderKind, usage: reader,
    async cleanup() { if (ownsDir && dataDir) await rm(dataDir, { recursive: true, force: true }) },
  }
}

/** Build the golden fixture (addendum §7.5): one heating weekday for office, 04:40–10:45 service window. */
export async function goldenRecords() {
  const g = await genDays({
    start: GOLDEN_DATE, days: 1, seed: 14, recorder: 'reference', window: ['04:40', '10:45'],
    outdoor: (ms) => 44 + 3 * Math.sin((2 * Math.PI * ((ms / HOUR - 7 - 10) % 24)) / 24),
    outdoorEveryMin: 30,
    units: [{
      id: 'office', order: 5, mode: 'HEAT', sp: 70, fan: 'LOW', par: { deltaF: 3, leadMin: 120 }, band: [68, 78],
      thermal: { alpha: 0.4, beta: 0.05, heatFph: 2.2 }, sensor: 'ok', quantize: 1, noise: 0.25, room0: 69.8,
      overrides: [{ at: '08:00', field: 'temp', to: 75, src: 'external' }],
    }],
  })
  return g
}

/** Serialize records as JSONL (one object per line, keys in the §3.5 order they were produced). */
export function toJsonl(records) { return records.map((r) => JSON.stringify(r)).join('\n') + '\n' }

/** Regenerate test/fixtures/usage/golden-2026-10-14.jsonl (dev helper; the fixture lives with the core suites). */
export async function writeGolden(file = GOLDEN_FILE) {
  const g = await goldenRecords()
  await writeFile(file, toJsonl(g.byDate[GOLDEN_DATE] ?? []))
  return g
}
