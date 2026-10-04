import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import vm from 'node:vm'
import axios from 'axios'
import { build, settle, ok, setupChild, setupView } from './helpers/parent-route-fixture.js'

const limits = { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 }
const projection = (extra = {}) => ({ simulation_id: 'A', task_id: 'task-A', status: 'processing', progress: 30,
  message: '', progress_detail: {}, already_prepared: false, preparation_phase: 'preparing', can_cancel: true,
  cancellation_requested: false, ...extra })
const plan = (extra = {}) => ({ simulation_id: 'A', mode: 'local', status: 'preparing', limits,
  owner: { busy: true, reason_code: 'preparation_busy', task_id: 'task-A' },
  prepared: { available: false, reason_code: 'prepared_unavailable', info: null }, can_prepare: false, can_reuse: false,
  preparation_task: projection(), cancellation: { blocked: false, phase: null, task_id: null, reason_code: null }, ...extra })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, name) => h.find(node => node.props?.['data-testid'] === name)
const textContent = node => [node.text || '', ...(node.children || []).map(textContent)].join(' ')
const click = async (h, name) => { const button = control(h, name); assert.ok(button, name); assert.ok(!button.props.disabled, name + ' enabled'); button.props.onClick(); await settle() }
const start = h => h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
async function currentPlan(h, data = plan()) {
  pending(h, 'getPreparationPlan').resolve(ok(data)); await settle()
  pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
  pending(h, 'getSimulation').resolve(ok({ status: 'created' })); await settle()
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(data)); await settle() }
}
async function planned(h, data = plan()) { await h.mount('/simulation/A'); await currentPlan(h, data) }
async function observe(h, data) { await h.tick(2000); pending(h, 'getPrepareStatus').resolve(ok(data)); await settle() }
function blocked(h) {
  assert.equal(h.state(setupChild).canPrepareLocal, false)
  assert.equal(h.state(setupChild).canReuseLocal, false)
  assert.equal(start(h).props.disabled, true)
  h.state(setupChild).handleStartSimulation()
  assert.equal(h.router.currentRoute.value.name, 'Simulation')
}

test('reload exposes Cancel only for an exact backend-owned cancellable local task', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h)
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.equal(control(h, 'cancel-preparation').props.disabled, false)
    assert.ok(textContent(h.host).includes('Stops queued profiles and later stages. Work already running may finish.'))
    assert.equal(control(h, 'preparation-cancellation-status').props.role, 'status')
    await h.tick(2000)
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'getPrepareStatus').args[0])), { simulation_id: 'A', task_id: 'task-A' })
  } finally { h.close() }
})

for (const task of [null, projection({ simulation_id: 'B' }), projection({ task_id: 'wrong' }), projection({ can_cancel: false }), projection({ preparation_phase: 'unknown' })]) {
  test('unknown, mismatched or noncancellable task has no Cancel: ' + JSON.stringify(task), async () => {
    const h = build({ manualPlan: true }); try {
      await planned(h, plan({ preparation_task: task }))
      assert.equal(control(h, 'cancel-preparation'), undefined)
    } finally { h.close() }
  })
}

test('a present invalid plan projection cannot fall through to preparation or legacy polling', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h, plan({ can_prepare: true, owner: { busy: false }, preparation_task: projection({ simulation_id: 'B' }) }))
    assert.equal(h.state(setupChild).planError, 'localPlan.requestError')
    blocked(h)
    await h.tick(2000)
    assert.equal(h.calls('getPrepareStatus').length, 0)
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

test('double click submits one exact task pair and keeps status polling through draining', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h)
    const cancel = control(h, 'cancel-preparation').props.onClick
    cancel(); cancel(); await settle()
    assert.equal(h.calls('cancelPreparation').length, 1)
    const request = pending(h, 'cancelPreparation')
    assert.deepEqual(JSON.parse(JSON.stringify(request.args[0])), { simulation_id: 'A', task_id: 'task-A' })
    assert.ok(request.signal instanceof AbortSignal)
    assert.ok(textContent(h.host).includes('Requesting cancellation'))
    blocked(h)
    request.resolve(ok({ accepted: true, ...projection({ preparation_phase: 'cancelling', can_cancel: false, cancellation_requested: true }) })); await settle()
    assert.equal(request.signal.aborted, false)
    assert.ok(textContent(h.host).includes('Waiting for running work and cleanup to finish'))
    assert.ok(!textContent(h.host).includes('Preparation cancelled'))
    await observe(h, projection({ preparation_phase: 'cancelling', can_cancel: false, cancellation_requested: true }))
    blocked(h)
    assert.equal(h.calls('cancelPreparation').length, 1)
    assert.ok(h.intervals.size > 0)
  } finally { h.close() }
})

