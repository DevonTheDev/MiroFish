import assert from 'node:assert/strict'
import test from 'node:test'
import { build as buildParent, settle, ok, graphView } from './helpers/parent-route-fixture.js'

// These witnesses compile the actual MainView + Step1 scripts/templates and
// invoke rendered handlers through Vue Router. No helper-only surrogate owns
// Stop. HTTP and timer settlement are controlled by the existing route harness.
const build = (options = {}) => buildParent({ graphRoute: true, ...options })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const state = h => h.state(graphView)
const button = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const stopButton = h => button(h, 'stop-graph-build')
const setupButton = h => button(h, 'create-simulation')
const text = node => [node?.text ?? '', ...(node?.children ?? []).map(text)].join(' ')
const control = (taskId, changes = {}) => ({ task_id: taskId, can_stop: true, state: null, persisted: false, ...changes })
const building = (id = 'A', changes = {}) => ({ project_id: id, graph_id: 'G' + id,
  graph_build_task_id: 'task-' + id, status: 'graph_building', files: [{ name: 'source.txt' }],
  ontology: { entity_types: [{ name: 'Person' }] }, graph_build_control: control('task-' + id), ...changes })
const marker = (state = 'requested', changes = {}) => ({ version: 1, backend: 'local',
  task_id: 'task-A', graph_id: 'GA', state, requested_at: '2026-10-17T00:00:00Z',
  expected_chunks: 5, succeeded_chunks: 1, unstarted_chunks: 2, ...changes })
const marked = (state = 'requested', changes = {}) => building('A', {
  status: state === 'stopped' ? 'graph_stopped' : 'graph_building', graph_build_stop: marker(state),
  graph_build_control: control('task-A', { can_stop: false, state, persisted: true }), ...changes })
const reply = (state = 'requested', changes = {}) => ok({ project_id: 'A', task_id: 'task-A', state,
  accepted: true, persisted: true, graph_build_stop: marker(state), ...changes })
async function load(h, project = building()) {
  await h.mount('/process/' + project.project_id)
  pending(h, 'getProject').resolve(ok(project)); await settle()
}
async function reconcile(h, project) {
  const request = pending(h, 'getProject')
  assert.ok(request, 'current project reconciliation exists')
  request.resolve(ok(project)); await settle()
}

test('only an exact live local capability exposes the compiled Stop handler', async () => {
  for (const project of [building('A', { graph_build_control: undefined }),
    building('A', { graph_build_control: control('foreign-task') }),
    building('A', { graph_build_control: control('task-A', { project_id: 'other-project' }) }),
    building('A', { graph_build_control: control('task-A', { can_stop: false }) }),
    { project_id: 'A', status: 'created', graph_build_control: control('task-A') }]) {
    const h = build()
    try { await load(h, project); assert.equal(stopButton(h), undefined); assert.equal(h.calls('stopGraphBuild').length, 0) }
    finally { h.close() }
  }
  const h = build()
  try {
    await load(h)
    const click = stopButton(h).props.onClick
    assert.equal(stopButton(h).props.disabled, false)
    click(); click(); await settle()
    assert.equal(h.calls('stopGraphBuild').length, 1)
    assert.equal(pending(h, 'stopGraphBuild').args[0], 'A')
    assert.equal(pending(h, 'stopGraphBuild').args[1], 'task-A')
    assert.equal(stopButton(h).props.disabled, true)
    assert.equal(setupButton(h).props.disabled, true)
  } finally { h.close() }
})

test('newly started local build uses its returned exact capability only after ontology', async () => {
  const h = build()
  try {
    await load(h, { project_id: 'A', status: 'ontology_generated' })
    assert.equal(stopButton(h), undefined)
    pending(h, 'buildGraph').resolve(ok({ task_id: 'task-A', graph_build_control: control('task-A') })); await settle()
    assert.equal(stopButton(h).props.disabled, false)
    stopButton(h).props.onClick(); await settle()
    assert.equal(pending(h, 'stopGraphBuild').args[1], 'task-A')
  } finally { h.close() }
})

