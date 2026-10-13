import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import * as Content from '../src/utils/content.js'

const viewPath = 'views/ReportView.vue'
const childPath = 'components/Step4Report.vue'
const readSource = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')
const sources = Object.fromEntries([viewPath, childPath].map(path => {
  const { descriptor } = parse(readSource(path), { filename: path })
  const script = compileScript(descriptor, { id: path })
  const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  return [path, { script: script.content, template: template.code }]
}))
const routerSource = readSource('router/index.js')
assert.equal(parse(readSource('App.vue')).descriptor.template.content.trim(), '<router-view />')

// Keep the real TransitionGroup lifecycle, but turn off CSS animation in this
// non-DOM renderer. Plain host nodes are deliberately not browser Elements.
const originalElement = globalThis.Element
globalThis.Element ??= class Element {}
after(() => {
  if (originalElement === undefined) delete globalThis.Element
  else globalThis.Element = originalElement
})
const hostVue = { ...Vue, TransitionGroup: { ...Vue.TransitionGroup,
  props: { ...Vue.TransitionGroup.props, css: { default: false } } } }

function renderer() {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const remove = child => {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
    child.parent = null
  }
  const insert = (child, parent, anchor = null) => {
    remove(child)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
    child.parent = parent
  }
  return Vue.createRenderer({
    createElement: type => node(type), createText: text => node('#text', text),
    createComment: text => node('#comment', text), insert, remove,
    insertStaticContent(content, parent, anchor) {
      const child = node('#static', content); insert(child, parent, anchor); return [child, child]
    },
    setText: (target, text) => { target.text = text },
    setElementText: (target, text) => { target.children = []; target.text = text },
    parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    patchProp: (target, key, _previous, value) => { target.props[key] = value },
  })
}

async function settle() {
  for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); await Vue.nextTick() }
}
const ok = data => ({ success: true, data })
const stages = ['getReport', 'getSimulation', 'getProject', 'getGraphData']
const idFor = (stage, id) => ({ getReport: id, getSimulation: 'S' + id,
  getProject: 'P' + id, getGraphData: 'G' + id })[stage]
const replyFor = (stage, id) => ok({
  getReport: { simulation_id: 'S' + id },
  getSimulation: { project_id: 'P' + id },
  getProject: { project_id: 'P' + id, graph_id: 'G' + id },
  getGraphData: { nodes: [{ name: id + ' graph' }], edges: [] },
}[stage])
const complete = id => ok({ from_line: 0, logs: [{ action: 'report_complete', timestamp: id, details: {} }] })