test('cancelled wins over completed and retires late config/profile responses', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h)
    await observe(h, projection({ progress_detail: { current_stage_name: 'generating_config' } }))
    await h.tick(2000); await h.tick(3000)
    const oldConfig = pending(h, 'getSimulationConfigRealtime'), oldProfiles = pending(h, 'getSimulationProfilesRealtime')
    pending(h, 'getPrepareStatus').resolve(ok(projection({ status: 'completed', preparation_phase: 'cancelled', can_cancel: false, cancellation_requested: true }))); await settle()
    oldConfig.resolve(ok({ status: 'ready', config_generated: true, is_generating: false, config: { secret: 'old' } }))
    oldProfiles.resolve(ok({ profiles: [{ name: 'late' }] })); await settle()
    assert.equal(h.state(setupChild).simulationConfig, null)
    assert.equal(h.state(setupChild).profiles.length, 0)
    assert.equal(h.intervals.size, 0)
    assert.ok(oldConfig.signal.aborted)
    assert.ok(textContent(h.host).includes('Preparation cancelled'))
    assert.equal(h.state(setupView).statusText, 'Cancelled')
    assert.ok(textContent(h.host).includes('Partial files remain for inspection'))
    assert.ok(textContent(h.host).includes('return to the project and create another simulation'))
    assert.ok(!textContent(h.host).includes('Preparation ready'))
    blocked(h)
  } finally { h.close() }
})

test('cleanup failure remains observed and blocked without exposing backend exception text', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h)
    await observe(h, projection({ preparation_phase: 'unavailable', can_cancel: false, cancellation_requested: true,
      error_code: 'cleanup_failed', message: 'PRIVATE /path/token', error: 'PRIVATE model credential' }))
    assert.ok(textContent(h.host).includes('Cleanup is blocked'))
    assert.ok(!textContent(h.host).includes('PRIVATE'))
    assert.ok(!JSON.stringify(h.state(setupView).systemLogs).includes('PRIVATE'))
    assert.ok(h.intervals.size > 0)
    assert.equal(control(h, 'cancel-preparation'), undefined)
    assert.equal(h.state(setupChild).simulationConfig, null)
    blocked(h)
  } finally { h.close() }
})

test('lost cancel response observes status before an explicit same-task retry', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h); await h.tick(2000)
    const oldStatus = pending(h, 'getPrepareStatus')
    await click(h, 'cancel-preparation')
    pending(h, 'cancelPreparation').reject(new Error('PRIVATE socket reset')); await settle()
    assert.equal(h.calls('cancelPreparation').length, 1)
    assert.ok(control(h, 'cancel-preparation')?.props.disabled ?? true)
    assert.ok(textContent(h.host).includes('Could not confirm the cancellation request'))
    oldStatus.resolve(ok(projection())); await settle()
    assert.ok(control(h, 'cancel-preparation')?.props.disabled ?? true, 'old observation cannot permit retry')
    await observe(h, projection())
    assert.ok(textContent(h.host).includes('Retry cancellation'))
    await click(h, 'cancel-preparation')
    assert.equal(h.calls('cancelPreparation').length, 2)
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'cancelPreparation').args[0])), { simulation_id: 'A', task_id: 'task-A' })
    assert.ok(!textContent(h.host).includes('PRIVATE'))
  } finally { h.close() }
})

