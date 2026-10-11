import assert from 'node:assert/strict'
import test from 'node:test'
import { watch } from 'vue'
import { mountSavedSimulations, deferredApi, flush, ok } from './helpers/saved-simulations-view-fixture.js'
import { mountComparison } from './helpers/comparison-view-fixture.js'

const record = (id, extra = {}) => ({ simulation_id: id, project_id: `project_${id}`,
  scenario: 'Saved scenario', status: 'completed', created_at: null, updated_at: '2026-10-01T11:00:00Z', ...extra })
const catalog = candidates => ({ candidates, skipped_records: 3 })
const records = () => ['A', 'B', 'C'].map(id => record(id))
const invoke = callback => callback({ preventDefault() {}, stopPropagation() {} })
const action = (h, id) => {
  const control = h.byId(id)
  assert.ok(control, `missing pair control ${id}`)
  assert.equal(typeof control.props.onClick, 'function')
  return control.props.onClick
}
const pair = h => ['left', 'right'].map(side => {
  const value = h.byId(`simulations-pair-${side}`)
  return value ? h.text(value) : null
})
const choose = (h, id) => h.click(`simulation-select-${id}`)
async function setup(t, options = {}) {
  const d = deferredApi(), h = await mountSavedSimulations({ api: d.api, ...options })
  t.after(() => h.unmount())
  return { ...d, h }
}
async function loaded(t, values = records(), options = {}) {
  const d = await setup(t, options)
  d.calls.getComparisonCandidates[0].resolve(ok(catalog(values))); await flush()
  return d
}
function noEffects(h, calls, count = 1) {
  assert.equal(calls.getComparisonCandidates.length, count)
  assert.equal(calls.getSimulationHistory.length, 0)
  assert.deepEqual(h.networkCalls, []); assert.deepEqual(h.storageWrites, []); assert.deepEqual(h.warnings, [])
}
function capturedPair(h) {
  return ['simulation-select-C', 'simulation-select-A', 'simulations-pair-remove-A',
    'simulations-pair-clear', 'simulations-pair-compare'].map(id => action(h, id))
}
async function invokeAll(callbacks) { for (const callback of callbacks) invoke(callback); await flush() }

test('the loaded catalogue exposes two empty slots and an accessible count even with no records', async t => {
  const { h, calls } = await setup(t)
  assert.equal(h.byId('simulations-pair'), undefined)
  calls.getComparisonCandidates[0].resolve(ok(catalog([]))); await flush()
  assert.ok(h.byId('simulations-pair'))
  assert.deepEqual(pair(h), [null, null])
  assert.match(h.text(h.byId('simulations-pair-count')), /0.*2/)
  assert.equal(h.byId('simulations-pair-count').props['aria-live'], 'polite')
  assert.ok(h.byId('simulations-pair-compare').props.disabled)
  assert.ok(h.byId('simulations-pair-clear').props.disabled)
  invoke(action(h, 'simulations-pair-compare')); await flush()
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations'); noEffects(h, calls)
})

test('first and second choices keep exact left/right IDs across pages, hidden matches, order and history', async t => {
  const values = Array.from({ length: 45 }, (_, i) => record(`sim_${String(i + 1).padStart(2, '0')}`))
  values[40].status = 'unknown'
  const original = structuredClone(values)
  values.forEach(Object.freeze); Object.freeze(values)
  const { h, calls } = await loaded(t, values)
  await choose(h, 'sim_02'); await h.click('simulations-next'); await h.click('simulations-next')
  await choose(h, 'sim_41')
  assert.deepEqual(pair(h), ['sim_02', 'sim_41'])
  await h.change('simulations-order', 'id-asc')
  await h.change('simulations-status', 'completed')
  await h.input('simulations-query', 'nothing [.*'); await h.click('simulations-search')
  assert.ok(h.byId('simulations-empty')); assert.ok(h.byId('simulations-pair'))
  assert.deepEqual(pair(h), ['sim_02', 'sim_41'])
  assert.equal(h.byId('simulations-pair-compare').props.disabled, false)
  await h.back(); await h.back(); await h.forward()
  assert.deepEqual(pair(h), ['sim_02', 'sim_41'])
  await h.click('simulations-clear')
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
  assert.deepEqual(pair(h), ['sim_02', 'sim_41'])
  assert.deepEqual(values, original); noEffects(h, calls)
})

