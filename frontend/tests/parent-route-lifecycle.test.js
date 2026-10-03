import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'
import axios from 'axios'
import { build, settle, ok, setupView, runView, setupChild, runChild } from './helpers/parent-route-fixture.js'

const path = (running, id = 'A') => `/simulation/${id}${running ? '/start' : ''}`
const view = running => running ? runView : setupView
const child = running => running ? runChild : setupChild
const messages = state => Array.from(state.systemLogs, item => item.msg)
const pending = (h, name, id) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted &&
  (id === undefined || call.args[0] === id || call.args[0]?.simulation_id === id))
const graphTimers = h => [...h.intervals.values()].filter(timer => timer.ms === 30000)
const goBack = h => h.child(runChild).vnode.props.onGoBack()

async function reachGraph(h, running, id = 'A') {
  const env = pending(h, 'getEnvStatus', id)
  if (!running && env) { env.resolve(ok({ env_alive: false })); await settle() }
  // Preparation may first read process status before loading its metadata.
  for (let pass = 0; pass < 3 && !pending(h, 'getGraphData', 'G' + id); pass++) {
    const simulation = pending(h, 'getSimulation', id)
    if (simulation) { simulation.resolve(ok({ status: 'ready', project_id: 'P' + id })); await settle() }
    const config = pending(h, 'getSimulationConfig', id)
    if (config) { config.resolve(ok({ time_config: { minutes_per_round: 15 } })); await settle() }
    const project = pending(h, 'getProject', 'P' + id)
    if (project) { project.resolve(ok({ project_id: 'P' + id, graph_id: 'G' + id })); await settle() }
  }
  const graph = pending(h, 'getGraphData', 'G' + id)
  assert.ok(graph, `current ${id} metadata reaches its graph request`)
  return graph
}

async function prepareAndStart(h, maxRounds) {
  if (maxRounds) {
    h.state(setupChild).useCustomRounds = true
    h.state(setupChild).customMaxRounds = maxRounds
  }
  pending(h, 'prepareSimulation', 'A').resolve(ok({ already_prepared: true })); await settle()
  pending(h, 'getSimulationProfilesRealtime', 'A').resolve(ok({ profiles: [] })); await settle()
  pending(h, 'getSimulationConfigRealtime', 'A').resolve(ok({ status: 'ready', is_generating: false,
    config_generated: true, config: { time_config: { total_simulation_hours: 10, minutes_per_round: 30 } } })); await settle()
  const start = h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary') && node.props.disabled === false)
  assert.ok(start, 'actual Step2 Start button is enabled after preparation')
  const navigated = new Promise(resolve => {
    const remove = h.router.afterEach(to => { if (to.name === 'SimulationRun') { remove(); resolve() } })
  })
  start.props.onClick(); await navigated; await settle()
  assert.equal(h.calls('startSimulation').at(-1).args[0].simulation_id, 'A')
}

