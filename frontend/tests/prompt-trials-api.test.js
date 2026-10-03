import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { trialApi, trialSnapshot, trialRequest, runId, ok, waitFor, mountTrials } from './helpers/prompt-trials-view-fixture.js'

test('dedicated trial transport is present and keeps same-origin URLs with no raw-error logger', () => {
  assert.ok(existsSync(new URL('../src/api/promptTrials.js', import.meta.url)), 'prompt trial API must exist')
  const api = trialApi()
  assert.equal(api.service.defaults.baseURL, '')
  assert.equal(api.service.defaults.timeout, 15000)
})

test('strict projection detaches all fixed fields and preserves literal captured prompts/replies', () => {
  const data = trialSnapshot('succeeded')
  data.secret = 'SECRET'; data.limits.endpoint = 'SECRET'; data.run.request.key = 'SECRET'; data.run.configuration.api_key = 'SECRET'; data.run.response.usage.raw = 'SECRET'
  const accepted = trialApi().acceptPromptTrialSnapshot(ok(data))
  assert.doesNotMatch(JSON.stringify(accepted), /SECRET/)
  data.run.request.user_prompt = 'MUTATED'; data.run.response.usage.total_tokens = 999
  assert.equal(accepted.run.request.user_prompt, 'Hello'); assert.equal(accepted.run.response.usage.total_tokens, 15)
})

for (const [name, mutate] of [
  ['schema', d => d.schema_version = 2], ['mode', d => d.mode = 'SECRET'], ['date', d => d.observed_at = '2026-02-31T12:00:00Z'],
  ['availability', d => d.available = false], ['limit', d => d.limits.response_bytes = 65537], ['zero output cap', d => d.limits.max_output_tokens = 0],
  ['id', d => d.run.request_id = 'PRIVATE'], ['uppercase UUID', d => d.run.request_id = d.run.request_id.toUpperCase()],
  ['fingerprint', d => d.run.fingerprint = 'x'.repeat(64)], ['state', d => d.run.state = 'SECRET'],
  ['negative elapsed', d => d.run.elapsed_ms = -1], ['unfinished success', d => d.run.finished_at = null],
  ['reversed time', d => d.run.finished_at = '2026-10-03T12:00:00Z'], ['numeric duration string', d => d.run.request_duration_ms = '4'],
  ['cloud model', d => d.run.configuration.model = 'large:cloud'], ['model controls', d => d.run.configuration.model = 'x\u202e'],
  ['empty model', d => d.run.configuration.model = ''], ['large model', d => d.run.configuration.model = 'a'.repeat(257)],
  ['omitted reasoning', d => delete d.run.configuration.reasoning_effort], ['blank prompt', d => d.run.request.user_prompt = '  '],
  ['large prompt', d => d.run.request.user_prompt = 'a'.repeat(4001)], ['large system', d => d.run.request.system_prompt = 'a'.repeat(1001)],
  ['large label', d => d.run.request.label = 'a'.repeat(81)], ['temperature', d => d.run.request.temperature = 1.1],
  ['infinite temperature', d => d.run.request.temperature = Infinity], ['fractional cap', d => d.run.request.max_output_tokens = 1.2],
  ['null succeeded content', d => d.run.response.content = null], ['oversized exact response', d => d.run.response.content = 'a'.repeat(16385)],
  ['unknown finish', d => d.run.response.finish_reason = 'SECRET'], ['mismatched finish', d => d.run.response.finish_reason = 'length'],
  ['omitted usage', d => delete d.run.response.usage], ['negative usage', d => d.run.response.usage.total_tokens = -1],
  ['boolean usage', d => d.run.response.usage.prompt_tokens = false], ['missing error code', d => delete d.run.error_code],
  ['unknown error code', d => d.run.error_code = 'SECRET'], ['unfinished cleanup', d => d.run.cleanup.state = 'running'],
  ['missing run', d => delete d.run], ['cloud private run', d => { d.mode = 'cloud'; d.available = false; d.unavailable_code = 'local_mode_required' }],
]) test(`invalid trial ${name} is rejected`, () => {
  const d = trialSnapshot('succeeded'); mutate(d)
  assert.throws(() => trialApi().acceptPromptTrialSnapshot(ok(d)), /Invalid prompt trial observation/)
})

