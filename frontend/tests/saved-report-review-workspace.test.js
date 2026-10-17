import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, webcrypto } from 'node:crypto'
import { ref, watch } from 'vue'
import { mountReportFiles, syntheticReport as report, ok, flush, acceptFile } from './helpers/saved-report-files-view-fixture.js'
import { mountReportLibrary } from './helpers/report-library-view-fixture.js'

// Six bounded mounted groups. These use compiled Vue scripts/templates and the
// real router. They establish event intent and ownership, not native download
// delivery, browser layout/keyboard behavior, or a browser's reload-warning UI.
const body = '\ufefflead\r\n  ## Same\r\nNeedle 😀\r## Same\n雪 needle\n'
const secondHeading = body.lastIndexOf('## Same')
const firstHeading = body.indexOf('  ## Same')
const invoke = callback => callback({ button: 0, preventDefault() {}, stopPropagation() {} })
const action = (view, id) => { const node = view.byId(id); assert.ok(node, `missing control ${id}`); return node.props.onClick }
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const workspace = view => view.reviewStore.state.value.workspace
const noteValues = view => workspace(view).notes.map(({ heading_start, text }) => ({ heading_start, text }))
const literal = node => (node.type === '#comment' ? '' : node.text ?? '') + (node.children ?? []).map(literal).join('')
const requestCount = view => Object.values(view.requests?.calls ?? {}).reduce((sum, calls) => sum + calls.length, 0)
const drain = callbacks => callbacks.splice(0).forEach(callback => callback())
const clean = view => { assert.deepEqual(view.networkCalls ?? [], []); assert.deepEqual(view.storageWrites ?? [], []); assert.deepEqual(view.warnings, []) }
const sourcePath = parent => parent === 'live' ? '/reports?report_id=report_A' : '/report-files'
const envelope = (source, notes) => ({ format: 'mirofish-report-review-notes', version: 1,
  source: { report_id: source.report_id, text_sha256: createHash('sha256').update(source.markdown_content, 'utf8').digest('hex'), text_bytes: Buffer.byteLength(source.markdown_content, 'utf8') }, notes })
function notesFile(value, name = 'review.json', overrides = {}) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value) + '\n')
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer, ...overrides }
}
async function chooseNotes(view, chosen) {
  const picker = view.byId('review-notes-file'); assert.ok(picker)
  const target = { files: chosen === null ? [] : Array.isArray(chosen) ? chosen : [chosen], value: 'chosen.json' }
  const pending = picker.props.onChange({ target }); await flush()
  return { pending, target }
}
async function previewNotes(view, value, name) {
  const { pending, target } = await chooseNotes(view, notesFile(value, name)); await pending; await flush(); assert.equal(target.value, '')
}
async function load(view, value, parent = 'file') {
  if (parent === 'file') await acceptFile(view, value)
  else { view.requests.calls.getSavedReport.at(-1).resolve(ok(value)); await flush() }
}
async function stage(view) {
  await view.click('review-report')
  await view.waitFor(() => view.router.currentRoute.value.path === '/report-review')
  await flush()
  assert.ok(view.reviewStore.state.value.candidate, 'capture must stage a detached candidate before its intentional navigation')
}
async function start(view) { await stage(view); await view.click('review-open'); assert.ok(workspace(view)) }
async function add(view, text, heading = null) {
  await view.click('review-add'); await view.input('review-note-text', text)
  if (heading !== null) await view.change('review-note-heading', String(heading))
  await view.click('review-save-note')
}
async function setup(t, options = {}, value = report('report_A', body)) {
  const parent = options.parent ?? 'file'
  const view = await mountReportFiles({ ...options, initialPath: sourcePath(parent) })
  t.after(() => view.unmount())
  await load(view, value, parent); await start(view)
  return view
}
function unloadEvent(view) {
  const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true } }
  view.dispatchWindow('beforeunload', event)
  return event
}

