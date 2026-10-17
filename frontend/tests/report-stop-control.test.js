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

// Source-bound compiled-template harness above is identical to the route fixture.
// Controlled responses below qualify report ownership; no provider is contacted.
const fixture = (options = {}) => build({ runtime: 'manual', locale: 'en', ...options })
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const stop = h => control(h, 'stop-report')
const regenerate = h => control(h, 'generate-new-report')
const childState = h => h.child().setupState
const text = node => node ? (node.type === '#comment' ? '' : node.text || '') + (node.children || []).map(text).join(' ') : ''
const rendered = h => text(h.find(node => node.props?.class === 'report-panel'))
const action = node => { assert.equal(node?.type, 'button'); assert.equal(typeof node.props.onClick, 'function'); return node.props.onClick }
const observation = (id = 'A', overrides = {}) => ok({
  report_id: id, simulation_id: 'S' + id, task_id: 'T' + id,
  status: 'generating', progress: 25, cancellation_supported: true,
  cancellation_requested: false, worker_active: true, terminal_status: null, error: null, ...overrides,
})
const sectionResponse = (id = 'A', sections = []) => ok({ report_id: id, sections: sections.map(([section_index, content]) => ({ section_index, content })), total_sections: sections.length, is_complete: false })
async function tick(h, milliseconds = 2000) {
  for (const timer of [...h.intervals.values()]) if (timer.ms === milliseconds) timer.callback()
  await settle()
}
async function active(h, id = 'A') {
  pending(h, 'getReportProgress', id).resolve(observation(id)); await settle()
  pending(h, 'getReportSections', id).resolve(sectionResponse(id)); await settle()
}
async function retired(h, id = 'A', sections = []) {
  await tick(h)
  pending(h, 'getReportProgress', id).resolve(observation(id, { status: 'cancelled', cancellation_requested: true, worker_active: false, terminal_status: 'cancelled' })); await settle()
  pending(h, 'getReportSections', id).resolve(sectionResponse(id, sections)); await settle()
}
async function cancelAccepted(h) {
  action(stop(h))(); await settle()
  h.calls('cancelReport').at(-1).resolve(observation('A', { status: 'cancelling', cancellation_requested: true })); await settle()
}

// The native rendered handler must close over the owner visible when rendered.
// Cached @click member wrappers would read the newest handler and fail the ABA cases.
test('local report stop renders only after authoritative active local progress and coalesces same-turn clicks', async () => {
  const h = fixture()
  try {
    await h.mount(); assert.equal(stop(h), undefined)
    await active(h)
    const click = action(stop(h)), first = click(), second = click()
    assert.equal(first, second); await settle()
    assert.equal(h.calls('cancelReport').length, 1)
    assert.equal(h.calls('cancelReport')[0].args[0], 'A')
    assert.equal(stop(h).props.type, 'button')
    assert.equal(stop(h).props.disabled, true)
    assert.equal(stop(h).props['aria-busy'], true)
    assert.equal(h.calls('generateReport').length, 0)
    assert.equal(childState(h).isCancelled, false)
    click(); await settle(); assert.equal(h.calls('cancelReport').length, 1)
  } finally { h.close() }
})

for (const result of ['cloud', 'wrong-report', 'wrong-simulation', 'missing-worker', 'rejected', 'orphan']) {
  test(`local report stop rejects unsupported or unconfirmed eligibility: ${result}`, async () => {
    const h = fixture()
    try {
      await h.mount()
      const request = pending(h, 'getReportProgress')
      if (result === 'rejected') request.reject(new Error('unavailable'))
      else if (result === 'cloud') request.resolve(ok({ report_id: 'A', cancellation_supported: false }))
      else if (result === 'wrong-report') request.resolve(observation('B'))
      else if (result === 'wrong-simulation') request.resolve(observation('A', { simulation_id: 7 }))
      else if (result === 'orphan') request.resolve({ success: false, error_code: 'no_active_report_job', data: observation().data })
      else { const response = observation(); delete response.data.worker_active; request.resolve(response) }
      await settle()
      assert.equal(stop(h), undefined); assert.equal(regenerate(h), undefined)
      assert.equal(h.calls('cancelReport').length, 0); assert.equal(h.calls('generateReport').length, 0)
    } finally { h.close() }
  })
}

