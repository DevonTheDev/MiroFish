import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mountSavedActivity, flush, ok } from './helpers/saved-activity-view-fixture.js'
import { mountActivityFiles, chooseFile, waitFor } from './helpers/saved-activity-files-view-fixture.js'

const fixture = JSON.parse(execFileSync('python3', [
  fileURLToPath(new URL('./helpers/saved-activity-files-reader-fixture.py', import.meta.url)),
], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 }))

test('actual production saved reader and live export expose a local reopening entry', async t => {
  assert.equal(fixture.source_files_unchanged, true)
  assert.equal(fixture.no_application_startup, true)
  const data = fixture.observations.full
  const view = await mountSavedActivity({ initialPath: `/simulation/${data.simulation_id}/activity?limit=${data.limit}` })
  t.after(() => view.unmount())
  view.requests.calls.getSavedActivity[0].resolve(ok(data)); await flush()
  assert.ok(view.byId('results'), 'Actual production observation must pass the live view validator')
  await view.click('download')
  assert.equal(await view.downloads[0].blob.text(), JSON.stringify({ format_version: 1, ...data }, null, 2) + '\n')
  assert.ok(view.byId('open-activity-files'), 'The live saved activity page must expose reopening of its exported file')
})

const observations = fixture.observations
const page = name => ({ format_version: 1, ...observations[name] })
const event = () => ({ button: 0, preventDefault() {}, stopPropagation() {} })
const rowIds = view => view.all(node => String(node.props['data-testid'] ?? '').startsWith('action-row-'))
  .map(node => node.props['data-testid'].slice('action-row-'.length))

function livePath(data) {
  const query = new URLSearchParams({ offset: data.offset, limit: data.limit })
  for (const [key, value] of Object.entries(data.filters)) if (value !== null && value !== false) query.set(key, String(value))
  if (data.offset) query.set('revision', data.source_revision)
  return `/simulation/${data.simulation_id}/activity?${query}`
}