// 1. Explicit capture and authored operations from each accepted entry path.
test('review group 1: capture, add, edit, remove and portable reopen on both entry paths', async t => {
  for (const parent of ['file', 'live']) for (const locale of ['en', 'zh']) await t.test(`${parent}, ${locale}`, async t => {
    const source = report('report_A', body), view = await mountReportFiles({ initialPath: sourcePath(parent), locale })
    t.after(() => view.unmount())
    await load(view, source, parent)
    assert.equal(workspace(view), null)
    assert.ok(view.byId('review-report'))
    const requests = requestCount(view)
    await view.click('capture-left'); await view.click('comparison-left-download-json')
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()).observation, source)
    await stage(view); assert.equal(workspace(view), null)
    await view.click('review-open')
    assert.equal(view.text(view.byId('review-report-id')), source.report_id)
    assert.equal(literal(view.byId('markdown')), body)
    assert.equal(view.all(node => node.props.id === 'report-find').length, 1)
    assert.equal(view.all(node => node.props.id === 'report-heading').length, 1)
    assert.equal(Object.isFrozen(workspace(view).source), true)
    assert.equal(workspace(view).source.markdown_content, body)
    await add(view, 'General question\r\nKeep literal <img src=x>')
    await add(view, 'Section question', secondHeading)
    await view.click('review-edit-0'); await view.input('review-note-text', 'Revised question'); await view.click('review-save-note')
    await view.click('review-remove-1')
    assert.deepEqual(noteValues(view), [{ heading_start: null, text: 'Revised question' }])
    await view.click('review-export')
    const exported = view.downloads.at(-1), savedNotes = JSON.parse(await exported.blob.text())
    assert.equal(exported.filename, 'report_A.review-notes.json')
    assert.deepEqual(savedNotes, envelope(source, noteValues(view)))
    assert.equal(requestCount(view), requests)
    const prior = workspace(view)
    await view.navigate('/report-files'); await acceptFile(view, { ...source, observed_at: 'a different recorded time' }); await stage(view)
    assert.equal(workspace(view), prior); assert.ok(view.byId('review-replace'))
    await view.click('review-replace'); assert.notEqual(workspace(view).id, prior.id); assert.deepEqual(noteValues(view), [])
    await previewNotes(view, savedNotes)
    assert.deepEqual(noteValues(view), []); assert.ok(view.byId('review-import-preview'))
    await view.click('review-open-notes'); assert.deepEqual(noteValues(view), savedNotes.notes)
    assert.equal(workspace(view).source.observed_at, 'a different recorded time')
    assert.equal(view.all(node => ['img', 'script', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
    clean(view)
  })
  for (const parent of ['file', 'live']) await t.test(`recorded-completed eligibility, including an empty body (${parent})`, async t => {
    const view = await mountReportFiles({ initialPath: sourcePath(parent) }); t.after(() => view.unmount())
    const missing = { ...report(), content_available: false, markdown_content: null, content_bytes: null, content_revision: null, content_source: null, content_error: 'not_saved' }
    const cases = [{ ...report(), status: 'failed' }, { ...report(), status: 'unknown' }, missing]
    for (const [index, source] of cases.entries()) {
      if (parent === 'live' && index) { await view.click('close-reader'); await view.navigate(sourcePath(parent)) }
      await load(view, source, parent)
      assert.equal(view.byId('review-report').props.disabled, true)
      invoke(action(view, 'review-report')); await flush(); assert.equal(workspace(view), null)
    }
    if (parent === 'live') { await view.click('close-reader'); await view.navigate(sourcePath(parent)) }
    await load(view, report('report_A', ''), parent)
    assert.equal(view.byId('review-report').props.disabled, false); await start(view)
    await add(view, 'Empty source question'); assert.equal(workspace(view).notes[0].heading_start, null); clean(view)
  })
  await t.test('the existing library host compiles the launch and dedicated route', async t => {
    const view = await mountReportLibrary({ initialPath: '/reports?report_id=report_A' }); t.after(() => view.unmount())
    await load(view, report('report_A', ''), 'live'); await start(view)
    await add(view, 'An empty completed report still supports a general note')
    assert.equal(workspace(view).source.markdown_content, '')
    assert.equal(workspace(view).notes.length, 1); assert.deepEqual(view.warnings, [])
  })
})

// 2. Capture ownership is permanently retired, including transient invalidity.
test('review group 2: A → B → A, stale digest and source retirement', async t => {
  for (const settlement of ['resolve', 'reject']) await t.test(`late ${settlement} cannot replace the newest capture`, async t => {
    const pending = [], host = { crypto: { subtle: { digest(algorithm, bytes) { const call = defer(); pending.push({ ...call, algorithm, bytes: new Uint8Array(bytes) }); return call.promise } } } }
    const view = await mountReportFiles({ reviewHost: host }); t.after(() => view.unmount())
    const a = report('report_A', body), b = report('report_A', 'replacement B\r\n')
    for (const source of [a, b, a]) { await acceptFile(view, source); await view.click('review-report') }
    assert.equal(pending.length, 3)
    for (const call of pending.slice(0, 2)) {
      if (settlement === 'reject') call.reject(Error('PRIVATE stale digest failure'))
      else call.resolve(await webcrypto.subtle.digest(call.algorithm, call.bytes))
    }
    await flush(); assert.equal(workspace(view), null); assert.equal(view.reviewStore.state.value.candidate, null)
    assert.equal(view.router.currentRoute.value.path, '/report-files')
    pending[2].resolve(await webcrypto.subtle.digest(pending[2].algorithm, pending[2].bytes))
    await view.waitFor(() => view.byId('review-open')); await view.click('review-open')
    assert.equal(workspace(view).source.markdown_content, body); assert.doesNotMatch(view.text(), /PRIVATE/); clean(view)
  })
  await t.test('same object owner false then true permanently retires its pending digest', async t => {
    const owner = ref(true), pending = defer()
    const view = await mountReportFiles({ reviewOwner: () => owner.value, reviewHost: { crypto: { subtle: { digest: () => pending.promise } } } })
    t.after(() => view.unmount())
    await acceptFile(view, report('report_A', body)); await view.click('review-report')
    owner.value = false; owner.value = true
    pending.resolve(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
    await flush()
    assert.equal(workspace(view), null); assert.equal(view.reviewStore.state.value.candidate, null)
    assert.equal(view.router.currentRoute.value.path, '/report-files'); clean(view)
  })
  for (const failure of ['missing', 'getter', 'rejected', 'invalid-result']) await t.test(`${failure} digest preserves the accepted workspace`, async t => {
    const view = await setup(t); await add(view, 'Retained note'); const original = workspace(view)
    await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'new source'))
    if (failure === 'getter') Object.defineProperty(view.reviewHost, 'crypto', { configurable: true, get() { throw Error('PRIVATE host getter') } })
    else view.reviewHost.crypto = failure === 'missing' ? undefined : { subtle: { digest: () => failure === 'rejected' ? Promise.reject(Error('PRIVATE rejection')) : Promise.resolve(new ArrayBuffer(31)) } }
    await view.click('review-report'); await flush()
    assert.equal(workspace(view), original); assert.equal(view.reviewStore.state.value.candidate, null)
    assert.equal(view.router.currentRoute.value.path, '/report-files')
    assert.ok(view.text(view.byId('review-capture-status')).length); assert.doesNotMatch(view.text(), /PRIVATE/); clean(view)
  })
  for (const field of ['markdown_content', 'title']) await t.test(`a live lone surrogate in ${field} remains readable but cannot enter portable review`, async t => {
    const view = await mountReportFiles({ initialPath: sourcePath('live') }); t.after(() => view.unmount())
    const source = report('report_A', body); source[field] = '\ud800'
    if (field === 'markdown_content') source.content_bytes = new TextEncoder().encode(source.markdown_content).length
    await load(view, source, 'live'); assert.ok(view.byId('reader'))
    await view.click('review-report'); await flush()
    assert.equal(workspace(view), null); assert.equal(view.reviewStore.state.value.candidate, null)
    assert.ok(view.byId('review-capture-status')); assert.ok(view.byId('reader')); clean(view)
  })
  await t.test('live capture detaches before a reentrant digest mutates the parent source', async t => {
    let parentSource
    const view = await mountReportFiles({ initialPath: sourcePath('live'), onReviewLaunchMount: props => { parentSource = props },
      reviewHost: { crypto: { subtle: { digest(algorithm, bytes) { parentSource.source.title = 'later parent title'; parentSource.source.markdown_content = 'later parent body'; return webcrypto.subtle.digest(algorithm, bytes) } } } } })
    t.after(() => view.unmount())
    await load(view, report('report_A', body), 'live'); await start(view)
    assert.equal(workspace(view).source.title, 'Saved report'); assert.equal(workspace(view).source.markdown_content, body)
    assert.equal(workspace(view).binding.text_sha256, envelope(report('report_A', body), []).source.text_sha256)
    assert.notEqual(workspace(view).source, parentSource.source); clean(view)
  })
})