function build() {
  const requests = {}, instances = {}, intervals = new Map(), warnings = []
  let nextTimer = 1
  const api = new Proxy({}, { get(_target, name) {
    return (...args) => new Promise((resolve, reject) => {
      // The transport deliberately settles after abort. Ownership checks, not
      // a cooperative mock transport, must prevent every stale continuation.
      const request = { args, signal: args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined,
        settled: false,
        resolve(value) { request.settled = true; resolve(value) },
        reject(error) { request.settled = true; reject(error) } }
      ;(requests[name] ??= []).push(request)
    })
  } })
  const boundary = { render: () => Vue.h('unrelated-boundary') }
  const graph = { props: ['graphData', 'loading', 'currentPhase', 'isSimulating'],
    emits: ['refresh', 'toggle-maximize'], setup() {
      instances.graph = Vue.getCurrentInstance()
      return () => Vue.h('graph-boundary')
    } }
  const components = { '../components/GraphPanel.vue': graph,
    '../components/LanguageSwitcher.vue': boundary }
  const modules = { vue: hostVue, 'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': { useI18n: () => ({ t: (key, params) => key + (params ? JSON.stringify(params) : '') }) },
    '../utils/content.js': Content }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController,
      console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
      setInterval: (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id },
      clearInterval: id => intervals.delete(id) }
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      const path = statement.source.value
      const dependency = modules[path] ?? (path.includes('/api/') ? api : null)
      for (const item of statement.specifiers) {
        globals[item.local.name] = item.type === 'ImportDefaultSpecifier'
          ? components[path] ?? boundary : dependency[item.imported.name]
      }
      source = source.slice(0, statement.start) + source.slice(statement.end)
    }
    return vm.runInNewContext(source.replace('export default', 'const component =')
      .replace('export function render', 'function render') + '\n;' + returnName, globals)
  }
  function component(path) {
    const value = evaluate(sources[path].script)
    value.render = evaluate(sources[path].template, 'render')
    const setup = value.setup
    value.setup = (props, context) => {
      ;(instances[path] ??= []).push(Vue.getCurrentInstance())
      return setup(props, context)
    }
    return value
  }
  components['../components/Step4Report.vue'] = component(childPath)
  components['../views/ReportView.vue'] = component(viewPath)
  const router = evaluate(routerSource)
  const app = renderer().createApp({ render: () => Vue.h(Router.RouterView) })
  app.use(router)
  app.config.globalProperties.$t = key => key
  app.config.globalProperties.$tm = () => []
  app.config.warnHandler = message => warnings.push(message)
  const host = { type: 'root', children: [] }
  let mounted = false
  return { requests, instances, intervals, warnings, router,
    state: () => instances[viewPath].at(-1).setupState,
    view: () => instances[viewPath].at(-1),
    child: () => instances[childPath].at(-1), graph: () => instances.graph,
    calls: name => requests[name] ?? [],
    async mount() { await router.push('/report/A'); await router.isReady(); app.mount(host); mounted = true; await settle() },
    async navigate(id) { await router.push('/report/' + id); await settle() },
    close() { if (mounted) { mounted = false; app.unmount() } },
    find(predicate) {
      const visit = target => predicate(target) ? target : target.children?.map(visit).find(Boolean)
      return visit(host)
    },
  }
}

const pending = (h, stage, id = 'A') => {
  const request = h.calls(stage).findLast(call => !call.settled && !call.signal?.aborted
    && call.args[0] === (stages.includes(stage) ? idFor(stage, id) : id))
  assert.ok(request, `${id} has a pending ${stage} request`)
  return request
}
async function reach(h, stage, id = 'A') {
  for (const current of stages.slice(0, stages.indexOf(stage))) {
    pending(h, current, id).resolve(replyFor(current, id)); await settle()
  }
  return pending(h, stage, id)
}
async function loaded(h, id = 'A') {
  const graph = await reach(h, 'getGraphData', id)
  graph.resolve(replyFor('getGraphData', id)); await settle()
}
const messages = h => Array.from(h.state().systemLogs, log => log.msg)
const snapshot = h => JSON.stringify({ simulationId: h.state().simulationId, project: h.state().projectData,
  graph: h.state().graphData, loading: h.state().graphLoading, status: h.state().currentStatus,
  logs: messages(h), childReport: h.child().props.reportId, childSimulation: h.child().props.simulationId })
const chainCounts = h => stages.map(stage => h.calls(stage).length)
const status = h => h.find(node => String(node.props?.class).includes('status-indicator'))
function assertCurrent(h, id) {
  assert.equal(h.state().simulationId, 'S' + id)
  assert.equal(h.child().props.reportId, id)
  assert.equal(h.child().props.simulationId, 'S' + id)
  assert.equal(h.state().projectData.project_id, 'P' + id)
  assert.equal(h.graph().props.graphData.nodes[0].name, id + ' graph')
  assert.equal(h.graph().props.loading, false)
}
async function finishOld(h, request, stage, reject) {
  if (reject) request.reject(new Error('retired ' + stage))
  else request.resolve(replyFor(stage, 'A'))
  await settle()
}

