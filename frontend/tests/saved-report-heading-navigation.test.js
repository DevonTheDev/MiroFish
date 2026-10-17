import assert from 'node:assert/strict'
import test from 'node:test'
import { mountReportFiles, syntheticReport as report, ok, flush, file, chooseFile, previewFile, acceptFile } from './helpers/saved-report-files-view-fixture.js'

const body = 'lead\r\n  ## Same\r\nbody\r## Same\n### 雪 🐟\n'
const offsets = [6, 22, 30]
const literal = node => (node.type === '#comment' ? '' : node.text ?? '') + (node.children ?? []).map(literal).join('')
const targets = h => h.all(node => node.props['data-heading-offset'] !== undefined)
const marks = h => h.all(node => node.type === 'mark')
const select = (h, offset) => h.change('report-heading', String(offset))
const jump = h => h.byId('report-heading-jump').props.onClick()
const drain = queue => queue.splice(0).forEach(callback => callback())
const requestCount = h => Object.values(h.requests.calls).reduce((sum, calls) => sum + calls.length, 0)
async function setup(t, options = {}, text = body) {
  const h = await mountReportFiles({ initialPath: '/reports?report_id=report_A', ...options })
  t.after(() => { if (h.root.children.length) h.unmount() })
  h.requests.calls.getSavedReport[0].resolve(ok(report('report_A', text))); await flush()
  return h
}
async function fileSetup(t, options = {}, text = body) {
  const h = await mountReportFiles(options)
  t.after(() => { if (h.root.children.length) h.unmount() })
  await acceptFile(h, report('report_A', text)); return h
}
function noEffects(h, count, route) {
  assert.equal(requestCount(h), count); assert.equal(h.router.currentRoute.value.fullPath, route)
  assert.deepEqual(h.networkCalls, []); assert.deepEqual(h.storageWrites, []); assert.deepEqual(h.warnings, [])
}

// The tests exercise compiled templates and the actual router. They record
// focus/scroll requests and literal nodes, not browser geometry or native UI.
for (const locale of ['en', 'zh']) test(`explicit heading Jump is exact, literal and leaves Find and export bytes intact (${locale})`, async t => {
  const writes = [], h = await setup(t, { locale, clipboardHost: { navigator: { clipboard: { writeText: value => { writes.push(value); return Promise.resolve() } } } } })
  const count = requestCount(h), route = h.router.currentRoute.value.fullPath
  assert.equal(h.byId('report-heading').type, 'select'); assert.equal(h.byId('report-heading').props.value, '')
  assert.ok(h.byId('report-heading-jump').props.disabled)
  const options = h.byId('report-heading').children.filter(n => n.type === 'option')
  assert.equal(options.length, 4); assert.notEqual(literal(options[1]), literal(options[2]))
  await select(h, offsets[1]); assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0)
  await h.input('report-find', 'Same'); await h.click('report-find-next'); await h.change('report-find-case', true)
  const query = h.byId('report-find').props.value, status = literal(h.byId('report-find-status')), current = marks(h).findIndex(n => n.props['aria-current'] === 'true')
  await h.click('report-heading-jump')
  const target = targets(h).find(n => n.props['data-heading-offset'] === offsets[1])
  assert.equal(h.document.activeElement, target); assert.equal(h.focusCalls.at(-1).node, target); assert.equal(h.scrollCalls.at(-1).node, target)
  assert.deepEqual({ ...h.focusCalls.at(-1).options }, { preventScroll: true })
  assert.equal(target.props.tabindex, '-1'); assert.equal(target.props.role, 'heading'); assert.equal(target.props['aria-level'], 2)
  assert.match(target.props['aria-label'], /Same/); assert.ok(literal(target).startsWith('##'))
  assert.equal(h.byId('report-find').props.value, query); assert.equal(literal(h.byId('report-find-status')), status)
  assert.equal(marks(h).findIndex(n => n.props['aria-current'] === 'true'), current)
  assert.equal(literal(h.byId('markdown')), body)
  await h.click('copy-saved-markdown'); await h.click('download'); await h.click('download-observation'); await h.click('capture-left'); await h.click('comparison-left-download')
  assert.deepEqual(writes, [body]); assert.equal(JSON.parse(await h.downloads[1].blob.text()).observation.markdown_content, body)
  for (const index of [0, 2]) assert.deepEqual(Buffer.from(await h.downloads[index].blob.arrayBuffer()), Buffer.from(body))
  assert.equal(literal(h.byId('comparison-left-text')), body)
  assert.doesNotMatch(h.text(), /savedReportHeadings\./); noEffects(h, count, route)
})

