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
  const node = (type, text = '') => ({ type, text, props: {}, style: {}, children: [], parent: null })
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

const translations = Object.fromEntries(['en', 'zh'].map(locale => [locale,
  JSON.parse(readFileSync(new URL('../../locales/' + locale + '.json', import.meta.url), 'utf8'))]))

function build({ locale, reportProps, runtime = 'cloud' } = {}) {
  const translate = (key, params) => locale
    ? key.split('.').reduce((value, segment) => value?.[segment], translations[locale]) ?? key
    : key + (params ? JSON.stringify(params) : '')
  const requests = {}, instances = {}, intervals = new Map(), warnings = []
  let nextTimer = 1
  const api = new Proxy({}, { get(_target, name) {
    return (...args) => {
      // Existing observation-only cases explicitly exercise unsupported cloud mode.
      // Manual mode leaves exact-ID progress under each cancellation test's control.
      if (name === 'getReportProgress' && runtime === 'cloud') return Promise.resolve(ok({ report_id: args[0], cancellation_supported: false }))
      return new Promise((resolve, reject) => {
      // The transport deliberately settles after abort. Ownership checks, not
      // a cooperative mock transport, must prevent every stale continuation.
      const request = { args, signal: args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined,
        settled: false,
        resolve(value) { request.settled = true; resolve(value) },
        reject(error) { request.settled = true; reject(error) } }
      ;(requests[name] ??= []).push(request)
      })
    }
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
    'vue-i18n': { useI18n: () => ({ t: translate }) },
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
  const app = renderer().createApp({ render: () => reportProps
    ? Vue.h(components['../components/Step4Report.vue'], reportProps) : Vue.h(Router.RouterView) })
  app.use(router)
  app.config.globalProperties.$t = translate
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
  graph: h.state().graphData, loading: h.state().graphLoading, metadata: h.state().metadataStatus, status: h.state().currentStatus,
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


const graphContent = h => h.find(node => node.props?.['data-testid'] === 'report-graph-content')
const metadataPanel = h => h.find(node => node.props?.['data-testid'] === 'graph-metadata')
const metadataRetry = h => h.find(node => node.props?.['data-testid'] === 'retry-graph-metadata')
const metadataMessage = h => h.find(node => node.props?.['data-testid'] === 'graph-metadata-message')
const textContent = node => [node.text ?? '', ...(node.children ?? [])
  .filter(child => child.type !== '#comment').map(textContent)].join(' ')
const onlyReads = h => assert.ok(Object.keys(h.requests).every(name => name.startsWith('get')))

// Exact baseline witness: a current report metadata rejection must expose a
// visible, usable recovery action while the actual Step4 stays mounted.
test('graph metadata failure exposes a retry in the default workbench', async () => {
  const h = build()
  try {
    await h.mount()
    const child = h.child()
    pending(h, 'getReport').reject(new Error('metadata unavailable')); await settle()
    assert.ok(metadataPanel(h), 'graph metadata failure must be visible in the default workbench')
    assert.equal(graphContent(h).props.hidden, true, 'hide the unrelated ontology-waiting graph placeholder')
    assert.equal(metadataMessage(h).props.role, 'alert')
    assert.equal(metadataRetry(h).props.disabled, false)
    assert.equal(h.state().viewMode, 'workbench')
    assert.equal(h.child(), child)
    assert.equal(h.child().isUnmounted, false)
    assert.equal(h.state().currentStatus, 'processing')
    assert.equal(h.calls('getAgentLog').length, 1)
    assert.equal(h.calls('getConsoleLog').length, 1)
    onlyReads(h)
  } finally { h.close() }
})

test('graph metadata pending and retry are single flight and a failed retry stays usable', async () => {
  const h = build()
  try {
    await h.mount()
    const child = h.child(), initial = pending(h, 'getReport')
    assert.equal(graphContent(h).props.hidden, true)
    const retry = metadataRetry(h).props.onClick
    assert.equal(metadataMessage(h).props.role, 'status')
    assert.equal(metadataPanel(h).props['aria-busy'], true)
    assert.equal(metadataRetry(h).props.disabled, true)
    retry(); retry(); await settle()
    assert.equal(h.calls('getReport').length, 1)
    initial.reject(new Error('initial failure')); await settle()
    retry(); retry(); await settle()
    assert.equal(h.calls('getReport').length, 2)
    assert.equal(metadataMessage(h).props.role, 'status')
    assert.equal(metadataRetry(h).props.disabled, true)
    pending(h, 'getReport').reject(new Error('retry failure')); await settle()
    assert.equal(metadataMessage(h).props.role, 'alert')
    assert.equal(metadataRetry(h).props.disabled, false)
    retry(); await settle(); await loaded(h)
    assertCurrent(h, 'A')
    assert.equal(metadataPanel(h), undefined)
    assert.equal(graphContent(h).props.hidden, false)
    assert.equal(h.child(), child)
    assert.equal(h.calls('getAgentLog').length, 1)
    assert.equal(h.calls('getConsoleLog').length, 1)
    const counts = chainCounts(h)
    retry(); await settle()
    assert.deepEqual(chainCounts(h), counts, 'captured retry cannot reload ready metadata')
    onlyReads(h)
  } finally { h.close() }
})

const metadataFailures = [
  ['rejection', request => request.reject(new Error('metadata read failed'))],
  ['unsuccessful response', request => request.resolve({ success: false, error: 'unavailable' })],
  ['null response', request => request.resolve(null)],
  ['missing data', request => request.resolve({ success: true })],
  ['malformed data', request => request.resolve(ok('invalid'))],
  ['missing relation', request => request.resolve(ok({ graph_id: 'must-not-bypass-the-chain' }))],
  ['invalid relation', (request, stage) => request.resolve(ok({
    [{ getReport: 'simulation_id', getSimulation: 'project_id', getProject: 'graph_id' }[stage]]: '   ',
  }))],
]
for (const stage of stages.slice(0, 3)) for (const [kind, fail] of metadataFailures) {
  // The project missing-relation case must not accidentally supply graph_id.
  test(`graph metadata ${stage} ${kind} is recoverable without changing report status`, async () => {
    const h = build()
    try {
      await h.mount(); const request = await reach(h, stage), counts = chainCounts(h)
      if (stage === 'getProject' && kind === 'missing relation') request.resolve(ok({ project_id: 'PA' }))
      else fail(request, stage)
      await settle()
      assert.equal(metadataMessage(h).props.role, 'alert')
      assert.equal(metadataRetry(h).props.disabled, false)
      assert.deepEqual(chainCounts(h), counts, 'invalid metadata must not continue downstream')
      assert.equal(h.state().currentStatus, 'processing')
      assert.equal(h.graph().props.loading, false)
      metadataRetry(h).props.onClick(); await settle(); await loaded(h)
      assert.equal(metadataPanel(h), undefined)
      assertCurrent(h, 'A'); onlyReads(h)
      assert.equal(h.warnings.length, 0)
    } finally { h.close() }
  })
}

for (const target of ['B', 'A', 'unmount']) {
  test(`graph metadata captured retry is retired after ${target === 'A' ? 'A to B to A' : target}`, async () => {
    const h = build()
    try {
      await h.mount(); pending(h, 'getReport').reject(new Error('first failure')); await settle()
      const retry = metadataRetry(h).props.onClick
      if (target === 'unmount') h.close()
      else {
        await h.navigate('B')
        if (target === 'A') await h.navigate('A')
        pending(h, 'getReport', target).reject(new Error('current failure')); await settle()
      }
      const before = snapshot(h), counts = chainCounts(h)
      retry(); retry(); await settle()
      assert.equal(snapshot(h), before)
      assert.deepEqual(chainCounts(h), counts, 'retired retry cannot start the new route metadata chain')
    } finally { h.close() }
  })
}

for (const stage of stages.slice(0, 3)) for (const target of ['B', 'A', 'unmount']) for (const reject of [false, true]) {
  test(`graph metadata retry late ${stage} ${reject ? 'rejection' : 'success'} is ignored after ${target}`, async () => {
    const h = build()
    try {
      await h.mount(); pending(h, 'getReport').reject(new Error('first failure')); await settle()
      metadataRetry(h).props.onClick(); await settle()
      const old = await reach(h, stage)
      if (target === 'unmount') h.close()
      else {
        await h.navigate('B')
        if (target === 'A') await h.navigate('A')
        pending(h, 'getReport', target).reject(new Error('current failure')); await settle()
      }
      const before = snapshot(h), counts = chainCounts(h)
      await finishOld(h, old, stage, reject)
      assert.equal(snapshot(h), before)
      assert.deepEqual(chainCounts(h), counts)
      assert.equal(old.signal.aborted, true)
      if (target !== 'unmount') assert.equal(metadataMessage(h).props.role, 'alert')
    } finally { h.close() }
  })
}

for (const retrying of [false, true]) {
  test(`graph metadata ${retrying ? 'retry' : 'failure'} preserves Step4 completion, content, logs and interaction navigation`, async () => {
    const h = build()
    try {
      await h.mount(); const child = h.child()
      pending(h, 'getConsoleLog').resolve(ok({ from_line: 0, logs: ['Current report console'] })); await settle()
      pending(h, 'getReport').reject(new Error('parent metadata unavailable')); await settle()
      if (retrying) { metadataRetry(h).props.onClick(); await settle() }
      pending(h, 'getAgentLog').resolve(ok({ from_line: 0, logs: [
        { action: 'planning_complete', timestamp: '2026-10-13T00:00:00Z', details: {
          outline: { title: 'Current report title', summary: 'Current summary', sections: [{ title: 'Results' }] } } },
        { action: 'section_complete', timestamp: '2026-10-13T00:00:01Z', section_index: 1,
          details: { content: 'Preserved report content' } },
        { action: 'report_complete', timestamp: '2026-10-13T00:00:02Z', details: {} },
      ] })); await settle()
      assert.equal(h.child().setupState.isComplete, true)
      assert.equal(h.state().currentStatus, 'completed')
      const reportBefore = JSON.stringify({ outline: child.setupState.reportOutline,
        sections: child.setupState.generatedSections, logs: child.setupState.agentLogs,
        console: child.setupState.consoleLogs }), logsBefore = messages(h)
      metadataRetry(h).props.onClick(); await settle()
      if (!retrying) { pending(h, 'getReport').reject(new Error('retry still unavailable')); await settle() }
      assert.equal(h.child(), child)
      assert.equal(h.state().currentStatus, 'completed')
      assert.match(status(h).props.class, /completed/)
      assert.equal(JSON.stringify({ outline: child.setupState.reportOutline,
        sections: child.setupState.generatedSections, logs: child.setupState.agentLogs,
        console: child.setupState.consoleLogs }), reportBefore)
      assert.deepEqual(messages(h).slice(0, logsBefore.length), logsBefore)
      assert.equal(h.calls('getAgentLog').length, 1)
      assert.equal(h.calls('getConsoleLog').length, 1)
      assert.equal(h.intervals.size, 0)
      const content = h.find(node => node.props?.class === 'generated-content')
      assert.match(content.props.innerHTML, /Preserved report content/)
      assert.equal(h.find(node => node.type === 'h1').text, 'Current report title')
      const button = h.find(node => node.props?.class === 'next-step-btn')
      const navigated = new Promise(resolve => {
        const remove = h.router.afterEach(to => { if (to.name === 'Interaction') { remove(); resolve() } })
      })
      button.props.onClick(); await navigated; await settle()
      assert.equal(h.router.currentRoute.value.fullPath, '/interaction/A')
      assert.equal(child.isUnmounted, true)
      assert.equal(h.calls('getReport').at(-1).signal.aborted, true)
      onlyReads(h)
      assert.equal(h.warnings.length, 0)
    } finally { h.close() }
  })
}

test('graph data failure after metadata recovery keeps graph-only Refresh', async () => {
  const h = build()
  try {
    await h.mount(); pending(h, 'getReport').reject(new Error('metadata unavailable')); await settle()
    metadataRetry(h).props.onClick(); await settle()
    const graph = await reach(h, 'getGraphData')
    assert.equal(metadataPanel(h), undefined)
    assert.equal(graphContent(h).props.hidden, false)
    assert.equal(h.graph().props.loading, true)
    graph.reject(new Error('graph unavailable')); await settle()
    assert.equal(metadataPanel(h), undefined)
    const counts = chainCounts(h)
    h.graph().emit('refresh'); await settle()
    assert.deepEqual(chainCounts(h).slice(0, 3), counts.slice(0, 3))
    assert.equal(h.calls('getGraphData').length, counts[3] + 1)
    pending(h, 'getGraphData').resolve(replyFor('getGraphData', 'A')); await settle()
    assertCurrent(h, 'A'); onlyReads(h)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) {
  test(`graph metadata loading, unavailable and retry labels are localized and accessible (${locale})`, async () => {
    const h = build({ locale }), strings = translations[locale].graph
    try {
      await h.mount()
      assert.equal(metadataMessage(h).props.role, 'status')
      assert.equal(metadataMessage(h).props['aria-live'], 'polite')
      assert.equal(metadataMessage(h).props['aria-atomic'], 'true')
      assert.ok(textContent(metadataMessage(h)).includes(strings.reportMetadataLoading))
      assert.equal(metadataRetry(h).text, strings.reportMetadataRetry)
      assert.equal(metadataRetry(h).props.type, 'button')
      assert.equal(metadataRetry(h).props.disabled, true)
      pending(h, 'getReport').reject(new Error('private internal error')); await settle()
      assert.equal(metadataMessage(h).props.role, 'alert')
      assert.equal(metadataMessage(h).props['aria-live'], 'assertive')
      assert.ok(textContent(metadataMessage(h)).includes(strings.reportMetadataUnavailable))
      assert.ok(textContent(metadataMessage(h)).includes(strings.reportMetadataHint))
      assert.ok(!textContent(metadataMessage(h)).includes('private internal error'))
      assert.equal(metadataPanel(h).props['aria-busy'], false)
      assert.equal(metadataRetry(h).props.disabled, false)
      for (const mode of ['graph', 'split', 'workbench']) {
        h.state().viewMode = mode; await settle()
        assert.ok(metadataPanel(h), 'recovery remains visible in ' + mode)
        assert.equal(metadataPanel(h).parent, h.find(node => node.type === 'main').parent,
          'recovery is outside either independently hidden content panel')
        assert.equal(graphContent(h).props.hidden, true)
      }
      metadataRetry(h).props.onClick(); await settle()
      assert.equal(metadataMessage(h).props.role, 'status')
      assert.equal(metadataRetry(h).props.disabled, true)
      await loaded(h)
      assert.equal(metadataPanel(h), undefined)
    } finally { h.close() }
  })
}

const findWithin = (node, predicate) => predicate(node) ? node
  : node.children?.map(child => findWithin(child, predicate)).find(Boolean)
const reportSection = (h, index) => h.find(node => node.props?.class === 'sections-list')
  .children.filter(node => String(node.props?.class).split(' ').includes('report-section-item'))[index]
const sectionButton = (h, index) => findWithin(reportSection(h, index), node => node.type === 'button')
const sectionBody = (h, index) => findWithin(reportSection(h, index), node => node.props?.class === 'section-body')
const allRequestCounts = h => Object.fromEntries(Object.entries(h.requests).map(([name, calls]) => [name, calls.length]))
const sectionLog = (index, content, action = 'section_complete') => ({
  action, timestamp: `2026-10-13T00:00:0${index}Z`, section_index: index, details: { content },
})
async function showSections(h, titles, logs, id = 'A') {
  pending(h, 'getAgentLog', id).resolve(ok({ from_line: 0, logs: [
    { action: 'planning_complete', timestamp: '2026-10-13T00:00:00Z', details: {
      outline: { title: `${id} report`, summary: 'Section disclosure test', sections: titles.map(title => ({ title })) },
    } },
    ...logs,
  ] })); await settle()
}

// These host tests cover rendered semantics, bindings and application state.
// Native keyboard activation, focus rendering and screen-reader output need a browser.
test('report section completed heading exposes a native disclosure button', async () => {
  const h = build()
  try {
    await h.mount()
    await showSections(h, ['Results'], [sectionLog(1, 'Completed content')])
    const button = sectionButton(h, 0), body = sectionBody(h, 0)
    assert.ok(button, 'completed section must expose a native disclosure button')
    assert.equal(button.props.type, 'button')
    assert.equal(button.parent.type, 'h3')
    assert.ok(textContent(button).includes('Results'))
    assert.ok(textContent(button).includes('01'))
    assert.equal(button.props['aria-expanded'], true)
    assert.equal(typeof button.props['aria-controls'], 'string')
    assert.ok(button.props['aria-controls'].length > 0)
    assert.equal(button.props['aria-controls'], body.props.id)
    assert.notEqual(body.style.display, 'none')
    assert.equal(button.parent.props.onClick, undefined, 'heading must not duplicate the button handler')
    assert.equal(findWithin(button, node => node.type === 'svg').props['aria-hidden'], 'true')
    assert.deepEqual(allRequestCounts(h), { getAgentLog: 1, getConsoleLog: 1, getReport: 1 })
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

test('report section disclosure preserves missing empty whitespace and content-only eligibility', async () => {
  const h = build()
  try {
    await h.mount()
    await showSections(h, ['Missing', 'Empty', 'Whitespace', 'Completed', 'Content only'], [
      sectionLog(2, ''), sectionLog(3, ' \n\t '), sectionLog(4, 'Ready'),
      sectionLog(5, 'Still generating', 'section_content'),
    ])
    for (const index of [0, 1, 4]) {
      const section = reportSection(h, index)
      assert.equal(sectionButton(h, index), undefined)
      assert.equal(findWithin(section, node => typeof node.props?.onClick === 'function'), undefined)
      assert.ok(findWithin(section, node => node.type === 'h3'))
      assert.ok(findWithin(section, node => node.props?.class === 'section-number'))
      assert.notEqual(sectionBody(h, index).style.display, 'none')
    }
    for (const index of [2, 3]) {
      assert.equal(sectionButton(h, index).props['aria-expanded'], true)
      assert.equal(sectionButton(h, index).props['aria-controls'], sectionBody(h, index).props.id)
    }
    assert.equal(h.child().setupState.generatedSections[3], ' \n\t ')
    assert.equal(h.child().setupState.generatedSections[5], undefined)
    const before = allRequestCounts(h)
    sectionButton(h, 2).props.onClick(); await settle()
    assert.equal(sectionButton(h, 2).props['aria-expanded'], false)
    assert.equal(sectionBody(h, 2).style.display, 'none')
    assert.equal(sectionButton(h, 3).props['aria-expanded'], true)
    assert.deepEqual(allRequestCounts(h), before)
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

test('report section buttons collapse and reopen independently without report side effects', async () => {
  const h = build()
  try {
    await h.mount()
    await showSections(h, ['First', 'Second'], [
      sectionLog(1, '**First content**'), sectionLog(2, '<script>unsafe</script> Second content'),
      { action: 'report_complete', timestamp: '2026-10-13T00:00:03Z', details: {} },
    ])
    const child = h.child(), before = allRequestCounts(h), beforeRoute = snapshot(h)
    const beforeReport = JSON.stringify({ sections: child.setupState.generatedSections, logs: child.setupState.agentLogs })
    const bodies = [sectionBody(h, 0), sectionBody(h, 1)]
    const ids = bodies.map(body => body.props.id)
    const html = bodies.map(body => findWithin(body, node => node.props?.class === 'generated-content').props.innerHTML)
    assert.notEqual(ids[0], ids[1])
    assert.match(html[1], /&lt;script&gt;unsafe&lt;\/script&gt;/)
    for (const [clicked, expanded] of [[0, [false, true]], [1, [false, false]], [0, [true, false]], [1, [true, true]]]) {
      sectionButton(h, clicked).props.onClick(); await settle()
      for (const index of [0, 1]) {
        assert.equal(sectionBody(h, index), bodies[index], 'v-show retains the existing body')
        assert.equal(sectionButton(h, index).props['aria-expanded'], expanded[index])
        assert.equal(sectionButton(h, index).props['aria-controls'], ids[index])
        assert.equal(sectionBody(h, index).style.display === 'none', !expanded[index])
        assert.equal(findWithin(bodies[index], node => node.props?.class === 'generated-content').props.innerHTML, html[index])
      }
    }
    assert.equal(JSON.stringify({ sections: child.setupState.generatedSections, logs: child.setupState.agentLogs }), beforeReport)
    assert.equal(snapshot(h), beforeRoute)
    assert.deepEqual(allRequestCounts(h), before)
    assert.equal(h.router.currentRoute.value.fullPath, '/report/A')
    assert.equal(h.intervals.size, 0)
    assert.equal(child.setupState.isComplete, true)
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

test('report section collapse survives same-ID queries and resets on report changes', async () => {
  const h = build()
  try {
    await h.mount()
    await showSections(h, ['A section'], [sectionLog(1, 'A content')])
    const child = h.child(), body = sectionBody(h, 0), id = body.props.id
    sectionButton(h, 0).props.onClick(); await settle()
    const before = allRequestCounts(h), intervals = [...h.intervals.keys()]
    await h.navigate('A?tab=graph')
    assert.equal(h.child(), child)
    assert.equal(sectionBody(h, 0), body)
    assert.equal(sectionButton(h, 0).props['aria-controls'], id)
    assert.equal(sectionButton(h, 0).props['aria-expanded'], false)
    assert.equal(body.style.display, 'none')
    assert.deepEqual(allRequestCounts(h), before)
    assert.deepEqual([...h.intervals.keys()], intervals)
    await h.navigate('B')
    assert.equal(h.child(), child)
    assert.equal(child.setupState.collapsedSections.size, 0)
    assert.equal(h.find(node => node.props?.class === 'sections-list'), undefined)
    assert.deepEqual(allRequestCounts(h), { getAgentLog: 2, getConsoleLog: 2, getReport: 2 })
    await showSections(h, ['B section'], [sectionLog(1, 'B content')], 'B')
    assert.equal(sectionButton(h, 0).props['aria-expanded'], true)
    assert.notEqual(sectionBody(h, 0).style.display, 'none')
    assert.equal(sectionButton(h, 0).props['aria-controls'], sectionBody(h, 0).props.id)
    assert.equal(child.setupState.generatedSections[1], 'B content')
    assert.deepEqual(allRequestCounts(h), { getAgentLog: 2, getConsoleLog: 2, getReport: 2 })
    assert.equal(h.intervals.size, 2)
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

test('report section body IDs are unique across mounted report instances', async () => {
  const first = build(), second = build()
  try {
    await first.mount(); await second.mount()
    for (const h of [first, second]) {
      await showSections(h, ['First', 'Second'], [sectionLog(1, 'One'), sectionLog(2, 'Two')])
    }
    const ids = [first, second].flatMap(h => [0, 1].map(index => {
      const id = sectionBody(h, index).props.id
      assert.equal(sectionButton(h, index).props['aria-controls'], id)
      return id
    }))
    assert.equal(new Set(ids).size, 4)
    sectionButton(first, 0).props.onClick(); await settle()
    assert.equal(sectionButton(first, 0).props['aria-expanded'], false)
    assert.equal(sectionButton(second, 0).props['aria-expanded'], true)
    for (const h of [first, second]) {
      assert.deepEqual(allRequestCounts(h), { getAgentLog: 1, getConsoleLog: 1, getReport: 1 })
      assert.equal(h.warnings.length, 0)
    }
  } finally { first.close(); second.close() }
})


const savedReportLink = h => h.find(node => node.type === 'a' && node.props.href?.startsWith('/reports?'))
const anchorClick = (overrides = {}) => ({ button: 0, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true }, ...overrides })

for (const locale of ['en', 'zh']) test(`completed saved report link uses current identity and localized native anchor in ${locale}`, async () => {
  const h = build({ locale })
  try {
    await h.mount()
    assert.equal(savedReportLink(h), undefined, 'pending report has no saved-report link')
    await h.navigate('A?tab=graph&report_id=unrelated&revision=old&metadata_revision=old#old')
    const before = allRequestCounts(h)
    pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    const link = savedReportLink(h)
    assert.ok(link)
    assert.equal(link.props.href, '/reports?report_id=A')
    assert.equal(textContent(link).trim(), locale === 'en' ? 'Open saved report' : '打开已保存的报告')
    const note = h.find(node => node.type === 'p' && textContent(node).includes(locale === 'en'
      ? 'Reads the currently saved report.' : '读取当前保存的报告'))
    assert.equal(textContent(note).trim(), locale === 'en'
      ? 'Reads the currently saved report. Markdown and observation downloads are available there.'
      : '读取当前保存的报告，可在该页面下载 Markdown 和观测 JSON。')
    assert.equal(link.props.role, undefined)
    assert.equal(link.props.tabindex, undefined)
    assert.equal(link.props.onKeydown, undefined)
    assert.equal(link.props.target, undefined)
    assert.equal(typeof link.props.onClick, 'function')
    assert.ok(h.find(node => node.type === 'button' && node.props.class === 'next-step-btn'))
    await h.navigate('A?tab=other')
    assert.equal(savedReportLink(h), link)
    assert.equal(link.props.href, '/reports?report_id=A')
    assert.deepEqual(allRequestCounts(h), before, 'showing the link and same-ID query changes issue no extra requests')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('completed saved report link resets when a completed report is replaced', async () => {
  const h = build()
  try {
    await h.mount(); pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    assert.equal(savedReportLink(h).props.href, '/reports?report_id=A')
    const child = h.child()
    await h.navigate('B')
    assert.equal(h.child(), child)
    assert.equal(h.child().setupState.isComplete, false)
    assert.equal(savedReportLink(h), undefined)
    pending(h, 'getReport', 'B').reject(new Error('graph metadata unavailable')); await settle()
    assert.equal(savedReportLink(h), undefined)
    pending(h, 'getAgentLog', 'B').resolve(complete('B')); await settle()
    assert.equal(savedReportLink(h).props.href, '/reports?report_id=B')
  } finally { h.close() }
})

test('completed saved report link rejects stale completion through A to B to A', async () => {
  for (const target of ['B', 'A']) {
    const h = build()
    try {
      await h.mount(); const oldA = pending(h, 'getAgentLog')
      await h.navigate('B'); const oldB = pending(h, 'getAgentLog', 'B')
      if (target === 'A') await h.navigate('A')
      oldA.resolve(complete('A')); await settle()
      assert.equal(savedReportLink(h), undefined)
      assert.equal(h.child().setupState.isComplete, false)
      assert.equal(oldA.signal.aborted, true)
      if (target === 'A') {
        oldB.resolve(complete('B')); await settle()
        assert.equal(savedReportLink(h), undefined)
        assert.equal(oldB.signal.aborted, true)
      }
      pending(h, 'getAgentLog', target).resolve(complete(target)); await settle()
      assert.equal(savedReportLink(h).props.href, '/reports?report_id=' + target)
    } finally { h.close() }
  }
})

test('completed saved report link accepts only unnormalized ASCII IDs of length 1 through 128', async () => {
  const valid = ['A', '_', '-', 'aZ09_-', 'R'.repeat(128)]
  const invalid = [undefined, null, 7, true, ['A'], { reportId: 'A' }, '', 'R'.repeat(129),
    ' A', 'A ', 'A\t', 'A\n', 'A\r', 'A\r\n', 'A\u2028', 'A\u2029', 'A\0', 'é', '报告', 'Ａ',
    '../A', 'A/B', 'A\\B', 'A?x', 'A#x', 'A%20', 'A.B']
  for (const reportId of [...valid, ...invalid]) {
    const h = build({ reportProps: { reportId } })
    try {
      await h.mount()
      // Isolate the defensive ID gate even for props that cannot start polling.
      // Route-owned completion and reset behavior are exercised above separately.
      h.child().setupState.reportOutline = { title: 'Current report', sections: [] }
      h.child().setupState.isComplete = true
      await settle()
      const link = savedReportLink(h)
      if (valid.includes(reportId)) assert.equal(link?.props.href, '/reports?report_id=' + reportId)
      else assert.equal(link, undefined, `must reject raw ID ${JSON.stringify(reportId)}`)
    } finally { h.close() }
  }
})

test('completed saved report link preserves modified-click default behavior without extra requests', async () => {
  const h = build()
  try {
    await h.mount(); pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    const link = savedReportLink(h), before = allRequestCounts(h)
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = anchorClick(modifier)
      await link.props.onClick(event); await settle()
      assert.equal(event.defaultPrevented, false)
      assert.equal(h.router.currentRoute.value.fullPath, '/report/A')
    }
    assert.deepEqual(allRequestCounts(h), before)
    assert.equal(savedReportLink(h), link)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('completed saved report link navigates to the unpinned reader and retires Step4 requests', async () => {
  const h = build()
  try {
    await h.mount()
    const oldMetadata = pending(h, 'getReport'), oldConsole = pending(h, 'getConsoleLog')
    pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    const link = savedReportLink(h), child = h.child(), before = allRequestCounts(h)
    const event = anchorClick()
    await link.props.onClick(event); await settle()
    assert.equal(event.defaultPrevented, true)
    assert.equal(h.router.currentRoute.value.name, 'SavedReports')
    assert.equal(h.router.currentRoute.value.fullPath, '/reports?report_id=A')
    assert.deepEqual(h.router.currentRoute.value.query, { report_id: 'A' })
    assert.equal(child.isUnmounted, true)
    assert.ok(oldMetadata.signal.aborted && oldConsole.signal.aborted)
    assert.equal(h.intervals.size, 0)
    oldMetadata.resolve(replyFor('getReport', 'A'))
    oldConsole.resolve(ok({ from_line: 0, logs: ['retired console'] })); await settle()
    assert.equal(savedReportLink(h), undefined)
    assert.deepEqual(allRequestCounts(h), before)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})
