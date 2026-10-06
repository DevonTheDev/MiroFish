// Invoked by the guarded Python suite against real disposable SQLite and Flask.
// This mounts compiled production Vue scripts/templates/router, not a browser.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import axios from 'axios'
import { mountSavedInterviews, waitFor, flush } from './saved-interviews-view-fixture.js'

const [baseURL, mode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['reopen', 'states', 'bounds', 'budget'].includes(mode))
const wrapperPath = new URL('../../src/api/savedInterviews.js', import.meta.url)
assert.ok(existsSync(wrapperPath), 'The production Saved interviews API must exist')
assert.ok(existsSync(new URL('../../src/views/SavedInterviewsView.vue', import.meta.url)), 'The production Saved interviews view must exist')
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const requests = [], observations = []
service.interceptors.request.use(config => {
  assert.equal(config.method, 'get')
  assert.match(config.url, /^\/api\/simulation\/sim_(saved|unknown|empty|corrupt)\/saved-interviews$/)
  assert.ok(config.signal instanceof AbortSignal)
  requests.push(config)
  return config
})
service.interceptors.response.use(envelope => {
  assert.equal(envelope.success, true)
  observations.push(envelope.data)
  return envelope
})
const wrappers = readFileSync(wrapperPath, 'utf8').replace(/^import .*$/gm, '')
  .replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
const api = new Function('service', wrappers + '\nreturn { getSavedInterviews };')(service)
assert.equal(typeof api.getSavedInterviews, 'function')
const view = await mountSavedInterviews({
  api, initialPath: `/simulation/${mode === 'states' ? 'sim_unknown' : 'sim_saved'}/interviews`, locale: 'en',
})
const last = () => observations.at(-1)
const renderedRows = () => view.all(node => String(node.props['data-testid'] ?? '').startsWith('interview-row-'))
const event = () => ({ preventDefault() {}, stopPropagation() {} })
async function settled(count) {
  await waitFor(() => observations.length >= count && view.byId('interviews-results'))
  assert.equal(view.router.currentRoute.value.name, 'SavedInterviews')
  assert.equal(view.byId('interviews-download').props.disabled, false)
}
async function exactDownload(expected = last()) {
  const readsBefore = requests.length, responsesBefore = observations.length, downloadsBefore = view.downloads.length
  await view.click('interviews-download')
  assert.equal(view.downloads.length, downloadsBefore + 1)
  const file = view.downloads.at(-1)
  assert.match(file.filename, new RegExp(`${expected.simulation_id}.*interviews.*\\.json$`))
  assert.equal(await file.blob.text(), JSON.stringify(expected, null, 2) + '\n')
  const data = JSON.parse(await file.blob.text())
  assert.deepEqual(data, expected)
  await flush()
  assert.equal(requests.length, readsBefore, 'Download must not make a new HTTP read')
  assert.equal(observations.length, responsesBefore)
  return file
}

