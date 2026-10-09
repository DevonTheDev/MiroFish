import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'
import axios from 'axios'
import { parse, compileScript } from '@vue/compiler-sfc'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'

// Complete actual setup script, real Vue effects; only HTTP, lifecycle hooks,
// router navigation and timers are boundaries. No template/browser claim.
const source = await readFile(new URL('../src/components/Step3Simulation.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const parsed = compileScript(descriptor, { id: 'simulation-polling-tests' })
let setup = descriptor.scriptSetup.content
for (const node of parsed.scriptSetupAst.filter(node => node.type === 'ImportDeclaration').reverse()) {
  setup = setup.slice(0, node.start) + setup.slice(node.end)
}
setup += '\n;({phase,isStarting,isStopping,isGeneratingReport,startError,runStatus,allActions,actionIds,prevTwitterRound,prevRedditRound,doStartSimulation,handleStopSimulation,handleNextStep})'
const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() } }
const names = ['startSimulation', 'stopSimulation', 'getRunStatus', 'getRunStatusDetail', 'generateReport']
function harness(simulationId = 'A', maxRounds) {
  const props = reactive({ simulationId, maxRounds, minutesPerRound: 30, projectData: {}, graphData: {}, systemLogs: [] })
  const scope = effectScope(), intervals = new Map(), mounted = [], unmounted = [], emitted = [], warnings = [], routes = []
  const requests = Object.fromEntries(names.map(name => [name, []]))
  const api = Object.fromEntries(names.map(name => [name, (...args) => new Promise((resolve, reject) => {
    // Abort is deliberately ignored here to test stale continuation ownership.
    requests[name].push({ args, resolve, reject, signal: args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined })
  })]))
  let nextTimer = 1
  const state = scope.run(() => vm.runInNewContext(setup, {
    ref, computed, watch, nextTick, AbortController, ...api,
    defineProps: () => props, defineEmits: () => (...args) => emitted.push(args),
    useI18n: () => ({ t: key => key }), useRouter: () => ({ push: route => routes.push(route) }),
    onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    setInterval: (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id },
    clearInterval: id => intervals.delete(id), console: { warn: (...args) => warnings.push(args) },
  }))
  let closed = false
  return { state, props, requests, intervals, emitted, warnings, routes,
    mount: async () => { mounted.forEach(callback => callback()); await settle() },
    tick: async ms => { [...intervals.values()].filter(timer => timer.ms === ms).forEach(timer => timer.callback()); await settle() },
    close: () => { if (!closed) { closed = true; unmounted.forEach(callback => callback()); scope.stop() } },
  }
}
const reply = (runner_status = 'running', extra = {}) => ({ success: true, data: { runner_status, total_rounds: 8, ...extra } })
const action = (id, platform = 'twitter') => ({ id, timestamp: `time-${id}`, platform, agent_id: 0, action_type: 'CREATE_POST', agent_name: 'Synthetic', action_args: { content: id } })
const detail = (...actions) => ({ success: true, data: { all_actions: actions } })
const statuses = h => h.emitted.filter(([name]) => name === 'update-status').map(([, value]) => value)
async function running(h) { await h.mount(); h.requests.startSimulation[0].resolve(reply()); await settle() }
async function completed(h, status = 'completed') {
  await h.tick(2000); h.requests.getRunStatus.at(-1).resolve(reply(status)); await settle()
}

for (const rejected of [false, true]) test(`retired start ${rejected ? 'failure' : 'success'} cannot restart polling or publish`, async () => {
  const h = harness(); await h.mount(); h.close(); const before = JSON.stringify(h.emitted)
  if (rejected) h.requests.startSimulation[0].reject(new Error('old start'))
  else h.requests.startSimulation[0].resolve(reply())
  await settle()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.state.phase.value, 0)
  assert.equal(JSON.stringify(h.emitted), before)
  assert.equal(h.requests.startSimulation[0].signal?.aborted, true)
})

