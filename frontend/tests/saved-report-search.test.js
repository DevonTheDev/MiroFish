import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mountReportLibrary, deferredApi, flush, ok } from './helpers/report-library-view-fixture.js'
import { findReportPassages } from '../src/utils/savedReportSearch.js'
import * as reportSearch from '../src/utils/savedReportSearch.js'

const metadataRevision = 'b'.repeat(64), contentRevision = 'c'.repeat(64)
const detail = (text, id = 'report_A', overrides = {}) => ({ report_id: id, simulation_id: 'sim_saved', title: `Saved ${id}`, summary_preview: '', requirement_preview: '', status: 'completed', created_at: null, completed_at: null, source: 'modern', metadata_revision: metadataRevision, observed_at: '2026-10-06T04:00:00Z', content_source: 'full_report.md', content_revision: contentRevision, content_bytes: Buffer.byteLength(text), markdown_content: text, content_available: true, content_error: null, ...overrides })
async function resolve(call, data) { assert.ok(call); call.resolve(ok(data)); await flush() }
async function setup(t, text, options = {}) {
  const d = deferredApi(), h = await mountReportLibrary({ api: d.api, initialPath: '/reports?report_id=report_A', ...options })
  t.after(() => h.unmount())
  await resolve(d.calls.getSavedReport[0], detail(text))
  return { h, calls: d.calls }
}
const marks = h => h.all(node => node.type === 'mark')
const literalText = target => (target.type === '#comment' ? '' : target.text ?? '') + (target.children ?? []).map(literalText).join('')
const countCalls = calls => calls.getSavedReport.length + calls.getSavedReports.length

test('maximum dense line-break body and admitted nonmatch finish within an isolated 20-second budget', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/saved-report-search-performance.mjs', import.meta.url))], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.error?.code, undefined, `saved-report search exceeded the isolated 20-second budget: ${run.error?.code}`)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const measurement = JSON.parse(run.stdout)
  assert.equal(measurement.bodyBytes, 8 * 1024 * 1024)
  assert.equal(measurement.queryCodePoints, 200)
  assert.ok(Number.isFinite(measurement.milliseconds))
})

test('the prepared search index preserves raw offsets with compact CRLF mapping and no-CR fast path', () => {
  assert.equal(typeof reportSearch.createReportSearchIndex, 'function')
  const plain = '🐟\n𐐀 [literal]+\n', direct = reportSearch.createReportSearchIndex(plain)
  assert.equal(direct.text, plain)
  assert.equal(direct.removedCRLF, null)
  const body = '🐟\r\n𐐀\r\nx\ry\n', prepared = reportSearch.createReportSearchIndex(body)
  assert.equal(prepared.text, '🐟\n𐐀\nx\ny\n')
  assert.ok(prepared.removedCRLF instanceof Uint32Array)
  assert.deepEqual([...prepared.removedCRLF], [2, 5])
  assert.equal(prepared.removedCRLF.byteLength, 8)
  assert.deepEqual(findReportPassages(prepared, '𐐨\nx\ny'), { matches: [{ start: 4, end: 11 }], more: false })
  assert.equal(body.slice(4, 11), '𐐀\r\nx\ry')
  assert.equal(reportSearch.createReportSearchIndex('a\rb').removedCRLF, null)
})

