import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, setupView, setupChild, runChild } from './helpers/parent-route-fixture.js'

export const limits = { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 }
export const localPlan = (extra = {}) => ({ simulation_id: 'A', mode: 'local', status: 'created', limits,
  owner: { busy: false, reason_code: null, task_id: null }, prepared: { available: false, reason_code: 'prepared_unavailable', info: null }, can_prepare: true, can_reuse: false, ...extra })
export const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, name) => h.find(node => node.props?.['data-testid'] === name)
const click = async (h, name) => { const button = control(h, name); assert.ok(button, name); assert.ok(!button.props.disabled, name + ' enabled'); button.props.onClick(); await settle() }
const entities = ['a','b','c'].map(uuid => ({ uuid, name: 'Person ' + uuid, entity_type: 'Person', summary: 'Summary', text_truncated: false }))
async function cleanup(h) { pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle(); pending(h, 'getSimulation').resolve(ok({ status: 'created' })); await settle() }
async function planned(h, plan = localPlan()) {
  await h.mount('/simulation/A')
  assert.equal(h.calls('prepareSimulation').length, 0, 'mode is unresolved')
  pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle()
  await cleanup(h)
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle() }
}
async function ready(h, config = { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } }) {
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [] })); await settle()
  pending(h, 'getSimulationConfigRealtime').resolve(ok({ status: 'ready', is_generating: false, config_generated: true, config })); await settle()
}

test('local setup waits for cleanup and explicit cast loading before any preparation POST', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A')
    assert.equal(h.calls('prepareSimulation').length, 0)
    pending(h, 'getPreparationPlan').resolve(ok(localPlan())); await settle()
    assert.equal(control(h, 'load-cast').props.disabled, true)
    assert.notEqual(h.state(setupView).currentStatus, 'processing')
    await cleanup(h)
    pending(h, 'getPreparationPlan').resolve(ok(localPlan())); await settle()
    assert.equal(h.calls('previewPreparation').length, 0)
    await click(h, 'load-cast'); await click(h, 'load-cast').catch(() => {})
    assert.equal(h.calls('previewPreparation').length, 1)
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', entities, limits, eligible_count: 3, total_nodes: 3 })); await settle()
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.ok(control(h, 'prepare-cast').props.disabled)
    control(h, 'entity-a').props.onChange({ target: { checked: true } }); await settle()
    await click(h, 'prepare-cast')
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'prepareSimulation').args[0])), {
      simulation_id: 'A', preparation_mode: 'prepare', selected_entity_ids: ['a'], use_llm_for_profiles: false, parallel_profile_count: 1,
    })
  } finally { h.close() }
})

test('only confirmed cloud mode preserves automatic legacy preparation payload', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A'); assert.equal(h.calls('prepareSimulation').length, 0)
    pending(h, 'getPreparationPlan').resolve(ok({ simulation_id: 'A', mode: 'cloud', limits: null })); await settle()
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'prepareSimulation').args[0])), { simulation_id: 'A', use_llm_for_profiles: true, parallel_profile_count: 5 })
  } finally { h.close() }
})

for (const bad of [null, { valid: false }, { ...limits, max_rounds: 0 }, { ...limits, max_concurrency: '1' }]) test('invalid loaded limits fail closed: ' + JSON.stringify(bad), async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h, localPlan({ limits: bad }))
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.ok(control(h, 'load-cast').props.disabled)
    assert.equal(h.calls('previewPreparation').length, 0)
  } finally { h.close() }
})

test('saved reuse has a strict body and no graph or generation options, with cap-one routed to Step3', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h, localPlan({ limits: { ...limits, max_rounds: 1 }, can_prepare: false, can_reuse: true,
      prepared: { available: true, info: { profiles_count: 2, configured_rounds: 2 } } }))
    assert.equal(control(h, 'load-cast'), undefined)
    assert.equal(control(h, 'profile-mode'), undefined)
    await click(h, 'reuse-preparation')
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'prepareSimulation').args[0])), { simulation_id: 'A', preparation_mode: 'reuse' })
    assert.equal(h.calls('getGraphData').length, 0)
    assert.equal(h.calls('previewPreparation').length, 0)
    await ready(h)
    assert.equal(control(h, 'maximum-rounds').props.max, 1)
    assert.equal(h.state(setupChild).effectiveLocalRounds, 1)
    const start = h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
    const navigated = new Promise(resolve => { const remove = h.router.afterEach(to => { if (to.name === 'SimulationRun') { remove(); resolve() } }) })
    start.props.onClick(); await navigated; await settle()
    assert.equal(h.router.currentRoute.value.query.maxRounds, '1')
    assert.equal(h.child(runChild).props.maxRounds, 1)
    assert.equal(h.calls('startSimulation')[0].args[0].max_rounds, 1)
  } finally { h.close() }
})