// 3. Read and preview are inert until an owned explicit whole-list acceptance.
test('review group 3: read, preview, reject and Cancel retain notes; Open replaces', async t => {
  await t.test('invalid, mismatched and cancelled imports preserve the entire active list', async t => {
    const view = await setup(t); await add(view, 'Keep existing')
    const initial = workspace(view), next = envelope(initial.source, [{ heading_start: secondHeading, text: 'Imported\r\nquestion\rnext\nlast' }])
    const reading = defer(), chosen = notesFile(next, '../<img>.json', { arrayBuffer: () => reading.promise })
    const { pending } = await chooseNotes(view, chosen)
    assert.equal(workspace(view), initial)
    reading.resolve(await notesFile(next).arrayBuffer()); await pending; await flush()
    assert.equal(workspace(view), initial); assert.ok(view.byId('review-import-preview'))
    assert.ok(view.text(view.byId('review-import-preview')).includes('../<img>.json'))
    await view.click('review-cancel-import'); assert.equal(workspace(view), initial)
    for (const invalid of ['{PRIVATE malformed', { ...next, source: { ...next.source, text_sha256: '0'.repeat(64) } }]) {
      await previewNotes(view, invalid); assert.ok(view.byId('review-import-error')); assert.equal(workspace(view), initial)
    }
    await chooseNotes(view, null); assert.equal(view.byId('review-import-error'), undefined); assert.equal(workspace(view), initial)
    await previewNotes(view, next); await view.click('review-open-notes')
    assert.deepEqual(noteValues(view), next.notes); assert.notEqual(workspace(view).notesRevision, initial.notesRevision)
    await view.click('review-edit-0'); await view.click('review-save-note')
    assert.equal(workspace(view).notes[0].text, next.notes[0].text, 'saving an untouched imported editor must preserve CR/LF/CRLF')
    await view.click('review-edit-0'); await view.input('review-note-text', 'Unsaved editor')
    await previewNotes(view, next)
    assert.equal(view.byId('review-open-notes').props.disabled, true)
    invoke(action(view, 'review-open-notes')); await flush()
    assert.equal(workspace(view).draft.text, 'Unsaved editor'); assert.equal(workspace(view).notes[0].text, next.notes[0].text)
    await view.click('review-discard-draft')
    await previewNotes(view, envelope(initial.source, [])); assert.equal(workspace(view).notes.length, 1)
    assert.match(view.text(view.byId('review-open-notes')), /discard|replace/i)
    await view.click('review-open-notes'); assert.deepEqual(noteValues(view), []); clean(view)
  })
  await t.test('new selection, edits and route departure retire reads and old acceptance callbacks', async t => {
    const view = await setup(t); await add(view, 'Original')
    const source = workspace(view).source, oldRead = defer(), incoming = envelope(source, [{ heading_start: null, text: 'Imported' }])
    const { pending } = await chooseNotes(view, notesFile(incoming, 'late.json', { arrayBuffer: () => oldRead.promise }))
    await previewNotes(view, incoming, 'newer.json'); const staleOpen = action(view, 'review-open-notes')
    oldRead.reject(Error('PRIVATE stale read')); await pending; await flush()
    assert.ok(view.text(view.byId('review-import-preview')).includes('newer.json')); assert.equal(view.byId('review-import-error'), undefined)
    await view.click('review-add'); await view.input('review-note-text', 'New authored work'); invoke(staleOpen); await flush()
    assert.equal(workspace(view).draft.text, 'New authored work'); assert.equal(workspace(view).notes[0].text, 'Original')
    await view.click('review-save-note'); invoke(staleOpen); await flush(); assert.equal(workspace(view).notes.length, 2)
    const departed = defer(), previous = workspace(view)
    const read = await chooseNotes(view, notesFile(incoming, 'departed.json', { arrayBuffer: () => departed.promise }))
    await view.navigate('/runtime'); await view.navigate('/report-review')
    departed.resolve(await notesFile(incoming).arrayBuffer()); await read.pending; await flush()
    assert.equal(workspace(view), previous); assert.equal(view.byId('review-import-preview'), undefined)
    invoke(staleOpen); await flush(); assert.equal(workspace(view), previous); clean(view)
  })
})