test('local report stop preserves cloud log completion and hides local controls', async () => {
  const h = build({ locale: 'en' })
  try {
    await h.mount(); pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    assert.equal(childState(h).isComplete, true)
    assert.ok(h.find(node => node.props?.class === 'next-step-btn'))
    assert.equal(stop(h), undefined); assert.equal(regenerate(h), undefined)
    assert.equal(h.calls('cancelReport').length, 0); assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('local report stop ignores completion logs until exact-ID worker retirement', async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h)
    pending(h, 'getAgentLog').resolve(complete('A')); await settle()
    assert.equal(childState(h).isComplete, false)
    assert.equal(h.find(node => node.props?.class === 'next-step-btn'), undefined)
    await tick(h)
    pending(h, 'getReportProgress').resolve(observation('A', { status: 'completed', worker_active: true, terminal_status: 'completed' })); await settle()
    assert.equal(childState(h).isComplete, false)
    assert.equal(regenerate(h), undefined)
    await tick(h)
    pending(h, 'getReportProgress').resolve(observation('A', { status: 'completed', worker_active: false, terminal_status: 'completed' })); await settle()
    assert.equal(childState(h).isComplete, true)
    assert.equal(h.state().currentStatus, 'completed')
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('local report stop retires pre-cancel reads, preserves committed files and never promotes diagnostic previews', async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h)
    pending(h, 'getAgentLog').resolve(ok({ from_line: 0, logs: [
      { action: 'planning_complete', timestamp: 'outline', details: { outline: { title: 'Report A', sections: [{ title: 'One' }, { title: 'Two' }] } } },
      { action: 'section_complete', timestamp: 'committed', section_index: 1, details: { content: 'Committed first section' } },
      { action: 'section_content', timestamp: 'preview', section_index: 2, details: { content: 'Uncommitted preview' } },
    ] })); await settle(); await tick(h)
    const oldLogs = pending(h, 'getAgentLog'), oldProgress = pending(h, 'getReportProgress')
    await cancelAccepted(h)
    assert.equal(oldLogs.signal.aborted, true); assert.equal(oldProgress.signal.aborted, true)
    oldLogs.resolve(ok({ from_line: 3, logs: [{ action: 'report_complete', timestamp: 'late', details: {} }, { action: 'section_complete', section_index: 2, timestamp: 'late section', details: { content: 'Late return' } }] }))
    oldProgress.resolve(observation('A', { status: 'completed', worker_active: false })); await settle()
    assert.equal(childState(h).isComplete, false)
    assert.equal(childState(h).generatedSections[1], 'Committed first section')
    assert.equal(childState(h).generatedSections[2], undefined)
    assert.ok(control(h, 'report-cancelling'))
    pending(h, 'getReportProgress').resolve(observation('A', { status: 'cancelled', cancellation_requested: true, worker_active: true })); await settle()
    assert.equal(childState(h).isCancelled, false); assert.equal(regenerate(h), undefined)
    await retired(h, 'A', [[1, 'Committed first section'], [2, 'File committed before log failed']])
    assert.equal(childState(h).isCancelled, true)
    assert.equal(childState(h).generatedSections[2], 'File committed before log failed')
    assert.match(rendered(h), /Partial report/)
    assert.equal(h.find(node => node.props?.class === 'next-step-btn'), undefined)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test(`local report stop before outline renders an empty terminal state (${locale})`, async () => {
  const h = fixture({ locale })
  try {
    await h.mount(); await active(h); await cancelAccepted(h)
    pending(h, 'getReportProgress').resolve(observation('A', { status: 'cancelling', cancellation_requested: true })); await settle()
    await retired(h)
    const empty = control(h, 'cancelled-empty-report')
    assert.ok(empty)
    assert.match(text(empty), locale === 'en' ? /Report cancelled.*No sections saved/ : /报告已取消.*没有已保存的章节/)
    assert.equal(h.find(node => node.props?.class === 'waiting-animation'), undefined)
    assert.equal(h.find(node => node.props?.class === 'workflow-empty'), undefined)
    assert.equal(h.find(node => node.props?.class === 'loading-state'), undefined)
    assert.match(rendered(h), locale === 'en' ? /Interviews already sent.*may still finish and save records/ : /已发送到模拟的访谈仍可能完成并保存记录/)
    assert.equal(regenerate(h).props.disabled, false)
    assert.equal(h.state().currentStatus, 'cancelled')
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('local report stop reload reconciles committed section files without log events', async () => {
  const h = fixture()
  try {
    await h.mount()
    pending(h, 'getReportProgress').resolve(observation('A', { status: 'cancelled', cancellation_requested: true, worker_active: false })); await settle()
    pending(h, 'getReportSections').resolve(sectionResponse('A', [[1, '**Retained on reload**']])); await settle()
    assert.equal(childState(h).generatedSections[1], '**Retained on reload**')
    assert.match(h.find(node => node.props?.class === 'generated-content').props.innerHTML, /Retained on reload/)
    assert.equal(childState(h).isComplete, false)
    assert.equal(stop(h), undefined); assert.ok(regenerate(h))
    assert.equal(h.calls('cancelReport').length, 0)
  } finally { h.close() }
})

for (const outcome of ['rejected', 'unsuccessful', 'wrong-identity']) test(`local report stop ${outcome} response stays unconfirmed and retries only by explicit click`, async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h)
    action(stop(h))(); await settle()
    const request = h.calls('cancelReport')[0]
    if (outcome === 'rejected') request.reject(new Error('lost response'))
    else request.resolve(outcome === 'unsuccessful' ? { success: false } : observation('B', { cancellation_requested: true, status: 'cancelling' }))
    await settle()
    assert.ok(control(h, 'cancel-unconfirmed'))
    assert.equal(childState(h).isCancelled, false); assert.equal(regenerate(h), undefined)
    pending(h, 'getReportProgress').resolve(observation()); await settle(); await tick(h)
    assert.equal(h.calls('cancelReport').length, 1)
    assert.equal(h.calls('generateReport').length, 0)
    action(stop(h))(); await settle()
    assert.equal(h.calls('cancelReport').length, 2)
    assert.deepEqual(h.calls('cancelReport').map(call => call.args[0]), ['A', 'A'])
  } finally { h.close() }
})

for (const status of ['completed', 'failed']) test(`local report stop respects a ${status} terminal winner`, async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); action(stop(h))(); await settle()
    h.calls('cancelReport')[0].resolve(observation('A', { status, worker_active: false, terminal_status: status })); await settle()
    assert.equal(childState(h).isCancelled, false)
    assert.equal(childState(h).isComplete, status === 'completed')
    assert.equal(h.state().currentStatus, status === 'completed' ? 'completed' : 'error')
    assert.equal(regenerate(h), undefined)
    assert.equal(h.calls('generateReport').length, 0)
  } finally { h.close() }
})

