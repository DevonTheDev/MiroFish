import assert from 'node:assert/strict'
import test from 'node:test'
import { build as buildParent, settle, ok, graphView, graphChild } from './helpers/parent-route-fixture.js'
import { setPendingUpload, clearPendingUpload, getPendingUpload } from '../src/store/pendingUpload.js'

const build = () => buildParent({ graphRoute: true })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const completed = id => ({ project_id: id, status: 'graph_completed', graph_id: 'G' + id })
const building = id => ({ project_id: id, status: 'graph_building', graph_build_task_id: 'task-' + id })
const generated = id => ({ project_id: id, status: 'ontology_generated' })
const state = h => h.state(graphView)
const createButton = h => h.find(node => node.props?.['data-testid'] === 'create-simulation')
const refresh = async h => { h.graph().emit('refresh'); await settle() }
const upload = id => setPendingUpload([new Blob(['synthetic ' + id])], 'synthetic requirement ' + id)
async function loaded(h, id = 'A') {
  pending(h, 'getProject').resolve(ok(completed(id))); await settle()
  pending(h, 'getGraphData').resolve(ok({ nodes: [{ name: id + ' graph' }] })); await settle()
}
async function task(h) {
  pending(h, 'getProject').resolve(ok(building('A'))); await settle()
  return pending(h, 'getTaskStatus')
}

test('actual Process route clears A props before reused MainView can create for B', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    const first = h.child(graphView), oldClick = createButton(h).props.onClick
    await h.navigate('/process/B')
    assert.equal(h.child(graphView), first, 'Vue Router reuses the actual parent')
    assert.equal(h.child(graphChild).props.projectData, null)
    assert.equal(h.child(graphChild).props.graphData, null)
    assert.equal(createButton(h).props.disabled, true)
    oldClick(); createButton(h).props.onClick(); await settle()
    assert.equal(h.calls('createSimulation').length, 0)
    assert.equal(pending(h, 'getProject').args[0], 'B')
    await loaded(h, 'B'); createButton(h).props.onClick(); await settle()
    assert.equal(pending(h, 'createSimulation').args[0].project_id, 'B')
    assert.equal(pending(h, 'createSimulation').args[0].graph_id, 'GB')
  } finally { h.close() }
})

test('A → B → A owns a fresh project observer and ignores the first A success or failure', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); const old = pending(h, 'getProject')
    await h.navigate('/process/B'); const middle = pending(h, 'getProject')
    await h.navigate('/process/A'); const current = pending(h, 'getProject')
    assert.notEqual(current, old)
    assert.equal(old.signal?.aborted, true); assert.equal(middle.signal?.aborted, true)
    old.resolve(ok(generated('A'))); middle.reject(new Error('retired B failure')); await settle()
    assert.equal(h.calls('buildGraph').length, 0)
    assert.equal(state(h).loading, true); assert.equal(state(h).error, '')
    assert.equal(state(h).projectData, null)
    await loaded(h)
    assert.equal(state(h).currentPhase, 2)
    assert.equal(state(h).graphData.nodes[0].name, 'A graph')
  } finally { h.close() }
})

for (const leave of ['navigate', 'unmount']) {
  test(`${leave} retires a delayed project reply before it can start a graph build`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); const old = pending(h, 'getProject')
      if (leave === 'navigate') await h.navigate('/'); else h.close()
      assert.equal(old.signal?.aborted, true)
      const logs = state(h).systemLogs.length
      old.resolve(ok(generated('A'))); await settle()
      assert.equal(h.calls('buildGraph').length, 0)
      assert.equal(state(h).systemLogs.length, logs)
    } finally { h.close() }
  })
}

test('retired ontology cannot replace the route, clear a newer pending upload or start a build', async () => {
  clearPendingUpload(); upload('A')
  const h = build()
  try {
    await h.mount('/process/new'); const old = pending(h, 'generateOntology')
    await h.navigate('/'); upload('B')
    assert.equal(old.signal?.aborted, true)
    old.resolve(ok(generated('A'))); await settle(); await new Promise(setImmediate); await settle()
    assert.equal(h.router.currentRoute.value.path, '/')
    assert.equal(getPendingUpload().simulationRequirement, 'synthetic requirement B')
    assert.equal(h.calls('buildGraph').length, 0)
  } finally { h.close(); clearPendingUpload() }
})

