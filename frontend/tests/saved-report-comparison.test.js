import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountReportLibrary, deferredApi, flush, ok } from './helpers/report-library-view-fixture.js'

import * as utility from '../src/utils/savedReportComparison.js'
import { createSavedReportFile, readSavedReportFile } from '../src/utils/savedReportFiles.js'
import { REPORT_OBSERVATION_KEYS } from '../src/utils/savedReportObservation.js'
const revision = 'a'.repeat(64), metadataRevision = 'b'.repeat(64), contentRevision = 'c'.repeat(64)
const summary = (id = 'report_A', overrides = {}) => ({ report_id: id, simulation_id: 'sim_saved', title: `Saved ${id}`, summary_preview: '', requirement_preview: '', status: 'completed', created_at: null, completed_at: null, source: 'modern', metadata_revision: metadataRevision, ...overrides })
const detail = (text = 'A\n', id = 'report_A', overrides = {}) => ({ ...summary(id), observed_at: '2026-10-05T12:00:01Z', content_source: 'full_report.md', content_revision: contentRevision, content_bytes: Buffer.byteLength(text), markdown_content: text, content_available: true, content_error: null, ...overrides })
const listFor = (call, ids = ['report_A'], overrides = {}) => ({ source_revision: revision, observed_at: '2026-10-05T12:00:00Z', filters: { q: call.args[0].q ?? null, status: call.args[0].status ?? null }, offset: call.args[0].offset, limit: call.args[0].limit, matched_count: ids.length, returned_count: ids.length, has_more: false, unavailable_count: 0, unavailable_reasons: [], reports: ids.map(id => summary(id)), ...overrides })
async function resolve(call, data) { assert.ok(call); call.resolve(ok(data)); await flush() }
async function setup(t, locale = 'en', query = 'report_id=report_A') {
  const d = deferredApi(), h = await mountReportLibrary({ api: d.api, initialPath: '/reports?' + query, locale })
  t.after(() => h.unmount())
  return { h, calls: d.calls }
}
async function open(h, calls, id, text, overrides = {}) {
  await h.navigate('/reports?report_id=' + id)
  await resolve(calls.getSavedReport.at(-1), detail(text, id, overrides))
}
const invoke = handler => handler({ button: 0, preventDefault() {}, stopPropagation() {} })
const countCalls = calls => calls.getSavedReport.length + calls.getSavedReports.length

async function assertObservationDownload(file, expected, side) {
  assert.ok(file.blob instanceof Blob)
  assert.equal(file.blob.type, 'application/json;charset=utf-8')
  assert.equal(file.filename, `${expected.report_id}-${side}-${expected.metadata_revision.slice(0, 12)}-${expected.content_revision?.slice(0, 12) ?? 'unavailable'}.observation.json`)
  assert.match(file.filename, /^[A-Za-z0-9_-]+\.observation\.json$/)
  assert.ok(file.filename.length <= 177)
  const text = await file.blob.text()
  assert.equal(text, createSavedReportFile(expected))
  assert.deepEqual(Object.keys(JSON.parse(text)), ['format', 'version', 'observation'])
  assert.deepEqual(Object.keys(JSON.parse(text).observation), REPORT_OBSERVATION_KEYS)
  const reopened = await readSavedReportFile(file.blob)
  assert.deepEqual(reopened, expected)
  assert.ok(Object.isFrozen(reopened))
  if (expected.content_available) assert.deepEqual(Buffer.from(reopened.markdown_content), Buffer.from(expected.markdown_content))
}

