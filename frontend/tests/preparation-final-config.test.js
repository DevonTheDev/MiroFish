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
const configData = () => ({ status: 'ready', is_generating: false, config_generated: true,
  config: { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } } })
const missingConfig = outcome => outcome === 'missing-data' ? { success: true } : { success: true, data: null }
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
async function finalConfig(h) {
  pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [{ name: 'Saved one' }, { name: 'Saved two' }] })); await settle()
  const request = pending(h, 'getSimulationConfigRealtime')
  assert.ok(request, 'final config read requested after profiles')
  return request
}
async function reuse(h) {
  await click(h, 'reuse-preparation')
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  // A terminal/reuse reply needs current idle admission before final reads.
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(savedPlan(h.state(setupChild).simulationId || h.child(setupChild).props.simulationId))); await settle() }
  return finalConfig(h)
}
async function ready(h) {
  pending(h, 'getSimulationConfigRealtime').resolve(ok(configData())); await settle()
}

// Removing the final-envelope failure must strand phase 2 and fail these
// recovery assertions. The component, rendered controls, parent and router are
// real; malformed accepted API replies are injected at the HTTP boundary.
for (const outcome of ['missing-data', 'null-data', 'rejected']) {
  test('final config ' + outcome + ' unlocks Refresh plan and requires explicit Reuse to recover', async () => {
    const h = build({ manualPlan: true, locale: 'en' }), statuses = []
    let stopStatus
    try {
      await h.mount('/simulation/A'); await plan(h)
      stopStatus = watch(() => h.state(setupView).currentStatus, status => statuses.push(status), { flush: 'sync' })
      const request = await reuse(h)
      const renderedStart = start(h).props.onClick
      assert.equal(typeof renderedStart, 'function', 'capture the actual rendered Start callback before failure')
      if (outcome === 'rejected') request.reject(new Error('Synthetic config failure /private/details'))
      else request.resolve(missingConfig(outcome))
      await settle()
      assert.equal(control(h, 'refresh-plan').props.disabled, false, 'final config failure must release Refresh plan')
      assert.equal(h.state(setupChild).phase, 0)
      assert.equal(h.state(setupView).currentStatus, 'error')
      assert.equal(h.state(setupChild).planError, 'localPlan.requestError')
      assert.equal(h.state(setupChild).localPlan.prepared.available, true)
      assert.equal(h.state(setupChild).simulationConfig, null)
      assert.equal(request.signal.aborted, true)
      assert.equal(h.intervals.size, 0)
      assert.ok(!start(h) || start(h).props.disabled, 'Start is absent or disabled after local final-data failure')
      renderedStart(); await settle()
      assert.equal(h.calls('startSimulation').length, 0)
      assert.equal(h.router.currentRoute.value.name, 'Simulation')
      assert.ok(!JSON.stringify(h.state(setupView).systemLogs).includes('/private/details'))
      assert.equal(statuses.includes('completed'), false)
      await h.tick(2000); await h.tick(3000)
      assert.equal(h.calls('getSimulationConfigRealtime').length, 1, 'no automatic final-read retry')
      assert.equal(h.calls('prepareSimulation').length, 1)
      assert.equal(control(h, 'reuse-preparation').props.disabled, true)
      await click(h, 'refresh-plan'); await plan(h)
      assert.equal(h.calls('prepareSimulation').length, 1, 'Refresh only reads the plan')
      assert.equal(h.calls('getSimulationProfilesRealtime').length, 1)
      assert.equal(h.calls('getSimulationConfigRealtime').length, 1)
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
      assert.equal(h.state(setupChild).simulationConfig.time_config.total_simulation_hours, 1)
      assert.equal(start(h).props.disabled, false)
      assert.deepEqual(h.warnings, [])
    } finally { stopStatus?.(); h.close() }
  })
}

