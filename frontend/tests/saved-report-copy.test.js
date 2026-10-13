import assert from 'node:assert/strict'
import test from 'node:test'
import { watch } from 'vue'
import { mountReportFiles, syntheticReport as report, ok, flush, file, chooseFile, previewFile, acceptFile } from './helpers/saved-report-files-view-fixture.js'

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const action = view => { const node = view.byId('copy-saved-markdown'); assert.ok(node, 'The accepted reader needs an explicit Copy saved Markdown control'); return node.props.onClick }
const invoke = fn => fn({ button: 0, preventDefault() {}, stopPropagation() {} })
const feedback = view => view.text(view.byId('copy-saved-markdown-status'))
const countRequests = view => Object.values(view.requests.calls).reduce((total, calls) => total + calls.length, 0)
const initialPath = parent => parent === 'live' ? '/reports?report_id=report_A' : '/report-files'
async function load(view, value, parent) {
  if (parent === 'file') await acceptFile(view, value)
  else { view.requests.calls.getSavedReport.at(-1).resolve(ok(value)); await flush() }
}
function clipboard(writeText) {
  const host = { navigator: { clipboard: { writeText, read() { assert.fail('must not read clipboard') }, readText() { assert.fail('must not read clipboard') } } } }
  return host
}
function noEffects(view, requests) {
  assert.equal(countRequests(view), requests); assert.deepEqual(view.networkCalls, []); assert.deepEqual(view.storageWrites, [])
  assert.equal(view.downloads.length, 0); assert.equal(view.blobs.size, 0); assert.equal(view.anchors.length, 0); assert.equal(view.timers.pending.size, 0); assert.deepEqual(view.warnings, [])
}

test('accepted reader exposes a separate Copy saved Markdown control', async () => {
  const view = await mountReportFiles()
  try {
    await acceptFile(view, report())
    const button = view.byId('copy-saved-markdown')
    assert.ok(button, 'The accepted reader needs an explicit Copy saved Markdown control')
    assert.equal(view.text(button), 'Copy saved Markdown'); assert.equal(button.props.type, 'button'); assert.equal(button.props.disabled, false)
    assert.ok(view.byId('download-file')); assert.ok(view.byId('download-markdown'))
    const status = view.byId('copy-saved-markdown-status')
    assert.equal(status.props.role, 'status'); assert.equal(status.props['aria-live'], 'polite'); assert.equal(status.props['aria-atomic'], 'true')
  } finally { view.unmount() }
})

test('copy captures the exact live string at click before a host getter can mutate the accepted object', async () => {
  let readerProps
  const writes = [], body = 'accepted at click\r\n雪😀', view = await mountReportFiles({
    initialPath: initialPath('live'), onReaderMount: props => { readerProps = props },
    clipboardHost: { get navigator() {
      assert.equal(Object.isFrozen(readerProps.source), false)
      readerProps.source.markdown_content = 'host mutated the same source object'
      return { clipboard: { writeText(text) { writes.push(text); return Promise.resolve() } } }
    } },
  })
  try { await load(view, report('report_A', body), 'live'); await view.click('copy-saved-markdown'); assert.deepEqual(writes, [body]) }
  finally { view.unmount() }
})

test('only the owning clipboard token releases a pending write', async () => {
  const { acquireSavedReportClipboard, savedReportClipboardBusy } = await import('../src/utils/savedReportClipboard.js')
  const first = acquireSavedReportClipboard()
  let second
  try {
    assert.equal(savedReportClipboardBusy.value, true); assert.equal(acquireSavedReportClipboard(), null)
    first(); second = acquireSavedReportClipboard()
    first(); assert.equal(savedReportClipboardBusy.value, true); assert.equal(acquireSavedReportClipboard(), null)
  } finally { first?.(); second?.() }
  assert.equal(savedReportClipboardBusy.value, false)
})