test('the reader lazily reuses one prepared index and retires it with the exact source snapshot', async t => {
  const indexes = [], body = 'first\r\nFIRST\r\nlast'
  const { h, calls } = await setup(t, body, { onSearchIndex: index => indexes.push(index) })
  assert.equal(indexes.length, 0)
  await h.change('report-find-case', true)
  await h.input('report-find', '')
  await h.input('report-find', 'x'.repeat(201))
  await h.change('report-find-case', false)
  assert.equal(indexes.length, 0)
  await h.click('report-find-clear'); await h.input('report-find', 'first')
  assert.equal(indexes.length, 1)
  for (const query of ['last', '\n', 'first', 'absent']) await h.input('report-find', query)
  await h.change('report-find-case', true); await h.change('report-find-case', false)
  await h.input('report-find', 'first')
  await h.click('report-find-next'); await h.click('report-find-previous')
  await h.click('report-find-clear'); await h.input('report-find', 'last')
  assert.equal(indexes.length, 1)
  const stale = h.byId('report-find').props.onInput
  const revision = 'd'.repeat(64)
  await h.navigate('/reports?report_id=report_A&metadata_revision=' + revision)
  stale({ target: { value: 'first' } })
  assert.equal(indexes.length, 1)
  await resolve(calls.getSavedReport.at(-1), detail('second\r\nsecond', 'report_A', { metadata_revision: revision, content_revision: 'e'.repeat(64) }))
  assert.equal(indexes.length, 1)
  assert.equal(h.byId('report-find').props.value, '')
  await h.input('report-find', 'second')
  assert.equal(indexes.length, 2)
  assert.notEqual(indexes[0], indexes[1])
  assert.equal(indexes[1].text, 'second\nsecond')
  const retired = h.byId('report-find').props.onInput
  h.unmount(); retired({ target: { value: 'third' } }); await flush()
  assert.equal(indexes.length, 2)
})

test('dense CRLF indexes have bounded storage and retain a truthful late-match cap and raw spans', () => {
  assert.equal(typeof reportSearch.createReportSearchIndex, 'function')
  const dense = '\r\n'.repeat(4 * 1024 * 1024)
  const index = reportSearch.createReportSearchIndex(dense)
  assert.equal(index.text.length, 4 * 1024 * 1024)
  assert.equal(index.removedCRLF.byteLength, 16 * 1024 * 1024)
  assert.equal(index.removedCRLF[0], 0)
  assert.equal(index.removedCRLF.at(-1), index.text.length - 1)
  const tail = 'x\r\n'.repeat(1001)
  const prefix = '\r\n'.repeat((8 * 1024 * 1024 - tail.length - 1) / 2) + 'a'
  const body = prefix + tail, prepared = reportSearch.createReportSearchIndex(body)
  assert.equal(body.length, 8 * 1024 * 1024)
  const found = findReportPassages(prepared, 'x\n')
  assert.equal(found.more, true); assert.equal(found.matches.length, 1000)
  assert.equal(found.matches[0].start, prefix.length)
  assert.equal(found.matches.at(-1).end, prefix.length + 3000)
  assert.ok(found.matches.every(match => body.slice(match.start, match.end) === 'x\r\n'))
})

test('opened saved report finds literal punctuation and inert markup without changing bytes or requests', async t => {
  const body = '<script>alert(1)</script>\r\n[capital]+.*? [CAPITAL]+.*?\n<img src="https://invalid.test/pixel"> 雪 🐟\n\\d+ /^$()|{}[] . * + ?\n'
  const { h, calls } = await setup(t, body)
  assert.ok(h.byId('report-find'), 'the opened report needs its own Find in this report input')
  const count = countCalls(calls), route = h.router.currentRoute.value.fullPath
  await h.input('report-find', '[capital]+.*?')
  assert.deepEqual(marks(h).map(literalText), ['[capital]+.*?', '[CAPITAL]+.*?'])
  assert.equal(literalText(h.byId('markdown')), body)
  assert.match(h.text(h.byId('report-find-status')), /1 of 2/)
  assert.equal(marks(h)[0].props['aria-current'], 'true')
  await h.click('report-find-next')
  assert.equal(marks(h)[1].props['aria-current'], 'true')
  await h.click('report-find-next')
  assert.equal(marks(h)[0].props['aria-current'], 'true')
  await h.click('report-find-previous')
  assert.equal(marks(h)[1].props['aria-current'], 'true')
  for (const query of ['<script>alert(1)</script>', '\\d+', '/^$()|{}[] . * + ?']) {
    await h.input('report-find', query)
    assert.deepEqual(marks(h).map(literalText), [query])
  }
  await h.click('capture-left'); await h.click('download'); await h.click('comparison-left-download')
  for (const download of h.downloads) assert.deepEqual(Buffer.from(await download.blob.arrayBuffer()), Buffer.from(body))
  assert.equal(h.text(h.byId('comparison-left-text')), body)
  assert.equal(countCalls(calls), count)
  assert.equal(h.router.currentRoute.value.fullPath, route)
  assert.equal(h.all(node => ['script', 'img', 'iframe'].includes(node.type) || Object.hasOwn(node.props, 'innerHTML')).length, 0)
  await h.click('report-find-clear')
  assert.equal(marks(h).length, 0)
  assert.equal(literalText(h.byId('markdown')), body)
  assert.deepEqual(h.warnings, [])
})

