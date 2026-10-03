import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import axios from 'axios'
import { mountReportLibrary, reportLibraryApi, waitFor } from './helpers/report-library-view-fixture.js'

function productionApi(baseURL) {
  const source = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
  const service = new Function('axios', 'i18n', 'buildEnvironment', 'console', source)(axios,
    { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error() {} })
  service.defaults.proxy = false; service.defaults.maxRedirects = 0; service.defaults.timeout = 3000
  return reportLibraryApi(service)
}
async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('actual Axios uses only isolated GET library endpoints with literal query and encoded ID', async t => {
  const seen = []
  const baseURL = await serverFor(t, (request, response) => {
    seen.push({ method: request.method, url: new URL(request.url, 'http://localhost') })
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"success":true,"data":{}}')
  })
  const api = productionApi(baseURL), catalogueRevision = 'a'.repeat(64), metadataRevision = 'b'.repeat(64)
  const q = '中文 Straße .* &+ "\\ 😀'
  await api.getSavedReports({ q, status: 'completed', offset: 20, limit: 20, revision: catalogueRevision, unauthorized: 'ignored' })
  await api.getSavedReport('report_A/../?id=#文', { revision: metadataRevision, q: 'ignored' })
  assert.equal(seen.length, 2); assert.ok(seen.every(request => request.method === 'GET'))
  assert.equal(seen[0].url.pathname, '/api/report/library/records')
  assert.equal(seen[0].url.searchParams.get('q'), q)
  assert.deepEqual([...seen[0].url.searchParams.keys()].sort(), ['limit', 'offset', 'q', 'revision', 'status'])
  assert.equal(seen[0].url.searchParams.get('revision'), catalogueRevision)
  assert.equal(seen[1].url.pathname, '/api/report/library/records/report_A%2F..%2F%3Fid%3D%23%E6%96%87')
  assert.deepEqual([...seen[1].url.searchParams], [['revision', metadataRevision]])
})

test('editing a mounted library aborts both real pending Axios requests and issues no runtime/generation calls', { timeout: 5000 }, async t => {
  const seen = [], closed = new Set()
  const baseURL = await serverFor(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    seen.push({ method: request.method, path }); request.on('close', () => closed.add(path))
    if (seen.length <= 2) return
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: { source_revision: 'a'.repeat(64), observed_at: '2026-10-03T15:00:00Z', filters: { q: 'new 文', status: 'failed' }, offset: 0, limit: 20, matched_count: 0, returned_count: 0, has_more: false, unavailable_count: 0, unavailable_reasons: [], reports: [] } }))
  })
  const h = await mountReportLibrary({ api: productionApi(baseURL), initialPath: '/reports?report_id=report_A' }); t.after(() => h.unmount())
  await waitFor(() => seen.length === 2)
  await h.input('search-phrase', 'new 文'); await h.change('status', 'failed'); await h.click('apply')
  await waitFor(() => closed.has('/api/report/library/records') && closed.has('/api/report/library/records/report_A') && h.byId('results'))
  assert.equal(seen.length, 3); assert.ok(seen.every(request => request.method === 'GET' && request.path.startsWith('/api/report/library/records')))
  assert.equal(h.byId('reader'), undefined); assert.equal(h.byId('download').props.disabled, true)
  assert.deepEqual(h.warnings, [])
})