try {
  await settled(1)
  if (mode === 'reopen') {
    const initial = last()
    assert.equal(initial.availability, 'complete')
    assert.deepEqual(initial.records.map(row => [row.record_id, row.agent_id]), [
      ['twitter:3', '0'], ['twitter:2', '9223372036854775807'], ['twitter:1', '0'], ['reddit:1', '0'],
    ])
    assert.equal(initial.records[0].response, 'Committed WAL reply')
    assert.ok(view.text().includes('Twitter zero reply')); assert.ok(view.text().includes('Reddit zero reply'))
    assert.ok(view.text().includes('<script>saved & literal</script>\nCafé 雪 🐟'))
    assert.ok(view.text().includes('9223372036854775807'))
    assert.equal(view.all(node => ['script', 'img', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
    assert.match(view.text(), /current.*databases/i)
    const initialFile = await exactDownload(initial)
    const staleDownload = view.byId('interviews-download').props.onClick

    await view.change('interviews-platform', 'twitter')
    await view.input('interviews-agent-id', '9223372036854775807')
    assert.equal(Boolean(view.byId('interviews-results')), false)
    assert.equal(view.byId('interviews-download').props.disabled, true)
    assert.ok(view.revokedUrls.includes(initialFile.url))
    await view.submit('interviews-form'); await settled(2)
    assert.deepEqual(last().filters, { platform: 'twitter', agent_id: '9223372036854775807' })
    assert.equal(view.router.currentRoute.value.query.agent_id, '9223372036854775807')
    assert.equal(last().records.length, 1); assert.equal(last().records[0].response, 'Twitter signed64 max reply')
    assert.equal(last().sources.reddit.status, 'not_requested')
    staleDownload(event()); assert.equal(view.downloads.length, 1)
    await exactDownload()

    await view.change('interviews-platform', 'reddit'); await view.input('interviews-agent-id', '0')
    await view.click('interviews-apply'); await settled(3)
    assert.deepEqual(last().filters, { platform: 'reddit', agent_id: '0' })
    assert.equal(last().records.length, 1); assert.equal(last().records[0].agent_id, '0')
    assert.equal(last().records[0].response, 'Reddit zero reply')
    await exactDownload()

    await view.navigate('/simulation/sim_saved/interviews'); await settled(4)
    assert.equal(last().records[0].response, 'Committed WAL reply')
    const beforeRefresh = requests.length
    await view.click('interviews-refresh'); await settled(5)
    assert.equal(requests.length, beforeRefresh + 1)
    assert.equal(last().records[0].response, 'Refreshed WAL reply')
    assert.equal(last().records.length, 5)
    await exactDownload()
    assert.equal(requests.length, 5)
  } else if (mode === 'states') {
    assert.equal(last().availability, 'unavailable'); assert.equal(last().records.length, 0)
    assert.ok(Object.values(last().sources).every(source => source.status === 'missing' && source.has_more === null))
    assert.match(view.text(view.byId('interviews-availability')), /unavailable/i)
    assert.doesNotMatch(view.text(), /no matching saved interviews/i)
    const missingFile = await exactDownload()
    const staleDownload = view.byId('interviews-download').props.onClick
    await view.navigate('/simulation/sim_empty/interviews')
    staleDownload(event()); assert.equal(view.downloads.length, 1)
    await settled(2)
    assert.equal(last().availability, 'complete'); assert.equal(last().records.length, 0)
    assert.ok(Object.values(last().sources).every(source => source.status === 'available' && source.has_more === false))
    assert.match(view.text(view.byId('interviews-source-twitter')), /no matching saved interviews/i)
    assert.match(view.text(view.byId('interviews-source-reddit')), /no matching saved interviews/i)
    assert.ok(view.revokedUrls.includes(missingFile.url)); await exactDownload()
    await view.navigate('/simulation/sim_corrupt/interviews'); await settled(3)
    staleDownload(event()); assert.equal(view.downloads.length, 2)
    assert.equal(last().availability, 'partial')
    assert.equal(last().sources.twitter.status, 'available'); assert.equal(last().sources.reddit.status, 'unreadable')
    assert.equal(last().sources.reddit.has_more, null)
    assert.match(view.text(view.byId('interviews-source-twitter')), /no matching saved interviews/i)
    assert.doesNotMatch(view.text(view.byId('interviews-source-reddit')), /no matching saved interviews/i)
    assert.doesNotMatch(view.text(), /PRIVATE_CORRUPT_DATABASE_CONTENT/)
    await exactDownload(); assert.equal(requests.length, 3)
  } else if (mode === 'bounds') {
    const data = last()
    assert.equal(data.availability, 'partial'); assert.equal(data.records.length, 200)
    assert.equal(data.limits.rows_per_platform, 100); assert.equal(data.limits.rows_total, 200)
    assert.equal(data.limits.payload_bytes, 16384)
    for (const platform of ['twitter', 'reddit']) {
      assert.equal(data.sources[platform].returned_count, 100)
      assert.equal(data.sources[platform].has_more, true)
      assert.equal(data.sources[platform].coverage, 'partial')
      assert.ok(data.sources[platform].warnings.includes('row_limit'))
    }
    assert.equal(data.records[0].record_id, 'twitter:105')
    assert.equal(data.records[0].payload_kind, 'raw'); assert.equal(data.records[0].payload_bytes, 18000)
    assert.equal(data.records[0].truncated, true); assert.ok(data.records[0].warnings.includes('payload_truncated'))
    assert.ok(data.records[0].raw_preview.length < 6000)
    assert.equal(data.records[1].raw_preview, '<img src=x onerror=alert(1)>{broken')
    assert.equal(data.records[2].prompt, ''); assert.equal(data.records[2].response, '')
    assert.equal(data.records[3].payload_kind, 'missing'); assert.equal(data.records[3].response, null)
    assert.equal(renderedRows().length, 25)
    assert.match(view.text(), /truncated/i); assert.match(view.text(), /more.*matching.*rows/i)
    assert.match(view.text(), /empty saved text/i); assert.match(view.text(), /not saved/i)
    assert.ok(view.text().includes('<img src=x onerror=alert(1)>{broken'))
    assert.equal(view.all(node => ['script', 'img', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
    await exactDownload(data)
    const visibleIds = renderedRows().map(node => node.props['data-testid'])
    for (let page = 1; page < 8; page++) {
      await view.click('interviews-next')
      visibleIds.push(...renderedRows().map(node => node.props['data-testid']))
    }
    assert.deepEqual(visibleIds, data.records.map(row => `interview-row-${row.record_id}`))
    assert.equal(view.byId('interviews-next').props.disabled, true)
    assert.equal(view.router.currentRoute.value.query.page, undefined)
    await exactDownload(data)
    assert.equal(requests.length, 1, 'Local pagination and export must reuse the accepted observation')
  } else {
    const data = last()
    assert.equal(data.availability, 'partial')
    assert.ok(data.records.length > 0 && data.records.length < 80)
    for (const platform of ['twitter', 'reddit']) {
      const source = data.sources[platform]
      assert.equal(source.status, 'available'); assert.equal(source.coverage, 'partial')
      assert.equal(source.has_more, true)
      assert.ok(source.returned_count > 0 && source.returned_count < 40)
      assert.ok(source.warnings.includes('response_limit'))
      assert.ok(source.warnings.includes('record_warnings'))
      assert.equal(data.records.filter(row => row.platform === platform).length, source.returned_count)
    }
    assert.ok(data.records.every(row => row.payload_kind === 'raw' && row.warnings.includes('invalid_utf8')))
    assert.match(view.text(), /partial/i)
    await exactDownload(data)
    while (!view.byId('interviews-next').props.disabled) await view.click('interviews-next')
    assert.ok(renderedRows().some(row => row.props['data-testid'].includes('reddit:')))
    await exactDownload(data)
    assert.equal(requests.length, 1)
  }
  assert.deepEqual(view.warnings, [])
  console.log(`actual Flask/Axios/Vue saved interviews ${mode} passed; ${requests.length} GET reads`)
} finally {
  view.unmount()
}