test('new → assigned ID adoption starts exactly one build, then completes through the real child', async () => {
  clearPendingUpload(); upload('A')
  const h = build()
  try {
    await h.mount('/process/new')
    const ontology = pending(h, 'generateOntology')
    assert.equal(ontology.args[0].get('simulation_requirement'), 'synthetic requirement A')
    assert.equal(ontology.args[0].getAll('files').length, 1)
    ontology.resolve(ok(generated('A'))); await settle(); await new Promise(setImmediate); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/A')
    assert.equal(h.calls('generateOntology').length, 1)
    assert.equal(h.calls('getProject').length, 0, 'adoption consumes the generated project without a duplicate initialization read')
    assert.equal(h.calls('buildGraph').length, 1)
    assert.equal(getPendingUpload().isPending, false)
    pending(h, 'buildGraph').resolve(ok({ task_id: 'task-A' })); await settle()
    pending(h, 'getTaskStatus').resolve(ok({ status: 'completed', progress: 100 })); await settle()
    await loaded(h)
    assert.equal(state(h).currentPhase, 2)
    createButton(h).props.onClick(); createButton(h).props.onClick(); await settle()
    assert.equal(h.calls('createSimulation').length, 1)
    assert.equal(pending(h, 'createSimulation').args[0].project_id, 'A')
  } finally { h.close(); clearPendingUpload() }
})

test('successful adoption only consumes the upload that its ontology request captured', async () => {
  clearPendingUpload(); upload('A')
  const h = build()
  try {
    await h.mount('/process/new'); const old = pending(h, 'generateOntology'); upload('B')
    old.resolve(ok(generated('A'))); await settle(); await new Promise(setImmediate); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/A')
    assert.equal(getPendingUpload().simulationRequirement, 'synthetic requirement B')
    assert.equal(h.calls('buildGraph').length, 1)
  } finally { h.close(); clearPendingUpload() }
})

test('route change during assigned-ID navigation does not start the adopted build', async () => {
  clearPendingUpload(); upload('A')
  const h = build()
  let release
  try {
    await h.mount('/process/new')
    h.router.beforeEach(to => to.path === '/process/A' ? new Promise(resolve => { release = resolve }) : undefined)
    pending(h, 'generateOntology').resolve(ok(generated('A'))); await settle()
    assert.ok(release)
    await h.navigate('/process/B'); release(); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/B')
    assert.equal(h.calls('buildGraph').length, 0)
    assert.equal(state(h).projectData, null)
  } finally { release?.(); h.close(); clearPendingUpload() }
})

test('current ontology-generated project starts once and reuses a backend-completed graph', async () => {
  const h = build()
  try {
    await h.mount('/process/A')
    pending(h, 'getProject').resolve(ok(generated('A'))); await settle()
    assert.equal(h.calls('buildGraph').length, 1)
    pending(h, 'buildGraph').resolve(ok({ reused: true, graph_id: 'GA' })); await settle()
    await loaded(h)
    assert.equal(h.calls('getTaskStatus').length, 0)
    assert.equal(state(h).currentPhase, 2); assert.equal(state(h).buildProgress, null)
    assert.equal(createButton(h).props.disabled, false)
  } finally { h.close() }
})

for (const response of [{ task_id: 'task-A', reused: true }, { graph_id: 'GA', reused: true }]) {
  test(`late build reply ${response.task_id ? 'with active task' : 'with completed graph'} cannot continue on route B`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); pending(h, 'getProject').resolve(ok(generated('A'))); await settle()
      const old = pending(h, 'buildGraph'); await h.navigate('/process/B')
      assert.equal(old.signal?.aborted, true)
      old.resolve(ok(response)); await settle()
      assert.equal(h.calls('getProject').length, 2)
      assert.equal(h.calls('getTaskStatus').length, 0); assert.equal(h.calls('getGraphData').length, 0)
      assert.equal(state(h).projectData, null); assert.equal(state(h).loading, true)
    } finally { h.close() }
  })
}

