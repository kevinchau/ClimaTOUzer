// stats.js — small, dependency-free statistics for the usage optimizer (addendum §4.5–§4.7,
// §5.5, §7.1). PURE: no I/O, no clock, no Date getters; every function is deterministic.
//
// Conventions
//   - Inputs are plain arrays. Non-finite entries (null, undefined, NaN, ±Infinity, non-numbers) are
//     IGNORED everywhere (for paired data the whole pair is ignored). Inputs are never mutated.
//   - "No answer" is `null` (never NaN), so results can be compared (`r2 >= 0.3` is simply false) and
//     serialised without surprises.
//   - Time series points are `{t, v}` with `t` in epoch SECONDS (usage records, addendum §3.5); any
//     monotonic unit works as long as it is consistent.
//
// Exports (addendum §7.1 contract first, then helpers other modules may use):
//   mean(a), median(a), mad(a), quantile(a, q)
//   ols(xs, ys)            → {a, b, n, xMean, yMean, sxx, sxy, syy, sse, se, sigma, r2} | null
//                            (null when fewer than 3 finite pairs or Sxx = 0 / all x equal)
//                            b = Sxy/Sxx, a = ȳ − b·x̄, sse = Σe², se = se_b = √(SSE/(n−2)/Sxx),
//                            sigma = √(SSE/(n−2)), r2 = 1 − SSE/Syy (0 when Syy = 0: nothing to explain)
//   robustOls(xs, ys, {floorF = 1.0, k = 3})
//                          → ols + {dropped, droppedIdx} | null — ONE robust pass (§4.6): residuals e of
//                            the first fit, MAD = median|e − median(e)|, drop points whose residual is
//                            more than max(floorF, k·1.4826·MAD) from median(e), refit when anything
//                            was dropped (null if the refit is impossible). droppedIdx are indices into
//                            the ORIGINAL arrays. NOTE: §4.6 writes |e| > thr; measuring from median(e)
//                            is identical for centred residuals but does not throw away every good point
//                            when one big spike drags a small-sample fit (n ≈ 6–10) off by > floorF.
//   pearson(xs, ys)        → r ∈ [−1, 1] | null (n < 3, Sxx = 0 or Syy = 0)
//   interp(points, t)      → linear interpolation on [{t, v}] | null outside the covered span
//   meanOver(points, t0, t1, {full = false})
//                          → time-weighted mean of the piecewise-linear series over [t0, t1] clipped to
//                            the covered span | null (no overlap; or, with full:true, when the series
//                            does not cover all of [t0, t1])
//   stableStringify(obj, {digits = 6})
//                          → JSON with sorted object keys and fixed number formatting: integers
//                            verbatim, other numbers rounded to `digits` decimals, −0 → 0,
//                            NaN/±Infinity → null. Byte-identical for equal inputs.
//   sum(a), minMax(a), round(x, digits), clamp(x, lo, hi)
//   BUCKET_SEC (300), bucketStart(t, stepSec), bucketMeans(points, t0, t1, stepSec), groupMeans(values, size)

export const BUCKET_SEC = 300 // the 5-minute usage bucket (addendum §3.3)
const MAD_SCALE = 1.4826 // MAD → σ for normal residuals

function isNum(v) { return typeof v === 'number' && Number.isFinite(v) }

function finite(a) {
  const out = []
  if (a == null || typeof a[Symbol.iterator] !== 'function') return out
  for (const v of a) if (isNum(v)) out.push(v)
  return out
}

function sortedCopy(a) { return finite(a).sort((x, y) => x - y) }

// type-7 (R default / numpy 'linear') quantile of an already sorted, non-empty array.
function quantileSorted(s, q) {
  if (s.length === 1) return s[0]
  const h = (s.length - 1) * q
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return lo === hi ? s[lo] : s[lo] + (h - lo) * (s[hi] - s[lo])
}

/** Σ of the finite entries (0 for none). */
export function sum(a) {
  let s = 0
  for (const v of finite(a)) s += v
  return s
}

