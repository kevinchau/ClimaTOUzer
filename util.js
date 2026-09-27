// util.js — small pure helpers shared by the core modules (a host may re-export them).
//
// clamp(v, lo, hi) → v clamped into [lo, hi]; either bound may be null/undefined (open).
// roundToStep(v, step = 1) → the nearest multiple of `step`, free of float noise (71.00000001 → 71).
// approxEqual(field, a, b, tempToleranceF = 0.6) → THE equality used for "live ≈ target": enums (power, mode, fan,
//   vane, preset) compare case-insensitively and exactly; temperatures (temp, room, setpoint, sp) within the
//   tolerance, inclusive; null/undefined equal only each other.

const NUMERIC_FIELDS = new Set(['temp', 'room', 'setpoint', 'sp'])

/**
 * Equality used for "live ≈ target". Enums (power, mode, fan, vane, preset) compare
 * case-insensitively and exactly; temps compare within `tempToleranceF` (inclusive, default 0.6).
 * null/undefined equal only each other.
 */
export function approxEqual(field, a, b, tempToleranceF = 0.6) {
  if (a == null || b == null) return a == null && b == null
  if (NUMERIC_FIELDS.has(field)) {
    const x = Number(a)
    const y = Number(b)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    const tol = tempToleranceF == null ? 0.6 : Number(tempToleranceF)
    return Math.abs(x - y) <= tol + 1e-9
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a).toUpperCase() === String(b).toUpperCase()
}

/** Clamp v into [lo, hi] (either bound may be null/undefined = open). */
export function clamp(v, lo, hi) {
  let x = v
  if (lo != null && x < lo) x = lo
  if (hi != null && x > hi) x = hi
  return x
}

/** Round to the nearest multiple of `step` (default 1), free of float noise (71.00000001 → 71). */
export function roundToStep(v, step = 1) {
  const s = Number(step) > 0 ? Number(step) : 1
  const r = Math.round(Number(v) / s) * s
  return Math.round(r * 1e6) / 1e6
}
