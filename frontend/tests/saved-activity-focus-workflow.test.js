import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readSavedActivityFile } from '../src/utils/savedActivityFiles.js'
import { mountActivityFiles, chooseFile, flush, waitFor, ok } from './helpers/saved-activity-files-view-fixture.js'

// These observations come from the actual Python production reader over fresh
// temporary saved logs. The fixture denies socket access and checks that the
// source files are unchanged; it does not start Flask or a simulation runner.
const fixture = JSON.parse(execFileSync('python3', [
  fileURLToPath(new URL('./helpers/saved-activity-files-reader-fixture.py', import.meta.url)),
], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 }))
const observations = fixture.observations
const page = name => ({ format_version: 1, ...observations[name] })
const encoded = value => JSON.stringify(value, null, 2) + '\n'
const actualFile = (value, name = 'captured-page.json') => new File([encoded(value)], name, { type: 'application/json' })
const rowIds = view => view.all(node => String(node.props['data-testid'] ?? '').startsWith('action-row-'))
  .map(node => node.props['data-testid'].slice('action-row-'.length))
const controlIds = ['focus-platform', 'focus-outcome', 'focus-reset', 'focus-count', 'focus-scope']
const clickEvent = () => ({ button: 0, preventDefault() {}, stopPropagation() {} })
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function livePath(data) {
  const query = new URLSearchParams({ offset: data.offset, limit: data.limit })
  for (const [key, value] of Object.entries(data.filters)) if (value !== null && value !== false) query.set(key, String(value))
  if (data.offset) query.set('revision', data.source_revision)
  return `/simulation/${data.simulation_id}/activity?${query}`
}

async function liveDownloadAndReopen(t, name, options = {}) {
  assert.equal(fixture.source_files_unchanged, true)
  assert.equal(fixture.no_application_startup, true)
  const data = observations[name], calls = []
  let reviewing = false, unmounted = false
  const api = new Proxy({}, { get: (_object, method) => (...args) => {
    assert.equal(reviewing, false, `Local focus invoked API ${String(method)}`)
    assert.equal(method, 'getSavedActivity')
    calls.push({ method, args })
    assert.equal(args[0], data.simulation_id)
    assert.equal(args[1].offset, data.offset)
    assert.equal(args[1].limit, data.limit)
    for (const [key, value] of Object.entries(data.filters)) {
      if (value !== null && value !== false) assert.equal(args[1][key], value)
    }
    if (data.offset) assert.equal(args[1].revision, data.source_revision)
    assert.ok(args[2] instanceof AbortSignal)
    return Promise.resolve(ok(structuredClone(data)))
  } })
  const view = await mountActivityFiles({ api, initialPath: livePath(data), ...options })
  const unmount = () => { if (!unmounted) { unmounted = true; view.unmount() } }
  t.after(unmount)
  await waitFor(() => view.byId('results'))
  assert.equal(calls.length, 1)
  await view.click('download')
  const downloaded = view.downloads.at(-1), originalText = await downloaded.blob.text()
  assert.equal(originalText, encoded(page(name)))
  assert.equal(downloaded.filename, `${data.simulation_id}-saved-activity-page-${data.offset}.json`)
  const file = new File([await downloaded.blob.arrayBuffer()], `<img onerror=literal()> Café 雪 ${name}.json`, { type: 'application/json' })
  assert.equal(await file.text(), originalText)
  reviewing = true
  await view.click('open-activity-files')
  await waitFor(() => view.router.currentRoute.value.path === '/activity-files')
  assert.equal(calls[0].args[2].aborted, true)
  assert.ok(view.revokedUrls.includes(downloaded.url))
  for (const id of controlIds) assert.equal(view.byId(id), undefined, `${id} must wait for explicit acceptance`)
  await preview(view, file)
  for (const id of controlIds) assert.equal(view.byId(id), undefined, `${id} must not focus an unaccepted preview`)
  await view.click('open-file')
  for (const id of controlIds) assert.ok(view.byId(id), `Missing local captured-page control ${id}`)
  assert.deepEqual(rowIds(view), data.actions.map(row => row.record_id))
  assert.equal(view.text(view.byId('accepted-filename')), file.name)
  return { view, data, file, calls, originalText, unmount }
}

