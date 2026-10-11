import assert from 'node:assert/strict'
import test from 'node:test'
import { watch } from 'vue'
import { mountSavedSimulations, deferredApi, flush, ok } from './helpers/saved-simulations-view-fixture.js'

const record = (index, extra = {}) => ({ simulation_id: `sim_${String(index).padStart(2, '0')}`,
  project_id: `project_${index}`, scenario: 'Saved scenario 雪', status: 'completed',
  created_at: null, updated_at: `2026-10-01T11:00:${String(index % 60).padStart(2, '0')}Z`, ...extra })
const catalog = (candidates, skipped_records = 3) => ({ candidates, skipped_records })
const ids = records => records.map(row => row.simulation_id)
const rows = h => h.all(node => node.props['data-testid'] === 'simulation-row')
const action = h => { const button = h.byId('simulations-download'); assert.ok(button, 'catalog download control'); return button.props.onClick }
const invoke = callback => callback({ preventDefault() {}, stopPropagation() {} })
const read = async h => JSON.parse(await h.downloads.at(-1).blob.text())
async function setup(t, options = {}) {
  const d = deferredApi(), h = await mountSavedSimulations({ api: d.api, ...options })
  t.after(() => h.unmount())
  return { ...d, h }
}
async function loaded(t, records = [record(1)], options, skipped) {
  const d = await setup(t, options)
  d.calls.getComparisonCandidates[0].resolve(ok(catalog(records, skipped))); await flush()
  return d
}
function noEffects(h, calls, count = 1) {
  assert.equal(calls.getComparisonCandidates.length, count)
  assert.equal(calls.getSimulationHistory.length, 0)
  assert.deepEqual(h.networkCalls, []); assert.deepEqual(h.storageWrites, []); assert.deepEqual(h.warnings, [])
}

test('download includes all 45 matching ordered records across pages and preserves the source', async t => {
  const records = Array.from({ length: 45 }, (_, index) => Object.freeze(record(45 - index)))
  Object.freeze(records)
  const original = structuredClone(records), { h, calls } = await loaded(t, records, { initialPath: '/simulations?page=2' })
  assert.equal(rows(h).length, 20)
  for (const order of ['', 'updated-desc', 'updated-asc', 'id-asc']) {
    await h.change('simulations-order', order)
    await h.click('simulations-next')
    await h.click('simulations-download')
    const exported = await read(h), expected = order === 'updated-asc' || order === 'id-asc' ? [...records].reverse() : records
    assert.equal(exported.format, 'mirofish-saved-simulation-catalog'); assert.equal(exported.version, 1)
    assert.deepEqual(exported.selection, { q: '', status: '', order })
    assert.deepEqual(exported.counts, { total: 45, matched: 45, skipped: 3 })
    assert.deepEqual(ids(exported.records), ids(expected))
    assert.equal(exported.records.length, 45)
    assert.equal(h.downloads.at(-1).filename, 'mirofish-saved-simulation-catalog.json')
    assert.equal(h.downloads.at(-1).blob.type, 'application/json;charset=utf-8')
    assert.ok(h.anchors.every(anchor => !anchor.attached))
  }
  assert.deepEqual(records, original); noEffects(h, calls)
})

test('export follows applied literal search, status and order, excluding the search draft and page', async t => {
  const records = Array.from({ length: 49 }, (_, index) => record(index + 1))
  records.push(record(50, { status: 'stopped' }), record(51, { scenario: 'different scenario' }))
  const { h, calls } = await loaded(t, records, { initialPath: '/simulations?q=saved&status=completed&order=updated-desc&page=3' })
  assert.equal(rows(h).length, 9)
  await h.input('simulations-query', 'unapplied draft')
  await h.click('simulations-download')
  const exported = await read(h)
  assert.deepEqual(exported.selection, { q: 'saved', status: 'completed', order: 'updated-desc' })
  assert.deepEqual(exported.counts, { total: 51, matched: 49, skipped: 3 })
  assert.deepEqual(ids(exported.records), ids(records.slice(0, 49).reverse()))
  await h.input('simulations-query', 'PROJECT_50'); await h.click('simulations-search')
  await h.change('simulations-status', 'stopped'); await h.click('simulations-download')
  assert.deepEqual((await read(h)).records, [records[49]])
  await h.input('simulations-query', '[.*nothing'); await h.click('simulations-search'); await h.click('simulations-download')
  assert.deepEqual((await read(h)).records, []); assert.equal((await read(h)).counts.matched, 0)
  noEffects(h, calls)
})