test('side JSON retains old and new same-ID observations beyond the preview after reader replacement and closure', async t => {
  const { h, calls } = await setup(t)
  const old = detail('\ufeff<script>literal</script>\r\n雪😀'.repeat(3000), 'report_A', { title: '../unsafe title', summary_preview: 'earlier summary', requirement_preview: 'earlier requirement', status: 'generating', created_at: 'arbitrary creation', completed_at: null })
  await resolve(calls.getSavedReport[0], { ...old, ignored: 'not part of the file' }); await h.click('capture-left')
  await open(h, calls, 'report_B', 'intermediate')
  const next = detail('new same-ID body\n', 'report_A', { content_revision: 'd'.repeat(64), observed_at: '2026-10-05T12:01:00Z' })
  await open(h, calls, 'report_A', next.markdown_content, next); await h.click('capture-right')
  assert.ok(h.byId('comparison-left-truncated'))
  const count = countCalls(calls)
  await h.click('comparison-left-download-json'); await assertObservationDownload(h.downloads.at(-1), old, 'left')
  await h.click('comparison-right-download-json'); await assertObservationDownload(h.downloads.at(-1), next, 'right')
  await h.click('close-reader')
  await h.click('comparison-left-download-json'); await assertObservationDownload(h.downloads.at(-1), old, 'left')
  assert.equal(countCalls(calls), count)
  assert.deepEqual(h.warnings, [])
})

test('bounded comparison utility exists and distinguishes exact text from missing bodies', () => {
  assert.equal(typeof utility.compareCapturedText, 'function', 'missing captured-text comparison utility')
  const compare = utility.compareCapturedText
  for (const text of ['', 'a\r\n雪😀\n', 'x'.repeat(8 * 1024 * 1024)]) {
    const result = compare(text, text)
    assert.equal(result.status, 'identical'); assert.equal(result.added, 0); assert.equal(result.removed, 0); assert.deepEqual(result.rows, [])
  }
  for (const pair of [[null, ''], ['', null], [null, null]]) {
    const result = compare(...pair); assert.equal(result.status, 'unavailable'); assert.equal(result.added, null); assert.equal(result.removed, null)
  }
})

test('line diff preserves repeated lines, Unicode, blank lines, CRLF, CR and trailing newlines', () => {
  assert.equal(typeof utility.compareCapturedText, 'function')
  const compare = utility.compareCapturedText
  for (const [left, right] of [['a\na\nb\n', 'a\nb\na\n'], ['', '\n'], ['x', 'x\n'], ['x\n', 'x\r\n'], ['雪😀\n\n', '雪😀\r\n\n'], ['a\rb', 'a\nb']]) {
    const result = compare(left, right)
    assert.equal(result.status, 'different')
    const rebuild = kinds => result.rows.filter(row => kinds.includes(row.kind)).map(row => row.text + ({ LF: '\n', CRLF: '\r\n', CR: '\r', NONE: '' })[row.ending]).join('')
    assert.equal(rebuild(['same', 'removed']), left); assert.equal(rebuild(['same', 'added']), right)
    assert.equal(result.added, result.rows.filter(row => row.kind === 'added').length)
    assert.equal(result.removed, result.rows.filter(row => row.kind === 'removed').length)
    assert.deepEqual(compare(left, right), result)
    const reverse = compare(right, left); assert.equal(reverse.added, result.removed); assert.equal(reverse.removed, result.added)
  }
})

test('UTF-8 preview and diff budgets admit boundaries and reject excess before complete rows', () => {
  assert.equal(typeof utility.compareCapturedText, 'function'); assert.equal(typeof utility.previewCapturedText, 'function')
  assert.deepEqual(utility.COMPARISON_LIMITS, { bytes: 65536, lines: 2000, cells: 1000000, rows: 4000 })
  const compare = utility.compareCapturedText, preview = utility.previewCapturedText
  assert.deepEqual(preview('a'.repeat(65536)), { text: 'a'.repeat(65536), truncated: false })
  assert.deepEqual(preview('a'.repeat(65535) + '😀'), { text: 'a'.repeat(65535), truncated: true })
  assert.deepEqual(preview('雪'.repeat(21845) + 'a'), { text: '雪'.repeat(21845) + 'a', truncated: false })
  assert.equal(compare('a'.repeat(65536), 'b').status, 'different')
  assert.equal(compare('x\n'.repeat(2000), '').status, 'different')
  assert.equal(compare('a\n'.repeat(999), 'b\n'.repeat(999)).status, 'different')
  for (const [left, right, reason] of [['a'.repeat(65537), 'b', 'bytes'], ['雪'.repeat(21846), '', 'bytes'], ['x\n'.repeat(2001), '', 'lines'], ['a\n'.repeat(1000), 'b\n'.repeat(999), 'cells']]) {
    const result = compare(left, right)
    assert.equal(result.status, 'limited'); assert.equal(result.reason, reason); assert.equal(result.added, null); assert.equal(result.removed, null); assert.deepEqual(result.rows, [])
  }
  assert.ok(compare('x\n'.repeat(2000), '').rows.length <= 4000)
})