for (const running of [false, true]) {
  test(`actual RouterView reuses the ${running ? 'run' : 'setup'} parent and updates its child through A to B to A`, async () => {
    const h = build()
    try {
      await h.mount(path(running))
      const original = h.child(view(running))
      const api = running ? 'startSimulation' : 'prepareSimulation'
      for (const [index, id] of ['A', 'B', 'A'].entries()) {
        if (index > 0) await h.navigate(path(running, id))
        assert.equal(h.router.currentRoute.value.params.simulationId, id)
        assert.equal(original.props.simulationId, id)
        assert.equal(h.instances[view(running)].length, 1, 'actual RouterView reuses its parent')
        assert.equal(h.child(child(running)).props.simulationId, id, 'actual child receives the selected ID')
        assert.equal(h.calls(api).at(-1).args[0].simulation_id, id)
      }
      assert.equal(h.calls(api).length, 3)
      assert.equal(h.calls(api)[0].signal?.aborted, true)
    } finally { h.close() }
  })

  test(`${running ? 'run' : 'setup'} selection resets owned metadata, graph, logs and status`, async () => {
    const h = build()
    try {
      await h.mount(path(running))
      const oldGraph = await reachGraph(h, running)
      oldGraph.resolve(ok({ nodes: [{ name: 'old A' }] })); await settle()
      h.child(child(running)).emit('add-log', 'previous selection only')
      h.child(child(running)).emit('update-status', 'completed'); await settle()
      assert.equal(h.state(view(running)).currentStatus, 'completed')
      await h.navigate(path(running, 'B'))
      const state = h.state(view(running))
      assert.equal(state.projectData, null)
      assert.equal(state.graphData, null)
      assert.equal(state.currentStatus, 'processing')
      assert.ok(!messages(state).includes('previous selection only'))
      assert.equal(h.child(child(running)).props.projectData, null)
      assert.equal(h.graph().props.graphData, null)
      if (running) assert.equal(state.minutesPerRound, 30)
      const currentGraph = await reachGraph(h, running, 'B')
      currentGraph.resolve(ok({ nodes: [{ name: 'current B' }] })); await settle()
      assert.equal(h.graph().props.graphData.nodes[0].name, 'current B')
      assert.equal(h.child(child(running)).props.projectData.project_id, 'PB')
    } finally { h.close() }
  })

  for (const reject of [false, true]) test(`${running ? 'run' : 'setup'} graph ${reject ? 'rejection' : 'response'} and finally cannot replace a newer refresh`, async () => {
    const h = build()
    try {
      await h.mount(path(running))
      h.child(child(running)).emit('update-status', 'completed'); await settle()
      const old = await reachGraph(h, running)
      h.graph().emit('refresh'); await settle()
      const latest = pending(h, 'getGraphData', 'GA')
      assert.notEqual(latest, old)
      const before = messages(h.state(view(running)))
      if (reject) old.reject(new Error('retired graph error'))
      else old.resolve(ok({ nodes: [{ name: 'retired graph' }] }))
      await settle()
      assert.equal(h.graph().props.loading, true, 'older finally does not release newer loading')
      assert.equal(h.graph().props.graphData, null)
      assert.deepEqual(messages(h.state(view(running))), before)
      assert.equal(old.signal?.aborted, true)
      latest.resolve(ok({ nodes: [{ name: 'latest graph' }] })); await settle()
      assert.equal(h.graph().props.loading, false)
      assert.equal(h.graph().props.graphData.nodes[0].name, 'latest graph')
    } finally { h.close() }
  })

  test(`${running ? 'run' : 'setup'} stale A graph cannot mutate the second A selection`, async () => {
    const h = build()
    try {
      await h.mount(path(running)); const old = await reachGraph(h, running)
      await h.navigate(path(running, 'B')); await h.navigate(path(running, 'A'))
      const current = await reachGraph(h, running)
      old.resolve(ok({ nodes: [{ name: 'first A' }] })); await settle()
      assert.equal(h.state(view(running)).graphData, null)
      current.resolve(ok({ nodes: [{ name: 'second A' }] })); await settle()
      assert.equal(h.state(view(running)).graphData.nodes[0].name, 'second A')
      assert.equal(old.signal?.aborted, true)
    } finally { h.close() }
  })

  for (const stage of ['simulation', ...(running ? ['config'] : []), 'project']) {
    test(`${running ? 'run' : 'setup'} ignores retired ${stage} metadata and cannot continue its chain`, async () => {
      const h = build()
      try {
        await h.mount(path(running))
        if (!running) {
          pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
          pending(h, 'getSimulation').resolve(ok({ status: 'ready' })); await settle()
        }
        let old = pending(h, 'getSimulation')
        if (stage !== 'simulation') {
          old.resolve(ok({ project_id: 'PA' })); await settle()
          if (running) {
            old = pending(h, 'getSimulationConfig')
            if (stage === 'project') { old.resolve(ok({})); await settle() }
          }
          if (stage === 'project') old = pending(h, 'getProject')
        }
        assert.ok(old)
        await h.navigate(path(running, 'B')); await h.navigate(path(running, 'A'))
        const before = messages(h.state(view(running)))
        const projectCount = h.calls('getProject').length
        old.resolve(ok(stage === 'config' ? { time_config: { minutes_per_round: 99 } }
          : { project_id: 'PA', graph_id: 'GA' })); await settle()
        assert.equal(h.state(view(running)).projectData, null)
        assert.equal(h.state(view(running)).graphData, null)
        assert.equal(h.calls('getGraphData').length, 0)
        assert.equal(h.calls('getProject').length, projectCount)
        assert.deepEqual(messages(h.state(view(running))), before)
        assert.equal(old.signal?.aborted, true)
        if (running) assert.equal(h.state(runView).minutesPerRound, 30)
      } finally { h.close() }
    })
  }

  test(`${running ? 'run' : 'setup'} unmount aborts reads and ignores late metadata failures`, async () => {
    const h = build()
    await h.mount(path(running))
    const state = h.state(view(running))
    const old = pending(h, running ? 'getSimulation' : 'getEnvStatus')
    h.close(); const before = messages(state)
    old.reject(new Error('late metadata failure')); await settle()
    assert.deepEqual(messages(state), before)
    assert.equal(h.intervals.size, 0)
    assert.equal(old.signal?.aborted, true)
    assert.equal(h.calls('getProject').length, 0)
  })
}