test('current matches request nearest scrolling and tolerate a host without scrolling support', async t => {
  const { h } = await setup(t, 'one one one')
  await h.input('report-find', 'one')
  assert.equal(h.scrollCalls.length, 1)
  assert.equal(h.scrollCalls[0].node, marks(h)[0])
  assert.deepEqual({ ...h.scrollCalls[0].options }, { block: 'nearest', inline: 'nearest' })
  await h.click('report-find-previous')
  assert.equal(h.scrollCalls.at(-1).node, marks(h)[2])
  marks(h).forEach(node => { node.scrollIntoView = undefined })
  await h.click('report-find-next')
  assert.equal(marks(h)[0].props['aria-current'], 'true')
  assert.equal(h.scrollCalls.length, 2)
})

test('newer queries and case changes retire all earlier controls and deferred scroll callbacks', async t => {
  const deferredScrolls = [], { h } = await setup(t, 'old old NEW new', { deferredScrolls })
  await h.input('report-find', 'old')
  const stale = ['report-find-next', 'report-find-previous', 'report-find-clear'].map(id => h.byId(id).props.onClick)
  const staleInput = h.byId('report-find').props.onInput, staleCase = h.byId('report-find-case').props.onChange
  await h.input('report-find', 'new')
  stale.forEach(callback => callback())
  staleInput({ target: { value: 'old' } }); staleCase({ target: { checked: true } })
  await flush()
  assert.equal(h.byId('report-find').props.value, 'new')
  assert.deepEqual(marks(h).map(literalText), ['NEW', 'new'])
  assert.equal(deferredScrolls.length, 2)
  deferredScrolls.shift()()
  assert.equal(h.scrollCalls.length, 0)
  await h.change('report-find-case', true)
  deferredScrolls.shift()()
  assert.equal(h.scrollCalls.length, 0)
  deferredScrolls.shift()()
  assert.equal(h.scrollCalls.length, 1)
  assert.equal(literalText(h.scrollCalls[0].node), 'new')
  await h.click('report-find-next')
  await h.click('report-find-clear')
  deferredScrolls.splice(0).forEach(callback => callback())
  assert.equal(h.scrollCalls.length, 1)
  assert.equal(marks(h).length, 0)
})

for (const action of ['filter', 'close-reader', 'refresh', 'unmount']) test(`${action} synchronously retires controls and pending scroll before child updates`, async t => {
  const deferredScrolls = [], { h } = await setup(t, 'old old', { deferredScrolls })
  await h.input('report-find', 'old')
  const next = h.byId('report-find-next').props.onClick
  const input = h.byId('report-find').props.onInput
  if (action === 'filter') h.byId('search-phrase').props.onInput({ target: { value: 'changed' } })
  else if (action === 'unmount') h.unmount()
  else h.byId(action).props.onClick()
  // No renderer flush here: the old child's props and DOM still exist for
  // filter/close/refresh, but its accepted parent source has already retired.
  next(); input({ target: { value: 'new' } })
  deferredScrolls.splice(0).forEach(callback => callback())
  assert.equal(h.scrollCalls.length, 0)
  await flush()
  assert.equal(deferredScrolls.length, 0)
  assert.equal(h.byId('report-find'), undefined)
})

