import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { mountRuntime, runtimeApi, runtimeSnapshot, ok, waitFor, flush } from './helpers/runtime-view-fixture.js'

test('runtime wrapper sends only the fixed GET and forwards the optional AbortSignal', async () => {
  const calls = []
  const api = runtimeApi({ get: (...args) => { calls.push(args); return Promise.resolve(ok(runtimeSnapshot())) } })
  const controller = new AbortController()
  await api.getRuntimeStatus(controller.signal)
  await api.getRuntimeStatus()
  assert.deepEqual(calls, [['/api/runtime/status', { signal: controller.signal }], ['/api/runtime/status', { signal: undefined }]])
})

test('accepted schema preserves canonical loopback endpoints, zero observations and finite fractional limits', () => {
  const data = runtimeSnapshot()
  data.configuration.chat_endpoint = 'http://127.0.0.2:11434/v1'
  data.configuration.graph_endpoint = 'bolt://[::1]:7687/neo4j'
  data.configuration.gateway_limits.request_timeout = 1e20
  data.gateway.limits.max_queue = 0
  data.gateway.uptime_seconds = 0
  for (const metric of Object.keys(data.gateway.metrics)) data.gateway.metrics[metric] = 0
  assert.deepEqual(runtimeApi().acceptRuntimeSnapshot(ok(data)), data)
})

test('projection preserves safe long Bolt paths at the backend endpoint bound', () => {
  const data = runtimeSnapshot()
  data.configuration.graph_endpoint = 'bolt://127.0.0.1:7687/' + 'a'.repeat(1500)
  assert.equal(runtimeApi().acceptRuntimeSnapshot(ok(data)).configuration.graph_endpoint, data.configuration.graph_endpoint)
})

test('bounded model and reasoning text count Unicode codepoints rather than UTF-16 units', () => {
  const data = runtimeSnapshot()
  data.configuration.chat_model = '🦙'.repeat(256)
  data.configuration.reasoning_effort = '🦙'.repeat(64)
  assert.deepEqual(runtimeApi().acceptRuntimeSnapshot(ok(data)), data)
})

for (const [name, mutate] of [
  ['version', data => { data.schema_version = 2 }],
  ['timestamp', data => { data.observed_at = 'yesterday' }],
  ['calendar date', data => { data.observed_at = '2026-02-31T13:00:00Z' }],
  ['zone', data => { data.observed_at = '2026-10-03T13:00:00' }],
  ['mode', data => { data.mode = 'SECRET_MODE' }],
  ['state', data => { data.gateway.state = 'SECRET_STATE' }],
  ['unsafe integer', data => { data.configuration.context_tokens = Number.MAX_SAFE_INTEGER + 1 }],
  ['string integer', data => { data.configuration.max_agents = '12' }],
  ['boolean count', data => { data.gateway.metrics.active_requests = false }],
  ['negative count', data => { data.gateway.metrics.active_requests = -1 }],
  ['nonfinite deadline', data => { data.configuration.gateway_limits.request_timeout = Infinity }],
  ['omitted count', data => { delete data.gateway.metrics.active_requests }],
  ['endpoint credential', data => { data.configuration.chat_endpoint = 'http://secret@127.0.0.1/v1' }],
  ['endpoint remote', data => { data.configuration.chat_endpoint = 'http://128.0.0.1/v1' }],
  ['endpoint invalid port', data => { data.configuration.chat_endpoint = 'http://127.0.0.1:99999/v1' }],
  ['endpoint escaped path', data => { data.configuration.graph_endpoint = 'bolt://127.0.0.1/%73ecret' }],
  ['endpoint traversal', data => { data.configuration.graph_endpoint = 'bolt://127.0.0.1/foo/../bar' }],
  ['model control', data => { data.configuration.chat_model = 'local\u202Esecret' }],
  ['model cloud', data => { data.configuration.chat_model = 'local:cloud' }],
  ['blank reasoning', data => { data.configuration.reasoning_effort = '' }],
  ['instance id', data => { data.gateway.instance_id = '/private/path' }],
  ['false validity', data => { data.configuration.chat_model = null }],
]) {
  test(`malformed ${name} is rejected without publishing raw data or enabling export`, async () => {
    const view = await mountRuntime()
    try {
      const data = runtimeSnapshot(); mutate(data)
      view.requests.calls.getRuntimeStatus[0].resolve(ok(data)); await flush()
      assert.equal(Boolean(view.byId('results')), false)
      assert.ok(view.byId('download').props.disabled)
      assert.match(view.text(), /Could not read a valid runtime observation/)
      assert.doesNotMatch(view.text(), /SECRET_|private\/path/)
    } finally { view.unmount() }
  })
}