for (const cacheHandlers of [false, true]) test(`selection promotes the survivor, rejects duplicate/third additions and clears (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  const originalAdd = action(h, 'simulation-select-A')
  invoke(originalAdd); invoke(originalAdd); await flush()
  assert.deepEqual(pair(h), ['A', null])
  assert.ok(h.byId('simulations-pair-compare').props.disabled)
  await choose(h, 'B')
  assert.deepEqual(pair(h), ['A', 'B'])
  assert.ok(h.byId('simulation-select-C').props.disabled)
  invoke(action(h, 'simulation-select-C')); await flush()
  assert.deepEqual(pair(h), ['A', 'B'])
  await h.click('simulations-pair-remove-A')
  assert.deepEqual(pair(h), ['B', null])
  await choose(h, 'C'); await choose(h, 'C')
  assert.deepEqual(pair(h), ['B', null])
  await choose(h, 'A'); await h.click('simulations-pair-clear')
  assert.deepEqual(pair(h), [null, null])
  assert.equal(h.byId('simulation-select-C').props.disabled, false)
  noEffects(h, calls)
})

test('comparison opens exactly the selected pair and the existing destination autoloads those IDs', async t => {
  const { h, calls } = await loaded(t, [record('sim_Exact-Left', { status: 'failed' }), record('sim_Exact-Right', { status: 'idle' })])
  await choose(h, 'sim_Exact-Left'); await choose(h, 'sim_Exact-Right')
  await h.click('simulations-pair-compare')
  const route = h.router.currentRoute.value
  assert.equal(route.name, 'SimulationComparison')
  assert.equal(route.fullPath, '/compare?left=sim_Exact-Left&right=sim_Exact-Right')
  assert.deepEqual(route.query, { left: 'sim_Exact-Left', right: 'sim_Exact-Right' })
  assert.deepEqual(route.params, {}); noEffects(h, calls)
  const destination = await mountComparison({ initialPath: route.fullPath })
  t.after(() => destination.unmount())
  assert.equal(destination.requests.calls.compareSavedSimulations.length, 1)
  assert.deepEqual(destination.requests.calls.compareSavedSimulations[0].args.slice(0, 2), ['sim_Exact-Left', 'sim_Exact-Right'])
  assert.equal(destination.byId('left-select').props.value, 'sim_Exact-Left')
  assert.equal(destination.byId('right-select').props.value, 'sim_Exact-Right')
})

for (const missing of ['A', 'B']) test(`opening rechecks ${missing}'s current catalogue membership even before another render`, async t => {
  const values = records(), { h, calls } = await loaded(t, values)
  await choose(h, 'A'); await choose(h, 'B')
  const open = action(h, 'simulations-pair-compare')
  // Change the external response object without triggering a Vue render. A
  // previously enabled button must still recheck both records when invoked.
  values.splice(values.findIndex(candidate => candidate.simulation_id === missing), 1)
  await invoke(open); await flush()
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
  noEffects(h, calls)
})

test('selecting does not change row destinations, export content or an already captured download action', async t => {
  const values = records(), { h, calls } = await loaded(t, values)
  const download = action(h, 'simulations-download')
  const links = ['activity', 'interviews', 'compare', 'captures'].map(kind => h.byId(`simulation-${kind}-A`).props.href)
  assert.deepEqual(links, ['/simulation/A/activity', '/simulation/A/interviews', '/compare?left=A', '/captures?simulation=A'])
  invoke(download); await flush()
  const before = await h.downloads.at(-1).blob.text()
  await choose(h, 'A'); await choose(h, 'B'); await h.click('simulations-pair-remove-A')
  await h.click('simulations-pair-clear'); invoke(download); await flush()
  assert.equal(h.downloads.length, 2)
  assert.equal(await h.downloads.at(-1).blob.text(), before)
  assert.deepEqual(['activity', 'interviews', 'compare', 'captures'].map(kind => h.byId(`simulation-${kind}-A`).props.href), links)
  assert.deepEqual(JSON.parse(before).records, values); noEffects(h, calls)
})