test('task polling is single-flight and claims completion once before the final reads', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); const first = await task(h)
    await h.tick(2000); await h.tick(2000)
    assert.equal(h.calls('getTaskStatus').length, 1, 'pending task observations never overlap')
    first.resolve(ok({ status: 'processing', progress: 10, message: 'running' })); await settle()
    assert.equal(state(h).buildProgress.progress, 10)
    const queuedTick = [...h.intervals.values()][0].callback
    await h.tick(2000)
    assert.equal(h.calls('getTaskStatus').length, 2)
    pending(h, 'getTaskStatus').resolve(ok({ status: 'completed', progress: 100, message: 'ready' })); await settle()
    queuedTick(); await h.tick(2000); await settle()
    assert.equal(h.calls('getTaskStatus').length, 2)
    assert.equal(h.calls('getProject').length, 2, 'only one terminal project read')
    assert.equal(h.intervals.size, 0, 'timer ID zero is retired')
    await loaded(h)
    queuedTick(); await settle()
    assert.equal(h.calls('getGraphData').length, 1)
    assert.equal(state(h).buildProgress.progress, 100)
    assert.equal(state(h).statusText, 'Ready')
  } finally { h.close() }
})

test('failed task is terminal and a current transient observation error can retry', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); (await task(h)).reject(new Error('synthetic transient failure')); await settle()
    await h.tick(2000); assert.equal(h.calls('getTaskStatus').length, 2)
    pending(h, 'getTaskStatus').resolve(ok({ status: 'failed', progress: 12, error: 'synthetic build failure' })); await settle()
    await h.tick(2000)
    assert.equal(state(h).error, 'synthetic build failure')
    assert.equal(h.intervals.size, 0); assert.equal(h.calls('getProject').length, 1)
  } finally { h.close() }
})

for (const stage of ['task', 'final-project', 'reused-project', 'graph']) {
  test(`route change retires the delayed ${stage} continuation`, async () => {
    const h = build()
    try {
      await h.mount('/process/A')
      let old
      if (stage === 'reused-project') {
        pending(h, 'getProject').resolve(ok(generated('A'))); await settle()
        pending(h, 'buildGraph').resolve(ok({ reused: true, graph_id: 'GA' })); await settle()
        old = pending(h, 'getProject')
      } else if (stage === 'graph') {
        pending(h, 'getProject').resolve(ok(completed('A'))); await settle()
        old = pending(h, 'getGraphData')
      } else {
        old = await task(h)
        if (stage === 'final-project') {
          old.resolve(ok({ status: 'completed', progress: 100 })); await settle()
          old = pending(h, 'getProject')
        }
      }
      const graphCalls = h.calls('getGraphData').length, projectCalls = h.calls('getProject').length
      await h.navigate('/process/B'); assert.equal(old.signal?.aborted, true)
      old.resolve(stage === 'task' ? ok({ status: 'completed', progress: 100 }) : stage === 'graph' ? ok({ nodes: [{ name: 'retired' }] }) : ok(completed('A')))
      await settle(); await h.tick(2000)
      assert.equal(h.calls('getProject').length, projectCalls + 1)
      assert.equal(h.calls('getGraphData').length, graphCalls)
      assert.equal(state(h).projectData, null); assert.equal(state(h).graphData, null)
      assert.equal(state(h).graphLoading, false); assert.equal(state(h).error, '')
    } finally { h.close() }
  })
}