/** Arithmetic mean of the finite entries | null. */
export function mean(a) {
  const f = finite(a)
  if (!f.length) return null
  let s = 0
  for (const v of f) s += v
  return s / f.length
}

/** Type-7 quantile, q clamped to [0, 1] | null. */
export function quantile(a, q) {
  const s = sortedCopy(a)
  if (!s.length || !isNum(q)) return null
  return quantileSorted(s, Math.min(1, Math.max(0, q)))
}

/** Median of the finite entries | null. */
export function median(a) { return quantile(a, 0.5) }

/** Raw median absolute deviation, median|x − median(x)| (unscaled) | null. */
export function mad(a) {
  const f = finite(a)
  if (!f.length) return null
  const m = median(f)
  return median(f.map((v) => Math.abs(v - m)))
}

/** {min, max} of the finite entries | null. */
export function minMax(a) {
  const f = finite(a)
  if (!f.length) return null
  let min = f[0]
  let max = f[0]
  for (const v of f) { if (v < min) min = v; if (v > max) max = v }
  return { min, max }
}

/** Round half away from zero to `digits` decimals (null/non-finite → null). */
export function round(x, digits = 1) {
  if (!isNum(x)) return null
  const r = Number((Math.sign(x) * Math.round(Math.abs(x) * 10 ** digits) / 10 ** digits).toFixed(digits))
  return Object.is(r, -0) ? 0 : r
}

/** Clamp into [lo, hi]; either bound may be null/undefined (open). */
export function clamp(x, lo, hi) {
  let v = x
  if (lo != null && v < lo) v = lo
  if (hi != null && v > hi) v = hi
  return v
}

// ---- regression ---------------------------------------------------------------------------------

// Finite (x, y) pairs with their original indices.
function pairs(xs, ys) {
  const px = []
  const py = []
  const idx = []
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0)
  for (let i = 0; i < n; i++) {
    if (isNum(xs[i]) && isNum(ys[i])) { px.push(xs[i]); py.push(ys[i]); idx.push(i) }
  }
  return { px, py, idx }
}

// OLS on clean arrays (two-pass centred sums: numerically stable for epoch-sized x).
function fit(px, py) {
  const n = px.length
  if (n < 3) return null
  let minX = px[0]
  let maxX = px[0]
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    const x = px[i]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    sx += x
    sy += py[i]
  }
  // All x equal (or equal to within float resolution) ⇒ slope undefined.
  if (maxX - minX <= 1e-12 * Math.max(1, Math.abs(maxX), Math.abs(minX))) return null
  const xMean = sx / n
  const yMean = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = px[i] - xMean
    const dy = py[i] - yMean
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (!(sxx > 0)) return null
  const b = sxy / sxx
  const a = yMean - b * xMean
  let sse = 0
  for (let i = 0; i < n; i++) {
    const e = py[i] - a - b * px[i]
    sse += e * e
  }
  const sigma = Math.sqrt(sse / (n - 2))
  const se = Math.sqrt(sse / (n - 2) / sxx)
  const r2 = syy > 0 ? clamp(1 - sse / syy, 0, 1) : 0
  return { a, b, n, xMean, yMean, sxx, sxy, syy, sse, se, sigma, r2 }
}

/**
 * Ordinary least squares y = a + b·x over the finite pairs.
 * → {a, b, n, xMean, yMean, sxx, sxy, syy, sse, se, sigma, r2} | null (n < 3 or Sxx = 0).
 */
export function ols(xs, ys) {
  const { px, py } = pairs(xs, ys)
  return fit(px, py)
}

/**
 * OLS with one MAD outlier pass (addendum §4.6): drop points with |e − median(e)| > max(floorF,
 * k·1.4826·MAD(e)) and refit if anything was dropped. → ols + {dropped, droppedIdx} | null.
 */