// 4. The tab owns content and draft; replace/clear choices own exact revisions.
test('review group 4: SPA persistence, draft protection and explicit Replace/Clear cancellation', async t => {
  await t.test('draft and unload protection survive navigation and download initiation', async t => {
    const view = await setup(t)
    assert.equal(unloadEvent(view).prevented, false)
    await view.click('review-add'); await view.input('review-note-text', ' \r\n')
    assert.equal(view.byId('review-export').props.disabled, true)
    const retained = workspace(view), oldSave = action(view, 'review-save-note')
    assert.equal(unloadEvent(view).prevented, true)
    await view.navigate('/runtime'); assert.equal(workspace(view), retained); assert.equal(unloadEvent(view).prevented, true)
    await view.navigate('/report-review'); invoke(oldSave); await flush()
    assert.equal(workspace(view), retained); assert.equal(view.byId('review-note-text').props.value, ' \r\n')
    await view.input('review-note-text', 'Draft preserved'); await view.click('review-save-note')
    const prior = workspace(view)
    await view.click('review-export'); assert.equal(unloadEvent(view).prevented, true)
    assert.match(view.text(view.byId('review-export-status')), /Download requested/i)
    assert.match(view.text(view.byId('review-export-status')), /cannot confirm/i)
    await view.click('review-edit-0'); await view.input('review-note-text', 'x'.repeat(2001))
    assert.equal(workspace(view).draft.text, 'Draft preserved'); assert.ok(view.byId('review-draft-error'))
    await view.click('review-discard-draft'); assert.deepEqual(noteValues(view), prior.notes.map(({ heading_start, text }) => ({ heading_start, text })))
    await view.click('review-remove-0'); assert.equal(unloadEvent(view).prevented, false); clean(view)
  })
  await t.test('replacement and clear Cancel retain notes/draft; old destructive choices retire', async t => {
    const view = await setup(t); await add(view, 'Keep A'); const a = workspace(view)
    await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'B')); await stage(view)
    const oldReplace = action(view, 'review-replace')
    await view.click('review-add'); await view.input('review-note-text', 'Unsaved A')
    invoke(oldReplace); await flush(); assert.equal(workspace(view).id, a.id); assert.equal(workspace(view).draft.text, 'Unsaved A')
    await view.click('review-cancel-candidate'); assert.equal(workspace(view).id, a.id)
    await view.click('review-clear'); const oldClear = action(view, 'review-confirm-clear')
    await view.input('review-note-text', 'Later A'); invoke(oldClear); await flush()
    assert.equal(workspace(view).draft.text, 'Later A')
    await view.click('review-clear'); await view.click('review-cancel-clear'); assert.equal(workspace(view).id, a.id)
    await view.navigate('/report-files'); await acceptFile(view, report('report_A', body)); await stage(view)
    assert.equal(workspace(view).id, a.id, 'same-ID/body capture must still request replacement')
    await view.click('review-replace'); assert.notEqual(workspace(view).id, a.id); assert.deepEqual(noteValues(view), []); assert.equal(workspace(view).draft, null)
    await add(view, 'Clear explicitly'); await view.click('review-clear'); await view.click('review-confirm-clear')
    assert.equal(workspace(view), null); assert.ok(view.byId('review-empty')); assert.equal(unloadEvent(view).prevented, false); clean(view)
  })
  await t.test('aborted navigation and equivalent review URLs retain an operable view', async t => {
    const callbacks = [], readerMounts = []
    const view = await setup(t, { deferredScrolls: callbacks, onReaderMount: props => readerMounts.push(props.source) })
    await add(view, 'Still here', firstHeading); const original = workspace(view)
    const removeGuard = view.router.beforeEach(to => to.path === '/runtime' ? false : undefined)
    try { await view.navigate('/runtime') } finally { removeGuard() }
    assert.equal(view.router.currentRoute.value.path, '/report-review'); assert.equal(workspace(view), original)
    await add(view, 'After aborted navigation'); await view.input('report-find', 'needle')
    drain(callbacks); await flush()
    const findNode = view.byId('report-find'), mountedReaders = readerMounts.length, source = workspace(view).source
    for (const path of ['/report-review#notes', '/report-review?panel=notes#notes']) {
      const staleRemove = action(view, 'review-remove-0'), staleExport = action(view, 'review-export'), staleJump = action(view, 'review-show-0')
      const before = view.scrollCalls.length, retained = workspace(view)
      await view.navigate(path); invoke(staleRemove); invoke(staleExport); invoke(staleJump); await flush(); drain(callbacks); await flush()
      assert.equal(workspace(view), retained); assert.equal(view.downloads.length, 0); assert.equal(view.scrollCalls.length, before)
      assert.equal(view.byId('report-find'), findNode); assert.equal(view.byId('report-find').props.value, 'needle')
      assert.equal(readerMounts.length, mountedReaders, 'equivalent review URLs must keep the same live reader')
      assert.equal(workspace(view).source, source); assert.equal(literal(view.byId('markdown')), body)
      await view.click('review-show-0'); drain(callbacks); await flush()
      assert.equal(view.scrollCalls.length, before + 1, 'a fresh section action must still reach the retained reader')
      assert.equal(view.scrollCalls.at(-1).node.props['data-heading-offset'], firstHeading)
      assert.equal(view.byId('report-find').props.value, 'needle')
    }
    await add(view, 'After review URL navigation')
    assert.deepEqual(noteValues(view).map(note => note.text), ['Still here', 'After aborted navigation', 'After review URL navigation'])
    clean(view)
  })
  await t.test('unrelated navigation cancels a staged candidate and a new tab has honest empty recovery', async t => {
    const view = await setup(t); const original = workspace(view)
    await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'B')); await stage(view)
    await view.navigate('/runtime'); await view.navigate('/report-review')
    assert.equal(view.reviewStore.state.value.candidate, null); assert.equal(workspace(view), original)
    const fresh = await mountReportFiles({ initialPath: '/report-review' }); t.after(() => fresh.unmount())
    assert.equal(workspace(fresh), null); assert.ok(fresh.byId('review-empty')); assert.equal(fresh.byId('review-note-text'), undefined)
    assert.match(fresh.text(fresh.byId('review-empty')), /report|notes/i); clean(view); clean(fresh)
  })
})

