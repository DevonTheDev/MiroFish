// Guarded Python tests provide only a disposable loopback Flask application.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountReportLibrary, reportLibraryApi, waitFor } from '../helpers/report-library-view-fixture.js'

const [baseURL, contentMode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['file', 'metadata', 'empty', 'unavailable', 'legacy'].includes(contentMode))
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const requests = [], replies = []
service.interceptors.request.use(config => {
  requests.push(config)
  assert.equal(config.method, 'get')
  assert.ok(config.url === '/api/report/library/records' || config.url === '/api/report/library/records/report_old')
  return config
})
service.interceptors.response.use(body => { replies.push(structuredClone(body)); return body })
const view = await mountReportLibrary({ api: reportLibraryApi(service), initialPath: '/reports?limit=1', locale: 'en' })
try {
  await waitFor(() => view.byId('open-report_new'))
  assert.match(view.text(), /Newest \[capital\]\+ report/)
  const initial = replies.at(-1).data
  assert.equal(initial.matched_count, 3)
  assert.equal(initial.unavailable_count, 1)
  await view.input('search-phrase', '[capital]+')
  await view.click('apply')
  await waitFor(() => replies.at(-1).data.filters?.q === '[capital]+' && view.byId('open-report_new'))
  assert.equal(replies.at(-1).data.matched_count, 2)
  await view.click('next')
  await waitFor(() => view.byId('open-report_old'))
  const oldRow = replies.at(-1).data.reports[0]
  assert.equal(oldRow.report_id, 'report_old')
  assert.ok(requests.at(-1).params.revision)
  await view.click('open-report_old')
  await waitFor(() => view.byId('reader') && replies.at(-1).data.report_id === 'report_old')
  const captured = replies.at(-1).data
  assert.equal(captured.metadata_revision, oldRow.metadata_revision)
  assert.equal(captured.source, contentMode === 'legacy' ? 'legacy' : 'modern')
  assert.match(view.text(), /Earlier \[capital\]\+ <literal>/)
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  if (contentMode === 'unavailable') {
    assert.equal(captured.content_available, false)
    assert.equal(captured.markdown_content, null)
    assert.ok(view.byId('content-error'))
    assert.ok(!view.byId('download') || view.byId('download').props.disabled)
    assert.equal(view.downloads.length, 0)
  } else {
    const text = contentMode === 'empty' ? '' : '# Earlier report\r\n\r\nCafé 雪 🐟 <script>literal</script>\r\n'
    assert.equal(captured.content_available, true)
    assert.equal(captured.markdown_content, text)
    const expected = Buffer.from(text, 'utf8')
    assert.equal(captured.content_bytes, expected.length)
    assert.equal(captured.content_revision, createHash('sha256').update(expected).digest('hex'))
    assert.ok(view.byId('markdown'))
    assert.equal(view.text(view.byId('markdown')), text)
    const requestCount = requests.length
    await view.click('download')
    assert.equal(requests.length, requestCount)
    assert.equal(view.downloads.length, 1)
    assert.equal(view.downloads[0].filename, 'report_old.md')
    assert.deepEqual(Buffer.from(await view.downloads[0].blob.arrayBuffer()), expected)
  }
  const previousRequests = requests.length
  await view.click('refresh')
  await waitFor(() => requests.length > previousRequests && view.byId('results') && !view.byId('loading'))
  assert.ok(!view.byId('reader'))
  assert.ok(!view.byId('download') || view.byId('download').props.disabled)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue saved report library passed')
} finally {
  view.unmount()
}