test('retired setup cannot close a new run after the actual Start button navigates', { timeout: 3000 }, async () => {
  const h = build()
  try {
    await h.mount(path(false)); const old = pending(h, 'getEnvStatus')
    await prepareAndStart(h)
    old.resolve(ok({ env_alive: true })); await settle()
    assert.equal(h.router.currentRoute.value.name, 'SimulationRun')
    assert.equal(h.calls('closeSimulationEnv').length, 0)
    assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(old.signal?.aborted, true)
  } finally { h.close() }
})

test('retired setup close rejection cannot force-stop the simulation started by its Start button', { timeout: 3000 }, async () => {
  const h = build()
  try {
    await h.mount(path(false))
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
    const old = pending(h, 'closeSimulationEnv')
    await prepareAndStart(h)
    const before = messages(h.state(runView))
    old.reject(new Error('late close failure')); await settle()
    assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(h.router.currentRoute.value.name, 'SimulationRun')
    assert.deepEqual(messages(h.state(runView)), before)
    assert.equal(old.signal?.aborted, true)
  } finally { h.close() }
})

for (const closeResult of ['success', 'unsuccessful', 'rejection']) test(`setup preserves ordinary cleanup with a ${closeResult} graceful close`, async () => {
  const h = build()
  try {
    await h.mount(path(false))
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
    const close = pending(h, 'closeSimulationEnv')
    assert.equal(close.args[0].simulation_id, 'A'); assert.equal(close.args[0].timeout, 10)
    if (closeResult === 'rejection') close.reject(new Error('close failed'))
    else close.resolve({ success: closeResult === 'success' })
    await settle()
    if (closeResult !== 'success') {
      const stop = pending(h, 'stopSimulation')
      assert.equal(stop.args[0].simulation_id, 'A')
      stop.resolve(ok({})); await settle()
    } else assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(pending(h, 'getSimulation').args[0], 'A', 'metadata loads after cleanup')
    assert.equal(h.router.currentRoute.value.name, 'Simulation')
  } finally { h.close() }
})

test('setup still stops an orphaned running process when its environment is absent', async () => {
  const h = build()
  try {
    await h.mount(path(false))
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
    pending(h, 'getSimulation').resolve(ok({ status: 'running' })); await settle()
    assert.equal(pending(h, 'stopSimulation').args[0].simulation_id, 'A')
    pending(h, 'stopSimulation').resolve(ok({})); await settle()
    assert.equal(pending(h, 'getSimulation').args[0], 'A')
    assert.equal(h.calls('closeSimulationEnv').length, 0)
  } finally { h.close() }
})