for (const result of ['success', 'rejection']) test(`local report stop captured A/B callbacks and old ${result} are inert after A to B to A`, async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); const oldA = action(stop(h)); oldA(); await settle()
    const oldRequest = h.calls('cancelReport')[0]
    await h.navigate('B'); await active(h, 'B'); const oldB = action(stop(h))
    await h.navigate('A'); await active(h); const current = action(stop(h))
    oldA(); oldB(); await settle()
    assert.equal(h.calls('cancelReport').length, 1, 'captured rendered actions must not retarget the current owner')
    current(); await settle(); assert.equal(h.calls('cancelReport').length, 2)
    if (result === 'success') oldRequest.resolve(observation('A', { status: 'cancelled', cancellation_requested: true, worker_active: false }))
    else oldRequest.reject(new Error('retired request'))
    await settle()
    assert.equal(oldRequest.signal.aborted, true)
    assert.equal(childState(h).isCancelled, false); assert.equal(stop(h).props.disabled, true)
    assert.equal(h.calls('generateReport').length, 0)
  } finally { h.close() }
})

test('local report stop stale progress and sections cannot overwrite a newer report or release its read slots', async () => {
  const h = fixture()
  try {
    await h.mount(); const oldProgress = pending(h, 'getReportProgress')
    await h.navigate('B'); await active(h, 'B'); await tick(h)
    const currentProgress = pending(h, 'getReportProgress', 'B')
    oldProgress.resolve(observation('A', { status: 'cancelled', worker_active: false, cancellation_requested: true })); await settle()
    assert.equal(childState(h).progressState.report_id, 'B')
    await tick(h); assert.equal(pending(h, 'getReportProgress', 'B'), currentProgress)
    currentProgress.resolve(observation('B')); await settle(); const oldSections = pending(h, 'getReportSections', 'B')
    await h.navigate('A'); await active(h)
    oldSections.resolve(sectionResponse('B', [[1, 'Stale B body']])); await settle()
    assert.equal(childState(h).generatedSections[1], undefined)
    assert.equal(h.calls('cancelReport').length, 0)
  } finally { h.close() }
})

