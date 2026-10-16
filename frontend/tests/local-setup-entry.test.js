import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, settle, ok, setupView, setupChild, localPlan, savedPlan, busyPlan, task, taskPlan, readyTask,
  pending, control, text, body, action, setupAction, gatedControl, click, noMutations, blocked, observePlan, entered, metadata,
  openHistorySetup, profiles, config, finalData, reuse } from './helpers/local-setup-entry-fixture.js'

// This identical case is the sole unchanged-source witness. The baseline must
// reach its final assertion through real Home, History, Router, parent and child.
// Its normal running/interview-unavailable inputs deliberately do not establish
// an orphan. A compiler, import, rendering or route failure is not the witness.
test('History Env Setup never stops a healthy local run', async () => {
  const h = fixture({ historyRoute: true })
  try {
    await openHistorySetup(h)
    await observePlan(h, busyPlan())
    const environment = pending(h, 'getEnvStatus')
    if (environment) {
      assert.equal(environment.args[0].simulation_id, 'A')
      environment.resolve(ok({ env_alive: false, env_status: 'running', interview_available: false })); await settle()
      const simulation = pending(h, 'getSimulation')
      assert.equal(simulation.args[0], 'A')
      simulation.resolve(ok({ simulation_id: 'A', status: 'running', project_id: 'PA' })); await settle()
    } else {
      await metadata(h)
    }
    assert.equal(h.calls('stopSimulation').length, 0, 'opening Env Setup must not call Stop for the same healthy local simulation A')
    noMutations(h)
    blocked(h)
  } finally { h.close() }
})

for (const scenario of ['completed interview environment', 'persisted RUNNING without a live process']) {
  test('passive local entry and Refresh preserve ' + scenario, async () => {
    const h = fixture({ graphRoute: true })
    try {
      const data = busyPlan('run_busy', { status: scenario.startsWith('completed') ? 'completed' : 'running' })
      await entered(h, data)
      await metadata(h, { status: data.status, graph: null, projectStatus: 'ontology_generated' })
      assert.equal(h.calls('getEnvStatus').length, 0, 'an interview probe is not a local ownership test')
      assert.equal(h.calls('getGraphData').length, 0, 'local graph reading stays explicit')
      blocked(h); noMutations(h)
      const back = setupAction(h, 'back')
      const start = setupAction(h, 'start')
      back(); start(); await settle()
      assert.equal(h.router.currentRoute.value.name, 'Simulation')
      await click(h, 'refresh-plan'); await observePlan(h, data)
      back(); start(); await settle()
      blocked(h); noMutations(h)
      assert.equal(h.calls('getEnvStatus').length, 0)
      assert.ok(!text(h.host).includes('Rebuild'))
    } finally { h.close() }
  })
}

const badEntry = [
  ['missing plan', () => ({ success: true })],
  ['unknown mode', () => ok({ simulation_id: 'A', mode: 'unknown' })],
  ['wrong simulation', () => ok({ simulation_id: 'B', mode: 'cloud', limits: null })],
  ['malformed ownership', () => ok(localPlan({ owner: { busy: 'false', reason_code: null, task_id: null } }))],
  ['unknown status', () => ok(localPlan({ status: 'unrecognized-state' }))],
  ['missing status', () => ok(localPlan({ status: undefined }))],
  ['contradictory idle ownership', () => ok(localPlan({ owner: { busy: false, reason_code: 'run_busy', task_id: null } }))],
  ['contradictory idle task', () => ok(localPlan({ owner: { busy: false, reason_code: null, task_id: 'task-A' } }))],
  ['rejected read', null],
]
for (const [label, response] of badEntry) test('unconfirmed entry fails closed: ' + label, async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A')
    const read = pending(h, 'getPreparationPlan')
    if (response) read.resolve(response())
    else read.reject(new Error('Synthetic plan failure /private/details'))
    await settle()
    noMutations(h); blocked(h)
    assert.equal(h.calls('getEnvStatus').length, 0)
    assert.equal(control(h, 'stop-local-simulation'), undefined)
    gatedControl(h, 'setup-start')
    setupAction(h, 'start')(); setupAction(h, 'back')(); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    assert.ok(!text(h.host).includes('/private/details'))
    noMutations(h)
  } finally { h.close() }
})

test('confirmed local mode cannot become cloud cleanup through Refresh', async () => {
  const h = fixture()
  try {
    await entered(h, savedPlan())
    await click(h, 'refresh-plan')
    await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
    assert.equal(h.state(setupView).runtimeMode, 'local')
    blocked(h); noMutations(h)
    assert.equal(h.calls('getEnvStatus').length, 0)
  } finally { h.close() }
})