test('null observations remain unknown and omitted reasoning is distinguished from invalid reasoning', async () => {
  const view = await mountRuntime()
  try {
    const data = runtimeSnapshot()
    data.gateway.metrics.active_requests = null
    view.requests.calls.getRuntimeStatus[0].resolve(ok(data)); await flush()
    assert.match(view.text(view.byId('metric-active_requests')), /Unknown/)
    assert.match(view.text(view.byId('config-reasoning_effort')), /Server default/)
    await view.click('refresh')
    data.configuration.valid = false
    data.configuration.issues = [{ field: 'reasoning_effort', code: 'invalid_reasoning_effort' }]
    view.requests.calls.getRuntimeStatus[1].resolve(ok(data)); await flush()
    assert.match(view.text(view.byId('config-reasoning_effort')), /Unknown/)
    assert.doesNotMatch(view.text(view.byId('config-reasoning_effort')), /Server default/)
  } finally { view.unmount() }
})

test('small positive deadline values remain visibly positive instead of rounding to zero', async () => {
  const view = await mountRuntime()
  try {
    const data = runtimeSnapshot()
    data.configuration.gateway_limits.request_timeout = 0.0001
    view.requests.calls.getRuntimeStatus[0].resolve(ok(data)); await flush()
    assert.equal(view.text(view.byId('loaded-request_timeout')), '1E-4')
  } finally { view.unmount() }
})

function productionClient(baseURL) {
  const index = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
  const client = new Function('axios', 'i18n', 'buildEnvironment', 'console', index)(axios,
    { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error() {} })
  client.defaults.proxy = false; client.defaults.maxRedirects = 0; client.defaults.timeout = 3000
  return client
}
async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('actual Axios transport uses the envelope and cancels an in-flight status GET', { timeout: 5000 }, async t => {
  const seen = []
  let closed = false
  const baseURL = await serverFor(t, (request, response) => {
    seen.push({ method: request.method, url: request.url, language: request.headers['accept-language'] })
    if (seen.length === 2) { response.on('close', () => { closed = true }); return }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(ok(runtimeSnapshot())))
  })
  const api = runtimeApi(productionClient(baseURL))
  const response = await api.getRuntimeStatus()
  assert.deepEqual(api.acceptRuntimeSnapshot(response), runtimeSnapshot())
  const controller = new AbortController()
  const pending = api.getRuntimeStatus(controller.signal)
  const rejected = assert.rejects(pending, error => axios.isCancel(error) && error.code === 'ERR_CANCELED')
  await waitFor(() => seen.length === 2)
  controller.abort(); await rejected; await waitFor(() => closed)
  assert.deepEqual(seen, Array.from({ length: 2 }, () => ({ method: 'GET', url: '/api/runtime/status', language: 'en' })))
})

test('compiled view aborts actual Axios on navigation and remount accepts only a fresh observation', { timeout: 5000 }, async t => {
  let count = 0, closed = false
  const baseURL = await serverFor(t, (request, response) => {
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/api/runtime/status'); count++
    if (count === 1) { response.on('close', () => { closed = true }); return }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(ok(runtimeSnapshot())))
  })
  const view = await mountRuntime({ api: runtimeApi(productionClient(baseURL)) })
  try {
    await waitFor(() => count === 1)
    await view.navigate('/')
    await waitFor(() => closed)
    await view.navigate('/runtime')
    await waitFor(() => view.byId('results'))
    assert.equal(count, 2)
    assert.equal(view.byId('download').props.disabled, false)
    assert.doesNotMatch(view.text(), /Could not read/)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})
