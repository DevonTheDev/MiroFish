import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountReportLibrary, deferredApi, flush, ok } from './helpers/report-library-view-fixture.js'

const revision = 'a'.repeat(64), metadataRevision = 'b'.repeat(64), contentRevision = 'c'.repeat(64)
const summary = (overrides = {}) => ({ report_id: 'report_A', simulation_id: 'sim_saved', title: 'Saved report A', summary_preview: '<img src=x> Saved summary', requirement_preview: 'Saved requirement', status: 'completed', created_at: '2026-10-01T12:00:00', completed_at: null, source: 'modern', metadata_revision: metadataRevision, ...overrides })
const catalogue = (overrides = {}) => ({ source_revision: revision, observed_at: '2026-10-03T12:00:00Z', filters: { q: null, status: null }, offset: 0, limit: 20, matched_count: 1, returned_count: 1, has_more: false, unavailable_count: 0, unavailable_reasons: [], reports: [summary()], ...overrides })
const detail = (overrides = {}) => ({ ...summary(), observed_at: '2026-10-03T12:00:01Z', content_source: 'full_report.md', content_revision: contentRevision, content_bytes: 5, markdown_content: '# Hi\n', content_available: true, content_error: null, ...overrides })
const listFor = (call, overrides = {}) => catalogue({ filters: { q: call.args[0].q ?? null, status: call.args[0].status ?? null }, offset: call.args[0].offset, limit: call.args[0].limit, ...overrides })
async function setup(t, query = '', locale = 'en') {
  const d = deferredApi(), h = await mountReportLibrary({ api: d.api, initialPath: '/reports' + (query ? '?' + query : ''), locale })
  t.after(() => h.unmount()); return { h, ...d }
}
async function resolve(call, data) { assert.ok(call, 'expected request'); call.resolve(ok(data)); await flush() }

test('Home opens the standalone saved reports route', async t => {
  const h = await mountReportLibrary({ initialPath: '/' }); t.after(() => h.unmount())
  assert.equal(h.requests.calls.getSavedReports.length, 0)
  await h.click('saved-reports-link')
  assert.equal(h.router.currentRoute.value.path, '/reports')
  assert.equal(h.requests.calls.getSavedReports.length, 1)
})

for (const locale of ['en', 'zh']) test(`browse, open literal saved Markdown and download exact captured UTF-8 in ${locale}`, async t => {
  const { h, calls } = await setup(t, '', locale)
  assert.equal(calls.getSavedReports.length, 1); assert.equal(calls.getSavedReport.length, 0)
  await resolve(calls.getSavedReports[0], catalogue())
  assert.equal(h.router.currentRoute.value.query.revision, undefined)
  assert.match(h.text(), new RegExp(revision))
  assert.ok(h.byId('report-row-report_A')); assert.match(h.text(), /<img src=x>/)
  await h.click('open-report_A')
  assert.equal(calls.getSavedReports.length, 1)
  assert.equal(calls.getSavedReport[0].args[0], 'report_A')
  assert.equal(calls.getSavedReport[0].args[1].revision, metadataRevision)
  assert.equal(h.router.currentRoute.value.query.metadata_revision, metadataRevision)
  const text = '# 文 😀\r\n<img src="https://example.org/tracker" onerror="alert(1)">\n[link](https://example.org)\n'
  const saved = detail({ markdown_content: text, content_bytes: Buffer.byteLength(text) })
  await resolve(calls.getSavedReport[0], saved)
  assert.equal(h.text(h.byId('markdown')), text)
  assert.equal(h.all(node => ['img', 'iframe', 'script'].includes(node.type) || node.props.innerHTML).length, 0)
  saved.markdown_content = 'MUTATED_AFTER_CAPTURE'
  await h.click('download')
  const file = h.downloads[0]
  assert.equal(file.filename, 'report_A.md'); assert.equal(file.blob.type, 'text/markdown;charset=utf-8')
  assert.equal(await file.blob.text(), text)
  assert.deepEqual(Buffer.from(await file.blob.arrayBuffer()), Buffer.from(text))
  assert.doesNotMatch(h.text(), /savedReports\./); assert.deepEqual(h.warnings, [])
  assert.equal(h.timers.pending.size, 0)
})

test('empty saved Markdown is available and downloadable; missing content preserves metadata', async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  assert.deepEqual(Object.keys(calls.getSavedReport[0].args[1]), [])
  await resolve(calls.getSavedReport[0], detail({ markdown_content: '', content_bytes: 0 }))
  assert.ok(h.byId('reader')); assert.ok(h.byId('empty-content')); assert.equal(h.byId('download').props.disabled, false)
  await h.click('download'); assert.equal(h.downloads[0].blob.size, 0)
  await h.navigate('/reports?report_id=report_B')
  await resolve(calls.getSavedReport[1], detail({ report_id: 'report_B', title: 'Metadata remains', content_available: false, markdown_content: null, content_source: null, content_bytes: null, content_revision: null, content_error: 'not_saved' }))
  assert.match(h.text(h.byId('reader')), /Metadata remains/)
  assert.ok(h.byId('content-error')); assert.equal(h.byId('download').props.disabled, true)
})

