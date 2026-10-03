import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createServer } from 'node:http'
import axios from 'axios'
import vm from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'

// Run the complete actual setup script with real Vue effects. Template rendering,
// HTTP responses and the passage of time are boundaries, not duplicated logic.
const source = await readFile(new URL('../src/components/Step2EnvSetup.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const parsed = compileScript(descriptor, { id: 'preparation-polling-tests' })
let setup = descriptor.scriptSetup.content
for (const node of parsed.scriptSetupAst.filter(node => node.type === 'ImportDeclaration').reverse()) {
  setup = setup.slice(0, node.start) + setup.slice(node.end)
}
setup += '\n;({phase, taskId, prepareProgress, currentStage, profiles, entityTypes, expectedTotal, simulationConfig, selectedProfile, useCustomRounds, customMaxRounds, startPrepareSimulation, handleStartSimulation})'
const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
const apiNames = ['prepareSimulation', 'getPrepareStatus', 'getSimulationProfilesRealtime', 'getSimulationConfig', 'getSimulationConfigRealtime']
function harness(simulationId = 'A') {
  const props = reactive({ simulationId, projectData: {}, graphData: {}, systemLogs: [] })
  const scope = effectScope(), intervals = new Map(), mounted = [], unmounted = [], emitted = [], warnings = []
  const requests = Object.fromEntries(apiNames.map(name => [name, []]))
  const api = Object.fromEntries(apiNames.map(name => [name, (...args) => new Promise((resolve, reject) => {
    // Ignore abort deliberately: stale completions still need ownership guards.
    requests[name].push({ args, resolve, reject, signal: args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined })
  })]))
  let nextTimer = 0 // ID zero is a valid timer handle.
  const state = scope.run(() => vm.runInNewContext(setup, {
    ref, computed, watch, nextTick, AbortController, ...api,
    defineProps: () => props, defineEmits: () => (...args) => emitted.push(args),
    useI18n: () => ({ t: key => key }),
    onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    setInterval: (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id },
    clearInterval: id => intervals.delete(id),
    console: { warn: (...args) => warnings.push(args) },
  }))
  let closed = false
  return { props, state, requests, intervals, emitted, warnings,
    mount: async () => { mounted.forEach(callback => callback()); await settle() },
    tick: async ms => { [...intervals.values()].filter(timer => timer.ms === ms).forEach(timer => timer.callback()); await settle() },
    close: () => { if (!closed) { closed = true; unmounted.forEach(callback => callback()); scope.stop() } },
  }
}
const prepared = (extra = {}) => ({ success: true, data: { task_id: 'task-A', expected_entities_count: 2, ...extra } })
const progress = (status, extra = {}) => ({ success: true, data: { status, progress: 50, ...extra } })
const profileReply = (names = ['One', 'Two']) => ({ success: true, data: { profiles: names.map(name => ({ name, entity_type: 'Person' })), total_expected: 2 } })
const configReply = (extra = {}) => ({ success: true, data: { status: 'ready', is_generating: false, config_generated: true, config: { time_config: { total_simulation_hours: 10, minutes_per_round: 30 } }, ...extra } })
async function running(h) { await h.mount(); h.requests.prepareSimulation[0].resolve(prepared()); await settle() }
async function generatingConfig(h) {
  await running(h); await h.tick(2000)
  h.requests.getPrepareStatus[0].resolve(progress('processing', { progress_detail: { current_stage_name: 'generating_config' } })); await settle()
}
function statuses(h) { return h.emitted.filter(([event]) => event === 'update-status').map(([, status]) => status) }

test('a late preparation POST cannot install timers or mutate a retired view', async () => {
  const h = harness(); await h.mount(); h.close()
  const previous = JSON.stringify(h.emitted)
  h.requests.prepareSimulation[0].resolve(prepared()); await settle()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.state.taskId.value, null)
  assert.equal(JSON.stringify(h.emitted), previous)
  assert.equal(h.requests.prepareSimulation[0].signal?.aborted, true)
})

test('a rejected preparation POST after unmount is ignored', async () => {
  const h = harness(); await h.mount(); h.close()
  const previous = JSON.stringify(h.emitted)
  h.requests.prepareSimulation[0].reject(new Error('retired preparation')); await settle()
  assert.equal(JSON.stringify(h.emitted), previous)
  assert.equal(h.intervals.size, 0)
})

test('each status and profile stream allows only one pending request', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000); await h.tick(2000); await h.tick(3000); await h.tick(3000)
    assert.equal(h.requests.getPrepareStatus.length, 1)
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 1)
    h.requests.getPrepareStatus[0].resolve(progress('processing'))
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply(['One'])); await settle()
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.requests.getPrepareStatus.length, 2)
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 2)
    assert.equal(h.requests.getPrepareStatus[1].args[0].simulation_id, 'A')
    assert.equal(h.requests.getPrepareStatus[1].args[0].task_id, 'task-A')
    assert.equal(h.requests.getSimulationProfilesRealtime[1].args[1], undefined)
  } finally { h.close() }
})