for (const parent of ['file', 'live']) for (const locale of ['en', 'zh']) test(`copy writes the exact accepted body in the click stack and succeeds only after settlement (${parent}, ${locale})`, async () => {
  const pending = defer(), writes = [], body = '\ufeff  # Saved\r\n\t<script>literal</script>\r\n雪😀 e\u0301\rsolo\n  '
  let inClick = false, expectedThis
  const host = clipboard(function (text) { assert.equal(this, expectedThis); assert.equal(inClick, true); writes.push(text); return pending.promise })
  expectedThis = host.navigator.clipboard
  const view = await mountReportFiles({ initialPath: initialPath(parent), locale, clipboardHost: host })
  try {
    const value = { ...report('report_A', body), status: 'failed', title: 'DO NOT COPY METADATA' }
    await load(view, value, parent); const requests = countRequests(view), copy = action(view)
    await view.input('report-find', 'x'.repeat(201))
    inClick = true; invoke(copy); invoke(copy); inClick = false
    assert.deepEqual(writes, [body]); await flush()
    assert.equal(view.byId('copy-saved-markdown').props.disabled, true)
    assert.match(feedback(view), locale === 'en' ? /Copying/ : /正在复制/)
    assert.doesNotMatch(feedback(view), locale === 'en' ? /Copied/ : /已复制/)
    assert.deepEqual(new TextEncoder().encode(writes[0]), new TextEncoder().encode(body))
    pending.resolve(); await flush()
    assert.match(feedback(view), locale === 'en' ? /Copied saved Markdown/ : /已复制保存的 Markdown/)
    assert.equal(view.byId('copy-saved-markdown').props.disabled, false)
    noEffects(view, requests)
  } finally { pending.resolve(); await flush(); view.unmount() }
})

for (const parent of ['file', 'live']) test(`copy availability follows accepted body, including whitespace and every saved status (${parent})`, async () => {
  const writes = [], view = await mountReportFiles({ initialPath: initialPath(parent), clipboardHost: clipboard(text => { writes.push(text); return Promise.resolve() }) })
  try {
    for (const status of ['pending', 'planning', 'generating', 'completed', 'failed', 'unknown']) {
      if (parent === 'live' && view.byId('copy-saved-markdown')) { await view.click('close-reader'); await view.navigate('/reports?report_id=report_A') }
      await load(view, { ...report('report_A', ' \t\r\n'), status }, parent)
      assert.equal(view.byId('copy-saved-markdown').props.disabled, false); await view.click('copy-saved-markdown')
    }
    assert.deepEqual(writes, Array(6).fill(' \t\r\n'))
    for (const unavailable of [false, true]) {
      if (parent === 'live') { await view.click('close-reader'); await view.navigate('/reports?report_id=report_A') }
      const value = report('report_A', '')
      if (unavailable) Object.assign(value, { content_available: false, markdown_content: null, content_bytes: null, content_revision: null, content_source: null, content_error: 'not_saved' })
      await load(view, value, parent)
      assert.equal(view.byId('copy-saved-markdown').props.disabled, true); invoke(action(view)); await flush(); assert.equal(writes.length, 6)
      await view.click(parent === 'live' ? 'download-observation' : 'download-file'); assert.equal(JSON.parse(await view.downloads.at(-1).blob.text()).observation.markdown_content, value.markdown_content)
    }
  } finally { view.unmount() }
})