test('reload keeps exact live Stop available while processing retains a prior safe error', async () => {
  const h = build({ locale: 'en' })
  try {
    await load(h, building('A', { graph_build_control: control('task-A', {
      state: 'running', error: 'Synthetic bridge timeout; owned loop receipt still pending' }) }))
    assert.equal(stopButton(h).props.disabled, false)
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic bridge timeout/)
    pending(h, 'getTaskStatus').resolve(ok({ status: 'processing', progress: 20,
      error: 'Synthetic provider timeout; detached batch receipt still pending' })); await settle()
    await reconcile(h, building('A', { graph_build_control: control('task-A', { state: 'running' }) }))
    assert.equal(state(h).projectData.status, 'graph_building')
    assert.equal(state(h).currentPhase, 1)
    assert.equal(state(h).graphStop.state, null)
    assert.equal(stopButton(h).props.disabled, false)
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic provider timeout/)
    assert.equal(setupButton(h).props.disabled, true)
    assert.equal(h.calls('buildGraph').length, 0)
    stopButton(h).props.onClick(); await settle()
    assert.equal(pending(h, 'stopGraphBuild').args[0], 'A')
    assert.equal(pending(h, 'stopGraphBuild').args[1], 'task-A')
  } finally { h.close() }
})

test('accepted Stop retains sources and partial data and waits for a durable stopped receipt', async () => {
  const h = build()
  try {
    await load(h)
    h.graph().emit('refresh'); await settle()
    pending(h, 'getGraphData').resolve(ok({ graph_id: 'GA', nodes: [{ name: 'Partial person' }], edges: [] })); await settle()
    stopButton(h).props.onClick(); await settle()
    pending(h, 'stopGraphBuild').resolve(reply()); await settle()
    assert.equal(state(h).graphStop.state, 'requested')
    assert.equal(state(h).currentPhase, 1)
    assert.equal(setupButton(h).props.disabled, true)
    assert.equal(state(h).graphData.nodes[0].name, 'Partial person')
    assert.equal(state(h).projectData.files[0].name, 'source.txt')
    await reconcile(h, marked())
    pending(h, 'getTaskStatus').resolve(ok({ status: 'cancelled', progress: 20 })); await settle()
    await reconcile(h, marked('stopped'))
    assert.equal(state(h).graphStop.state, 'stopped')
    assert.equal(state(h).currentPhase, 1)
    assert.equal(h.intervals.size, 0)
    assert.equal(setupButton(h).props.disabled, true)
    assert.equal(h.calls('buildGraph').length, 0)
  } finally { h.close() }
})

for (const stage of ['requested', 'unresolved', 'stopped']) {
  test(`reopen ${stage} keeps a durable receipt visible without an automatic build`, async () => {
    const h = build()
    try {
      await load(h, marked(stage))
      assert.equal(state(h).graphStop.state, stage)
      assert.equal(state(h).currentPhase, 1)
      assert.equal(setupButton(h).props.disabled, true)
      assert.equal(h.calls('buildGraph').length, 0)
      if (stage !== 'stopped') {
        pending(h, 'getTaskStatus').reject(Object.assign(new Error('task missing after restart'), { response: { status: 404 } })); await settle()
        await reconcile(h, marked('unresolved', { graph_build_control: control('task-A', { can_stop: false, state: 'unresolved', persisted: true }) }))
        assert.equal(state(h).graphStop.state, 'unresolved')
      } else assert.equal(h.calls('getTaskStatus').length, 0)
    } finally { h.close() }
  })
}

for (const project of [marked('stopped', { status: 'ontology_generated', graph_id: null }),
  marked('stopped', { graph_build_stop: { ...marker('stopped'), version: 99 } }),
  marked('stopped', { graph_build_stop: { ...marker('stopped'), task_id: 'old-task' } }),
  marked('stopped', { graph_build_stop: { ...marker('stopped'), requested_at: '' } }),
  marked('stopped', { graph_build_stop: { ...marker('stopped'), unstarted_chunks: -1 } }),
  marked('stopped', { graph_build_stop: 'invalid marker' }),
  marked('stopped', { graph_build_stop: null }),
  marked('stopped', { status: 'graph_completed' })]) {
  test(`malformed/inconsistent marker is unresolved and never auto-builds: ${JSON.stringify(project.graph_build_stop)} / ${project.status}`, async () => {
    const h = build()
    try {
      await load(h, project)
      assert.equal(state(h).graphStop.state, 'unresolved')
      assert.equal(setupButton(h).props.disabled, true)
      assert.notEqual(state(h).statusText, 'Ready')
      assert.equal(h.calls('buildGraph').length, 0)
      assert.equal(h.calls('createSimulation').length, 0)
    } finally { h.close() }
  })
}