async function preview(view, file) {
  assert.ok(file instanceof File)
  const { pending } = await chooseFile(view, file)
  await pending; await flush()
  assert.equal(view.byId('file-error'), undefined)
  assert.ok(view.byId('file-preview'))
}

async function accept(view, value, name) {
  await preview(view, actualFile(value, name))
  await view.click('open-file')
}

function noEffects(view, calls) {
  assert.equal(calls.length, 1, 'Only the original live saved-page request is allowed')
  assert.deepEqual(view.networkCalls, [])
  assert.deepEqual(view.storageWrites, [])
  assert.deepEqual(view.warnings, [])
  assert.equal(view.all(node => node.props.innerHTML || ['script', 'img', 'iframe'].includes(node.type)).length, 0)
}

function history(view) {
  const evidence = view.byId('accepted-file')
  assert.ok(evidence)
  const descendants = []
  const visit = node => { descendants.push(node); node.children.forEach(visit) }
  visit(evidence)
  return {
    fields: Object.fromEntries(['filename', 'simulation', 'observed', 'revision', 'availability', 'returned', 'matched', 'offset', 'limit', 'has-more', 'filters', 'context', 'warnings']
      .map(field => [field, view.text(view.byId(`accepted-${field}`))])),
    // Includes both platform coverage values, which have no individual test IDs.
    metadata: descendants.filter(node => node.type === 'dl').map(node => view.text(node)),
    provenance: evidence.children.filter(node => node.type === 'p' && ['provenance', 'notice'].includes(node.props.class)).slice(0, 3).map(node => view.text(node)),
  }
}

function expectedRows(data, platform, outcome) {
  const success = { success: true, failed: false, unknown: null }
  return data.actions.filter(row => (platform === 'all' || row.platform === platform)
    && (outcome === 'all' || row.success === success[outcome]))
}

function assertFocus(view, data, platform, outcome) {
  const expected = expectedRows(data, platform, outcome)
  assert.equal(view.byId('focus-platform').props.value, platform)
  assert.equal(view.byId('focus-outcome').props.value, outcome)
  assert.deepEqual(rowIds(view), expected.map(row => row.record_id))
  assert.deepEqual(view.text(view.byId('focus-count')).match(/\d+/g), [String(expected.length), String(data.actions.length)])
  for (const row of expected) {
    const text = view.text(view.byId(`action-row-${row.record_id}`))
    for (const value of [row.agent_id, row.round_num, row.action_type, row.agent_name, row.timestamp]) if (value !== null) assert.ok(text.includes(value), value)
    assert.equal(view.text(view.byId(`details-${row.record_id}`)), row.details_json)
    if (row.match_preview !== null) assert.equal(view.text(view.byId(`match-preview-${row.record_id}`)), row.match_preview)
  }
  assert.equal(Boolean(view.byId('focus-empty')), data.actions.length > 0 && expected.length === 0)
  assert.equal(Boolean(view.byId('empty-state')), data.actions.length === 0)
}

async function exactReexport(view, originalText) {
  const count = view.downloads.length
  await view.click('download-file')
  assert.equal(view.downloads.length, count + 1)
  const exported = view.downloads.at(-1)
  assert.equal(await exported.blob.text(), originalText, 'Local focus must retain every captured row and every historical field byte-for-byte')
  assert.equal(exported.filename, 'mirofish-saved-activity-page.json')
}

function oldFocusHandlers(view) {
  return {
    platform: view.byId('focus-platform').props.onChange,
    outcome: view.byId('focus-outcome').props.onChange,
    reset: view.byId('focus-reset').props.onClick,
  }
}

function renderedFileModel(view) {
  // Read the compiled component's actual presentation model. This lets the
  // workflow assert row identity and post-unmount ownership, neither of which
  // can be established by comparing rendered text alone.
  let vnode = view.root._vnode
  while (vnode && vnode.type.__name !== 'SavedActivityFilesView') vnode = vnode.component?.subTree
  assert.ok(vnode?.component, 'The actual compiled saved-file view must be mounted')
  const component = vnode.component
  return () => component.setupState.views
}
async function invokeOld(handlers) {
  await handlers.platform({ target: { value: 'reddit' } })
  await handlers.outcome({ target: { value: 'success' } })
  await handlers.reset(clickEvent())
  await flush()
}