for (const outcome of ['missing-data', 'null-data']) {
  test('cloud final config ' + outcome + ' uses the existing terminal config-load error', async () => {
    const h = build(); try {
      await h.mount('/simulation/A')
      pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
      const request = await finalConfig(h)
      request.resolve(missingConfig(outcome)); await settle()
      assert.equal(h.state(setupView).currentStatus, 'error')
      assert.equal(request.signal.aborted, true)
      assert.ok(start(h).props.disabled)
      start(h).props.onClick(); await settle()
      assert.equal(h.calls('startSimulation').length, 0)
      assert.ok(JSON.stringify(h.state(setupView).systemLogs).includes('log.loadConfigFailed'))
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })

  test('retired final config ' + outcome + ' cannot overwrite completed A after A → B → A', async () => {
    const h = build({ manualPlan: true }); try {
      await h.mount('/simulation/A'); await plan(h)
      const old = await reuse(h)
      await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await plan(h)
      await reuse(h); await ready(h)
      const before = JSON.stringify(h.state(setupView).systemLogs)
      old.resolve(missingConfig(outcome)); await settle()
      assert.equal(old.signal.aborted, true)
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.state(setupChild).simulationConfig.time_config.total_simulation_hours, 1)
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.equal(start(h).props.disabled, false)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })

  test('final config ' + outcome + ' from a retired task cannot fail the current task', async () => {
    const h = build(); try {
      await h.mount('/simulation/A')
      pending(h, 'prepareSimulation').resolve(ok({ task_id: 'old-task' })); await settle()
      await h.tick(2000)
      pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
      const old = await finalConfig(h)
      h.state(setupChild).taskId = 'new-task'
      const before = JSON.stringify(h.state(setupView).systemLogs)
      old.resolve(missingConfig(outcome)); await settle()
      assert.equal(h.state(setupChild).taskId, 'new-task')
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.state(setupChild).simulationConfig, null)
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })

  test('unmounted final config ' + outcome + ' cannot publish an error', async () => {
    const h = build({ manualPlan: true }); try {
      await h.mount('/simulation/A'); await plan(h)
      const old = await reuse(h)
      h.close()
      const before = JSON.stringify(h.state(setupView).systemLogs)
      old.resolve(missingConfig(outcome)); await settle()
      assert.equal(old.signal.aborted, true)
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.equal(h.intervals.size, 0)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })

  for (const handoff of [false, true]) test('config preview ' + outcome + (handoff ? ' is retired at ready handoff' : ' stays nonterminal and allows the next preview'), async () => {
    const h = build(); try {
      await h.mount('/simulation/A')
      pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A' })); await settle()
      await h.tick(2000)
      pending(h, 'getPrepareStatus').resolve(ok({ status: 'processing', progress_detail: { current_stage_name: 'generating_config' } })); await settle()
      await h.tick(2000)
      const preview = pending(h, 'getSimulationConfigRealtime')
      if (handoff) {
        pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
        pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [] })); await settle()
        assert.equal(h.calls('getSimulationConfigRealtime').length, 1, 'final config waits for preview stream')
      }
      preview.resolve(missingConfig(outcome)); await settle()
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.state(setupChild).simulationConfig, null)
      if (!handoff) {
        assert.ok(h.intervals.size > 0)
        await h.tick(2000)
        pending(h, 'getSimulationConfigRealtime').resolve(ok({ ...configData(), status: 'preparing', is_generating: true })); await settle()
        assert.equal(h.state(setupChild).simulationConfig.time_config.total_simulation_hours, 1)
        assert.equal(h.state(setupView).currentStatus, 'processing')
        assert.ok(start(h).props.disabled)
        pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
        await finalConfig(h)
      }
      await ready(h)
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.equal(start(h).props.disabled, false)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}

for (const outcome of ['missing-data', 'null-data', 'success']) {
  test('final config ' + outcome + ' cannot overwrite an active cancellation block', async () => {
    const h = build({ manualPlan: true }); try {
      await h.mount('/simulation/A'); await plan(h)
      const request = await reuse(h)
      // Exercise admission independently of how cancellation was observed.
      h.state(setupChild).cancellationBlocked = true
      const before = JSON.stringify(h.state(setupView).systemLogs)
      request.resolve(outcome === 'success' ? ok(configData()) : missingConfig(outcome)); await settle()
      assert.equal(h.state(setupChild).cancellationBlocked, true)
      assert.equal(h.state(setupChild).planError, '')
      assert.equal(h.state(setupChild).simulationConfig, null)
      assert.equal(h.state(setupView).currentStatus, 'processing')
      assert.equal(JSON.stringify(h.state(setupView).systemLogs), before)
      assert.ok(start(h).props.disabled)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}

test('valid final config still generating is observed until one usable completion', async () => {
  const h = build({ manualPlan: true }), statuses = []
  let stopStatus
  try {
    await h.mount('/simulation/A'); await plan(h)
    stopStatus = watch(() => h.state(setupView).currentStatus, status => statuses.push(status), { flush: 'sync' })
    const first = await reuse(h)
    first.resolve(ok({ ...configData(), status: 'preparing', is_generating: true })); await settle()
    assert.equal(h.state(setupView).currentStatus, 'processing')
    assert.equal(h.state(setupChild).simulationConfig, null)
    assert.ok(start(h).props.disabled)
    await h.tick(2000); await finalConfig(h); await ready(h)
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(h.state(setupView).currentStatus, 'completed')
    assert.equal(statuses.filter(status => status === 'completed').length, 1)
    assert.equal(h.calls('prepareSimulation').length, 1)
    assert.equal(h.calls('getSimulationConfigRealtime').length, 2)
    assert.equal(h.intervals.size, 0)
    assert.equal(start(h).props.disabled, false)
    assert.deepEqual(h.warnings, [])
  } finally { stopStatus?.(); h.close() }
})
