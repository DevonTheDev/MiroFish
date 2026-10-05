import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { trialApi, trialSnapshot, runId, ok, waitFor, mountTrials } from './helpers/prompt-trials-view-fixture.js'
import { parsePromptTrialFile } from '../src/utils/promptTrialFiles.js'

const instanceId = '22345678-1234-4234-9234-123456789abc'
const target = () => ({ request_id: runId, instance_id: instanceId, fingerprint: 'a'.repeat(64) })
const cancelled = (state = 'cancelled') => {
  const data = trialSnapshot(state)
  Object.assign(data.run, { instance_id: instanceId, error_code: 'user_cancelled', response: null })
  if (state === 'running') data.run.cleanup.state = 'running'
  return data
}

test('optional instance identity is projected exactly without changing old snapshots', () => {
  const api = trialApi(), old = trialSnapshot('succeeded')
  assert.deepEqual(api.acceptPromptTrialSnapshot(ok(old)), old)
  const live = trialSnapshot('running'); live.run.instance_id = instanceId
  assert.equal(api.acceptPromptTrialSnapshot(ok(live)).run.instance_id, instanceId)
  for (const value of [null, '', 1, 'x', instanceId.toUpperCase()]) {
    live.run.instance_id = value
    assert.throws(() => api.acceptPromptTrialSnapshot(ok(live)), /Invalid/)
  }
})

test('user_cancelled accepts only running cleanup or cancelled outcomes without a reply', () => {
  const api = trialApi()
  for (const state of ['running', 'cancelled']) {
    const data = cancelled(state)
    assert.deepEqual(api.acceptPromptTrialSnapshot(ok(data)), data)
    data.run.response = trialSnapshot('succeeded').run.response
    assert.throws(() => api.acceptPromptTrialSnapshot(ok(data)), /Invalid/)
  }
  for (const state of ['succeeded', 'failed', 'timed_out']) {
    const data = cancelled(state)
    assert.throws(() => api.acceptPromptTrialSnapshot(ok(data)), /Invalid/)
  }
  const failed = trialSnapshot('failed')
  Object.assign(failed.run, { instance_id: instanceId, error_code: 'cleanup_failed', response: null })
  failed.run.cleanup.state = 'failed'
  assert.equal(api.acceptPromptTrialSnapshot(ok(failed)).run.error_code, 'cleanup_failed')
})

test('old and cancelled terminal trial files round-trip with optional nonce; running files remain historical-invalid', () => {
  for (const data of [trialSnapshot('succeeded'), cancelled()]) {
    assert.deepEqual(parsePromptTrialFile(JSON.stringify(data)).snapshots[0], data)
  }
  assert.throws(() => parsePromptTrialFile(JSON.stringify(cancelled('running'))), /Invalid/)
})

async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('real Axios cancellation sends exact target URL and body once and drops unrelated private fields', async t => {
  const seen = [], logs = []
  const baseURL = await serverFor(t, (request, response) => {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => {
      seen.push({ method: request.method, url: request.url, body, headers: request.headers })
      response.writeHead(202, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(ok(cancelled('running'))))
    })
  })
  const api = trialApi({ baseURL, logger: { error: (...args) => logs.push(args), log: (...args) => logs.push(args) } })
  assert.equal(typeof api.cancelPromptTrial, 'function')
  const result = await api.cancelPromptTrial({ ...target(), secret: 'PRIVATE', user_prompt: 'PRIVATE', state: 'running' }, new AbortController().signal)
  assert.equal(result.data.run.error_code, 'user_cancelled')
  assert.equal(seen.length, 1); assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, `/api/runtime/trials/${runId}/cancel`)
  assert.deepEqual(JSON.parse(seen[0].body), { instance_id: instanceId, fingerprint: 'a'.repeat(64) })
  assert.equal(seen[0].headers.origin, undefined); assert.equal(seen[0].headers['sec-fetch-site'], undefined)
  assert.deepEqual(logs, [])
})

test('invalid cancellation identities never reach the transport', () => {
  const api = trialApi()
  assert.equal(typeof api.cancelPromptTrial, 'function')
  for (const value of [null, {}, [], ...['request_id', 'instance_id', 'fingerprint'].flatMap(field =>
    [undefined, null, '', 'PRIVATE', target()[field].toUpperCase()].map(v => ({ ...target(), [field]: v })))]) {
    assert.throws(() => api.cancelPromptTrial(value), /Invalid/)
  }
})

test('real Axios cancellation honors AbortSignal without repeat POSTs or private error logging', async t => {
  let seen = 0, closed = false
  const logs = []
  const baseURL = await serverFor(t, (_request, response) => { seen++; response.on('close', () => { closed = true }) })
  const api = trialApi({ baseURL, logger: { error: (...args) => logs.push(args), log: (...args) => logs.push(args) } })
  assert.equal(typeof api.cancelPromptTrial, 'function')
  const controller = new AbortController()
  const pending = assert.rejects(api.cancelPromptTrial(target(), controller.signal), error => axios.isCancel(error))
  await waitFor(() => seen === 1); controller.abort(); await pending; await waitFor(() => closed)
  assert.equal(seen, 1); assert.deepEqual(logs, [])
})

test('real Axios cancellation failures expose no raw server error logs or automatic retry', async t => {
  const logs = []; let seen = 0
  const baseURL = await serverFor(t, (_request, response) => {
    seen++; response.writeHead(409, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: false, error: 'PRIVATE', error_code: 'request_conflict' }))
  })
  const api = trialApi({ baseURL, logger: { error: (...args) => logs.push(args), log: (...args) => logs.push(args) } })
  await assert.rejects(api.cancelPromptTrial(target()))
  assert.equal(seen, 1); assert.deepEqual(logs, [])
})

test('compiled Vue route leave aborts actual Axios stop transport without sending any extra request', async t => {
  const seen = []; let closed = false
  const baseURL = await serverFor(t, (request, response) => {
    seen.push([request.method, request.url])
    if (request.method === 'GET') {
      const data = trialSnapshot('running'); data.run.instance_id = instanceId
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(ok(data)))
    } else response.on('close', () => { closed = true })
  })
  const v = await mountTrials({ api: trialApi({ baseURL }) })
  try {
    await waitFor(() => !!v.byId('trial-stop')); await v.click('trial-stop')
    await waitFor(() => seen.length === 2); await v.navigate('/'); await waitFor(() => closed)
    assert.deepEqual(seen, [['GET', '/api/runtime/trials'], ['POST', `/api/runtime/trials/${runId}/cancel`]])
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})
