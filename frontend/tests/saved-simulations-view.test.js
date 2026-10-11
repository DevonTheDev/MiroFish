import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedSimulations, deferredApi, flush, ok } from './helpers/saved-simulations-view-fixture.js'

const saved = (n = 35) => ({ candidates: Array.from({ length: n }, (_, i) => ({
  simulation_id: `sim_${String(i + 1).padStart(2, '0')}`,
  project_id: `project_${i + 1}`, scenario: `Scenario ${i + 1}`,
  status: i % 2 ? 'completed' : 'stopped',
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T11:00:00Z'
})), skipped_records: 2 })
async function setup(t, initialPath = '/simulations', locale = 'en') {
  const d = deferredApi()
  const h = await mountSavedSimulations({ api: d.api, initialPath, locale })
  t.after(() => h.unmount())
  return { ...d, h }
}
async function loaded(t, path, data = saved(), locale) {
  const d = await setup(t, path, locale)
  assert.equal(d.calls.getComparisonCandidates.length, 1, 'Saved simulations must load the complete existing metadata catalog')
  d.calls.getComparisonCandidates[0].resolve(ok(data)); await flush()
  return d
}
const rows = h => h.all(n => n.props['data-testid'] === 'simulation-row')

test('35-record history fixture reproduces the first-20 discovery gap and provides a full-catalog entry', async t => {
  const { h, calls } = await setup(t, '/')
  const records = saved().candidates.map(row => ({ ...row, simulation_requirement: row.scenario }))
  assert.equal(calls.getSimulationHistory[0].args[0], 20)
  calls.getSimulationHistory[0].resolve(ok(records.slice(0, calls.getSimulationHistory[0].args[0]))); await flush()
  assert.equal(h.all(n => n.type === 'div' && String(n.props.class).split(' ').includes('project-card')).length, 20)
  assert.doesNotMatch(h.text(), /Scenario 35/)
  await h.click('history-simulations')
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
  calls.getComparisonCandidates[0].resolve(ok(saved())); await flush()
  await h.click('simulations-next')
  assert.match(h.text(), /Scenario 35/)
  await h.navigate('/')
  await h.click('saved-simulations-link')
  assert.equal(h.router.currentRoute.value.fullPath, '/simulations')
})

test('catalog preserves service order, pages all 35 healthy records and states honest counts and limits', async t => {
  const { h, calls } = await loaded(t)
  assert.equal(rows(h).length, 20)
  assert.match(h.text(h.byId('simulations-counts')), /1–20.*35.*35.*2/)
  assert.match(h.text(), /saved update time/i)
  assert.match(h.text(), /client-side/i)
  assert.match(h.text(), /not a live status/i)
  assert.ok(h.byId('simulations-previous').props.disabled)
  await h.click('simulations-next')
  assert.equal(h.router.currentRoute.value.query.page, '2')
  assert.equal(rows(h).length, 15)
  assert.match(h.text(rows(h)[0]), /sim_21/)
  assert.match(h.text(h.byId('simulations-counts')), /21–35.*35.*35.*2/)
  assert.ok(h.byId('simulations-next').props.disabled)
  assert.equal(calls.getComparisonCandidates.length, 1)
  assert.equal(h.warnings.length, 0)
})

test('literal case-insensitive Unicode and punctuation search covers IDs, project IDs and scenarios safely', async t => {
  const data = saved()
  data.candidates[34].scenario = 'ÉLAN 中文 [A+B].* <script>alert(1)</script>'
  const { h } = await loaded(t, '/simulations?page=2', data)
  for (const query of ['SIM_35', 'PROJECT_35', 'élan 中文 [a+b].*', '<script>']) {
    await h.input('simulations-query', query); await h.click('simulations-search')
    assert.equal(h.router.currentRoute.value.query.q, query)
    assert.equal(h.router.currentRoute.value.query.page, undefined)
    assert.equal(rows(h).length, 1)
    assert.match(h.text(rows(h)[0]), /sim_35/)
  }
  assert.equal(h.all(n => n.type === 'script').length, 0)
  await h.input('simulations-query', '[.*not a regex'); await h.click('simulations-search')
  assert.equal(rows(h).length, 0)
  assert.match(h.text(), /No saved simulations match/i)
})

