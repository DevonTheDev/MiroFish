import assert from 'node:assert/strict'
import test from 'node:test'
import { watch } from 'vue'
import { build, settle, ok, setupView, setupChild } from './helpers/parent-route-fixture.js'

const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const start = h => h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
const back = h => h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn secondary'))
const fixture = () => build({ manualPlan: true, locale: 'en', disableTransitions: true })
const profileData = name => ({ profiles: [{ name: name || 'Current saved agent', entity_type: 'Person' }], total_expected: 1 })
const configData = (extra = {}) => ({ status: 'ready', is_generating: false, config_generated: true,
  config: { time_config: { total_simulation_hours: 10, minutes_per_round: 30 } }, ...extra })
const replayNames = ['getPreparationPlan', 'prepareSimulation', 'previewPreparation', 'startSimulation',
  'cancelPreparation', 'stopSimulation', 'closeSimulationEnv']
const replayCounts = h => Object.fromEntries(replayNames.map(name => [name, h.calls(name).length]))
const counts = h => Object.fromEntries(Object.keys(h.requests).sort().map(name => [name, h.calls(name).length]))
const snapshot = h => JSON.stringify({ route: h.router.currentRoute.value.fullPath,
  status: h.state(setupView).currentStatus, phase: h.state(setupChild).phase,
  profiles: h.state(setupChild).profiles, config: h.state(setupChild).simulationConfig,
  custom: h.state(setupChild).useCustomRounds, rounds: h.state(setupChild).customMaxRounds,
  logs: h.state(setupView).systemLogs, requests: counts(h), timers: h.intervals.size })
const retry = h => {
  const button = control(h, 'retry-prepared-data')
  assert.ok(button, 'explicit prepared-data retry control exists')
  assert.equal(button.props.disabled, false, 'prepared-data retry is available')
  return button.props.onClick
}
async function plan(h, id = 'A') {
  const request = pending(h, 'getPreparationPlan')
  assert.ok(request, 'explicit cloud plan request is recorded')
  request.resolve(ok({ simulation_id: id, mode: 'cloud' })); await settle()
}
async function boot(h, prepared = true) {
  await h.mount('/simulation/A'); await plan(h)
  pending(h, 'prepareSimulation').resolve(ok(prepared ? { already_prepared: true } : { task_id: 'task-A' }))
  await settle()
}
async function failFinal(h, stage = 'profiles') {
  await boot(h)
  if (stage === 'config') {
    pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData())); await settle()
    pending(h, 'getSimulationConfigRealtime').resolve({ success: true })
  } else pending(h, 'getSimulationProfilesRealtime').reject(new Error('Synthetic final profile outage'))
  await settle()
  assert.equal(h.state(setupView).currentStatus, 'error')
  assert.equal(start(h).props.disabled, true)
  return retry(h)
}
async function beginRetry(h, callback = retry(h)) {
  const before = replayCounts(h)
  callback(); await settle()
  const request = pending(h, 'getPrepareStatus')
  assert.ok(request, 'retry checks preparation readiness')
  assert.deepEqual(JSON.parse(JSON.stringify(request.args[0])), { simulation_id: 'A' })
  assert.equal(request.signal.aborted, false)
  assert.equal(control(h, 'retry-prepared-data').props.disabled, true)
  assert.equal(start(h).props.disabled, true)
  assert.equal(h.state(setupView).currentStatus, 'processing')
  assert.deepEqual(replayCounts(h), before, 'retry does not replay preparation, planning, or simulation actions')
  return request
}
async function confirmReady(h, request = pending(h, 'getPrepareStatus')) {
  request.resolve(ok({ simulation_id: 'A', status: 'ready', already_prepared: true })); await settle()
  assert.ok(pending(h, 'getSimulationProfilesRealtime'))
}
async function finishFinal(h, name) {
  pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData(name))); await settle()
  assert.equal(start(h).props.disabled, true)
  pending(h, 'getSimulationConfigRealtime').resolve(ok(configData())); await settle()
  assert.equal(h.state(setupView).currentStatus, 'completed')
  assert.equal(h.state(setupChild).phase, 4)
  assert.equal(start(h).props.disabled, false)
  assert.equal(control(h, 'retry-prepared-data'), undefined)
  assert.equal(h.intervals.size, 0)
}
async function replaceWithReadyA(h) {
  await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await plan(h)
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  await finishFinal(h, 'Replacement A')
}

