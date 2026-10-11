import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedSimulations, deferredApi, flush, ok } from './helpers/saved-simulations-view-fixture.js'

const record = (id, updated_at = '2026-10-01T11:00:00Z', extra = {}) => ({
  simulation_id: id, project_id: 'project', scenario: 'Saved scenario', status: 'completed',
  created_at: null, updated_at, ...extra,
})
const catalog = candidates => ({ candidates, skipped_records: 2 })
const rows = h => h.all(n => n.props['data-testid'] === 'simulation-row')
const ids = h => rows(h).map(row => row.children.find(n => n.props.class === 'row-heading').children.find(n => n.type === 'h2').text)
async function setup(t, initialPath = '/simulations', locale = 'en') {
  const d = deferredApi()
  const h = await mountSavedSimulations({ api: d.api, initialPath, locale })
  t.after(() => h.unmount())
  return { ...d, h }
}
async function loaded(t, candidates, path, locale) {
  const d = await setup(t, path, locale)
  d.calls.getComparisonCandidates[0].resolve(ok(catalog(candidates))); await flush()
  return d
}

test('explicit updated order sorts all matches before pagination and never mutates the service sequence', async t => {
  const records = Array.from({ length: 45 }, (_, i) => record(`sim_${String(i + 1).padStart(2, '0')}`, `2026-10-${String(i % 30 + 1).padStart(2, '0')}T11:00:00Z`))
  records[44] = record('sim_latest', '2026-11-01T11:00:00Z')
  const original = structuredClone(records)
  records.forEach(Object.freeze); Object.freeze(records)
  const { h, calls } = await loaded(t, records)
  assert.deepEqual(ids(h), original.slice(0, 20).map(row => row.simulation_id))
  assert.equal(h.byId('simulations-order')?.props.value, '', 'The order selector must default to the unchanged service sequence')
  await h.click('simulations-next')
  await h.change('simulations-order', 'updated-desc')
  assert.equal(h.router.currentRoute.value.query.order, 'updated-desc')
  assert.equal(h.router.currentRoute.value.query.page, undefined)
  assert.equal(ids(h)[0], 'sim_latest', 'A late API record must sort onto the first page')
  const newest = [...original].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).map(row => row.simulation_id)
  assert.deepEqual(ids(h), newest.slice(0, 20))
  await h.click('simulations-next')
  assert.deepEqual(ids(h), newest.slice(20, 40))
  assert.equal(h.router.currentRoute.value.query.order, 'updated-desc')
  await h.change('simulations-order', 'updated-asc')
  assert.deepEqual(ids(h), [...original].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at)).slice(0, 20).map(row => row.simulation_id))
  await h.change('simulations-order', '')
  assert.deepEqual(ids(h), original.slice(0, 20).map(row => row.simulation_id))
  assert.equal(h.router.currentRoute.value.query.order, undefined)
  assert.deepEqual(records, original)
  assert.equal(calls.getComparisonCandidates.length, 1)
  assert.equal(h.warnings.length, 0)
})

test('recognized dates use UTC for unzoned values, retain microseconds and keep equal times in service order', async t => {
  const records = [
    record('tie_z', '2026-10-01T11:00:00.123456'),
    record('later_microsecond', '2026-10-01T11:00:00.123457Z'),
    record('tie_a', '2026-10-01T13:00:00.123456+02:00'),
    record('earlier_microsecond', '2026-10-01T10:00:00.123455-01:00'),
    record('epoch', '1970-01-01'),
    record('before_epoch', '1969-12-31T23:59:59.999999Z'),
    record('leap_day', '2024-02-29'),
    record('short_fraction', '2026-10-01T11:00:00.1Z'),
    record('year_99', '0099-01-01'),
    record('year_1', '0001-01-01T00:00:00'),
  ]
  const newest = ['later_microsecond', 'tie_z', 'tie_a', 'earlier_microsecond', 'short_fraction', 'leap_day', 'epoch', 'before_epoch', 'year_99', 'year_1']
  const oldest = ['year_1', 'year_99', 'before_epoch', 'epoch', 'leap_day', 'short_fraction', 'earlier_microsecond', 'tie_z', 'tie_a', 'later_microsecond']
  const { h } = await loaded(t, records, '/simulations?order=updated-desc')
  assert.deepEqual(ids(h), newest)
  await h.change('simulations-order', 'updated-asc')
  assert.deepEqual(ids(h), oldest)
  // Equivalent instants must have identical native-locale displays.
  const updatedText = row => row.children.find(n => n.type === 'dl').children.filter(n => n.type === 'dd').at(-1).text
  assert.equal(updatedText(rows(h)[7]), updatedText(rows(h)[8]))
  assert.match(h.text(), /without.*offset.*UTC/i)
})