test('config previews stay single-flight and cannot declare preparation complete', async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(2000); await h.tick(2000)
    assert.equal(h.requests.getSimulationConfigRealtime.length, 1)
    h.requests.getSimulationConfigRealtime[0].resolve(configReply({ status: 'preparing', is_generating: true })); await settle()
    assert.notEqual(h.state.simulationConfig.value, null)
    assert.notEqual(h.state.phase.value, 4)
    assert.ok(!statuses(h).includes('completed'))
    h.requests.getPrepareStatus[1].resolve(progress('failed', { error: 'script preparation failed' })); await settle()
    assert.equal(statuses(h).at(-1), 'error')
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('current read failures release slots for the next scheduled attempt', async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(2000); await h.tick(3000)
    h.requests.getPrepareStatus[1].reject(new Error('status read'))
    h.requests.getSimulationProfilesRealtime[0].reject(new Error('profile read'))
    h.requests.getSimulationConfigRealtime[0].reject(new Error('config read')); await settle()
    assert.equal(h.warnings.length, 3)
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.requests.getPrepareStatus.length, 3)
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 2)
    assert.equal(h.requests.getSimulationConfigRealtime.length, 2)
  } finally { h.close() }
})

test('unmount retires all in-flight reads and the queued stage watcher', async () => {
  const h = harness(); await running(h); await h.tick(2000); await h.tick(3000)
  h.close(); const before = JSON.stringify(h.emitted)
  h.requests.getPrepareStatus[0].resolve(progress('processing', { progress_detail: { current_stage_name: 'generating_config' } }))
  h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.state.currentStage.value, '')
  assert.equal(h.state.profiles.value.length, 0)
  assert.equal(JSON.stringify(h.emitted), before)
  assert.ok([h.requests.getPrepareStatus[0], h.requests.getSimulationProfilesRealtime[0]].every(request => request.signal?.aborted))
})

test('switching A to B to A retires old POST replies and original task identities', async () => {
  const h = harness(); try {
    await h.mount(); const oldA = h.requests.prepareSimulation[0]
    h.props.simulationId = 'B'; await settle(); const oldB = h.requests.prepareSimulation[1]
    h.props.simulationId = 'A'; await settle()
    assert.equal(h.requests.prepareSimulation.length, 3)
    oldA.resolve(prepared({ task_id: 'retired-A' })); oldB.reject(new Error('retired-B')); await settle()
    assert.equal(h.state.taskId.value, null)
    assert.equal(h.intervals.size, 0)
    assert.equal(oldA.signal?.aborted, true)
    assert.equal(oldB.signal?.aborted, true)
    h.requests.prepareSimulation[2].resolve(prepared({ task_id: 'current-A' })); await settle(); await h.tick(2000)
    assert.equal(h.requests.getPrepareStatus[0].args[0].task_id, 'current-A')
    assert.ok(!statuses(h).includes('error'))
  } finally { h.close() }
})

