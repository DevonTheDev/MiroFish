import assert from 'node:assert/strict'
import test from 'node:test'
import { watch } from 'vue'
import { build, settle, ok, setupView, setupChild } from './helpers/parent-route-fixture.js'

const savedPlan = id => ({ simulation_id: id, mode: 'local', status: 'ready',
  limits: { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 },
  owner: { busy: false, reason_code: null, task_id: null },
  prepared: { available: true, info: { profiles_count: 2, configured_rounds: 2 } }, can_prepare: false, can_reuse: true })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const start = h => h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
const click = async (h, id) => {
  const button = control(h, id)
  assert.ok(button && !button.props.disabled, id + ' enabled')
  button.props.onClick(); await settle()
}
async function plan(h, id = 'A') {
  pending(h, 'getPreparationPlan').resolve(ok(savedPlan(id))); await settle()
  if (pending(h, 'getEnvStatus')) {
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
    pending(h, 'getSimulation').resolve(ok({ status: 'ready' })); await settle()
  }
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(savedPlan(id))); await settle() }
}
async function reuse(h) {
  await click(h, 'reuse-preparation')
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  return pending(h, 'getSimulationProfilesRealtime')
}
const profileData = (names = ['Saved one', 'Saved two']) => ({ profiles: names.map(name => ({ name, entity_type: 'Person' })) })
async function ready(h, names) {
  pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData(names))); await settle()
  pending(h, 'getSimulationConfigRealtime').resolve(ok({ status: 'ready', is_generating: false, config_generated: true,
    config: { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } } })); await settle()
}
function fail(request, outcome) {
  if (outcome === 'rejected') request.reject(new Error('Synthetic final profile outage /private/details'))
  else if (outcome === 'unsuccessful') request.resolve({ success: false, error: 'Synthetic unsuccessful profiles', data: profileData() })
  else if (outcome === 'missing-data') request.resolve({ success: true })
  else request.resolve({ success: true, data: null })
}

// Removing the terminal failure at the final profile boundary must let config
// loading proceed and fail these assertions. The compiled component, template,
// parent status, router and rendered handlers are all the real application code.
for (const outcome of ['rejected', 'unsuccessful', 'missing-data', 'null-data']) {
  test('final profiles ' + outcome + ' block completion until Refresh plan and explicit Reuse', async () => {
    const h = build({ manualPlan: true, locale: 'en' }), statuses = []
    let stopStatus
    try {
      await h.mount('/simulation/A'); await plan(h)
      stopStatus = watch(() => h.state(setupView).currentStatus, status => statuses.push(status), { flush: 'sync' })
      const request = await reuse(h)
      fail(request, outcome); await settle()
      assert.equal(h.calls('getSimulationConfigRealtime').length, 0, 'failed final profiles must not request final config')
      assert.equal(h.state(setupChild).phase, 0)
      assert.equal(h.state(setupView).currentStatus, 'error')
      assert.equal(h.state(setupChild).planError, 'localPlan.requestError')
      assert.equal(h.state(setupChild).localPlan.prepared.available, true)
      assert.equal(request.signal.aborted, true)
      assert.ok(start(h).props.disabled)
      start(h).props.onClick(); await settle()
      assert.equal(h.calls('startSimulation').length, 0)
      assert.equal(h.router.currentRoute.value.name, 'Simulation')
      assert.ok(!JSON.stringify(h.state(setupView).systemLogs).includes('/private/details'))
      assert.equal(statuses.includes('completed'), false)
      await h.tick(2000); await h.tick(3000)
      assert.equal(h.calls('getSimulationProfilesRealtime').length, 1, 'no automatic final-read retry')
      assert.equal(h.calls('prepareSimulation').length, 1)
      assert.equal(control(h, 'reuse-preparation').props.disabled, true)
      await click(h, 'refresh-plan'); await plan(h)
      assert.equal(h.calls('prepareSimulation').length, 1, 'Refresh only reads the plan')
      await reuse(h); await ready(h)
      assert.deepEqual(h.calls('prepareSimulation').map(call => JSON.parse(JSON.stringify(call.args[0]))), [
        { simulation_id: 'A', preparation_mode: 'reuse' }, { simulation_id: 'A', preparation_mode: 'reuse' },
      ])
      assert.equal(h.calls('previewPreparation').length, 0)
      assert.equal(h.calls('getGraphData').length, 0)
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.equal(statuses.filter(status => status === 'completed').length, 1)
      assert.equal(h.state(setupChild).profiles.length, 2)
      assert.equal(start(h).props.disabled, false)
      assert.deepEqual(h.warnings, [])
    } finally { stopStatus?.(); h.close() }
  })
}