for (const reject of [false, true]) {
  test(`superseded ${reject ? 'failed' : 'successful'} graph read cannot replace current graph or finish its loading`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); pending(h, 'getProject').resolve(ok(completed('A'))); await settle()
      const old = pending(h, 'getGraphData'); await refresh(h); const current = pending(h, 'getGraphData')
      assert.notEqual(old, current); assert.equal(old.signal?.aborted, true)
      const logs = state(h).systemLogs.length
      if (reject) old.reject(new Error('retired graph failure')); else old.resolve(ok({ nodes: [{ name: 'retired graph' }] }))
      await settle()
      assert.equal(state(h).graphData, null); assert.equal(state(h).graphLoading, true)
      assert.equal(state(h).systemLogs.length, logs)
      current.resolve(ok({ nodes: [{ name: 'current graph' }] })); await settle()
      assert.equal(state(h).graphData.nodes[0].name, 'current graph'); assert.equal(state(h).graphLoading, false)
      await refresh(h); const latest = pending(h, 'getGraphData')
      await refresh(h); pending(h, 'getGraphData').resolve(ok({ nodes: [{ name: 'latest graph' }] })); await settle()
      latest.resolve(ok({ nodes: [{ name: 'stale graph' }] })); await settle()
      assert.equal(state(h).graphData.nodes[0].name, 'latest graph')
    } finally { h.close() }
  })
}

test('unmount aborts a graph read and late failure has no logging or loading effects', async () => {
  const h = build()
  await h.mount('/process/A'); pending(h, 'getProject').resolve(ok(completed('A'))); await settle()
  const old = pending(h, 'getGraphData'); h.close()
  assert.equal(old.signal?.aborted, true)
  const logs = state(h).systemLogs.length
  old.reject(new Error('late graph error')); await settle()
  assert.equal(state(h).systemLogs.length, logs); assert.equal(state(h).graphLoading, false)
})

for (const api of ['getProject', 'generateOntology', 'buildGraph']) {
  for (const reject of [false, true]) {
    test(`current ${api} ${reject ? 'exception' : 'unsuccessful response'} remains visible`, async () => {
      clearPendingUpload(); if (api === 'generateOntology') upload('A')
      const h = build()
      try {
        await h.mount(api === 'generateOntology' ? '/process/new' : '/process/A')
        if (api === 'buildGraph') { pending(h, 'getProject').resolve(ok(generated('A'))); await settle() }
        const request = pending(h, api)
        if (reject) request.reject(new Error('synthetic failure')); else request.resolve({ success: false, error: 'synthetic failure' })
        await settle()
        assert.equal(state(h).error, 'synthetic failure'); assert.equal(state(h).loading, false)
        assert.equal(state(h).statusText, 'Error')
      } finally { h.close(); clearPendingUpload() }
    })
  }
}

test('new route without upload fails visibly without any API work', async () => {
  clearPendingUpload(); const h = build()
  try {
    await h.mount('/process/new')
    assert.equal(state(h).error, 'No pending files found.')
    assert.equal(h.calls('generateOntology').length, 0); assert.equal(h.calls('buildGraph').length, 0)
  } finally { h.close() }
})

test('control: current completed project creates exactly once through the actual child button', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    createButton(h).props.onClick(); createButton(h).props.onClick(); await settle()
    assert.equal(h.calls('createSimulation').length, 1)
    assert.equal(pending(h, 'createSimulation').args[0].project_id, 'A')
    assert.equal(pending(h, 'createSimulation').args[0].graph_id, 'GA')
    assert.equal(h.intervals.size, 0, 'completed projects do not start dormant graph polling')
  } finally { h.close() }
})

test('a canceled leave recovers the still-selected project with a fresh observer', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    h.router.beforeEach(to => to.path === '/' ? false : undefined)
    await h.navigate('/')
    assert.equal(h.router.currentRoute.value.path, '/process/A')
    assert.equal(h.calls('getProject').length, 2, 'canceled departure starts a fresh current-project observer')
    await loaded(h)
    assert.equal(state(h).statusText, 'Ready'); assert.equal(createButton(h).props.disabled, false)
  } finally { h.close() }
})

test('rapid leave and return to the same route cannot leave the selected project retired', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); const old = pending(h, 'getProject')
    const leave = h.router.push('/'); await Promise.resolve()
    const stay = h.router.push('/process/A')
    await Promise.all([leave, stay]); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/A')
    assert.equal(h.calls('getProject').length, 2)
    assert.equal(old.signal?.aborted, true)
    old.resolve(ok(generated('A'))); await settle()
    assert.equal(h.calls('buildGraph').length, 0)
    await loaded(h)
    assert.equal(state(h).statusText, 'Ready')
  } finally { h.close() }
})