test('copy preserves the full admitted 8 MiB body beyond the search cap and rejects an oversized source through existing admission', async () => {
  const writes = [], view = await mountReportFiles({ initialPath: initialPath('live'), clipboardHost: clipboard(text => { writes.push(text); return Promise.resolve() }) })
  try {
    const body = 'x\r\n'.repeat(1001) + '雪'.repeat(1000) + 'z'.repeat(8 * 1024 * 1024 - 6003)
    assert.equal(Buffer.byteLength(body), 8 * 1024 * 1024)
    await load(view, report('report_A', body), 'live'); await view.input('report-find', 'x')
    assert.equal(view.all(node => node.type === 'mark').length, 1000)
    await view.click('copy-saved-markdown'); assert.deepEqual(writes, [body])
    await view.click('close-reader'); await view.navigate('/reports?report_id=report_A')
    await load(view, report('report_A', body + 'x'), 'live')
    assert.equal(view.byId('copy-saved-markdown'), undefined); assert.equal(writes.length, 1)
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) for (const mode of ['no-navigator', 'no-clipboard', 'no-write', 'navigator-throws', 'clipboard-throws', 'write-getter-throws', 'write-throws', 'rejects']) test(`copy reports a generic ${mode} outcome with download available (${locale})`, async () => {
  const error = Error('PRIVATE HOST DETAILS'), writes = [], host = clipboard(text => { writes.push(text); return Promise.resolve() })
  if (mode === 'no-navigator') host.navigator = undefined
  if (mode === 'no-clipboard') host.navigator = {}
  if (mode === 'no-write') host.navigator.clipboard = {}
  if (mode === 'navigator-throws') Object.defineProperty(host, 'navigator', { configurable: true, get() { throw error } })
  if (mode === 'clipboard-throws') Object.defineProperty(host.navigator, 'clipboard', { get() { throw error } })
  if (mode === 'write-getter-throws') Object.defineProperty(host.navigator.clipboard, 'writeText', { get() { throw error } })
  if (mode === 'write-throws') host.navigator.clipboard.writeText = () => { throw error }
  if (mode === 'rejects') host.navigator.clipboard.writeText = () => Promise.reject(error)
  const view = await mountReportFiles({ locale, clipboardHost: host, clipboardGlobalFacade: mode === 'navigator-throws' })
  try {
    await acceptFile(view, report()); await view.click('copy-saved-markdown')
    assert.match(feedback(view), locale === 'en' ? /download/i : /下载/)
    assert.match(feedback(view), mode.startsWith('no-') ? (locale === 'en' ? /unavailable/i : /不可用/) : (locale === 'en' ? /could not copy/i : /无法复制/))
    assert.doesNotMatch(view.text(), /PRIVATE HOST DETAILS/); assert.equal(view.byId('copy-saved-markdown').props.disabled, false)
    await view.click('download-markdown'); assert.equal(await view.downloads.at(-1).blob.text(), report().markdown_content)
    Object.defineProperty(host, 'navigator', { configurable: true, value: { clipboard: { writeText(text) { writes.push(text); return Promise.resolve() } } } })
    await view.click('copy-saved-markdown'); assert.deepEqual(writes, [report().markdown_content])
    assert.match(feedback(view), locale === 'en' ? /Copied/ : /已复制/)
  } finally { view.unmount() }
})

for (const boundary of ['navigator', 'clipboard', 'writeText', 'call']) test(`single-flight starts before reentrant host ${boundary} access`, async () => {
  const pending = defer(), writes = [], reads = [], viewHost = {}, clipboardValue = {}, navigatorValue = {}
  let retained, triggered = false
  function reenter(stage) { reads.push(stage); if (stage === boundary && !triggered) { triggered = true; invoke(retained) } }
  Object.defineProperty(viewHost, 'navigator', { get() { reenter('navigator'); return navigatorValue } })
  Object.defineProperty(navigatorValue, 'clipboard', { get() { reenter('clipboard'); return clipboardValue } })
  Object.defineProperty(clipboardValue, 'writeText', { get() { reenter('writeText'); return function (text) { reenter('call'); writes.push(text); return pending.promise } } })
  const view = await mountReportFiles({ clipboardHost: viewHost })
  try {
    await acceptFile(view, report()); retained = action(view); invoke(retained); await flush()
    assert.deepEqual(reads, ['navigator', 'clipboard', 'writeText', 'call']); assert.equal(writes.length, 1)
    pending.resolve(); await flush(); assert.match(feedback(view), /Copied/)
  } finally { pending.resolve(); await flush(); view.unmount() }
})

for (const boundary of ['navigator', 'clipboard', 'writeText']) test(`host ${boundary} retirement is checked again before writing`, async () => {
  const writes = [], clipboardValue = {}, navigatorValue = {}, host = {}
  let view, retired = false
  const retire = stage => { if (stage === boundary && !retired) { retired = true; view.byId('clear-file').props.onClick() } }
  Object.defineProperty(host, 'navigator', { get() { retire('navigator'); return navigatorValue } })
  Object.defineProperty(navigatorValue, 'clipboard', { get() { retire('clipboard'); return clipboardValue } })
  Object.defineProperty(clipboardValue, 'writeText', { get() { retire('writeText'); return text => { writes.push(text); return Promise.resolve() } } })
  view = await mountReportFiles({ clipboardHost: host })
  try { await acceptFile(view, report()); invoke(action(view)); await flush(); assert.deepEqual(writes, []); assert.equal(view.byId('accepted-file'), undefined) }
  finally { view.unmount() }
})

for (const settlement of ['resolve', 'reject']) test(`pending copy keeps the global lock across same-ID replacement and retires old ${settlement} feedback`, async () => {
  const first = defer(), second = defer(), writes = [], view = await mountReportFiles({ clipboardHost: clipboard(text => { writes.push(text); return writes.length === 1 ? first.promise : second.promise }) })
  try {
    await acceptFile(view, report('report_A', 'old\r\nbody')); const stale = action(view); invoke(stale); await flush()
    await acceptFile(view, report('report_A', 'new\r\nbody')); const current = action(view)
    assert.equal(feedback(view), ''); assert.equal(view.byId('copy-saved-markdown').props.disabled, true)
    invoke(stale); invoke(current); await flush(); assert.deepEqual(writes, ['old\r\nbody'])
    first[settlement](settlement === 'reject' ? Error('private stale') : undefined); await flush()
    assert.equal(feedback(view), ''); assert.equal(view.byId('copy-saved-markdown').props.disabled, false)
    invoke(stale); await flush(); assert.deepEqual(writes, ['old\r\nbody'])
    invoke(current); await flush(); assert.deepEqual(writes, ['old\r\nbody', 'new\r\nbody'])
    assert.match(feedback(view), /Copying/); invoke(stale); second.resolve(); await flush(); assert.match(feedback(view), /Copied/)
  } finally { first.resolve(); second.resolve(); await flush(); view.unmount() }
})

test('pending copy survives clear, departure and unmount/remount with no timeout, queue or automatic retry', async () => {
  const pending = defer(), writes = [], host = clipboard(text => { writes.push(text); return writes.length === 1 ? pending.promise : Promise.resolve() })
  let view = await mountReportFiles({ clipboardHost: host })
  try {
    await acceptFile(view, report('report_A', 'original')); invoke(action(view)); await flush()
    await view.click('clear-file'); await acceptFile(view, report('report_A', 'after clear'))
    assert.equal(view.byId('copy-saved-markdown').props.disabled, true); invoke(action(view)); await flush()
    await view.navigate('/runtime'); await view.navigate('/report-files'); await acceptFile(view, report('report_A', 'after route'))
    assert.equal(view.byId('copy-saved-markdown').props.disabled, true); invoke(action(view)); await flush()
    view.unmount(); view = await mountReportFiles({ clipboardHost: host }); await acceptFile(view, report('report_A', 'remounted'))
    const current = action(view); invoke(current); await view.timers.advance(24 * 60 * 60 * 1000)
    assert.equal(view.byId('copy-saved-markdown').props.disabled, true); assert.deepEqual(writes, ['original']); assert.equal(feedback(view), ''); assert.equal(view.timers.pending.size, 0)
    pending.resolve(); await flush(); assert.deepEqual(writes, ['original']); assert.equal(feedback(view), '')
    await view.click('copy-saved-markdown'); assert.deepEqual(writes, ['original', 'remounted']); assert.match(feedback(view), /Copied/)
  } finally { pending.resolve(); await flush(); view.unmount() }
})

for (const parent of ['file', 'live']) for (const cacheHandlers of [true, false]) test(`retained copy callbacks retire on committed departure before queued unmount (${parent}, ${cacheHandlers})`, async () => {
  let reads = 0
  const view = await mountReportFiles({ initialPath: initialPath(parent), cacheHandlers, clipboardHost: { get navigator() { reads++; throw Error('stale clipboard access') } } })
  let stop
  try {
    await load(view, report(), parent); const stale = action(view), snapshots = []
    stop = watch(() => view.router.currentRoute.value.fullPath, () => { snapshots.push(!!view.byId('copy-saved-markdown')); invoke(stale) }, { flush: 'sync' })
    await view.navigate('/runtime?report_id=report_A'); stop(); stop = null
    assert.deepEqual(snapshots, [true]); assert.equal(reads, 0); assert.equal(view.byId('copy-saved-markdown'), undefined)
    invoke(stale); view.unmount(); invoke(stale); await flush(); assert.equal(reads, 0)
  } finally { stop?.(); if (view.root.children.length) view.unmount() }
})

test('unaccepted file reads, previews, invalid files, cancellation, search and locale retain accepted copy ownership', async () => {
  const pending = defer(), read = defer(), writes = [], view = await mountReportFiles({ clipboardHost: clipboard(text => { writes.push(text); return pending.promise }) })
  try {
    const a = report('report_A', 'accepted\r\nA'), b = report('report_A', 'unaccepted B')
    await acceptFile(view, a); const retained = action(view)
    const reading = await chooseFile(view, file(b, 'B.json', { arrayBuffer: () => read.promise }))
    invoke(retained); await flush(); assert.deepEqual(writes, [a.markdown_content])
    await view.input('report-find', 'accepted'); await view.change('report-find-case', true); await view.change('file-language', 'zh')
    assert.match(feedback(view), /正在复制/)
    read.resolve(await file(b).arrayBuffer()); await reading.pending; await flush(); assert.ok(view.byId('file-preview'))
    await view.click('cancel-file'); await previewFile(view, '{invalid'); await chooseFile(view, null)
    assert.match(feedback(view), /正在复制/); pending.resolve(); await flush(); assert.match(feedback(view), /已复制/)
    const literal = node => (node.type === '#comment' ? '' : node.text ?? '') + (node.children ?? []).map(literal).join('')
    assert.deepEqual(writes, [a.markdown_content]); assert.equal(literal(view.byId('markdown')), a.markdown_content)
    assert.deepEqual(view.networkCalls, []); assert.deepEqual(view.storageWrites, []); assert.deepEqual(view.warnings, [])
  } finally { read.resolve(new ArrayBuffer(0)); pending.resolve(); await flush(); view.unmount() }
})

test('aborted navigation keeps accepted copy feedback; committed navigation suppresses late settlement', async () => {
  const pending = defer(), writes = [], view = await mountReportFiles({ initialPath: initialPath('live'), clipboardHost: clipboard(text => { writes.push(text); return pending.promise }) })
  let removeGuard
  try {
    await load(view, report(), 'live'); const retained = action(view)
    removeGuard = view.router.beforeEach(to => to.path === '/runtime' ? false : undefined)
    await view.navigate('/runtime'); invoke(retained); await flush(); assert.equal(writes.length, 1); assert.match(feedback(view), /Copying/)
    removeGuard(); removeGuard = null; await view.navigate('/runtime'); pending.reject(Error('private late rejection')); await flush()
    await view.navigate('/reports?report_id=report_A'); await load(view, report(), 'live'); assert.equal(feedback(view), '')
    assert.equal(view.byId('copy-saved-markdown').props.disabled, false); assert.deepEqual(view.warnings, [])
  } finally { removeGuard?.(); pending.resolve(); await flush(); view.unmount() }
})
