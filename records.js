// records.js — the usage-record format rollup.rollupDay() reads (addendum §3.5), and the one mapping from a
// host's action lines to `a` records. PURE: no I/O, no clock.
//
// Records are plain objects, one per line in a host's daily log; `t` = integer epoch SECONDS (UTC); a record belongs
// to the log of the LOCAL date of its `t`. `k` names the kind:
//   s  a 5-minute sample bucket of one unit: {k:'s', t (bucket start, on the 300 s epoch grid), u, r (mean room °F |
//      null), n (reads), cv (covered s), on (s running), p (1|0 power at the bucket end), m (mode), sp (setpoint), f (fan)}
//   c  a settings change of one unit: {k:'c', t, u, f:'power'|'mode'|'temp'|'fan', o (from), v (to),
//      s:'schedule'|'user'|'system'|'external', e (event id active for the unit | null), gap (s without reads | null)}
//   o  an outdoor temperature: {k:'o', t, f (°F)}
//   a  an action line (mirrorActivity below): {k:'a', t, u, ty, ac, e, f, fr, to, res, ph, se, par, cl, why, …}
//   p  a tuning change: {k:'p', t, u, se, pa:'deltaF'|'leadMin', fr, to, s:'optimizer'|'user'|'revert'|'undo'|'reset'|
//      'system', id}
//   b  a boot snapshot of one unit: {k:'b', t, u, p, m, sp, f, r, boot}
//   h  a boot header: {k:'h', t, boot}
//
// mirrorActivity(entry, nowMs) → the `a` record of an action line, or null when its type is not mirrored. Action lines
// use the reference app's activity vocabulary (MIRRORED_TYPES): phase_enter / phase_exit (phase 'precondition'|'shed'|
// 'restoring', with params {deltaF, leadMin, season}), take (the automation takes a field: original → applied),
// write (from → to, result 'verified'|…), released / drop / deferred (a person's override), notice, forced /
// unforced (a multi-split master rewrote a follower's mode), tuning_* and the device/job lines. rollup reads the
// episode story from them (see rollup.js). `nowMs` stamps a line without a parsable `ts`.

export const RECORD_KINDS = Object.freeze(['s', 'c', 'o', 'a', 'p', 'b', 'h'])
/**
 * Activity types mirrored as `a` records (§3.5); `notice` only for precondition_* codes and for dryout_skipped with
 * reason follower_running / master_conditioning (addendum C §3.4); any `tuning_*` too.
 */
export const MIRRORED_TYPES = Object.freeze([
  'take', 'write', 'would_write', 'verify_fail', 'retry', 'failing', 'blocked', 'recovered', 'drop', 'released',
  'resumed', 'restored', 'skipped', 'deferred', 'phase_enter', 'phase_exit', 'notice', 'device_offline', 'device_online',
  'tuning_changed', 'tuning_proposed', 'tuning_deferred', 'tuning_reverted', 'tuning_undone', 'tuning_reset',
  'tuning_suspended', 'tuning_resumed', 'tuning_cancelled', 'tuning_superseded',
  'schedule_entry', 'forced', 'unforced', // Release 4 (addenda B F3, C §3.4)
])

const MIRROR_SET = new Set(MIRRORED_TYPES)

const sec = (ms) => Math.floor(ms / 1000)
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)

/** Scalar for an `a` record: short string, finite number, boolean — anything else null (keeps lines ≤ 200 B). */
function scalar(v) {
  if (v == null) return null
  if (typeof v === 'string') return v.length > 32 ? v.slice(0, 32) : v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v
  return null
}