test('an older canceled leave cannot restart observations while a newer leave is pending', async () => {
  const h = build(), releases = new Map()
  try {
    await h.mount('/process/A'); await loaded(h)
    h.router.beforeEach(to => new Promise(resolve => releases.set(to.path, resolve)))
    const first = h.router.push('/'); await settle()
    const second = h.router.push('/runtime'); await settle()
    assert.ok(releases.has('/')); assert.ok(releases.has('/runtime'))
    releases.get('/')(false); await first; await settle()
    assert.equal(h.calls('getProject').length, 1, 'older failure does not revive a newer departure')
    releases.get('/runtime')(false); await second; await settle()
    assert.equal(h.calls('getProject').length, 2)
    await loaded(h); assert.equal(state(h).statusText, 'Ready')
  } finally { for (const release of releases.values()) release(false); h.close() }
})

test('a canceled upload departure stays visible without automatically resubmitting accepted ontology work', async () => {
  clearPendingUpload(); upload('A'); const h = build()
  try {
    await h.mount('/process/new'); const old = pending(h, 'generateOntology')
    h.router.beforeEach(to => to.path === '/' ? false : undefined)
    await h.navigate('/')
    assert.equal(h.router.currentRoute.value.path, '/process/new')
    assert.equal(h.calls('generateOntology').length, 1)
    assert.equal(state(h).statusText, 'Error', 'interrupted upload gives a visible recovery instruction')
    assert.match(state(h).error, /upload.*again/i)
    old.resolve(ok(generated('A'))); await settle()
    assert.equal(h.calls('buildGraph').length, 0)
    assert.equal(getPendingUpload().isPending, true)
  } finally { h.close(); clearPendingUpload() }
})

for (const chained of [false, true]) {
  test(`a ${chained ? 'chained ' : ''}redirected leave back to the selected project recovers readiness`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); await loaded(h)
      h.router.beforeEach(to => {
        if (to.path === '/') return chained ? '/runtime' : '/process/A'
        if (to.path === '/runtime') return '/process/A'
      })
      await h.navigate('/')
      assert.equal(h.router.currentRoute.value.path, '/process/A')
      assert.equal(h.calls('getProject').length, 2)
      await loaded(h)
      assert.equal(state(h).statusText, 'Ready'); assert.equal(createButton(h).props.disabled, false)
    } finally { h.close() }
  })
}

test('a leave that fails with a guard exception recovers the current project', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    h.router.onError(() => {})
    h.router.beforeEach(to => { if (to.path === '/') throw new Error('synthetic navigation failure') })
    await assert.rejects(h.router.push('/'), /synthetic navigation failure/); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/A')
    assert.equal(h.calls('getProject').length, 2)
    await loaded(h)
    assert.equal(state(h).statusText, 'Ready'); assert.equal(createButton(h).props.disabled, false)
  } finally { h.close() }
})

for (const destination of ['/process/A?view=graph', '/process/B', '/runtime']) {
  test(`a competing successful navigation to ${destination} keeps only its selected project`, async () => {
    const h = build()
    let release
    try {
      await h.mount('/process/A'); await loaded(h)
      h.router.beforeEach(to => to.path === '/' ? new Promise(resolve => { release = resolve }) : undefined)
      const oldLeave = h.router.push('/'); await settle(); assert.ok(release)
      await h.navigate(destination)
      assert.equal(h.router.currentRoute.value.fullPath, destination)
      const expected = destination.includes('/process/A') ? ['A', 'A'] : destination === '/process/B' ? ['A', 'B'] : ['A']
      assert.deepEqual(h.calls('getProject').map(call => call.args[0]), expected)
      if (destination.startsWith('/process/')) {
        await loaded(h, expected.at(-1))
        assert.equal(createButton(h).props.disabled, false)
      }
      release(false); await oldLeave; await settle()
      assert.deepEqual(h.calls('getProject').map(call => call.args[0]), expected, 'older settlement cannot recover a retired selection')
      assert.equal(h.router.currentRoute.value.fullPath, destination)
    } finally { release?.(false); h.close() }
  })
}