test('A to B to A, same-ID new revisions and ignored aborts never resurrect search ownership', async t => {
  const deferredScrolls = [], { h, calls } = await setup(t, 'old old', { deferredScrolls })
  await h.input('report-find', 'old')
  const staleNext = h.byId('report-find-next').props.onClick
  const staleInput = h.byId('report-find').props.onInput
  await h.navigate('/reports?report_id=report_B')
  const oldB = calls.getSavedReport.at(-1)
  await h.navigate('/reports?report_id=report_A')
  const oldA = calls.getSavedReport.at(-1)
  const revision = 'd'.repeat(64)
  await h.navigate('/reports?report_id=report_A&metadata_revision=' + revision)
  const currentA = calls.getSavedReport.at(-1)
  await resolve(oldB, detail('late B', 'report_B'))
  await resolve(oldA, detail('late A'))
  assert.equal(h.byId('report-find'), undefined)
  await resolve(currentA, detail('new new', 'report_A', { metadata_revision: revision, content_revision: 'e'.repeat(64) }))
  assert.equal(h.byId('report-find').props.value, '')
  assert.equal(marks(h).length, 0)
  staleNext(); staleInput({ target: { value: 'old' } })
  deferredScrolls.splice(0).forEach(callback => callback())
  assert.equal(h.scrollCalls.length, 0)
  await h.input('report-find', 'new')
  deferredScrolls.splice(0).forEach(callback => callback())
  assert.equal(h.scrollCalls.length, 1)
  assert.equal(literalText(h.byId('markdown')), 'new new')
  await h.navigate('/'); await h.navigate('/reports?report_id=report_A')
  await resolve(calls.getSavedReport.at(-1), detail('new new'))
  assert.equal(h.byId('report-find').props.value, '')
  assert.equal(marks(h).length, 0)
})

test('Unicode case matching, exact whitespace, multiline queries and no-match states preserve the source', async t => {
  const body = 'Café CAFÉ cafe\n雪 🐟 𐐀 𐐨\nΣ σ ς\nİ i\u0307\nline  one\r\nline two\n'
  const { h } = await setup(t, body)
  for (const [query, expected] of [
    ['café', ['Café', 'CAFÉ']], ['🐟', ['🐟']], ['𐐨', ['𐐀', '𐐨']], ['σ', ['Σ', 'σ', 'ς']],
    ['i', ['i', 'i', 'i']], ['line  one\r\nline two', ['line  one\r\nline two']], ['  ', ['  ']],
    ['line one', []], ['\\d+', []], ['\udc1f', []], ['\ud801', []],
  ]) {
    await h.input('report-find', query)
    assert.deepEqual(marks(h).map(literalText), expected, JSON.stringify(query))
    assert.equal(literalText(h.byId('markdown')), body)
    if (!expected.length) {
      assert.match(h.text(h.byId('report-find-status')), /No matches/)
      assert.ok(h.byId('report-find-next').props.disabled)
      assert.ok(h.byId('report-find-previous').props.disabled)
    }
  }
  await h.input('report-find', 'CAFÉ'); await h.change('report-find-case', true)
  assert.deepEqual(marks(h).map(literalText), ['CAFÉ'])
  await h.change('report-find-case', false)
  assert.deepEqual(marks(h).map(literalText), ['Café', 'CAFÉ'])
  await h.input('report-find', '')
  assert.equal(marks(h).length, 0)
  assert.match(h.text(h.byId('report-find-status')), /Enter text/)
  assert.equal(literalText(h.byId('markdown')), body)
})

