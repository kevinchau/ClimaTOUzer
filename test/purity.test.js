// test/purity.test.js — every module of the library is pure and self-contained: it imports only sibling modules (no
// Node built-ins, no packages, nothing outside the library), never reads the clock (Date.now(), new Date() without an
// argument), never uses randomness or the process, and never calls a process-local Date getter.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const DIR = new URL('../', import.meta.url)
const modules = readdirSync(DIR).filter((f) => f.endsWith('.js'))

test('the library has its modules at the package root', () => {
  for (const m of ['tou.js', 'tuning.js', 'rollup.js', 'optimizer.js', 'stats.js', 'tz.js', 'holidays.js']) assert.ok(modules.includes(m), m)
})

test('modules import only their siblings', () => {
  for (const f of modules) {
    const src = readFileSync(new URL(f, DIR), 'utf8')
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      const spec = m[1] ?? m[2]
      assert.match(spec, /^\.\/[a-z-]+\.js$/, `${f} imports ${spec}`)
      assert.ok(modules.includes(spec.slice(2)), `${f} imports ${spec}, which is not a library module`)
    }
  }
})

test('modules never read the clock, the process, randomness or process-local Date getters', () => {
  const banned = /Date\.now\(|new Date\(\)|\.get(Hours|Minutes|Seconds|Date|Day|Month|FullYear|TimezoneOffset)\(|toLocale(Time|Date)?String\(|\bprocess\.|Math\.random/
  for (const f of modules) {
    const lines = readFileSync(new URL(f, DIR), 'utf8').split('\n')
    lines.forEach((l, i) => { if (!/^\s*(\/\/|\*)/.test(l)) assert.doesNotMatch(l, banned, `${f}:${i + 1}`) })
  }
})
