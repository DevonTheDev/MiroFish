import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { mountSavedInterviews, observation, waitFor } from './helpers/saved-interviews-view-fixture.js'

const path = new URL('../src/api/savedInterviews.js', import.meta.url)
const build = service => {
  if (!existsSync(path)) return {}
  const source = readFileSync(path, 'utf8').replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
  return new Function('service', source + '\nreturn { getSavedInterviews };')(service)
}
function productionClient(baseURL) {
  const index = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
  const client = new Function('axios', 'i18n', 'buildEnvironment', 'console', index)(axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error() {} })
  client.defaults.proxy = false; client.defaults.maxRedirects = 0; client.defaults.timeout = 3000
  return client
}
async function serverFor(t, handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('wrapper encodes simulation ID, allowlists only filters and forwards exact strings and AbortSignal', async () => {
  const calls = [], api = build({ get: (...args) => { calls.push(args); return Promise.resolve({ success: true }) } })
  assert.equal(typeof api.getSavedInterviews, 'function')
  const controller = new AbortController(), params = { platform: 'reddit', agent_id: '9223372036854775807', limit: 100, secret: 'ignored' }
  await api.getSavedInterviews('literal?/id', params, controller.signal); await api.getSavedInterviews('sim_A')
  assert.deepEqual(calls, [['/api/simulation/literal%3F%2Fid/saved-interviews', { params: { platform: 'reddit', agent_id: '9223372036854775807' }, signal: controller.signal }], ['/api/simulation/sim_A/saved-interviews', { params: {}, signal: undefined }]])
  assert.equal(params.secret, 'ignored')
})

test('real Axios sends exact filters and aborts held loopback request', { timeout: 5000 }, async t => {
  let observed, seen; const requestSeen = new Promise(resolve => { seen = resolve })
  const baseURL = await serverFor(t, (request, response) => {
    observed = { method: request.method, url: new URL(request.url, 'http://localhost'), language: request.headers['accept-language'] }
    if (request.url.includes('sim_hold')) seen()
    else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data: observation() })) }
  })
  const api = build(productionClient(baseURL)); assert.equal(typeof api.getSavedInterviews, 'function')
  const result = await api.getSavedInterviews('sim_A', { platform: 'twitter', agent_id: '9223372036854775807' })
  assert.equal(result.data.version, 1); assert.equal(observed.method, 'GET'); assert.equal(observed.language, 'en'); assert.equal(observed.url.pathname, '/api/simulation/sim_A/saved-interviews')
  assert.equal(observed.url.searchParams.get('agent_id'), '9223372036854775807'); assert.equal(observed.url.searchParams.get('platform'), 'twitter')
  const controller = new AbortController(), pending = api.getSavedInterviews('sim_hold', {}, controller.signal)
  const rejected = assert.rejects(pending, error => axios.isCancel(error) && error.code === 'ERR_CANCELED')
  await requestSeen; controller.abort(); await rejected
})

test('mounted production view aborts actual Axios read on route change and accepts only replacement response', { timeout: 5000 }, async t => {
  const traffic = []; let closed = false
  const baseURL = await serverFor(t, (request, response) => {
    traffic.push({ method: request.method, url: request.url })
    if (request.url.includes('/sim_A/')) { request.on('close', () => { closed = true }); return }
    assert.equal(request.url, '/api/simulation/sim_B/saved-interviews')
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data: observation({ simulation_id: 'sim_B' }) }))
  })
  const api = build(productionClient(baseURL)); assert.equal(typeof api.getSavedInterviews, 'function')
  const h = await mountSavedInterviews({ api }); t.after(() => h.unmount())
  await waitFor(() => traffic.length === 1); await h.navigate('/simulation/sim_B/interviews')
  await waitFor(() => h.byId('interviews-results') && closed)
  assert.equal(traffic.length, 2); assert.ok(traffic.every(item => item.method === 'GET')); assert.ok(h.text().includes('sim_B')); assert.deepEqual(h.warnings, [])
})
