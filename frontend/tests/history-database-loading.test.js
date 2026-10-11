import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedSimulations, deferredApi, flush, ok } from './helpers/saved-simulations-view-fixture.js'

const messages = {
  en: { error: 'Could not load simulation history. Please try again.', retry: 'Retry loading history', loading: 'Loading...' },
  zh: { error: '无法加载推演记录，请重试。', retry: '重试加载记录', loading: '加载中...' },
}
const unsafe = '/private/history.json token=do-not-display <script>secret</script>'
const record = (id, requirement) => ({
  simulation_id: id, project_id: `project_${id}`, report_id: `report_${id}`,
  simulation_requirement: requirement, created_at: '2026-10-01T10:00:00Z', files: [],
})
const cards = h => h.all(node => node.type === 'div' && String(node.props.class).split(' ').includes('project-card'))
const loading = h => h.find(node => String(node.props.class).split(' ').includes('loading-state'))
const fire = target => target.props.onClick({ stopPropagation() {}, preventDefault() {} })

async function setup(t, { locale = 'en', keepAlive = false } = {}) {
  const d = deferredApi()
  const h = await mountSavedSimulations({ api: d.api, initialPath: '/', locale, keepAlive })
  t.after(() => {
    h.unmount()
    assert.equal(d.calls.getComparisonCandidates.length, 0, 'History recovery must not load another catalog')
    assert.equal(h.networkCalls.length, 0)
    assert.equal(h.storageWrites.length, 0)
    assert.equal(h.downloads.length, 0)
    assert.equal(h.warnings.length, 0, `unexpected Vue warning: ${h.warnings.join('; ')}`)
    for (const request of d.calls.getSimulationHistory) assert.deepEqual(request.args, [20])
  })
  return { ...d, h }
}

function assertFailure(h, locale) {
  const notice = h.byId('history-error'), retry = h.byId('history-retry')
  assert.ok(notice, 'failed Home History reads must have a visible error')
  assert.equal(notice.props.role, 'alert')
  assert.ok(h.text(notice).includes(messages[locale].error))
  assert.equal(retry.type, 'button')
  assert.equal(retry.props.type, 'button')
  assert.equal(h.text(retry), messages[locale].retry)
  assert.doesNotMatch(h.text(), /private|token=|do-not-display|secret|<script>|history\.(loadError|retry)/)
  assert.equal(cards(h).length, 0)
}

for (const locale of ['en', 'zh']) {
  test(`rejected initial Home History read shows a safe localized alert and retry (${locale})`, async t => {
    const { h, calls } = await setup(t, { locale })
    assert.equal(calls.getSimulationHistory.length, 1, 'initial loading must still make a history read')
    assert.equal(h.byId('history-error'), undefined)
    calls.getSimulationHistory[0].reject(new Error(unsafe)); await flush()
    assertFailure(h, locale)
    assert.ok(!h.byId('history-retry').props.disabled)
    assert.equal(loading(h), undefined)
    assert.equal(h.router.currentRoute.value.fullPath, '/')
  })

  test(`resolved success:false Home History read reports failure instead of empty success (${locale})`, async t => {
    const { h, calls } = await setup(t, { locale })
    calls.getSimulationHistory[0].resolve({ success: false, error: unsafe, data: [record('sim_ignored', 'Must not appear')] }); await flush()
    assertFailure(h, locale)
    assert.doesNotMatch(h.text(), /Must not appear/)
    assert.equal(loading(h), undefined)
  })

  test(`successful empty Home History stays distinct from failure (${locale})`, async t => {
    const { h, calls } = await setup(t, { locale })
    calls.getSimulationHistory[0].resolve(ok([])); await flush()
    assert.equal(cards(h).length, 0)
    assert.equal(h.byId('history-error'), undefined)
    assert.equal(h.byId('history-retry'), undefined)
    assert.equal(loading(h), undefined)
    assert.ok(h.find(node => String(node.props.class).split(' ').includes('no-projects')))
  })
}

test('Home mount and KeepAlive activation share one pending history read', async t => {
  const { h, calls } = await setup(t, { keepAlive: true })
  assert.equal(calls.getSimulationHistory.length, 1, 'mount and activation must not issue parallel initial reads')
  calls.getSimulationHistory[0].resolve(ok([record('sim_initial', 'Initial accepted history')])); await flush()
  assert.equal(cards(h).length, 1)
  await h.navigate('/reports'); await h.navigate('/')
  assert.equal(calls.getSimulationHistory.length, 2, 'route entry and activation must share one refresh')
  calls.getSimulationHistory[1].resolve(ok([record('sim_refreshed', 'New accepted history')])); await flush()
  assert.equal(cards(h).length, 1)
  assert.match(h.text(), /New accepted history/)
  assert.doesNotMatch(h.text(), /Initial accepted history/)
})