test('owned status can confirm cancellation while the mutation reply is still missing', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h); await click(h, 'cancel-preparation')
    const mutation = pending(h, 'cancelPreparation')
    await observe(h, projection({ preparation_phase: 'cancelling', can_cancel: false, cancellation_requested: true }))
    assert.ok(textContent(h.host).includes('Waiting for running work and cleanup to finish'))
    assert.equal(h.state(setupChild).cancelPending, false)
    assert.equal(h.calls('cancelPreparation').length, 1)
    mutation.resolve(ok({ accepted: false, ...projection() })); await settle()
    assert.equal(control(h, 'cancel-preparation'), undefined)
    await observe(h, projection({ status: 'cancelled', preparation_phase: 'cancelled', can_cancel: false, cancellation_requested: true }))
    assert.ok(textContent(h.host).includes('Preparation cancelled'))
    blocked(h)
  } finally { h.close() }
})

for (const phase of ['cancelling', 'finalizing']) test('a read started during Cancel cannot regress its confirmed ' + phase + ' reply', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h); await click(h, 'cancel-preparation'); await h.tick(2000)
    const beforeReply = pending(h, 'getPrepareStatus')
    pending(h, 'cancelPreparation').resolve(ok({ accepted: phase === 'cancelling', ...projection({ preparation_phase: phase,
      can_cancel: false, cancellation_requested: phase === 'cancelling' }) })); await settle()
    beforeReply.resolve(ok(projection())); await settle()
    assert.equal(h.state(setupChild).preparationTask.preparation_phase, phase)
    assert.equal(control(h, 'cancel-preparation'), undefined)
    assert.ok(textContent(h.host).includes(phase === 'cancelling' ? 'Waiting for running work' : 'cancellation was too late'))
    assert.equal(h.calls('cancelPreparation').length, 1)
  } finally { h.close() }
})

test('failed config preview cannot retire a planned task before its cleanup blocker is observed', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h)
    await observe(h, projection({ progress_detail: { current_stage_name: 'generating_config' } }))
    await h.tick(2000)
    const preview = pending(h, 'getSimulationConfigRealtime')
    pending(h, 'getPrepareStatus').resolve(ok(projection())); await settle()
    await click(h, 'cancel-preparation')
    pending(h, 'cancelPreparation').resolve(ok({ accepted: false, ...projection({ preparation_phase: 'finalizing', can_cancel: false }) })); await settle()
    preview.resolve(ok({ status: 'failed', error: 'PRIVATE half-written preview', config: null })); await settle()
    assert.ok(h.intervals.size > 0, 'owned task must still be observed')
    await observe(h, projection({ preparation_phase: 'unavailable', can_cancel: false, error_code: 'cleanup_failed' }))
    assert.ok(textContent(h.host).includes('Cleanup is blocked'))
    assert.ok(!textContent(h.host).includes('PRIVATE'))
    blocked(h)
  } finally { h.close() }
})

for (const outcome of ['ready', 'failed']) test('too-late cancellation observes normal ' + outcome + ' outcome', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h); await click(h, 'cancel-preparation')
    pending(h, 'cancelPreparation').resolve(ok({ accepted: false, ...projection({ preparation_phase: 'finalizing', can_cancel: false }) })); await settle()
    assert.ok(textContent(h.host).includes('cancellation was too late'))
    assert.equal(control(h, 'cancel-preparation'), undefined)
    await observe(h, projection({ preparation_phase: outcome, status: outcome === 'ready' ? 'completed' : 'failed', can_cancel: false }))
    if (outcome === 'ready') {
      pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [] })); await settle()
      pending(h, 'getSimulationConfigRealtime').resolve(ok({ status: 'ready', config_generated: true, is_generating: false,
        config: { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } } })); await settle()
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(start(h).props.disabled, false)
    } else {
      assert.equal(h.state(setupChild).phase, 0)
      assert.equal(h.state(setupView).currentStatus, 'error')
      blocked(h)
    }
    assert.equal(h.calls('cancelPreparation').length, 1)
    assert.equal(h.intervals.size, 0)
    assert.ok(!textContent(h.host).includes('Waiting for the result'), 'settled outcome retires too-late waiting notice')
  } finally { h.close() }
})

