import assert from 'node:assert/strict'
import { build, settle, ok, setupView, setupChild } from './parent-route-fixture.js'

export { settle, ok, setupView, setupChild }
export const homeView = 'views/Home.vue'
export const historyChild = 'components/HistoryDatabase.vue'
export const limits = { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 }
export const localPlan = (extra = {}) => ({ simulation_id: 'A', mode: 'local', status: 'created', limits,
  owner: { busy: false, reason_code: null, task_id: null },
  prepared: { available: false, reason_code: 'prepared_unavailable', info: null }, can_prepare: true, can_reuse: false, ...extra })
export const savedPlan = (extra = {}) => localPlan({ status: 'ready', can_prepare: false, can_reuse: true,
  prepared: { available: true, info: { profiles_count: 2, configured_rounds: 2 } }, ...extra })
export const busyPlan = (reason = 'run_busy', extra = {}) => savedPlan({ status: 'running', can_reuse: false,
  owner: { busy: true, reason_code: reason, task_id: null }, ...extra })
export const task = (extra = {}) => ({ simulation_id: 'A', task_id: 'task-A', status: 'processing', progress: 30,
  progress_detail: {}, message: '', already_prepared: false, preparation_phase: 'preparing', can_cancel: true,
  cancellation_requested: false, ...extra })
export const taskPlan = (extra = {}) => localPlan({ status: 'preparing', can_prepare: false,
  owner: { busy: true, reason_code: 'preparation_busy', task_id: 'task-A' }, preparation_task: task(),
  cancellation: { blocked: false, phase: null, task_id: null, reason_code: null }, ...extra })
export const readyTask = (extra = {}) => task({ status: 'completed', preparation_phase: 'ready', can_cancel: false, ...extra })
export const fixture = (options = {}) => build({ manualPlan: true, locale: 'en', disableTransitions: true, assertNoWarnings: true, ...options })
export const pending = (h, name, id) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted
  && (id === undefined || call.args[0] === id || call.args[0]?.simulation_id === id))