test('idle saved setup requires explicit Reuse and a fresh admission read before Start', async () => {
  const h = fixture()
  try {
    await entered(h, savedPlan())
    noMutations(h)
    assert.equal(control(h, 'reuse-preparation').props.disabled, false)
    gatedControl(h, 'setup-start')
    await reuse(h)
    noMutations(h, ['prepareSimulation'])
    await finalData(h)
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(control(h, 'setup-start').props.disabled, false)
    assert.equal(h.calls('previewPreparation').length, 0)
    await click(h, 'setup-start')
    await h.pushes.at(-1).promise; await settle()
    assert.equal(h.router.currentRoute.value.name, 'SimulationRun')
    assert.equal(h.calls('startSimulation').length, 1)
    assert.deepEqual(body(h.calls('startSimulation')[0]), { simulation_id: 'A', platform: 'auto',
      force: true, enable_graph_memory_update: true, max_rounds: 5 }, 'explicit Start preserves the existing Step3 payload')
    noMutations(h, ['prepareSimulation', 'startSimulation'])
  } finally { h.close() }
})

test('Reuse acknowledgement cannot promote through a newly busy admission read', async () => {
  for (const reason of ['run_busy', 'updater_busy', 'ownership_unavailable']) {
    const h = fixture()
    try {
      await entered(h, savedPlan())
      await click(h, 'reuse-preparation')
      pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
      await observePlan(h, busyPlan(reason), 1)
      blocked(h)
      assert.equal(h.calls('getSimulationProfilesRealtime').length, 0)
      assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
      assert.equal(h.calls('prepareSimulation').length, 1)
      noMutations(h, ['prepareSimulation'])
    } finally { h.close() }
  }
})

for (const reason of ['run_busy', 'updater_busy', 'lifecycle_busy', 'ownership_unavailable']) {
  test('remembered ready preparation cannot outrank ' + reason, async () => {
    const h = fixture()
    try {
      await entered(h, busyPlan(reason, { preparation_task: readyTask() }))
      blocked(h)
      assert.equal(h.calls('getSimulationProfilesRealtime').length, 0)
      assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
      assert.equal(!!control(h, 'stop-local-simulation'), ['run_busy', 'updater_busy'].includes(reason))
      setupAction(h, 'start')(); await settle()
      noMutations(h)
    } finally { h.close() }
  })
}

test('owned preparation keeps exact-task polling and cancellation without run cleanup', async () => {
  const h = fixture()
  try {
    await entered(h, taskPlan())
    assert.equal(control(h, 'stop-local-simulation'), undefined)
    assert.equal(control(h, 'cancel-preparation').props.disabled, false)
    await h.tick(2000)
    assert.deepEqual(body(pending(h, 'getPrepareStatus')), { simulation_id: 'A', task_id: 'task-A' })
    const cancel = action(control(h, 'cancel-preparation'))
    cancel(); cancel(); await settle()
    assert.equal(h.calls('cancelPreparation').length, 1)
    assert.deepEqual(body(pending(h, 'cancelPreparation')), { simulation_id: 'A', task_id: 'task-A' })
    pending(h, 'cancelPreparation').resolve(ok({ accepted: true, ...task({ preparation_phase: 'cancelling', can_cancel: false, cancellation_requested: true }) })); await settle()
    assert.ok(text(h.host).includes('Waiting for running work and cleanup to finish'))
    blocked(h); noMutations(h)
    pending(h, 'getPrepareStatus').resolve(ok(task({ status: 'completed', preparation_phase: 'ready', can_cancel: false }))); await settle()
    assert.equal(h.state(setupChild).phase, 1, 'pre-cancellation ready observation cannot release cancellation')
    assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
    noMutations(h)
  } finally { h.close() }
})

test('a different preparation owner rejects remembered ready without run cleanup or duplicate Prepare', async () => {
  const h = fixture()
  try {
    await entered(h, taskPlan({ preparation_task: readyTask({ task_id: 'old-task' }) }))
    blocked(h)
    assert.equal(control(h, 'stop-local-simulation'), undefined)
    assert.equal(control(h, 'cancel-preparation'), undefined)
    await h.tick(2000)
    assert.equal(h.calls('getPrepareStatus').length, 0)
    assert.equal(h.calls('getSimulationProfilesRealtime').length, 0)
    noMutations(h)
  } finally { h.close() }
})

test('owned terminal preparation establishes current idle admission before final profiles and config', async () => {
  const h = fixture()
  try {
    await entered(h, taskPlan())
    await h.tick(2000)
    pending(h, 'getPrepareStatus').resolve(ok(readyTask())); await settle()
    assert.ok(pending(h, 'getPreparationPlan'))
    assert.notEqual(h.state(setupChild).phase, 4)
    await observePlan(h, savedPlan({ preparation_task: readyTask() }), 1)
    // An already running preview is retired before the final profile read.
    const preview = pending(h, 'getSimulationProfilesRealtime')
    assert.ok(preview)
    preview.resolve(profiles()); await settle()
    if (pending(h, 'getSimulationProfilesRealtime')) { pending(h, 'getSimulationProfilesRealtime').resolve(profiles()); await settle() }
    pending(h, 'getSimulationConfigRealtime').resolve(config()); await settle()
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(control(h, 'setup-start').props.disabled, false)
    noMutations(h)
  } finally { h.close() }
})