for (const outcome of ['rejected', 'unsuccessful', 'missing-data']) {
  test('cloud final profiles ' + outcome + ' use the existing terminal error path', async () => {
    const h = build(); try {
      await h.mount('/simulation/A')
      pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
      fail(pending(h, 'getSimulationProfilesRealtime'), outcome); await settle()
      assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
      assert.equal(h.state(setupView).currentStatus, 'error')
      assert.ok(start(h).props.disabled)
      start(h).props.onClick(); await settle()
      assert.equal(h.calls('startSimulation').length, 0)
      assert.ok(JSON.stringify(h.state(setupView).systemLogs).includes('log.loadProfilesFailed'))
    } finally { h.close() }
  })
}

test('an explicitly successful empty profile envelope retains the existing completed behavior', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A'); await plan(h); await reuse(h); await ready(h, [])
    assert.equal(h.state(setupChild).profiles.length, 0)
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(h.state(setupView).currentStatus, 'completed')
    assert.equal(start(h).props.disabled, false)
  } finally { h.close() }
})

for (const outcome of ['rejected', 'unsuccessful', 'missing-data', 'success']) {
  test('final profiles ' + outcome + ' cannot overwrite an active cancellation block', async () => {
    const h = build({ manualPlan: true }); try {
      await h.mount('/simulation/A'); await plan(h)
      const request = await reuse(h)
      // Exercise response admission independently of how cancellation was
      // observed. A blocked view must retain ownership of its status and data.
      h.state(setupChild).cancellationBlocked = true
      const before = JSON.stringify(h.state(setupView).systemLogs)
      if (outcome === 'success') request.resolve(ok(profileData()))
      else fail(request, outcome)
      await settle()
      assert.equal(h.state(setupChild).cancellationBlocked, true)
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.state(setupChild).profiles.length, 0)
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.ok(start(h).props.disabled)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}

for (const outcome of ['rejected', 'unsuccessful', 'missing-data']) {
  for (const handoff of [false, true]) test('preview profiles ' + outcome + (handoff ? ' after ready handoff are retired' : ' remain nonterminal'), async () => {
    const h = build(); try {
      await h.mount('/simulation/A')
      pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A' })); await settle()
      await h.tick(3000)
      const preview = pending(h, 'getSimulationProfilesRealtime')
      if (handoff) {
        await h.tick(2000)
        pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
        assert.equal(h.calls('getSimulationProfilesRealtime').length, 1, 'final request waits for preview stream')
      }
      fail(preview, outcome); await settle()
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(h.state(setupChild).planError, '')
      if (!handoff) {
        await h.tick(3000)
        pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData(['Preview']))); await settle()
        assert.equal(h.state(setupChild).profiles[0].name, 'Preview')
        await h.tick(2000)
        pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
      }
      await ready(h)
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.equal(h.state(setupChild).profiles[0].name, 'Saved one')
      assert.equal(h.warnings.length, !handoff && outcome === 'rejected' ? 1 : 0)
    } finally { h.close() }
  })
}

for (const outcome of ['rejected', 'unsuccessful', 'missing-data']) {
  test('retired final profiles ' + outcome + ' cannot overwrite completed A after A → B → A', async () => {
    const h = build({ manualPlan: true }); try {
      await h.mount('/simulation/A'); await plan(h)
      const old = await reuse(h)
      await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await plan(h)
      await reuse(h); await ready(h)
      const before = JSON.stringify(h.state(setupView).systemLogs)
      fail(old, outcome); await settle()
      assert.equal(old.signal.aborted, true)
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.state(setupChild).profiles[0].name, 'Saved one')
      assert.equal(h.calls('getSimulationConfigRealtime').length, 1)
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.equal(start(h).props.disabled, false)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })

  test('final profiles ' + outcome + ' from a retired task cannot fail the current task', async () => {
    const h = build(); try {
      await h.mount('/simulation/A')
      pending(h, 'prepareSimulation').resolve(ok({ task_id: 'old-task' })); await settle()
      await h.tick(2000)
      pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
      const old = pending(h, 'getSimulationProfilesRealtime')
      h.state(setupChild).taskId = 'new-task'
      const before = JSON.stringify(h.state(setupView).systemLogs)
      fail(old, outcome); await settle()
      assert.equal(h.state(setupChild).taskId, 'new-task')
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}