test('report route normal mount, current chain, sequential refresh and same-ID query preserve current behavior', async () => {
  const h = build()
  try {
    await h.mount()
    assert.equal(h.calls('getReport').length, 1)
    assert.equal(h.calls('getAgentLog').length, 1)
    assert.equal(h.calls('getConsoleLog').length, 1)
    const initial = pending(h, 'getReport')
    await loaded(h); assertCurrent(h, 'A')
    const signals = stages.map(stage => h.calls(stage)[0].signal)
    assert.ok(signals.every(signal => signal === initial.signal && signal?.aborted === false))
    for (const name of ['first refresh', 'second refresh']) {
      h.graph().emit('refresh'); await settle()
      assert.equal(h.graph().props.loading, true)
      pending(h, 'getGraphData').resolve(ok({ nodes: [{ name }] })); await settle()
      assert.equal(h.graph().props.graphData.nodes[0].name, name)
      assert.equal(h.graph().props.loading, false)
    }
    const before = snapshot(h), counts = chainCounts(h), original = h.view()
    await h.navigate('A?tab=graph')
    assert.equal(h.view(), original)
    assert.equal(snapshot(h), before)
    assert.deepEqual(chainCounts(h), counts)
    assert.equal(initial.signal.aborted, false)
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

test('report route completed A to B resets metadata, graph, logs and completed status', async () => {
  const h = build()
  try {
    await h.mount(); await loaded(h)
    pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    assert.equal(h.state().currentStatus, 'completed')
    assert.match(status(h).props.class, /completed/)
    const original = h.view(), originalChild = h.child()
    await h.navigate('B')
    assert.equal(h.view(), original)
    assert.equal(h.child(), originalChild)
    assert.equal(h.instances[viewPath].length, 1)
    assert.equal(h.state().simulationId, null)
    assert.equal(h.state().projectData, null)
    assert.equal(h.graph().props.graphData, null)
    assert.equal(h.graph().props.loading, false)
    assert.equal(h.child().props.simulationId, null)
    assert.equal(h.child().props.reportId, 'B')
    assert.equal(h.state().currentStatus, 'processing')
    assert.match(status(h).props.class, /processing/)
    assert.ok(!messages(h).some(message => message.includes('"PA"') || message.includes('"A"') || message.includes('initialized: A')))
    await loaded(h, 'B'); assertCurrent(h, 'B')
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

for (const stage of stages.slice(0, 3)) for (const reject of [false, true]) {
  test(`report route stale ${stage} ${reject ? 'rejection' : 'success'} cannot mutate B or continue A`, async () => {
    const h = build()
    try {
      await h.mount(); const old = await reach(h, stage)
      await h.navigate('B'); await loaded(h, 'B')
      const before = snapshot(h), counts = chainCounts(h)
      await finishOld(h, old, stage, reject)
      assert.equal(snapshot(h), before)
      assert.deepEqual(chainCounts(h), counts)
      assert.equal(old.signal?.aborted, true)
      assertCurrent(h, 'B')
    } finally { h.close() }
  })
}

for (const stage of stages.slice(0, 3)) {
  test(`report route A to B to A retires the first ${stage} owner`, async () => {
    const h = build()
    try {
      await h.mount(); const old = await reach(h, stage)
      await h.navigate('B'); await h.navigate('A')
      const before = snapshot(h), counts = chainCounts(h)
      await finishOld(h, old, stage, false)
      assert.equal(snapshot(h), before)
      assert.deepEqual(chainCounts(h), counts)
      assert.equal(old.signal?.aborted, true)
      await loaded(h); assertCurrent(h, 'A')
    } finally { h.close() }
  })
}

for (const currentSettled of [false, true]) for (const reject of [false, true]) {
  test(`report route stale graph ${reject ? 'rejection' : 'success'} preserves ${currentSettled ? 'settled' : 'pending'} B graph and loading`, async () => {
    const h = build()
    try {
      await h.mount(); const old = await reach(h, 'getGraphData')
      await h.navigate('B'); const current = await reach(h, 'getGraphData', 'B')
      if (currentSettled) { current.resolve(replyFor('getGraphData', 'B')); await settle() }
      const before = snapshot(h), counts = chainCounts(h)
      await finishOld(h, old, 'getGraphData', reject)
      assert.equal(snapshot(h), before)
      assert.deepEqual(chainCounts(h), counts)
      assert.equal(h.graph().props.loading, !currentSettled)
      assert.equal(old.signal?.aborted, true)
      if (!currentSettled) { current.resolve(replyFor('getGraphData', 'B')); await settle() }
      assertCurrent(h, 'B')
    } finally { h.close() }
  })
}

for (const stage of stages) for (const reject of [false, true]) {
  test(`report route unmount ignores ${stage} ${reject ? 'rejection' : 'success'} without downstream work`, async () => {
    const h = build()
    try {
      await h.mount(); const old = await reach(h, stage)
      h.close()
      const before = snapshot(h), counts = chainCounts(h)
      await finishOld(h, old, stage, reject)
      assert.equal(snapshot(h), before)
      assert.deepEqual(chainCounts(h), counts)
      assert.equal(old.signal?.aborted, true)
      assert.equal(h.intervals.size, 0)
      assert.ok(h.calls('getAgentLog').every(request => request.signal.aborted))
      assert.ok(h.calls('getConsoleLog').every(request => request.signal.aborted))
    } finally { h.close() }
  })
}

for (const stage of stages) {
  test(`report route current ${stage} failure keeps its existing diagnostic and loading behavior`, async () => {
    const h = build()
    try {
      await h.mount(); const current = await reach(h, stage), counts = chainCounts(h)
      current.reject(new Error('current ' + stage + ' failure')); await settle()
      const key = stage === 'getGraphData' ? 'log.graphLoadFailed' : 'log.loadException'
      assert.ok(messages(h).some(message => message.includes(key) && message.includes('current ' + stage + ' failure')))
      assert.deepEqual(chainCounts(h), counts)
      assert.equal(h.state().currentStatus, 'processing')
      assert.equal(h.graph().props.loading, false)
      if (stage === 'getGraphData') {
        h.graph().emit('refresh'); await settle()
        pending(h, stage).resolve(replyFor(stage, 'A')); await settle()
        assertCurrent(h, 'A')
      }
    } finally { h.close() }
  })
}

test('report route actual Step4 ignores stale completion, completes B and opens the current interaction', async () => {
  const h = build()
  try {
    await h.mount()
    const old = pending(h, 'getAgentLog'), oldConsole = pending(h, 'getConsoleLog')
    await h.navigate('B')
    old.resolve(complete('A')); oldConsole.resolve(ok({ from_line: 0, logs: ['retired console'] })); await settle()
    assert.equal(h.child().setupState.isComplete, false)
    assert.equal(h.child().setupState.agentLogs.length, 0)
    assert.equal(h.child().setupState.consoleLogs.length, 0)
    assert.equal(h.state().currentStatus, 'processing')
    assert.equal(old.signal.aborted, true)
    assert.equal(oldConsole.signal.aborted, true)
    pending(h, 'getAgentLog', 'B').resolve(complete('B')); await settle()
    assert.equal(h.child().setupState.isComplete, true)
    assert.equal(h.state().currentStatus, 'completed')
    assert.match(status(h).props.class, /completed/)
    assert.equal(h.intervals.size, 0)
    const button = h.find(node => node.type === 'button' && node.props.class === 'next-step-btn')
    assert.ok(button)
    const navigated = new Promise(resolve => {
      const remove = h.router.afterEach(to => { if (to.name === 'Interaction') { remove(); resolve() } })
    })
    button.props.onClick(); await navigated; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, '/interaction/B')
    assert.equal(h.calls('getReport').at(-1).signal?.aborted, true)
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})