test('search trims Unicode metadata phrase and applies status and page size with pinned pagination', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReports[0], catalogue())
  for (const id of ['search-phrase', 'status', 'page-size']) assert.ok(h.find(n => n.type === 'label' && n.props.for === h.byId(id).props.id))
  await h.input('search-phrase', '  Straße .* 文  '); await h.change('status', 'failed'); await h.change('page-size', '1')
  assert.equal(h.byId('results'), undefined)
  await h.submit('report-library-form')
  const first = calls.getSavedReports.at(-1)
  assert.equal(first.args[0].q, 'Straße .* 文'); assert.equal(first.args[0].status, 'failed'); assert.equal(first.args[0].limit, 1)
  assert.equal(first.args[0].revision, undefined)
  await resolve(first, listFor(first, { reports: [summary({ status: 'failed' })], matched_count: 2, has_more: true }))
  await h.click('next')
  const next = calls.getSavedReports.at(-1)
  assert.equal(next.args[0].offset, 1); assert.equal(next.args[0].revision, revision)
  await resolve(next, listFor(next, { reports: [summary({ report_id: 'report_B', status: 'failed' })], matched_count: 2 }))
  await h.click('previous'); assert.equal(calls.getSavedReports.at(-1).args[0].offset, 0)
  assert.match(h.text(), /metadata.*Markdown|Markdown.*metadata/i)
})

for (const query of ['unknown=x', 'q=a&q=b', 'status=', 'status=unknown', 'status=Completed', 'limit=0', 'limit=51', 'limit=1.5', 'offset=2001', 'offset=1', 'revision=X', 'report_id=../x', 'report_id=', 'report_id=a&report_id=b', `metadata_revision=${metadataRevision}`, 'report_id=report_A&metadata_revision=x', 'limit', 'q']) test(`invalid URL fails before requests: ${query}`, async t => {
  const { h, calls } = await setup(t, query)
  assert.equal(calls.getSavedReports.length, 0); assert.equal(calls.getSavedReport.length, 0)
  assert.ok(h.byId('error')); assert.equal(h.byId('download').props.disabled, true)
})

test('empty or whitespace query normalizes to omitted; 200 Unicode characters are accepted', async t => {
  for (const value of ['', '  ', '😀'.repeat(200)]) {
    const { h, calls } = await setup(t, 'q=' + encodeURIComponent(value))
    assert.equal(calls.getSavedReports.length, 1)
    assert.equal(calls.getSavedReports[0].args[0].q, value.trim() || undefined)
    h.unmount()
  }
})

test('manual Refresh discards both revisions, selected report, reader and download', async t => {
  const { h, calls } = await setup(t, `report_id=report_A&metadata_revision=${metadataRevision}&revision=${revision}`)
  await resolve(calls.getSavedReports[0], catalogue()); await resolve(calls.getSavedReport[0], detail()); await h.click('download')
  await h.click('refresh')
  const params = calls.getSavedReports.at(-1).args[0]
  assert.equal(params.revision, undefined); assert.equal(params.offset, 0)
  assert.equal(h.router.currentRoute.value.query.report_id, undefined); assert.equal(h.router.currentRoute.value.query.metadata_revision, undefined)
  assert.equal(h.byId('reader'), undefined); assert.equal(h.byId('download').props.disabled, true)
  assert.ok(h.revokedUrls.includes(h.downloads[0].url))
})

for (const control of ['search-phrase', 'status', 'page-size']) test(`${control} retires list/detail/export synchronously even if abort is ignored`, async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  await resolve(calls.getSavedReport[0], detail()); await h.click('download')
  const target = h.byId(control), value = control === 'status' ? 'failed' : control === 'page-size' ? '10' : 'new'
  ;(target.props.onInput ?? target.props.onChange)({ target: { value } })
  assert.ok(calls.getSavedReports[0].signal.aborted); assert.ok(calls.getSavedReport[0].signal.aborted)
  assert.ok(h.revokedUrls.includes(h.downloads[0].url))
  await resolve(calls.getSavedReports[0], catalogue())
  assert.equal(h.byId('results'), undefined); assert.equal(h.byId('reader'), undefined); assert.equal(h.byId('download').props.disabled, true)
})