test('JSON preserves raw dates, nulls, Unicode and control text while projecting only six catalog fields', async t => {
  const value = record(1, { project_id: null, scenario: '\ufeff雪😀\r\n\u0000\t<script>literal</script>\u2028\ud800',
    created_at: 'not a date\n', updated_at: '2026-10-01T11:00:00.123456+02:00',
    config: { api_key: 'private config' }, reports: ['private report'], interviews: ['private interview'], future: 'private extra',
    toJSON() { throw Error('Never serialize the original response object') } })
  const { h, calls } = await loaded(t, [value, record(2, { created_at: null, updated_at: null })])
  await h.click('simulations-download')
  const exported = await read(h), fields = ['simulation_id', 'project_id', 'scenario', 'status', 'created_at', 'updated_at']
  assert.deepEqual(Object.keys(exported.records[0]), fields)
  for (const field of fields) assert.equal(exported.records[0][field], value[field])
  assert.equal(exported.records[1].created_at, null); assert.equal(exported.records[1].updated_at, null)
  const text = await h.downloads[0].blob.text()
  assert.doesNotMatch(text, /private config|private report|private interview|private extra/)
  assert.deepEqual(new Uint8Array(await h.downloads[0].blob.arrayBuffer()), new TextEncoder().encode(text))
  noEffects(h, calls)
})

test('malformed route values export normalized applied defaults and out-of-range pages do not truncate', async t => {
  const { h, calls } = await loaded(t, [record(2), record(1)], { initialPath: '/simulations?q=a&q=b&status=invalid&order=id-asc&order=unknown&page=999' })
  assert.ok(h.byId('simulations-url-notice')); await h.click('simulations-download')
  assert.deepEqual((await read(h)).selection, { q: '', status: '', order: '' })
  assert.deepEqual(ids((await read(h)).records), ['sim_02', 'sim_01'])
  await h.navigate('/simulations?q=Saved&status=completed&order=id-asc&page=bad'); await h.click('simulations-download')
  assert.deepEqual(ids((await read(h)).records), ['sim_01', 'sim_02']); noEffects(h, calls)
})

test('loading, failed and malformed catalog states cannot export; valid empty catalog can', async t => {
  const { h, calls } = await setup(t)
  const pending = action(h); assert.ok(h.byId('simulations-download').props.disabled)
  invoke(pending); assert.equal(h.downloads.length, 0)
  const invalid = [catalog([record(1)], undefined), catalog([record(1)], null), catalog([record(1)], 'unknown'),
    catalog([record(1)], -1), catalog([record(1), record(1)]), catalog([record(1, { project_id: {} })]),
    catalog([record(1, { status: 'future-status' })]), catalog([record(1, { simulation_id: '../bad' })])]
  delete invalid[0].skipped_records
  for (const data of invalid) {
    calls.getComparisonCandidates.at(-1).resolve(ok(data)); await flush()
    assert.ok(h.byId('simulations-download').props.disabled); invoke(action(h))
    assert.ok(h.byId('simulations-error')); assert.equal(h.downloads.length, 0)
    await h.click('simulations-retry')
  }
  calls.getComparisonCandidates.at(-1).reject(Error('private failure')); await flush()
  invoke(action(h)); assert.equal(h.downloads.length, 0); assert.doesNotMatch(h.text(), /private failure/)
  await h.click('simulations-retry'); calls.getComparisonCandidates.at(-1).resolve(ok(catalog([], 4))); await flush()
  invoke(pending); assert.equal(h.downloads.length, 0)
  await h.click('simulations-download'); assert.deepEqual((await read(h)).counts, { total: 0, matched: 0, skipped: 4 })
})