/**
 * Activity entry → `a` record (§3.5) or null when the type is not mirrored. PURE. `to` = the entry's to / applied,
 * or the person's value where the host logs it under its own key (deferred `value`, drop `live`): rollup's override
 * `v` and comfortDir read it (§4.6). `fr` = from ?? original (a RETARGET's take line carries `from`, the value it
 * was written over). `dry: true` is appended only for a phase entered in dry run (entry.dryRun, the host's
 * phase_enter): rollup marks that episode 'dry' (§4.6). `rs` (addendum B §4) is appended only for a `take` line
 * with a reason: 'dry-out ended by you' is the one thing that tells the person's early end of a fan-only dry-out
 * from its deadline ('dry-out over'), and rollup ends the episode's fanOnly there. Every other line keeps the fixed
 * §3.5 key set, except these Release 4 keys (each only on the lines named):
 *   bs  a `take` line's `base` (addendum B F3.11: the entry setpoint a precondition bump was computed from;
 *       rollup's pre.orig = bs ?? fr)
 *   rs  also a `phase_enter` line's `reason` (C CD-6: 'adopted_fan' / 'carried_dryout' start the episode's fanOnly)
 *       and a mirrored `notice` line's `reason` (CD-11: rollup's preSkipped 'already conditioned', the master's
 *       dryoutSkipped reason)
 *   by  a `forced` / `unforced` line's master (C §3.4); `ss` a `forced` line's sameSeason; `rs` a `forced` line's
 *       cause ('master'|'app', rollup's tail.forced) and an `unforced` line's `how` (rollup pairs an outside mode
 *       change with the forced lines, never with how 'person', C6.7)
 * A `precondition_skipped` notice mirrors `fr` = its bump target (the silent 'already conditioned' line: `to` = the
 * setpoint it keeps); a `dryout_skipped` notice `to` = its units joined with ',' (up to 96 characters).
 */
export function mirrorActivity(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return null
  const ty = entry.type
  if (typeof ty !== 'string') return null
  if (!MIRROR_SET.has(ty) && !ty.startsWith('tuning_')) return null
  const code = String(entry.code ?? '')
  const dryoutSkip = code === 'dryout_skipped' && (entry.reason === 'follower_running' || entry.reason === 'master_conditioning')
  if (ty === 'notice' && !code.startsWith('precondition_') && !dryoutSkip) return null
  const tsMs = typeof entry.ts === 'number' ? entry.ts : Date.parse(entry.ts)
  const t = sec(Number.isFinite(tsMs) ? tsMs : nowMs)
  const par = entry.params && typeof entry.params === 'object'
    ? { deltaF: isNum(entry.params.deltaF) ? entry.params.deltaF : null, leadMin: isNum(entry.params.leadMin) ? entry.params.leadMin : null }
    : null
  const notice = ty === 'notice'
  let fr = scalar(entry.from ?? entry.original)
  let to = scalar(entry.to ?? entry.applied ?? entry.value ?? entry.live)
  if (notice && code === 'precondition_skipped') fr = scalar(entry.target)
  if (notice && dryoutSkip) to = Array.isArray(entry.units) ? entry.units.map(String).join(',').slice(0, 96) : null
  return {
    k: 'a', t, u: scalar(entry.unit), ty, ac: scalar(entry.actor), e: scalar(entry.event),
    f: scalar(entry.field ?? entry.param), fr, to,
    res: scalar(entry.result), ph: scalar(entry.phase), se: scalar(entry.season ?? entry.params?.season), par,
    cl: scalar(entry.class ?? entry.lastError?.class ?? entry.error?.class), why: scalar(entry.code),
    ...(entry.dryRun === true ? { dry: true } : {}),
    ...((ty === 'take' || ty === 'phase_enter' || notice) && entry.reason != null ? { rs: scalar(entry.reason) } : {}),
    ...(ty === 'take' && entry.base != null ? { bs: scalar(entry.base) } : {}),
    ...(ty === 'forced' || ty === 'unforced' ? { by: scalar(entry.by) } : {}),
    ...(ty === 'forced' ? { ss: entry.sameSeason === true } : {}),
    ...(ty === 'forced' && entry.cause != null ? { rs: scalar(entry.cause) } : {}),
    ...(ty === 'unforced' && entry.how != null ? { rs: scalar(entry.how) } : {}),
  }
}