for (const cacheHandlers of [false, true]) test(`refresh clears immediately; identical-ID replacements and ignored aborted replies cannot restore a pair (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  await choose(h, 'A'); await choose(h, 'B')
  const retained = capturedPair(h)
  invoke(action(h, 'simulations-refresh'))
  await invokeAll(retained)
  assert.equal(h.byId('simulations-pair'), undefined)
  const stale = calls.getComparisonCandidates[1]
  await h.click('simulations-refresh'); assert.ok(stale.signal.aborted)
  calls.getComparisonCandidates[2].resolve(ok(catalog(records()))); await flush()
  assert.deepEqual(pair(h), [null, null])
  await choose(h, 'A'); await choose(h, 'B')
  stale.resolve(ok(catalog([record('old')]))); await flush()
  await invokeAll(retained)
  assert.deepEqual(pair(h), ['A', 'B'])
  assert.equal(h.byId('simulation-select-old'), undefined)
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations'); noEffects(h, calls, 3)
})

test('failed loads, failed retries, duplicate IDs and unsafe IDs leave no selection or actionable stale callbacks', async t => {
  const { h, calls } = await loaded(t)
  await choose(h, 'A'); await choose(h, 'B')
  const retained = capturedPair(h)
  await h.click('simulations-refresh')
  calls.getComparisonCandidates.at(-1).reject(Error('private failure')); await flush()
  const invalid = [catalog([record('A'), record('A')]), catalog([record('../unsafe')]),
    catalog([record('bad\n')]), catalog([record('x'.repeat(129))])]
  for (const value of invalid) {
    assert.ok(h.byId('simulations-error')); assert.equal(h.byId('simulations-pair'), undefined)
    await invokeAll(retained)
    await h.click('simulations-retry')
    calls.getComparisonCandidates.at(-1).resolve(ok(value)); await flush()
  }
  await h.click('simulations-retry'); calls.getComparisonCandidates.at(-1).reject(Error('private retry failure')); await flush()
  assert.equal(h.byId('simulations-pair'), undefined)
  await h.click('simulations-retry'); calls.getComparisonCandidates.at(-1).resolve(ok(catalog(records()))); await flush()
  await invokeAll(retained)
  assert.deepEqual(pair(h), [null, null]); assert.doesNotMatch(h.text(), /private/)
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations'); noEffects(h, calls, 8)
})

for (const cacheHandlers of [false, true]) test(`captured add/remove/clear/open callbacks retire on mutations and a selection A-B-A cycle (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  const oldAdd = action(h, 'simulation-select-C')
  await choose(h, 'A'); await choose(h, 'B')
  const retained = capturedPair(h)
  await h.click('simulations-pair-clear')
  await choose(h, 'A'); await choose(h, 'B')
  await invokeAll([oldAdd, ...retained])
  assert.deepEqual(pair(h), ['A', 'B'])
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations'); noEffects(h, calls)
})

for (const cacheHandlers of [false, true]) test(`captured pair callbacks retire on same-view route changes and A-B-A history (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  await choose(h, 'A'); await choose(h, 'B')
  for (const path of ['/simulations?q=Saved', '/simulations?status=completed', '/simulations?order=id-asc', '/simulations?page=2', '/simulations#pair']) {
    const retained = capturedPair(h)
    await h.navigate(path); await invokeAll(retained)
    assert.equal(h.router.currentRoute.value.fullPath, path)
    assert.deepEqual(pair(h), ['A', 'B'])
    await h.back(); await invokeAll(retained)
    assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
    assert.deepEqual(pair(h), ['A', 'B'])
  }
  noEffects(h, calls)
})

for (const cacheHandlers of [false, true]) test(`route commit, leaving and teardown reject old pair actions before queued unmount (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  await choose(h, 'A'); await choose(h, 'B')
  const retained = capturedPair(h)
  let observed = false
  const stop = watch(() => h.router.currentRoute.value.fullPath, () => {
    observed = !!h.byId('simulations-pair')
    retained.forEach(invoke)
    assert.equal(h.router.currentRoute.value.name, 'SavedReports')
  }, { flush: 'sync' })
  await h.navigate('/reports'); stop(); assert.ok(observed)
  await invokeAll(retained)
  await h.navigate('/simulations'); calls.getComparisonCandidates.at(-1).resolve(ok(catalog(records()))); await flush()
  await invokeAll(retained); assert.deepEqual(pair(h), [null, null])
  await choose(h, 'A'); await choose(h, 'B')
  const current = capturedPair(h)
  h.unmount()
  const unmountedPath = h.router.currentRoute.value.fullPath
  await invokeAll(current)
  assert.equal(h.root.children.length, 0)
  assert.equal(h.router.currentRoute.value.fullPath, unmountedPath); noEffects(h, calls, 2)
})