for (const stage of ['environment', 'close', 'stop']) for (const reject of [false, true]) {
  test(`run Back ${stage} ${reject ? 'failure' : 'success'} cannot affect a replacement route`, async () => {
    const h = build()
    try {
      await h.mount(path(true))
      const back = goBack(h)
      let old = pending(h, 'getEnvStatus')
      if (stage !== 'environment') {
        old.resolve(ok({ env_alive: true })); await settle()
        old = pending(h, 'closeSimulationEnv')
        if (stage === 'stop') {
          old.reject(new Error('graceful close failed')); await settle()
          old = pending(h, 'stopSimulation')
        }
      }
      assert.equal(old.args[0].simulation_id, 'A')
      await h.navigate(path(true, 'B'))
      const before = messages(h.state(runView))
      const closeCount = h.calls('closeSimulationEnv').length, stopCount = h.calls('stopSimulation').length
      if (reject) old.reject(new Error('retired Back failure'))
      else old.resolve(ok({ env_alive: true }))
      await settle()
      assert.equal(h.calls('closeSimulationEnv').length, closeCount, 'old Back cannot continue closing')
      assert.equal(h.calls('stopSimulation').length, stopCount, 'old Back cannot continue stopping')
      await back; await settle()
      assert.equal(h.router.currentRoute.value.fullPath, path(true, 'B'))
      assert.deepEqual(messages(h.state(runView)), before)
      assert.equal(old.signal?.aborted, true)
      assert.equal(h.child(runChild).props.simulationId, 'B')
    } finally { h.close() }
  })
}

for (const closeResult of ['success', 'unsuccessful', 'rejection']) test(`run Back is single-flight and preserves ${closeResult} graceful-close behavior`, async () => {
  const h = build()
  try {
    await h.mount(path(true))
    const first = goBack(h), duplicate = goBack(h)
    assert.equal(h.calls('getEnvStatus').length, 1)
    assert.equal(graphTimers(h).length, 0)
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
    assert.equal(h.calls('closeSimulationEnv').length, 1)
    const close = pending(h, 'closeSimulationEnv')
    assert.equal(close.args[0].simulation_id, 'A'); assert.equal(close.args[0].timeout, 10)
    if (closeResult === 'rejection') close.reject(new Error('close failed'))
    else close.resolve({ success: closeResult === 'success' })
    await settle()
    if (closeResult === 'rejection') {
      const stop = pending(h, 'stopSimulation')
      assert.equal(stop.args[0].simulation_id, 'A')
      stop.resolve(ok({})); await settle()
    } else assert.equal(h.calls('stopSimulation').length, 0)
    await Promise.all([first, duplicate]); await settle()
    assert.equal(h.router.currentRoute.value.fullPath, path(false))
    assert.equal(h.calls('prepareSimulation').length, 1)
  } finally { h.close() }
})

test('run Back stops graph polling before awaiting and queued status cannot restart it', async () => {
  const h = build()
  try {
    await h.mount(path(true))
    assert.equal(graphTimers(h).length, 1)
    const queuedTimer = graphTimers(h)[0].callback
    const oldGraph = await reachGraph(h, true)
    const currentChild = h.child(runChild)
    currentChild.emit('update-status', 'completed'); await settle()
    currentChild.emit('update-status', 'processing') // Queue the actual watcher before Back.
    const back = goBack(h)
    await settle()
    assert.equal(graphTimers(h).length, 0)
    const count = h.calls('getGraphData').length
    queuedTimer(); currentChild.emit('update-status', 'processing'); await settle()
    assert.equal(graphTimers(h).length, 0)
    assert.equal(h.calls('getGraphData').length, count)
    const before = messages(h.state(runView))
    oldGraph.resolve(ok({ nodes: [{ name: 'late after Back' }] })); await settle()
    assert.equal(h.state(runView).graphData, null)
    assert.deepEqual(messages(h.state(runView)), before)
    assert.equal(oldGraph.signal?.aborted, true)
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
    pending(h, 'closeSimulationEnv').resolve(ok({})); await back; await settle()
  } finally { h.close() }
})

test('run graph timer and queued callback stop on unmount', async () => {
  const h = build()
  await h.mount(path(true))
  await reachGraph(h, true)
  const timer = graphTimers(h)[0].callback
  h.close(); const count = h.calls('getGraphData').length
  timer(); await settle()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.calls('getGraphData').length, count)
})