test('queries admit 200 Unicode code points and reject excess without silently searching a prefix', async t => {
  const query = '🐟'.repeat(200)
  const { h } = await setup(t, query)
  await h.input('report-find', query)
  assert.deepEqual(marks(h).map(literalText), [query])
  await h.input('report-find', query + 'x'.repeat(10000))
  assert.equal(h.byId('report-find').props.value, query)
  assert.equal(h.byId('report-find').props['aria-invalid'], 'true')
  assert.match(h.text(h.byId('report-find-status')), /200.*Edit or clear/)
  assert.equal(marks(h).length, 0)
  assert.ok(h.byId('report-find-next').props.disabled)
  await h.input('report-find', query.slice(0, -2))
  assert.equal(h.byId('report-find').props['aria-invalid'], 'false')
  assert.equal(marks(h).length, 1)
  await h.click('report-find-clear')
  assert.equal(h.byId('report-find').props.value, '')
  assert.match(h.text(h.byId('report-find-status')), /Enter text/)
})

test('non-overlapping matches stop after 1,000 with a truthful extra-match check', async t => {
  const { h } = await setup(t, 'x'.repeat(2002))
  await h.input('report-find', 'xx')
  assert.equal(marks(h).length, 1000)
  assert.match(h.text(h.byId('report-find-status')), /more than 1,000.*first 1,000 shown/)
  await h.click('report-find-previous')
  assert.equal(marks(h)[999].props['aria-current'], 'true')
  assert.match(h.text(h.byId('report-find-status')), /1,000 of 1,000 shown/)
  await h.click('report-find-next')
  assert.equal(marks(h)[0].props['aria-current'], 'true')
  assert.equal(literalText(h.byId('markdown')), 'x'.repeat(2002))
  await h.input('report-find', 'xxx')
  assert.equal(marks(h).length, 667)
  assert.doesNotMatch(h.text(h.byId('report-find-status')), /more than/)
})

test('an exact 1,000 count is complete and the full admitted 8 MiB body stays readable and downloadable', async t => {
  const body = 'xx '.repeat(1000) + 'a'.repeat(8 * 1024 * 1024 - 3004) + '🐟'
  const { h, calls } = await setup(t, body)
  const count = countCalls(calls)
  await h.input('report-find', 'xx')
  assert.equal(marks(h).length, 1000)
  assert.doesNotMatch(h.text(h.byId('report-find-status')), /more than/)
  await h.input('report-find', '🐟')
  assert.deepEqual(marks(h).map(literalText), ['🐟'])
  assert.equal(literalText(h.byId('markdown')), body)
  await h.click('download')
  assert.deepEqual(Buffer.from(await h.downloads[0].blob.arrayBuffer()), Buffer.from(body))
  assert.equal(countCalls(calls), count)
})

for (const locale of ['en', 'zh']) test(`empty and unavailable bodies have clear find states in ${locale}`, async t => {
  const { h, calls } = await setup(t, '', { locale })
  assert.ok(h.byId('empty-content'))
  assert.ok(h.byId('report-find').props.disabled)
  assert.match(h.text(h.byId('report-find-status')), locale === 'en' ? /body is empty/ : /正文为空/)
  assert.equal(literalText(h.byId('markdown')), '')
  await h.navigate('/reports?report_id=report_B')
  await resolve(calls.getSavedReport.at(-1), detail('', 'report_B', { content_available: false, content_source: null, markdown_content: null, content_bytes: null, content_revision: null, content_error: 'not_saved' }))
  assert.ok(h.byId('content-error'))
  assert.ok(h.byId('report-find').props.disabled)
  assert.match(h.text(h.byId('report-find-status')), locale === 'en' ? /body is unavailable/ : /正文不可用/)
  assert.equal(h.byId('markdown'), undefined)
  assert.equal(marks(h).length, 0)
  assert.doesNotMatch(h.text(), /savedReportSearch\./)
  assert.deepEqual(h.warnings, [])
})