test('selection changes immediately reset all preparation data and local choices', async () => {
  const h = harness(); try {
    await running(h); await h.tick(3000)
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
    h.state.selectedProfile.value = h.state.profiles.value[0]
    h.state.simulationConfig.value = { previous: true }
    h.state.useCustomRounds.value = true; h.state.customMaxRounds.value = 80
    h.props.simulationId = ''
    assert.equal(h.state.profiles.value.length, 0)
    assert.equal(h.state.taskId.value, null)
    assert.equal(h.state.simulationConfig.value, null)
    assert.equal(h.state.selectedProfile.value, null)
    assert.equal(h.state.useCustomRounds.value, false)
    assert.equal(h.state.customMaxRounds.value, 40)
    assert.equal(h.intervals.size, 0)
    await settle(); assert.equal(h.requests.prepareSimulation.length, 1)
    h.props.simulationId = 'B'; await settle(); assert.equal(h.requests.prepareSimulation[1].args[0].simulation_id, 'B')
  } finally { h.close() }
})

test('stale read rejection cannot release the replacement selection slots', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000)
    const old = h.requests.getPrepareStatus[0]
    h.props.simulationId = 'B'; await settle()
    assert.equal(h.requests.prepareSimulation.length, 2)
    h.requests.prepareSimulation[1].resolve(prepared({ task_id: 'B-task' })); await settle(); await h.tick(2000)
    old.reject(new Error('aborted A')); await settle(); await h.tick(2000)
    assert.equal(h.requests.getPrepareStatus.length, 2)
    assert.equal(h.warnings.length, 0)
    assert.equal(h.requests.getPrepareStatus[1].args[0].simulation_id, 'B')
  } finally { h.close() }
})

test('already-prepared reuse loads profiles then config and completes once', async () => {
  const h = harness(); try {
    await h.mount(); h.requests.prepareSimulation[0].resolve(prepared({ already_prepared: true })); await settle()
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 1)
    assert.equal(h.requests.getSimulationConfigRealtime.length, 0)
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
    h.requests.getSimulationConfigRealtime[0].resolve(configReply()); await settle()
    assert.equal(h.state.phase.value, 4)
    assert.equal(h.state.profiles.value.length, 2)
    assert.equal(h.intervals.size, 0)
    assert.equal(statuses(h).filter(status => status === 'completed').length, 1)
    h.state.handleStartSimulation()
    assert.equal(h.emitted.at(-1)[0], 'next-step')
    assert.deepEqual(Object.keys(h.emitted.at(-1)[1]), [])
  } finally { h.close() }
})

for (const stage of ['profiles', 'config']) test(`unmount during final ${stage} load cannot continue or publish completion`, async () => {
  const h = harness(); await h.mount(); h.requests.prepareSimulation[0].resolve(prepared({ already_prepared: true })); await settle()
  if (stage === 'config') { h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle() }
  h.close(); const before = JSON.stringify(h.emitted)
  if (stage === 'profiles') h.requests.getSimulationProfilesRealtime[0].resolve(profileReply())
  else h.requests.getSimulationConfigRealtime[0].resolve(configReply())
  await settle()
  assert.equal(JSON.stringify(h.emitted), before)
  assert.notEqual(h.state.phase.value, 4)
  assert.equal(h.intervals.size, 0)
  if (stage === 'profiles') assert.equal(h.requests.getSimulationConfigRealtime.length, 0)
})