test('new run selections capture maxRounds once while query-only navigation keeps the active child', async () => {
  const h = build()
  try {
    await h.mount(path(true) + '?maxRounds=12')
    const original = h.child(runChild)
    assert.equal(original.props.maxRounds, 12)
    assert.equal(h.calls('startSimulation')[0].args[0].max_rounds, 12)
    await h.navigate(path(true) + '?maxRounds=99')
    assert.equal(h.child(runChild).uid, original.uid)
    assert.equal(h.calls('startSimulation').length, 1)
    assert.equal(h.calls('getSimulation').length, 1)
    assert.equal(h.child(runChild).props.maxRounds, 12)
    await h.navigate(path(true, 'B') + '?maxRounds=7')
    assert.equal(h.calls('startSimulation').at(-1).args[0].max_rounds, 7)
    assert.equal(h.child(runChild).props.maxRounds, 7)
    await h.navigate(path(true))
    assert.equal(Object.hasOwn(h.calls('startSimulation').at(-1).args[0], 'max_rounds'), false)
    assert.equal(h.child(runChild).props.maxRounds, null)
    assert.equal(h.calls('startSimulation').length, 3)
  } finally { h.close() }
})

async function simulationApi(service) {
  const source = await readFile(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ')
    + '\n;({getSimulationConfig,getEnvStatus,closeSimulationEnv})', { service })
}

test('parent lifecycle APIs preserve routes, payloads and no-signal callers while accepting cancellation', async () => {
  const calls = []
  const service = {
    get: (url, options = {}) => { calls.push({ url, method: 'GET', ...options }); return Promise.resolve({}) },
    post: (url, data, options = {}) => { calls.push({ url, method: 'POST', data, ...options }); return Promise.resolve({}) },
  }
  const api = await simulationApi(service), signal = new AbortController().signal
  const status = { simulation_id: 'synthetic' }, close = { simulation_id: 'synthetic', timeout: 10 }
  await api.getSimulationConfig('synthetic', signal)
  await api.getEnvStatus(status, signal); await api.closeSimulationEnv(close, signal)
  assert.ok(calls.every(call => call.signal === signal))
  assert.deepEqual(calls.map(call => [call.method, call.url]), [['GET', '/api/simulation/synthetic/config'],
    ['POST', '/api/simulation/env-status'], ['POST', '/api/simulation/close-env']])
  assert.equal(calls[1].data, status); assert.equal(calls[2].data, close)
  await api.getSimulationConfig('synthetic'); await api.getEnvStatus(status); await api.closeSimulationEnv(close)
  assert.ok(calls.slice(3).every(call => call.signal === undefined))
  assert.equal(calls[4].data, status); assert.equal(calls[5].data, close)
})

for (const endpoint of ['getSimulationConfig', 'getEnvStatus', 'closeSimulationEnv']) {
  test(`real Axios cancels a pending ${endpoint} observation`, { timeout: 5000 }, async t => {
    let arrived, disconnected
    const arrival = new Promise(resolve => { arrived = resolve })
    const departure = new Promise(resolve => { disconnected = resolve })
    const server = createServer((request, response) => { response.on('close', disconnected); arrived(request.url) })
    const controller = new AbortController()
    t.after(async () => {
      controller.abort(); server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const service = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000 })
    const api = await simulationApi(service)
    const argument = endpoint === 'getSimulationConfig' ? 'synthetic' : { simulation_id: 'synthetic', timeout: 10 }
    const pendingRequest = api[endpoint](argument, controller.signal)
    const rejected = assert.rejects(pendingRequest, error => axios.isCancel(error))
    assert.equal(await arrival, endpoint === 'getSimulationConfig' ? '/api/simulation/synthetic/config'
      : endpoint === 'getEnvStatus' ? '/api/simulation/env-status' : '/api/simulation/close-env')
    controller.abort(); await rejected; await departure
  })
}


test('run Back clears loading immediately when it retires a pending manual graph read', async () => {
  const h = build()
  try {
    await h.mount(path(true))
    h.child(runChild).emit('update-status', 'completed'); await settle()
    const oldGraph = await reachGraph(h, true)
    assert.equal(h.graph().props.loading, true)
    const back = goBack(h); await settle()
    assert.equal(h.graph().props.loading, false, 'retired graph observation no longer owns a loading indicator')
    oldGraph.resolve(ok({ nodes: [{ name: 'retired graph' }] })); await settle()
    assert.equal(h.graph().props.graphData, null)
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await back; await settle()
  } finally { h.close() }
})