for (const locale of ['en', 'zh']) test(`real parent and comparison capture literal exact sources and render provenance in ${locale}`, async t => {
  const { h, calls } = await setup(t, locale)
  const text = '<script>alert(1)</script>\r\n<img src="https://invalid.test/pixel"> 雪 😀\n'
  await resolve(calls.getSavedReport[0], detail(text))
  assert.ok(h.byId('capture-left'), 'missing actual comparison child capture control')
  const count = countCalls(calls)
  await h.click('capture-left'); await h.click('capture-right')
  assert.equal(h.byId('comparison-status').props['data-status'], 'identical')
  assert.equal(h.text(h.byId('comparison-left-text')), text)
  assert.match(h.text(h.byId('comparison-left')), /report_A/)
  for (const value of [metadataRevision, contentRevision, '2026-10-05T12:00:01Z']) assert.ok(h.text(h.byId('comparison-left')).includes(value))
  assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type) || Object.hasOwn(n.props, 'innerHTML')).length, 0)
  await h.click('comparison-left-download'); await h.click('comparison-right-download')
  assert.equal(countCalls(calls), count)
  for (const [index, file] of h.downloads.entries()) { assert.equal(file.filename, `report_A-${index === 0 ? 'left' : 'right'}-${contentRevision.slice(0, 12)}.md`); assert.deepEqual(Buffer.from(await file.blob.arrayBuffer()), Buffer.from(text)) }
  assert.doesNotMatch(h.text(), /savedReportComparison\./); assert.deepEqual(h.warnings, [])
  await h.timers.advance(1000); assert.equal(h.revokedUrls.length, 2)
})

test('captures persist across catalogue pages, filters, refresh and reader closure but not page departure', async t => {
  const { h, calls } = await setup(t, 'en', 'limit=1')
  await resolve(calls.getSavedReports[0], listFor(calls.getSavedReports[0], ['report_A'], { matched_count: 2, has_more: true }))
  await h.click('open-report_A'); await resolve(calls.getSavedReport[0], detail('first\n'))
  await h.click('capture-left'); await h.click('next')
  await resolve(calls.getSavedReports.at(-1), listFor(calls.getSavedReports.at(-1), ['report_B'], { matched_count: 2 }))
  assert.equal(h.text(h.byId('comparison-left-text')), 'first\n')
  await h.click('open-report_B'); await resolve(calls.getSavedReport.at(-1), detail('second\n', 'report_B', { status: 'generating' }))
  await h.click('capture-right'); await h.click('close-reader')
  await h.input('search-phrase', 'new filter'); await h.click('apply')
  await resolve(calls.getSavedReports.at(-1), listFor(calls.getSavedReports.at(-1), []))
  await h.click('refresh')
  assert.equal(h.text(h.byId('comparison-left-text')), 'first\n'); assert.equal(h.text(h.byId('comparison-right-text')), 'second\n')
  assert.equal(h.byId('comparison-status').props['data-status'], 'different')
  assert.match(h.text(h.byId('comparison-right')), /Generating/)
  assert.ok(!Object.keys(h.router.currentRoute.value.query).some(key => /left|right|compar/i.test(key)))
  await h.back(); await h.forward()
  assert.equal(h.text(h.byId('comparison-left-text')), 'first\n')
  await h.navigate('/'); await h.navigate('/reports')
  assert.equal(h.byId('comparison-left-text'), undefined); assert.equal(h.byId('comparison-right-text'), undefined)
})