test('one source index survives Find locale and selection updates without passive focus', async t => {
  const indexed = [], h = await setup(t, { onHeadingIndex: index => indexed.push(index) })
  assert.equal(indexed.length, 1); await select(h, offsets[0])
  for (const query of ['Same', 'absent', '', 'x'.repeat(201)]) await h.input('report-find', query)
  h.i18n.global.locale.value = 'zh'; await flush()
  assert.equal(indexed.length, 1); assert.equal(h.byId('report-heading').props.value, String(offsets[0])); assert.equal(h.focusCalls.length, 0)
  assert.match(literal(h.byId('report-heading-jump')), /跳转/)
})

test('multiline and boundary Find matches retain one outer mark and one exact heading target', async t => {
  const text = 'lead\r\n  ## Alpha\r\n## Beta\r\nend', h = await setup(t, {}, text)
  for (const query of ['lead\n  ', '## Alpha', 'lead\n  #', '# Alpha', '  ', 'lead\n  ## Alpha\n## Beta']) {
    await h.input('report-find', query)
    assert.equal(marks(h).length, 1); assert.equal(targets(h).length, 2)
    assert.equal(literal(h.byId('markdown')), text)
    assert.ok(targets(h).every(node => literal(node).length > 0 && literal(node).startsWith('#')))
    await select(h, 6); await h.click('report-heading-jump')
    assert.equal(h.scrollCalls.at(-1).node, targets(h)[0])
    await h.click('report-find-next'); assert.equal(h.scrollCalls.at(-1).node, marks(h)[0])
  }
  assert.equal(marks(h)[0].children.filter(node => node.props?.['data-heading-offset'] !== undefined).length, 2)
})

test('selection A B A and stale selector handlers cannot revive an earlier Jump', async t => {
  const queue = [], h = await setup(t, { deferredScrolls: queue })
  await select(h, offsets[0]); const staleJump = h.byId('report-heading-jump').props.onClick, staleSelect = h.byId('report-heading').props.onChange
  jump(h); await flush(); await select(h, offsets[1]); await select(h, offsets[0])
  staleJump(); staleSelect({ target: { value: String(offsets[1]) } }); drain(queue)
  assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0)
  assert.equal(h.byId('report-heading').props.value, String(offsets[0]))
  jump(h); jump(h); await flush(); drain(queue)
  assert.equal(h.focusCalls.length, 1); assert.equal(h.scrollCalls.length, 1)
})

test('all accepted Find changes retire a queued Jump including changes without a result', async t => {
  const queue = [], h = await setup(t, { deferredScrolls: queue })
  await select(h, offsets[0])
  for (const change of [
    () => h.input('report-find', 'absent'), () => h.input('report-find', 'x'.repeat(201)),
    () => h.click('report-find-clear'), () => h.change('report-find-case', true),
    () => h.input('report-find', 'Same'), () => h.click('report-find-next'), () => h.click('report-find-previous'),
  ]) {
    jump(h); await flush(); await change(); drain(queue)
    assert.equal(h.focusCalls.length, 0)
  }
  assert.ok(h.scrollCalls.every(call => call.node.type === 'mark'))
})

test('later Jump wins over queued Find and later Find wins over queued Jump', async t => {
  const queue = [], h = await setup(t, { deferredScrolls: queue })
  await select(h, offsets[0]); await h.input('report-find', 'Same'); jump(h); await flush(); drain(queue)
  assert.equal(h.scrollCalls.length, 1); assert.equal(h.scrollCalls[0].node, targets(h)[0])
  jump(h); await flush(); await h.click('report-find-next'); drain(queue)
  assert.equal(h.focusCalls.length, 1); assert.equal(h.scrollCalls.length, 2); assert.equal(h.scrollCalls[1].node, marks(h)[1])
})