test('local report stop navigation and unmount retire observation without cancelling generation', async () => {
  const h = fixture()
  await h.mount(); await active(h); const old = action(stop(h))
  await h.navigate('B'); await active(h, 'B'); const newer = action(stop(h))
  h.close(); old(); newer(); await settle()
  assert.equal(h.calls('cancelReport').length, 0)
  assert.equal(h.calls('generateReport').length, 0)
  assert.equal(h.intervals.size, 0)
})

test('local report stop pending cancellation cannot mutate after unmount', async () => {
  const h = fixture()
  await h.mount(); await active(h); const old = action(stop(h)); old(); await settle()
  const request = h.calls('cancelReport')[0]; h.close()
  const before = JSON.stringify(childState(h).progressState)
  old(); request.resolve(observation('A', { status: 'cancelled', cancellation_requested: true, worker_active: false })); await settle()
  assert.equal(JSON.stringify(childState(h).progressState), before)
  assert.equal(request.signal.aborted, true); assert.equal(h.calls('cancelReport').length, 1)
})

test('local report stop aborted departure renews exact rendered ownership without cancellation', async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); const old = action(stop(h))
    h.router.beforeEach(to => to.path === '/' ? false : undefined)
    await h.router.push('/'); await settle(); await active(h)
    const current = action(stop(h)); assert.notEqual(current, old)
    old(); await settle(); assert.equal(h.calls('cancelReport').length, 0)
    current(); await settle(); assert.equal(h.calls('cancelReport').length, 1)
  } finally { h.close() }
})

test('local report stop allows one new generation only after cleanup and accepts its ID before opening', async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); await retired(h)
    const click = action(regenerate(h)), first = click(), second = click()
    assert.equal(first, second); await settle()
    assert.equal(h.calls('generateReport').length, 1)
    const request = h.calls('generateReport')[0]
    assert.equal(request.args[0].simulation_id, 'SA'); assert.equal(request.args[0].force_regenerate, true)
    assert.equal(regenerate(h).props.disabled, true)
    let acceptedBeforeNavigation = false
    const remove = h.router.beforeEach(to => {
      if (to.params.reportId === 'B') { acceptedBeforeNavigation = childState(h).newReportId === 'B'; return false }
    })
    request.resolve(observation('B')); await settle()
    // A response for this request must match the originally selected simulation.
    assert.equal(childState(h).newReportId, null)
    assert.equal(h.router.currentRoute.value.params.reportId, 'A')
    const acceptedGeneration = action(regenerate(h))(); await settle()
    h.calls('generateReport')[1].resolve(ok({ report_id: 'B', simulation_id: 'SA', task_id: 'TB' })); await acceptedGeneration; await settle()
    assert.equal(acceptedBeforeNavigation, true)
    assert.equal(childState(h).newReportId, 'B')
    assert.equal(h.router.currentRoute.value.params.reportId, 'A')
    assert.equal(h.calls('generateReport').length, 2)
    remove(); await action(regenerate(h))(); await settle()
    assert.equal(h.router.currentRoute.value.params.reportId, 'B')
    assert.equal(h.calls('generateReport').length, 2, 'opening retry never repeats the accepted mutation')
  } finally { h.close() }
})