for (const phase of ['cancelled', 'unavailable']) test('reload with persistent ' + phase + ' marker cannot reuse partial saved files', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h, plan({ owner: { busy: false, reason_code: null, task_id: null },
      prepared: { available: true, info: { profiles_count: 2 } }, can_prepare: true, can_reuse: true,
      preparation_task: projection({ preparation_phase: phase, status: phase === 'cancelled' ? 'cancelled' : 'processing', can_cancel: false, cancellation_requested: true }),
      cancellation: { blocked: true, phase, task_id: 'task-A', reason_code: 'preparation_cancelled' } }))
    assert.equal(control(h, 'cancel-preparation'), undefined)
    assert.equal(control(h, 'load-cast'), undefined)
    assert.equal(control(h, 'reuse-preparation'), undefined)
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.equal(h.state(setupChild).planLoading, false)
    assert.ok(textContent(h.host).includes('Partial files remain for inspection'))
    blocked(h)
  } finally { h.close() }
})

test('unsafe marker without a task blocks every local action', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h, plan({ owner: { busy: false }, preparation_task: null, can_prepare: true,
      cancellation: { blocked: true, phase: 'unavailable', task_id: null, reason_code: 'PRIVATE /path' } }))
    assert.ok(textContent(h.host).includes('Cleanup is blocked'))
    assert.ok(!textContent(h.host).includes('PRIVATE'))
    blocked(h)
    assert.equal(h.calls('getPrepareStatus').length, 0)
  } finally { h.close() }
})

for (const outcome of ['resolved', 'rejected']) test('A → B → A retires old cancel callback and ' + outcome + ' response', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h)
    const oldAction = control(h, 'cancel-preparation').props.onClick
    oldAction(); await settle(); const old = pending(h, 'cancelPreparation')
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await currentPlan(h)
    assert.ok(old.signal.aborted)
    oldAction(); await settle()
    assert.equal(h.calls('cancelPreparation').length, 1)
    if (outcome === 'resolved') old.resolve(ok({ accepted: true, ...projection({ preparation_phase: 'cancelled', status: 'cancelled', can_cancel: false, cancellation_requested: true }) }))
    else old.reject(new Error('PRIVATE stale error'))
    await settle()
    assert.equal(h.state(setupChild).cancellationBlocked, false)
    assert.equal(h.state(setupChild).cancelFeedback, '')
    assert.equal(control(h, 'cancel-preparation').props.disabled, false)
    await click(h, 'cancel-preparation')
    assert.equal(h.calls('cancelPreparation').length, 2)
  } finally { h.close() }
})

test('task replacement retires captured cancel handler and every pending response', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h)
    await observe(h, projection({ progress_detail: { current_stage_name: 'generating_config' } }))
    await h.tick(2000); await h.tick(3000)
    const oldStatus = pending(h, 'getPrepareStatus'), oldConfig = pending(h, 'getSimulationConfigRealtime'), oldProfiles = pending(h, 'getSimulationProfilesRealtime')
    const oldAction = control(h, 'cancel-preparation').props.onClick
    oldAction(); await settle(); const old = pending(h, 'cancelPreparation')
    h.state(setupChild).taskId = 'task-new'
    h.state(setupChild).preparationTask = projection({ task_id: 'task-new' })
    h.state(setupChild).cancelPending = false
    await settle(); oldAction(); await settle()
    assert.equal(h.calls('cancelPreparation').length, 1)
    old.resolve(ok({ accepted: true, ...projection({ preparation_phase: 'cancelled', status: 'cancelled', can_cancel: false, cancellation_requested: true }) }))
    oldStatus.resolve(ok(projection({ preparation_phase: 'ready', status: 'completed', can_cancel: false })))
    oldConfig.resolve(ok({ status: 'ready', config_generated: true, is_generating: false, config: { old: true } }))
    oldProfiles.resolve(ok({ profiles: [{ name: 'old' }] })); await settle()
    assert.equal(h.state(setupChild).taskId, 'task-new')
    assert.equal(h.state(setupChild).cancellationBlocked, false)
    assert.equal(h.state(setupChild).simulationConfig, null)
    assert.equal(h.state(setupChild).profiles.length, 0)
    assert.notEqual(h.state(setupChild).phase, 4)
  } finally { h.close() }
})