test('cloud prepared-data retry: profile failure recovers and preserves custom rounds', async () => {
  const h = fixture(); try {
    await boot(h, false); await h.tick(2000)
    pending(h, 'getPrepareStatus').resolve(ok({ status: 'processing', progress_detail: { current_stage_name: 'generating_config' } })); await settle()
    await h.tick(2000)
    pending(h, 'getSimulationConfigRealtime').resolve(ok(configData({ status: 'preparing', is_generating: true }))); await settle()
    h.state(setupChild).useCustomRounds = true; h.state(setupChild).customMaxRounds = 35
    pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
    const oldProfiles = pending(h, 'getSimulationProfilesRealtime')
    oldProfiles.reject(new Error('Synthetic final profile outage')); await settle()
    const callback = retry(h), oldStart = start(h).props.onClick, before = replayCounts(h)
    await h.tick(2000); await h.tick(3000)
    assert.deepEqual(replayCounts(h), before)
    const request = await beginRetry(h, callback)
    assert.notEqual(request.signal, oldProfiles.signal)
    assert.equal(oldProfiles.signal.aborted, true)
    oldStart(); await settle(); assert.equal(h.router.currentRoute.value.name, 'Simulation')
    await confirmReady(h, request); await finishFinal(h)
    assert.equal(h.state(setupChild).useCustomRounds, true)
    assert.equal(h.state(setupChild).customMaxRounds, 35)
    const complete = snapshot(h); oldStart(); await settle(); assert.equal(snapshot(h), complete)
    assert.deepEqual(replayCounts(h), before)
    start(h).props.onClick(); await h.pushes.at(-1).promise; await settle()
    assert.equal(h.router.currentRoute.value.name, 'SimulationRun')
    assert.equal(h.router.currentRoute.value.query.maxRounds, '35')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('cloud prepared-data retry: missing config recovers only after both fresh reads', async () => {
  const h = fixture(); try {
    const callback = await failFinal(h, 'config'), oldBack = back(h).props.onClick, before = replayCounts(h)
    const request = await beginRetry(h, callback)
    oldBack(); await settle(); assert.equal(h.router.currentRoute.value.name, 'Simulation')
    await confirmReady(h, request)
    assert.equal(h.state(setupChild).simulationConfig, null)
    assert.equal(start(h).props.disabled, true)
    await finishFinal(h)
    const complete = snapshot(h); oldBack(); await settle(); assert.equal(snapshot(h), complete)
    assert.deepEqual(replayCounts(h), before)
    back(h).props.onClick(); await h.pushes.at(-1).promise; await settle()
    assert.equal(h.router.currentRoute.value.name, 'Home')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('cloud prepared-data retry: repeated clicks stay single-flight through every read', async () => {
  const h = fixture(), statuses = []; let stop
  try {
    const old = await failFinal(h), before = replayCounts(h)
    stop = watch(() => h.state(setupView).currentStatus, status => statuses.push(status), { flush: 'sync' })
    old(); old(); await settle()
    assert.equal(h.calls('getPrepareStatus').length, 1)
    const busy = control(h, 'retry-prepared-data').props.onClick
    busy(); old(); await settle(); assert.equal(h.calls('getPrepareStatus').length, 1)
    await confirmReady(h)
    busy(); old(); await settle(); assert.equal(h.calls('getSimulationProfilesRealtime').length, 2)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData())); await settle()
    busy(); await settle(); assert.equal(h.calls('getSimulationConfigRealtime').length, 1)
    pending(h, 'getSimulationConfigRealtime').resolve(ok(configData({ status: 'preparing', is_generating: true }))); await settle()
    assert.equal(control(h, 'retry-prepared-data').props.disabled, true, 'retry stays busy while final config polling continues')
    assert.equal(start(h).props.disabled, true)
    assert.ok(h.intervals.size > 0)
    busy(); old(); await settle(); assert.equal(h.calls('getPrepareStatus').length, 1)
    await h.tick(2000); await finishFinal(h)
    assert.deepEqual(statuses, ['processing', 'completed'])
    assert.deepEqual(replayCounts(h), before)
    assert.deepEqual(h.warnings, [])
  } finally { stop?.(); h.close() }
})

test('cloud prepared-data retry: another final failure permits one fresh explicit retry', async () => {
  const h = fixture(); try {
    const old = await failFinal(h), before = replayCounts(h)
    const firstStatus = await beginRetry(h, old); await confirmReady(h, firstStatus)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData())); await settle()
    const firstConfig = pending(h, 'getSimulationConfigRealtime')
    firstConfig.reject(new Error('Synthetic retry config outage')); await settle()
    const current = retry(h)
    assert.equal(firstStatus.signal.aborted, true)
    const secondStatus = await beginRetry(h, current)
    old(); current(); await settle(); assert.equal(h.calls('getPrepareStatus').length, 2)
    assert.notEqual(secondStatus.signal, firstStatus.signal)
    await confirmReady(h, secondStatus); await finishFinal(h)
    assert.deepEqual(replayCounts(h), before)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('cloud prepared-data retry: readiness transport failure permits a later retry', async () => {
  const h = fixture(); try {
    const old = await failFinal(h), before = replayCounts(h), profiles = h.calls('getSimulationProfilesRealtime').length
    const first = await beginRetry(h, old)
    first.reject(new Error('Synthetic status outage')); await settle()
    assert.equal(h.state(setupView).currentStatus, 'error')
    assert.equal(start(h).props.disabled, true)
    assert.equal(h.calls('getSimulationProfilesRealtime').length, profiles)
    assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
    assert.equal(h.intervals.size, 0)
    const request = await beginRetry(h, retry(h)); await confirmReady(h, request); await finishFinal(h)
    assert.deepEqual(replayCounts(h), before)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

for (const [label, data] of [
  ['not-started', { simulation_id: 'A', status: 'not_started', already_prepared: false }],
  ['mismatched simulation', { simulation_id: 'B', status: 'ready', already_prepared: true }],
  ['historical completed-only', { simulation_id: 'A', status: 'completed', already_prepared: false }],
]) test('cloud prepared-data retry: ' + label + ' readiness blocks final reads', async () => {
  const h = fixture(); try {
    const old = await failFinal(h), before = replayCounts(h)
    h.state(setupChild).useCustomRounds = true; h.state(setupChild).customMaxRounds = 30
    const request = await beginRetry(h, old), profiles = h.calls('getSimulationProfilesRealtime').length
    request.resolve(ok(data)); await settle()
    assert.equal(h.state(setupView).currentStatus, 'error')
    assert.equal(start(h).props.disabled, true)
    assert.equal(h.state(setupChild).useCustomRounds, true)
    assert.equal(h.state(setupChild).customMaxRounds, 30)
    assert.equal(h.calls('getSimulationProfilesRealtime').length, profiles)
    assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
    retry(h)
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.intervals.size, 0)
    assert.equal(h.calls('getPrepareStatus').length, 1)
    assert.deepEqual(replayCounts(h), before)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('cloud prepared-data retry: old readiness and handlers retire across A to B to A', async () => {
  const h = fixture(); try {
    const old = await failFinal(h), oldStart = start(h).props.onClick, oldBack = back(h).props.onClick
    const request = await beginRetry(h, old), busy = control(h, 'retry-prepared-data').props.onClick
    await replaceWithReadyA(h)
    const current = snapshot(h)
    old(); busy(); oldStart(); oldBack()
    request.resolve(ok({ simulation_id: 'A', status: 'ready', already_prepared: true })); await settle()
    assert.equal(request.signal.aborted, true)
    assert.equal(snapshot(h), current)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('cloud prepared-data retry: old final config cannot overwrite completed replacement A', async () => {
  const h = fixture(); try {
    const old = await failFinal(h), request = await beginRetry(h, old)
    await confirmReady(h, request)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok(profileData('Retired A'))); await settle()
    const config = pending(h, 'getSimulationConfigRealtime'), busy = control(h, 'retry-prepared-data').props.onClick
    const oldStart = start(h).props.onClick, oldBack = back(h).props.onClick
    await replaceWithReadyA(h)
    const current = snapshot(h)
    old(); busy(); oldStart(); oldBack()
    config.resolve(ok(configData({ config: { retired: true } }))); await settle()
    assert.equal(config.signal.aborted, true)
    assert.equal(snapshot(h), current)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

for (const stage of ['readiness', 'final profiles', 'final config']) {
  test('cloud prepared-data retry: unmount retires ' + stage, async () => {
    const h = fixture(); try {
      const old = await failFinal(h), status = await beginRetry(h, old)
      let request = status
      if (stage !== 'readiness') {
        await confirmReady(h, status); request = pending(h, 'getSimulationProfilesRealtime')
      }
      if (stage === 'final config') {
        request.resolve(ok(profileData())); await settle(); request = pending(h, 'getSimulationConfigRealtime')
      }
      const busy = control(h, 'retry-prepared-data').props.onClick
      const oldStart = start(h).props.onClick, oldBack = back(h).props.onClick
      h.close(); const current = snapshot(h)
      old(); busy(); oldStart(); oldBack()
      request.resolve(ok(stage === 'readiness' ? { simulation_id: 'A', status: 'ready', already_prepared: true }
        : stage === 'final profiles' ? profileData('Retired') : configData()))
      await settle()
      assert.equal(request.signal.aborted, true)
      assert.equal(snapshot(h), current)
      assert.equal(h.intervals.size, 0)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}