test('explicit local Stop is exact-ID single-flight and stays blocked through verification', async () => {
  const h = fixture()
  try {
    await entered(h, busyPlan())
    const stop = action(control(h, 'stop-local-simulation'))
    stop(); stop(); await settle()
    assert.equal(h.calls('stopSimulation').length, 1)
    assert.deepEqual(body(pending(h, 'stopSimulation')), { simulation_id: 'A' })
    assert.ok(pending(h, 'stopSimulation').signal instanceof AbortSignal)
    assert.equal(control(h, 'stop-local-simulation').props.disabled, true)
    assert.equal(control(h, 'stop-local-simulation').props['aria-busy'], true)
    blocked(h)
    pending(h, 'stopSimulation').resolve(ok({ runner_status: 'stopped' })); await settle()
    assert.equal(control(h, 'local-stop-status').props['aria-busy'], true)
    blocked(h)
    stop(); await settle()
    assert.equal(h.calls('stopSimulation').length, 1, 'settled Stop callback cannot acquire a fresh observer')
    await observePlan(h, busyPlan(), 1)
    blocked(h)
    assert.ok(text(h.host).includes('Setup is still blocked'))
    assert.equal(control(h, 'stop-local-simulation').props.disabled, false)
    assert.equal(control(h, 'refresh-plan').props.disabled, false)
    noMutations(h, ['stopSimulation'])
  } finally { h.close() }
})

const stopOutcomes = ['202 pending', 'refusal', 'transport rejection or lost response', 'failed verification']
for (const outcome of stopOutcomes) test('Stop ' + outcome + ' cannot optimistically enable setup or retry itself', async () => {
  const h = fixture()
  try {
    await entered(h, busyPlan('updater_busy'))
    await click(h, 'stop-local-simulation')
    const request = pending(h, 'stopSimulation')
    if (outcome === 'transport rejection or lost response') request.reject(new Error('Synthetic lost Stop reply'))
    else if (outcome === '202 pending') request.resolve({ success: false, pending: true, status: 202 })
    else if (outcome === 'refusal') request.resolve({ success: false, error: 'Stop refused' })
    else request.resolve(ok({ runner_status: 'stopped' }))
    await settle()
    blocked(h)
    const verification = pending(h, 'getPreparationPlan')
    assert.ok(verification, 'every settled Stop outcome is reconciled with one passive read')
    assert.equal(verification.args[0], 'A')
    if (outcome === 'failed verification') verification.reject(new Error('Synthetic verification outage'))
    else verification.resolve(ok(busyPlan('updater_busy')))
    await settle()
    blocked(h)
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.calls('stopSimulation').length, 1)
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    assert.equal(control(h, 'refresh-plan').props.disabled, false)
    if (outcome === 'failed verification') {
      assert.ok(text(control(h, 'local-stop-status')).includes('Could not verify whether setup can continue'))
      assert.equal(control(h, 'local-stop-status').props['aria-busy'], false)
    }
    const expected = outcome === '202 pending' ? 'Stop is still pending.' : outcome === 'refusal' ? 'Stop was not accepted.'
      : outcome === 'transport rejection or lost response' ? 'Could not confirm the Stop result; it may have been accepted.' : 'Stop was acknowledged.'
    assert.ok(text(control(h, 'local-stop-status')).includes(expected), 'Stop outcome remains distinct from admission verification')
    noMutations(h, ['stopSimulation'])
    assert.ok(!text(h.host).includes('The current status check allows setup to continue'))
  } finally { h.close() }
})

test('stale RUNNING recovers through explicit Stop then fresh idle observation and explicit Reuse', async () => {
  const h = fixture()
  try {
    await entered(h, busyPlan())
    await click(h, 'stop-local-simulation')
    pending(h, 'stopSimulation').resolve(ok({ runner_status: 'stopped' })); await settle()
    await observePlan(h, savedPlan({ preparation_task: readyTask() }), 1)
    assert.equal(h.state(setupChild).phase, 0, 'Stop does not automatically reuse remembered readiness')
    assert.equal(h.calls('getSimulationProfilesRealtime').length, 0)
    assert.equal(control(h, 'reuse-preparation').props.disabled, false)
    gatedControl(h, 'setup-start')
    assert.equal(control(h, 'setup-back').props.disabled, false)
    assert.ok(text(h.host).includes('The current status check allows setup to continue'))
    noMutations(h, ['stopSimulation'])
    await reuse(h); await finalData(h)
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(control(h, 'setup-start').props.disabled, false)
    assert.equal(h.calls('stopSimulation').length, 1)
    assert.equal(h.calls('prepareSimulation').length, 1)
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    noMutations(h, ['stopSimulation', 'prepareSimulation'])
  } finally { h.close() }
})

