import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import * as I18n from 'vue-i18n'

export const ok = data => ({ success: true, data })
export async function settle() {
  for (let i = 0; i < 14; i++) { await Promise.resolve(); await Vue.nextTick() }
}
export const textContent = node => [node.text ?? '', ...(node.children ?? []).filter(child => child.type !== '#comment').map(textContent)].join(' ')

// Actual compiled Step1/Step3 templates, Vue renderer, and application's router.
// The graph-building parent supplies controlled props; HTTP and timers are
// deferred boundaries. This is not a native-browser layout/interaction test.
export function build({ locale = 'en', api: overrides = {} } = {}) {
  const requests = {}, instances = {}, intervals = new Map(), warnings = [], alerts = [], logs = []
  let nextTimer = 0
  const sourceProps = Vue.reactive({ currentPhase: 2, projectData: null })
  const api = new Proxy({}, { get(_target, name) {
    return (...args) => {
      if (overrides[name]) return overrides[name](...args)
      return new Promise((resolve, reject) => {
      const request = { args, settled: false, signal: args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined,
        resolve(data) { request.settled = true; resolve(data) },
        reject(error) { request.settled = true; reject(error) } }
      ;(requests[name] ??= []).push(request)
      })
    }
  } })
  const stub = { render: () => Vue.h('fixture-boundary') }
  const modules = { vue: { ...Vue, TransitionGroup: { props: ['name'], setup(_p, { slots }) { return () => slots.default?.() } } },
    'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory }, 'vue-i18n': I18n }
  const components = {}
  function evaluate(source, name = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
      alert: message => alerts.push(message), setInterval: (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id },
      clearInterval: id => intervals.delete(id) }
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      const path = statement.source.value
      const dependency = modules[path] ?? (path.includes('/api/') ? api : null)
      for (const item of statement.specifiers) globals[item.local.name] = item.type === 'ImportDefaultSpecifier'
        ? components[path] ?? stub : dependency[item.imported.name]
      source = source.slice(0, statement.start) + source.slice(statement.end)
    }
    return vm.runInNewContext(source.replace('export default', 'const component =').replace('export function render', 'function render') + '\n;' + name, globals)
  }
  function component(filename) {
    const { descriptor } = parse(readFileSync(new URL('../../src/components/' + filename, import.meta.url), 'utf8'), { filename })
    const script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({ source: descriptor.template.content, filename, id: filename,
      compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const component = evaluate(script.content)
    component.render = evaluate(template.code, 'render')
    const setup = component.setup
    component.setup = (props, context) => { instances[filename] = Vue.getCurrentInstance(); return setup(props, context) }
    return component
  }
  const step1 = component('Step1GraphBuild.vue'), step3 = component('Step3Simulation.vue')
  components['../views/MainView.vue'] = { props: ['projectId'], setup(props) {
    return () => Vue.h(step1, { ...sourceProps, projectData: sourceProps.projectData ?? { project_id: props.projectId, graph_id: 'G' + props.projectId }, systemLogs: [] })
  } }
  components['../views/SimulationRunView.vue'] = { props: ['simulationId'], setup(props) {
    return () => Vue.h(step3, { simulationId: props.simulationId, maxRounds: 7, minutesPerRound: 30, systemLogs: [], onAddLog: message => logs.push(message) })
  } }
  const router = evaluate(readFileSync(new URL('../../src/router/index.js', import.meta.url), 'utf8'))
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, style: {},
    addEventListener() {}, removeEventListener() {} })
  const remove = child => { if (child.parent) { const i = child.parent.children.indexOf(child); if (i >= 0) child.parent.children.splice(i, 1); child.parent = null } }
  const insert = (child, parent, anchor) => { remove(child); const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child); child.parent = parent }
  const renderer = Vue.createRenderer({ createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text), insert, remove,
    insertStaticContent(text, parent, anchor) { const child = node('#static', text); insert(child, parent, anchor); return [child, child] },
    setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    patchProp: (target, key, _old, value) => { target.props[key] = value } })
  const app = renderer.createApp({ render: () => Vue.h(Router.RouterView) })
  app.use(router)
  const messages = Object.fromEntries(['en', 'zh'].map(locale => [locale, JSON.parse(readFileSync(new URL('../../../locales/' + locale + '.json', import.meta.url), 'utf8'))]))
  app.use(I18n.createI18n({ legacy: false, locale, fallbackLocale: 'en', messages }))
  const host = node('root')
  let mounted = false
  const find = predicate => { const visit = target => predicate(target) ? target : target.children?.map(visit).find(Boolean); return visit(host) }
  return { sourceProps, router, host, intervals, warnings, alerts, logs, instances,
    find, control: id => find(node => node.props?.['data-testid'] === id), text: () => textContent(host),
    state: name => instances[name].setupState, calls: name => requests[name] ?? [],
    pending: name => (requests[name] ?? []).findLast(call => !call.settled && !call.signal?.aborted),
    async mount(path = '/process/A') { await router.push(path); await router.isReady(); app.mount(host); mounted = true; await settle() },
    async navigate(path) { await router.push(path); await settle() },
    async tick(ms) { for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.callback(); await settle() },
    close() { if (mounted) { mounted = false; app.unmount() } },
  }
}