test('explicit planned preparation response installs a cancellable task before preflight details exist', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h, plan({ status: 'created', owner: { busy: false }, preparation_task: null, can_prepare: true }))
    await click(h, 'load-cast')
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', limits, eligible_count: 1,
      entities: [{ uuid: 'entity-a', name: 'A', entity_type: 'Person', summary: '', text_truncated: false }] })); await settle()
    control(h, 'entity-entity-a').props.onChange({ target: { checked: true } }); await settle()
    await click(h, 'prepare-cast')
    assert.equal(control(h, 'cancel-preparation'), undefined)
    pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A', expected_entities_count: 1, entity_types: [],
      preparation_task: projection({ status: 'pending', progress: 0 }) })); await settle()
    assert.equal(h.state(setupChild).expectedTotal, 1)
    assert.equal(control(h, 'cancel-preparation').props.disabled, false)
  } finally { h.close() }
})

test('cancelled status alone takes precedence over a ready phase', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h)
    await observe(h, projection({ preparation_phase: 'ready', status: 'cancelled', can_cancel: false }))
    assert.ok(textContent(h.host).includes('Preparation cancelled'))
    blocked(h)
    assert.equal(h.calls('getSimulationConfigRealtime').length, 0)
  } finally { h.close() }
})

test('a replaced task cannot be overwritten by an earlier preparation POST acknowledgement', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A')
    pending(h, 'getPreparationPlan').resolve(ok({ simulation_id: 'A', mode: 'cloud' })); await settle()
    const old = pending(h, 'prepareSimulation')
    h.state(setupChild).taskId = 'task-new'
    old.resolve(ok({ task_id: 'task-old' })); await settle()
    assert.equal(h.state(setupChild).taskId, 'task-new')
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test('literal safe cancellation states render in ' + locale, async () => {
  const h = build({ manualPlan: true, locale }); try {
    await planned(h)
    assert.ok(textContent(h.host).includes(locale === 'en' ? 'Cancel preparation' : '取消准备'))
    await click(h, 'cancel-preparation')
    pending(h, 'cancelPreparation').resolve(ok({ accepted: true, ...projection({ preparation_phase: 'cancelled', status: 'cancelled', can_cancel: false, cancellation_requested: true }) })); await settle()
    assert.ok(textContent(h.host).includes(locale === 'en' ? 'Preparation cancelled' : '准备已取消'))
    assert.ok(textContent(h.host).includes(locale === 'en' ? 'create another simulation' : '创建另一个模拟'))
    assert.ok(!textContent(h.host).includes('localPlan.'))
    blocked(h)
  } finally { h.close() }
})

test('cloud tasks never expose cancellation even if a task projection is present', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A')
    pending(h, 'getPreparationPlan').resolve(ok({ simulation_id: 'A', mode: 'cloud' })); await settle()
    pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A' })); await settle()
    assert.equal(control(h, 'cancel-preparation'), undefined)
    assert.equal(h.calls('cancelPreparation').length, 0)
  } finally { h.close() }
})

async function cancellationApi(service) {
  const source = await readFile(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ') + '\n;({cancelPreparation})', { service })
}
test('cancellation API forwards the exact body and optional AbortSignal once', async () => {
  const calls = []
  const api = await cancellationApi({ post: (...args) => { calls.push(args); return Promise.resolve({}) } })
  const body = { simulation_id: 'A', task_id: 'task-A' }, signal = new AbortController().signal
  await api.cancelPreparation(body, signal); await api.cancelPreparation(body)
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], '/api/simulation/prepare/cancel')
  assert.equal(calls[0][1], body)
  assert.equal(calls[0][2].signal, signal)
  assert.equal(calls[1][2].signal, undefined)
})

test('real Axios cancellation request transports exact JSON and does not retry a lost reply', { timeout: 5000 }, async t => {
  const received = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    received.push({ method: request.method, url: request.url, body: JSON.parse(body) })
    response.destroy()
  })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const api = await cancellationApi(axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000 }))
  await assert.rejects(api.cancelPreparation({ simulation_id: 'A', task_id: 'task-A' }, new AbortController().signal))
  assert.deepEqual(received, [{ method: 'POST', url: '/api/simulation/prepare/cancel', body: { simulation_id: 'A', task_id: 'task-A' } }])
})