test('verified run ownership offers Stop with invalid limits but admission blockers survive Stop', async () => {
  for (const blocker of ['limits', 'cancellation', 'artifacts']) {
    const h = fixture()
    try {
      await entered(h, busyPlan('run_busy', { limits: { valid: false } }))
      assert.equal(control(h, 'stop-local-simulation').props.disabled, false, 'runtime limits do not hide a verified Stop intent')
      await click(h, 'stop-local-simulation')
      pending(h, 'stopSimulation').resolve(ok({ runner_status: 'stopped' })); await settle()
      const extra = blocker === 'limits' ? { limits: { valid: false } }
        : blocker === 'cancellation' ? { cancellation: { blocked: true, phase: 'cancelled', task_id: null, reason_code: 'cancelled' } }
          : { can_reuse: false, prepared: { available: false, reason_code: 'invalid_artifacts', info: null } }
      await observePlan(h, savedPlan(extra), 1)
      blocked(h); noMutations(h, ['stopSimulation'])
      assert.equal(h.calls('stopSimulation').length, 1)
    } finally { h.close() }
  }
})

test('A to B to A ignores held old mode replies and retires the old rendered Stop intent', async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A')
    const oldMode = pending(h, 'getPreparationPlan')
    await h.navigate('/simulation/B'); await observePlan(h, busyPlan('run_busy', { simulation_id: 'B' }))
    const oldStop = action(control(h, 'stop-local-simulation'))
    await h.navigate('/simulation/A'); await observePlan(h, busyPlan())
    const reads = h.calls('getPreparationPlan').length
    oldMode.resolve(ok({ simulation_id: 'A', mode: 'cloud', limits: null })); oldStop(); await settle()
    assert.ok(oldMode.signal.aborted)
    assert.equal(h.calls('getPreparationPlan').length, reads)
    assert.equal(h.state(setupView).runtimeMode, 'local')
    assert.equal(h.child(setupChild).props.simulationId, 'A')
    blocked(h); noMutations(h)
  } finally { h.close() }
})

test('A to B to A ignores a held Stop result and a held admission plan from the first A', async () => {
  const h = fixture()
  try {
    await entered(h, busyPlan())
    const oldStop = action(control(h, 'stop-local-simulation'))
    oldStop(); await settle()
    const reply = pending(h, 'stopSimulation')
    await h.navigate('/simulation/B'); await observePlan(h, busyPlan('run_busy', { simulation_id: 'B' }))
    await h.navigate('/simulation/A'); await observePlan(h, busyPlan())
    const reads = h.calls('getPreparationPlan').length
    reply.resolve(ok({ runner_status: 'stopped' })); oldStop(); await settle()
    assert.equal(h.calls('getPreparationPlan').length, reads)
    assert.ok(reply.signal.aborted)
    blocked(h)
    await click(h, 'refresh-plan')
    const oldPlan = pending(h, 'getPreparationPlan')
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await observePlan(h, busyPlan())
    oldPlan.resolve(ok(savedPlan({ preparation_task: readyTask() }))); await settle()
    assert.ok(oldPlan.signal.aborted)
    blocked(h)
    assert.equal(h.calls('stopSimulation').length, 1)
    noMutations(h, ['stopSimulation'])
  } finally { h.close() }
})

test('unmount retires pending Stop and its rendered callback without a later verification read', async () => {
  const h = fixture()
  await entered(h, busyPlan())
  const stop = action(control(h, 'stop-local-simulation'))
  stop(); await settle()
  const reply = pending(h, 'stopSimulation'), reads = h.calls('getPreparationPlan').length
  h.close()
  stop(); reply.resolve(ok({ runner_status: 'stopped' })); await settle()
  assert.ok(reply.signal.aborted)
  assert.equal(h.calls('stopSimulation').length, 1)
  assert.equal(h.calls('getPreparationPlan').length, reads)
  noMutations(h, ['stopSimulation'])
})

test('pending then aborted departure retires old callbacks and requires a fresh child observation', async () => {
  const h = fixture()
  let removeGuard
  try {
    await entered(h, busyPlan())
    const oldChild = h.child(setupChild), oldStop = action(control(h, 'stop-local-simulation'))
    const oldStart = setupAction(h, 'start'), oldBack = setupAction(h, 'back')
    let finish, signalArrival
    const arrival = new Promise(resolve => { signalArrival = resolve })
    removeGuard = h.router.beforeResolve(to => to.path === '/' ? new Promise(resolve => { finish = resolve; signalArrival(to) }) : undefined)
    const departure = h.router.push('/')
    const heldRoute = await Promise.race([arrival, departure.then(() => assert.fail('navigation settled before the held beforeResolve guard'))])
    assert.equal(heldRoute.path, '/', 'actual navigation is pending in the intended later router guard')
    assert.equal(typeof finish, 'function')
    oldStop(); oldStart(); oldBack(); await settle()
    noMutations(h)
    finish(false); await departure; await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    assert.notEqual(h.child(setupChild), oldChild)
    assert.ok(pending(h, 'getPreparationPlan'), 'aborted departure installs a fresh read')
    oldStop(); oldStart(); oldBack(); await settle()
    noMutations(h)
    await observePlan(h, busyPlan())
    oldStop(); await settle()
    assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(control(h, 'stop-local-simulation').props.disabled, false)
    blocked(h)
  } finally { removeGuard?.(); h.close() }
})