test('list A to B to A rejects stale success, error and finally; Back and Forward restore controls', async t => {
  const { h, calls } = await setup(t, 'q=alpha')
  await h.navigate('/reports?q=beta'); await h.navigate('/reports?q=alpha')
  assert.equal(calls.getSavedReports.length, 3)
  calls.getSavedReports[0].reject(new Error('SECRET_STALE_ERROR'))
  await resolve(calls.getSavedReports[1], listFor(calls.getSavedReports[1]))
  assert.ok(h.byId('loading')); assert.equal(h.byId('results'), undefined)
  await resolve(calls.getSavedReports[2], listFor(calls.getSavedReports[2]))
  assert.ok(h.byId('results')); await h.input('search-phrase', 'unapplied')
  await h.back(); assert.equal(h.byId('search-phrase').props.value, 'beta')
  await h.forward(); assert.equal(h.byId('search-phrase').props.value, 'alpha')
  assert.doesNotMatch(h.text(), /SECRET_STALE_ERROR/)
})

test('detail A to B to A has separate request ownership and cannot expose retired content', async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  await h.navigate('/reports?report_id=report_B'); await h.navigate('/reports?report_id=report_A')
  assert.equal(calls.getSavedReports.length, 1); assert.equal(calls.getSavedReport.length, 3)
  await resolve(calls.getSavedReport[0], detail({ markdown_content: 'old A', content_bytes: 5 }))
  calls.getSavedReport[1].reject(new Error('SECRET_DETAIL_ERROR')); await flush()
  assert.ok(h.byId('detail-loading')); assert.equal(h.byId('reader'), undefined)
  await resolve(calls.getSavedReport[2], detail())
  assert.equal(h.text(h.byId('markdown')), '# Hi\n'); assert.doesNotMatch(h.text(), /old A|SECRET_DETAIL_ERROR/)
})

test('unmount aborts both requests and prevents late settlement or downloads', async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  await h.navigate('/')
  assert.ok(calls.getSavedReports[0].signal.aborted); assert.ok(calls.getSavedReport[0].signal.aborted)
  await resolve(calls.getSavedReports[0], catalogue()); await resolve(calls.getSavedReport[0], detail())
  assert.equal(h.byId('results'), undefined); assert.equal(h.downloads.length, 0); assert.equal(h.timers.pending.size, 0)
})

test('unavailable counts and saved statuses remain honest; unknown never appears completed', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReports[0], catalogue({ reports: [summary({ status: 'unknown' })], unavailable_count: 2, unavailable_reasons: [{ code: 'metadata_unreadable', count: 1 }, { code: 'unsafe_path', count: 1 }] }))
  assert.match(h.text(h.byId('report-row-report_A')), /Unknown/)
  assert.match(h.text(h.byId('unavailable')), /2/)
  assert.match(h.text(), /unreadable|read/i); assert.match(h.text(), /unsafe|safe/i)
})

for (const code of ['sources_changed', 'metadata_unavailable', 'report_not_found', 'response_too_large', 'library_unavailable']) test(`detail failure ${code} preserves catalogue with a fixed message`, async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  await resolve(calls.getSavedReports[0], catalogue())
  calls.getSavedReport[0].reject({ response: { data: { error_code: code, error: 'SECRET /private/path' } } }); await flush()
  assert.ok(h.byId('results')); assert.ok(h.byId('detail-error')); assert.equal(h.byId('download').props.disabled, true)
  assert.doesNotMatch(h.text(), /SECRET|private\/path/)
})

test('English and Chinese report library copy has matching nonempty keys', () => {
  const values = ['en', 'zh'].map(locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8')).savedReports)
  assert.ok(values.every(Boolean))
  const entries = (node, path = '') => Object.entries(node).flatMap(([key, value]) => typeof value === 'string' ? [[path + key, value]] : entries(value, path + key + '.'))
  assert.deepEqual(entries(values[0]).map(([key]) => key).sort(), entries(values[1]).map(([key]) => key).sort())
  assert.ok(values.every(node => entries(node).every(([, value]) => value.trim())))
  // A conflict can come from metadata OR a body changed during capture.
  assert.match(values[0].errors.sources_changed, /report files changed/i)
  assert.match(values[1].errors.sources_changed, /报告文件发生变化/)
})

for (const control of ['apply', 'next', 'refresh', 'open-report_A']) test(`delayed ${control} cannot restore retired data over new draft`, async t => {
  const { h, calls } = await setup(t, 'limit=1')
  await resolve(calls.getSavedReports[0], catalogue({ limit: 1, matched_count: 2, has_more: true }))
  let release, delayed = false
  h.router.beforeEach(() => { if (!delayed) { delayed = true; return new Promise(resolve => { release = resolve }) } return true })
  if (control === 'apply') await h.input('search-phrase', 'pending')
  await h.click(control); assert.ok(release)
  await h.input('search-phrase', 'new draft'); await h.change('status', 'failed')
  release(true); await flush()
  assert.equal(calls.getSavedReports.length, 1); assert.equal(calls.getSavedReport.length, 0)
  assert.equal(h.byId('search-phrase').props.value, 'new draft'); assert.equal(h.byId('status').props.value, 'failed')
  assert.equal(h.byId('results'), undefined); assert.equal(h.byId('download').props.disabled, true)
})

test('catalogue settlement cannot navigate over a pending route or restore a retired draft', async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  await h.input('search-phrase', 'unapplied')
  await resolve(calls.getSavedReports[0], catalogue())
  await resolve(calls.getSavedReport[0], detail())
  assert.equal(h.router.currentRoute.value.fullPath, '/reports?report_id=report_A')
  assert.equal(h.byId('search-phrase').props.value, 'unapplied'); assert.equal(h.byId('results'), undefined); assert.equal(h.byId('reader'), undefined)
  assert.equal(h.byId('download').props.disabled, true)
})