// 5. Old handlers and reentrant platform boundaries cannot retarget authored work.
test('review group 5: stale edit/remove/export handlers and failed or reentrant downloads', async t => {
  for (const cacheHandlers of [true, false]) await t.test(`same-workspace and route-retired callbacks (${cacheHandlers})`, async t => {
    const view = await setup(t, { cacheHandlers }); await add(view, 'First'); await add(view, 'Second')
    const oldEdit = action(view, 'review-edit-1'), oldRemove = action(view, 'review-remove-1'), oldExport = action(view, 'review-export')
    await view.click('review-remove-0'); const kept = workspace(view)
    invoke(oldEdit); invoke(oldRemove); invoke(oldExport); await flush()
    assert.equal(workspace(view), kept); assert.deepEqual(noteValues(view), [{ heading_start: null, text: 'Second' }]); assert.equal(view.downloads.length, 0)
    await view.click('review-edit-0'); const oldInput = view.byId('review-note-text').props.onInput, oldSave = action(view, 'review-save-note')
    await view.input('review-note-text', 'Latest draft'); oldInput({ target: { value: 'Stale draft' } }); invoke(oldSave); await flush()
    assert.equal(workspace(view).draft.text, 'Latest draft'); await view.click('review-save-note')
    const source = workspace(view).source
    await previewNotes(view, envelope(source, [{ heading_start: null, text: 'Imported replacement' }]))
    const beforeImport = action(view, 'review-remove-0'); await view.click('review-open-notes'); invoke(beforeImport); await flush()
    assert.equal(workspace(view).notes[0].text, 'Imported replacement')
    const departedRemove = action(view, 'review-remove-0'), departedExport = action(view, 'review-export')
    const routeSnapshots = []
    const stop = watch(() => view.router.currentRoute.value.fullPath, () => {
      routeSnapshots.push(!!view.byId('review-remove-0')); invoke(departedRemove); invoke(departedExport)
    }, { flush: 'sync' })
    try { await view.navigate('/runtime') } finally { stop() }
    assert.deepEqual(routeSnapshots, [true], 'exercise the committed departure before old review DOM unmounts')
    await view.navigate('/report-review'); invoke(departedRemove); invoke(departedExport); await flush()
    assert.equal(workspace(view).notes[0].text, 'Imported replacement'); assert.equal(view.downloads.length, 0)
    await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'B')); await stage(view); await view.click('review-replace')
    invoke(oldEdit); invoke(oldRemove); invoke(oldExport); invoke(oldSave); await flush()
    assert.equal(workspace(view).source.report_id, 'report_B'); assert.deepEqual(noteValues(view), []); assert.equal(view.downloads.length, 0); clean(view)
  })
  for (const boundary of ['beforeCreate', 'beforeAnchor', 'append', 'click']) await t.test(`${boundary} failure leaves notes and releases owned resources`, async t => {
    const hooks = {}, view = await setup(t, { downloadHooks: hooks }); await add(view, 'Retained on failure'); const kept = workspace(view)
    hooks[boundary] = () => { throw Error('PRIVATE download error') }
    await view.click('review-export')
    assert.equal(workspace(view), kept); assert.equal(view.downloads.length, 0)
    assert.equal(view.blobs.size, 0); assert.equal(view.timers.pending.size, 0); assert.ok(view.anchors.every(anchor => !anchor.attached))
    assert.doesNotMatch(view.text(), /PRIVATE/); assert.ok(view.text(view.byId('review-export-status')).length)
    delete hooks[boundary]; await view.click('review-export'); assert.equal(view.downloads.length, 1); assert.equal(workspace(view), kept); clean(view)
  })
  for (const boundary of ['create', 'anchor', 'append']) await t.test(`reentrant ${boundary} replacement retires the current download`, async t => {
    const hooks = {}, view = await setup(t, { downloadHooks: hooks }); await add(view, 'Old report note')
    await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'B')); await stage(view)
    const replace = action(view, 'review-replace'); hooks[boundary] = () => { delete hooks[boundary]; invoke(replace) }
    await view.click('review-export')
    assert.equal(workspace(view).source.report_id, 'report_B'); assert.deepEqual(noteValues(view), []); assert.equal(view.downloads.length, 0)
    assert.equal(view.blobs.size, 0); assert.equal(view.timers.pending.size, 0); assert.ok(view.anchors.every(anchor => !anchor.attached)); clean(view)
  })
  for (const boundary of ['createObjectURL', 'revokeObjectURL', 'setTimeout', 'clearTimeout']) for (const retirement of ['replace', 'clear']) await t.test(`reentrant ${boundary} getter stops the retired ${retirement} attempt`, async t => {
    const view = await setup(t); await add(view, 'Original payload\r\nunchanged')
    const original = workspace(view), expected = envelope(original.source, noteValues(view))
    if (retirement === 'replace') {
      await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'Replacement B')); await stage(view)
    } else await view.click('review-clear')
    const retire = action(view, retirement === 'replace' ? 'review-replace' : 'review-confirm-clear')
    const targets = { createObjectURL: view.reviewHost.URL, revokeObjectURL: view.reviewHost.URL, setTimeout: view.reviewHost, clearTimeout: view.reviewHost }
    const descriptors = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, Object.getOwnPropertyDescriptor(target, name)]))
    const accesses = [], calls = []
    let retired = false
    try {
      for (const [name, target] of Object.entries(targets)) Object.defineProperty(target, name, { configurable: true, get() {
        accesses.push(name)
        if (name === boundary && !retired) { retired = true; invoke(retire) }
        return (...args) => { calls.push(name); return Reflect.apply(descriptors[name].value, target, args) }
      } })
      await view.click('review-export')
      const getters = ['createObjectURL', 'revokeObjectURL', 'setTimeout', 'clearTimeout']
      assert.deepEqual(accesses, getters.slice(0, getters.indexOf(boundary) + 1), 'no subsequent getter may be evaluated by the retired initiating attempt')
      const initiated = boundary === 'setTimeout' || boundary === 'clearTimeout'
      assert.deepEqual(calls, initiated ? ['createObjectURL', 'revokeObjectURL'] : [], 'retirement permits only cleanup of an already allocated URL')
      assert.equal(view.downloads.length, initiated ? 1 : 0); assert.equal(view.anchors.length, initiated ? 1 : 0)
      if (initiated) assert.deepEqual(JSON.parse(await view.downloads[0].blob.text()), expected, 'a requested download retains its frozen original payload')
      assert.equal(original.notes[0].text, 'Original payload\r\nunchanged'); assert.equal(original.source.markdown_content, body)
      assert.equal(view.blobs.size, 0); assert.equal(view.timers.pending.size, 0); assert.ok(view.anchors.every(anchor => !anchor.attached))
      assert.equal(view.revokedUrls.length, initiated ? 1 : 0)
      if (retirement === 'replace') { assert.equal(workspace(view).source.report_id, 'report_B'); assert.deepEqual(noteValues(view), []) }
      else assert.equal(workspace(view), null)
    } finally {
      for (const [name, target] of Object.entries(targets)) Object.defineProperty(target, name, descriptors[name])
    }
    if (retirement === 'clear') {
      await view.navigate('/report-files'); await acceptFile(view, report('report_B', 'Replacement B')); await start(view)
    }
    await add(view, 'New workspace remains usable'); const before = view.downloads.length
    await view.click('review-export'); assert.equal(view.downloads.length, before + 1)
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), envelope(workspace(view).source, noteValues(view)))
    await view.timers.advance(1000); assert.equal(view.blobs.size, 0); assert.equal(view.timers.pending.size, 0)
    assert.equal(new Set(view.revokedUrls).size, view.revokedUrls.length); clean(view)
  })
  for (const boundary of ['createObjectURL', 'setTimeout']) await t.test(`reentrant ${boundary} getter starts a newer export whose resources stay owned`, async t => {
    const view = await setup(t); await add(view, 'Two attempts, one frozen notes revision')
    const expected = envelope(workspace(view).source, noteValues(view)), exportAgain = action(view, 'review-export')
    const targets = { createObjectURL: view.reviewHost.URL, revokeObjectURL: view.reviewHost.URL, setTimeout: view.reviewHost, clearTimeout: view.reviewHost }
    const descriptors = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, Object.getOwnPropertyDescriptor(target, name)]))
    const accesses = [], calls = []
    let attempt = 'old', reentered = false
    try {
      for (const [name, target] of Object.entries(targets)) Object.defineProperty(target, name, { configurable: true, get() {
        const owner = attempt; accesses.push(`${owner}:${name}`)
        if (owner === 'old' && name === boundary && !reentered) {
          reentered = true; attempt = 'new'; try { invoke(exportAgain) } finally { attempt = 'old' }
        }
        return (...args) => { calls.push(`${owner}:${name}`); return Reflect.apply(descriptors[name].value, target, args) }
      } })
      await view.click('review-export')
      const getters = ['createObjectURL', 'revokeObjectURL', 'setTimeout', 'clearTimeout']
      assert.deepEqual(accesses.filter(value => value.startsWith('old:')), getters.slice(0, getters.indexOf(boundary) + 1).map(name => `old:${name}`))
      assert.deepEqual(accesses.filter(value => value.startsWith('new:')), getters.map(name => `new:${name}`))
      assert.equal(calls.includes('old:setTimeout'), false); assert.equal(calls.includes('old:clearTimeout'), false)
      if (boundary === 'createObjectURL') assert.equal(calls.some(value => value.startsWith('old:')), false)
      const initiated = boundary === 'setTimeout'
      assert.equal(view.downloads.length, initiated ? 2 : 1)
      for (const download of view.downloads) assert.deepEqual(JSON.parse(await download.blob.text()), expected)
      const latest = view.downloads.at(-1).url
      assert.deepEqual([...view.blobs.keys()], [latest]); assert.equal(view.revokedUrls.includes(latest), false)
      assert.equal(view.timers.pending.size, 1); assert.equal(view.revokedUrls.length, initiated ? 1 : 0)
      assert.ok(view.anchors.every(anchor => !anchor.attached))
    } finally {
      for (const [name, target] of Object.entries(targets)) Object.defineProperty(target, name, descriptors[name])
    }
    await view.timers.advance(1000); assert.equal(view.blobs.size, 0); assert.equal(view.timers.pending.size, 0)
    const before = view.downloads.length; await view.click('review-export'); assert.equal(view.downloads.length, before + 1)
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), expected)
    await view.timers.advance(1000); assert.equal(view.blobs.size, 0); assert.equal(new Set(view.revokedUrls).size, view.revokedUrls.length); clean(view)
  })
  await t.test('frozen payload and attempt cleanup do not affect a newer download', async t => {
    const hooks = {}, view = await setup(t, { downloadHooks: hooks }); await add(view, 'Before click')
    const remove = action(view, 'review-remove-0')
    hooks.create = () => { delete hooks.create; invoke(remove) }
    await view.click('review-export'); assert.deepEqual(noteValues(view), [])
    assert.equal(JSON.parse(await view.downloads[0].blob.text()).notes[0].text, 'Before click')
    await view.click('review-export'); const latest = view.downloads[1].url
    assert.ok(view.blobs.has(latest)); assert.equal(view.revokedUrls.includes(latest), false)
    await view.timers.advance(1000); assert.equal(view.blobs.size, 0)
    assert.equal(new Set(view.revokedUrls).size, view.revokedUrls.length, 'each URL must be released by its own attempt once')
    assert.ok(view.anchors.every(anchor => !anchor.attached)); clean(view)
  })
})