test('aborted and thrown departures preserve local mode and reject a cloud recovery read', async () => {
  for (const outcome of ['aborted', 'thrown']) {
    const h = fixture()
    let removeGuard
    try {
      await entered(h, busyPlan())
      const oldStop = action(control(h, 'stop-local-simulation'))
      removeGuard = h.router.beforeResolve(to => {
        if (to.path !== '/') return
        if (outcome === 'thrown') throw new Error('Synthetic navigation failure')
        return false
      })
      if (outcome === 'thrown') await assert.rejects(h.router.push('/'), /Synthetic navigation failure/)
      else await h.router.push('/')
      await settle()
      assert.equal(h.router.currentRoute.value.name, 'Simulation')
      assert.ok(pending(h, 'getPreparationPlan'))
      oldStop(); await settle()
      await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
      assert.equal(h.state(setupView).runtimeMode, 'local')
      assert.equal(h.calls('getEnvStatus').length, 0)
      blocked(h); noMutations(h)
      await click(h, 'refresh-plan'); await observePlan(h, busyPlan())
      assert.equal(control(h, 'stop-local-simulation').props.disabled, false)
      oldStop(); await settle()
      noMutations(h)
    } finally { removeGuard?.(); h.close() }
  }
})

test('an older navigation cancellation cannot revive callbacks during a newer pending departure', async () => {
  const h = fixture()
  let removeGuard
  try {
    await entered(h, busyPlan())
    const oldChild = h.child(setupChild), oldStop = action(control(h, 'stop-local-simulation'))
    const releases = new Map(), signalArrivals = new Map()
    const arrivalB = new Promise(resolve => { signalArrivals.set('/simulation/B', resolve) })
    const arrivalC = new Promise(resolve => { signalArrivals.set('/simulation/C', resolve) })
    removeGuard = h.router.beforeResolve(to => new Promise(resolve => {
      releases.set(to.fullPath, resolve)
      signalArrivals.get(to.fullPath)?.(to)
    }))
    const older = h.router.push('/simulation/B')
    const heldB = await Promise.race([arrivalB, older.then(() => assert.fail('older navigation settled before its held beforeResolve guard'))])
    assert.equal(heldB.fullPath, '/simulation/B')
    assert.ok(releases.has('/simulation/B'))
    const newer = h.router.push('/simulation/C')
    const heldC = await Promise.race([arrivalC, newer.then(() => assert.fail('newer navigation settled before its held beforeResolve guard'))])
    assert.equal(heldC.fullPath, '/simulation/C')
    assert.ok(releases.has('/simulation/C'))
    const reads = h.calls('getPreparationPlan').length
    releases.get('/simulation/B')(false); await older; await settle()
    assert.equal(h.calls('getPreparationPlan').length, reads, 'older cancellation cannot install a new observer')
    assert.equal(h.child(setupChild), oldChild)
    oldStop(); await settle()
    noMutations(h)
    releases.get('/simulation/C')(false); await newer; await settle()
    assert.notEqual(h.child(setupChild), oldChild)
    await observePlan(h, busyPlan())
    oldStop(); await settle()
    noMutations(h)
    assert.equal(control(h, 'stop-local-simulation').props.disabled, false)
  } finally { removeGuard?.(); h.close() }
})

test('leave and update guards synchronously retire captured Stop before a Vue flush', async () => {
  for (const destination of ['/', '/simulation/B']) {
    const h = fixture()
    try {
      await entered(h, busyPlan())
      const stop = action(control(h, 'stop-local-simulation'))
      const guards = h.router.currentRoute.value.matched.at(-1)[destination === '/' ? 'leaveGuards' : 'updateGuards']
      const guard = [...guards][0]
      assert.equal(typeof guard, 'function', 'the actual component registered its route ownership guard')
      let intercepted = false
      guards.delete(guard)
      guards.add((...args) => {
        const result = guard(...args)
        // Re-enter in the SAME stack, before Vue can propagate a Boolean prop.
        // The production guard and its result remain unchanged.
        stop(); intercepted = true
        assert.equal(h.calls('stopSimulation').length, 0, 'synchronous route retirement fences the captured handler')
        return result
      })
      await h.navigate(destination)
      assert.equal(intercepted, true)
      noMutations(h)
    } finally { h.close() }
  }
})