for (const cacheHandlers of [false, true]) test(`late refresh success after leaving cannot populate a remounted same-ID catalogue (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  await choose(h, 'A'); await choose(h, 'B')
  const retained = capturedPair(h)
  await h.click('simulations-refresh')
  const abandoned = calls.getComparisonCandidates.at(-1)
  await h.navigate('/reports'); assert.ok(abandoned.signal.aborted)
  await h.navigate('/simulations')
  abandoned.resolve(ok(catalog(records()))); await flush()
  assert.ok(h.byId('simulations-loading')); assert.equal(h.byId('simulations-pair'), undefined)
  calls.getComparisonCandidates.at(-1).resolve(ok(catalog(records()))); await flush()
  await invokeAll(retained)
  assert.deepEqual(pair(h), [null, null])
  noEffects(h, calls, 3)
})

for (const cacheHandlers of [false, true]) test(`pending filter navigation disables every pair action; cancellation preserves selection and retires callbacks (${cacheHandlers})`, async t => {
  const { h, calls } = await loaded(t, records(), { cacheHandlers })
  await choose(h, 'A'); await choose(h, 'B')
  const retained = capturedPair(h)
  let settle
  const removeGuard = h.router.beforeEach(() => new Promise(resolve => { settle = resolve }))
  await h.input('simulations-query', 'other'); await h.click('simulations-search')
  for (const id of ['simulation-select-A', 'simulation-select-C', 'simulations-pair-remove-A', 'simulations-pair-clear', 'simulations-pair-compare']) {
    assert.ok(h.byId(id).props.disabled, id)
  }
  const pending = capturedPair(h)
  await invokeAll([...retained, ...pending])
  assert.deepEqual(pair(h), ['A', 'B'])
  settle(false); await flush(); removeGuard()
  await invokeAll([...retained, ...pending])
  assert.deepEqual(pair(h), ['A', 'B'])
  assert.equal(h.byId('simulations-pair-compare').props.disabled, false)
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations'); noEffects(h, calls)
})

test('repeated comparison clicks enqueue once and cancelled or rejected comparison navigation keeps the pair', async t => {
  const { h, calls } = await loaded(t)
  await choose(h, 'A'); await choose(h, 'B')
  let settle, starts = 0
  const removeGuard = h.router.beforeEach(to => { starts++; assert.equal(to.name, 'SimulationComparison'); return new Promise(resolve => { settle = resolve }) })
  const open = action(h, 'simulations-pair-compare')
  invoke(open); invoke(open); await flush()
  assert.equal(starts, 1); assert.ok(h.byId('simulations-pair-compare').props.disabled)
  invoke(action(h, 'simulations-pair-compare')); await flush(); assert.equal(starts, 1)
  settle(false); await flush(); removeGuard()
  assert.deepEqual(pair(h), ['A', 'B'])
  invoke(open); await flush(); assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
  const removeError = h.router.onError(() => {})
  const rejectGuard = h.router.beforeEach(() => { throw Error('navigation failed') })
  await invoke(action(h, 'simulations-pair-compare')); await flush()
  rejectGuard(); removeError()
  assert.deepEqual(pair(h), ['A', 'B'])
  assert.equal(h.byId('simulations-pair-compare').props.disabled, false)
  await h.click('simulations-pair-compare')
  assert.equal(h.router.currentRoute.value.fullPath, '/compare?left=A&right=B'); noEffects(h, calls)
})

test('late comparison completion cannot clear a newer filter navigation owner', async t => {
  const { h, calls } = await loaded(t)
  await choose(h, 'A'); await choose(h, 'B')
  const waiting = []
  const removeGuard = h.router.beforeEach(to => new Promise(resolve => waiting.push({ to, resolve })))
  await h.click('simulations-pair-compare')
  await h.input('simulations-query', 'Saved'); await h.click('simulations-search')
  assert.equal(waiting.length, 2)
  assert.equal(waiting[0].to.name, 'SimulationComparison')
  waiting[0].resolve(false); await flush()
  assert.ok(h.byId('simulations-pair-compare').props.disabled)
  assert.ok(h.byId('simulations-download').props.disabled)
  invoke(action(h, 'simulations-pair-compare')); await flush(); assert.equal(waiting.length, 2)
  waiting[1].resolve(true); await flush(); removeGuard()
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations?q=Saved')
  assert.equal(h.byId('simulations-pair-compare').props.disabled, false)
  assert.deepEqual(pair(h), ['A', 'B']); noEffects(h, calls)
})

for (const locale of ['en', 'zh']) test(`pair labels describe identities, clearing lifetime and literal hostile text (${locale})`, async t => {
  const id = 'Long-Exact_ID_'.repeat(9)
  const hostile = '<img src=x onerror=alert(1)> 雪 [.*'
  const { h, calls } = await loaded(t, [record(id, { scenario: hostile }), record('B', { status: 'unknown' })], { locale })
  assert.ok(h.byId(`simulation-select-${id}`), 'select control for a valid long ID')
  assert.match(h.byId(`simulation-select-${id}`).props['aria-label'], new RegExp(id))
  await choose(h, id); await choose(h, 'B')
  assert.deepEqual(pair(h), [id, 'B'])
  assert.match(h.text(h.byId('simulations-pair-count')), /2.*2/)
  assert.match(h.text(h.byId('simulations-pair')), locale === 'en' ? /Left.*Right/s : /左侧.*右侧/s)
  assert.match(h.text(h.byId('simulations-pair')), locale === 'en' ? /refresh.*leav.*clear/i : /刷新.*离开.*清除/)
  assert.ok(h.text().includes(hostile)); assert.equal(h.all(node => node.type === 'img').length, 0)
  assert.match(h.byId(`simulations-pair-remove-${id}`).props['aria-label'], new RegExp(id))
  assert.doesNotMatch(h.text(), /savedSimulations\.|comparison\./); noEffects(h, calls)
})