test('same-ID body-only rewrite creates independent captures; replacement, swap and clear retire callbacks', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('old\r\n')); await h.click('capture-left')
  const staleCapture = h.byId('capture-right').props.onClick
  await open(h, calls, 'report_B', 'other')
  await open(h, calls, 'report_A', 'new\n', { content_revision: 'd'.repeat(64), observed_at: '2026-10-05T12:01:00Z' })
  invoke(staleCapture); await flush(); assert.equal(h.byId('comparison-right-text'), undefined)
  await h.click('capture-right')
  assert.equal(h.byId('comparison-status').props['data-status'], 'different')
  assert.equal(h.text(h.byId('comparison-left-text')), 'old\r\n'); assert.equal(h.text(h.byId('comparison-right-text')), 'new\n')
  const retired = ['comparison-left-download', 'comparison-left-download-json', 'comparison-left-clear', 'comparison-swap', 'comparison-clear', 'capture-left'].map(id => h.byId(id).props.onClick)
  const count = countCalls(calls)
  await h.click('comparison-swap')
  retired.forEach(invoke); await flush()
  assert.equal(h.downloads.length, 0); assert.equal(h.text(h.byId('comparison-left-text')), 'new\n'); assert.equal(h.text(h.byId('comparison-right-text')), 'old\r\n')
  await h.click('comparison-left-download'); const url = h.downloads.at(-1).url
  assert.equal(h.downloads.at(-1).filename, 'report_A-left-dddddddddddd.md')
  await h.click('capture-left'); assert.ok(h.revokedUrls.includes(url))
  const clearOld = h.byId('comparison-left-clear').props.onClick
  await h.click('comparison-left-clear'); await h.click('capture-left'); invoke(clearOld); await flush()
  assert.equal(h.text(h.byId('comparison-left-text')), 'new\n')
  const downloadOld = h.byId('comparison-left-download').props.onClick
  await h.click('comparison-clear'); invoke(downloadOld); await flush()
  assert.equal(h.downloads.length, 1); assert.equal(h.byId('comparison-left-text'), undefined)
  assert.equal(countCalls(calls), count)
})

test('capture rejects synchronous retirement and ignored-abort A to B to A responses', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('accepted')); await h.click('capture-left')
  const stale = h.byId('capture-right').props.onClick
  h.byId('search-phrase').props.onInput({ target: { value: 'draft' } }); invoke(stale)
  await flush(); assert.equal(h.byId('comparison-right-text'), undefined)
  await h.navigate('/reports?report_id=report_B'); const oldB = calls.getSavedReport.at(-1)
  await h.navigate('/reports?report_id=report_A'); const oldA = calls.getSavedReport.at(-1)
  await h.navigate('/reports?report_id=report_B'); const newB = calls.getSavedReport.at(-1)
  await resolve(oldB, detail('retired B', 'report_B')); oldA.reject(new Error('SECRET')); await flush()
  assert.ok(h.byId('capture-right').props.disabled)
  await resolve(newB, detail('current B', 'report_B')); await h.click('capture-right')
  assert.equal(h.text(h.byId('comparison-left-text')), 'accepted'); assert.equal(h.text(h.byId('comparison-right-text')), 'current B')
  const actions = ['capture-left', 'comparison-left-download', 'comparison-left-download-json', 'comparison-swap', 'comparison-clear'].map(id => h.byId(id).props.onClick)
  await h.navigate('/'); actions.forEach(invoke); await flush()
  assert.equal(h.downloads.length, 0); assert.equal(h.timers.pending.size, 0)
})

