import assert from 'node:assert/strict'
import test from 'node:test'
import { mountActivityFiles, flush, syntheticActivityPage, file, chooseFile, previewFile, acceptFile } from './helpers/saved-activity-files-view-fixture.js'

function page(id = 'focused_page') {
  const value = syntheticActivityPage(id), original = value.actions[0]
  value.offset = 100; value.limit = 8; value.returned_count = 8; value.matched_count = 275
  value.availability = 'partial'; value.platform_availability.reddit = 'partial'
  value.warnings = [{ code: 'invalid_records', platform: 'reddit', count: 2 }]
  value.filters.q = 'STRASSE'; value.filters.case_sensitive = false
  value.actions = [['twitter', true], ['reddit', false], ['twitter', null], ['reddit', true], ['twitter', false], ['reddit', null], ['reddit', false], ['twitter', null]].map(([platform, success], index) => ({
    ...original, record_id: `legacy:${index + 1}`, platform, success,
    agent_name: '<img src=x> Straße', match_preview: 'Straße',
    details_json: '{"exact":9007199254740993,"text":"<script>literal</script>","success":true}',
  }))
  return value
}
const ids = view => view.all(node => node.type === 'tr' && node.props['data-testid']?.startsWith('action-row-')).map(node => node.props['data-testid'].slice('action-row-'.length))
const expectRows = (view, numbers) => assert.deepEqual(ids(view), numbers.map(number => `legacy:${number}`))
function noEffects(view) {
  assert.ok(Object.values(view.requests.calls).every(calls => calls.length === 0))
  assert.deepEqual(view.storageWrites, []); assert.deepEqual(view.networkCalls, []); assert.deepEqual(view.warnings, [])
}
function controls(view) {
  return {
    platform: view.byId('focus-platform').props.onChange,
    outcome: view.byId('focus-outcome').props.onChange,
    reset: view.byId('focus-reset').props.onClick,
  }
}
async function assertRetired(view, owned) {
  const snapshot = () => ({ platform: view.byId('focus-platform')?.props.value, outcome: view.byId('focus-outcome')?.props.value, rows: ids(view) })
  const current = snapshot()
  for (const invoke of [() => owned.platform({ target: { value: 'twitter' } }), () => owned.outcome({ target: { value: 'success' } }), () => owned.reset()]) {
    invoke(); await flush(); assert.deepEqual(snapshot(), current, 'each stale handler must leave current focus unchanged')
  }
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const metadataIds = ['filename', 'simulation', 'observed', 'revision', 'availability', 'returned', 'matched', 'offset', 'limit', 'has-more', 'filters', 'context', 'warnings']
const metadata = view => Object.fromEntries(metadataIds.map(key => [key, view.text(view.byId(`accepted-${key}`))]))

for (const locale of ['en', 'zh']) test(`local focus controls appear only after acceptance, with labels and count in ${locale}`, async () => {
  const view = await mountActivityFiles({ locale })
  try {
    assert.equal(view.byId('focus-platform'), undefined)
    await previewFile(view, page())
    assert.equal(view.byId('focus-platform'), undefined)
    await view.click('open-file')
    for (const id of ['focus-platform', 'focus-outcome']) {
      const control = view.byId(id)
      assert.ok(control, `missing local focus control ${id}`)
      assert.equal(control.type, 'select'); assert.equal(control.props.value, 'all')
      assert.ok(view.find(node => node.type === 'label' && node.props.for === control.props.id), `accessible label for ${id}`)
    }
    assert.deepEqual(view.byId('focus-platform').children.filter(node => node.type === 'option').map(node => node.props.value), ['all', 'twitter', 'reddit'])
    assert.deepEqual(view.byId('focus-outcome').children.filter(node => node.type === 'option').map(node => node.props.value), ['all', 'success', 'failed', 'unknown'])
    assert.equal(view.byId('focus-count').props['aria-live'], 'polite')
    assert.match(view.text(view.byId('focus-count')), locale === 'en' ? /Showing 8 of 8 captured records/ : /显示 8 条.*共 8 条/)
    assert.match(view.text(view.byId('focus-scope')), locale === 'en' ? /Only records in this opened file are filtered/ : /仅筛选此已打开文件中的记录/)
    assert.match(view.text(view.byId('focus-reset')), locale === 'en' ? /Show all captured records/ : /显示全部捕获记录/)
    assert.equal(view.all(node => node.type === 'input' && node.props.type !== 'file').length, 0)
    noEffects(view)
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`literal platform and saved-outcome truth table preserves order and duplicates in ${locale}`, async () => {
  const view = await mountActivityFiles({ locale })
  try {
    const value = page(); await acceptFile(view, value)
    const original = metadata(view)
    const expected = {
      all: { all: [1, 2, 3, 4, 5, 6, 7, 8], success: [1, 4], failed: [2, 5, 7], unknown: [3, 6, 8] },
      twitter: { all: [1, 3, 5, 8], success: [1], failed: [5], unknown: [3, 8] },
      reddit: { all: [2, 4, 6, 7], success: [4], failed: [2, 7], unknown: [6] },
    }
    for (const [platform, outcomes] of Object.entries(expected)) for (const [outcome, numbers] of Object.entries(outcomes)) {
      await view.change('focus-platform', platform); await view.change('focus-outcome', outcome)
      expectRows(view, numbers); assert.deepEqual(metadata(view), original)
      assert.match(view.text(view.byId('focus-count')), new RegExp(locale === 'en' ? `Showing ${numbers.length} of 8 captured records` : `显示 ${numbers.length} 条.*共 8 条`))
      for (const number of numbers) assert.equal(view.text(view.byId(`details-legacy:${number}`)), value.actions[number - 1].details_json)
      assert.equal(view.all(node => ['script', 'img'].includes(node.type) || node.props.innerHTML).length, 0)
    }
    await view.click('download-file')
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), value, 'hidden rows and original metadata remain in full export')
    await view.click('focus-reset'); expectRows(view, expected.all.all)
    assert.equal(view.byId('focus-platform').props.value, 'all'); assert.equal(view.byId('focus-outcome').props.value, 'all')
    assert.deepEqual(metadata(view), original); noEffects(view)
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`zero local matches differ from the captured source state in ${locale}`, async () => {
  const view = await mountActivityFiles({ locale })
  try {
    const value = page(); value.actions = value.actions.slice(0, 1); value.returned_count = value.limit = 1
    await acceptFile(view, value); const original = metadata(view)
    await view.change('focus-outcome', 'failed')
    assert.equal(view.byId('activity-file-table'), undefined); assert.equal(view.byId('empty-state'), undefined)
    assert.match(view.text(view.byId('focus-empty')), locale === 'en' ? /No captured records match these review filters/ : /没有捕获记录符合这些查看筛选条件/)
    assert.match(view.text(view.byId('focus-count')), locale === 'en' ? /Showing 0 of 1 captured records/ : /显示 0 条.*共 1 条/)
    assert.deepEqual(metadata(view), original)
    await view.click('focus-reset'); expectRows(view, [1]); assert.equal(view.byId('focus-empty'), undefined)
    noEffects(view)
  } finally { view.unmount() }
})

for (const kind of ['complete-zero', 'partial-zero', 'unavailable', 'beyond-offset']) test(`${kind} keeps its original empty notice when focus changes`, async () => {
  const view = await mountActivityFiles()
  try {
    const value = syntheticActivityPage(); value.actions = []; value.returned_count = 0; value.has_more = false; value.matched_count = 0; value.offset = 0
    if (kind === 'partial-zero') { value.availability = 'partial'; value.platform_availability.twitter = 'partial'; value.warnings = [{ code: 'invalid_records', count: 2 }] }
    if (kind === 'unavailable') { value.availability = 'unavailable'; value.platform_availability = { twitter: 'unavailable', reddit: 'unavailable' }; value.matched_count = null }
    if (kind === 'beyond-offset') { value.offset = 100; value.matched_count = 3 }
    await acceptFile(view, value); const original = metadata(view), empty = view.text(view.byId('empty-state'))
    await view.change('focus-outcome', 'failed'); await view.change('focus-platform', 'reddit')
    assert.equal(view.text(view.byId('empty-state')), empty); assert.equal(view.byId('focus-empty'), undefined)
    assert.match(empty, kind === 'unavailable' ? /unavailable when captured/ : kind === 'beyond-offset' ? /beyond.*matching/ : /zero matching/)
    assert.equal(view.text(view.byId('focus-count')), 'Showing 0 of 0 captured records')
    assert.deepEqual(metadata(view), original); noEffects(view)
  } finally { view.unmount() }
})

test('language changes relabel local review without changing selectors, rows or metadata values', async () => {
  const view = await mountActivityFiles()
  try {
    await acceptFile(view, page()); await view.change('focus-platform', 'reddit'); await view.change('focus-outcome', 'failed')
    await view.change('file-language', 'zh'); expectRows(view, [2, 7])
    assert.equal(view.byId('focus-platform').props.value, 'reddit'); assert.equal(view.byId('focus-outcome').props.value, 'failed')
    assert.match(view.text(view.byId('focus-count')), /显示 2 条.*共 8 条/)
    assert.equal(view.text(view.byId('accepted-matched')), '275'); assert.equal(view.text(view.byId('accepted-offset')), '100')
    await view.change('file-language', 'en'); expectRows(view, [2, 7]); assert.equal(view.text(view.byId('focus-count')), 'Showing 2 of 8 captured records')
    noEffects(view)
  } finally { view.unmount() }
})

test('invalid selectors preserve the current focus and its valid handler revision', async () => {
  const view = await mountActivityFiles()
  try {
    await acceptFile(view, page()); await view.change('focus-outcome', 'failed')
    const original = controls(view)
    for (const value of ['', 'Twitter', 'FALSE', null, undefined, false, 0, [], {}]) {
      await view.change('focus-platform', value); await view.change('focus-outcome', value)
      expectRows(view, [2, 5, 7]); assert.equal(view.byId('focus-platform').props.value, 'all'); assert.equal(view.byId('focus-outcome').props.value, 'failed')
    }
    original.platform({ target: { value: 'reddit' } }); await flush(); expectRows(view, [2, 7]); noEffects(view)
  } finally { view.unmount() }
})

for (const cacheHandlers of [true, false]) test(`newer focus revisions retire all retained selectors and resets (cached ${cacheHandlers})`, async () => {
  const view = await mountActivityFiles({ cacheHandlers })
  try {
    await acceptFile(view, page()); const initial = controls(view)
    await view.change('focus-platform', 'reddit'); await assertRetired(view, initial); expectRows(view, [2, 4, 6, 7])
    const platform = controls(view); await view.change('focus-outcome', 'failed'); await assertRetired(view, platform); expectRows(view, [2, 7])
    const failed = controls(view); await view.click('focus-reset'); await assertRetired(view, failed); expectRows(view, [1, 2, 3, 4, 5, 6, 7, 8])
    noEffects(view)
  } finally { view.unmount() }
})

for (const cacheHandlers of [true, false]) test(`changing focus during replacement read preserves eventual preview and acceptance resets focus (cached ${cacheHandlers})`, async () => {
  const view = await mountActivityFiles({ cacheHandlers })
  try {
    await acceptFile(view, page('original')); await view.change('focus-outcome', 'failed')
    const read = deferred(), replacement = page('replacement')
    const { pending } = await chooseFile(view, file(replacement, 'replacement.json', { arrayBuffer: () => read.promise }))
    assert.ok(view.byId('file-loading')); await view.change('focus-platform', 'reddit'); expectRows(view, [2, 7])
    const stale = controls(view)
    read.resolve(new TextEncoder().encode(JSON.stringify(replacement)).buffer); await pending; await flush()
    assert.equal(view.text(view.byId('preview-simulation')), 'replacement'); expectRows(view, [2, 7])
    assert.equal(view.byId('file-loading'), undefined)
    await view.click('open-file')
    assert.equal(view.text(view.byId('accepted-simulation')), 'replacement'); expectRows(view, [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(view.byId('focus-platform').props.value, 'all'); assert.equal(view.byId('focus-outcome').props.value, 'all')
    await view.change('focus-platform', 'reddit'); await view.change('focus-outcome', 'unknown')
    await assertRetired(view, stale); expectRows(view, [6]); noEffects(view)
  } finally { view.unmount() }
})

for (const finish of ['cancel-preview', 'cancel-loading', 'invalid-file', 'read-reject', 'empty-picker']) test(`${finish} retains accepted page and local focus`, async () => {
  const view = await mountActivityFiles()
  try {
    await acceptFile(view, page('original')); await view.change('focus-platform', 'reddit'); await view.change('focus-outcome', 'failed')
    const original = metadata(view)
    if (finish === 'cancel-preview') { await previewFile(view, page('replacement')); await view.click('cancel-file') }
    if (finish === 'invalid-file') await previewFile(view, '{invalid')
    if (finish === 'empty-picker') await chooseFile(view, null)
    if (finish === 'cancel-loading' || finish === 'read-reject') {
      const read = deferred(), replacement = page('replacement')
      const { pending } = await chooseFile(view, file(replacement, 'replacement.json', { arrayBuffer: () => read.promise }))
      await view.change('focus-platform', 'twitter'); expectRows(view, [5]); await view.change('focus-platform', 'reddit')
      if (finish === 'cancel-loading') { await view.click('cancel-file'); read.resolve(new TextEncoder().encode(JSON.stringify(replacement)).buffer) }
      else read.reject(new Error('private read failure'))
      await pending; await flush()
    }
    expectRows(view, [2, 7]); assert.deepEqual(metadata(view), original)
    assert.equal(view.byId('focus-platform').props.value, 'reddit'); assert.equal(view.byId('focus-outcome').props.value, 'failed')
    assert.equal(view.byId('file-preview'), undefined); noEffects(view)
  } finally { view.unmount() }
})

for (const cacheHandlers of [true, false]) for (const transition of ['clear', 'same-route', 'back-forward', 'unmount']) test(`${transition} retires retained local handlers and resets later accepted focus (cached ${cacheHandlers})`, async () => {
  const view = await mountActivityFiles({ cacheHandlers })
  let unmounted = false
  try {
    await acceptFile(view, page('original')); await view.change('focus-platform', 'reddit'); await view.change('focus-outcome', 'failed')
    const stale = controls(view)
    if (transition === 'clear') await view.click('clear-file')
    if (transition === 'same-route') await view.navigate('/activity-files?next=1')
    if (transition === 'back-forward') { await view.navigate('/runtime'); await view.back(); assert.equal(view.router.currentRoute.value.name, 'SavedActivityFiles') }
    if (transition === 'unmount') { view.unmount(); unmounted = true }
    await assertRetired(view, stale); assert.equal(view.byId('accepted-file'), undefined)
    if (!unmounted) {
      await acceptFile(view, page('later')); expectRows(view, [1, 2, 3, 4, 5, 6, 7, 8])
      assert.equal(view.byId('focus-platform').props.value, 'all'); assert.equal(view.byId('focus-outcome').props.value, 'all')
      await view.change('focus-platform', 'twitter'); await view.change('focus-outcome', 'unknown')
      await assertRetired(view, stale); expectRows(view, [3, 8])
      if (transition === 'back-forward') { const later = controls(view); await view.forward(); await assertRetired(view, later); assert.equal(view.router.currentRoute.value.name, 'RuntimeStatus') }
    }
    noEffects(view)
  } finally { if (!unmounted) view.unmount() }
})