for (const outcome of ['lost', 'refused']) test(`local report stop new-generation ${outcome} response never retries or navigates automatically`, async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); await retired(h)
    action(regenerate(h))(); await settle(); const request = h.calls('generateReport')[0]
    if (outcome === 'lost') request.reject(new Error('lost acceptance'))
    else request.resolve({ success: false })
    await settle(); await tick(h)
    assert.equal(h.calls('generateReport').length, 1)
    assert.equal(h.router.currentRoute.value.params.reportId, 'A')
    assert.equal(regenerate(h).props.disabled, false)
    action(regenerate(h))(); await settle(); assert.equal(h.calls('generateReport').length, 2)
  } finally { h.close() }
})

for (const staleResponse of [false, true]) test(`local report stop captured new-generation actions remain inert after ABA (${staleResponse ? 'pending response' : 'idle action'})`, async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); await retired(h); const old = action(regenerate(h))
    if (staleResponse) { old(); await settle() }
    await h.navigate('B'); await active(h, 'B'); await retired(h, 'B'); const oldB = action(regenerate(h))
    await h.navigate('A'); await active(h); await retired(h)
    old(); oldB(); await settle(); assert.equal(h.calls('generateReport').length, staleResponse ? 1 : 0)
    if (staleResponse) {
      h.calls('generateReport')[0].resolve(ok({ report_id: 'obsolete-new', simulation_id: 'SA' })); await settle()
      assert.equal(h.router.currentRoute.value.params.reportId, 'A'); assert.equal(childState(h).newReportId, null)
    }
    action(regenerate(h))(); await settle()
    assert.equal(h.calls('generateReport').length, staleResponse ? 2 : 1)
  } finally { h.close() }
})

test('local report stop section read failure preserves displayed content and offers read-only reconciliation', async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h)
    childState(h).generatedSections = { 1: 'Committed' }
    await tick(h); pending(h, 'getReportProgress').resolve(observation('A', { status: 'cancelled', cancellation_requested: true, worker_active: false })); await settle()
    pending(h, 'getReportSections').reject(new Error('file read unavailable')); await settle()
    assert.ok(control(h, 'report-sections-unavailable'))
    assert.equal(childState(h).generatedSections[1], 'Committed')
    const button = control(h, 'report-sections-unavailable').children.find(node => node.type === 'button')
    action(button)(); await settle()
    pending(h, 'getReportSections').resolve(sectionResponse('A', [[1, 'Committed'], [2, 'Recovered file']])); await settle()
    assert.equal(childState(h).generatedSections[2], 'Recovered file')
    assert.equal(h.calls('cancelReport').length, 0); assert.equal(h.calls('generateReport').length, 0)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test(`local report stop limitation copy, acknowledged state and native accessibility are localized (${locale})`, async () => {
  // A 202 active acknowledgement and a 200 retired acknowledgement both remain
  // confirmed if the immediate, read-only progress reconciliation fails.
  for (const acknowledgedStatus of ['cancelling', 'cancelled']) {
    const h = fixture({ locale })
    try {
      await h.mount(); await active(h)
      assert.equal(text(stop(h)), translations[locale].step4.stopReport)
      const descriptionId = stop(h).props['aria-describedby']
      const description = h.find(node => node.props?.id === descriptionId)
      assert.equal(text(description), translations[locale].step4.stopNotice)
      assert.equal(stop(h).props.type, 'button'); assert.equal(stop(h).props['aria-busy'], false)
      action(stop(h))(); await settle()
      assert.equal(text(stop(h)), translations[locale].step4.requestingStop)
      assert.equal(stop(h).props.disabled, true); assert.equal(stop(h).props['aria-busy'], true)
      assert.equal(text(description), translations[locale].step4.stopNotice)

      const workerActive = acknowledgedStatus === 'cancelling'
      h.calls('cancelReport')[0].resolve(observation('A', { status: acknowledgedStatus,
        cancellation_requested: true, worker_active: workerActive,
        terminal_status: workerActive ? null : 'cancelled' })); await settle()
      assert.ok(control(h, 'report-' + acknowledgedStatus))
      pending(h, 'getReportProgress').reject(new Error('fresh progress read unavailable')); await settle()
      assert.ok(control(h, 'report-' + acknowledgedStatus))
      assert.equal(h.state().currentStatus, acknowledgedStatus)
      assert.equal(childState(h).isCancelled, !workerActive)
      assert.equal(childState(h).isComplete, false)
      assert.equal(control(h, 'cancel-unconfirmed'), undefined)
      const unavailable = control(h, 'report-progress-unavailable')
      assert.equal(unavailable.props.role, 'status')
      assert.equal(text(unavailable), locale === 'en'
        ? 'Report status is unavailable. Waiting for an authoritative update.'
        : '报告状态暂不可用，正在等待权威状态更新。')
      assert.doesNotMatch(rendered(h), /cancellation (?:is )?not confirmed|尚未确认取消/i)
      assert.equal(stop(h), undefined)
      assert.equal(!!regenerate(h), !workerActive)
      assert.equal(h.calls('cancelReport').length, 1)
      assert.equal(h.calls('generateReport').length, 0)
    } finally { h.close() }
  }
})