test('missing and invalid dates stay last in either direction and display as unavailable', async t => {
  const bad = [null, '', 'not a date', '10/01/2026', '2026-02-30', '2025-02-29T11:00:00Z',
    '2026-13-01T00:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T11:00:60Z',
    '2026-10-01T11:00:00+24:00', '2026-10-01T11:00:00.1234567Z', ' 2026-10-01', '0000-01-01',
    '2026-10-01\n', '2026-10-01\r', '2026-10-01\u2028', '2026-10-01\u2029']
  const records = [record('newer', '2026-10-01T11:00:00Z'), ...bad.map((value, i) => record(`unknown_${i}`, value)), record('older', '1969-12-31T23:59:59Z')]
  const unknownIds = bad.map((_, i) => `unknown_${i}`)
  const { h } = await loaded(t, records, '/simulations?order=updated-desc')
  assert.deepEqual(ids(h), ['newer', 'older', ...unknownIds])
  await h.change('simulations-order', 'updated-asc')
  assert.deepEqual(ids(h), ['older', 'newer', ...unknownIds])
  for (const row of rows(h).slice(2)) {
    assert.equal(row.children.find(n => n.type === 'dl').children.filter(n => n.type === 'dd').at(-1).text, '—')
  }
  assert.equal(h.byId('simulations-error'), undefined)
  assert.match(h.text(h.byId('simulations-counts')), /19.*19.*19.*2/)
})

test('ID order is literal and case-sensitive, with exact existing result destinations', async t => {
  const originalIds = ['sim_2', 'sim_10', 'sim_a', 'sim_A', 'sim-2', 'Sim_2', 'sim_02']
  const { h } = await loaded(t, originalIds.map(id => record(id)), '/simulations?order=id-asc')
  assert.deepEqual(ids(h), ['Sim_2', 'sim-2', 'sim_02', 'sim_10', 'sim_2', 'sim_A', 'sim_a'])
  await h.click('simulation-activity-sim_A')
  assert.equal(h.router.currentRoute.value.name, 'SavedActivity')
  assert.equal(h.router.currentRoute.value.params.simulationId, 'sim_A')
  assert.deepEqual(h.router.currentRoute.value.query, {})
})

test('order URL rejects null, arrays and unknown tokens without losing valid filters', async t => {
  const originalIds = ['sim_b', 'sim_a']
  const { h } = await loaded(t, originalIds.map(id => record(id)))
  for (const order of ['order', 'order=updated-desc&order=updated-asc', 'order=', 'order=unknown', 'order=server', 'order=%20updated-desc', 'order=ID-ASC']) {
    await h.navigate(`/simulations?q=Saved&status=completed&${order}`)
    assert.equal(h.byId('simulations-order').props.value, '')
    assert.deepEqual(ids(h), originalIds)
    assert.equal(h.byId('simulations-query').props.value, 'Saved')
    assert.equal(h.byId('simulations-status').props.value, 'completed')
    assert.equal(Boolean(h.byId('simulations-url-notice')), order !== 'order=')
  }
  await h.change('simulations-order', 'id-asc')
  assert.deepEqual(h.router.currentRoute.value.query, { q: 'Saved', status: 'completed', order: 'id-asc' })
  assert.equal(h.byId('simulations-url-notice'), undefined)
  assert.deepEqual(ids(h), ['sim_a', 'sim_b'])
})