for (const rounds of [undefined, 42]) test(`automatic startup preserves auto/force/memory payload with rounds ${rounds}`, async () => {
  const h = harness('A', rounds); try {
    await h.mount(); const payload = h.requests.startSimulation[0].args[0]
    assert.equal(payload.simulation_id, 'A'); assert.equal(payload.platform, 'auto')
    assert.equal(payload.force, true); assert.equal(payload.enable_graph_memory_update, true)
    assert.equal(payload.max_rounds, rounds)
    assert.equal(Object.hasOwn(payload, 'max_rounds'), rounds !== undefined)
    h.state.doStartSimulation(); h.state.doStartSimulation(); await settle()
    assert.equal(h.requests.startSimulation.length, 1)
    h.requests.startSimulation[0].resolve(reply()); await settle()
    assert.equal(h.state.phase.value, 1)
    assert.equal(h.intervals.size, 2)
    assert.deepEqual(statuses(h), ['processing'])
  } finally { h.close() }
})

test('status and detail polling allow only one request each, then resume after settlement', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000); await h.tick(2000); await h.tick(3000); await h.tick(3000)
    assert.equal(h.requests.getRunStatus.length, 1)
    assert.equal(h.requests.getRunStatusDetail.length, 1)
    h.requests.getRunStatus[0].resolve(reply('running', { twitter_current_round: 2 }))
    h.requests.getRunStatusDetail[0].resolve(detail(action('one'))); await settle()
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.requests.getRunStatus.length, 2)
    assert.equal(h.requests.getRunStatusDetail.length, 2)
    assert.equal(h.state.runStatus.value.twitter_current_round, 2)
    assert.equal(h.state.allActions.value[0].id, 'one')
  } finally { h.close() }
})

test('current polling rejections release request slots without stopping later attempts', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000); await h.tick(3000)
    h.requests.getRunStatus[0].reject(new Error('status')); h.requests.getRunStatusDetail[0].reject(new Error('detail')); await settle()
    assert.equal(h.warnings.length, 2)
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.requests.getRunStatus.length, 2); assert.equal(h.requests.getRunStatusDetail.length, 2)
  } finally { h.close() }
})

test('A to B to A uses distinct ownership and ignores old start results', async () => {
  const h = harness(); try {
    await h.mount(); const oldA = h.requests.startSimulation[0]
    h.props.simulationId = 'B'; await settle()
    assert.equal(h.requests.startSimulation.length, 2); const oldB = h.requests.startSimulation[1]
    h.props.simulationId = 'A'; await settle(); assert.equal(h.requests.startSimulation.length, 3)
    oldA.resolve(reply()); oldB.reject(new Error('old B')); await settle()
    assert.equal(h.state.isStarting.value, true); assert.equal(h.state.phase.value, 0)
    assert.equal(h.intervals.size, 0); assert.ok(!statuses(h).includes('error'))
    h.requests.startSimulation[2].resolve(reply()); await settle()
    assert.equal(h.state.isStarting.value, false); assert.equal(h.state.phase.value, 1)
    assert.equal(oldA.signal?.aborted, true); assert.equal(oldB.signal?.aborted, true)
  } finally { h.close() }
})

test('ID clearing resets displayed state, aborts reads and stays idle until another ID', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000); await h.tick(3000)
    h.requests.getRunStatus[0].resolve(reply('running', { twitter_current_round: 3 }))
    h.requests.getRunStatusDetail[0].resolve(detail(action('old'))); await settle()
    await h.tick(2000); await h.tick(3000)
    const oldStatus = h.requests.getRunStatus[1], oldDetail = h.requests.getRunStatusDetail[1]
    h.props.simulationId = null
    assert.equal(h.state.phase.value, 0); assert.equal(h.state.allActions.value.length, 0)
    assert.equal(Object.keys(h.state.runStatus.value).length, 0); assert.equal(h.state.prevTwitterRound.value, 0)
    assert.equal(h.intervals.size, 0)
    oldStatus.resolve(reply('completed')); oldDetail.resolve(detail(action('retired'))); await settle()
    assert.equal(h.state.phase.value, 0); assert.equal(h.state.allActions.value.length, 0)
    assert.equal(oldStatus.signal?.aborted, true); assert.equal(oldDetail.signal?.aborted, true)
    h.props.simulationId = 'B'; await settle(); assert.equal(h.requests.startSimulation.at(-1).args[0].simulation_id, 'B')
  } finally { h.close() }
})