test('Refresh synchronously revokes parent Back and Start admission and failure cannot restore it', async () => {
  const h = fixture()
  try {
    await entered(h, savedPlan()); await reuse(h); await finalData(h)
    assert.equal(h.state(setupView).setupAdmission, true)
    assert.equal(h.state(setupView).startAdmission, true)
    const oldStart = setupAction(h, 'start'), oldBack = setupAction(h, 'back')
    const parentStart = h.state(setupView).viewActions.next, parentBack = h.state(setupView).viewActions.back
    action(control(h, 'refresh-plan'))()
    assert.equal(h.state(setupView).setupAdmission, false, 'the fresh read revokes parent admission synchronously')
    assert.equal(h.state(setupView).startAdmission, false)
    oldStart(); oldBack(); parentStart({ maxRounds: 2 }); parentBack(); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    pending(h, 'getPreparationPlan').reject(new Error('Synthetic Refresh failure')); await settle()
    assert.equal(h.state(setupView).setupAdmission, false)
    assert.equal(h.state(setupView).startAdmission, false)
    blocked(h)
    oldStart(); parentStart({ maxRounds: 2 }); await settle()
    assert.equal(h.calls('startSimulation').length, 0)
    await click(h, 'refresh-plan'); await observePlan(h, savedPlan())
    gatedControl(h, 'setup-start')
    assert.equal(h.state(setupView).startAdmission, false)
    await click(h, 'reuse-preparation')
    pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
    assert.ok(pending(h, 'getPreparationPlan'), 'explicit recovery Reuse must establish fresh admission')
    gatedControl(h, 'setup-start')
    oldStart(); await settle()
    assert.equal(h.calls('startSimulation').length, 0)
    await observePlan(h, savedPlan(), 1)
    gatedControl(h, 'setup-start')
    await finalData(h)
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(control(h, 'setup-start').props.disabled, false)
    assert.equal(h.state(setupView).startAdmission, true)
    oldStart(); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation', 'the old Start stays retired after the fresh Start is enabled')
    assert.equal(h.calls('startSimulation').length, 0)
    assert.equal(h.calls('prepareSimulation').length, 2)
    noMutations(h, ['prepareSimulation'])
  } finally { h.close() }
})

test('late ready task and preview replies cannot release a Stop or its verification gate', async () => {
  const h = fixture()
  try {
    await entered(h, taskPlan())
    await h.tick(2000)
    pending(h, 'getPrepareStatus').resolve(ok(task({ progress_detail: { current_stage_name: 'generating_config' } }))); await settle()
    await h.tick(2000); await h.tick(3000)
    const oldProfiles = pending(h, 'getSimulationProfilesRealtime'), oldConfig = pending(h, 'getSimulationConfigRealtime')
    assert.ok(oldProfiles); assert.ok(oldConfig)
    pending(h, 'getPrepareStatus').resolve(ok(readyTask())); await settle()
    await observePlan(h, busyPlan(), 1)
    blocked(h)
    await click(h, 'stop-local-simulation')
    oldProfiles.resolve(profiles()); oldConfig.resolve(config()); await settle()
    blocked(h)
    pending(h, 'stopSimulation').resolve(ok({ runner_status: 'stopped' })); await settle()
    blocked(h)
    await observePlan(h, busyPlan(), 1)
    blocked(h)
    assert.equal(h.state(setupChild).profiles.length, 0)
    assert.equal(h.state(setupChild).simulationConfig, null)
    noMutations(h, ['stopSimulation'])
  } finally { h.close() }
})

test('held task and final-data replies cannot unlock a replacement selection during explicit Stop', async () => {
  for (const stage of ['task', 'profiles', 'config']) {
    const h = fixture()
    try {
      if (stage === 'task') { await entered(h, taskPlan()); await h.tick(2000) }
      else { await entered(h, savedPlan()); await reuse(h) }
      if (stage === 'config') { pending(h, 'getSimulationProfilesRealtime').resolve(profiles()); await settle() }
      const old = pending(h, { task: 'getPrepareStatus', profiles: 'getSimulationProfilesRealtime', config: 'getSimulationConfigRealtime' }[stage])
      assert.ok(old)
      await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await observePlan(h, busyPlan())
      await click(h, 'stop-local-simulation')
      old.resolve(stage === 'task' ? ok(readyTask()) : stage === 'profiles' ? profiles() : config()); await settle()
      assert.ok(old.signal.aborted)
      blocked(h)
      assert.equal(h.state(setupChild).profiles.length, 0)
      assert.equal(h.state(setupChild).simulationConfig, null)
      noMutations(h, ['prepareSimulation', 'stopSimulation'])
    } finally { h.close() }
  }
})

test('Back blocks mutation-capable Process while busy and recovers after current idle observation', async () => {
  const h = fixture({ graphRoute: true })
  try {
    await entered(h, busyPlan()); await metadata(h, { graph: null, projectStatus: 'ontology_generated' })
    const oldBack = setupAction(h, 'back')
    oldBack(); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    noMutations(h)
    const blockedNavigation = await h.router.push({ name: 'Process', params: { projectId: 'PA' } }); await settle()
    assert.ok(blockedNavigation, 'direct setup-to-Process navigation is refused by the owned route guard')
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    await observePlan(h, savedPlan())
    await metadata(h, { status: 'ready', graph: 'GA' })
    assert.equal(control(h, 'setup-back').props.disabled, false)
    oldBack(); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation', 'a blocked departure cannot revive the original Back')
    await click(h, 'setup-back'); await h.pushes.at(-1).promise; await settle()
    assert.equal(h.router.currentRoute.value.name, 'Process')
    pending(h, 'getProject').resolve(ok({ project_id: 'PA', status: 'graph_completed', graph_id: 'GA' })); await settle()
    noMutations(h)
  } finally { h.close() }
})

