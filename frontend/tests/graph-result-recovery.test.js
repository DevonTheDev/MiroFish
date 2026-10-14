import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, graphView } from './helpers/parent-route-fixture.js'

const fixture = (locale = 'en') => build({ graphRoute: true, locale })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const state = h => h.state(graphView)
const control = (h, name) => h.find(node => node.props?.['data-testid'] === name)
const create = h => control(h, 'create-simulation')
const retry = h => control(h, 'retry-graph-result')
const text = node => [node?.text, ...(node?.children ?? []).map(text)].filter(Boolean).join(' ')
const completed = (id = 'A', graphId = 'GA-new') => ({ project_id: id, status: 'graph_completed', graph_id: graphId })
const noMutations = h => assert.deepEqual(Object.keys(h.requests).filter(name =>
  !['getProject', 'getTaskStatus', 'getGraphData'].includes(name)), [], 'recovery only observes saved data')

async function finishTask(h, oldGraph = undefined) {
  await h.mount('/process/A')
  pending(h, 'getProject').resolve(ok({ project_id: 'A', status: 'graph_building', graph_build_task_id: 'task-A', graph_id: oldGraph }))
  await settle()
  const queuedTick = [...h.intervals.values()][0].callback
  pending(h, 'getTaskStatus').resolve(ok({ status: 'completed', progress: 100 }))
  await settle()
  return { request: pending(h, 'getProject'), queuedTick }
}

async function unavailable(h) {
  const terminal = await finishTask(h, 'GA-old')
  terminal.request.reject(new Error('synthetic offline'))
  await settle()
  assert.ok(retry(h), 'a final-read failure exposes the recovery button')
  return terminal
}

test('completed task waits for saved metadata without exposing an old graph or restarting polling', async () => {
  const h = fixture()
  try {
    const { queuedTick } = await finishTask(h, 'GA-old')
    assert.notEqual(state(h).statusText, 'Ready', 'task completion alone is not project readiness')
    assert.equal(state(h).currentPhase, 1)
    assert.equal(state(h).buildProgress.progress, 100)
    assert.match(text(h.host), /Graph build completed\. Loading saved result/)
    assert.equal(control(h, 'graph-result-status').props.role, 'status')
    assert.equal(control(h, 'graph-result-status').props['aria-live'], 'polite')
    assert.equal(retry(h).props.disabled, true)
    assert.equal(create(h).props.disabled, true)
    create(h).props.onClick(); retry(h).props.onClick(); queuedTick()
    await h.tick(2000); await h.tick(2000); await h.tick(2000)
    assert.equal(h.intervals.size, 0)
    assert.equal(h.calls('getTaskStatus').length, 1)
    assert.equal(h.calls('getProject').length, 2)
    assert.equal(h.calls('getGraphData').length, 0)
    noMutations(h)
  } finally { h.close() }
})

for (const [name, response] of [
  ['rejected read', new Error('synthetic offline')],
  ['unsuccessful read', { success: false, error: 'synthetic unavailable' }],
  ['unsuccessful read without details', { success: false }],
  ['missing data', ok(null)],
  ['missing graph ID', ok({ ...completed(), graph_id: null })],
  ['blank graph ID', ok({ ...completed(), graph_id: '  ' })],
  ['non-string graph ID', ok({ ...completed(), graph_id: 5 })],
  ['wrong project', ok(completed('B'))],
  ['missing project ID', ok({ status: 'graph_completed', graph_id: 'GA-new' })],
  ...['graph_building', 'ontology_generated', 'created', 'failed', 'unknown'].map(status =>
    [status + ' metadata', ok({ ...completed(), status })]),
]) {
  test(`terminal ${name} stays visibly retryable and cannot use an old graph ID`, async () => {
    const h = fixture()
    try {
      const { request, queuedTick } = await finishTask(h, 'GA-old')
      if (response instanceof Error) request.reject(response); else request.resolve(response)
      await settle(); queuedTick(); await h.tick(2000)
      assert.notEqual(state(h).statusText, 'Ready')
      assert.equal(state(h).currentPhase, 1)
      assert.match(text(h.host), /Graph build completed, but its saved result could not be loaded/)
      assert.equal(control(h, 'graph-result-status').props.role, 'alert')
      assert.equal(retry(h).props.disabled, false)
      assert.match(text(retry(h)), /Retry loading graph result/)
      assert.equal(create(h).props.disabled, true)
      create(h).props.onClick(); await settle()
      assert.equal(h.calls('getGraphData').length, 0)
      assert.equal(h.calls('getTaskStatus').length, 1)
      assert.equal(h.intervals.size, 0)
      const click = retry(h).props.onClick
      click(); click(); await settle()
      assert.equal(h.calls('getProject').length, 3, 'only one explicit retry is in flight')
      assert.equal(pending(h, 'getProject').args[0], 'A')
      assert.equal(retry(h).props.disabled, true)
      noMutations(h)
    } finally { h.close() }
  })
}