test('old read rejection cannot unlock the new view stream or produce warnings', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000); const old = h.requests.getRunStatus[0]
    h.props.simulationId = 'B'; await settle(); assert.equal(h.requests.startSimulation.length, 2)
    h.requests.startSimulation[1].resolve(reply()); await settle(); await h.tick(2000)
    old.reject(new Error('old read')); await settle(); await h.tick(2000)
    assert.equal(h.requests.getRunStatus.length, 2); assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

for (const terminal of ['completed', 'stopped', 'failed']) test(`${terminal} status stops timers and obtains a fresh final action snapshot`, async () => {
  const h = harness(); try {
    await running(h); await h.tick(3000)
    const oldDetail = h.requests.getRunStatusDetail[0]
    await completed(h, terminal)
    assert.equal(h.state.phase.value, 2)
    assert.equal(h.intervals.size, 0)
    assert.equal(statuses(h).at(-1), terminal === 'failed' ? 'error' : 'completed')
    assert.equal(oldDetail.signal?.aborted, true)
    assert.equal(h.requests.getRunStatusDetail.length, 1)
    oldDetail.resolve(detail(action('old-preview'))); await settle()
    assert.equal(h.state.allActions.value.length, 0)
    assert.equal(h.requests.getRunStatusDetail.length, 2)
    h.requests.getRunStatusDetail[1].resolve(detail(action('final'), action('last', 'reddit'))); await settle()
    assert.deepEqual(Array.from(h.state.allActions.value, item => item.id), ['final', 'last'])
    assert.equal(h.state.runStatus.value.runner_status, terminal)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('normal detail merge retains ID deduplication and fallback identity', async () => {
  const h = harness(); try {
    await running(h); const fallback = action('fallback'); delete fallback.id
    await h.tick(3000); h.requests.getRunStatusDetail[0].resolve(detail(action('one'), fallback)); await settle()
    await h.tick(3000); h.requests.getRunStatusDetail[1].resolve(detail(action('one'), fallback, action('two'))); await settle()
    assert.equal(h.state.allActions.value.length, 3)
    assert.equal(h.state.actionIds.value.size, 3)
    assert.ok(h.state.allActions.value[1]._uniqueId.includes('time-fallback'))
  } finally { h.close() }
})

test('unmount during final detail wait does not launch another read', async () => {
  const h = harness(); await running(h); await h.tick(3000)
  await completed(h); h.close()
  h.requests.getRunStatusDetail[0].resolve(detail(action('late'))); await settle()
  assert.equal(h.requests.getRunStatusDetail.length, 1)
  assert.equal(h.state.allActions.value.length, 0)
})

test('final detail failure is best-effort and cannot reverse terminal status', async () => {
  const h = harness(); try {
    await running(h); await completed(h)
    assert.equal(h.requests.getRunStatusDetail.length, 1)
    h.requests.getRunStatusDetail[0].reject(new Error('final detail unavailable')); await settle()
    assert.equal(h.state.phase.value, 2); assert.equal(statuses(h).at(-1), 'completed')
    assert.equal(h.warnings.length, 1); assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('accepted Stop wins over an older status response and prevents duplicate stop posts', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000); const oldStatus = h.requests.getRunStatus[0]
    h.state.handleStopSimulation(); h.state.handleStopSimulation(); await settle()
    assert.equal(h.requests.stopSimulation.length, 1)
    assert.equal(h.requests.stopSimulation[0].args[0].simulation_id, 'A')
    h.requests.stopSimulation[0].resolve(reply('stopped', { twitter_current_round: 4 })); await settle()
    oldStatus.resolve(reply('running', { twitter_current_round: 1 })); await settle()
    assert.equal(h.state.runStatus.value.runner_status, 'stopped')
    assert.equal(h.state.runStatus.value.twitter_current_round, 4)
    assert.equal(h.state.phase.value, 2); assert.equal(h.state.isStopping.value, false)
    assert.equal(statuses(h).filter(value => value === 'completed').length, 1)
    assert.equal(h.requests.getRunStatusDetail.length, 1)
  } finally { h.close() }
})

for (const rejected of [false, true]) test(`current stop ${rejected ? 'rejection' : 'pending response'} permits explicit retry without claiming completion`, async () => {
  const h = harness(); try {
    await running(h); h.state.handleStopSimulation(); await settle()
    if (rejected) h.requests.stopSimulation[0].reject(new Error('stop failed'))
    else h.requests.stopSimulation[0].resolve({ success: false, pending: true, error: 'still draining' })
    await settle()
    assert.equal(h.state.phase.value, 1); assert.equal(h.state.isStopping.value, false)
    assert.equal(statuses(h).at(-1), 'processing'); assert.equal(h.intervals.size, 2)
    h.state.handleStopSimulation(); await settle(); assert.equal(h.requests.stopSimulation.length, 2)
  } finally { h.close() }
})

test('retired stop completion cannot end or unlock a replacement stop operation', async () => {
  const h = harness(); try {
    await running(h); h.state.handleStopSimulation(); await settle(); const old = h.requests.stopSimulation[0]
    h.props.simulationId = 'B'; await settle(); assert.equal(h.requests.startSimulation.length, 2)
    h.requests.startSimulation[1].resolve(reply()); await settle(); h.state.handleStopSimulation(); await settle()
    old.resolve(reply('stopped')); await settle()
    assert.equal(h.state.isStopping.value, true); assert.equal(h.state.phase.value, 1)
    assert.equal(old.signal?.aborted, true)
    h.requests.stopSimulation[1].resolve(reply('stopped')); await settle(); assert.equal(h.state.isStopping.value, false)
  } finally { h.close() }
})

test('terminal status owns completion over a late stop error', async () => {
  const h = harness(); try {
    await running(h); h.state.handleStopSimulation(); await settle(); await completed(h)
    const before = JSON.stringify(h.emitted)
    h.requests.stopSimulation[0].reject(new Error('late stop failure')); await settle()
    assert.equal(JSON.stringify(h.emitted), before)
    assert.equal(h.state.phase.value, 2); assert.equal(h.state.isStopping.value, false)
  } finally { h.close() }
})

for (const rejected of [false, true]) test(`retired report ${rejected ? 'failure' : 'success'} cannot navigate or publish`, async () => {
  const h = harness(); await running(h); await completed(h)
  h.state.handleNextStep(); await settle(); h.close(); const before = JSON.stringify(h.emitted)
  if (rejected) h.requests.generateReport[0].reject(new Error('retired report'))
  else h.requests.generateReport[0].resolve({ success: true, data: { report_id: 'old-report' } })
  await settle()
  assert.equal(h.routes.length, 0); assert.equal(JSON.stringify(h.emitted), before)
  assert.equal(h.requests.generateReport[0].signal?.aborted, true)
})

test('completed view submits one report with original payload and navigates normally', async () => {
  const h = harness(); try {
    await running(h); await completed(h)
    h.state.handleNextStep(); h.state.handleNextStep(); await settle()
    assert.equal(h.requests.generateReport.length, 1)
    const request = h.requests.generateReport[0]
    assert.equal(request.args[0].simulation_id, 'A'); assert.equal(request.args[0].force_regenerate, true)
    assert.equal(request.signal?.aborted, false, 'completed polling must not retire view actions')
    request.resolve({ success: true, data: { report_id: 'current-report' } }); await settle()
    assert.equal(h.routes.length, 1); assert.equal(h.routes[0].name, 'Report')
    assert.equal(h.routes[0].params.reportId, 'current-report')
    h.state.handleNextStep(); await settle(); assert.equal(h.requests.generateReport.length, 1)
  } finally { h.close() }
})

test('report failure releases only the current request for explicit retry', async () => {
  const h = harness(); try {
    await running(h); await completed(h); h.state.handleNextStep(); await settle()
    h.requests.generateReport[0].reject(new Error('current report failure')); await settle()
    assert.equal(h.state.isGeneratingReport.value, false)
    h.state.handleNextStep(); await settle(); assert.equal(h.requests.generateReport.length, 2)
    h.requests.generateReport[1].resolve({ success: false, error: 'reported failure' }); await settle()
    assert.equal(h.state.isGeneratingReport.value, false); assert.equal(h.routes.length, 0)
  } finally { h.close() }
})

test('explicit retry after a lost report response opens the server-owned active job', async () => {
  const h = harness(); try {
    await running(h); await completed(h); h.state.handleNextStep(); await settle()
    h.requests.generateReport[0].reject(new Error('response lost after server admission')); await settle()
    assert.equal(h.state.isGeneratingReport.value, false)
    assert.equal(h.routes.length, 0)
    h.state.handleNextStep(); h.state.handleNextStep(); await settle()
    assert.equal(h.requests.generateReport.length, 2)
    assert.equal(h.requests.generateReport[1].args[0].force_regenerate, true)
    h.requests.generateReport[1].resolve({ success: true, data: {
      simulation_id: 'A', report_id: 'original-active-report', task_id: 'original-task',
      status: 'generating', already_generated: false, already_running: true
    } }); await settle()
    assert.equal(h.routes.length, 1)
    assert.equal(h.routes[0].name, 'Report')
    assert.equal(h.routes[0].params.reportId, 'original-active-report')
    h.state.handleNextStep(); await settle()
    assert.equal(h.requests.generateReport.length, 2)
  } finally { h.close() }
})

test('explicit same-ID restart retires old report and detail ownership', async () => {
  const h = harness(); try {
    await running(h); await completed(h); h.state.handleNextStep(); await settle()
    const oldReport = h.requests.generateReport[0]
    h.state.doStartSimulation(); await settle()
    assert.equal(h.requests.startSimulation.length, 2)
    assert.equal(h.state.isGeneratingReport.value, false)
    oldReport.resolve({ success: true, data: { report_id: 'previous-run' } }); await settle()
    assert.equal(h.routes.length, 0); assert.equal(h.state.phase.value, 0)
    assert.equal(oldReport.signal?.aborted, true)
    if (h.requests.getRunStatusDetail[0]) h.requests.getRunStatusDetail[0].resolve(detail(action('previous-run')))
    await settle(); assert.equal(h.state.allActions.value.length, 0)
  } finally { h.close() }
})

test('failed startup is retryable and never enables report submission', async () => {
  const h = harness(); try {
    await h.mount(); h.requests.startSimulation[0].reject(new Error('cannot start')); await settle()
    assert.equal(h.state.isStarting.value, false); assert.equal(h.state.startError.value, 'cannot start')
    h.state.handleNextStep(); await settle(); assert.equal(h.requests.generateReport.length, 0)
    h.state.doStartSimulation(); await settle(); assert.equal(h.requests.startSimulation.length, 2)
    h.requests.startSimulation[1].resolve(reply()); await settle(); assert.equal(h.state.phase.value, 1)
  } finally { h.close() }
})

test('empty and undefined selections start no request and ignore inactive actions', async () => {
  const h = harness(''); try {
    await h.mount(); h.state.doStartSimulation(); h.state.handleStopSimulation(); h.state.handleNextStep(); await settle()
    assert.ok(Object.values(h.requests).every(values => values.length === 0))
    h.props.simulationId = undefined; await settle(); h.state.handleNextStep(); await settle()
    assert.ok(Object.values(h.requests).every(values => values.length === 0))
    h.props.simulationId = 'B'; await settle(); assert.equal(h.requests.startSimulation.length, 1)
    assert.equal(h.requests.startSimulation[0].args[0].simulation_id, 'B')
  } finally { h.close() }
})

async function apiWith(service) {
  const read = async file => {
    const source = await readFile(new URL(`../src/api/${file}.js`, import.meta.url), 'utf8')
    return source.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ')
  }
  return vm.runInNewContext(await read('simulation') + '\n' + await read('report') + '\n;({startSimulation,stopSimulation,getRunStatus,getRunStatusDetail,generateReport})', { service })
}

test('all Step3 API helpers forward optional signals while keeping old call contracts', async () => {
  const calls = [], service = { post: (...args) => { calls.push(args); return Promise.resolve({}) }, get: (...args) => { calls.push(args); return Promise.resolve({}) } }
  const api = await apiWith(service), controller = new AbortController(), payload = { simulation_id: 'A' }
  for (const name of ['startSimulation', 'stopSimulation', 'generateReport']) {
    await api[name](payload, controller.signal); assert.equal(calls.at(-1)[1], payload); assert.equal(calls.at(-1)[2]?.signal, controller.signal)
    await api[name](payload); assert.equal(calls.at(-1)[2]?.signal, undefined)
  }
  for (const name of ['getRunStatus', 'getRunStatusDetail']) {
    await api[name]('A', controller.signal); assert.equal(calls.at(-1)[1]?.signal, controller.signal)
    await api[name]('A'); assert.equal(calls.at(-1)[1]?.signal, undefined)
  }
})

for (const name of names) test(`real Axios cancels a pending ${name} request`, { timeout: 5000 }, async t => {
  let received, disconnected
  const arrival = new Promise(resolve => { received = resolve }), departure = new Promise(resolve => { disconnected = resolve })
  const server = createServer((request, response) => { response.on('close', disconnected); received(request.url) })
  const controller = new AbortController()
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const api = await apiWith(axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000 }))
  const pending = api[name](name.startsWith('get') ? 'synthetic' : { simulation_id: 'synthetic' }, controller.signal)
  const rejected = assert.rejects(pending, error => axios.isCancel(error))
  assert.ok((await arrival).startsWith('/api/'))
  controller.abort(); await rejected; await departure
})

for (const rejected of [false, true]) test(`old A report ${rejected ? 'error' : 'success'} cannot affect a replacement A report after B`, async () => {
  const h = harness(); try {
    await running(h); await completed(h); h.state.handleNextStep(); await settle()
    const old = h.requests.generateReport[0]
    for (const id of ['B', 'A']) {
      h.props.simulationId = id; await settle()
      assert.equal(h.requests.startSimulation.at(-1).args[0].simulation_id, id)
      h.requests.startSimulation.at(-1).resolve(reply()); await settle()
    }
    await completed(h); h.state.handleNextStep(); await settle()
    assert.equal(h.requests.generateReport.length, 2)
    const before = JSON.stringify(h.emitted)
    if (rejected) old.reject(new Error('old A report'))
    else old.resolve({ success: true, data: { report_id: 'old-A' } })
    await settle()
    assert.equal(h.state.isGeneratingReport.value, true)
    assert.equal(h.routes.length, 0); assert.equal(JSON.stringify(h.emitted), before)
    h.requests.generateReport[1].resolve({ success: true, data: { report_id: 'new-A' } }); await settle()
    assert.equal(h.routes[0].params.reportId, 'new-A')
  } finally { h.close() }
})

for (const rejected of [false, true]) test(`unmounted stop ${rejected ? 'error' : 'success'} cannot alter retired status`, async () => {
  const h = harness(); await running(h); h.state.handleStopSimulation(); await settle(); h.close()
  const before = JSON.stringify(h.emitted)
  if (rejected) h.requests.stopSimulation[0].reject(new Error('retired stop'))
  else h.requests.stopSimulation[0].resolve(reply('stopped'))
  await settle()
  assert.equal(JSON.stringify(h.emitted), before)
  assert.equal(h.state.phase.value, 0)
  assert.equal(h.intervals.size, 0)
  assert.equal(h.requests.getRunStatusDetail.length, 0)
  assert.equal(h.requests.stopSimulation[0].signal?.aborted, true)
})

test('failed terminal view retains its existing report action contract', async () => {
  const h = harness(); try {
    await running(h); await completed(h, 'failed')
    h.state.handleNextStep(); await settle()
    assert.equal(h.requests.generateReport.length, 1)
    h.requests.generateReport[0].resolve({ success: false, error: 'ingestion incomplete' }); await settle()
    assert.equal(h.state.isGeneratingReport.value, false)
    assert.equal(h.state.phase.value, 2); assert.equal(statuses(h).at(-1), 'error')
  } finally { h.close() }
})

test('retired running read results and errors cannot mutate or warn after unmount', async () => {
  const h = harness(); await running(h); await h.tick(2000); await h.tick(3000); h.close()
  const before = JSON.stringify(h.emitted)
  h.requests.getRunStatus[0].resolve(reply('completed'))
  h.requests.getRunStatusDetail[0].reject(new Error('retired detail'))
  await settle()
  assert.equal(JSON.stringify(h.emitted), before)
  assert.equal(h.warnings.length, 0); assert.equal(h.intervals.size, 0)
  assert.equal(h.state.phase.value, 0); assert.equal(h.state.allActions.value.length, 0)
})

test('a completed run ignores a later Stop action', async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000)
    h.requests.getRunStatus[0].resolve(reply('completed')); await settle()
    h.state.handleStopSimulation()
    await settle()
    assert.equal(h.state.phase.value, 2)
    assert.equal(h.requests.stopSimulation.length, 0)
    assert.equal(h.state.isStopping.value, false)
  } finally { h.close() }
})