for (const changes of [{ report_id: 'report_B' }, { content_bytes: 99 }, { content_revision: null }, { metadata_revision: revision }]) test(`invalid detail cannot replace capture: ${JSON.stringify(changes)}`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('kept')); await h.click('capture-left')
  await h.navigate('/reports?report_id=report_A&metadata_revision=' + metadataRevision)
  await resolve(calls.getSavedReport.at(-1), detail('wrong', 'report_A', changes))
  assert.ok(h.byId('detail-error')); assert.ok(h.byId('capture-right').props.disabled)
  assert.equal(h.text(h.byId('comparison-left-text')), 'kept')
})

for (const contentError of ['not_saved', 'unreadable', 'too_large']) test(`empty available text stays distinct from ${contentError} body`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('', 'report_A', { status: 'failed' })); await h.click('capture-left')
  await open(h, calls, 'report_B', '', { status: 'generating', content_available: false, markdown_content: null, content_bytes: null, content_revision: null, content_source: null, content_error: contentError })
  await h.click('capture-right')
  assert.equal(h.byId('comparison-status').props['data-status'], 'unavailable')
  assert.ok(h.byId('comparison-right-download').props.disabled)
  assert.equal(h.text(h.byId('comparison-left-text')), '')
  await h.click('comparison-left-download'); assert.equal(h.downloads[0].blob.size, 0)
  const empty = detail('', 'report_A', { status: 'failed' })
  const missing = detail('', 'report_B', { status: 'generating', content_available: false, markdown_content: null, content_bytes: null, content_revision: null, content_source: null, content_error: contentError })
  await h.click('close-reader')
  await h.click('comparison-left-download-json'); await assertObservationDownload(h.downloads.at(-1), empty, 'left')
  await h.click('comparison-right-download-json'); await assertObservationDownload(h.downloads.at(-1), missing, 'right')
  assert.match(h.text(h.byId('comparison-left')), /Failed/); assert.match(h.text(h.byId('comparison-right')), /Generating/)
})

test('large differences render bounded previews and honest unknown counts but download full accepted text', async t => {
  const { h, calls } = await setup(t)
  const large = '😀'.repeat(17000)
  await resolve(calls.getSavedReport[0], detail(large)); await h.click('capture-left')
  await open(h, calls, 'report_B', large + '\n'); await h.click('capture-right')
  assert.equal(h.byId('comparison-status').props['data-status'], 'limited')
  assert.ok(h.byId('comparison-left-truncated')); assert.ok(h.byId('comparison-right-truncated'))
  assert.equal(Buffer.byteLength(h.text(h.byId('comparison-left-text'))), 65536)
  assert.equal(h.byId('comparison-diff'), undefined)
  assert.match(h.text(h.byId('comparison-status')), /unknown/i)
  await h.click('comparison-left-download'); assert.equal(await h.downloads[0].blob.text(), large)
})