test('repeated retry failures remain recoverable; accepted new graph enables setup before preview finishes', async () => {
  const h = fixture()
  try {
    await unavailable(h)
    const click = retry(h).props.onClick
    for (const response of [{ success: false }, new Error('still offline')]) {
      click(); click(); await settle()
      const request = pending(h, 'getProject')
      if (response instanceof Error) request.reject(response); else request.resolve(response)
      await settle()
      assert.equal(retry(h).props.disabled, false)
      assert.equal(create(h).props.disabled, true)
    }
    click(); click(); await settle()
    pending(h, 'getProject').resolve(ok(completed())); await settle()
    assert.equal(h.calls('getProject').length, 5)
    assert.equal(h.calls('getTaskStatus').length, 1)
    assert.equal(pending(h, 'getGraphData').args[0], 'GA-new')
    assert.equal(state(h).statusText, 'Ready')
    assert.equal(state(h).graphLoading, true)
    assert.equal(state(h).graphData, null)
    assert.equal(create(h).props.disabled, false, 'setup does not wait for graph rendering')
    assert.equal(retry(h), undefined)
    click(); await settle()
    assert.equal(h.calls('getProject').length, 5, 'an accepted result retires its retry handler')
    pending(h, 'getGraphData').reject(new Error('preview unavailable')); await settle()
    assert.equal(create(h).props.disabled, false)
    h.graph().emit('refresh'); await settle()
    assert.equal(pending(h, 'getGraphData').args[0], 'GA-new')
    pending(h, 'getGraphData').resolve(ok({ nodes: [{ name: 'new graph' }] })); await settle()
    assert.equal(state(h).graphData.nodes[0].name, 'new graph')
    noMutations(h)
    create(h).props.onClick(); create(h).props.onClick(); await settle()
    assert.equal(h.calls('createSimulation').length, 1)
    assert.equal(pending(h, 'createSimulation').args[0].graph_id, 'GA-new')
    assert.equal(pending(h, 'createSimulation').args[0].project_id, 'A')
  } finally { h.close() }
})

test('preview refresh cannot load a retained old graph while the completed result is unresolved', async () => {
  const h = fixture()
  try {
    const { request } = await finishTask(h, 'GA-old')
    assert.equal(h.graph().props.graphDownload.enabled, false)
    assert.equal(h.graph().props.graphDownload.action, undefined)
    h.graph().emit('refresh'); await settle()
    assert.equal(h.calls('getGraphData').length, 0)
    request.resolve({ success: false }); await settle()
    assert.equal(h.graph().props.graphDownload.enabled, false)
    h.graph().emit('refresh'); await settle()
    assert.equal(h.calls('getGraphData').length, 0)
    retry(h).props.onClick(); await settle()
    pending(h, 'getProject').resolve(ok(completed())); await settle()
    h.graph().emit('refresh'); await settle()
    assert.equal(h.calls('getGraphData').length, 2)
    assert.ok(h.calls('getGraphData').every(call => call.args[0] === 'GA-new'))
    assert.equal(h.graph().props.graphDownload.enabled, false)
    assert.equal(h.downloads.length, 0)
    noMutations(h)
  } finally { h.close() }
})

for (const leave of ['A → B', 'A → B → A', 'route departure', 'unmount']) {
  for (const rejected of [false, true]) {
    test(`${leave} retires retry handlers and late ${rejected ? 'failure' : 'success'}`, async () => {
      const h = fixture()
      let release
      try {
        await unavailable(h)
        const oldClick = retry(h).props.onClick
        oldClick(); await settle()
        const old = pending(h, 'getProject')
        if (leave === 'unmount') h.close()
        else if (leave === 'route departure') {
          h.router.beforeEach(to => to.path === '/' ? new Promise(resolve => { release = resolve }) : undefined)
          h.router.push('/'); await settle(); assert.ok(release)
        } else {
          await h.navigate('/process/B')
          if (leave === 'A → B → A') await h.navigate('/process/A')
        }
        assert.equal(old.signal.aborted, true)
        const calls = h.calls('getProject').length
        const logs = state(h).systemLogs.length
        oldClick(); oldClick()
        if (rejected) old.reject(new Error('retired failure'))
        else old.resolve(ok(completed()))
        await settle(); await h.tick(2000)
        assert.equal(h.calls('getProject').length, calls)
        assert.equal(h.calls('getGraphData').length, 0)
        assert.equal(state(h).systemLogs.length, logs)
        assert.equal(state(h).projectData, null)
        assert.equal(state(h).graphData, null)
        assert.equal(state(h).error, '')
        assert.equal(retry(h), undefined)
        noMutations(h)
        if (leave.startsWith('A →')) {
          const id = leave === 'A → B' ? 'B' : 'A'
          pending(h, 'getProject').resolve(ok(completed(id, 'current-' + id))); await settle()
          oldClick(); await settle()
          assert.equal(h.calls('getProject').length, calls)
          assert.equal(state(h).statusText, 'Ready')
          assert.equal(create(h).props.disabled, false)
          assert.equal(pending(h, 'getGraphData').args[0], 'current-' + id)
        }
      } finally { release?.(false); await settle(); h.close() }
    })
  }
}

for (const locale of ['en', 'zh']) {
  test(`saved-result recovery renders translated status and native accessible controls in ${locale}`, async () => {
    const h = fixture(locale)
    try {
      const { request } = await finishTask(h)
      assert.match(text(h.host), locale === 'en' ? /Graph build completed\. Loading saved result/ : /图谱构建已完成，正在加载已保存的结果/)
      request.resolve({ success: false }); await settle()
      assert.equal(retry(h).type, 'button')
      assert.equal(retry(h).props.type, 'button')
      assert.match(text(retry(h)), locale === 'en' ? /Retry loading graph result/ : /重试加载图谱结果/)
      assert.doesNotMatch(text(h.host), /step1\./)
      assert.equal(control(h, 'graph-result-status').props['aria-atomic'], 'true')
      noMutations(h)
    } finally { h.close() }
  })
}