for (const locale of ['en', 'zh']) test(`production page → live download → local mixed-outcome focus → complete re-export (${locale})`, async t => {
  const { view, data, file, calls, originalText } = await liveDownloadAndReopen(t, 'full', { locale })
  const savedHistory = history(view), original = encoded(data)
  const model = renderedFileModel(view), acceptedPage = model()[0].accepted.page
  assert.ok(Object.isFrozen(acceptedPage) && Object.isFrozen(acceptedPage.actions))
  assert.match(savedHistory.provenance.join(' '), locale === 'en' ? /historical.*unverified.*not a whole run/i : /历史.*未经验证.*并非完整运行/)
  assert.match(view.text(view.byId('focus-scope')), locale === 'en' ? /(?:only|local).*(?:file|page)/i : /(?:仅|只|本地).*(?:文件|页面|页)/)
  assert.equal(view.byId('focus-count').props['aria-live'], 'polite')
  assert.deepEqual(data.actions.map(row => row.success), [true, false, false, null, true])
  assert.equal(data.actions[1].details_json, data.actions[2].details_json, 'Repeated saved attempts remain separate source records')
  for (const platform of ['all', 'twitter', 'reddit']) for (const outcome of ['all', 'success', 'failed', 'unknown']) {
    await view.change('focus-platform', platform)
    await view.change('focus-outcome', outcome)
    assertFocus(view, data, platform, outcome)
    assert.strictEqual(model()[0].accepted.page, acceptedPage)
    const originalRows = expectedRows(acceptedPage, platform, outcome)
    model()[0].focus.actions.forEach((row, index) => assert.strictEqual(row, originalRows[index]))
    assert.equal(encoded(acceptedPage), originalText)
    assert.deepEqual(history(view), savedHistory)
    await exactReexport(view, originalText)
    noEffects(view, calls)
  }
  await view.change('focus-platform', 'twitter'); await view.change('focus-outcome', 'unknown')
  const otherLocale = locale === 'en' ? 'zh' : 'en'
  const previousScope = view.text(view.byId('focus-scope'))
  await view.change('file-language', otherLocale)
  assertFocus(view, data, 'twitter', 'unknown')
  assert.notEqual(view.text(view.byId('focus-scope')), previousScope)
  await view.change('file-language', locale)
  assert.deepEqual(history(view), savedHistory)
  await view.click('focus-reset'); assertFocus(view, data, 'all', 'all')
  assert.equal(encoded(data), original)
  const admitted = await readSavedActivityFile(file)
  const { focusSavedActivity } = await import('../src/utils/savedActivityReview.js')
  const failed = focusSavedActivity(admitted.actions, 'twitter', 'failed')
  assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.actions))
  assert.equal(failed.length, 2)
  assert.strictEqual(failed[0], admitted.actions[1]); assert.strictEqual(failed[1], admitted.actions[2])
  assert.ok(failed.every(Object.isFrozen))
  assert.equal(encoded(admitted), originalText)
  noEffects(view, calls)
})

for (const locale of ['en', 'zh']) for (const name of ['filtered', 'nonzero', 'partial']) test(`local zero preserves actual ${name} query/counts/coverage/warnings (${locale})`, async t => {
  const { view, data, calls, originalText } = await liveDownloadAndReopen(t, name, { locale })
  const original = history(view)
  if (name === 'filtered') {
    assert.equal(data.filters.q, 'STRASSE'); assert.equal(data.actions[0].match_preview, 'Straße Café 雪 🐟')
    assert.equal(data.filters.outcome, 'failed')
  }
  if (name === 'nonzero') assert.ok(data.offset > 0 && data.has_more && data.matched_count > data.returned_count)
  if (name === 'partial') assert.ok(data.availability === 'partial' && data.warnings.length > 0)
  await view.change('focus-platform', 'reddit')
  assertFocus(view, data, 'reddit', 'all')
  assert.deepEqual(history(view), original)
  assert.match(view.text(view.byId('focus-empty')), locale === 'en' ? /no.*captured.*match/i : /没有.*(?:匹配|符合)|(?:匹配|符合).*记录/)
  await exactReexport(view, originalText)
  await view.click('focus-reset'); assertFocus(view, data, 'all', 'all')
  assert.deepEqual(history(view), original); noEffects(view, calls)
})

