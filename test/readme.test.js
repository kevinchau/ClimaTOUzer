// test/readme.test.js — the README stays true: its quick start is examples/quickstart.js (importing the package by
// name), running that file prints exactly the output block the README shows, and the API reference names every
// export of every module.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as api from '../index.js'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const EXAMPLE = fileURLToPath(new URL('../examples/quickstart.js', import.meta.url))

function block(lang, after) {
  const from = README.indexOf(after)
  assert.ok(from >= 0, `README has "${after}"`)
  const open = README.indexOf('```' + lang + '\n', from)
  assert.ok(open >= 0, `a ${lang} block after "${after}"`)
  const start = open + lang.length + 4
  return README.slice(start, README.indexOf('\n```', start))
}

test('the quick start is examples/quickstart.js, importing the package by name', () => {
  const example = readFileSync(EXAMPLE, 'utf8').trimEnd().replace("from '../index.js'", "from 'climatouzer'")
  assert.equal(block('js', '## Quick start'), example)
})

test('running the quick start prints exactly the output the README shows', () => {
  const r = spawnSync(process.execPath, [EXAMPLE], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Tokyo' } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trimEnd(), block('text', 'Output ('))
})

test('the API reference names every export of every module', () => {
  const namespaces = ['tou', 'holidays', 'tz', 'tuning', 'rollup', 'optimizer', 'stats', 'explain', 'labels', 'records', 'validation']
  const missing = []
  for (const ns of namespaces) {
    for (const name of Object.keys(api[ns])) if (!new RegExp('`[^`]*\\b' + name + '\\b[^`]*`').test(README)) missing.push(`${ns}.${name}`)
  }
  for (const name of Object.keys(api)) if (!namespaces.includes(name) && !README.includes('`' + name)) missing.push(name)
  assert.deepEqual(missing, [])
})