for (const reason of ['run_busy','updater_busy','lifecycle_busy','ownership_unavailable']) test('owner ' + reason + ' blocks local actions', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h, localPlan({ owner: { busy: true, reason_code: reason, task_id: null }, can_prepare: false }))
    assert.ok(control(h, 'load-cast').props.disabled)
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

test('identified active preparation is observed without another POST', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h, localPlan({ status: 'preparing', owner: { busy: true, reason_code: 'preparation_busy', task_id: 'task-existing' }, can_prepare: false }))
    await h.tick(2000)
    assert.equal(pending(h, 'getPrepareStatus').args[0].task_id, 'task-existing')
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

async function planCurrentSelection(h, plan = localPlan()) {
  pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle()
  await cleanup(h)
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle() }
}

test('retired rendered local action and selection callbacks cannot act on A after A → B → A', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await click(h, 'load-cast')
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', entities, limits, eligible_count: 3 })); await settle()
    const oldSelect = control(h, 'entity-a').props.onChange
    const oldLoad = control(h, 'load-cast').props.onClick
    const oldPrepare = control(h, 'prepare-cast').props.onClick
    await h.navigate('/simulation/B')
    await h.navigate('/simulation/A')
    await planCurrentSelection(h)
    await click(h, 'load-cast')
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', entities, limits, eligible_count: 3 })); await settle()
    const before = h.calls('previewPreparation').length
    oldSelect({ target: { checked: true } }); oldPrepare(); oldLoad(); await settle()
    assert.deepEqual(Array.from(h.state(setupChild).selectedEntityIds), [])
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.equal(h.calls('previewPreparation').length, before)
  } finally { h.close() }
})

for (const outcome of ['success', 'failure']) test('retired local cast ' + outcome + ' cannot overwrite another selection', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await click(h, 'load-cast'); const old = pending(h, 'previewPreparation')
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await planCurrentSelection(h)
    await click(h, 'load-cast'); const current = pending(h, 'previewPreparation')
    if (outcome === 'success') old.resolve(ok({ simulation_id: 'A', entities, limits, eligible_count: 3 }))
    else old.reject(new Error('private /path secret'))
    await settle()
    assert.equal(h.state(setupChild).loadingCast, true)
    assert.equal(h.state(setupChild).catalog.length, 0)
    assert.equal(h.state(setupChild).planError, '')
    assert.equal(old.signal.aborted, true)
    current.resolve(ok({ simulation_id: 'A', entities: [entities[1]], limits, eligible_count: 1 })); await settle()
    assert.deepEqual(Array.from(h.state(setupChild).catalog, item => item.uuid), ['b'])
  } finally { h.close() }
})

test('exact selections persist through type filtering, cap enforcement and LLM choice', async () => {
  const h = build({ manualPlan: true }); try {
    const limited = { ...limits, max_agents: 2, max_selectable_agents: 2 }
    await planned(h, localPlan({ limits: limited })); await click(h, 'load-cast')
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', entities: [...entities, { ...entities[0], uuid: 'd', entity_type: 'Organization' }], limits: limited, eligible_count: 4 })); await settle()
    control(h, 'entity-a').props.onChange({ target: { checked: true } }); await settle()
    control(h, 'cast-filter').props.onChange({ target: { value: 'Organization' } }); await settle()
    assert.equal(control(h, 'entity-a'), undefined)
    control(h, 'entity-d').props.onChange({ target: { checked: true } }); await settle()
    control(h, 'cast-filter').props.onChange({ target: { value: 'Person' } }); await settle()
    assert.equal(control(h, 'entity-a').props.checked, true)
    assert.equal(control(h, 'entity-b').props.disabled, true)
    control(h, 'entity-b').props.onChange({ target: { checked: true } }); await settle()
    control(h, 'profile-mode').props.onChange({ target: { value: 'llm' } }); await settle()
    await click(h, 'prepare-cast')
    const payload = pending(h, 'prepareSimulation').args[0]
    assert.deepEqual(Array.from(payload.selected_entity_ids), ['a', 'd'])
    assert.equal(payload.use_llm_for_profiles, true)
    assert.equal(payload.parallel_profile_count, 1)
  } finally { h.close() }
})

