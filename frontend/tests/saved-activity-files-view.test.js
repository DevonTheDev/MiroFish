import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountActivityFiles, flush, syntheticActivityPage as page, file, chooseFile, previewFile, acceptFile } from './helpers/saved-activity-files-view-fixture.js'

const counts = view => Object.fromEntries(Object.entries(view.requests.calls).map(([name, values]) => [name, values.length]))
function noEffects(view) {
  assert.ok(Object.values(counts(view)).every(value => value === 0), JSON.stringify(counts(view)))
  assert.deepEqual(view.storageWrites, []); assert.deepEqual(view.networkCalls, [])
}
function handler(view, id) { const node = view.byId(id); assert.ok(node, id); return node.props.onClick }
function invoke(callback) { callback({ button: 0, preventDefault() {}, stopPropagation() {} }) }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function accepted(view, id) { assert.equal(view.text(view.byId('accepted-simulation')), id) }
async function exported(view) { return JSON.parse(await view.downloads.at(-1).blob.text()) }

for (const initialPath of ['/', '/simulation/sim_A/activity']) test(`entry from ${initialPath} remains available after backend rejection`, async () => {
  const view = await mountActivityFiles({ initialPath })
  try {
    for (const items of Object.values(view.requests.calls)) for (const request of items) request.reject(new Error('Offline'))
    await flush()
    const link = view.byId('open-activity-files')
    assert.ok(link, 'Open activity file must be discoverable without a successful backend read')
    assert.equal(link.props.href, '/activity-files')
    const before = counts(view)
    await view.click('open-activity-files')
    assert.equal(view.router.currentRoute.value.name, 'SavedActivityFiles')
    await acceptFile(view, page()); await view.click('download-file')
    assert.deepEqual(await exported(view), page())
    assert.deepEqual(counts(view), before); assert.deepEqual(view.storageWrites, []); assert.deepEqual(view.networkCalls, [])
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`preview, explicit acceptance and full literal evidence work in ${locale}`, async () => {
  const view = await mountActivityFiles({ locale })
  try {
    noEffects(view)
    assert.equal(view.all(n => n.type === 'input' && n.props.type === 'file').length, 1)
    assert.equal(view.byId('activity-file').props.multiple, undefined)
    assert.ok(view.byId('clear-file').props.disabled)
    const value = page(), action = value.actions[0]
    value.context.created_at = '<script>literal context</script>\ud800'
    value.filters.q = ' <b>saved phrase</b> '; value.filters.case_sensitive = true
    value.filters.platform = 'twitter'; value.filters.agent_id = action.agent_id
    value.filters.round_num = action.round_num; value.filters.action_type = action.action_type; value.filters.outcome = 'failed'
    action.agent_name = '<img src=x onerror=alert(1)>'; action.timestamp = 'literal saved time'
    action.match_preview = ' <b>saved phrase</b> 🦙 '
    action.details_json = '{"huge":9007199254740993,"text":"<script>literal</script>","text2":"\\ud800"}'
    const name = '../private/<img src=x>.json'
    await previewFile(view, value, name)
    assert.equal(view.text(view.byId('preview-filename')), name)
    assert.equal(view.byId('accepted-file'), undefined)
    const preview = view.text(view.byId('file-preview'))
    assert.match(preview, locale === 'en' ? /historical.*one captured page/i : /历史.*一页/)
    assert.match(preview, locale === 'en' ? /unverified/i : /未经验证/)
    assert.match(preview, locale === 'en' ? /not a whole run/i : /并非完整运行/)
    for (const text of [value.simulation_id, value.observed_at, value.source_revision, value.context.created_at, value.filters.q, value.filters.agent_id]) assert.ok(preview.includes(text), text)
    for (const key of ['filters', 'warnings', 'context', 'availability', 'matched', 'returned', 'offset', 'limit', 'has-more']) assert.ok(view.byId('preview-' + key), key)
    await view.click('open-file'); accepted(view, value.simulation_id)
    assert.equal(view.byId('file-preview'), undefined)
    assert.equal(view.text(view.byId('accepted-filename')), name)
    const acceptedText = view.text(view.byId('accepted-file'))
    for (const text of [value.observed_at, value.source_revision, value.context.created_at, value.filters.q, action.agent_name, action.timestamp, action.agent_id, action.round_num]) assert.ok(acceptedText.includes(text), text)
    assert.equal(view.text(view.byId('details-' + action.record_id)), action.details_json)
    assert.equal(view.text(view.byId('match-preview-' + action.record_id)), action.match_preview)
    assert.equal(view.all(n => ['img', 'script', 'b'].includes(n.type) || n.props.innerHTML).length, 0)
    assert.equal(view.all(n => n.type === 'a' && n.props.href?.includes('/simulation/')).length, 0)
    for (const id of ['next', 'refresh', 'first', 'previous', 'apply', 'activity-rounds-entry']) assert.equal(view.byId(id), undefined, id)
    assert.equal(view.all(n => n.type === 'form').length, 0)
    await view.click('download-file'); assert.deepEqual(await exported(view), value)
    assert.equal(view.downloads.at(-1).filename, 'mirofish-saved-activity-page.json')
    await view.change('file-language', locale === 'en' ? 'zh' : 'en')
    accepted(view, value.simulation_id); assert.deepEqual(view.warnings, []); noEffects(view)
  } finally { view.unmount() }
  assert.deepEqual(view.revokedUrls, ['blob:activity-files-1'])
})

for (const kind of ['complete-zero', 'partial-zero', 'unavailable', 'beyond-offset']) test(`${kind} remains a distinct historical page observation`, async () => {
  const view = await mountActivityFiles()
  try {
    const value = page(); value.actions = []; value.returned_count = 0; value.has_more = false
    if (kind === 'beyond-offset') { value.offset = 100; value.matched_count = 3 }
    else { value.offset = 0; value.matched_count = 0 }
    if (kind === 'partial-zero') { value.availability = 'partial'; value.platform_availability.twitter = 'partial'; value.warnings = [{ code: 'invalid_records', platform: 'twitter', count: 2 }] }
    if (kind === 'unavailable') { value.availability = 'unavailable'; value.platform_availability.twitter = value.platform_availability.reddit = 'unavailable'; value.matched_count = null; value.warnings = [{ code: 'no_action_logs' }] }
    await acceptFile(view, value)
    const empty = view.text(view.byId('empty-state'))
    assert.match(empty, kind === 'unavailable' ? /unavailable when captured/ : kind === 'beyond-offset' ? /beyond.*matching/ : /zero matching/)
    assert.equal(view.text(view.byId('accepted-matched')), kind === 'unavailable' ? 'Unknown' : String(value.matched_count))
    assert.equal(view.text(view.byId('accepted-returned')), '0')
    assert.equal(view.text(view.byId('accepted-offset')), String(value.offset))
    if (value.warnings.length) assert.ok(view.text(view.byId('accepted-warnings')).includes(value.warnings[0].code))
    else assert.match(view.text(view.byId('accepted-warnings')), /None recorded/)
    assert.match(view.text(view.byId('accepted-file')), /not a whole run/)
    await view.click('download-file'); assert.deepEqual(await exported(view), value); noEffects(view)
  } finally { view.unmount() }
})

test('cancelled or invalid replacements keep accepted filename, metadata and downloadable evidence', async () => {
  const view = await mountActivityFiles()
  try {
    const first = page('accepted_A'), second = page('pending_B')
    await acceptFile(view, first, 'accepted.json')
    await previewFile(view, second, 'replacement.json')
    accepted(view, first.simulation_id); assert.equal(view.text(view.byId('preview-simulation')), second.simulation_id)
    assert.equal(view.text(view.byId('accepted-filename')), 'accepted.json'); assert.equal(view.text(view.byId('preview-filename')), 'replacement.json')
    await view.click('cancel-file'); accepted(view, first.simulation_id); assert.equal(view.byId('file-preview'), undefined)
    await previewFile(view, '{private parser detail}', 'bad.json')
    assert.ok(view.byId('file-error')); assert.doesNotMatch(view.text(), /private parser detail/); accepted(view, first.simulation_id)
    await view.click('download-file'); assert.deepEqual(await exported(view), first)
    await chooseFile(view, null); assert.equal(view.byId('file-error'), undefined); accepted(view, first.simulation_id)
    await acceptFile(view, second, 'new-accepted.json'); accepted(view, second.simulation_id)
    await view.click('clear-file'); assert.equal(view.byId('accepted-file'), undefined); assert.equal(view.byId('download-file'), undefined)
    assert.equal(view.blobs.size, 0); noEffects(view)
  } finally { view.unmount() }
})

for (const resolution of ['resolve', 'reject']) test(`new selection retires old reads and retained select/open/cancel handlers after late ${resolution}`, async () => {
  const view = await mountActivityFiles()
  try {
    await previewFile(view, page('preview_A'))
    const staleOpen = handler(view, 'open-file'), staleCancel = handler(view, 'cancel-file'), staleSelect = view.byId('activity-file').props.onChange
    const read = deferred(), oldFile = file(page('old_B'), 'old.json', { arrayBuffer: () => read.promise })
    const { pending } = await chooseFile(view, oldFile), loadingCancel = handler(view, 'cancel-file')
    await previewFile(view, page('new_C'), 'new.json')
    invoke(staleOpen); invoke(staleCancel); invoke(loadingCancel)
    let staleReads = 0
    await staleSelect({ target: { files: [file(page(), 'stale.json', { arrayBuffer() { staleReads++; throw Error('stale read') } })], value: 'stale' } })
    read[resolution](resolution === 'resolve' ? new TextEncoder().encode(JSON.stringify(page('old_B'))).buffer : Error('private old error'))
    await pending; await flush()
    assert.equal(staleReads, 0); assert.equal(view.text(view.byId('preview-filename')), 'new.json')
    assert.equal(view.byId('file-error'), undefined); assert.equal(view.byId('accepted-file'), undefined)
    await view.click('open-file'); accepted(view, 'new_C'); noEffects(view)
  } finally { view.unmount() }
})

for (const cacheHandlers of [true, false]) test(`retained actions never clear or export newer evidence (cached ${cacheHandlers})`, async () => {
  const view = await mountActivityFiles({ cacheHandlers })
  try {
    await previewFile(view, page('preview_A')); const staleOpen = handler(view, 'open-file')
    await view.click('open-file')
    const stale = ['clear-file', 'download-file'].map(id => handler(view, id))
    await acceptFile(view, page('accepted_B'))
    invoke(staleOpen); stale.forEach(invoke); await flush()
    accepted(view, 'accepted_B'); assert.equal(view.downloads.length, 0)
    await view.click('download-file'); assert.equal((await exported(view)).simulation_id, 'accepted_B'); noEffects(view)
  } finally { view.unmount() }
})

for (const action of ['cancel-file', 'clear-file']) for (const resolution of ['resolve', 'reject']) test(`${action} retires a pending ${resolution}`, async () => {
  const view = await mountActivityFiles()
  try {
    await acceptFile(view, page('accepted_A'))
    const read = deferred(), { pending } = await chooseFile(view, file(page('late_B'), 'late.json', { arrayBuffer: () => read.promise }))
    await view.click(action)
    read[resolution](resolution === 'resolve' ? new TextEncoder().encode(JSON.stringify(page('late_B'))).buffer : Error('late private error'))
    await pending; await flush()
    assert.equal(view.byId('file-preview'), undefined); assert.equal(view.byId('file-loading'), undefined); assert.equal(view.byId('file-error'), undefined)
    if (action === 'cancel-file') accepted(view, 'accepted_A')
    else assert.equal(view.byId('accepted-file'), undefined)
    noEffects(view)
  } finally { view.unmount() }
})

for (const resolution of ['resolve', 'reject']) test(`navigation, Back/Forward and unmount retire late ${resolution} and revoke URLs`, async () => {
  const view = await mountActivityFiles()
  await acceptFile(view, page('accepted_A')); await view.click('download-file')
  const staleDownload = handler(view, 'download-file'), read = deferred()
  const { pending } = await chooseFile(view, file(page('late_B'), 'late.json', { arrayBuffer: () => read.promise }))
  const staleCancel = handler(view, 'cancel-file')
  await view.navigate('/runtime')
  read[resolution](resolution === 'resolve' ? new TextEncoder().encode(JSON.stringify(page('late_B'))).buffer : Error('private late error'))
  await pending; invoke(staleDownload); invoke(staleCancel); await flush()
  assert.equal(view.downloads.length, 1); assert.deepEqual(view.revokedUrls, ['blob:activity-files-1'])
  await view.back(); assert.equal(view.router.currentRoute.value.name, 'SavedActivityFiles')
  assert.equal(view.byId('accepted-file'), undefined); assert.equal(view.byId('file-preview'), undefined)
  await acceptFile(view, page('accepted_C')); await view.click('download-file')
  await view.forward(); assert.equal(view.router.currentRoute.value.name, 'RuntimeStatus')
  assert.deepEqual(view.revokedUrls, ['blob:activity-files-1', 'blob:activity-files-2']); noEffects(view); view.unmount()
})

test('same-route navigation and unmount retire every retained handler and pending read', async () => {
  const view = await mountActivityFiles()
  await acceptFile(view, page()); await view.click('download-file')
  const stale = ['clear-file', 'download-file'].map(id => handler(view, id))
  await view.navigate('/activity-files?next=1'); stale.forEach(invoke); await flush()
  assert.equal(view.byId('accepted-file'), undefined); assert.equal(view.blobs.size, 0)
  await previewFile(view, page()); const open = handler(view, 'open-file'), select = view.byId('activity-file').props.onChange
  const read = deferred(), { pending } = await chooseFile(view, file(page('late'), 'late.json', { arrayBuffer: () => read.promise }))
  const cancel = handler(view, 'cancel-file'); view.unmount(); invoke(open); invoke(cancel); stale.forEach(invoke)
  let reads = 0; await select({ target: { files: [file(page(), 'ignored.json', { arrayBuffer() { reads++; throw Error('ignored') } })] } })
  read.resolve(new TextEncoder().encode(JSON.stringify(page('late'))).buffer); await pending; await flush()
  assert.equal(reads, 0); assert.equal(view.downloads.length, 1); assert.deepEqual(view.revokedUrls, ['blob:activity-files-1']); noEffects(view)
})

for (const [name, invalid] of [
  ['multiple files', f => [f, f]], ['oversize', f => ({ ...f, size: 8 * 1024 * 1024 + 1 })],
  ['missing reader', f => ({ ...f, arrayBuffer: undefined })], ['long filename', f => ({ ...f, name: 'x'.repeat(513) })],
  ['nontext filename', f => ({ ...f, name: null })],
]) test(`preflight rejects ${name} without reading or replacing accepted evidence`, async () => {
  const view = await mountActivityFiles()
  try {
    await acceptFile(view, page()); let reads = 0
    const { pending } = await chooseFile(view, invalid(file(page('replacement'), 'bad.json', { arrayBuffer() { reads++; throw Error('private') } })))
    await pending; await flush(); assert.equal(reads, 0); assert.ok(view.byId('file-error')); accepted(view, page().simulation_id); noEffects(view)
  } finally { view.unmount() }
})

for (const count of [1, 2]) test(`native picker reset retains original FileList item and count ${count}`, async () => {
  const view = await mountActivityFiles()
  try {
    const chosen = file(page(), 'native.json'), buffer = await chosen.arrayBuffer(); let reads = 0
    chosen.arrayBuffer = async () => { reads++; return buffer }
    const files = { length: count, 0: chosen, ...(count === 2 ? { 1: chosen } : {}) }
    let value = 'native.json'
    const target = { files, get value() { return value }, set value(next) { value = next; if (next === '') { delete files[0]; delete files[1]; files.length = 0 } } }
    const input = view.byId('activity-file'); assert.ok(input, 'The saved activity file picker is missing')
    await input.props.onChange({ target }); await flush()
    assert.equal(value, ''); assert.equal(reads, count === 1 ? 1 : 0)
    assert.equal(!!view.byId('file-preview'), count === 1); assert.equal(!!view.byId('file-error'), count === 2); noEffects(view)
  } finally { view.unmount() }
})

test('download URLs are revoked on repeat, replacement, cancel, clear, and invalid selection', async () => {
  const view = await mountActivityFiles()
  try {
    await acceptFile(view, page()); await view.click('download-file'); await view.click('download-file')
    assert.deepEqual(view.revokedUrls, ['blob:activity-files-1']); assert.equal(view.blobs.size, 1)
    await previewFile(view, page('replacement')); assert.equal(view.blobs.size, 0)
    await view.click('download-file'); await view.click('cancel-file'); assert.equal(view.blobs.size, 0)
    await view.click('download-file'); await previewFile(view, '{bad'); assert.equal(view.blobs.size, 0)
    await view.click('download-file'); await view.click('clear-file'); assert.equal(view.blobs.size, 0)
    assert.deepEqual(view.revokedUrls, Array.from({ length: 5 }, (_, i) => `blob:activity-files-${i + 1}`)); noEffects(view)
    const source = readFileSync(new URL('../src/views/SavedActivityFilesView.vue', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from ['"][^'"]*\/api\/|localStorage|sessionStorage|indexedDB|fetch\(|v-html/)
  } finally { view.unmount() }
})

for (const failure of ['create', 'append', 'click']) test(`download ${failure} failure preserves accepted page and retires pending read`, async () => {
  const view = await mountActivityFiles({ failDownload: failure })
  try {
    await acceptFile(view, page('accepted_A'))
    const read = deferred(), { pending } = await chooseFile(view, file(page('late_B'), 'late.json', { arrayBuffer: () => read.promise }))
    await view.click('download-file')
    assert.ok(view.byId('file-error')); assert.equal(view.byId('file-loading'), undefined)
    accepted(view, 'accepted_A'); assert.equal(view.downloads.length, 0); assert.equal(view.blobs.size, 0)
    assert.doesNotMatch(view.text(), /private .* failure/)
    read.resolve(new TextEncoder().encode(JSON.stringify(page('late_B'))).buffer); await pending; await flush()
    assert.equal(view.byId('file-preview'), undefined); accepted(view, 'accepted_A'); noEffects(view)
  } finally { view.unmount() }
})