test('catalogue settlement preserves the selected detail and never sends catalogue revision as metadata revision', async t => {
  const { h, calls } = await setup(t, `report_id=report_A&metadata_revision=${metadataRevision}`)
  await resolve(calls.getSavedReport[0], detail()); await h.click('download')
  await resolve(calls.getSavedReports[0], catalogue())
  assert.equal(calls.getSavedReport.length, 1); assert.equal(calls.getSavedReport[0].args[1].revision, metadataRevision)
  assert.equal(h.router.currentRoute.value.query.revision, undefined); assert.equal(h.router.currentRoute.value.query.metadata_revision, metadataRevision)
  assert.equal(h.text(h.byId('markdown')), '# Hi\n'); assert.equal(h.byId('download').props.disabled, false)
})

test('settling old catalogue cannot cancel a newer route navigation with revision acknowledgement', async t => {
  const { h, calls } = await setup(t, 'q=alpha')
  const navigation = h.router.push('/reports?q=beta')
  await resolve(calls.getSavedReports[0], listFor(calls.getSavedReports[0]))
  await navigation; await flush()
  assert.equal(h.router.currentRoute.value.query.q, 'beta')
  assert.equal(calls.getSavedReports.length, 2); assert.equal(calls.getSavedReports[1].args[0].q, 'beta')
  assert.equal(h.byId('results'), undefined)
})

for (const [name, changes] of [
  ['catalogue revision', { source_revision: 'invalid' }], ['wrong page', { offset: 1 }], ['wrong filter echo', { filters: { q: 'unrequested', status: null } }],
  ['missing count', { matched_count: undefined }], ['incorrect has_more', { has_more: true }], ['duplicate reports', { returned_count: 2, matched_count: 2, reports: [summary(), summary()] }],
  ['unknown skipped reason', { unavailable_count: 1, unavailable_reasons: [{ code: 'SECRET /private/path', count: 1 }] }], ['inconsistent skipped count', { unavailable_count: 1 }],
  ['unsafe ID', { reports: [summary({ report_id: '../secret' })] }], ['invalid saved status', { reports: [summary({ status: 'running' })] }],
]) test(`invalid catalogue envelope rejects ${name}`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReports[0], catalogue(changes))
  assert.equal(h.byId('results'), undefined); assert.ok(h.byId('error')); assert.doesNotMatch(h.text(), /SECRET|private\/path/)
})

for (const [name, changes] of [
  ['wrong report', { report_id: 'report_B' }], ['wrong metadata revision', { metadata_revision: revision }],
  ['wrong byte count', { content_bytes: 4 }], ['missing content hash', { content_revision: null }], ['unavailable content string', { content_available: false }],
  ['unknown content source', { content_source: '/private/path' }], ['non-string body', { markdown_content: [] }],
]) test(`invalid detail envelope disables export: ${name}`, async t => {
  const { h, calls } = await setup(t, `report_id=report_A&metadata_revision=${metadataRevision}`)
  await resolve(calls.getSavedReport[0], detail(changes))
  assert.equal(h.byId('reader'), undefined); assert.ok(h.byId('detail-error')); assert.equal(h.byId('download').props.disabled, true)
})

for (const contentError of ['unreadable', 'too_large']) test(`unavailable saved body ${contentError} keeps reader metadata`, async t => {
  const { h, calls } = await setup(t, 'report_id=report_A')
  await resolve(calls.getSavedReport[0], detail({ content_available: false, content_source: 'full_report.md', content_revision: null, content_bytes: null, markdown_content: null, content_error: contentError }))
  assert.ok(h.byId('reader')); assert.match(h.text(), /Saved report A/); assert.ok(h.byId('content-error')); assert.equal(h.byId('download').props.disabled, true)
})