for (const loaded of [false, true]) test(`actual setup Back button returns to ${loaded ? 'the loaded project' : 'Home without metadata'}`, async () => {
  const h = build()
  try {
    await h.mount(path(false))
    const oldEnvironment = pending(h, 'getEnvStatus')
    if (loaded) {
      const graph = await reachGraph(h, false)
      graph.resolve(ok({ nodes: [] })); await settle()
    }
    const back = h.find(node => node.type === 'button' && String(node.props.class).includes('action-btn secondary'))
    assert.ok(back, 'actual setup Back button is present')
    const navigated = new Promise(resolve => {
      const remove = h.router.afterEach(to => {
        if (to.name === (loaded ? 'Process' : 'Home')) { remove(); resolve() }
      })
    })
    back.props.onClick(); await navigated; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, loaded ? '/process/PA' : '/')
    if (!loaded) {
      oldEnvironment.resolve(ok({ env_alive: true })); await settle()
      assert.equal(h.calls('closeSimulationEnv').length, 0)
      assert.equal(oldEnvironment.signal?.aborted, true)
    }
  } finally { h.close() }
})

test('actual setup Start carries custom maxRounds into the run child and startup payload', { timeout: 3000 }, async () => {
  const h = build()
  try {
    await h.mount(path(false)); await prepareAndStart(h, 17)
    assert.equal(h.router.currentRoute.value.query.maxRounds, '17')
    assert.equal(h.child(runChild).props.maxRounds, 17)
    assert.equal(h.calls('startSimulation')[0].args[0].max_rounds, 17)
  } finally { h.close() }
})

for (const status of ['processing', 'completed']) test(`run Back uses current child ${status} status when the environment is absent`, async () => {
  const h = build()
  try {
    await h.mount(path(true))
    const back = goBack(h)
    h.child(runChild).emit('update-status', status); await settle()
    assert.equal(h.state(runView).currentStatus, status)
    assert.equal(graphTimers(h).length, 0)
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
    if (status === 'processing') {
      assert.equal(h.calls('stopSimulation').length, 1)
      assert.equal(pending(h, 'stopSimulation').args[0].simulation_id, 'A')
      pending(h, 'stopSimulation').resolve(ok({})); await settle()
    } else assert.equal(h.calls('stopSimulation').length, 0)
    await back; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, path(false))
    assert.equal(h.calls('closeSimulationEnv').length, 0)
  } finally { h.close() }
})

test('an old A Back close rejection cannot release or act on the second A Back request', { timeout: 3000 }, async () => {
  const h = build()
  try {
    await h.mount(path(true))
    const oldBack = goBack(h)
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: true })); await settle()
    const oldClose = pending(h, 'closeSimulationEnv')
    await h.navigate(path(true, 'B')); await h.navigate(path(true, 'A'))
    const currentBack = goBack(h), currentEnvironment = pending(h, 'getEnvStatus')
    assert.notEqual(currentEnvironment, h.calls('getEnvStatus')[0])
    const before = messages(h.state(runView))
    oldClose.reject(new Error('first A close failure')); await settle()
    assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(h.router.currentRoute.value.fullPath, path(true))
    assert.deepEqual(messages(h.state(runView)), before)
    assert.equal(oldClose.signal?.aborted, true)
    assert.equal(currentEnvironment.signal?.aborted, false)
    await oldBack
    const duplicate = goBack(h)
    assert.equal(h.calls('getEnvStatus').length, 2, 'retired finally cannot unlock the new Back action')
    currentEnvironment.resolve(ok({ env_alive: true })); await settle()
    const currentClose = pending(h, 'closeSimulationEnv')
    assert.notEqual(currentClose, oldClose)
    assert.equal(currentClose.args[0].simulation_id, 'A')
    const navigated = new Promise(resolve => {
      const remove = h.router.afterEach(to => { if (to.name === 'Simulation') { remove(); resolve() } })
    })
    currentClose.resolve(ok({})); await Promise.all([currentBack, duplicate, navigated]); await settle()
    assert.equal(h.router.currentRoute.value.fullPath, path(false))
    assert.equal(h.calls('startSimulation').length, 3)
  } finally { h.close() }
})