for (const cacheHandlers of [false, true]) test(`retained export callbacks retire on filter/order/page changes and A-B-A routes (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, [record(2), record(1)], { cacheHandlers })
  for (const nextPath of ['/simulations?q=Saved', '/simulations?status=completed', '/simulations?order=id-asc', '/simulations?page=2', '/simulations#catalog']) {
    const retained = action(h)
    await h.navigate(nextPath); invoke(retained); await flush()
    assert.equal(h.downloads.length, 0)
    await h.navigate('/simulations'); invoke(retained); await flush()
    assert.equal(h.downloads.length, 0)
  }
  await h.click('simulations-download'); assert.equal(h.downloads.length, 1); noEffects(h, calls)
})

for (const cacheHandlers of [false, true]) test(`route commit retires downloads before queued unmount and retained callbacks stay retired (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, [record(1)], { cacheHandlers }), retained = action(h)
  let observed = false
  const stop = watch(() => h.router.currentRoute.value.fullPath, () => {
    observed = !!h.byId('simulations-download'); invoke(retained)
    assert.equal(h.downloads.length, 0); assert.equal(h.anchors.length, 0)
  }, { flush: 'sync' })
  await h.navigate('/reports'); stop()
  assert.ok(observed); invoke(retained); await flush(); assert.equal(h.downloads.length, 0)
  await h.navigate('/simulations'); calls.getComparisonCandidates.at(-1).resolve(ok(catalog([record(1)]))); await flush()
  invoke(retained); assert.equal(h.downloads.length, 0)
  const current = action(h); h.unmount(); invoke(current); assert.equal(h.downloads.length, 0); assert.equal(h.blobs.size, 0)
})

test('a pending filter navigation disables downloads and rejected navigation safely restores the current catalog', async t => {
  const { h, calls } = await loaded(t), retained = action(h)
  let settle
  const removeGuard = h.router.beforeEach(() => new Promise(resolve => { settle = resolve }))
  await h.input('simulations-query', 'other'); await h.click('simulations-search')
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
  assert.ok(h.byId('simulations-download').props.disabled)
  invoke(retained); invoke(action(h)); assert.equal(h.downloads.length, 0)
  settle(false); await flush(); removeGuard()
  assert.equal(h.byId('simulations-download').props.disabled, false)
  invoke(retained); assert.equal(h.downloads.length, 0)
  await h.click('simulations-download'); assert.deepEqual((await read(h)).selection, { q: '', status: '', order: '' })
  noEffects(h, calls)
})

test('export retains raw invalid and equal-time metadata in the same full-list order as the page', async t => {
  const records = [record(3, { updated_at: '2026-10-01T11:00:00.123456' }),
    record(1, { updated_at: '2026-10-01T13:00:00.123456+02:00' }),
    record(2, { updated_at: null }), record(4, { updated_at: 'not a date\r\n' }),
    record(5, { updated_at: '2026-10-01T11:00:00.123455Z' })]
  const { h, calls } = await loaded(t, records)
  for (const [order, expected] of [['updated-desc', [3, 1, 5, 2, 4]], ['updated-asc', [5, 3, 1, 2, 4]], ['id-asc', [1, 2, 3, 4, 5]], ['', [3, 1, 2, 4, 5]]]) {
    await h.change('simulations-order', order); await h.click('simulations-download')
    assert.deepEqual((await read(h)).records, expected.map(id => records.find(value => value.simulation_id === record(id).simulation_id)))
  }
  noEffects(h, calls)
})

test('refresh revokes the current URL, retires old callbacks and ignored-abort responses cannot restore records', async t => {
  const { h, calls } = await loaded(t), retained = action(h)
  await h.click('simulations-download'); const firstUrl = h.downloads[0].url
  await h.click('simulations-refresh'); invoke(retained); invoke(action(h))
  assert.ok(h.revoked.includes(firstUrl)); assert.equal(h.blobs.size, 0); assert.equal(h.downloads.length, 1)
  const stale = calls.getComparisonCandidates[1]
  await h.click('simulations-refresh'); assert.ok(stale.signal.aborted)
  calls.getComparisonCandidates[2].reject(Error('private failure')); await flush()
  stale.resolve(ok(catalog([record(50)]))); await flush(); invoke(retained)
  assert.equal(h.downloads.length, 1); assert.ok(h.byId('simulations-download').props.disabled)
  await h.click('simulations-retry'); calls.getComparisonCandidates[3].resolve(ok(catalog([record(2)]))); await flush()
  invoke(retained); assert.equal(h.downloads.length, 1)
  await h.click('simulations-download'); assert.deepEqual(ids((await read(h)).records), ['sim_02'])
  h.unmount(); assert.equal(h.blobs.size, 0); assert.ok(h.anchors.every(anchor => !anchor.attached))
})

