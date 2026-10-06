import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountCaptureFiles, flush } from './helpers/run-capture-files-view-fixture.js'
import { capture, LEFT, RIGHT, THIRD, revision } from './fixtures/run-captures-data.js'
import { compareRunCaptureFiles, RUN_CAPTURE_FILE_MAX_BYTES } from '../src/utils/runCaptureFiles.js'

const saved = (id = LEFT, count = 3, label = 'Saved capture') => {
  const value = capture(id, 'sim_A', count, label)
  value.observation.summary.metrics.rounds_with_actions = Math.min(2, count)
  value.observation.summary.metrics.platforms.twitter.active_agents = Math.min(2, count)
  value.observation.summary.metrics.action_types = count ? [{ action_type: 'POST', count }] : []
  return value
}
const pair = (left = saved(), right = saved(RIGHT, 0)) => compareRunCaptureFiles(left, right, '2026-10-03T12:02:00Z')
function file(value, name = 'saved.json', extra = {}) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  return { name, size: bytes.byteLength, type: 'application/json', arrayBuffer: async () => bytes.buffer, ...extra }
}
async function choose(v, files) {
  const target = { files: files == null ? [] : Array.isArray(files) ? files : [files], value: 'C:\\fakepath\\chosen.json' }
  const pending = v.byId('capture-file').props.onChange({ target }); await flush()
  assert.equal(target.value, '')
  return { pending }
}
async function open(v, value, name) { const { pending } = await choose(v, file(value, name)); await pending; await flush() }
async function accept(v, value, side = 'left', name) { await open(v, value, name); await v.click('use-' + side) }
const calls = v => Object.fromEntries(Object.entries(v.requests.calls).map(([key, items]) => [key, items.length]))
function noEffects(v) {
  assert.ok(Object.values(calls(v)).every(count => count === 0), JSON.stringify(calls(v)))
  assert.deepEqual(v.storageWrites, []); assert.deepEqual(v.networkCalls, [])
}
async function exported(v) { return JSON.parse(await v.downloads.at(-1).blob.text()) }
function handler(v, id) { const value = v.byId(id); assert.ok(value, id); return value.props.onClick }
function invoke(callback) { callback({ button: 0, preventDefault() {}, stopPropagation() {} }) }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function selected(v, side, value) { assert.ok(v.text(v.byId('accepted-' + side)).includes(value)) }

