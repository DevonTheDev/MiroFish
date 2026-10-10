// Real HTTP responses become retained-side native File bytes, then a fresh view.
// Flask or the explicitly labelled pure-reader loopback harness owns the server.
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import axios from 'axios'
import http from 'node:http'
import https from 'node:https'

const [baseURL, contentMode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['file', 'metadata', 'legacy', 'empty', 'unavailable'].includes(contentMode))
const source = process.env.MIRO_REPORT_FILES_SOURCE_ROOT
  ? pathToFileURL(resolve(process.env.MIRO_REPORT_FILES_SOURCE_ROOT, 'frontend') + '/') : new URL('../../', import.meta.url)
const { mountReportLibrary, reportLibraryApi, waitFor, flush } = await import(new URL('tests/helpers/report-library-view-fixture.js', source))
const { createSavedReportFile, readSavedReportFile } = await import(new URL('src/utils/savedReportFiles.js', source))
const index = readFileSync(new URL('src/api/index.js', source), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const clientLogs = []
const clientConsole = { ...console, error: (...args) => clientLogs.push({ filePhase, args }) }
const service = new Function('axios', 'i18n', 'buildEnvironment', 'console', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, clientConsole,
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const requests = [], replies = []
let filePhase = false, fileApiAttempts = 0
service.interceptors.request.use(config => {
  if (filePhase) fileApiAttempts++
  assert.equal(filePhase, false, 'File review attempted an Axios request')
  requests.push(config)
  assert.equal(config.method, 'get')
  assert.ok(config.url === '/api/report/library/records' || ['report_old', 'report_new'].some(id => config.url === '/api/report/library/records/' + id))
  return config
})
service.interceptors.response.use(body => { replies.push(structuredClone(body)); return body })
const canonicalKeys = ['report_id', 'simulation_id', 'title', 'summary_preview', 'requirement_preview', 'status', 'created_at', 'completed_at', 'source', 'metadata_revision', 'observed_at', 'content_available', 'content_source', 'markdown_content', 'content_bytes', 'content_revision', 'content_error']
const literal = node => (node.type === '#comment' ? '' : node.text ?? '') + (node.children ?? []).map(literal).join('')
const event = () => ({ button: 0, stopPropagation() {}, preventDefault() {} })
const exported = []

async function observationDownload(host, control, observed, filename) {
  const before = host.downloads.length
  await host.click(control)
  assert.equal(host.downloads.length, before + 1, 'The selected observation control must emit exactly one file')
  const download = host.downloads.at(-1)
  assert.ok(download.blob instanceof Blob, 'Reopen the actual native Blob emitted by the production component')
  assert.equal(download.blob.type, 'application/json;charset=utf-8')
  const bytes = Buffer.from(await download.blob.arrayBuffer())
  const envelope = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(Object.keys(envelope).sort(), ['format', 'observation', 'version'])
  assert.equal(envelope.format, 'mirofish-saved-report-observation')
  assert.equal(envelope.version, 1)
  assert.equal(canonicalKeys.length, 17)
  assert.deepEqual(Object.keys(envelope.observation).sort(), [...canonicalKeys].sort())
  assert.deepEqual(envelope.observation, observed, 'The exporter changed the independently captured observation')
  assert.deepEqual(bytes, Buffer.from(createSavedReportFile(observed)), 'Export must use the complete production observation format')
  assert.ok(bytes.toString('utf8').endsWith('\n'))
  assert.equal(download.filename, filename)
  const file = new File([download.blob], `<img src=x> Café 雪 ${filename}`, { type: 'application/json' })
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes, 'Native File construction must retain the emitted Blob bytes')
  const reopened = await readSavedReportFile(file)
  assert.ok(Object.isFrozen(reopened))
  assert.deepEqual(Object.keys(reopened).sort(), [...canonicalKeys].sort())
  for (const key of canonicalKeys) assert.equal(reopened[key], observed[key], `Reopened canonical field ${key} changed`)
  if (observed.content_available) assert.deepEqual(Buffer.from(reopened.markdown_content), Buffer.from(observed.markdown_content))
  return { observation: observed, bytes, envelope, filename: download.filename, file }
}
function sideFilename(observation, side) {
  return `${observation.report_id}-${side}-${observation.metadata_revision.slice(0, 12)}-${observation.content_revision?.slice(0, 12) ?? 'unavailable'}.observation.json`
}

const live = await mountReportLibrary({ api: reportLibraryApi(service), initialPath: '/reports', locale: 'en' })
try {
  await waitFor(() => live.byId('open-report_old'))
  const captures = []
  for (const [id, side] of [['report_old', 'left'], ['report_new', 'right']]) {
    await live.click('open-' + id)
    await waitFor(() => live.byId('reader') && !live.byId('loading') && !live.byId('detail-loading') && replies.some(reply => reply.data.report_id === id))
    const observed = replies.filter(reply => reply.data.report_id === id).at(-1).data
    assert.ok(live.byId('download-observation'), 'Published saved report reader lacks the observation JSON export needed to reopen reports')
    if (id === 'report_old') {
      assert.equal(observed.source, contentMode === 'legacy' ? 'legacy' : 'modern')
      assert.equal(observed.content_available, contentMode !== 'unavailable')
      if (observed.content_available) assert.equal(observed.markdown_content, contentMode === 'empty' ? '' : '\ufeff# Earlier report\r\n\r\nCafé 雪 🐟 <script>literal</script>\rCR\nLF\r\n')
      if (contentMode === 'metadata') assert.equal(observed.content_source, 'metadata')
      if (contentMode === 'legacy') assert.equal(observed.content_source, 'legacy_markdown')
    }
    await live.click('capture-' + side)
    captures.push({ side, observation: observed })
    assert.equal(live.byId('open-report-files').props.href, '/report-files')
  }
  assert.notEqual(captures[0].observation.report_id, captures[1].observation.report_id)
  assert.equal(live.downloads.length, 0, 'This workflow must defer JSON exports until both live captures outlast their readers')
  await live.click('close-reader')
  await waitFor(() => !live.byId('reader') && !live.byId('detail-loading'))
  assert.ok(live.byId('download-observation').props.disabled)
  const beforeSideExports = requests.length
  for (const { side, observation } of captures) {
    assert.ok(live.byId(`comparison-${side}-download-json`), 'A retained capture must export JSON after reader replacement and closure')
    exported.push(await observationDownload(live, `comparison-${side}-download-json`, observation, sideFilename(observation, side)))
  }
  assert.equal(requests.length, beforeSideExports, 'Exporting retained sides must not read the backend again')
  assert.ok(requests.length >= 3, 'The live catalogue and both explicit detail reads must run')
} finally {
  live.unmount()
  await flush()
}
const liveRequestCount = requests.length
filePhase = true
const forbiddenGlobalCalls = []
const denyGlobal = name => (...args) => { forbiddenGlobalCalls.push({ name, args }); throw new Error('Local file review attempted forbidden ' + name) }
for (const transport of [http, https]) for (const name of ['request', 'get']) transport[name] = denyGlobal(name)
globalThis.fetch = denyGlobal('fetch')
globalThis.WebSocket = class { constructor(...args) { denyGlobal('WebSocket')(...args) } }
globalThis.localStorage = globalThis.sessionStorage = { getItem: () => null, setItem: denyGlobal('storage.setItem'), removeItem: denyGlobal('storage.removeItem'), clear: denyGlobal('storage.clear') }
globalThis.indexedDB = { open: denyGlobal('indexedDB.open') }
service.defaults.adapter = () => { throw new Error('Backend disabled during local file review') }
const { mountReportFiles, chooseFile } = await import(new URL('tests/helpers/saved-report-files-view-fixture.js', source))
const blockedApi = []
const api = new Proxy({}, { get: (_target, name) => (...args) => { blockedApi.push({ name, args }); throw new Error('Every API/model/runtime operation is forbidden in file view') } })
const view = await mountReportFiles({ api, initialPath: '/report-files', locale: 'en' })
const [first, second] = exported

async function preview(file) {
  assert.ok(file instanceof File)
  const { pending, target } = await chooseFile(view, file)
  assert.equal(target.value, '', 'Reset permits native same-file reselection')
  await pending; await flush()
  assert.equal(view.byId('file-error'), undefined)
  assert.ok(view.byId('file-preview'))
}
async function open(file) { await preview(file); await view.click('open-file') }
function localOnly() {
  assert.equal(fileApiAttempts, 0)
  for (const entry of clientLogs) {
    assert.equal(entry.filePhase, false, 'File review caused client error logging')
    assert.equal(entry.args[1]?.code, 'ERR_CANCELED', 'Only an explicitly retired live request may log cancellation')
  }
  assert.deepEqual(blockedApi, [])
  assert.equal(requests.length, liveRequestCount)
  assert.deepEqual(forbiddenGlobalCalls, [])
  assert.deepEqual(view.networkCalls, [])
  assert.deepEqual(view.storageWrites, [])
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML') || ['script', 'img', 'iframe'].includes(node.type)).length, 0)
  assert.equal(view.all(node => node.type === 'a' && /\/simulation\//.test(node.props.href ?? '')).length, 0)
  assert.equal(view.byId('refresh'), undefined)
  assert.equal(view.byId('report-library-form'), undefined)
}
async function jsonDownload(expected) {
  const downloaded = await observationDownload(view, 'download-file', expected.observation, `${expected.observation.report_id}.observation.json`)
  assert.deepEqual(downloaded.bytes, expected.bytes,
    'Reopened JSON must preserve every canonical field and its exact original bytes')
  return downloaded
}
async function sideJsonDownload(side, expected) {
  const downloaded = await observationDownload(view, `comparison-${side}-download-json`, expected.observation, sideFilename(expected.observation, side))
  assert.deepEqual(downloaded.bytes, expected.bytes,
    'Retained-side re-export must preserve the original file after its parent reader changes or closes')
  localOnly()
  return downloaded
}
function readerInstance() {
  const seen = new Set()
  function visit(vnode) {
    if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return null
    seen.add(vnode)
    if (vnode.component?.type.__name === 'SavedReportReader') return vnode.component
    const nested = vnode.component && visit(vnode.component.subTree)
    if (nested) return nested
    for (const child of Array.isArray(vnode.children) ? vnode.children : []) { const found = visit(child); if (found) return found }
    return null
  }
  const result = visit(view.root._vnode)
  assert.ok(result, 'The workflow must exercise the real SavedReportReader instance')
  return result
}
function verifyBody(record) {
  const observation = record.observation
  const component = readerInstance()
  const originalReference = component.props.source
  assert.equal(component.props.isCurrent(originalReference), true)
  assert.equal(component.props.isCurrent({ ...originalReference }), false,
    'Reader ownership must reject copied observations even when ID and metadata match')
  assert.deepEqual(JSON.parse(JSON.stringify(originalReference)), observation)
  if (observation.content_available) {
    assert.equal(literal(view.byId('markdown')), observation.markdown_content)
    assert.equal(observation.content_bytes, Buffer.byteLength(observation.markdown_content))
    assert.equal(observation.content_revision, createHash('sha256').update(Buffer.from(observation.markdown_content)).digest('hex'))
  } else {
    assert.equal(view.byId('markdown'), undefined)
    assert.ok(view.byId('report-find').props.disabled)
    assert.ok(!view.byId('download-markdown') || view.byId('download-markdown').props.disabled)
  }
  return { component, originalReference }
}
try {
  assert.equal(view.byId('accepted-file'), undefined)
  await preview(first.file)
  assert.equal(view.byId('accepted-file'), undefined, 'File read must require explicit Open')
  assert.ok(view.text(view.byId('preview-filename')).includes(first.file.name))
  assert.ok(view.text(view.byId('preview-report-id')).includes(first.observation.report_id))
  assert.ok(view.text(view.byId('preview-observed-at')).includes(first.observation.observed_at))
  await view.click('open-file')
  const original = verifyBody(first)
  assert.ok(view.text(view.byId('accepted-observed-at')).includes(first.observation.observed_at))
  assert.match(view.text(), /unverified/i)
  await jsonDownload(first)
  if (first.observation.content_available) {
    await view.click('download-markdown')
    assert.deepEqual(Buffer.from(await view.downloads.at(-1).blob.arrayBuffer()), Buffer.from(first.observation.markdown_content))
  }
  await view.click('capture-left')
  const staleCapture = view.byId('capture-right').props.onClick
  const staleDownload = view.byId('download-file').props.onClick
  const staleClear = view.byId('clear-file').props.onClick
  // File bytes stay unchanged while their native asynchronous read is deferred.
  const delayed = new File([second.bytes], second.file.name, { type: 'application/json' })
  let resolveRead
  delayed.arrayBuffer = () => new Promise(resolve => { resolveRead = resolve })
  const { pending } = await chooseFile(view, delayed)
  assert.ok(view.byId('file-loading'))
  assert.equal(readerInstance().props.source, original.originalReference)
  if (first.observation.content_available && first.observation.markdown_content) {
    await view.input('report-find', '<SCRIPT>literal</SCRIPT>')
    assert.deepEqual(view.all(node => node.type === 'mark').map(literal), ['<script>literal</script>'])
    await view.change('report-find-case', true)
    assert.match(view.text(view.byId('report-find-status')), /No matches/)
    await view.input('report-find', 'Café 雪 🐟')
    await view.click('report-find-next'); await view.click('report-find-previous')
    assert.deepEqual(view.all(node => node.type === 'mark').map(literal), ['Café 雪 🐟'])
    await view.input('report-find', '\n\n')
    assert.deepEqual(view.all(node => node.type === 'mark').map(literal), ['\r\n\r\n'])
    assert.equal(literal(view.byId('markdown')), first.observation.markdown_content)
  }
  const staleFind = view.byId('report-find').props.onInput
  const staleCase = view.byId('report-find-case').props.onChange
  view.i18n.global.locale.value = 'zh'; await flush()
  resolveRead(await second.file.arrayBuffer()); await pending; await flush()
  assert.ok(view.byId('file-preview'), 'Search/case/locale changes must not retire a replacement read')
  assert.equal(readerInstance().props.source, original.originalReference)
  view.i18n.global.locale.value = 'en'; await flush()
  const beforeRetired = view.downloads.length
  // Invoke before Vue propagates replacement props, then once more after flush.
  view.byId('open-file').props.onClick(event())
  staleCapture(event()); staleDownload(event()); staleClear(event())
  staleFind({ target: { value: 'retired phrase' } }); staleCase({ target: { checked: true } })
  await flush()
  assert.equal(view.downloads.length, beforeRetired)
  assert.equal(original.component.props.isCurrent(original.originalReference), false)
  verifyBody(second)
  assert.equal(view.byId('report-find').props.value, '')
  assert.equal(view.byId('report-find-case').props.checked, false)
  assert.equal(view.byId('comparison-right-text'), undefined)
  await view.click('capture-right')
  assert.equal(view.byId('comparison-status').props['data-status'], contentMode === 'unavailable' ? 'unavailable' : 'different')
  for (const [side, record] of [['left', first], ['right', second]]) {
    const rendered = view.text(view.byId('comparison-' + side))
    for (const value of [record.observation.report_id, record.observation.observed_at, record.observation.metadata_revision]) assert.ok(rendered.includes(value))
    if (record.observation.content_available) {
      assert.equal(literal(view.byId(`comparison-${side}-text`)), record.observation.markdown_content)
      await view.click(`comparison-${side}-download`)
      assert.deepEqual(Buffer.from(await view.downloads.at(-1).blob.arrayBuffer()), Buffer.from(record.observation.markdown_content))
    } else assert.ok(view.byId(`comparison-${side}-download`).props.disabled)
    await sideJsonDownload(side, record)
  }
  await jsonDownload(second)
  // Returning to the original exact File must make a new owner, even with equal ID.
  await open(first.file)
  const reopened = verifyBody(first)
  assert.notEqual(reopened.originalReference, original.originalReference)
  assert.equal(reopened.component.props.isCurrent(original.originalReference), false)
  const downloadsBeforeABA = view.downloads.length
  staleCapture(event()); staleDownload(event()); staleClear(event()); await flush()
  assert.equal(view.downloads.length, downloadsBeforeABA)
  verifyBody(first)
  assert.equal(literal(view.byId('comparison-right-text')), second.observation.markdown_content)
  await sideJsonDownload('left', first)
  await sideJsonDownload('right', second)
  // Cancelled and invalid replacements preserve the accepted observation object.
  await preview(second.file); await view.click('cancel-file')
  assert.equal(readerInstance().props.source, reopened.originalReference)
  const invalid = new File(['{broken PRIVATE_PARSER_DETAIL'], 'bad.json', { type: 'application/json' })
  const invalidRead = await chooseFile(view, invalid); await invalidRead.pending; await flush()
  assert.ok(view.byId('file-error'))
  assert.doesNotMatch(view.text(), /PRIVATE_PARSER_DETAIL|SyntaxError/)
  assert.equal(readerInstance().props.source, reopened.originalReference)
  // Older success and rejection must not replace or erase a newer preview.
  for (const reject of [false, true]) {
    const late = new File([first.bytes], first.file.name, { type: 'application/json' })
    let finish
    late.arrayBuffer = () => new Promise((resolve, fail) => { finish = reject ? fail : resolve })
    const lateRead = await chooseFile(view, late)
    await preview(second.file)
    const newerOpen = view.byId('open-file').props.onClick
    const newerCancel = view.byId('cancel-file').props.onClick
    finish(reject ? new Error('PRIVATE_RETIRED_READ') : await first.file.arrayBuffer())
    await lateRead.pending; await flush()
    assert.ok(view.text(view.byId('preview-report-id')).includes(second.observation.report_id))
    assert.equal(view.byId('file-error'), undefined)
    await view.click('cancel-file')
    await preview(second.file)
    newerOpen(event()); newerCancel(event()); await flush()
    assert.ok(view.byId('file-preview'), 'Retired preview callbacks must not affect a later selection')
    assert.equal(readerInstance().props.source, reopened.originalReference)
    await view.click('cancel-file')
  }
  // A user-edited local JSON snapshot can keep the same report ID while its
  // body changes. Its hashes are recorded values, never proof of authorship.
  const editedObservation = { ...first.envelope.observation,
    observed_at: `${first.observation.observed_at} (local edited observation)`,
    content_available: true, content_source: second.observation.content_source,
    markdown_content: second.observation.markdown_content,
    content_bytes: second.observation.content_bytes,
    content_revision: second.observation.content_revision, content_error: null,
  }
  const editedBytes = Buffer.from(createSavedReportFile(editedObservation))
  const edited = { observation: editedObservation, bytes: editedBytes,
    file: new File([editedBytes], 'same-id-edited.json', { type: 'application/json' }) }
  const retiringFind = view.byId('report-find').props.onInput
  const retiringCapture = view.byId('capture-right').props.onClick
  await preview(edited.file)
  view.byId('open-file').props.onClick(event())
  retiringCapture(event()); retiringFind({ target: { value: 'retired same-ID text' } }); await flush()
  const editedOwner = verifyBody(edited)
  assert.equal(editedOwner.originalReference.report_id, reopened.originalReference.report_id)
  assert.equal(editedOwner.originalReference.metadata_revision, reopened.originalReference.metadata_revision)
  assert.notEqual(editedOwner.originalReference.markdown_content, reopened.originalReference.markdown_content)
  assert.equal(editedOwner.component.props.isCurrent(reopened.originalReference), false)
  assert.equal(view.byId('report-find').props.value, '')
  assert.ok(view.text(view.byId('comparison-right')).includes(second.observation.report_id))
  await sideJsonDownload('left', first)
  await sideJsonDownload('right', second)
  await view.click('capture-right')
  assert.ok(view.text(view.byId('comparison-right')).includes(first.observation.report_id))
  assert.equal(view.byId('comparison-status').props['data-status'], contentMode === 'unavailable' ? 'unavailable' : 'different')
  await sideJsonDownload('left', first)
  await sideJsonDownload('right', edited)
  await jsonDownload(edited)
  await view.click('clear-file')
  assert.equal(view.byId('accepted-file'), undefined)
  assert.equal(view.byId('report-find'), undefined)
  assert.ok(!view.byId('download-file') || view.byId('download-file').props.disabled)
  assert.ok(view.byId('comparison-status'), 'Clearing current file must retain independent pinned captures')
  assert.equal(literal(view.byId('comparison-right-text')), second.observation.markdown_content)
  await sideJsonDownload('left', first)
  await sideJsonDownload('right', edited)
  await view.click('comparison-swap')
  assert.equal(literal(view.byId('comparison-left-text')), second.observation.markdown_content)
  await sideJsonDownload('left', edited)
  await sideJsonDownload('right', first)
  await view.click('comparison-clear')
  assert.equal(view.byId('comparison-left-text'), undefined)
  await view.timers.advance(1000)
  assert.equal(view.blobs.size, 0)
  localOnly()
  assert.deepEqual(view.warnings, [])
  await view.navigate('/'); await view.navigate('/report-files')
  assert.equal(view.byId('accepted-file'), undefined)
  assert.equal(view.byId('comparison-left-text'), undefined)
  localOnly()
  console.log('actual Axios/Vue report file round trip passed: ' + contentMode)
  console.log(JSON.stringify({ mode: contentMode, native_file_bytes: true, exact_observation_json_and_markdown: true, retained_live_side_json_after_reader_close: true, retained_imported_side_json_after_replacement_and_close: true, canonical_observation_fields: canonicalKeys.length, source_reference_ownership: true, pending_read_search_and_language: true, stale_read_success_and_rejection: true, same_id_changed_body_comparison: true, file_api_attempts: fileApiAttempts, file_network_calls: view.networkCalls.length + forbiddenGlobalCalls.length, file_persistence_writes: view.storageWrites.length, native_browser_rendering: false }))
} finally {
  view.unmount()
}
