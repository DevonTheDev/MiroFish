import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Evaluate only the actual API wrapper definitions with a controlled transport.
const source = readFileSync(new URL('../src/api/report.js', import.meta.url), 'utf8')
const api = service => vm.runInNewContext(source.replace(/^import .*$/gm, '')
  .replace(/^export const /gm, 'const ') + '\n;({getReportProgress, getReportSections, cancelReport, generateReport})', { service })

test('report stop API uses exact encoded report paths and forwards observation signals', async () => {
  const calls = [], controller = new AbortController()
  const wrappers = api({ get: (...args) => { calls.push(['get', ...args]); return Promise.resolve({ success: true }) },
    post: (...args) => { calls.push(['post', ...args]); return Promise.resolve({ success: true }) } })
  await wrappers.getReportProgress('report/A ?', controller.signal)
  await wrappers.getReportSections('report/A ?', controller.signal)
  await wrappers.cancelReport('report/A ?', controller.signal)
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ['get', '/api/report/report%2FA%20%3F/progress'],
    ['get', '/api/report/report%2FA%20%3F/sections'],
    ['post', '/api/report/report%2FA%20%3F/cancel'],
  ])
  assert.equal(calls[0][2].signal, controller.signal)
  assert.equal(calls[1][2].signal, controller.signal)
  assert.equal(calls[2][3].signal, controller.signal)
  assert.equal(Object.keys(calls[2][2]).length, 0)
})

test('report stop API sends one mutation and never retries a lost response', async () => {
  const calls = [], failure = new Error('response lost')
  const wrappers = api({ post: (...args) => { calls.push(args); return Promise.reject(failure) } })
  await assert.rejects(wrappers.cancelReport('A'), error => error === failure)
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/api/report/A/cancel')
  await assert.rejects(wrappers.generateReport({ simulation_id: 'SA', force_regenerate: true }), error => error === failure)
  assert.equal(calls.length, 2); assert.equal(calls[1][0], '/api/report/generate')
  assert.equal(calls[1][1].simulation_id, 'SA'); assert.equal(calls[1][1].force_regenerate, true)
})