for (const locale of ['en', 'zh']) test(`browser-normalized multiline queries find original line-break spans in ${locale}`, async t => {
  const body = '🐟\r\nfirst\r\nsecond\rthird\nfourth\r\n\r\nlast\r'
  const { h, calls } = await setup(t, body, { locale })
  const count = countCalls(calls)
  // A textarea exposes pasted CRLF and CR as LF. Send that actual API value to
  // the compiled input handler, while keeping the accepted saved body intact.
  for (const [query, expected] of [
    ['first\nsecond\nthird\nfourth', ['first\r\nsecond\rthird\nfourth']],
    ['\nfirst', ['\r\nfirst']], ['\n\nlast\n', ['\r\n\r\nlast\r']],
    ['🐟\nfirst\n', ['🐟\r\nfirst\r\n']],
    ['\n', ['\r\n', '\r\n', '\r', '\n', '\r\n', '\r\n', '\r']],
  ]) {
    await h.input('report-find', query)
    assert.deepEqual(marks(h).map(literalText), expected, JSON.stringify(query))
    assert.equal(literalText(h.byId('markdown')), body)
  }
  await h.click('report-find-previous')
  assert.equal(marks(h)[6].props['aria-current'], 'true')
  await h.click('report-find-next')
  assert.equal(marks(h)[0].props['aria-current'], 'true')
  await h.click('download'); await h.click('capture-left'); await h.click('comparison-left-download')
  for (const file of h.downloads) assert.deepEqual(Buffer.from(await file.blob.arrayBuffer()), Buffer.from(body))
  assert.equal(h.text(h.byId('comparison-left-text')), body)
  assert.equal(countCalls(calls), count)
  assert.match(h.text(h.find(node => node.props.id === 'report-find-note')), locale === 'en' ? /Line-break styles are equivalent/ : /不同换行格式等效/)
  assert.doesNotMatch(h.text(), /savedReportSearch\./)
  assert.deepEqual(h.warnings, [])
})

test('logical breaks retain raw astral offsets and cannot backtrack into half a CRLF', () => {
  const body = '🐟\r\nfirst\rsecond\nlast'
  const expected = '\r\nfirst\rsecond\n'
  for (const query of ['\nfirst\nsecond\n', '\rfirst\rsecond\r', '\r\nfirst\r\nsecond\r\n']) {
    const result = findReportPassages(body, query)
    assert.deepEqual(result, { matches: [{ start: 2, end: 2 + expected.length }], more: false })
    assert.equal(body.slice(result.matches[0].start, result.matches[0].end), expected)
  }
  for (const body of ['\r\n', 'a\r\nb', 'a\rb', 'a\nb']) {
    for (const query of ['\n\n', '\r\r', '\r\n\r\n', 'a\n\nb']) {
      assert.deepEqual(findReportPassages(body, query), { matches: [], more: false })
    }
  }
  for (const body of ['\r\n\r\n', '\r\r', '\n\n', '\r\r\n', '\r\n\n']) {
    assert.deepEqual(findReportPassages(body, '\n\n'), { matches: [{ start: 0, end: body.length }], more: false })
  }
})

for (const locale of ['en', 'zh']) test(`logical line-break matches retain the truthful cap in ${locale}`, async t => {
  const body = '🐟' + '\r\n'.repeat(1001)
  const { h } = await setup(t, body, { locale })
  await h.input('report-find', '\n')
  assert.equal(marks(h).length, 1000)
  assert.ok(marks(h).every(node => literalText(node) === '\r\n'))
  assert.match(h.text(h.byId('report-find-status')), locale === 'en' ? /more than 1,000.*first 1,000 shown/ : /超过 1,000.*前 1,000/)
  assert.equal(literalText(h.byId('markdown')), body)
  await h.click('download')
  assert.deepEqual(Buffer.from(await h.downloads[0].blob.arrayBuffer()), Buffer.from(body))
  const exactBody = '\r\n'.repeat(1000)
  const exact = findReportPassages(exactBody, '\n')
  assert.equal(exact.matches.length, 1000); assert.equal(exact.more, false)
  assert.equal(exact.matches[999].end, exactBody.length)
})