test('filters reset paging and real router Back/Forward restores query, status and page', async t => {
  const { h } = await loaded(t, '/simulations?page=2')
  await h.input('simulations-query', 'Scenario'); await h.click('simulations-search')
  assert.equal(h.router.currentRoute.value.query.page, undefined)
  await h.change('simulations-status', 'completed')
  assert.equal(rows(h).length, 17)
  assert.equal(h.router.currentRoute.value.query.status, 'completed')
  await h.back()
  assert.equal(h.byId('simulations-status').props.value, '')
  assert.equal(h.byId('simulations-query').props.value, 'Scenario')
  await h.back()
  assert.equal(h.byId('simulations-query').props.value, '')
  assert.equal(rows(h).length, 15)
  assert.match(h.text(rows(h)[0]), /sim_21/)
  await h.forward(); await h.forward()
  assert.equal(h.byId('simulations-status').props.value, 'completed')
  assert.equal(rows(h).length, 17)
})

test('malformed URL values default safely, out-of-range pages clamp, and empty catalog is clear', async t => {
  const { h } = await loaded(t, '/simulations?q=a&q=b&status=untrusted&page=1e99')
  assert.equal(h.byId('simulations-query').props.value, '')
  assert.equal(h.byId('simulations-status').props.value, '')
  assert.equal(rows(h).length, 20)
  assert.ok(h.byId('simulations-url-notice'))
  for (const page of ['0', '-1', 'NaN', '1.2', '999999999999999999999999']) {
    await h.navigate(`/simulations?page=${page}`)
    assert.equal(rows(h).length, 20)
    assert.ok(h.byId('simulations-url-notice'))
  }
  await h.navigate('/simulations?page=999')
  assert.equal(rows(h).length, 15)
  assert.match(h.text(h.byId('simulations-page')), /2.*2/)
  assert.ok(h.byId('simulations-url-notice'))
  await h.navigate('/simulations?q=&status=&page=')
  assert.equal(rows(h).length, 20)
  assert.equal(h.byId('simulations-url-notice'), undefined)
})

test('empty catalog and unknown statuses remain factual in English and Chinese', async t => {
  for (const locale of ['en', 'zh']) {
    const { h } = await loaded(t, '/simulations', { candidates: [], skipped_records: 3 }, locale)
    assert.equal(rows(h).length, 0)
    assert.match(h.text(h.byId('simulations-counts')), /0.*0.*0.*3/)
    assert.ok(h.byId('simulations-empty'))
    assert.doesNotMatch(h.text(), /savedSimulations\.|comparison\./)
    assert.equal(h.warnings.length, 0)
  }
  const data = saved(1); data.candidates[0].status = 'unknown'
  const { h } = await loaded(t, '/simulations?status=unknown', data)
  assert.match(h.text(rows(h)[0]), /Unknown/)
})

test('each result action uses the exact simulation ID and the actual existing route contract', async t => {
  const id = 'sim_Exact-ID_35'
  const destinations = [
    ['activity', 'SavedActivity', 'simulationId', id],
    ['interviews', 'SavedInterviews', 'simulationId', id],
    ['compare', 'SimulationComparison', 'left', id],
    ['captures', 'RunCaptures', 'simulation', id]
  ]
  for (const [action, name, key, value] of destinations) {
    const data = saved(1); data.candidates[0].simulation_id = id
    const { h } = await loaded(t, '/simulations', data)
    await h.click(`simulation-${action}-${id}`)
    assert.equal(h.router.currentRoute.value.name, name)
    const selection = ['activity', 'interviews'].includes(action) ? h.router.currentRoute.value.params : h.router.currentRoute.value.query
    assert.equal(selection[key], value)
    assert.equal(Object.keys(h.router.currentRoute.value.query).length, ['activity', 'interviews'].includes(action) ? 0 : 1)
  }
})