test('local metadata preserves explicit read-only graph refresh while entry and plan Refresh stay passive', async () => {
  const h = fixture()
  try {
    await entered(h, busyPlan()); await metadata(h)
    assert.equal(h.calls('getGraphData').length, 0)
    await click(h, 'refresh-local-graph')
    assert.equal(pending(h, 'getGraphData').args[0], 'GA')
    pending(h, 'getGraphData').resolve(ok({ nodes: [], edges: [] })); await settle()
    await click(h, 'refresh-plan'); await observePlan(h, busyPlan())
    assert.equal(h.calls('getGraphData').length, 1)
    noMutations(h)
  } finally { h.close() }
})

test('confirmed cloud mode retains automatic preparation and existing graceful-close fallback', async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A')
    noMutations(h)
    assert.equal(h.calls('getEnvStatus').length, 0)
    await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
    assert.deepEqual(body(pending(h, 'prepareSimulation')), { simulation_id: 'A', use_llm_for_profiles: true, parallel_profile_count: 5 })
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
    assert.deepEqual(body(pending(h, 'closeSimulationEnv')), { simulation_id: 'A', timeout: 10 })
    pending(h, 'closeSimulationEnv').resolve({ success: false }); await settle()
    assert.deepEqual(body(pending(h, 'stopSimulation')), { simulation_id: 'A' })
    pending(h, 'stopSimulation').resolve(ok({})); await settle()
    assert.ok(pending(h, 'getSimulation'))
    assert.equal(control(h, 'stop-local-simulation'), undefined)
    assert.equal(h.calls('prepareSimulation').length, 1)
  } finally { h.close() }
})

test('same-entry cloud recovery retains pending fulfilled and rejected attempts without replay', async () => {
  const scenarios = [
    ['pending', 'aborted'], ['pending', 'thrown'], ['pending', 'query'],
    ['fulfilled', 'aborted'], ['rejected', 'aborted'], ['AbortError', 'aborted'],
  ]
  for (const [receipt, navigation] of scenarios) {
    const h = fixture()
    let removeGuard
    try {
      await h.mount('/simulation/A')
      await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
      const oldChild = h.child(setupChild), oldPrepare = pending(h, 'prepareSimulation')
      pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
      pending(h, 'closeSimulationEnv').resolve(ok({})); await settle()
      if (receipt === 'fulfilled') oldPrepare.resolve(ok({ task_id: 'cloud-task-A', expected_entities_count: 2 }))
      if (receipt === 'rejected' || receipt === 'AbortError') {
        const failure = new Error('Synthetic original cloud preparation failure')
        if (receipt === 'AbortError') failure.name = 'AbortError'
        oldPrepare.reject(failure)
      }
      await settle()
      if (navigation === 'query') await h.router.push('/simulation/A?view=again')
      else {
        removeGuard = h.router.beforeResolve(to => {
          if (to.path !== '/') return
          if (navigation === 'thrown') throw new Error('Synthetic cloud navigation failure')
          return false
        })
        if (navigation === 'thrown') await assert.rejects(h.router.push('/'), /Synthetic cloud navigation failure/)
        else await h.router.push('/')
      }
      await settle()
      assert.equal(h.router.currentRoute.value.name, 'Simulation')
      assert.notEqual(h.child(setupChild), oldChild, receipt + '/' + navigation + ' gets a fresh observer')
      assert.ok(pending(h, 'getPreparationPlan'))
      await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
      assert.equal(h.calls('getEnvStatus').length, 1)
      assert.equal(h.calls('closeSimulationEnv').length, 1)
      assert.equal(h.calls('prepareSimulation').length, 1, receipt + '/' + navigation + ' cannot replay the mutation')
      if (receipt === 'pending') { oldPrepare.resolve(ok({ task_id: 'cloud-task-A', expected_entities_count: 2 })); await settle() }
      await h.tick(2000); await h.tick(3000)
      if (receipt === 'pending' || receipt === 'fulfilled') {
        assert.deepEqual(body(pending(h, 'getPrepareStatus')), { simulation_id: 'A', task_id: 'cloud-task-A' }, 'fresh observer consumes the retained receipt')
      } else {
        assert.equal(h.state(setupView).currentStatus, 'error', 'retained rejection stays an error')
        assert.equal(h.calls('getPrepareStatus').length, 0)
        assert.equal(h.calls('getSimulationProfilesRealtime').length, 0)
        gatedControl(h, 'setup-start')
      }
      assert.equal(h.calls('prepareSimulation').length, 1)
      assert.equal(h.calls('getEnvStatus').length, 1)
      noMutations(h, ['prepareSimulation', 'closeSimulationEnv'])
    } finally { removeGuard?.(); h.close() }
  }
})