test('final loading waits for old streams then obtains fresh final profile and config snapshots', async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(3000); await h.tick(2000)
    h.requests.getPrepareStatus[1].resolve(progress('ready')); await settle()
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 1)
    assert.equal(h.requests.getSimulationConfigRealtime.length, 1)
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply(['Earlier'])); await settle()
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 2)
    h.requests.getSimulationProfilesRealtime[1].resolve(profileReply()); await settle()
    assert.equal(h.requests.getSimulationConfigRealtime.length, 1)
    h.requests.getSimulationConfigRealtime[0].resolve(configReply({ status: 'preparing', is_generating: true, config: { old: true } })); await settle()
    assert.equal(h.requests.getSimulationConfigRealtime.length, 2)
    assert.notEqual(h.state.phase.value, 4)
    h.requests.getSimulationConfigRealtime[1].resolve(configReply()); await settle()
    assert.equal(h.state.phase.value, 4)
    assert.equal(h.state.profiles.value.length, 2)
    assert.equal(h.state.simulationConfig.value.time_config.total_simulation_hours, 10)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('terminal failure rejects late profile/config data and stage-driven polling restart', async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(2000); await h.tick(3000)
    h.requests.getPrepareStatus[1].resolve(progress('failed', { error: 'failed preparation' })); await settle()
    const before = JSON.stringify(h.emitted)
    h.requests.getSimulationConfigRealtime[0].resolve(configReply())
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
    assert.equal(statuses(h).at(-1), 'error')
    assert.equal(JSON.stringify(h.emitted), before)
    assert.notEqual(h.state.phase.value, 4)
    assert.equal(h.state.profiles.value.length, 0)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('prepared config still being generated is polled until usable, without completing from preview', async () => {
  const h = harness(); try {
    await h.mount(); h.requests.prepareSimulation[0].resolve(prepared({ already_prepared: true })); await settle()
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
    h.requests.getSimulationConfigRealtime[0].resolve(configReply({ status: 'preparing', is_generating: true })); await settle()
    assert.notEqual(h.state.phase.value, 4)
    assert.ok(h.intervals.size > 0)
    await h.tick(2000)
    h.requests.getSimulationProfilesRealtime[1].resolve(profileReply()); await settle()
    h.requests.getSimulationConfigRealtime[1].resolve(configReply()); await settle()
    assert.equal(h.state.phase.value, 4)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('no preparation is submitted without a mounted nonempty selection', async () => {
  const h = harness(''); try {
    await h.mount(); assert.equal(h.requests.prepareSimulation.length, 0)
    h.props.simulationId = 'A'; await settle(); assert.equal(h.requests.prepareSimulation.length, 1)
    h.state.startPrepareSimulation(); h.state.startPrepareSimulation(); await settle()
    assert.equal(h.requests.prepareSimulation.length, 1)
  } finally { h.close() }
})

test('preparation API helpers forward optional signals without changing bodies or platform defaults', async () => {
  const calls = []
  const apiSource = await readFile(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  const api = vm.runInNewContext(apiSource.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ') + '\n;({prepareSimulation,getPrepareStatus,getSimulationProfilesRealtime,getSimulationConfigRealtime})', {
    service: { post: (...args) => { calls.push(args); return Promise.resolve({}) }, get: (...args) => { calls.push(args); return Promise.resolve({}) } },
  })
  const controller = new AbortController(), body = { simulation_id: 'A', parallel_profile_count: 5 }
  await api.prepareSimulation(body, controller.signal)
  await api.getPrepareStatus(body, controller.signal)
  await api.getSimulationConfigRealtime('A', controller.signal)
  await api.getSimulationProfilesRealtime('A', undefined, controller.signal)
  assert.equal(calls[0][1], body); assert.equal(calls[1][1], body)
  assert.equal(calls[0][2]?.signal, controller.signal); assert.equal(calls[1][2]?.signal, controller.signal)
  assert.equal(calls[2][1]?.signal, controller.signal); assert.equal(calls[3][1]?.signal, controller.signal)
  assert.deepEqual(Object.keys(calls[3][1].params), [])
  await api.getSimulationProfilesRealtime('A', 'twitter')
  assert.equal(calls[4][1].params.platform, 'twitter')
  await api.prepareSimulation(body); assert.equal(calls[5][1], body)
  assert.equal(calls[5][2]?.signal, undefined)
})

test('undefined selection and pre-completion Start actions remain harmless', async () => {
  const h = harness(); h.props.simulationId = undefined
  try {
    await h.mount()
    assert.doesNotThrow(() => h.state.handleStartSimulation())
    await h.state.startPrepareSimulation()
    assert.equal(h.requests.prepareSimulation.length, 0)
    h.props.simulationId = 'A'; await settle()
    h.state.handleStartSimulation()
    assert.equal(h.emitted.filter(([event]) => event === 'next-step').length, 0)
  } finally { h.close() }
})

for (const rejection of [false, true]) test(`current prepare ${rejection ? 'rejection' : 'error response'} ends observation once`, async () => {
  const h = harness(); try {
    await h.mount()
    if (rejection) h.requests.prepareSimulation[0].reject(new Error('current failure'))
    else h.requests.prepareSimulation[0].resolve({ success: false, error: 'current failure' })
    await settle()
    assert.deepEqual(statuses(h), ['processing', 'error'])
    assert.equal(h.intervals.size, 0)
    assert.equal(h.requests.prepareSimulation[0].signal?.aborted, true)
  } finally { h.close() }
})

test('normal task readiness waits for final data and retains custom next-step parameters', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000)
    assert.deepEqual(Object.keys(h.requests.prepareSimulation[0].args[0]).sort(), ['parallel_profile_count', 'simulation_id', 'use_llm_for_profiles'])
    assert.equal(h.requests.prepareSimulation[0].args[0].parallel_profile_count, 5)
    assert.equal(h.requests.prepareSimulation[0].args[0].use_llm_for_profiles, true)
    h.requests.getPrepareStatus[0].resolve(progress('completed')); await settle()
    assert.ok(!statuses(h).includes('completed'))
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
    h.requests.getSimulationConfigRealtime[0].resolve(configReply()); await settle()
    h.state.useCustomRounds.value = true; h.state.customMaxRounds.value = 55
    h.state.handleStartSimulation()
    assert.equal(h.emitted.at(-1)[0], 'next-step')
    assert.equal(h.emitted.at(-1)[1].maxRounds, 55)
    assert.equal(h.emitted.at(-2)[0], 'add-log')
    assert.equal(h.state.phase.value, 4)
    assert.equal(h.state.profiles.value.length, 2)
    assert.equal(h.intervals.size, 0)
    h.close(); const count = h.emitted.length; h.state.handleStartSimulation()
    assert.equal(h.emitted.length, count)
  } finally { h.close() }
})

test('config failure retires pending status success before it can start final loading', async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(2000)
    h.requests.getSimulationConfigRealtime[0].resolve(configReply({ status: 'failed', error: 'config failed' })); await settle()
    const before = JSON.stringify(h.emitted)
    h.requests.getPrepareStatus[1].resolve(progress('ready', { progress_detail: { current_stage_name: 'generating_config' } })); await settle()
    assert.equal(statuses(h).at(-1), 'error')
    assert.equal(JSON.stringify(h.emitted), before)
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 0)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('final config rejection reports error while a retired rejection is silent', async () => {
  for (const retired of [false, true]) {
    const h = harness(); try {
      await h.mount(); h.requests.prepareSimulation[0].resolve(prepared({ already_prepared: true })); await settle()
      h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
      if (retired) h.close()
      const before = JSON.stringify(h.emitted)
      h.requests.getSimulationConfigRealtime[0].reject(new Error('config transport failure')); await settle()
      if (retired) assert.equal(JSON.stringify(h.emitted), before)
      else assert.equal(statuses(h).at(-1), 'error')
      assert.equal(h.intervals.size, 0)
      assert.equal(h.warnings.length, 0)
    } finally { h.close() }
  }
})

test('changing selection during final profile load cannot request another simulation config', async () => {
  const h = harness(); try {
    await h.mount(); h.requests.prepareSimulation[0].resolve(prepared({ already_prepared: true })); await settle()
    const old = h.requests.getSimulationProfilesRealtime[0]
    h.props.simulationId = 'B'; await settle()
    old.resolve(profileReply()); await settle()
    assert.equal(h.state.profiles.value.length, 0)
    assert.equal(h.requests.getSimulationConfigRealtime.length, 0)
    assert.equal(old.signal.aborted, true)
    assert.equal(h.requests.prepareSimulation[1].args[0].simulation_id, 'B')
  } finally { h.close() }
})

for (const endpoint of ['prepare', 'status', 'config']) test(`real Axios cancels a pending ${endpoint} observation`, { timeout: 5000 }, async t => {
  let received, disconnected
  const arrival = new Promise(resolve => { received = resolve })
  const departure = new Promise(resolve => { disconnected = resolve })
  const server = createServer((request, response) => {
    response.on('close', disconnected)
    received(request.url)
  })
  const controller = new AbortController()
  t.after(async () => {
    controller.abort(); server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const service = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000 })
  const apiSource = await readFile(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  const api = vm.runInNewContext(apiSource.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ') + '\n;({prepareSimulation,getPrepareStatus,getSimulationConfigRealtime})', { service })
  const pending = endpoint === 'prepare' ? api.prepareSimulation({ simulation_id: 'synthetic' }, controller.signal)
    : endpoint === 'status' ? api.getPrepareStatus({ simulation_id: 'synthetic' }, controller.signal)
      : api.getSimulationConfigRealtime('synthetic', controller.signal)
  const rejected = assert.rejects(pending, error => axios.isCancel(error))
  assert.equal(await arrival, endpoint === 'prepare' ? '/api/simulation/prepare' : endpoint === 'status' ? '/api/simulation/prepare/status' : '/api/simulation/synthetic/config/realtime')
  controller.abort(); await rejected; await departure
})

for (const rejection of [false, true]) test(`authoritative readiness retires an earlier config ${rejection ? 'rejection' : 'failed snapshot'} before final loading`, async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(2000)
    const oldConfig = h.requests.getSimulationConfigRealtime[0]
    h.requests.getPrepareStatus[1].resolve(progress('ready'))
    // Resolve both before yielding: final-read ownership must be retired at the
    // ready handoff, not in a later asynchronous work callback.
    if (rejection) oldConfig.reject(new Error('older config request'))
    else oldConfig.resolve(configReply({ status: 'failed', error: 'older config snapshot' }))
    await settle()
    assert.ok(!statuses(h).includes('error'))
    assert.equal(h.warnings.length, 0)
    assert.equal(h.requests.getSimulationProfilesRealtime.length, 1)
    h.requests.getSimulationProfilesRealtime[0].resolve(profileReply()); await settle()
    assert.equal(h.requests.getSimulationConfigRealtime.length, 2)
    h.requests.getSimulationConfigRealtime[1].resolve(configReply()); await settle()
    assert.equal(h.state.phase.value, 4)
    assert.deepEqual(statuses(h), ['processing', 'completed'])
  } finally { h.close() }
})

test('generated config during script preparation remains a preview until authoritative readiness', async () => {
  const h = harness(); try {
    await generatingConfig(h); await h.tick(2000)
    h.requests.getSimulationConfigRealtime[0].resolve(configReply({ status: 'preparing', is_generating: true })); await settle()
    assert.equal(h.state.simulationConfig.value.time_config.total_simulation_hours, 10)
    assert.notEqual(h.state.phase.value, 4)
    assert.deepEqual(statuses(h), ['processing'])
    assert.ok(h.intervals.size > 0)
    h.requests.getPrepareStatus[1].resolve(progress('failed', { error: 'copying scripts failed' })); await settle()
    assert.deepEqual(statuses(h), ['processing', 'error'])
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})