test('refresh retires an ignored-abort response, safe errors clear old rows, and retry recovers', async t => {
  const { h, calls } = await setup(t)
  await h.click('simulations-refresh')
  assert.equal(calls.getComparisonCandidates[0].signal.aborted, true)
  calls.getComparisonCandidates[1].resolve(ok(saved(1))); await flush()
  calls.getComparisonCandidates[0].resolve(ok(saved(35))); await flush()
  assert.equal(rows(h).length, 1)
  await h.click('simulations-refresh')
  assert.equal(rows(h).length, 0)
  calls.getComparisonCandidates[2].reject(new Error('/secret/path token')); await flush()
  assert.ok(h.byId('simulations-error'))
  assert.doesNotMatch(h.text(), /secret|token/)
  await h.click('simulations-retry')
  calls.getComparisonCandidates[3].resolve(ok(saved(35))); await flush()
  assert.equal(rows(h).length, 20)
})

test('navigation and unmount retire outstanding reads and ignore their delayed failures', async t => {
  const { h, calls } = await setup(t)
  const retired = calls.getComparisonCandidates[0]
  await h.navigate('/reports')
  assert.ok(retired.signal.aborted)
  await h.navigate('/simulations')
  calls.getComparisonCandidates[1].resolve(ok(saved(1))); await flush()
  retired.reject(new Error('retired secret')); await flush()
  assert.equal(rows(h).length, 1)
  assert.equal(h.byId('simulations-error'), undefined)
  await h.click('simulations-refresh')
  h.unmount()
  assert.ok(calls.getComparisonCandidates[2].signal.aborted)
  calls.getComparisonCandidates[2].resolve(ok(saved())); await flush()
  assert.equal(h.root.children.length, 0)
})

test('invalid candidate responses fail safely without publishing false totals or unsafe IDs', async t => {
  for (const data of [{ candidates: 'bad', skipped_records: 0 }, { ...saved(1), skipped_records: -1 },
    { candidates: [{ ...saved(1).candidates[0], simulation_id: '../escape' }], skipped_records: 0 }]) {
    const { h, calls } = await setup(t)
    calls.getComparisonCandidates[0].resolve(ok(data)); await flush()
    assert.ok(h.byId('simulations-error'))
    assert.equal(rows(h).length, 0)
    assert.equal(h.byId('simulations-counts'), undefined)
  }
})

test('clearing an unapplied search and history navigation restore the actual URL query', async t => {
  const { h } = await loaded(t)
  await h.input('simulations-query', 'unapplied draft')
  await h.click('simulations-clear')
  assert.equal(h.byId('simulations-query').props.value, '')
  await h.click('simulations-next')
  await h.input('simulations-query', 'another unapplied draft')
  await h.back()
  assert.equal(h.byId('simulations-query').props.value, '')
  await h.forward()
  await h.change('simulations-status', 'completed')
  assert.equal(h.router.currentRoute.value.query.page, undefined)
  assert.equal(rows(h).length, 17)
})

test('pending reads use the newest URL filters; nullable fields and hostile project text remain literal', async t => {
  const { h, calls } = await setup(t)
  await h.navigate('/simulations?q=%3Cimg&status=completed&page=2')
  const data = saved(1)
  Object.assign(data.candidates[0], { project_id: '<img src=x onerror=alert(1)>', status: 'completed', scenario: '', updated_at: null, created_at: null })
  calls.getComparisonCandidates[0].resolve(ok(data)); await flush()
  assert.equal(rows(h).length, 1)
  assert.ok(h.text(rows(h)[0]).includes('<img src=x onerror=alert(1)>'))
  assert.match(h.text(rows(h)[0]), /No saved scenario/)
  assert.ok(h.text(rows(h)[0]).includes('—'))
  assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0)
  assert.equal(calls.getComparisonCandidates.length, 1)
})
