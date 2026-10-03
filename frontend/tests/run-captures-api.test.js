import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { mountRunCaptures, runCapturesApi, waitFor } from './helpers/run-captures-view-fixture.js'
import { LEFT, revision, preview, capture, library, candidates } from './fixtures/run-captures-data.js'

function productionApi(baseURL) {
  const source = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
  const service = new Function('axios', 'i18n', 'buildEnvironment', 'console', source)(axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error() {} })
  service.defaults.proxy = false; service.defaults.maxRedirects = 0; service.defaults.timeout = 3000
  const simulationSource = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
  const simulation = new Function('service', simulationSource + '\nreturn { getComparisonCandidates };')(service)
  return { ...runCapturesApi(service), ...simulation }
}
async function serverFor(t, handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}
const reply = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data })) }

test('real Axios capture wrappers isolate endpoints, encode literal IDs and allowlist exact JSON fields', async t => {
  const seen = []
  const baseURL = await serverFor(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    seen.push({ method: request.method, url: new URL(request.url, 'http://localhost'), body, locale: request.headers['accept-language'] }); reply(response, {})
  })
  const api = productionApi(baseURL), signal = new AbortController().signal
  const hostileId = 'literal/../?id=文#x', sim = 'sim &+?文', label = '<script>literal</script> 😀'
  await api.previewRunCapture(sim, signal)
  await api.getRunCaptures({ offset: 20, limit: 20, unexpected: 'ignored' }, signal)
  await api.getRunCapture(hostileId, signal)
  await api.compareRunCaptures('left&=文', 'right?=#', signal)
  await api.saveRunCapture(hostileId, { simulation_id: sim, source_revision: revision, label, note: 'literal\n\t中文', unexpected: 'ignored' }, signal)
  assert.deepEqual(seen.map(item => item.method), ['GET', 'GET', 'GET', 'GET', 'POST'])
  assert.equal(seen[0].url.pathname, '/api/run-captures/preview'); assert.deepEqual([...seen[0].url.searchParams], [['simulation_id', sim]])
  assert.deepEqual([...seen[1].url.searchParams], [['offset', '20'], ['limit', '20']])
  assert.equal(seen[2].url.pathname, '/api/run-captures/records/literal%2F..%2F%3Fid%3D%E6%96%87%23x')
  assert.deepEqual([...seen[3].url.searchParams], [['left', 'left&=文'], ['right', 'right?=#']])
  assert.equal(seen[4].url.pathname, seen[2].url.pathname); assert.equal(seen[4].url.search, '')
  assert.deepEqual(JSON.parse(seen[4].body), { simulation_id: sim, source_revision: revision, label, note: 'literal\n\t中文' })
  assert.ok(seen.every(item => item.locale === 'en'))
})

test('real Axios never automatically retries failed capture mutations and preserves fixed error codes', async t => {
  let count = 0
  const baseURL = await serverFor(t, (_request, response) => { count++; response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: false, error: 'The store is busy.', error_code: 'capture_storage_busy' })) })
  await assert.rejects(productionApi(baseURL).saveRunCapture(LEFT, { simulation_id: 'sim_A', source_revision: revision, label: 'One', note: '' }), error => error.response.data.error_code === 'capture_storage_busy')
  assert.equal(count, 1)
})

test('real HTTP committed save with lost response is reconciled by GET once without duplicate POST', { timeout: 8000 }, async t => {
  const seen = [], payloads = []; let stored
  const baseURL = await serverFor(t, async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname; seen.push([request.method, path])
    if (path.endsWith('/candidates')) return reply(response, candidates())
    if (path === '/api/run-captures/preview') return reply(response, preview())
    if (path === '/api/run-captures/records') return reply(response, library(stored ? [stored] : []))
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk
      const payload = JSON.parse(body); payloads.push(payload); stored = capture(LEFT, 'sim_A', 3, payload.label, payload.note)
      response.destroy(); return
    }
    if (stored) return reply(response, stored)
    response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"success":false,"error_code":"capture_not_found"}')
  })
  const h = await mountRunCaptures({ api: productionApi(baseURL), initialPath: '/captures?simulation=sim_A', crypto: { randomUUID: () => LEFT } }); t.after(() => h.unmount())
  await h.click('preview'); await waitFor(() => h.byId('preview-observation')); await h.input('label', 'Lost response'); await h.input('note', 'Unchanged draft'); await h.click('save')
  await waitFor(() => h.byId('saved-capture'))
  assert.deepEqual(payloads, [{ simulation_id: 'sim_A', source_revision: revision, label: 'Lost response', note: 'Unchanged draft' }])
  assert.equal(seen.filter(([method]) => method === 'POST').length, 1)
  assert.equal(seen.filter(([method, path]) => method === 'GET' && path === `/api/run-captures/records/${LEFT}`).length, 1)
  assert.ok(seen.every(([, path]) => path.startsWith('/api/run-captures/') || path === '/api/simulation/comparison/candidates'))
  assert.equal(h.warnings.length, 0)
})

test('real pending Axios preview is aborted on newer simulation navigation', { timeout: 8000 }, async t => {
  const seen = [], closed = new Set()
  const baseURL = await serverFor(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost'); seen.push([request.method, url.pathname, url.search]); request.on('close', () => closed.add(url.pathname + url.search))
    if (url.pathname.endsWith('/preview')) return
    reply(response, url.pathname.endsWith('/candidates') ? candidates() : library([]))
  })
  const h = await mountRunCaptures({ api: productionApi(baseURL), initialPath: '/captures?simulation=sim_A' }); t.after(() => h.unmount())
  await h.click('preview'); await waitFor(() => seen.some(([, path]) => path.endsWith('/preview')))
  await h.navigate('/captures?simulation=sim_B'); await waitFor(() => closed.has('/api/run-captures/preview?simulation_id=sim_A'))
  assert.equal(h.byId('preview-observation'), undefined); assert.equal(h.byId('save').props.disabled, true); assert.ok(seen.every(([method]) => method === 'GET'))
})

test('explicit recovery wrapper sends exactly one empty JSON POST and does not retry failures', async t => {
  const seen = []
  const baseURL = await serverFor(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    seen.push({ method: request.method, path: request.url, body })
    response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"success":false,"error_code":"capture_recovery_required"}')
  })
  const controller = new AbortController()
  await assert.rejects(productionApi(baseURL).recoverRunCaptureStore(controller.signal))
  assert.deepEqual(seen, [{ method: 'POST', path: '/api/run-captures/recover', body: '{}' }])
})