test('search, status, page, refresh and Back/Forward preserve order; Clear restores every default', async t => {
  const records = Array.from({ length: 45 }, (_, i) => record(`sim_${String(i).padStart(2, '0')}`, `2026-10-01T11:00:${String(i).padStart(2, '0')}Z`))
  records.push(record('stopped', '2026-10-01', { status: 'stopped' }))
  const { h, calls } = await loaded(t, records, '/simulations?q=Saved&status=completed&order=updated-desc&page=2')
  assert.deepEqual(ids(h), records.slice(5, 25).reverse().map(row => row.simulation_id))
  await h.change('simulations-order', 'updated-asc')
  assert.equal(h.router.currentRoute.value.query.page, undefined)
  await h.click('simulations-next')
  assert.deepEqual(h.router.currentRoute.value.query, { q: 'Saved', status: 'completed', order: 'updated-asc', page: '2' })
  await h.input('simulations-query', 'sim_'); await h.click('simulations-search')
  assert.deepEqual(h.router.currentRoute.value.query, { q: 'sim_', status: 'completed', order: 'updated-asc' })
  await h.change('simulations-status', 'stopped')
  assert.deepEqual(h.router.currentRoute.value.query, { q: 'sim_', status: 'stopped', order: 'updated-asc' })
  assert.equal(rows(h).length, 0)
  await h.back(); await h.back()
  assert.equal(h.byId('simulations-query').props.value, 'Saved')
  assert.equal(h.byId('simulations-status').props.value, 'completed')
  assert.equal(h.byId('simulations-order').props.value, 'updated-asc')
  assert.equal(h.router.currentRoute.value.query.page, '2')
  assert.equal(ids(h)[0], 'sim_20')
  await h.back(); await h.back()
  assert.equal(h.byId('simulations-order').props.value, 'updated-desc')
  assert.equal(h.router.currentRoute.value.query.page, '2')
  await h.forward(); await h.forward()
  await h.click('simulations-refresh')
  assert.equal(h.router.currentRoute.value.query.order, 'updated-asc')
  calls.getComparisonCandidates[1].resolve(ok(catalog(records))); await flush()
  assert.equal(ids(h)[0], 'sim_20')
  await h.input('simulations-query', 'unapplied draft')
  await h.click('simulations-clear')
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
  assert.equal(h.byId('simulations-query').props.value, '')
  assert.equal(h.byId('simulations-status').props.value, '')
  assert.equal(h.byId('simulations-order').props.value, '')
  assert.deepEqual(ids(h), records.slice(0, 20).map(row => row.simulation_id))
})

test('latest order applies to pending refreshes and retired responses cannot replace sorted rows', async t => {
  const { h, calls } = await setup(t, '/simulations?order=updated-desc')
  await h.click('simulations-refresh')
  assert.ok(calls.getComparisonCandidates[0].signal.aborted)
  await h.change('simulations-order', 'updated-asc')
  calls.getComparisonCandidates[1].resolve(ok(catalog([record('new', '2026-10-02'), record('old', '2026-10-01')]))); await flush()
  assert.deepEqual(ids(h), ['old', 'new'])
  calls.getComparisonCandidates[0].resolve(ok(catalog([record('retired')]))); await flush()
  assert.deepEqual(ids(h), ['old', 'new'])
  await h.click('simulations-refresh')
  h.unmount()
  assert.ok(calls.getComparisonCandidates[2].signal.aborted)
  calls.getComparisonCandidates[2].reject(new Error('retired secret')); await flush()
  assert.equal(h.root.children.length, 0)
})

test('sorting retains duplicate-ID rejection and both locales explain all order choices', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await loaded(t, [record('same')], '/simulations?order=updated-asc', locale)
    assert.equal(h.byId('simulations-order').children.filter(n => n.type === 'option').length, 4)
    assert.doesNotMatch(h.text(), /savedSimulations\.|comparison\./)
    assert.equal(h.warnings.length, 0)
    await h.click('simulations-refresh')
    calls.getComparisonCandidates[1].resolve(ok(catalog([record('same'), record('same')]))); await flush()
    assert.ok(h.byId('simulations-error'))
    assert.equal(rows(h).length, 0)
    assert.equal(h.byId('simulations-counts'), undefined)
  }
})