test('focus moving away and back retires a pending Jump', async t => {
  const queue = [], h = await setup(t, { deferredScrolls: queue })
  await select(h, offsets[0]); const origin = h.byId('report-heading-jump'); h.document.focus(origin)
  jump(h); await flush(); h.document.focus(h.byId('report-find')); h.document.focus(origin); drain(queue)
  assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0)
})

for (const action of ['selection', 'selection-return', 'find', 'jump', 'focus', 'unmount']) test(`synchronous target focus ${action} invalidates the old scroll`, async t => {
  const queue = [], h = await setup(t, { deferredScrolls: queue })
  await select(h, offsets[0]); const target = targets(h)[0]
  target.onFocus = () => {
    target.onFocus = undefined
    if (action.startsWith('selection')) {
      h.byId('report-heading').props.onChange({ target: { value: String(offsets[1]) } })
      if (action === 'selection-return') h.byId('report-heading').props.onChange({ target: { value: String(offsets[0]) } })
    } else if (action === 'find') h.byId('report-find').props.onInput({ target: { value: 'Same' } })
    else if (action === 'jump') jump(h)
    else if (action === 'focus') h.document.focus(h.byId('report-find'))
    else h.unmount()
  }
  jump(h); await flush(); drain(queue)
  assert.equal(h.scrollCalls.length, 0)
  await flush(); drain(queue)
  if (action === 'find') assert.equal(h.scrollCalls.at(-1).node.type, 'mark')
  if (action === 'jump') { assert.equal(h.scrollCalls.length, 1); assert.equal(h.scrollCalls[0].node, target) }
})

test('stale render ref registrations and removals cannot replace or clear current targets', async t => {
  const refs = [], queue = [], h = await setup(t, { deferredScrolls: queue, onHeadingRef: (offset, callback) => refs.push({ offset, callback }) })
  await select(h, offsets[0]); const old = refs.filter(r => r.offset === offsets[0]).at(-1), oldNode = targets(h)[0]
  await h.input('report-find', 'lead\n  ## Same'); const current = targets(h)[0]
  assert.notEqual(current, oldNode); assert.ok(old)
  old.callback(oldNode); old.callback(null)
  jump(h); await flush(); drain(queue)
  assert.equal(h.scrollCalls.at(-1).node, current); assert.equal(h.document.activeElement, current)
  const before = h.scrollCalls.length
  jump(h); await flush(); h.i18n.global.locale.value = 'zh'; await flush(); drain(queue)
  assert.equal(h.scrollCalls.length, before, 'a superseded render never scrolls even if Vue reused the same node')
})

for (const action of ['close-reader', 'refresh', 'filter', 'unmount']) test(`${action} synchronously retires captured heading controls and queued Jump`, async t => {
  const queue = [], h = await setup(t, { deferredScrolls: queue })
  await select(h, offsets[0]); const stale = h.byId('report-heading-jump').props.onClick, staleSelect = h.byId('report-heading').props.onChange
  jump(h); await flush()
  if (action === 'filter') h.byId('search-phrase').props.onInput({ target: { value: 'edited' } })
  else if (action === 'unmount') h.unmount()
  else h.byId(action).props.onClick()
  stale(); staleSelect({ target: { value: String(offsets[1]) } }); drain(queue)
  assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0)
})

test('A B A and same-ID revisions ignore aborted detail results and old heading callbacks', async t => {
  const queue = [], indexed = [], h = await setup(t, { deferredScrolls: queue, onHeadingIndex: index => indexed.push(index) })
  await select(h, offsets[0]); const stale = h.byId('report-heading-jump').props.onClick; jump(h); await flush()
  await h.navigate('/reports?report_id=report_B'); const b = h.requests.calls.getSavedReport.at(-1)
  await h.navigate('/reports?report_id=report_A'); const a = h.requests.calls.getSavedReport.at(-1)
  const revision = 'c'.repeat(64)
  await h.navigate('/reports?report_id=report_A&metadata_revision=' + revision); const current = h.requests.calls.getSavedReport.at(-1)
  b.resolve(ok(report('report_B', '# Old B'))); a.resolve(ok(report('report_A', '# Old A'))); await flush()
  assert.equal(h.byId('report-heading'), undefined)
  current.resolve(ok({ ...report('report_A', '# New A'), metadata_revision: revision })); await flush()
  stale(); drain(queue); assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0)
  assert.equal(h.byId('report-heading').props.value, ''); assert.equal(indexed.length, 2)
  await select(h, 0); await h.click('report-heading-jump'); drain(queue)
  assert.equal(literal(h.scrollCalls.at(-1).node), '# New A')
  await h.navigate('/runtime'); await h.back(); h.requests.calls.getSavedReport.at(-1).resolve(ok({ ...report('report_A', '# New A'), metadata_revision: revision })); await flush()
  assert.equal(h.byId('report-heading').props.value, '')
})