for (const locale of ['en', 'zh']) for (const name of ['empty', 'unavailable', 'beyond']) test(`original ${name} is distinct from a local zero (${locale})`, async t => {
  const { view, data, calls, originalText } = await liveDownloadAndReopen(t, name, { locale })
  const original = history(view), emptyText = view.text(view.byId('empty-state'))
  const messages = locale === 'en'
    ? { empty: /zero matching/, unavailable: /unavailable when captured/, beyond: /beyond.*matching/ }
    : { empty: /匹配.*(?:0|零)|(?:0|零).*匹配/, unavailable: /不可用/, beyond: /偏移.*(?:超出|超过)|(?:超出|超过).*偏移/ }
  assert.match(emptyText, messages[name])
  await view.change('focus-platform', 'reddit'); await view.change('focus-outcome', 'failed')
  assertFocus(view, data, 'reddit', 'failed')
  assert.equal(view.text(view.byId('empty-state')), emptyText)
  assert.deepEqual(history(view), original)
  await exactReexport(view, originalText); noEffects(view, calls)
})

for (const cacheHandlers of [true, false]) for (const locale of ['en', 'zh']) test(`pending read survives focus; rejection/cancellation retain it; acceptance resets (cached ${cacheHandlers}, ${locale})`, async t => {
  const { view, data, calls, originalText } = await liveDownloadAndReopen(t, 'full', { cacheHandlers, locale })
  await view.change('focus-platform', 'twitter'); await view.change('focus-outcome', 'failed')
  const original = history(view)
  const replacement = actualFile(page('nonzero'), 'replacement.json'), buffer = await replacement.arrayBuffer(), read = deferred()
  Object.defineProperty(replacement, 'arrayBuffer', { value: () => read.promise })
  const { pending } = await chooseFile(view, replacement)
  assert.ok(view.byId('file-loading'))
  await view.change('focus-outcome', 'unknown')
  assertFocus(view, data, 'twitter', 'unknown')
  await view.change('focus-platform', 'reddit'); assertFocus(view, data, 'reddit', 'unknown')
  await view.click('focus-reset'); assertFocus(view, data, 'all', 'all')
  await view.change('focus-platform', 'twitter'); await view.change('focus-outcome', 'unknown')
  assert.ok(view.byId('file-loading'), 'Focus must not retire the pending file read')
  read.resolve(buffer); await pending; await flush()
  assert.ok(view.byId('file-preview'), 'A still-owned replacement must reach preview after focus changes')
  assert.equal(view.text(view.byId('preview-filename')), 'replacement.json')
  assertFocus(view, data, 'twitter', 'unknown'); assert.deepEqual(history(view), original)
  await view.click('cancel-file')
  assert.equal(view.byId('file-preview'), undefined); assertFocus(view, data, 'twitter', 'unknown')
  const invalid = new File(['{untrusted invalid replacement}'], 'invalid.json', { type: 'application/json' })
  const rejected = await chooseFile(view, invalid); await rejected.pending; await flush()
  assert.ok(view.byId('file-error')); assertFocus(view, data, 'twitter', 'unknown')
  assert.deepEqual(history(view), original)
  await chooseFile(view, null); assertFocus(view, data, 'twitter', 'unknown')
  assert.equal(view.byId('file-error'), undefined)
  await exactReexport(view, originalText)
  const delayed = actualFile(page('partial'), 'cancelled-late.json'), late = deferred()
  Object.defineProperty(delayed, 'arrayBuffer', { value: () => late.promise })
  const cancelled = await chooseFile(view, delayed)
  await view.change('focus-outcome', 'failed'); await view.click('cancel-file')
  late.resolve(await actualFile(page('partial')).arrayBuffer()); await cancelled.pending; await flush()
  assert.equal(view.byId('file-preview'), undefined); assertFocus(view, data, 'twitter', 'failed')
  const stale = oldFocusHandlers(view)
  await accept(view, page('nonzero'), 'accepted-replacement.json')
  assertFocus(view, observations.nonzero, 'all', 'all')
  await view.change('focus-outcome', 'unknown')
  await invokeOld(stale)
  assertFocus(view, observations.nonzero, 'all', 'unknown')
  assert.equal(view.text(view.byId('accepted-filename')), 'accepted-replacement.json')
  await exactReexport(view, encoded(page('nonzero'))); noEffects(view, calls)
})