export function robustOls(xs, ys, { floorF = 1.0, k = 3 } = {}) {
  const { px, py, idx } = pairs(xs, ys)
  const first = fit(px, py)
  if (!first) return null
  const e = px.map((x, i) => py[i] - first.a - first.b * x)
  const center = median(e) ?? 0
  const m = mad(e) ?? 0
  const thr = Math.max(Number(floorF) || 0, (Number(k) || 0) * MAD_SCALE * m)
  const kx = []
  const ky = []
  const droppedIdx = []
  for (let i = 0; i < px.length; i++) {
    if (Math.abs(e[i] - center) > thr) droppedIdx.push(idx[i])
    else { kx.push(px[i]); ky.push(py[i]) }
  }
  if (!droppedIdx.length) return { ...first, dropped: 0, droppedIdx }
  const second = fit(kx, ky)
  if (!second) return null
  return { ...second, dropped: droppedIdx.length, droppedIdx }
}

/** Pearson correlation of the finite pairs | null (n < 3, Sxx = 0 or Syy = 0). */
export function pearson(xs, ys) {
  const { px, py } = pairs(xs, ys)
  const n = px.length
  if (n < 3) return null
  const xm = px.reduce((s, v) => s + v, 0) / n
  const ym = py.reduce((s, v) => s + v, 0) / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = px[i] - xm
    const dy = py[i] - ym
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  if (!(sxx > 0) || !(syy > 0)) return null
  return clamp(sxy / Math.sqrt(sxx * syy), -1, 1)
}

// ---- time series --------------------------------------------------------------------------------

// Finite {t, v} points sorted by t (stable: equal t keep input order). Returns the input's own
// filtered copy; the caller's array is never reordered.
function series(points) {
  const out = []
  if (!Array.isArray(points)) return out
  let sorted = true
  for (const p of points) {
    if (!p || !isNum(p.t) || !isNum(p.v)) continue
    if (out.length && p.t < out[out.length - 1].t) sorted = false
    out.push({ t: p.t, v: p.v })
  }
  if (!sorted) out.sort((a, b) => a.t - b.t)
  return out
}

// Index of the last point with p.t <= t (−1 when t precedes every point).
function lastAtOrBefore(s, t) {
  let lo = 0
  let hi = s.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s[mid].t <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function interpSorted(s, t) {
  if (!s.length || t < s[0].t || t > s[s.length - 1].t) return null
  const i = lastAtOrBefore(s, t)
  const p = s[i]
  if (p.t === t || i === s.length - 1) return p.v
  const q = s[i + 1]
  return p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t)
}

/** Linear interpolation on [{t, v}] at t | null outside [first.t, last.t] or without points. */
export function interp(points, t) {
  if (!isNum(t)) return null
  return interpSorted(series(points), t)
}

/**
 * Time-weighted mean of the piecewise-linear series over [t0, t1] ∩ [first.t, last.t].
 * `full: true` ⇒ null unless the series spans all of [t0, t1]. Zero-length overlap ⇒ the
 * interpolated value at that instant. | null.
 */
export function meanOver(points, t0, t1, { full = false } = {}) {
  if (!isNum(t0) || !isNum(t1) || t1 < t0) return null
  const s = series(points)
  if (!s.length) return null
  const first = s[0].t
  const last = s[s.length - 1].t
  if (full && (first > t0 || last < t1)) return null
  const lo = Math.max(t0, first)
  const hi = Math.min(t1, last)
  if (hi < lo) return null
  if (hi === lo) return interpSorted(s, lo)
  let area = 0
  for (let i = Math.max(0, lastAtOrBefore(s, lo)); i < s.length - 1; i++) {
    const p = s[i]
    const q = s[i + 1]
    if (p.t >= hi) break
    const a = Math.max(p.t, lo)
    const b = Math.min(q.t, hi)
    if (b <= a) continue
    const va = p.v + ((q.v - p.v) * (a - p.t)) / (q.t - p.t)
    const vb = p.v + ((q.v - p.v) * (b - p.t)) / (q.t - p.t)
    area += ((va + vb) / 2) * (b - a)
  }
  return area / (hi - lo)
}

