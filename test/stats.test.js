// stats.test.js — addendum §8.2: ols exact on y = 2x + 1; se/r2 vs hand-computed values; robustOls
// drops a +5 °F spike and recovers the slope within 0.02; pearson ±1/0; median/mad/quantile; null when
// n < 3 or Sxx = 0; stableStringify byte-stable; interp/meanOver; bucket helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mean, median, mad, quantile, sum, minMax, round, clamp,
  ols, robustOls, pearson, interp, meanOver, stableStringify,
  BUCKET_SEC, bucketStart, bucketMeans, groupMeans,
} from '../stats.js'

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b} (±${eps})`)

// deterministic PRNG (mulberry32) for property-ish checks
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('mean / median / mad / quantile / sum / minMax', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5)
  assert.equal(mean([]), null)
  assert.equal(mean(null), null)
  assert.equal(mean([1, null, NaN, undefined, 3, Infinity, '7']), 2) // non-finite ignored
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
  assert.equal(median([5]), 5)
  const input = [9, 1, 5]
  median(input)
  assert.deepEqual(input, [9, 1, 5], 'input not mutated')
  // mad([1,1,2,2,4,6,9]): median 2, |dev| = [1,1,0,0,2,4,7] → median 1
  assert.equal(mad([1, 1, 2, 2, 4, 6, 9]), 1)
  assert.equal(mad([7, 7, 7]), 0)
  assert.equal(mad([]), null)
  // type-7 quantiles
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75)
  assert.equal(quantile([1, 2, 3, 4], 0), 1)
  assert.equal(quantile([1, 2, 3, 4], 1), 4)
  assert.equal(quantile([4, 3, 2, 1], 0.5), 2.5)
  assert.equal(quantile([1, 2, 3, 4], 2), 4, 'q clamped')
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([1, 2], NaN), null)
  assert.equal(sum([1, 2, null, 3.5]), 6.5)
  assert.equal(sum([]), 0)
  assert.deepEqual(minMax([3, -1, 8, null]), { min: -1, max: 8 })
  assert.equal(minMax([]), null)
})

test('round / clamp', () => {
  assert.equal(round(1.25, 1), 1.3)
  assert.equal(round(-1.25, 1), -1.3)
  assert.equal(round(0.1 + 0.2, 2), 0.3)
  assert.equal(round(-0.04, 1), 0)
  assert.ok(Object.is(round(-0.04, 1), 0), 'no negative zero')
  assert.equal(round(null), null)
  assert.equal(round(NaN), null)
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-5, 1, 3), 1)
  assert.equal(clamp(2, null, 3), 2)
  assert.equal(clamp(9, 1, undefined), 9)
})

test('ols: exact on y = 2x + 1', () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const ys = xs.map((x) => 2 * x + 1)
  const f = ols(xs, ys)
  assert.equal(f.b, 2)
  assert.equal(f.a, 1)
  assert.equal(f.r2, 1)
  assert.equal(f.n, 10)
  assert.equal(f.sse, 0)
  assert.equal(f.se, 0)
  assert.equal(f.xMean, 4.5)
  assert.equal(f.sxx, 82.5)
})

test('ols: se_b and R² against hand-computed values', () => {
  // x̄ = 3, ȳ = 4, Sxx = 10, Sxy = 6 ⇒ b = 0.6, a = 2.2; residuals −0.8, 0.6, 1.0, −0.6, −0.2
  // SSE = 2.4, Syy = 6 ⇒ R² = 0.6; se_b = √(2.4/3/10) = √0.08; σ = √(2.4/3)
  const f = ols([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])
  near(f.b, 0.6)
  near(f.a, 2.2)
  near(f.sse, 2.4)
  near(f.syy, 6)
  near(f.sxy, 6)
  near(f.r2, 0.6)
  near(f.se, Math.sqrt(0.08))
  near(f.sigma, Math.sqrt(0.8))
  assert.equal(f.n, 5)
  // R² equals pearson² when both are defined
  near(f.r2, pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]) ** 2)
})

test('ols: null when n < 3 or Sxx = 0; non-finite pairs ignored; stable for epoch-sized x', () => {
  assert.equal(ols([1, 2], [1, 2]), null)
  assert.equal(ols([], []), null)
  assert.equal(ols([3, 3, 3, 3], [1, 2, 3, 4]), null, 'Sxx = 0')
  assert.equal(ols([0.1, 0.1, 0.1], [1, 2, 3]), null, 'identical x despite float mean rounding')
  assert.equal(ols(null, undefined), null)
  // pairs with a non-finite member are dropped: 3 good pairs remain
  const f = ols([0, 1, null, 2, 3], [1, 3, 99, NaN, 7])
  assert.equal(f.n, 3)
  near(f.b, 2)
  near(f.a, 1)
  assert.equal(ols([0, null, 1], [1, 5, 3]), null, 'only 2 finite pairs')
  // mismatched lengths use the shorter
  assert.equal(ols([0, 1, 2, 3], [1, 3, 5]).n, 3)
  // epoch-second x (1.79e9) with a 5-minute cadence: slope in °F/s recovered exactly enough
  const t0 = 1791986402
  const xs = Array.from({ length: 36 }, (_, i) => t0 + i * 300)
  const ys = xs.map((x) => 72 - (x - t0) / 3600) // −1 °F/h
  const e = ols(xs, ys)
  near(e.b * 3600, -1, 1e-9)
  near(e.r2, 1, 1e-12)
  // constant y: slope 0, nothing to explain ⇒ r2 0 (never NaN)
  const c = ols([1, 2, 3, 4], [5, 5, 5, 5])
  assert.equal(c.b, 0)
  assert.equal(c.r2, 0)
  assert.equal(c.se, 0)
  for (const v of Object.values(c)) assert.ok(Number.isFinite(v))
})

test('robustOls: drops a +5 °F spike and recovers the slope within 0.02', () => {
  // A shed drift: 5-min buckets from offAt+10 min, true slope −0.9 °F/h, small deterministic noise.
  const r = rng(7)
  const xs = []
  const ys = []
  for (let i = 0; i < 30; i++) {
    const x = (600 + 150 + i * 300) / 3600 // bucket midpoints in hours after offAt
    xs.push(x)
    ys.push(72.1 - 0.9 * x + (r() - 0.5) * 0.2)
  }
  const clean = ols(xs, ys)
  near(clean.b, -0.9, 0.02)
  const spiky = ys.slice()
  spiky[20] += 5
  const plain = ols(xs, spiky)
  assert.ok(Math.abs(plain.b - -0.9) > 0.02, `plain OLS is pulled by the spike (b = ${plain.b})`)
  const rob = robustOls(xs, spiky)
  assert.equal(rob.dropped, 1)
  assert.deepEqual(rob.droppedIdx, [20])
  assert.equal(rob.n, 29)
  near(rob.b, -0.9, 0.02)
  near(rob.b, clean.b, 0.02)
  assert.ok(rob.se <= 0.4)
})

test('robustOls: floor keeps small residuals; no drop ⇒ identical to ols; indices map to the input', () => {
  // quantised 1 °F readings: residuals < 1 °F never dropped even though MAD is tiny
  const xs = [0, 1, 2, 3, 4, 5, 6, 7]
  const ys = [72, 72, 71, 71, 70, 70, 69, 69]
  const rob = robustOls(xs, ys)
  assert.equal(rob.dropped, 0)
  assert.deepEqual(rob.droppedIdx, [])
  const f = ols(xs, ys)
  for (const k of Object.keys(f)) assert.equal(rob[k], f[k])
  // droppedIdx refers to ORIGINAL positions even with skipped non-finite pairs
  const xs2 = [null, 0, 1, 2, 3, 4, 5, 6, 7, 8]
  const ys2 = [50, 10, 11, 12, 13, 30, 15, 16, 17, 18]
  const r2 = robustOls(xs2, ys2)
  assert.deepEqual(r2.droppedIdx, [5])
  near(r2.b, 1)
  near(r2.a, 10)
  // custom floor/k: a huge floor drops nothing
  assert.equal(robustOls(xs2, ys2, { floorF: 100 }).dropped, 0)
  // small sample (n = 6, the drift-fit minimum) with one large glitch: only the glitch goes
  const xs3 = [0.25, 0.33, 0.42, 0.5, 0.58, 0.67]
  const ys3 = xs3.map((x) => 70 - 1.2 * x)
  ys3[2] += 8
  const r3 = robustOls(xs3, ys3)
  assert.deepEqual(r3.droppedIdx, [2])
  near(r3.b, -1.2, 1e-9)
  // refit impossible (too few points left) ⇒ null; too few to start ⇒ null
  assert.equal(robustOls([0, 1, 2], [0, 10, 0], { floorF: 0.1, k: 0 }), null)
  assert.equal(robustOls([0, 1], [0, 1]), null)
})

test('pearson: +1, −1, 0 and null cases', () => {
  near(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1)
  near(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1)
  near(pearson([1, 2, 3, 4, 5], [1, 2, 3, 2, 1]), 0)
  assert.equal(pearson([1, 2], [3, 4]), null)
  assert.equal(pearson([1, 1, 1], [3, 4, 5]), null)
  assert.equal(pearson([1, 2, 3], [4, 4, 4]), null)
  assert.equal(pearson([1, 2, null, 3], [2, 4, 100, 6]), 1)
  // bounded under float noise
  const r = rng(3)
  for (let k = 0; k < 200; k++) {
    const xs = Array.from({ length: 12 }, () => r() * 40)
    const ys = xs.map((x) => (k % 2 ? 1 : -1) * 3 * x + 7)
    const p = pearson(xs, ys)
    assert.ok(p >= -1 && p <= 1)
  }
})

test('interp: linear, endpoints, out of range, unsorted input, gaps', () => {
  const pts = [{ t: 0, v: 10 }, { t: 3600, v: 20 }, { t: 7200, v: 14 }]
  assert.equal(interp(pts, 0), 10)
  assert.equal(interp(pts, 1800), 15)
  assert.equal(interp(pts, 3600), 20)
  assert.equal(interp(pts, 5400), 17)
  assert.equal(interp(pts, 7200), 14)
  assert.equal(interp(pts, -1), null)
  assert.equal(interp(pts, 7201), null)
  assert.equal(interp([], 5), null)
  assert.equal(interp(pts, NaN), null)
  const shuffled = [pts[2], pts[0], pts[1]]
  assert.equal(interp(shuffled, 1800), 15)
  assert.deepEqual(shuffled, [pts[2], pts[0], pts[1]], 'input order untouched')
  // null values are skipped (interpolate across)
  assert.equal(interp([{ t: 0, v: 10 }, { t: 900, v: null }, { t: 1800, v: 20 }], 900), 15)
  // single point: only its own instant
  assert.equal(interp([{ t: 60, v: 3 }], 60), 3)
  assert.equal(interp([{ t: 60, v: 3 }], 61), null)
})

test('meanOver: time-weighted mean of the piecewise-linear series', () => {
  const lin = [{ t: 0, v: 10 }, { t: 3600, v: 20 }]
  near(meanOver(lin, 0, 3600), 15)
  near(meanOver(lin, 0, 1800), 12.5)
  // clipped to the covered span unless full:true
  near(meanOver(lin, 1800, 7200), 17.5)
  assert.equal(meanOver(lin, 1800, 7200, { full: true }), null)
  near(meanOver(lin, 0, 3600, { full: true }), 15)
  assert.equal(meanOver(lin, 4000, 5000), null, 'no overlap')
  assert.equal(meanOver(lin, 10, 5), null, 't1 < t0')
  assert.equal(meanOver(lin, 900, 900), 12.5, 'zero-length ⇒ interpolated value')
  assert.equal(meanOver([], 0, 10), null)
  // time weighting: a long flat stretch dominates
  const w = [{ t: 0, v: 0 }, { t: 100, v: 0 }, { t: 110, v: 100 }]
  near(meanOver(w, 0, 110), (0 * 100 + 50 * 10) / 110)
  // hourly forecast over a 7–10 AM peak: equals the fine 15-min sample mean within rounding
  const t7 = 1791986400
  const hourly = [{ t: t7 - 3600, v: 34 }, { t: t7, v: 36 }, { t: t7 + 3600, v: 39 }, { t: t7 + 7200, v: 43 }, { t: t7 + 10800, v: 46 }]
  const exact = meanOver(hourly, t7, t7 + 10800)
  near(exact, (36 + 2 * 39 + 2 * 43 + 46) / 6) // trapezoid of 36,39,43,46
  const fine = []
  for (let t = t7; t <= t7 + 10800; t += 60) fine.push(interp(hourly, t))
  near(exact, (fine.reduce((s, v) => s + v, 0) - (fine[0] + fine[fine.length - 1]) / 2) / (fine.length - 1), 1e-9)
})

test('bucket helpers: 5-min grid, per-bucket means, 15-min groups', () => {
  assert.equal(BUCKET_SEC, 300)
  assert.equal(bucketStart(1791986402), 1791986400)
  assert.equal(bucketStart(1791986699), 1791986400)
  assert.equal(bucketStart(1791986700), 1791986700)
  assert.equal(bucketStart(905, 900), 900)
  assert.equal(bucketStart(NaN), null)
  const t0 = 1791986400
  const pts = [
    { t: t0 + 10, v: 70 }, { t: t0 + 30, v: 72 }, // bucket 0 → 71
    { t: t0 + 650, v: 68 }, // bucket 2
    { t: t0 + 900, v: 99 }, // == t1 → excluded
    { t: t0 - 1, v: 99 }, // before t0 → excluded
    { t: t0 + 20, v: null }, // non-finite → ignored
  ]
  const b = bucketMeans(pts, t0, t0 + 900)
  assert.deepEqual(b, [{ t: t0, mean: 71, n: 2 }, { t: t0 + 300, mean: null, n: 0 }, { t: t0 + 600, mean: 68, n: 1 }])
  assert.equal(bucketMeans(pts, t0, t0 + 1000).length, 4, 'partial last bucket counted')
  assert.deepEqual(bucketMeans(pts, t0, t0), [])
  assert.deepEqual(groupMeans([70, 71, 72, null, null, null, 68, null], 3), [71, null, 68])
  assert.equal(groupMeans(new Array(288).fill(1), 3).length, 96)
  assert.deepEqual(groupMeans(null), [])
})

test('stableStringify: sorted keys, fixed numbers, byte-stable', () => {
  const a = { b: 1, a: { d: [3, 2, { z: 1, y: 2 }], c: 'x' }, e: 0.1 + 0.2 }
  const b = { e: 0.30000000000000004, a: { c: 'x', d: [3, 2, { y: 2, z: 1 }] }, b: 1 }
  const sa = stableStringify(a)
  assert.equal(sa, '{"a":{"c":"x","d":[3,2,{"y":2,"z":1}]},"b":1,"e":0.3}')
  assert.equal(stableStringify(b), sa, 'insertion order does not matter')
  assert.equal(stableStringify(a), sa, 'repeatable')
  assert.deepEqual(JSON.parse(sa), { a: { c: 'x', d: [3, 2, { y: 2, z: 1 }] }, b: 1, e: 0.3 })
  // numbers
  assert.equal(stableStringify(-0), '0')
  assert.equal(stableStringify([NaN, Infinity, -Infinity]), '[null,null,null]')
  assert.equal(stableStringify(1791986402), '1791986402')
  assert.equal(stableStringify(1791986402123), '1791986402123')
  assert.equal(stableStringify(-0.0000001), '0')
  assert.equal(stableStringify(72.123456789), '72.123457')
  assert.equal(stableStringify(72.1, { digits: 0 }), '72')
  assert.equal(stableStringify(1e21), '1e+21')
  // JSON semantics for undefined / functions / toJSON / strings
  assert.equal(stableStringify({ u: undefined, f() {}, n: null, s: 'a"b' }), '{"n":null,"s":"a\\"b"}')
  assert.equal(stableStringify([undefined, () => 1]), '[null,null]')
  assert.equal(stableStringify(new Date('2026-09-25T08:30:05Z')), '"2026-09-25T08:30:05.000Z"')
  assert.equal(stableStringify({ t: { toJSON: () => ({ b: 2, a: 1 }) } }), '{"t":{"a":1,"b":2}}')
  assert.equal(stableStringify(true), 'true')
  assert.equal(stableStringify(undefined), undefined)
  // shared (non-circular) references are fine; cycles and BigInt throw
  const shared = { x: 1 }
  assert.equal(stableStringify({ p: shared, q: shared }), '{"p":{"x":1},"q":{"x":1}}')
  const cyc = { a: 1 }
  cyc.self = cyc
  assert.throws(() => stableStringify(cyc), TypeError)
  assert.throws(() => stableStringify({ n: 10n }), TypeError)
  // byte-identical output for a rollup-shaped object rebuilt from scratch
  const mk = () => ({ v: 1, complete: true, units: { office: { onMin: { peak: 0, off_peak: 181.33333333, super_off_peak: 402 }, drift: { b: -0.92, se: 0.0612345678, r2: 0.95 } } } })
  assert.equal(stableStringify(mk()), stableStringify(JSON.parse(JSON.stringify(mk()))))
})