for (const cacheHandlers of [true, false]) test(`invalid values cannot change focus or retire current handlers (cached ${cacheHandlers})`, async t => {
  const { view, data, calls } = await liveDownloadAndReopen(t, 'full', { cacheHandlers })
  await view.change('focus-platform', 'twitter'); await view.change('focus-outcome', 'failed')
  const current = oldFocusHandlers(view), original = history(view)
  for (const value of ['', 'Twitter', 'unknown', null, false, 0, {}, ['reddit']]) {
    await current.platform({ target: { value } }); await flush()
    assertFocus(view, data, 'twitter', 'failed')
  }
  for (const value of ['', 'true', 'false', 'Succeeded', null, false, 0, {}, ['unknown']]) {
    await current.outcome({ target: { value } }); await flush()
    assertFocus(view, data, 'twitter', 'failed')
  }
  await current.outcome({ target: { value: 'unknown' } }); await flush()
  assertFocus(view, data, 'twitter', 'unknown')
  assert.deepEqual(history(view), original); noEffects(view, calls)
})

for (const cacheHandlers of [true, false]) for (const retirement of ['newer-focus', 'reset', 'clear', 'same-route', 'back-forward', 'unmount']) test(`retained focus handlers retire after ${retirement} (cached ${cacheHandlers})`, async t => {
  const { view, data, calls, unmount } = await liveDownloadAndReopen(t, 'full', { cacheHandlers })
  await view.change('focus-platform', 'twitter'); await view.change('focus-outcome', 'failed')
  const stale = oldFocusHandlers(view), downloads = view.downloads.length, model = renderedFileModel(view)
  if (retirement === 'newer-focus') await view.change('focus-outcome', 'unknown')
  else if (retirement === 'reset') {
    await view.click('focus-reset')
    await view.change('focus-outcome', 'unknown')
  } else if (retirement === 'clear') {
    await view.click('clear-file')
    assert.equal(view.byId('accepted-file'), undefined)
    await accept(view, page('full'))
    assertFocus(view, data, 'all', 'all')
    await view.change('focus-outcome', 'unknown')
  } else if (retirement === 'same-route') {
    await view.navigate('/activity-files?replacement=1')
    assert.equal(view.byId('accepted-file'), undefined)
    await accept(view, page('full')); assertFocus(view, data, 'all', 'all')
    await view.change('focus-outcome', 'unknown')
  } else if (retirement === 'back-forward') {
    await view.navigate('/runtime'); await view.back()
    assert.equal(view.router.currentRoute.value.path, '/activity-files')
    assert.equal(view.byId('accepted-file'), undefined)
    await accept(view, page('full')); assertFocus(view, data, 'all', 'all')
    await view.change('focus-outcome', 'unknown')
    await invokeOld(stale); assertFocus(view, data, 'all', 'unknown')
    await view.forward(); await view.back()
    assert.equal(view.byId('accepted-file'), undefined)
    await accept(view, page('full')); await view.change('focus-outcome', 'unknown')
  } else unmount()
  const beforeOldHandlers = model()
  await invokeOld(stale)
  assert.strictEqual(model(), beforeOldHandlers, 'Retired handlers must not mutate even their detached presentation model')
  if (retirement === 'unmount') {
    assert.equal(view.byId('accepted-file'), undefined)
    assert.equal(model()[0].accepted, null)
    assert.equal(model()[0].focus.platform, 'all'); assert.equal(model()[0].focus.outcome, 'all')
  }
  else assertFocus(view, data, retirement === 'newer-focus' ? 'twitter' : 'all', 'unknown')
  assert.equal(view.downloads.length, downloads)
  noEffects(view, calls)
})

test('local focus dependency path has no network or persistence capability', () => {
  // The renderer intercepts fetch and storage writes. This complementary source
  // check also covers storage reads and other network transports in the local
  // view/parser/projection dependency path, rather than claiming browser proof.
  for (const path of ['views/SavedActivityFilesView.vue', 'utils/savedActivityFiles.js', 'utils/boundedJson.js', 'utils/savedActivityReview.js']) {
    const source = readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB)\b|\/api\//, path)
  }
})