test('request validator preserves codepoints/newlines/empty system and rejects forbidden prompt controls', () => {
  const api = trialApi()
  const request = { request_id: runId, ...trialRequest(), label: '🦙'.repeat(80), user_prompt: '🦙'.repeat(4000), system_prompt: 'line\nnext\t' }
  assert.deepEqual(api.acceptPromptTrialRequest(request), request)
  assert.throws(() => api.acceptPromptTrialRequest({ ...request, user_prompt: '\u0000'.repeat(4000), system_prompt: '\u0000'.repeat(1000) }), /Invalid/)
  assert.equal(api.samePromptTrialRequest(trialRequest(), trialRequest()), true)
  assert.equal(api.samePromptTrialRequest(trialRequest(), { ...trialRequest(), user_prompt: 'changed' }), false)
})

async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('real Axios sends one exact POST, GET identities, no metadata fabrication and no secret logging', async t => {
  const seen = [], logs = []
  const baseURL = await serverFor(t, (request, response) => {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => {
      seen.push({ method: request.method, url: request.url, body, headers: request.headers })
      response.writeHead(request.method === 'POST' ? 503 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(request.method === 'POST' ? { success: false, error: 'SECRET upstream', error_code: 'trials_unavailable' } : ok(trialSnapshot())))
    })
  })
  const api = trialApi({ baseURL, logger: { error: (...args) => logs.push(args), log: (...args) => logs.push(args) } })
  await api.getPromptTrials(); await api.getPromptTrial(runId)
  await assert.rejects(api.startPromptTrial({ request_id: runId, ...trialRequest() }))
  assert.deepEqual(seen.map(r => [r.method, r.url]), [['GET', '/api/runtime/trials'], ['GET', '/api/runtime/trials/' + runId], ['POST', '/api/runtime/trials']])
  assert.deepEqual(JSON.parse(seen[2].body), { request_id: runId, ...trialRequest() })
  assert.equal(seen[2].headers['sec-fetch-site'], undefined); assert.equal(seen[2].headers.origin, undefined)
  assert.deepEqual(logs, [])
})

test('real Axios observation is aborted on route leave, without a cancel or extra model request', async t => {
  let seen = 0, closed = false
  const baseURL = await serverFor(t, (_request, response) => { seen++; response.on('close', () => { closed = true }) })
  const api = trialApi({ baseURL })
  const v = await mountTrials({ api })
  try {
    await waitFor(() => seen === 1); await v.navigate('/'); await waitFor(() => closed)
    assert.equal(seen, 1)
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
  const controller = new AbortController(); const pending = api.getPromptTrials(controller.signal)
  const aborted = assert.rejects(pending, error => axios.isCancel(error)); await waitFor(() => seen === 2); controller.abort(); await aborted
})

test('exact response scalar strings preserve controls and empty refusal but reject surrogates', () => {
  const api = trialApi(), data = trialSnapshot('succeeded')
  data.run.response.content = '\u0000\u001b\u202e'; data.run.response.refusal = ''
  assert.equal(api.acceptPromptTrialSnapshot(ok(data)).run.response.content, data.run.response.content)
  data.run.response.content = '\ud800'; assert.throws(() => api.acceptPromptTrialSnapshot(ok(data)))
  data.run.response.content = ''; data.run.state = 'refused'; assert.throws(() => api.acceptPromptTrialSnapshot(ok(data)))
  data.run.response.finish_reason = 'content_filter'; assert.equal(api.acceptPromptTrialSnapshot(ok(data)).run.response.refusal, '')
})

for (const [field, value] of [['model', 'http://127.0.0.1:1234/private'], ['model', ' local '], ['reasoning_effort', ' high ']]) test(`noncanonical captured ${field} is rejected`, () => {
  const data = trialSnapshot('succeeded'); data.run.configuration[field] = value
  assert.throws(() => trialApi().acceptPromptTrialSnapshot(ok(data)))
})

test('BOM-only required prompt is blank while mixed BOM text remains exact', () => {
  const api = trialApi(), request = { request_id: runId, ...trialRequest(), user_prompt: '\ufeff' }
  assert.throws(() => api.acceptPromptTrialRequest(request))
  request.user_prompt = '\ufeffhello\ufeff'
  assert.equal(api.acceptPromptTrialRequest(request).user_prompt, request.user_prompt)
  const snapshot = trialSnapshot('succeeded'); snapshot.run.request.user_prompt = request.user_prompt
  assert.equal(api.acceptPromptTrialSnapshot(ok(snapshot)).run.request.user_prompt, request.user_prompt)
})
