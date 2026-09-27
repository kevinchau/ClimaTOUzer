// test/helpers/fake-clock.js — injectable clock for tests (spec §10).
//
//   const clock = createFakeClock(Date.parse('2026-09-23T12:00:00Z'))
//   createEngine({ clock, … })                   // anything that takes {now, setTimeout, clearTimeout}
//   clock.advance(20_000)                          // sync: fires due timers in (time, creation) order
//   await clock.advanceAsync(20_000)               // same, but lets promise chains settle between timers
//
// Methods are bound, so `const { now } = clock` works. Timer handles support unref()/ref()/hasRef()/
// refresh() like Node's and coerce to their numeric id. Delays that are negative/NaN count as 0 and a
// 0 ms timer fires on the next advance(0) (unlike Node's 1 ms minimum). Date is NOT patched.
//
// API: now() · setTimeout(fn, ms, ...args) · clearTimeout(h) · setInterval(fn, ms, ...args) ·
//      clearInterval(h) · advance(ms) → fired · advanceAsync(ms, {settle}) → Promise<fired> ·
//      next() → bool (jump to and fire the next timer) · nextAsync() · runAll(limit) · runAllAsync(limit) ·
//      setNow(ms) (jump without firing — NTP step/host sleep; due timers fire on the next advance) ·
//      pending() → count · nextAt() → ms|null · flush(n) → Promise (yield to the real event loop n times)

const realSetImmediate = globalThis.setImmediate

export const DEFAULT_START = Date.parse('2026-09-23T12:00:00.000Z')

export function createFakeClock(start = DEFAULT_START) {
  let t = Number(start)
  let seq = 0
  let nextId = 1
  const timers = new Map() // id → timer

  function delayOf(ms) {
    const d = Number(ms)
    return Number.isFinite(d) && d > 0 ? d : 0
  }

  function makeTimer(fn, ms, args, interval) {
    if (typeof fn !== 'function') throw new TypeError('callback must be a function')
    const timer = {
      id: nextId++,
      when: t + delayOf(ms),
      seq: seq++,
      delay: delayOf(ms),
      fn,
      args,
      interval,
      unref() { return timer },
      ref() { return timer },
      hasRef() { return true },
      refresh() {
        timer.when = t + timer.delay
        timer.seq = seq++
        timers.set(timer.id, timer)
        return timer
      },
      [Symbol.toPrimitive]() { return timer.id },
    }
    timers.set(timer.id, timer)
    return timer
  }

  function clear(h) {
    if (h == null) return
    const key = typeof h === 'object' ? h.id : Number(h)
    timers.delete(key)
  }

  function earliest(limit) {
    let best = null
    for (const tm of timers.values()) {
      if (tm.when > limit) continue
      if (!best || tm.when < best.when || (tm.when === best.when && tm.seq < best.seq)) best = tm
    }
    return best
  }

  function fire(tm) {
    if (tm.when > t) t = tm.when
    if (tm.interval) {
      tm.when = t + Math.max(1, tm.delay)
      tm.seq = seq++
    } else {
      timers.delete(tm.id)
    }
    tm.fn(...tm.args)
  }

  async function flush(n = 5) {
    for (let i = 0; i < n; i++) await new Promise((r) => realSetImmediate(r))
  }

  const clock = {
    now: () => t,
    setTimeout: (fn, ms, ...args) => makeTimer(fn, ms, args, false),
    clearTimeout: clear,
    setInterval: (fn, ms, ...args) => makeTimer(fn, ms, args, true),
    clearInterval: clear,

    advance(ms = 0) {
      const target = t + delayOf(ms)
      let fired = 0
      for (let tm = earliest(target); tm; tm = earliest(target)) {
        if (++fired > 1e6) throw new Error('fake-clock: runaway timers')
        fire(tm)
      }
      if (target > t) t = target
      return fired
    },

    async advanceAsync(ms = 0, { settle = 5 } = {}) {
      const target = t + delayOf(ms)
      let fired = 0
      await flush(settle)
      for (let tm = earliest(target); tm; tm = earliest(target)) {
        if (++fired > 1e6) throw new Error('fake-clock: runaway timers')
        fire(tm)
        await flush(settle)
      }
      if (target > t) t = target
      await flush(settle)
      return fired
    },

    next() {
      const tm = earliest(Infinity)
      if (!tm) return false
      fire(tm)
      return true
    },

    async nextAsync({ settle = 5 } = {}) {
      await flush(settle)
      const ok = clock.next()
      await flush(settle)
      return ok
    },

    runAll(limit = 10000) {
      let n = 0
      while (n < limit && clock.next()) n++
      return n
    },

    async runAllAsync(limit = 10000, { settle = 5 } = {}) {
      let n = 0
      while (n < limit && (await clock.nextAsync({ settle }))) n++
      return n
    },

    setNow(ms) { t = Number(ms) },
    pending: () => timers.size,
    nextAt() { const tm = earliest(Infinity); return tm ? tm.when : null },
    flush,
  }
  return clock
}

export default createFakeClock