test('pending retry keeps its notice and disabled button while duplicate clicks and route activation share one read', async t => {
  const { h, calls } = await setup(t, { keepAlive: true })
  for (const request of calls.getSimulationHistory) request.resolve({ success: false, error: unsafe })
  await flush(); assertFailure(h, 'en')
  const before = calls.getSimulationHistory.length
  const retry = h.byId('history-retry')
  fire(retry); fire(retry); await flush()
  assert.equal(calls.getSimulationHistory.length, before + 1, 'rapid clicks must only issue one retry read')
  assertFailure(h, 'en')
  assert.equal(h.byId('history-retry').props.disabled, true)
  assert.equal(loading(h).props.role, 'status')
  assert.equal(h.text(loading(h)).trim(), messages.en.loading)
  assert.equal(h.router.currentRoute.value.fullPath, '/')
  fire(retry); await flush()
  await h.navigate('/reports'); await h.navigate('/')
  assert.equal(calls.getSimulationHistory.length, before + 1, 'pending retry must also guard route entry and activation')
  calls.getSimulationHistory[before].resolve(ok([])); await flush()
  assert.equal(h.byId('history-error'), undefined)
  assert.equal(h.byId('history-retry'), undefined)
  assert.equal(loading(h), undefined)
})

test('successful retry restores exact returned cards and preserves selected-card navigation', async t => {
  const { h, calls } = await setup(t)
  calls.getSimulationHistory[0].reject(new Error(unsafe)); await flush()
  assertFailure(h, 'en')
  await h.click('history-retry')
  assert.equal(calls.getSimulationHistory.length, 2)
  const records = [record('sim_Exact-ID_35', 'Recovered first scenario'), record('sim_SECOND', 'Recovered second scenario')]
  calls.getSimulationHistory[1].resolve(ok(records)); await flush()
  assert.equal(h.byId('history-error'), undefined)
  assert.equal(h.byId('history-retry'), undefined)
  assert.equal(loading(h), undefined)
  assert.equal(cards(h).length, 2)
  assert.match(h.text(cards(h)[0]), /Recovered first scenario/)
  assert.match(h.text(cards(h)[1]), /Recovered second scenario/)
  fire(cards(h)[0]); await flush()
  assert.match(h.text(h.body), /Recovered first scenario/)
  await h.click('history-saved-activity')
  assert.equal(h.router.currentRoute.value.name, 'SavedActivity')
  assert.equal(h.router.currentRoute.value.params.simulationId, records[0].simulation_id)
  assert.equal(Object.keys(h.router.currentRoute.value.query).length, 0)
  assert.equal(calls.getSimulationHistory.length, 2)
})

for (const mode of ['rejected', 'success:false']) {
  test(`failed ${mode} reload clears previously accepted cards and can recover again`, async t => {
    const { h, calls } = await setup(t, { keepAlive: true })
    for (const request of calls.getSimulationHistory) request.resolve(ok([record('sim_old', 'Previously accepted scenario')]))
    await flush(); assert.equal(cards(h).length, 1)
    const before = calls.getSimulationHistory.length
    await h.navigate('/reports'); await h.navigate('/')
    assert.equal(cards(h).length, 1, 'existing cards remain available until the refresh result arrives')
    for (const request of calls.getSimulationHistory.slice(before)) {
      if (mode === 'rejected') request.reject(new Error(unsafe))
      else request.resolve({ success: false, error: unsafe })
    }
    await flush(); assertFailure(h, 'en')
    assert.doesNotMatch(h.text(), /Previously accepted scenario/)
    const failedCount = calls.getSimulationHistory.length
    await h.click('history-retry')
    assert.equal(calls.getSimulationHistory.length, failedCount + 1)
    calls.getSimulationHistory[failedCount].resolve(ok([record('sim_new', 'Recovered after reload')])); await flush()
    assert.equal(cards(h).length, 1)
    assert.equal(h.byId('history-error'), undefined)
    assert.match(h.text(), /Recovered after reload/)
  })
}
