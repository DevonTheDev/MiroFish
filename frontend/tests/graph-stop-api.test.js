import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/api/graph.js', import.meta.url), 'utf8')
const api = service => vm.runInNewContext(source.replace(/^import .*$/gm, '')
  .replace(/^export function /gm, 'function ') + '\n;({stopGraphBuild})', { service })

test('graph Stop wrapper encodes the project and sends only the exact task identity', async () => {
  const calls = [], controller = new AbortController()
  const wrappers = api(request => { calls.push(request); return Promise.resolve({ success: true }) })
  await wrappers.stopGraphBuild('project/A ?', 'task-exact', controller.signal)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/graph/project/project%2FA%20%3F/build/stop')
  assert.equal(calls[0].method, 'post')
  assert.equal(calls[0].data.task_id, 'task-exact')
  assert.deepEqual(Object.keys(calls[0].data), ['task_id'])
  assert.equal(calls[0].signal, controller.signal)
})

test('graph Stop wrapper never automatically retries an uncertain mutation', async () => {
  const calls = [], failure = new Error('response lost')
  const wrappers = api(request => { calls.push(request); return Promise.reject(failure) })
  await assert.rejects(wrappers.stopGraphBuild('A', 'task-A'), error => error === failure)
  assert.equal(calls.length, 1)
})
