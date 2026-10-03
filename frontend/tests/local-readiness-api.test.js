import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import { mountReadiness, readinessSnapshot, readinessApi, productionClient, runId } from './helpers/readiness-view-fixture.js'
import { ok, runtimeSnapshot, waitFor } from './helpers/runtime-view-fixture.js'

test('readiness wrapper fixes methods, bodies, bounded timeouts and exact canonical cancel target', async () => {
  const calls = []
  const api = readinessApi({ get: (...args) => { calls.push(['GET', ...args]); return Promise.resolve() }, post: (...args) => { calls.push(['POST', ...args]); return Promise.resolve() } })
  const controller = new AbortController()
  await api.getLocalReadiness(controller.signal); await api.startLocalReadiness(controller.signal); await api.cancelLocalReadiness(runId, controller.signal)
  assert.deepEqual(calls, [
    ['GET', '/api/runtime/readiness', { signal: controller.signal, timeout: 15000 }],
    ['POST', '/api/runtime/readiness', {}, { signal: controller.signal, timeout: 15000 }],
    ['POST', `/api/runtime/readiness/${runId}/cancel`, {}, { signal: controller.signal, timeout: 15000 }],
  ])
  for (const bad of ['../secret', runId + '?secret=x', runId.toUpperCase(), null]) assert.throws(() => api.cancelLocalReadiness(bad))
  assert.equal(calls.length, 3)
})

async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}
const reply = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }

test('actual parent/router/Axios recover a lost start reply by GET and export the terminal safe result', { timeout: 10000 }, async t => {
  const seen = []; let state = null
  const baseURL = await serverFor(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    seen.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString(), language: request.headers['accept-language'] })
    if (request.url === '/api/runtime/status') return reply(response, ok(runtimeSnapshot()))
    if (request.method === 'GET') return reply(response, ok(readinessSnapshot(state)))
    assert.equal(request.url, '/api/runtime/readiness'); assert.equal(seen.at(-1).body, '{}')
    state = 'running'; request.socket.destroy()
  })
  const view = await mountReadiness({ api: readinessApi(productionClient(baseURL)) })
  try {
    await waitFor(() => view.byId('readiness-start')?.props.disabled === false)
    assert.equal(seen.filter(r => r.method === 'POST').length, 0)
    await view.click('readiness-start')
    await waitFor(() => view.text(view.byId('readiness-notice')).includes('passive refresh found'))
    assert.match(view.text(view.byId('readiness-state')), /^Running$/)
    assert.equal(seen.filter(r => r.method === 'POST').length, 1)
    assert.deepEqual(seen.filter(r => r.url === '/api/runtime/readiness').map(r => r.method), ['GET', 'POST', 'GET'])
    state = 'passed'; await view.click('readiness-refresh')
    await waitFor(() => view.byId('readiness-download')?.props.disabled === false)
    const before = seen.length; await view.click('readiness-download')
    assert.equal(seen.length, before); assert.equal(JSON.parse(await view.downloads[0].blob.text()).run.state, 'passed')
    assert.equal(view.downloads[0].filename, 'local_readiness_check.json')
    assert.ok(seen.every(r => r.language === 'en')); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('actual Axios 409 preserves the fixed conflicting run snapshot and stop sends only its UUID', { timeout: 10000 }, async t => {
  const posts = []
  const baseURL = await serverFor(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    if (request.url === '/api/runtime/status') return reply(response, ok(runtimeSnapshot()))
    if (request.method === 'GET') return reply(response, ok(readinessSnapshot()))
    posts.push([request.url, Buffer.concat(chunks).toString()])
    if (request.url.endsWith('/cancel')) return reply(response, ok(readinessSnapshot('stopping')))
    reply(response, { success: false, error_code: 'already_running', error: 'DO_NOT_RENDER_SECRET', data: readinessSnapshot('running') }, 409)
  })
  const view = await mountReadiness({ api: readinessApi(productionClient(baseURL)) })
  try {
    await waitFor(() => view.byId('readiness-start')?.props.disabled === false); await view.click('readiness-start')
    await waitFor(() => view.byId('readiness-stop')?.props.disabled === false)
    assert.match(view.text(view.byId('readiness-notice')), /already active/); assert.doesNotMatch(view.text(), /DO_NOT_RENDER_SECRET/)
    await view.click('readiness-stop'); await waitFor(() => view.text(view.byId('readiness-state')).startsWith('Stopping'))
    assert.deepEqual(posts, [['/api/runtime/readiness', '{}'], [`/api/runtime/readiness/${runId}/cancel`, '{}']])
  } finally { view.unmount() }
})

test('actual Axios observation closes on navigation without sending a cancellation POST', { timeout: 10000 }, async t => {
  let count = 0, closed = false; const methods = []
  const baseURL = await serverFor(t, (request, response) => {
    methods.push(request.method)
    if (request.url === '/api/runtime/status') return reply(response, ok(runtimeSnapshot()))
    count++
    if (count === 1) { response.on('close', () => { closed = true }); return }
    reply(response, ok(readinessSnapshot('running')))
  })
  const view = await mountReadiness({ api: readinessApi(productionClient(baseURL)) })
  try {
    await waitFor(() => count === 1); await view.navigate('/'); await waitFor(() => closed)
    await view.navigate('/runtime'); await waitFor(() => view.byId('readiness-result'))
    assert.match(view.text(view.byId('readiness-state')), /^Running$/)
    assert.ok(methods.every(method => method === 'GET')); assert.equal(count, 2)
  } finally { view.unmount() }
})

test('all readiness copy has matching nonempty English and Chinese keys and capability/code coverage', () => {
  const locales = ['en', 'zh'].map(locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8')).readiness)
  const entries = (value, path = '') => Object.entries(value).flatMap(([key, child]) => typeof child === 'string' ? [[path + key, child]] : entries(child, `${path}${key}.`))
  assert.deepEqual(entries(locales[0]).map(([key]) => key).sort(), entries(locales[1]).map(([key]) => key).sort())
  for (const copy of locales) {
    assert.ok(entries(copy).every(([, value]) => value.trim()))
    assert.equal(Object.keys(copy.codes).length, 17); assert.equal(Object.keys(copy.steps).length, 9)
  }
})