for (const outcome of ['missing', 'unknown', 'failure']) test('unresolved mode ' + outcome + ' never automatically prepares', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A')
    const request = pending(h, 'getPreparationPlan')
    if (outcome === 'failure') request.reject(new Error('private /path secret'))
    else request.resolve(ok({ simulation_id: 'A', ...(outcome === 'unknown' ? { mode: 'mystery' } : {}) }))
    await settle(); await cleanup(h)
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.equal(h.calls('previewPreparation').length, 0)
    assert.equal(h.state(setupChild).planError, 'localPlan.requestError')
    assert.ok(!JSON.stringify(h.state(setupView).systemLogs).includes('/path'))
  } finally { h.close() }
})

test('local plan response started before cleanup is reread before enabling actions', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A'); const early = pending(h, 'getPreparationPlan')
    await cleanup(h)
    early.resolve(ok(localPlan())); await settle()
    assert.equal(control(h, 'load-cast').props.disabled, true)
    assert.equal(h.calls('getPreparationPlan').length, 2)
    pending(h, 'getPreparationPlan').resolve(ok(localPlan({ owner: { busy: true, reason_code: 'run_busy', task_id: null }, can_prepare: false }))); await settle()
    assert.equal(control(h, 'load-cast').props.disabled, true)
  } finally { h.close() }
})

for (const failure of ['rejected', 'malformed']) test('cleanup-triggered ' + failure + ' plan read waits for explicit Refresh instead of looping', async () => {
  const h = build({ manualPlan: true }); try {
    await h.mount('/simulation/A')
    pending(h, 'getPreparationPlan').resolve(ok(localPlan())); await settle(); await cleanup(h)
    const second = pending(h, 'getPreparationPlan')
    if (failure === 'rejected') second.reject(new Error('no plan'))
    else second.resolve(ok({ mode: 'local' }))
    await settle()
    assert.equal(h.calls('getPreparationPlan').length, 2)
    assert.equal(h.state(setupChild).planLoading, false)
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

const textContent = node => [node.text || '', ...(node.children || []).map(textContent)].join(' ')
for (const locale of ['en', 'zh']) test('actual planner renders literal ' + locale + ' copy and local round semantics', async () => {
  const h = build({ manualPlan: true, locale }); try {
    await planned(h)
    assert.ok(textContent(h.host).includes(locale === 'en' ? 'Load cast' : '加载角色'))
    await click(h, 'load-cast')
    pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', entities, limits, eligible_count: 3 })); await settle()
    const text = textContent(h.host)
    assert.ok(text.includes(locale === 'en' ? 'Template profiles' : '模板人设'))
    assert.ok(text.includes(locale === 'en' ? 'configuration generation still uses the model' : '模拟配置生成仍然需要调用模型'))
    assert.ok(!text.includes('localPlan.'))
    control(h, 'entity-a').props.onChange({ target: { checked: true } }); await settle()
    await click(h, 'prepare-cast'); await ready(h)
    assert.ok(textContent(h.host).includes(locale === 'en' ? 'Maximum rounds' : '最大轮数'))
    assert.ok(!h.find(node => String(node.props?.class).includes('duration-badge')))
    assert.equal(h.state(setupChild).effectiveLocalRounds, 2)
    for (const value of ['', '0', '-1', '2.5', '6', 'Infinity']) {
      control(h, 'maximum-rounds').props.onInput({ target: { value } }); await settle()
      const start = h.find(node => String(node.props?.class).includes('action-btn primary'))
      assert.equal(start.props.disabled, true, 'invalid round value ' + value)
    }
    control(h, 'maximum-rounds').props.onInput({ target: { value: '1' } }); await settle()
    assert.equal(h.state(setupChild).effectiveLocalRounds, 1)
    assert.equal(h.find(node => String(node.props?.class).includes('action-btn primary')).props.disabled, false)
  } finally { h.close() }
})

test('local parent metadata never loads graph automatically and explicit graph refresh remains available', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h)
    pending(h, 'getSimulation').resolve(ok({ project_id: 'PA' })); await settle()
    pending(h, 'getProject').resolve(ok({ project_id: 'PA', graph_id: 'GA' })); await settle()
    assert.equal(h.calls('getGraphData').length, 0)
    await click(h, 'refresh-local-graph')
    assert.equal(pending(h, 'getGraphData').args[0], 'GA')
  } finally { h.close() }
})