test('accepted-file heading selection survives replacement reads previews rejection Cancel and locale', async t => {
  const h = await fileSetup(t), count = requestCount(h), route = h.router.currentRoute.value.fullPath
  await select(h, offsets[1]); await h.click('capture-left')
  let release; const pending = new Promise(resolve => { release = resolve }), replacement = report('report_A', '# Replacement')
  const reading = await chooseFile(h, file(replacement, 'B.json', { arrayBuffer: () => pending }))
  assert.equal(h.byId('report-heading').props.value, String(offsets[1]))
  release(await file(replacement).arrayBuffer()); await reading.pending; await flush()
  assert.equal(h.byId('report-heading').props.value, String(offsets[1])); await h.click('cancel-file')
  await previewFile(h, '{invalid'); await h.change('file-language', 'zh')
  assert.equal(h.byId('report-heading').props.value, String(offsets[1])); await h.click('report-heading-jump')
  assert.equal(h.document.activeElement, targets(h)[1]); assert.equal(literal(h.byId('markdown')), body)
  assert.equal(literal(h.byId('comparison-left-text')), body); noEffects(h, count, route)
})

test('accepted-file Open Clear and route departure retire heading owners while captures remain independent', async t => {
  const queue = [], h = await fileSetup(t, { deferredScrolls: queue })
  await select(h, offsets[0]); await h.click('capture-left'); const stale = h.byId('report-heading-jump').props.onClick
  await previewFile(h, report('report_A', '# Replacement')); jump(h); await flush()
  h.byId('open-file').props.onClick(); stale(); drain(queue)
  assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0); await flush()
  assert.equal(h.byId('report-heading').props.value, ''); assert.equal(literal(h.byId('comparison-left-text')), body)
  await select(h, 0); jump(h); await flush(); h.byId('clear-file').props.onClick(); drain(queue); await flush()
  assert.equal(h.scrollCalls.length, 0); assert.equal(h.byId('report-heading'), undefined); assert.equal(literal(h.byId('comparison-left-text')), body)
  await acceptFile(h, report('report_A', '# New')); await select(h, 0); jump(h); await flush(); await h.navigate('/runtime'); drain(queue)
  assert.equal(h.scrollCalls.length, 0); await h.back(); assert.equal(h.byId('report-heading'), undefined)
})

for (const locale of ['en', 'zh']) test(`empty unavailable unrecognized and truncated heading states are truthful (${locale})`, async t => {
  const h = await fileSetup(t, { locale }, '')
  assert.ok(h.byId('report-heading').props.disabled); assert.match(literal(h.byId('report-heading-status')), locale === 'en' ? /empty/ : /为空/)
  const unavailable = { ...report(), content_available: false, markdown_content: null, content_bytes: null, content_revision: null, content_source: null, content_error: 'not_saved' }
  await acceptFile(h, unavailable); assert.ok(h.byId('report-heading').props.disabled)
  assert.match(literal(h.byId('report-heading-status')), locale === 'en' ? /unavailable/ : /不可用/)
  await acceptFile(h, report('report_A', 'plain\n# ###\n```\n# hidden'))
  assert.match(literal(h.byId('report-heading-status')), locale === 'en' ? /No recognized/ : /未识别/)
  const text = '# <script>literal</script>\n' + '# Heading\n'.repeat(200)
  await acceptFile(h, report('report_A', text)); assert.equal(targets(h).length, 200)
  assert.match(literal(h.byId('report-heading-status')), locale === 'en' ? /First 200/ : /前 200/)
  assert.equal(literal(h.byId('markdown')), text); assert.equal(h.all(n => ['script', 'img', 'iframe'].includes(n.type) || Object.hasOwn(n.props, 'innerHTML')).length, 0)
  assert.doesNotMatch(h.text(), /savedReportHeadings\./); assert.deepEqual(h.warnings, [])
})