// 6. The reader owns target lookup, render/focus scheduling, Find and raw bytes.
test('review group 6: Show section preserves Find/source and later focus/navigation wins in both languages', async t => {
  for (const locale of ['en', 'zh']) await t.test(`reader integration and focus ownership (${locale})`, async t => {
    const callbacks = [], writes = [], view = await setup(t, { locale, deferredScrolls: callbacks,
      clipboardHost: { navigator: { clipboard: { writeText: value => { writes.push(value); return Promise.resolve() } } } } })
    await add(view, 'First duplicate heading', firstHeading); await add(view, '<script>literal note</script>\r\n<img src=x>', secondHeading)
    await view.input('report-find', 'needle'); await view.change('report-find-case', true); drain(callbacks); await flush()
    const original = workspace(view), requests = requestCount(view)
    await view.click('review-show-1'); await flush(); drain(callbacks); await flush()
    assert.equal(view.byId('report-heading').props.value, String(secondHeading))
    assert.equal(view.byId('report-find').props.value, 'needle'); assert.equal(view.byId('report-find-case').props.checked, true)
    assert.equal(literal(view.byId('markdown')), body); assert.equal(workspace(view), original)
    assert.equal(view.scrollCalls.at(-1).node.props['data-heading-offset'], secondHeading)
    const beforeFocus = view.focusCalls.length
    await view.click('review-show-0'); await flush(); view.document.focus(view.byId('review-export')); drain(callbacks); await flush()
    assert.equal(view.focusCalls.length, beforeFocus, 'later deliberate focus must defeat the queued section jump')
    const beforeFind = view.scrollCalls.length
    await view.click('review-show-0'); await view.input('report-find', '雪'); drain(callbacks); await flush()
    assert.equal(view.byId('report-find').props.value, '雪')
    assert.ok(view.scrollCalls.slice(beforeFind).every(call => call.node.props['data-heading-offset'] !== firstHeading), 'later Find retires the external jump')
    const staleJump = action(view, 'review-show-1'), beforeRoute = view.scrollCalls.length
    await view.click('review-show-1'); await view.navigate('/runtime'); drain(callbacks); await flush()
    await view.navigate('/report-review'); invoke(staleJump); drain(callbacks); await flush()
    assert.equal(view.scrollCalls.length, beforeRoute); assert.equal(workspace(view), original)
    await view.change('review-language', locale === 'en' ? 'zh' : 'en')
    assert.match(view.text(view.byId('review-add')), locale === 'en' ? /添加/ : /Add/)
    assert.match(view.text(view.byId('review-show-0')), locale === 'en' ? /章节|小节/ : /Show section/)
    assert.equal(literal(view.byId('markdown')), body)
    await view.click('copy-saved-markdown'); assert.deepEqual(writes, [body])
    await view.click('review-export-source')
    const observation = JSON.parse(await view.downloads.at(-1).blob.text()).observation
    assert.deepEqual(observation, original.source)
    assert.deepEqual(new TextEncoder().encode(observation.markdown_content), new TextEncoder().encode(body))
    assert.equal(view.all(node => ['img', 'script', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
    assert.equal(requestCount(view), requests); clean(view)
  })
})
