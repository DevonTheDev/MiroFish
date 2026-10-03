import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Execute the production wrappers; only the HTTP service boundary is observed.
const source = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const build = service => new Function('service', source + '\nreturn { getComparisonCandidates, compareSavedSimulations };')(service)

test('comparison API wrappers use only GET, preserve IDs as query params and forward optional signals', async () => {
  const calls = [], service = { get: (...args) => { calls.push(args); return Promise.resolve({ success: true }) } }
  const api = build(service), controller = new AbortController()
  await api.getComparisonCandidates(controller.signal)
  await api.compareSavedSimulations('sim_A', 'sim_B', controller.signal)
  await api.getComparisonCandidates()
  await api.compareSavedSimulations('literal?left=other', 'literal&right=other')
  assert.deepEqual(calls, [
    ['/api/simulation/comparison/candidates', { signal: controller.signal }],
    ['/api/simulation/comparison', { params: { left: 'sim_A', right: 'sim_B' }, signal: controller.signal }],
    ['/api/simulation/comparison/candidates', { signal: undefined }],
    ['/api/simulation/comparison', { params: { left: 'literal?left=other', right: 'literal&right=other' }, signal: undefined }],
  ])
})