export const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
export const text = node => node ? [node.text || '', ...(node.children || []).map(text)].join(' ') : ''
export const body = request => JSON.parse(JSON.stringify(request.args[0]))
export function action(button, label = 'rendered button') {
  assert.equal(button?.type, 'button', label)
  assert.equal(typeof button.props.onClick, 'function', label + ' owns a callback')
  return button.props.onClick
}
// The legacy workbench hides Start/Back at local phase zero. When absent, the
// same captured child action still has to fail closed if called by stale UI.
export function setupAction(h, name) {
  const button = control(h, 'setup-' + name)
  if (button) return action(button, 'setup-' + name)
  const callback = h.state(setupChild).plannerActions[name]
  assert.equal(typeof callback, 'function', name + ' has an owned child callback')
  return callback
}
export function gatedControl(h, name) {
  const button = control(h, name)
  assert.ok(!button || button.props.disabled === true, name + ' is absent or disabled')
}
export async function click(h, id) {
  const button = control(h, id)
  assert.ok(button && !button.props.disabled, id + ' is enabled')
  action(button, id)(); await settle()
}
export const mutations = ['closeSimulationEnv', 'stopSimulation', 'prepareSimulation', 'startSimulation', 'buildGraph', 'generateOntology', 'createSimulation']
export function noMutations(h, except = []) {
  for (const name of mutations) if (!except.includes(name)) assert.equal(h.calls(name).length, 0, name + ' is never dispatched')
  // Existing Step3 Start keeps its force payload; setup mutations never add it.
  for (const name of mutations.filter(name => name !== 'startSimulation')) for (const request of h.calls(name)) assert.notEqual(request.args[0]?.force, true, 'no force payload')
}
export function blocked(h) {
  assert.notEqual(h.state(setupChild).phase, 4, 'ownership blocks terminal readiness')
  for (const name of ['reuse-preparation', 'load-cast', 'prepare-cast', 'setup-start', 'setup-back']) {
    const button = control(h, name)
    if (button) assert.equal(button.props.disabled, true, name + ' is disabled')
  }
  assert.equal(h.state(setupChild).canPrepareLocal, false)
  assert.equal(h.state(setupChild).canReuseLocal, false)
}
// Local entry first establishes mode, then rereads admission after parent entry
// readiness. Refresh and Stop verification may require just one current read.
export async function observePlan(h, data, maximum = 2) {
  assert.ok(pending(h, 'getPreparationPlan'), 'an owned preparation-plan read exists')
  for (let index = 0; index < maximum; index++) {
    const request = pending(h, 'getPreparationPlan')
    if (!request) break
    assert.equal(request.args[0], data.simulation_id)
    request.resolve(ok(data)); await settle()
  }
}
export async function entered(h, data = localPlan()) {
  await h.mount('/simulation/' + data.simulation_id)
  await observePlan(h, data)
}
export async function metadata(h, { id = 'A', status = 'running', graph = 'GA', projectStatus = 'completed' } = {}) {
  const simulation = pending(h, 'getSimulation', id)
  assert.ok(simulation, 'local entry retains read-only simulation metadata')
  simulation.resolve(ok({ simulation_id: id, status, project_id: 'P' + id })); await settle()
  pending(h, 'getProject', 'P' + id).resolve(ok({ project_id: 'P' + id, status: projectStatus, graph_id: graph })); await settle()
}
export async function openHistorySetup(h, status = 'running') {
  await h.mount('/')
  assert.equal(h.instances[homeView].length, 1, 'the real Home is mounted')
  const history = pending(h, 'getSimulationHistory')
  assert.deepEqual(history.args, [20])
  history.resolve(ok([{ simulation_id: 'A', project_id: 'PA', status, simulation_requirement: 'Saved local simulation',
    created_at: '2026-10-16T00:00:00Z', current_round: 1, total_rounds: 5, files: [] }])); await settle()
  const card = h.find(node => node.props?.role === 'button' && String(node.props?.class).includes('project-card'))
  assert.ok(card, 'real History card is rendered')
  const historyState = h.state(historyChild)
  assert.equal(card.isConnected, true, 'rendered History card is connected')
  assert.equal(historyState.historyContainer.contains(card), true, 'History template ref preserves rendered card identity')
  card.props.onClick({ currentTarget: card, target: card }); await settle()
  assert.equal(historyState.selectedProject?.simulation_id, 'A', 'real History click selects the exact simulation before opening setup')
  const setup = h.find(node => node.type === 'button' && String(node.props?.class).includes('btn-simulation'))
  assert.ok(text(setup).includes('Env Setup'), 'real History Env Setup action is visible')
  action(setup, 'History Env Setup')()
  await h.pushes.at(-1).promise; await settle()
  assert.equal(h.router.currentRoute.value.name, 'Simulation')
  assert.equal(h.router.currentRoute.value.params.simulationId, 'A')
  assert.equal(h.child(setupChild).props.simulationId, 'A')
}
export const profiles = () => ok({ profiles: [{ name: 'Saved one', entity_type: 'Person' }, { name: 'Saved two', entity_type: 'Person' }] })
export const config = () => ok({ status: 'ready', is_generating: false, config_generated: true,
  config: { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } } })
export async function finalData(h) {
  pending(h, 'getSimulationProfilesRealtime').resolve(profiles()); await settle()
  pending(h, 'getSimulationConfigRealtime').resolve(config()); await settle()
}
export async function reuse(h, data = savedPlan()) {
  await click(h, 'reuse-preparation')
  assert.deepEqual(body(pending(h, 'prepareSimulation')), { simulation_id: data.simulation_id, preparation_mode: 'reuse' })
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  assert.ok(pending(h, 'getPreparationPlan'), 'Reuse readiness needs a fresh owned idle observation')
  await observePlan(h, data, 1)
}