for (const phase of ['profiles', 'config']) test('local final ' + phase + ' response loses ownership after navigation', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h, localPlan({ can_prepare: false, can_reuse: true, prepared: { available: true, info: { profiles_count: 2 } } }))
    await click(h, 'reuse-preparation')
    pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
    if (phase === 'config') { pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [] })); await settle() }
    const old = pending(h, phase === 'profiles' ? 'getSimulationProfilesRealtime' : 'getSimulationConfigRealtime')
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A')
    old.resolve(ok(phase === 'profiles' ? { profiles: [{ name: 'old' }] } : { config_generated: true, config: {}, status: 'ready', is_generating: false })); await settle()
    assert.equal(h.state(setupChild).phase, 0)
    assert.equal(h.state(setupChild).profiles.length, 0)
    assert.equal(h.state(setupChild).simulationConfig, null)
    assert.equal(old.signal.aborted, true)
  } finally { h.close() }
})

test('retired local round input and Start handlers cannot change or start the second A selection', async () => {
  const h = build({ manualPlan: true }); try {
    const saved = localPlan({ can_prepare: false, can_reuse: true, prepared: { available: true, info: { profiles_count: 2 } } })
    await planned(h, saved); await click(h, 'reuse-preparation'); await ready(h)
    const oldInput = control(h, 'maximum-rounds').props.onInput
    const oldStart = h.find(node => String(node.props?.class).includes('action-btn primary')).props.onClick
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await planCurrentSelection(h, saved)
    await click(h, 'reuse-preparation'); await ready(h)
    oldInput({ target: { value: '1' } }); await settle()
    assert.equal(h.state(setupChild).localMaxRounds, 5)
    oldStart(); await new Promise(resolve => setImmediate(resolve)); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
    assert.equal(h.calls('startSimulation').length, 0)
  } finally { h.close() }
})

test('unavailable configured rounds show no invented local duration or round total', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h, localPlan({ can_prepare: false, can_reuse: true, prepared: { available: true, info: { profiles_count: 2, configured_rounds: null } } }))
    await click(h, 'reuse-preparation'); await ready(h, { time_config: { total_simulation_hours: Infinity, minutes_per_round: 30 } })
    assert.equal(h.state(setupChild).effectiveLocalRounds, null)
    const text = textContent(h.host)
    assert.ok(text.includes('Configured rounds are unavailable'))
    assert.ok(!text.includes('Infinity'))
    assert.equal(control(h, 'maximum-rounds').props.value, 5)
  } finally { h.close() }
})

test('retired explicit graph refresh cannot initialize a replacement local selection', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h)
    pending(h, 'getSimulation').resolve(ok({ project_id: 'PA' })); await settle()
    pending(h, 'getProject').resolve(ok({ project_id: 'PA', graph_id: 'GA' })); await settle()
    const oldRefresh = control(h, 'refresh-local-graph').props.onClick
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await planCurrentSelection(h)
    pending(h, 'getSimulation').resolve(ok({ project_id: 'PA' })); await settle()
    pending(h, 'getProject').resolve(ok({ project_id: 'PA', graph_id: 'GA' })); await settle()
    oldRefresh(); await settle()
    assert.equal(h.calls('getGraphData').length, 0)
  } finally { h.close() }
})