test('a stale completed task cannot enable setup over a saved Stop marker', async () => {
  const h = build()
  try {
    await load(h)
    pending(h, 'getTaskStatus').resolve(ok({ status: 'completed', progress: 100 })); await settle()
    await reconcile(h, marked())
    assert.equal(state(h).graphStop.state, 'requested')
    assert.equal(state(h).graphResult, null)
    assert.equal(setupButton(h).props.disabled, true)
    assert.notEqual(state(h).statusText, 'Ready')
  } finally { h.close() }
})

test('live unresolved ownership outranks an older persisted requested marker', async () => {
  const h = build({ locale: 'en' })
  try {
    await load(h, marked('requested', { graph_build_control: control('task-A', {
      can_stop: false, state: 'unresolved', persisted: true, error: 'Synthetic loop receipt still pending' }) }))
    assert.equal(state(h).graphStop.state, 'unresolved')
    assert.match(text(button(h, 'graph-stop-status')), /completion could not be confirmed/)
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic loop receipt still pending/)
    assert.equal(setupButton(h).props.disabled, true)
  } finally { h.close() }
})

test('contradictory live unresolved ownership cannot be presented as stopped', async () => {
  const h = build()
  try {
    await load(h, marked('stopped', { graph_build_control: control('task-A', {
      can_stop: false, state: 'unresolved', persisted: true, error: 'Synthetic terminal settlement conflict' }) }))
    assert.equal(state(h).graphStop.state, 'unresolved')
    assert.equal(setupButton(h).props.disabled, true)
    assert.notEqual(state(h).statusText, 'step1.graphStoppedTitle')
  } finally { h.close() }
})

test('completed-first Stop response reconciles the exact completed project', async () => {
  const h = build()
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    pending(h, 'stopGraphBuild').resolve(reply('completed', { accepted: false, graph_build_stop: null })); await settle()
    await reconcile(h, building('A', { status: 'graph_completed', graph_build_control: null }))
    assert.equal(state(h).currentPhase, 2)
    assert.equal(state(h).graphStop.state, null)
    assert.equal(setupButton(h).props.disabled, false)
    assert.equal(h.calls('stopGraphBuild').length, 1)
  } finally { h.close() }
})

test('first marker save failure is visibly unconfirmed and never claims a saved Stop', async () => {
  const h = build({ locale: 'en' })
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    pending(h, 'stopGraphBuild').resolve(reply('unresolved', { accepted: false, persisted: false,
      graph_build_stop: null, error: 'Synthetic marker write failed' })); await settle()
    assert.equal(state(h).graphStop.persisted, false)
    assert.match(text(button(h, 'graph-stop-status')), /could not be saved/i)
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic marker write failed/)
    await reconcile(h, building('A', { graph_build_control: control('task-A', {
      can_stop: false, state: 'unresolved', persisted: false, error: 'Synthetic marker write failed' }) }))
    assert.equal(state(h).graphStop.state, 'unresolved')
    assert.equal(setupButton(h).props.disabled, true)
  } finally { h.close() }
})

test('a structured HTTP 503 exposes the live-only fence and original save error', async () => {
  const h = build({ locale: 'en' })
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    const envelope = { ...reply('unresolved', { accepted: false, persisted: false, graph_build_stop: null }),
      success: false, error: 'Synthetic disk replacement failed' }
    pending(h, 'stopGraphBuild').reject(Object.assign(new Error('HTTP 503'), { response: { status: 503, data: envelope } })); await settle()
    assert.equal(state(h).graphStop.state, 'unresolved')
    assert.match(text(button(h, 'graph-stop-status')), /could not be saved/i)
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic disk replacement failed/)
    assert.equal(h.calls('stopGraphBuild').length, 1)
  } finally { h.close() }
})