test('comparison locales have matching nonempty keys and explain independent temporary literal captures', () => {
  const values = ['en', 'zh'].map(locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8')).savedReportComparison)
  assert.ok(values.every(Boolean), 'missing comparison translations')
  const entries = (node, path = '') => Object.entries(node).flatMap(([key, value]) => typeof value === 'string' ? [[path + key, value]] : entries(value, path + key + '.'))
  assert.deepEqual(entries(values[0]).map(([key]) => key).sort(), entries(values[1]).map(([key]) => key).sort())
  assert.ok(values.every(node => entries(node).every(([, value]) => value.trim())))
  assert.match(values[0].scope, /independent/i); assert.match(values[0].scope, /temporary/i)
  assert.match(values[0].instructions, /JSON/); assert.match(values[0].downloadJson, /JSON/)
})

test('repeated-line changes use a minimal deterministic alignment', () => {
  const result = utility.compareCapturedText('a\na\nb\n', 'a\nb\na\n')
  assert.equal(result.added, 1); assert.equal(result.removed, 1)
  assert.deepEqual(result.rows.map(row => row.kind), ['same', 'removed', 'same', 'added'])
  const maximumRows = utility.compareCapturedText('a\n'.repeat(2000), 'b\n'.repeat(498))
  assert.equal(maximumRows.status, 'different'); assert.equal(maximumRows.rows.length, 2498)
})

for (const locale of ['en', 'zh']) test(`compiled changes expose newline and blank-line distinctions in ${locale}`, async t => {
  const { h, calls } = await setup(t, locale)
  await resolve(calls.getSavedReport[0], detail('x\n\n')); await h.click('capture-left')
  await open(h, calls, 'report_B', 'x\r\n'); await h.click('capture-right')
  const diff = h.byId('comparison-diff'); assert.ok(diff)
  assert.match(h.text(diff), /CRLF/); assert.match(h.text(diff), /LF/)
  assert.match(h.text(diff), locale === 'en' ? /Blank line/ : /空行/)
  assert.equal(h.all(node => node.props['data-kind'] === 'removed').length, 2)
  assert.equal(h.all(node => node.props['data-kind'] === 'added').length, 1)
  assert.doesNotMatch(h.text(), /savedReportComparison\./); assert.deepEqual(h.warnings, [])
})

test('different IDs and hashes can have equal empty or full 8 MiB accepted bodies', async t => {
  const { h, calls } = await setup(t)
  for (const text of ['', 'x'.repeat(8 * 1024 * 1024)]) {
    if (calls.getSavedReport.length > 1) await h.navigate('/reports?report_id=report_A')
    await resolve(calls.getSavedReport.at(-1), detail(text)); await h.click('capture-left')
    await open(h, calls, 'report_B', text, { content_revision: 'd'.repeat(64) }); await h.click('capture-right')
    assert.equal(h.byId('comparison-status').props['data-status'], 'identical')
    assert.equal(h.byId('comparison-diff'), undefined)
    assert.ok(Buffer.byteLength(h.text(h.byId('comparison-left-text'))) <= 65536)
    const count = countCalls(calls)
    await h.click('comparison-right-download'); assert.equal(await h.downloads.at(-1).blob.text(), text)
    assert.equal(countCalls(calls), count)
  }
})

test('repeated source downloads retire URLs and old timers cannot revoke newer URLs', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('exact\r\n')); await h.click('capture-left')
  await h.click('comparison-left-download')
  const first = h.downloads.at(-1), oldTimer = [...h.timers.pending.values()][0].callback
  await h.click('comparison-left-download'); const second = h.downloads.at(-1)
  assert.ok(h.revokedUrls.includes(first.url)); oldTimer()
  assert.ok(!h.revokedUrls.includes(second.url))
  await h.navigate('/')
  assert.ok(h.revokedUrls.includes(second.url)); assert.equal(h.timers.pending.size, 0)
})

for (const code of ['sources_changed', 'metadata_unavailable', 'report_not_found']) test(`selected detail ${code} leaves the accepted pair unchanged`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('kept')); await h.click('capture-left'); await h.click('capture-right')
  await h.navigate('/reports?report_id=report_B')
  calls.getSavedReport.at(-1).reject({ response: { data: { error_code: code, error: 'SECRET /private/file' } } }); await flush()
  assert.ok(h.byId('detail-error')); assert.ok(h.byId('capture-left').props.disabled)
  assert.equal(h.text(h.byId('comparison-left-text')), 'kept'); assert.equal(h.text(h.byId('comparison-right-text')), 'kept')
  assert.doesNotMatch(h.text(), /SECRET|private\/file/)
})

test('Refresh retires capture admission before child props update even behind a delayed router guard', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedReport[0], detail('kept')); await h.click('capture-left')
  const stale = h.byId('capture-right').props.onClick
  let release
  h.router.beforeEach(() => new Promise(resolve => { release = resolve }))
  invoke(h.byId('refresh').props.onClick); invoke(stale)
  await flush()
  assert.ok(release); assert.equal(h.byId('comparison-right-text'), undefined)
  assert.equal(h.text(h.byId('comparison-left-text')), 'kept')
  release(true); await flush()
  assert.equal(h.byId('comparison-right-text'), undefined)
})