for (const stage of ['blob', 'url', 'create', 'href', 'filename', 'append', 'click', 'remove']) test(`download ${stage} failure is generic, cleans this attempt and permits retry`, async t => {
  const { h, calls } = await loaded(t)
  h.downloadHooks[stage] = () => { throw Error('secret download failure') }
  invoke(action(h)); await flush()
  assert.ok(h.byId('simulations-download-error')); assert.doesNotMatch(h.text(), /secret download failure/)
  assert.equal(h.blobs.size, 0); assert.ok(h.anchors.every(anchor => !anchor.attached))
  delete h.downloadHooks[stage]
  const before = h.downloads.length
  await h.click('simulations-download'); assert.equal(h.downloads.length, before + 1)
  assert.equal(h.byId('simulations-download-error'), undefined); noEffects(h, calls)
})

test('a transient anchor-removal failure retries cleanup and still revokes its URL', async t => {
  const { h, calls } = await loaded(t)
  h.downloadHooks.beforeRemove = () => { delete h.downloadHooks.beforeRemove; throw Error('transient removal failure') }
  await h.click('simulations-download')
  assert.ok(h.byId('simulations-download-error')); assert.equal(h.blobs.size, 0)
  assert.ok(h.anchors.every(anchor => !anchor.attached))
  await h.change('simulations-order', 'id-asc')
  assert.equal(h.byId('simulations-download-error'), undefined); noEffects(h, calls)
})

for (const stage of ['blob', 'afterUrl', 'afterCreate', 'href', 'filename', 'append', 'afterClick', 'remove', 'revoke']) test(`reentry from ${stage} preserves newer ownership and cleans only the retired resources`, async t => {
  const { h, calls } = await loaded(t)
  // A second click retires the first resource, including reentry from its cleanup.
  if (stage === 'revoke') await h.click('simulations-download')
  h.downloadHooks[stage] = () => { delete h.downloadHooks[stage]; invoke(action(h)) }
  await h.click('simulations-download')
  assert.ok(h.downloads.length >= 1)
  const latest = h.downloads.at(-1)
  assert.ok(h.blobs.has(latest.url), 'the completed newer download must keep its own URL')
  assert.equal(h.blobs.size, 1); assert.ok(h.anchors.every(anchor => !anchor.attached))
  assert.equal(h.byId('simulations-download-error'), undefined); noEffects(h, calls)
  h.unmount(); assert.equal(h.blobs.size, 0)
})

test('retirement inside URL creation and anchor attachment prevents a later click', async t => {
  for (const stage of ['blob', 'afterUrl', 'afterCreate', 'href', 'filename', 'append']) {
    const { h } = await loaded(t)
    h.downloadHooks[stage] = () => { delete h.downloadHooks[stage]; h.unmount() }
    invoke(action(h)); await flush()
    assert.equal(h.downloads.length, 0); assert.equal(h.blobs.size, 0); assert.ok(h.anchors.every(anchor => !anchor.attached))
  }
})

test('cleanup failure after reentry cannot report a stale error or revoke the newer download', async t => {
  const { h, calls } = await loaded(t)
  await h.click('simulations-download')
  h.downloadHooks.revoke = () => { delete h.downloadHooks.revoke; invoke(action(h)); throw Error('private cleanup error') }
  await h.click('simulations-download')
  assert.equal(h.blobs.size, 1); assert.ok(h.blobs.has(h.downloads.at(-1).url))
  assert.equal(h.byId('simulations-download-error'), undefined); noEffects(h, calls)
})

for (const locale of ['en', 'zh']) test(`catalog scope, all-pages download label and generic error are localized (${locale})`, async t => {
  const { h, calls } = await loaded(t, [record(1)], { locale })
  assert.match(h.text(h.byId('simulations-download')), locale === 'en' ? /Download matching JSON/ : /下载匹配.*JSON/)
  assert.match(h.text(), locale === 'en' ? /not a restorable simulation backup/i : /不能.*恢复/)
  h.downloadHooks.url = () => { throw Error('private') }; await h.click('simulations-download')
  assert.ok(h.byId('simulations-download-error')); assert.doesNotMatch(h.text(), /savedSimulations\.|private/)
  noEffects(h, calls)
})