test('a later-save 503 is immediately unresolved while its saved requested marker is reconciled', async () => {
  const h = build({ locale: 'en' })
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    const envelope = { ...reply('unresolved', { accepted: false, persisted: true,
      graph_build_stop: marker('requested'), error: 'Synthetic terminal save failed' }), success: false }
    pending(h, 'stopGraphBuild').reject(Object.assign(new Error('HTTP 503'), { response: { status: 503, data: envelope } })); await settle()
    assert.equal(state(h).graphStop.state, 'unresolved')
    assert.match(text(button(h, 'graph-stop-status')), /completion could not be confirmed/)
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic terminal save failed/)
    assert.equal(state(h).projectData.graph_build_stop.state, 'requested')
    assert.equal(pending(h, 'getProject').settled, false)
  } finally { h.close() }
})

test('known episode errors and unknown counts survive a stopped receipt honestly', async () => {
  const h = build({ locale: 'en' })
  try {
    await load(h, marked('stopped', { graph_build_stop: marker('stopped', {
      error: 'Synthetic admitted episode failed', expected_chunks: 5, succeeded_chunks: 1, unstarted_chunks: null }) }))
    assert.match(text(button(h, 'graph-stop-error')), /Synthetic admitted episode failed/)
    assert.match(text(button(h, 'graph-stop-counts')), /unknown never started/)
    assert.doesNotMatch(text(button(h, 'graph-stop-counts')), /4 never started/)
  } finally { h.close() }
})

test('a stale identity conflict reconciles current ownership without retargeting Stop', async () => {
  const h = build()
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    pending(h, 'stopGraphBuild').reject(Object.assign(new Error('Task changed'), { response: { status: 409 } })); await settle()
    await reconcile(h, building('A', { graph_build_task_id: 'new-task', graph_build_control: control('new-task') }))
    assert.equal(state(h).projectData.graph_build_task_id, 'new-task')
    assert.equal(state(h).graphStop.state, null)
    assert.equal(h.calls('stopGraphBuild').length, 1)
    assert.equal(pending(h, 'getTaskStatus').args[0], 'new-task')
  } finally { h.close() }
})

test('an unmounted Stop response cannot change a retired view or request more reads', async () => {
  const h = build()
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    const request = pending(h, 'stopGraphBuild'), reads = h.calls('getProject').length
    h.close(); request.resolve(reply('stopped')); await settle()
    assert.equal(request.signal.aborted, true)
    assert.equal(h.calls('getProject').length, reads)
    assert.equal(h.calls('stopGraphBuild').length, 1)
    assert.equal(state(h).projectData, null)
  } finally { h.close() }
})

test('a lost Stop response reads durable state once and does not repeat the mutation', async () => {
  const h = build()
  try {
    await load(h); stopButton(h).props.onClick(); await settle()
    pending(h, 'stopGraphBuild').reject(new Error('response lost')); await settle()
    assert.equal(state(h).graphStop.state, 'unknown')
    await reconcile(h, marked('stopped'))
    assert.equal(state(h).graphStop.state, 'stopped')
    assert.equal(h.calls('stopGraphBuild').length, 1)
  } finally { h.close() }
})

test('project reads begun before Stop cannot erase its accepted receipt', async () => {
  const h = build()
  try {
    await load(h)
    pending(h, 'getTaskStatus').resolve(ok({ status: 'processing', progress: 20 })); await settle()
    const old = pending(h, 'getProject')
    stopButton(h).props.onClick(); await settle()
    pending(h, 'stopGraphBuild').resolve(reply()); await settle()
    const current = pending(h, 'getProject'); assert.notEqual(current, old)
    old.resolve(ok(building())); await settle()
    assert.equal(state(h).graphStop.state, 'requested')
    current.resolve(ok(marked())); await settle()
    assert.equal(state(h).graphStop.state, 'requested')
  } finally { h.close() }
})