for (const locale of ['en', 'zh']) test(`local route opens with no effects and renders literal capture provenance in ${locale}`, async () => {
  const v = await mountCaptureFiles({ locale })
  try {
    noEffects(v)
    assert.equal(v.all(n => n.type === 'input' && n.props.type === 'file').length, 1)
    assert.equal(v.byId('capture-file').props.multiple, undefined)
    assert.equal(v.byId('compare-files').props.disabled, true)
    const value = saved(); value.label = '<b>saved label</b>'; value.note = '<img src=x onerror=alert(1)>\nsecond\tline'
    value.observation.summary.scenario = '<script>historical scenario</script>\ud800'
    value.observation.summary.configured_model = 'saved-model-only'
    value.observation.summary.configured_agents = '90071992547409931234567890'
    const filename = '../private/<img src=x>.json'
    await open(v, value, filename)
    assert.equal(v.text(v.byId('preview-filename')), filename)
    const preview = v.text(v.byId('file-preview'))
    for (const literal of [value.label, value.note, value.observation.summary.scenario, 'saved-model-only', '90071992547409931234567890', LEFT, revision, value.captured_at, value.observation.observed_at]) assert.ok(preview.includes(literal), literal)
    assert.match(preview, locale === 'en' ? /Imported file · historical observation/ : /导入文件 · 历史观察/)
    assert.match(preview, locale === 'en' ? /not been verified against the current backend/ : /未经当前后端验证/)
    assert.match(preview, locale === 'en' ? /Saved configured model\/settings/ : /保存的配置模型与设置/)
    assert.match(preview, locale === 'en' ? /local label, not a source URL/ : /本地标签，并非来源网址/)
    assert.equal(v.all(n => ['img', 'script', 'b'].includes(n.type) || n.props.innerHTML).length, 0)
    assert.ok(!v.text(v.byId('accepted-left')).includes(LEFT), 'preview does not accept')
    await v.click('use-left'); selected(v, 'left', LEFT)
    assert.equal(v.byId('file-preview'), undefined); assert.equal(v.byId('compare-files').props.disabled, true)
    await v.click('download-left'); assert.deepEqual(await exported(v), value)
    assert.equal(v.downloads.at(-1).filename, 'mirofish-run-capture.json')
    assert.equal(v.text(v.byId('filename-left')), filename)
    await v.change('file-language', locale === 'en' ? 'zh' : 'en')
    noEffects(v); assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
  assert.deepEqual(v.revokedUrls, ['blob:run-captures-1'])
})

test('unconditional server-page link reaches file workflow after every server read rejects', async () => {
  const v = await mountCaptureFiles({ initialPath: '/captures' })
  try {
    for (const entries of Object.values(v.requests.calls)) for (const request of entries) request.reject(new Error('Backend unavailable'))
    await flush()
    assert.equal(v.byId('open-capture-files').props.href, '/capture-files')
    const before = calls(v)
    await v.click('open-capture-files'); assert.equal(v.router.currentRoute.value.name, 'RunCaptureFiles')
    await accept(v, saved()); await open(v, pair()); await v.click('use-both'); await v.click('compare-files'); await v.click('download-file-comparison')
    assert.deepEqual(calls(v), before); assert.deepEqual(v.storageWrites, []); assert.deepEqual(v.networkCalls, [])
  } finally { v.unmount() }
})

test('comparison import needs explicit Use both and computes fresh same-simulation differences', async () => {
  const v = await mountCaptureFiles()
  try {
    const historical = pair()
    await open(v, historical, 'pair.json')
    assert.equal(v.all(n => n.props['data-testid']?.startsWith('preview-capture-')).length, 2)
    assert.ok(v.text(v.byId('historical-comparison-time')).includes(historical.generated_at))
    assert.equal(v.byId('use-left'), undefined); assert.equal(v.byId('compare-files').props.disabled, true)
    await v.click('use-both'); selected(v, 'left', LEFT); selected(v, 'right', RIGHT)
    assert.equal(v.byId('download-file-comparison').props.disabled, true)
    await v.click('compare-files')
    assert.match(v.text(v.byId('file-metric-recorded_actions')), /3\s+0\s+-3/)
    assert.match(v.text(v.byId('file-metric-reddit-recorded_actions')), /—\s+—\s+—/)
    assert.match(v.text(v.byId('file-comparison')), /Computed here from imported captures/)
    await v.click('download-file-comparison')
    const result = await exported(v)
    assert.notEqual(result.generated_at, historical.generated_at)
    assert.ok(Number.isFinite(Date.parse(result.generated_at)))
    assert.deepEqual(result.left, historical.left); assert.deepEqual(result.right, historical.right)
    assert.deepEqual(result.differences, historical.differences)
    assert.deepEqual(Object.keys(result).sort(), ['schema_version', 'left', 'right', 'differences', 'generated_at'].sort())
    await v.click('swap-files'); selected(v, 'left', RIGHT); selected(v, 'right', LEFT)
    assert.equal(v.byId('file-comparison'), undefined); assert.equal(v.byId('download-file-comparison').props.disabled, true)
    assert.deepEqual(v.revokedUrls, ['blob:run-captures-1'])
    await v.click('compare-files'); assert.match(v.text(v.byId('file-metric-recorded_actions')), /0\s+3\s+\+3/)
    await v.click('download-file-comparison'); assert.equal((await exported(v)).left.capture_id, RIGHT)
    await v.click('clear-left'); assert.equal(v.byId('file-comparison'), undefined); selected(v, 'right', LEFT)
    await v.click('download-right'); assert.deepEqual(await exported(v), historical.left)
    await v.click('clear-files'); assert.equal(v.byId('download-right'), undefined)
    noEffects(v)
  } finally { v.unmount() }
})

test('individual choices replace only their side, while cancel, failures and same-ID rejection preserve accepted captures', async () => {
  const v = await mountCaptureFiles()
  try {
    await accept(v, saved()); await accept(v, saved(RIGHT, 5), 'right')
    await open(v, saved(THIRD, 4)); await v.click('cancel-file')
    selected(v, 'left', LEFT); selected(v, 'right', RIGHT)
    await open(v, saved(RIGHT, 5)); await v.click('use-left')
    assert.match(v.text(v.byId('file-error')), /different capture IDs/)
    selected(v, 'left', LEFT); selected(v, 'right', RIGHT)
    await v.click('cancel-file')
    await open(v, '{private parser detail}'); assert.ok(v.byId('file-error'))
    assert.doesNotMatch(v.text(), /private parser detail/); selected(v, 'left', LEFT); selected(v, 'right', RIGHT)
    const forged = JSON.parse(JSON.stringify(pair())); forged.differences.recorded_actions = 100
    await open(v, forged); assert.ok(v.byId('file-error')); selected(v, 'left', LEFT); selected(v, 'right', RIGHT)
    await accept(v, saved(THIRD, 4)); selected(v, 'left', THIRD); selected(v, 'right', RIGHT)
    await choose(v, null); selected(v, 'left', THIRD); selected(v, 'right', RIGHT)
    assert.equal(v.byId('file-error'), undefined); noEffects(v)
  } finally { v.unmount() }
})

for (const coverage of ['partial', 'unavailable']) test(`${coverage} stays distinct from a complete zero observation`, async () => {
  const v = await mountCaptureFiles()
  try {
    const left = saved(), right = saved(RIGHT, 0)
    const summary = left.observation.summary; summary.availability = coverage
    if (coverage === 'unavailable') {
      summary.metrics.recorded_actions = null; summary.metrics.rounds_with_actions = null
      summary.metrics.action_types = []; summary.metrics.platforms.twitter = { availability: 'unavailable', recorded_actions: null, active_agents: null }
    } else { summary.metrics.platforms.twitter.availability = 'partial' }
    await accept(v, left); await accept(v, right, 'right'); await v.click('compare-files')
    assert.match(v.text(v.byId('file-metric-recorded_actions')), coverage === 'partial' ? /3\s+0\s+—/ : /—\s+0\s+—/)
    await v.click('download-file-comparison'); assert.equal((await exported(v)).differences.recorded_actions, null)
    noEffects(v)
  } finally { v.unmount() }
})

for (const resolution of ['resolve', 'reject']) test(`newer file selection owns results after late ${resolution} and stale preview handlers`, async () => {
  const v = await mountCaptureFiles()
  try {
    await open(v, saved())
    const use = handler(v, 'use-left'), cancel = handler(v, 'cancel-file'), staleInput = v.byId('capture-file').props.onChange
    const read = deferred(); const first = await choose(v, file(saved(), 'first.json', { arrayBuffer: () => read.promise }))
    const loadingCancel = handler(v, 'cancel-file')
    await open(v, saved(RIGHT, 5), 'second.json')
    invoke(use); invoke(cancel); invoke(loadingCancel)
    let staleReads = 0
    await staleInput({ target: { files: [file(saved(THIRD), 'stale.json', { arrayBuffer() { staleReads++; return new ArrayBuffer(0) } })], value: 'stale' } })
    read[resolution](resolution === 'resolve' ? new TextEncoder().encode(JSON.stringify(saved())).buffer : new Error('private old error'))
    await first.pending; await flush()
    assert.equal(staleReads, 0); assert.equal(v.text(v.byId('preview-filename')), 'second.json')
    assert.equal(v.byId('file-error'), undefined); assert.equal(v.byId('download-left'), undefined)
    await v.click('use-left'); selected(v, 'left', RIGHT); noEffects(v)
  } finally { v.unmount() }
})

for (const cacheHandlers of [true, false]) test(`old Use, clear, swap, compare and download handlers cannot affect a newer pair (cached ${cacheHandlers})`, async () => {
  const v = await mountCaptureFiles({ cacheHandlers })
  try {
    await open(v, pair()); const staleUse = handler(v, 'use-both'); await v.click('use-both'); await v.click('compare-files')
    const old = ['clear-left', 'clear-right', 'clear-files', 'swap-files', 'compare-files', 'download-left', 'download-right', 'download-file-comparison'].map(id => handler(v, id))
    await accept(v, saved(THIRD, 4))
    invoke(staleUse); old.forEach(invoke); await flush()
    selected(v, 'left', THIRD); selected(v, 'right', RIGHT)
    assert.equal(v.downloads.length, 0); assert.equal(v.byId('file-comparison'), undefined)
    await v.click('compare-files'); await v.click('download-file-comparison')
    assert.equal((await exported(v)).left.capture_id, THIRD); noEffects(v)
  } finally { v.unmount() }
})

for (const interruption of ['cancel-file', 'clear-left', 'clear-files', 'swap-files']) test(`${interruption} retires a pending file read without later replacement`, async () => {
  const v = await mountCaptureFiles()
  try {
    await open(v, pair()); await v.click('use-both')
    const read = deferred(); const first = await choose(v, file(saved(THIRD, 4), 'late.json', { arrayBuffer: () => read.promise }))
    await v.click(interruption)
    read.resolve(new TextEncoder().encode(JSON.stringify(saved(THIRD, 4))).buffer)
    await first.pending; await flush()
    assert.equal(v.byId('file-preview'), undefined); assert.equal(v.byId('file-loading'), undefined)
    if (interruption === 'cancel-file') { selected(v, 'left', LEFT); selected(v, 'right', RIGHT) }
    if (interruption === 'clear-left') { assert.equal(v.byId('download-left'), undefined); selected(v, 'right', RIGHT) }
    if (interruption === 'clear-files') { assert.equal(v.byId('download-left'), undefined); assert.equal(v.byId('download-right'), undefined) }
    if (interruption === 'swap-files') { selected(v, 'left', RIGHT); selected(v, 'right', LEFT) }
    noEffects(v)
  } finally { v.unmount() }
})

for (const resolution of ['resolve', 'reject']) test(`navigation, Back/Forward and unmount retire late ${resolution} and revoke downloads`, async () => {
  const v = await mountCaptureFiles()
  await accept(v, saved()); await v.click('download-left')
  const oldDownload = handler(v, 'download-left')
  const read = deferred(); const first = await choose(v, file(saved(RIGHT, 5), 'late.json', { arrayBuffer: () => read.promise }))
  const oldCancel = handler(v, 'cancel-file')
  await v.navigate('/runtime')
  read[resolution](resolution === 'resolve' ? new TextEncoder().encode(JSON.stringify(saved(RIGHT, 5))).buffer : new Error('private late error'))
  await first.pending; invoke(oldDownload); invoke(oldCancel); await flush()
  assert.equal(v.downloads.length, 1); assert.deepEqual(v.revokedUrls, ['blob:run-captures-1'])
  await v.back(); assert.equal(v.router.currentRoute.value.name, 'RunCaptureFiles')
  assert.equal(v.byId('download-left'), undefined); assert.equal(v.byId('file-preview'), undefined)
  await accept(v, saved(THIRD, 4)); await v.click('download-left')
  await v.forward(); assert.equal(v.router.currentRoute.value.name, 'RuntimeStatus')
  assert.deepEqual(v.revokedUrls, ['blob:run-captures-1', 'blob:run-captures-2'])
  noEffects(v); v.unmount()
})

test('same-route navigation clears session and unmount makes all saved handlers inert', async () => {
  const v = await mountCaptureFiles()
  await open(v, pair()); await v.click('use-both'); await v.click('compare-files'); await v.click('download-file-comparison')
  const stale = ['clear-files', 'swap-files', 'compare-files', 'download-file-comparison'].map(id => handler(v, id))
  await v.navigate('/capture-files?next=1'); stale.forEach(invoke); await flush()
  assert.equal(v.byId('file-comparison'), undefined); assert.equal(v.byId('download-left'), undefined)
  await open(v, saved()); const use = handler(v, 'use-left'); v.unmount(); invoke(use); stale.forEach(invoke)
  assert.equal(v.downloads.length, 1); assert.deepEqual(v.revokedUrls, ['blob:run-captures-1']); noEffects(v)
})

for (const [name, invalid] of [
  ['multiple files', f => [f, f]], ['oversize', f => ({ ...f, size: RUN_CAPTURE_FILE_MAX_BYTES + 1 })],
  ['missing reader', f => ({ ...f, arrayBuffer: undefined })], ['long filename', f => ({ ...f, name: 'x'.repeat(513) })], ['invalid filename', f => ({ ...f, name: null })],
]) test(`preflight rejects ${name} without reading or replacing a slot`, async () => {
  const v = await mountCaptureFiles()
  try {
    await accept(v, saved()); let reads = 0
    const { pending } = await choose(v, invalid(file(saved(RIGHT, 5), 'invalid.json', { arrayBuffer() { reads++; throw new Error('private') } })))
    await pending; await flush(); assert.equal(reads, 0); assert.ok(v.byId('file-error')); selected(v, 'left', LEFT); noEffects(v)
  } finally { v.unmount() }
})

for (const count of [1, 2]) test(`native input reset preserves the original FileList count ${count}`, async () => {
  const v = await mountCaptureFiles()
  try {
    let reads = 0; const chosen = file(saved(), 'native.json'); const buffer = await chosen.arrayBuffer()
    chosen.arrayBuffer = async () => { reads++; return buffer }
    const files = { length: count, 0: chosen, ...(count === 2 ? { 1: file(saved(RIGHT, 5)) } : {}) }
    let value = 'C:\\fakepath\\native.json'
    const target = { files, get value() { return value }, set value(next) { value = next; if (next === '') { delete files[0]; delete files[1]; files.length = 0 } } }
    await v.byId('capture-file').props.onChange({ target }); await flush()
    assert.equal(value, ''); assert.equal(reads, count === 1 ? 1 : 0)
    assert.equal(!!v.byId('file-preview'), count === 1); assert.equal(!!v.byId('file-error'), count === 2); noEffects(v)
  } finally { v.unmount() }
})

test('repeated download URLs are retired and local page has no server or persistence dependency', async () => {
  const v = await mountCaptureFiles()
  try {
    await accept(v, saved()); await v.click('download-left'); await v.click('download-left')
    assert.deepEqual(v.revokedUrls, ['blob:run-captures-1']); assert.equal(v.blobs.size, 1)
    await open(v, saved(RIGHT, 5)); assert.equal(v.blobs.size, 0)
    await v.click('cancel-file'); await v.click('download-left'); await v.click('clear-files'); assert.equal(v.blobs.size, 0)
    noEffects(v)
    const source = readFileSync(new URL('../src/views/RunCaptureFilesView.vue', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from ['"][^'"]*\/api\/|localStorage|sessionStorage|indexedDB|fetch\(/)
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})

test('download failure while a read is pending preserves accepted files and retires the loading state', async () => {
  const v = await mountCaptureFiles({ failDownload: true })
  try {
    await accept(v, saved())
    const read = deferred(); const first = await choose(v, file(saved(RIGHT, 5), 'pending.json', { arrayBuffer: () => read.promise }))
    await v.click('download-left')
    assert.ok(v.byId('file-error')); assert.equal(v.byId('file-loading'), undefined)
    assert.doesNotMatch(v.text(), /private download failure/); selected(v, 'left', LEFT)
    read.resolve(new TextEncoder().encode(JSON.stringify(saved(RIGHT, 5))).buffer)
    await first.pending; await flush(); assert.equal(v.byId('file-preview'), undefined)
    selected(v, 'left', LEFT); assert.equal(v.downloads.length, 0); noEffects(v)
  } finally { v.unmount() }
})