async function produceDownload(t, name, options = {}) {
  const data = observations[name], calls = []
  let local = false
  const api = new Proxy({}, { get: (_target, method) => (...args) => {
    assert.equal(local, false, `File review invoked backend/API method ${String(method)}`)
    assert.equal(method, 'getSavedActivity', 'Only the saved reader may provide the live export')
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
  t.after(() => view.unmount())
  await waitFor(() => view.byId('results'))
  assert.equal(calls.length, 1)
  await view.click('download')
  const downloaded = view.downloads.at(-1)
  assert.equal(await downloaded.blob.text(), JSON.stringify(page(name), null, 2) + '\n')
  assert.equal(downloaded.filename, `${data.simulation_id}-saved-activity-page-${data.offset}.json`)
  const file = new File([await downloaded.blob.arrayBuffer()], `<img onerror=alert(1)> Café 雪 ${name}.json`, { type: 'application/json' })
  assert.equal(await file.text(), await downloaded.blob.text())
  const link = view.byId('open-activity-files')
  assert.ok(link, 'The current activity export needs a discoverable local reopening entry')
  assert.equal(link.props.href, '/activity-files')
  local = true
  await view.click('open-activity-files')
  await waitFor(() => view.router.currentRoute.value.path === '/activity-files')
  assert.equal(calls[0].args[2].aborted, true)
  assert.ok(view.revokedUrls.includes(downloaded.url), 'Leaving the live view retires its download')
  return { view, data, file, downloaded, calls }
}

async function readFile(view, file) {
  assert.ok(file instanceof File, 'Workflow compatibility requires actual File bytes')
  const { pending } = await chooseFile(view, file)
  await pending; await flush()
  assert.equal(Boolean(view.byId('file-error')), false, 'A current production-reader/live-view export must be accepted')
  assert.ok(view.byId('file-preview'))
}

function localOnly(view, calls) {
  assert.equal(view.router.currentRoute.value.path, '/activity-files')
  assert.deepEqual(view.router.currentRoute.value.query, {})
  if (calls) assert.equal(calls.length, 1, 'The local route must not request backend data')
  assert.deepEqual(view.networkCalls, [])
  assert.deepEqual(view.storageWrites, [])
  assert.equal(view.all(node => node.props.innerHTML || ['script', 'img', 'iframe'].includes(node.type)).length, 0)
  for (const id of ['next', 'previous', 'first', 'refresh', 'apply', 'activity-form', 'activity-rounds-entry']) {
    assert.equal(view.byId(id), undefined, `Local evidence must not expose remote control ${id}`)
  }
  assert.equal(view.all(node => node.type === 'a' && /\/simulation\//.test(node.props.href ?? '')).length, 0,
    'An imported simulation ID is not authenticated against any current simulation')
}

function metadata(view, prefix, data) {
  for (const [field, value] of [
    ['simulation', data.simulation_id], ['observed', data.observed_at], ['revision', data.source_revision],
    ['returned', data.returned_count], ['offset', data.offset], ['limit', data.limit],
  ]) {
    assert.ok(view.byId(`${prefix}-${field}`), `Missing captured-page field ${prefix}-${field}`)
    assert.ok(view.text(view.byId(`${prefix}-${field}`)).includes(String(value)), `Changed recorded ${field}`)
  }
  if (data.matched_count !== null) assert.ok(view.text(view.byId(`${prefix}-matched`)).includes(String(data.matched_count)))
  assert.ok(view.byId(`${prefix}-availability`))
  assert.ok(view.byId(`${prefix}-has-more`))
  assert.ok(view.byId(`${prefix}-filters`))
  assert.ok(view.text(view.byId(`${prefix}-context`)).includes(data.context.created_at))
}

async function exactDownload(view, expected, originalText = JSON.stringify(expected, null, 2) + '\n') {
  const before = view.downloads.length
  await view.click('download-file')
  assert.equal(view.downloads.length, before + 1)
  const download = view.downloads.at(-1)
  assert.equal(await download.blob.text(), originalText, 'Local export must retain the complete accepted page, exact strings, and record order')
  assert.deepEqual(JSON.parse(await download.blob.text()), expected)
  return download
}

for (const name of Object.keys(observations)) for (const locale of ['en', 'zh']) {
  test(`actual production ${name} page exports and reopens byte-exactly in ${locale}`, async t => {
    const { view, data, file, downloaded, calls } = await produceDownload(t, name, { locale })
    const unchanged = JSON.stringify(data)
    assert.equal(view.byId('accepted-file'), undefined)
    await readFile(view, file)
    assert.ok(view.text(view.byId('preview-filename')).includes(file.name))
    metadata(view, 'preview', data)
    assert.equal(view.byId('accepted-file'), undefined, 'Reading cannot silently accept a file')
    localOnly(view, calls)
    await view.click('open-file')
    assert.equal(view.byId('file-preview'), undefined)
    assert.ok(view.byId('accepted-file'))
    assert.ok(view.text(view.byId('accepted-filename')).includes(file.name))
    metadata(view, 'accepted', data)
    assert.deepEqual(rowIds(view), data.actions.map(row => row.record_id))
    for (const row of data.actions) {
      assert.equal(view.text(view.byId(`details-${row.record_id}`)), row.details_json,
        'Original JSON is literal saved text, without Number conversion or parse/stringify')
      const rowText = view.text(view.byId(`action-row-${row.record_id}`))
      assert.ok(rowText.includes(row.agent_id))
      assert.ok(rowText.includes(row.round_num))
      if (row.agent_name !== null) assert.ok(rowText.includes(row.agent_name))
      if (row.match_preview !== null) assert.equal(view.text(view.byId(`match-preview-${row.record_id}`)), row.match_preview)
    }
    if (locale === 'en') {
      assert.match(view.text(), /unverified/i)
      assert.match(view.text(), /historical/i)
      assert.match(view.text(), /captured.*page|one.*page/i)
      assert.match(view.text(view.byId('accepted-has-more')), data.has_more ? /yes|reported.*later/i : /no/i)
    }
    assert.doesNotMatch(view.text(), /savedActivityFiles\.|savedActivity\.|comparison\./)
    await exactDownload(view, page(name), await downloaded.blob.text())
    assert.equal(JSON.stringify(data), unchanged)
    localOnly(view, calls)
    assert.deepEqual(view.warnings, [])
    const lastUrl = view.downloads.at(-1).url
    await view.click('clear-file')
    assert.equal(view.byId('accepted-file'), undefined)
    assert.equal(rowIds(view).length, 0)
    assert.ok(view.revokedUrls.includes(lastUrl))
    assert.equal(view.blobs.size, 0)
    localOnly(view, calls)
  })
}

test('production Unicode search and source coverage remain recorded facts, not JS recomputations', () => {
  const { filtered, full, nonzero, beyond, partial, empty, unavailable } = observations
  assert.equal(filtered.filters.q, 'STRASSE')
  assert.equal(filtered.filters.case_sensitive, false)
  assert.equal(filtered.actions[0].match_preview, 'Straße Café 雪 🐟')
  assert.equal(filtered.actions[0].match_preview.toLowerCase().includes(filtered.filters.q.toLowerCase()), false,
    'A JavaScript lowercase replay would incorrectly reject this Python casefold match')
  assert.deepEqual(filtered.actions.map(row => row.record_id), ['twitter:2', 'twitter:3'])
  assert.equal(filtered.actions[0].details_json, filtered.actions[1].details_json,
    'Repeated physical attempts remain separate records')
  assert.equal(full.actions[0].agent_id, '9'.repeat(80))
  assert.equal(full.actions[0].round_num, '8'.repeat(79))
  assert.equal(full.actions[0].agent_name, 'Lone high \ud800 and low \udfff')
  assert.ok(full.actions[0].details_json.includes(`"agent_id":${'9'.repeat(80)}`))
  assert.ok(full.actions[0].details_json.includes(`"round":${'8'.repeat(79)}`))
  assert.ok(full.actions[0].details_json.includes('\\ud800'))
  assert.equal(nonzero.offset, 1); assert.equal(nonzero.returned_count, 1); assert.equal(nonzero.matched_count, 5); assert.equal(nonzero.has_more, true)
  assert.equal(nonzero.availability, 'complete', 'Complete coverage does not mean this file contains the whole run')
  assert.equal(beyond.offset, 50); assert.equal(beyond.returned_count, 0); assert.equal(beyond.matched_count, 5)
  assert.equal(empty.matched_count, 0); assert.equal(empty.availability, 'complete')
  assert.equal(unavailable.matched_count, null); assert.equal(unavailable.availability, 'unavailable')
  assert.equal(partial.availability, 'partial')
  assert.ok(partial.warnings.some(warning => warning.code === 'invalid_records'))
  assert.ok(partial.warnings.some(warning => warning.code === 'platform_log_missing'))
})

for (const cacheHandlers of [false, true]) {
  test(`retained workflow controls cannot act on later native-file evidence (cached=${cacheHandlers})`, async t => {
    const { view, file, calls } = await produceDownload(t, 'full', { cacheHandlers })
    await readFile(view, file)
    const staleOpen = view.byId('open-file').props.onClick
    const staleCancel = view.byId('cancel-file').props.onClick
    await view.click('cancel-file')
    await readFile(view, file)
    staleOpen(event()); staleCancel(event()); await flush()
    assert.ok(view.byId('file-preview'), 'Old cancel must not cancel a newly staged file')
    assert.equal(view.byId('accepted-file'), undefined, 'Old Open must not open a newly staged file')
    await view.click('open-file')
    const staleClear = view.byId('clear-file').props.onClick
    const staleDownload = view.byId('download-file').props.onClick
    const original = await exactDownload(view, page('full'))
    const replacement = new File([JSON.stringify(page('filtered'), null, 2) + '\n'], 'replacement.json', { type: 'application/json' })
    await readFile(view, replacement)
    assert.ok(view.text(view.byId('accepted-filename')).includes(file.name))
    assert.deepEqual(rowIds(view), observations.full.actions.map(row => row.record_id))
    await view.click('open-file')
    assert.ok(view.revokedUrls.includes(original.url))
    const before = view.downloads.length
    staleDownload(event()); staleClear(event()); await flush()
    assert.equal(view.downloads.length, before)
    assert.ok(view.byId('accepted-file'))
    assert.deepEqual(rowIds(view), observations.filtered.actions.map(row => row.record_id))
    const bad = new File(['{"format_version":1,"format_version":2}'], 'private-invalid.json')
    const { pending } = await chooseFile(view, bad); await pending; await flush()
    assert.ok(view.byId('file-error'))
    assert.ok(view.text(view.byId('accepted-filename')).includes('replacement.json'))
    assert.deepEqual(rowIds(view), observations.filtered.actions.map(row => row.record_id))
    await exactDownload(view, page('filtered'))
    await view.click('clear-file')
    staleDownload(event()); staleClear(event()); staleOpen(event()); await flush()
    assert.equal(view.byId('accepted-file'), undefined)
    assert.equal(view.byId('file-preview'), undefined)
    localOnly(view, calls)
  })
}

function delayedFile(source) {
  const delayed = new File([source], 'delayed-original.json', { type: 'application/json' })
  let resolve, reject
  const ready = delayed.arrayBuffer()
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  Object.defineProperty(delayed, 'arrayBuffer', { value: () => promise })
  return { file: delayed, resolve: async () => resolve(await ready), reject }
}

for (const outcome of ['resolve', 'reject']) test(`late native file ${outcome} after cancel cannot alter accepted evidence`, async t => {
  const { view, file, calls } = await produceDownload(t, 'nonzero')
  await readFile(view, file); await view.click('open-file')
  const delayed = delayedFile(await file.arrayBuffer())
  const { pending } = await chooseFile(view, delayed.file)
  assert.ok(view.byId('file-loading'))
  await view.click('cancel-file')
  const replacement = new File([JSON.stringify(page('empty'))], 'empty-current.json')
  await readFile(view, replacement); await view.click('open-file')
  if (outcome === 'resolve') await delayed.resolve()
  else delayed.reject(new Error('PRIVATE obsolete read error'))
  await pending; await flush()
  assert.equal(view.byId('file-error'), undefined)
  assert.equal(view.byId('file-preview'), undefined)
  assert.ok(view.text(view.byId('accepted-filename')).includes('empty-current.json'))
  assert.deepEqual(rowIds(view), [])
  await exactDownload(view, page('empty'))
  localOnly(view, calls)
})

test('route departure and unmount retire native reads, old controls, and accepted download URLs', async t => {
  const { view, file } = await produceDownload(t, 'full')
  await readFile(view, file); await view.click('open-file')
  const staleDownload = view.byId('download-file').props.onClick
  const staleClear = view.byId('clear-file').props.onClick
  const download = await exactDownload(view, page('full'))
  const delayed = delayedFile(await file.arrayBuffer())
  const { pending } = await chooseFile(view, delayed.file)
  await view.navigate('/interview-files')
  assert.ok(view.revokedUrls.includes(download.url))
  await delayed.resolve(); await pending; await flush()
  staleDownload(event()); staleClear(event()); await flush()
  assert.equal(view.router.currentRoute.value.path, '/interview-files')
  assert.equal(view.blobs.size, 0)
  await view.navigate('/activity-files')
  assert.equal(view.byId('accepted-file'), undefined)
  assert.equal(view.byId('file-preview'), undefined)
  assert.equal(view.byId('file-error'), undefined)
  await readFile(view, file); await view.click('open-file')
  const finalDownload = await exactDownload(view, page('full'))
  const late = delayedFile(await file.arrayBuffer())
  const task = await chooseFile(view, late.file)
  view.unmount()
  late.reject(new Error('PRIVATE after unmount'))
  await task.pending; await flush()
  assert.ok(view.revokedUrls.includes(finalDownload.url))
  assert.equal(view.root.children.length, 0)
  assert.equal(view.blobs.size, 0)
  assert.deepEqual(view.networkCalls, []); assert.deepEqual(view.storageWrites, [])
})

for (const failDownload of ['create', 'append', 'click']) test(`local download ${failDownload} failure retains the accepted production page`, async t => {
  const view = await mountActivityFiles({ failDownload })
  t.after(() => view.unmount())
  await readFile(view, new File([JSON.stringify(page('filtered'))], 'accepted.json'))
  await view.click('open-file')
  await view.click('download-file')
  assert.ok(view.byId('accepted-file'))
  assert.deepEqual(rowIds(view), observations.filtered.actions.map(row => row.record_id))
  assert.equal(view.downloads.length, 0)
  assert.equal(view.blobs.size, 0)
  assert.doesNotMatch(view.text(), /private .* failure/i)
  for (const calls of Object.values(view.requests.calls)) assert.equal(calls.length, 0)
  localOnly(view)
})

test('local file route and parser have no API, runtime, model, or persistence dependencies', () => {
  for (const path of ['../src/views/SavedActivityFilesView.vue', '../src/utils/savedActivityFiles.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*(?:\/api\/|axios|simulation_runner|simulation_manager|openai|anthropic)/i)
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b/)
    assert.doesNotMatch(source, /v-html|innerHTML/)
  }
})