// ---- buckets ------------------------------------------------------------------------------------

/** Start of the grid bucket containing t (grid anchored at t = 0; 5-min buckets by default). */
export function bucketStart(t, stepSec = BUCKET_SEC) {
  if (!isNum(t) || !(stepSec > 0)) return null
  return Math.floor(t / stepSec) * stepSec
}

/**
 * Arithmetic means of point values per bucket over [t0, t1): →
 * [{t: bucketStart, mean: number|null, n}] with ceil((t1 − t0)/stepSec) entries. Points outside
 * [t0, t1) are ignored; an empty bucket has mean null.
 */
export function bucketMeans(points, t0, t1, stepSec = BUCKET_SEC) {
  if (!isNum(t0) || !isNum(t1) || !(stepSec > 0) || t1 <= t0) return []
  const len = Math.ceil((t1 - t0) / stepSec)
  const sums = new Array(len).fill(0)
  const counts = new Array(len).fill(0)
  if (Array.isArray(points)) {
    for (const p of points) {
      if (!p || !isNum(p.t) || !isNum(p.v) || p.t < t0 || p.t >= t1) continue
      const i = Math.floor((p.t - t0) / stepSec)
      sums[i] += p.v
      counts[i]++
    }
  }
  const out = new Array(len)
  for (let i = 0; i < len; i++) out[i] = { t: t0 + i * stepSec, mean: counts[i] ? sums[i] / counts[i] : null, n: counts[i] }
  return out
}

/**
 * Means of consecutive groups of `size` values (null entries skipped; an all-null group → null).
 * E.g. 288 five-minute values → 96 fifteen-minute values with size 3 (the rollup spark series).
 */
export function groupMeans(values, size = 3) {
  const n = Math.max(1, Math.floor(Number(size) || 1))
  const out = []
  if (!Array.isArray(values)) return out
  for (let i = 0; i < values.length; i += n) out.push(mean(values.slice(i, i + n)))
  return out
}

// ---- stable JSON --------------------------------------------------------------------------------

function fmtNumber(x, digits) {
  if (!Number.isFinite(x)) return 'null'
  if (Number.isInteger(x)) return Object.is(x, -0) ? '0' : String(x)
  let r = Number(x.toFixed(digits))
  if (Object.is(r, -0)) r = 0
  return JSON.stringify(r)
}

/**
 * Deterministic JSON: object keys sorted (code-unit order), numbers with fixed rounding, otherwise
 * JSON.stringify semantics (toJSON honoured, undefined/functions/symbols dropped from objects and
 * null in arrays, BigInt and cycles throw TypeError).
 */
export function stableStringify(obj, { digits = 6 } = {}) {
  const d = Math.max(0, Math.min(15, Math.floor(Number(digits))))
  const stack = new Set()
  function enc(value, key) {
    let v = value
    if (v !== null && typeof v === 'object' && typeof v.toJSON === 'function') v = v.toJSON(key)
    else if (typeof v === 'bigint') throw new TypeError('stableStringify: BigInt is not serialisable')
    if (v === null) return 'null'
    switch (typeof v) {
      case 'number': return fmtNumber(v, d)
      case 'string': return JSON.stringify(v)
      case 'boolean': return v ? 'true' : 'false'
      case 'bigint': throw new TypeError('stableStringify: BigInt is not serialisable')
      case 'object': break
      default: return undefined // undefined, function, symbol
    }
    if (stack.has(v)) throw new TypeError('stableStringify: circular structure')
    stack.add(v)
    let out
    if (Array.isArray(v)) {
      out = '[' + v.map((item, i) => enc(item, String(i)) ?? 'null').join(',') + ']'
    } else {
      const parts = []
      for (const k of Object.keys(v).sort()) {
        const s = enc(v[k], k)
        if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s)
      }
      out = '{' + parts.join(',') + '}'
    }
    stack.delete(v)
    return out
  }
  return enc(obj, '')
}
