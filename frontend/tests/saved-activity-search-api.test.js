import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { mountSavedActivity, waitFor } from './helpers/saved-activity-view-fixture.js'

function productionApi(baseURL) {
  const clientSource = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
  const service = new Function('axios', 'i18n', 'buildEnvironment', 'console', clientSource)(axios,
    { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error() {} })
  service.defaults.proxy = false; service.defaults.maxRedirects = 0; service.defaults.timeout = 3000
  const source = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
  return new Function('service', source + '\nreturn { getSavedActivity };')(service)
}
async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

// Omitting an allowlisted search field or coercing a phrase must change the
// real HTTP query. Cancellation is exercised by a mounted production view.
test('real Axios forwards literal Unicode phrase, exact true/false and outcome without extra fields', async t => {
  const seen = []
  const baseURL = await serverFor(t, (request, response) => {
    seen.push({ method: request.method, url: new URL(request.url, 'http://localhost') })
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data: {} }))
  })
  const api = productionApi(baseURL), phrase = ' 中文 Straße .* &+ "\\ 😀 '
  for (const value of [true, false]) await api.getSavedActivity('sim_A', { q: phrase, case_sensitive: value, outcome: 'failed', agent_id: '900719925474099312345', unauthorized: 'ignored' })
  assert.equal(seen.length, 2)
  for (const [index, request] of seen.entries()) {
    assert.equal(request.method, 'GET'); assert.equal(request.url.pathname, '/api/simulation/sim_A/saved-actions')
    assert.equal(request.url.searchParams.get('q'), phrase); assert.equal(request.url.searchParams.get('case_sensitive'), index ? 'false' : 'true')
    assert.equal(request.url.searchParams.get('outcome'), 'failed'); assert.equal(request.url.searchParams.get('agent_id'), '900719925474099312345')
    assert.equal(request.url.searchParams.has('unauthorized'), false)
  }
})

test('editing phrase cancels real pending Axios and only the reapplied search renders', { timeout: 5000 }, async t => {
  const traffic = [], revision = 'a'.repeat(64)
  let firstClosed = false
  const baseURL = await serverFor(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost'); traffic.push({ method: request.method, url })
    if (url.searchParams.get('q') === 'old') { request.on('close', () => { firstClosed = true }); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: { simulation_id: 'sim_A', source_revision: revision, observed_at: '2026-10-03T09:00:00Z', context: { status: 'completed', created_at: null, updated_at: null, started_at: null, completed_at: null, requested_rounds: null, last_saved_round: null }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'unavailable' }, warnings: [], filters: { platform: null, agent_id: null, round_num: null, action_type: null, q: 'new 文', case_sensitive: true, outcome: 'unknown' }, order: 'source_record', offset: 0, limit: 50, returned_count: 0, matched_count: 0, has_more: false, actions: [] } }))
  })
  const h = await mountSavedActivity({ api: productionApi(baseURL), initialPath: '/simulation/sim_A/activity?q=old' }); t.after(() => h.unmount())
  await waitFor(() => traffic.length === 1)
  await h.input('search-phrase', 'new 文'); h.byId('case-sensitive').props.onChange({ target: { checked: true } }); await h.change('outcome', 'unknown')
  await h.click('apply'); await waitFor(() => h.byId('results') && firstClosed)
  assert.equal(traffic.length, 2); assert.ok(traffic.every(item => item.method === 'GET'))
  assert.equal(traffic[1].url.searchParams.get('q'), 'new 文'); assert.equal(traffic[1].url.searchParams.get('case_sensitive'), 'true'); assert.equal(traffic[1].url.searchParams.get('outcome'), 'unknown')
  assert.equal(h.router.currentRoute.value.query.revision, revision); assert.deepEqual(h.warnings, [])
})