test('true cloud A to B to A gives each entry one attempt and rejects the first A receipt', async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A')
    await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
    const firstA = pending(h, 'prepareSimulation')
    await h.navigate('/simulation/B')
    await observePlan(h, { simulation_id: 'B', mode: 'cloud', limits: null }, 1)
    const firstB = pending(h, 'prepareSimulation')
    await h.navigate('/simulation/A')
    await observePlan(h, { simulation_id: 'A', mode: 'cloud', limits: null }, 1)
    const returnedA = pending(h, 'prepareSimulation')
    assert.notEqual(returnedA, firstA)
    assert.deepEqual(h.calls('prepareSimulation').map(request => body(request).simulation_id), ['A', 'B', 'A'])
    assert.equal(h.calls('getEnvStatus').length, 3, 'a true new route entry retains its own confirmed cloud cleanup')
    returnedA.resolve(ok({ task_id: 'returned-A', expected_entities_count: 2 })); await settle()
    firstA.resolve(ok({ already_prepared: true }))
    firstB.resolve(ok({ task_id: 'retired-B', expected_entities_count: 20 })); await settle()
    assert.equal(firstA.signal.aborted, true)
    assert.equal(firstB.signal.aborted, true)
    assert.equal(returnedA.signal.aborted, false)
    assert.equal(h.state(setupChild).taskId, 'returned-A')
    assert.equal(h.state(setupChild).phase, 1)
    assert.equal(h.calls('getSimulationProfilesRealtime').length, 0, 'old ready receipt cannot start a final artifact load')
    assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
    await h.tick(2000)
    assert.deepEqual(body(pending(h, 'getPrepareStatus')), { simulation_id: 'A', task_id: 'returned-A' })
    assert.equal(h.calls('prepareSimulation').length, 3)
    noMutations(h, ['prepareSimulation'])
  } finally { h.close() }
})

test('idle local Prepare retains the strict selected-cast payload and no automatic work', async () => {
  const h = fixture()
  try {
    await entered(h)
    noMutations(h)
    await click(h, 'load-cast')
    const entities = [{ uuid: 'entity-A', name: 'Person', entity_type: 'Person', summary: 'Saved cast row', text_truncated: false }]
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', limits: localPlan().limits, entities, eligible_count: 1 })); await settle()
    control(h, 'entity-entity-A').props.onChange({ target: { checked: true } }); await settle()
    await click(h, 'prepare-cast')
    assert.deepEqual(body(pending(h, 'prepareSimulation')), { simulation_id: 'A', preparation_mode: 'prepare', selected_entity_ids: ['entity-A'], use_llm_for_profiles: false, parallel_profile_count: 1 })
    assert.equal(h.calls('prepareSimulation').length, 1)
    noMutations(h, ['prepareSimulation'])
  } finally { h.close() }
})

test('local final-profile failure remains blocked until Refresh and another explicit Reuse', async () => {
  const h = fixture()
  try {
    await entered(h, savedPlan()); await reuse(h)
    pending(h, 'getSimulationProfilesRealtime').reject(new Error('Synthetic final-profile outage')); await settle()
    assert.equal(h.state(setupChild).phase, 0)
    assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
    blocked(h)
    await click(h, 'refresh-plan'); await observePlan(h, savedPlan())
    assert.equal(h.calls('prepareSimulation').length, 1)
    await reuse(h); await finalData(h)
    assert.equal(h.state(setupChild).phase, 4)
    assert.equal(control(h, 'setup-start').props.disabled, false)
    assert.equal(h.calls('prepareSimulation').length, 2)
    noMutations(h, ['prepareSimulation'])
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test('local Stop has translated accessible intent and pending status in ' + locale, async () => {
  const h = fixture({ locale })
  try {
    await entered(h, busyPlan())
    const stop = control(h, 'stop-local-simulation'), status = control(h, 'local-stop-status')
    assert.equal(stop.props.type, 'button')
    assert.equal(stop.props.disabled, false)
    assert.ok(text(stop).includes(locale === 'en' ? 'Stop this simulation to continue setup' : '停止此模拟以继续环境搭建'))
    const description = h.find(node => node.props?.id === stop.props['aria-describedby'])
    assert.ok(description, 'the native button points to its rendered description')
    assert.ok(text(description).includes(locale === 'en' ? 'selected simulation' : '当前选中的模拟'))
    assert.equal(status.props.role, 'status')
    assert.equal(status.props['aria-live'], 'polite')
    await click(h, 'stop-local-simulation')
    assert.ok(text(control(h, 'local-stop-status')).includes(locale === 'en' ? 'Requesting Stop' : '正在请求停止'))
    assert.equal(control(h, 'stop-local-simulation').props.disabled, true)
    assert.equal(control(h, 'local-stop-status').props['aria-busy'], true)
    assert.ok(!text(h.host).includes('localPlan.'))
    noMutations(h, ['stopSimulation'])
  } finally { h.close() }
})