for (const terminal of ['completed', 'cancelled']) test(`local report stop progress-first ${terminal} reload restores saved outline without promoting metadata content`, async () => {
  const h = fixture()
  try {
    await h.mount(); const oldLog = pending(h, 'getAgentLog')
    pending(h, 'getReportProgress').resolve(observation('A', { status: terminal, worker_active: false,
      cancellation_requested: terminal === 'cancelled', terminal_status: terminal })); await settle()
    assert.equal(oldLog.signal.aborted, true)
    pending(h, 'getReportSections').resolve(sectionResponse('A', [[1, 'Only committed section body']])); await settle()
    const metadata = h.calls('getReport').at(-1)
    metadata.resolve(ok({ report_id: 'A', simulation_id: 'SA', status: terminal, outline: {
      title: 'Saved exact report title', summary: 'Saved exact report summary',
      sections: [{ title: 'Saved exact section heading', content: 'Untrusted metadata preview' }],
    } })); await settle()
    assert.equal(h.find(node => node.type === 'h1').text, 'Saved exact report title')
    assert.match(rendered(h), /Saved exact report summary/)
    assert.match(rendered(h), /Saved exact section heading/)
    assert.equal(childState(h).generatedSections[1], 'Only committed section body')
    assert.doesNotMatch(rendered(h), /Untrusted metadata preview/)
    assert.equal(childState(h).isComplete, terminal === 'completed')
    assert.equal(!!h.find(node => node.props?.class === 'next-step-btn'), terminal === 'completed')
    oldLog.resolve(complete('stale')); await settle()
    assert.equal(childState(h).isComplete, terminal === 'completed')
    assert.equal(h.find(node => node.type === 'h1').text, 'Saved exact report title')
  } finally { h.close() }
})

test('local report stop delayed saved outline cannot replace a new report header', async () => {
  const h = fixture()
  try {
    await h.mount(); await active(h); const old = h.calls('getReport').at(-1)
    await h.navigate('B'); await active(h, 'B')
    h.calls('getReport').at(-1).resolve(ok({ report_id: 'B', outline: { title: 'Current B', summary: 'B summary', sections: [] } })); await settle()
    old.resolve(ok({ report_id: 'A', outline: { title: 'Old A', summary: 'old', sections: [] } })); await settle()
    assert.equal(h.find(node => node.type === 'h1').text, 'Current B')
    assert.equal(old.signal.aborted, true)
  } finally { h.close() }
})

test('local report stop renders terminal persistence failure from authoritative progress', async () => {
  const h = fixture()
  try {
    await h.mount()
    pending(h, 'getReportProgress').resolve(observation('A', { status: 'cancelled', worker_active: false,
      cancellation_requested: true, error: 'Cancelled outcome could not be saved' })); await settle()
    assert.equal(text(control(h, 'report-persistence-error')), 'Cancelled outcome could not be saved')
    assert.equal(childState(h).isCancelled, true)
    assert.equal(childState(h).isComplete, false)
  } finally { h.close() }
})