test('stale Stop click and response cannot retarget A → B → A or a newer task', async () => {
  const h = build()
  try {
    await load(h); const oldClick = stopButton(h).props.onClick
    oldClick(); await settle(); const old = pending(h, 'stopGraphBuild')
    await h.navigate('/process/B'); await reconcile(h, building('B'))
    await h.navigate('/process/A'); await reconcile(h, building('A', { graph_build_task_id: 'task-A2', graph_build_control: control('task-A2') }))
    oldClick(); old.resolve(reply('stopped')); await settle()
    assert.equal(h.calls('stopGraphBuild').length, 1)
    assert.equal(state(h).projectData.graph_build_task_id, 'task-A2')
    assert.equal(state(h).graphStop.state, null)
    stopButton(h).props.onClick(); await settle()
    assert.equal(pending(h, 'stopGraphBuild').args[1], 'task-A2')
  } finally { h.close() }
})

for (const destination of ['/process/B', '/', '/process/A?view=graph', 'unmount']) {
  test(`passive ${destination} retires Stop handlers without issuing cancellation`, async () => {
    const h = build()
    try {
      await load(h); const click = stopButton(h).props.onClick
      if (destination === 'unmount') h.close(); else await h.navigate(destination)
      click(); await settle()
      assert.equal(h.calls('stopGraphBuild').length, 0)
    } finally { h.close() }
  })
}

test('cancelled navigation renews a Stop handler while its old callback stays inert', async () => {
  const h = build()
  try {
    await load(h); const oldClick = stopButton(h).props.onClick
    h.router.beforeEach(to => to.path === '/' ? false : undefined)
    await h.navigate('/'); await reconcile(h, building())
    oldClick(); await settle(); assert.equal(h.calls('stopGraphBuild').length, 0)
    stopButton(h).props.onClick(); await settle(); assert.equal(h.calls('stopGraphBuild').length, 1)
  } finally { h.close() }
})

test('Back and Forward reopen the saved Stop outcome without another build or Stop', async () => {
  const h = build()
  const historyNavigation = async (action, destination) => {
    let removeAfter = () => {}, removeError = () => {}, timer
    const cleanup = () => { removeAfter(); removeError(); clearTimeout(timer) }
    try {
      await new Promise((resolve, reject) => {
        const finish = error => { cleanup(); error ? reject(error) : resolve() }
        removeAfter = h.router.afterEach((to, _from, failure) => {
          try {
            assert.equal(failure, undefined, 'history navigation succeeds')
            assert.equal(to.fullPath, destination, 'history reached its exact destination')
            finish()
          } catch (error) { finish(error) }
        })
        removeError = h.router.onError(finish)
        timer = setTimeout(() => finish(new Error('History navigation did not settle within 3 seconds')), 3000)
        action()
      })
      await settle()
    } finally { cleanup() }
  }
  try {
    await load(h, marked('stopped'))
    await h.navigate('/process/B'); await reconcile(h, building('B'))
    await historyNavigation(() => h.router.back(), '/process/A'); await reconcile(h, marked('stopped'))
    assert.equal(state(h).graphStop.state, 'stopped')
    await historyNavigation(() => h.router.forward(), '/process/B'); await reconcile(h, building('B'))
    assert.equal(state(h).projectData.project_id, 'B')
    assert.equal(h.calls('stopGraphBuild').length, 0); assert.equal(h.calls('buildGraph').length, 0)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) {
  test(`${locale} copy preserves whole-chunk/model semantics and observed counts`, async () => {
    const h = build({ locale })
    try {
      await load(h, marked())
      const status = text(button(h, 'graph-stop-status'))
      assert.ok(status.length > 40); assert.doesNotMatch(status, /step1\./)
      if (locale === 'en') { assert.match(status, /current document chunk/); assert.match(status, /model requests may finish/) }
      const counts = text(button(h, 'graph-stop-counts'))
      assert.match(counts, /5/); assert.match(counts, /1/); assert.match(counts, /2/)
      assert.equal(setupButton(h).props.disabled, true)
    } finally { h.close() }
  })
}