for (const rejected of [false, true]) test(`accepted stop recovery supersedes earlier failure and refreshes final detail after ${rejected ? 'rejection' : 'old data'}`, async () => {
  const h = harness(); try {
    await running(h); await h.tick(2000)
    h.state.handleStopSimulation(); await settle()
    h.requests.getRunStatus[0].resolve(reply('failed', { error: 'older drain failure' })); await settle()
    assert.equal(statuses(h).at(-1), 'error')
    assert.equal(h.requests.getRunStatusDetail.length, 1)
    const failedDetail = h.requests.getRunStatusDetail[0]
    h.requests.stopSimulation[0].resolve(reply('stopped', { twitter_current_round: 8 })); await settle()
    assert.equal(h.state.runStatus.value.runner_status, 'stopped')
    assert.equal(statuses(h).at(-1), 'completed')
    assert.equal(h.requests.getRunStatusDetail.length, 1)
    if (rejected) failedDetail.reject(new Error('obsolete final detail'))
    else failedDetail.resolve(detail(action('obsolete-failure-snapshot')))
    await settle()
    assert.equal(h.warnings.length, 0)
    assert.equal(h.state.allActions.value.length, 0)
    assert.equal(h.requests.getRunStatusDetail.length, 2)
    h.requests.getRunStatusDetail[1].resolve(detail(action('recovered-final'))); await settle()
    assert.equal(h.state.allActions.value[0].id, 'recovered-final')
    assert.deepEqual(statuses(h), ['processing', 'error', 'completed'])
  } finally { h.close() }
})

test('explicit Stop can retry a failed run without restarting its simulation', async () => {
  const h = harness(); try {
    await running(h); await completed(h, 'failed')
    h.state.handleStopSimulation(); await settle()
    assert.equal(h.requests.stopSimulation.length, 1)
    h.requests.stopSimulation[0].resolve(reply('stopped')); await settle()
    assert.equal(h.requests.startSimulation.length, 1)
    assert.equal(statuses(h).at(-1), 'completed')
    assert.equal(h.state.runStatus.value.runner_status, 'stopped')
  } finally { h.close() }
})

test('failed-run Stop retry still reports its own current transport failure', async () => {
  const h = harness(); try {
    await running(h); await completed(h, 'failed')
    h.state.handleStopSimulation(); await settle()
    assert.equal(h.requests.stopSimulation.length, 1)
    h.requests.stopSimulation[0].reject(new Error('current retry failure')); await settle()
    assert.equal(h.emitted.at(-1)[1], 'log.stopException')
    assert.equal(statuses(h).at(-1), 'error')
    assert.equal(h.state.isStopping.value, false)
  } finally { h.close() }
})
