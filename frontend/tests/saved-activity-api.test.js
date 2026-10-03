import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { mountSavedActivity, waitFor } from './helpers/saved-activity-view-fixture.js'

const source = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const build = service => new Function('service', source + '\nreturn { getSavedActivity };')(service)

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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

// Forwarding arbitrary fields, failing to encode the ID, or dropping a signal
// must break these tests of the production wrapper and real Axios transport.
test('saved activity wrapper uses GET, allowlists supplied fields and forwards signal without rounding', async () => {
  const calls = [], api = build({ get: (...args) => { calls.push(args); return Promise.resolve({ success: true }) } })
  const controller = new AbortController()
  const params = { agent_id: '900719925474099312345', round_num: '0', action_type: ' exact ', offset: 0, limit: 1, revision: 'a'.repeat(64), unauthorized: 'ignored' }
  await api.getSavedActivity('literal?/id', params, controller.signal)
  await api.getSavedActivity('sim_saved')
  assert.deepEqual(calls, [
    ['/api/simulation/literal%3F%2Fid/saved-actions', { params: { agent_id: params.agent_id, round_num: '0', action_type: ' exact ', offset: 0, limit: 1, revision: params.revision }, signal: controller.signal }],
    ['/api/simulation/sim_saved/saved-actions', { params: {}, signal: undefined }],
  ])
  assert.equal(params.unauthorized, 'ignored')
})

test('real Axios sends exact query strings and AbortSignal cancels the loopback HTTP observation', { timeout: 5000 }, async t => {
  let observed, requestSeen
  const seen = new Promise(resolve => { requestSeen = resolve })
  const baseURL = await serverFor(t, (request, response) => {
    observed = { method: request.method, url: new URL(request.url, 'http://localhost'), language: request.headers['accept-language'] }
    if (request.url.includes('sim_hold')) requestSeen()
    else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data: { exact: true } })) }
  })
  const api = build(productionClient(baseURL))
  const response = await api.getSavedActivity('sim_A', { agent_id: '900719925474099312345', round_num: '0', action_type: 'has & space', offset: 0, limit: 1 })
  assert.equal(response.data.exact, true); assert.equal(observed.method, 'GET')
  assert.equal(observed.url.pathname, '/api/simulation/sim_A/saved-actions'); assert.equal(observed.language, 'en')
  assert.equal(observed.url.searchParams.get('agent_id'), '900719925474099312345')
  assert.equal(observed.url.searchParams.get('round_num'), '0'); assert.equal(observed.url.searchParams.get('action_type'), 'has & space')
  const controller = new AbortController()
  const pending = api.getSavedActivity('sim_hold', {}, controller.signal)
  const rejected = assert.rejects(pending, error => axios.isCancel(error) && error.code === 'ERR_CANCELED')
  await seen; controller.abort(); await rejected
})

test('mounted view retires an actual Axios request on route change and accepts only the new GET', { timeout: 5000 }, async t => {
  const traffic = [], revision = 'b'.repeat(64)
  let firstClosed = false
  const baseURL = await serverFor(t, (request, response) => {
    traffic.push({ method: request.method, url: request.url })
    if (request.url.includes('/sim_A/')) { request.on('close', () => { firstClosed = true }); return }
    assert.ok(request.url.startsWith('/api/simulation/sim_B/saved-actions'))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: { simulation_id: 'sim_B', source_revision: revision, observed_at: '2026-10-03T09:00:00Z', context: { status: 'completed', created_at: null, updated_at: null, started_at: null, completed_at: null, requested_rounds: null, last_saved_round: null }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'unavailable' }, warnings: [], filters: { platform: null, agent_id: null, round_num: null, action_type: null, q: null, case_sensitive: false, outcome: null }, order: 'source_record', offset: 0, limit: 50, returned_count: 0, matched_count: 0, has_more: false, actions: [] } }))
  })
  const h = await mountSavedActivity({ api: build(productionClient(baseURL)) }); t.after(() => h.unmount())
  await waitFor(() => traffic.length === 1)
  await h.navigate('/simulation/sim_B/activity')
  await waitFor(() => h.byId('results') && firstClosed)
  assert.equal(traffic.length, 2); assert.ok(traffic.every(item => item.method === 'GET'))
  assert.equal(h.router.currentRoute.value.query.revision, revision); assert.match(h.text(), /sim_B/)
  assert.doesNotMatch(h.text(), /could not be loaded/); assert.deepEqual(h.warnings, [])
})
