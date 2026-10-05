import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createI18n } from 'vue-i18n'
import * as I18n from 'vue-i18n'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import * as LocalCastPreset from '../../src/utils/localCastPreset.js'

export const setupView = 'views/SimulationView.vue'
export const runView = 'views/SimulationRunView.vue'
export const setupChild = 'components/Step2EnvSetup.vue'
export const runChild = 'components/Step3Simulation.vue'
export const ok = data => ({ success: true, data })
export async function settle() {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); await Vue.nextTick() }
}

// Render actual compiled SFC scripts AND templates through the actual router.
// Only HTTP, timers, and unrelated view/graph/language boundaries are facades.
// A custom host avoids a browser dependency without replacing Vue's renderer.
function renderer() {
  const node = (type, text = '') => ({ type, text, tagName: type.toUpperCase(), props: {},
    children: [], parent: null, style: {}, addEventListener() {}, removeEventListener() {},
    setAttribute(key, value) { this.props[key] = value }, removeAttribute(key) { delete this.props[key] } })
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

export function build(options = {}) {
  const requests = {}, instances = {}, intervals = new Map(), warnings = []
  const downloads = options.downloads ?? [], revoked = options.revoked ?? [], objectUrls = new Map()
  let nextObjectUrl = 0
  const fileUrl = {
    createObjectURL(blob) { const url = 'blob:preset-fixture-' + (++nextObjectUrl); objectUrls.set(url, blob); return url },
    revokeObjectURL(url) { revoked.push(url); objectUrls.delete(url) },
  }
  const fileDocument = { createElement(type) {
    assert.equal(type, 'a')
    return { href: '', download: '', click() { downloads.push({ href: this.href, filename: this.download, blob: objectUrls.get(this.href) }) } }
  } }
  let nextTimer = 0 // Timer ID zero must be retired too.
  const api = new Proxy({}, { get(_target, name) {
    return (...args) => {
      if (options.api?.[name]) return options.api[name](...args)
      if (name === 'getPreparationPlan' && !options.manualPlan) return Promise.resolve(ok({ simulation_id: args[0], mode: 'cloud', limits: null }))
      return new Promise((resolve, reject) => {
      // Deliberately ignore cancellation: stale completion guards must work even
      // when a transport/server finishes after the observer has been aborted.
      const request = { args, settled: false,
        resolve(value) { request.settled = true; resolve(value) },
        reject(error) { request.settled = true; reject(error) },
        signal: args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined }
      ;(requests[name] ??= []).push(request)
    })
    }
  } })
  const stub = { render: () => Vue.h('fixture-boundary') }
  const graph = { name: 'GraphBoundary', props: ['graphData', 'loading', 'currentPhase', 'isSimulating'],
    emits: ['refresh', 'toggle-maximize'], setup() {
      ;(instances.graph ??= []).push(Vue.getCurrentInstance())
      return () => Vue.h('graph-boundary')
    } }
  const modules = { vue: options.disableTransitions ? { ...Vue,
    Transition: { props: ['name', 'mode'], setup(_props, { slots }) { return () => slots.default?.() } },
    TransitionGroup: { props: ['name', 'mode'], setup(_props, { slots }) { return () => slots.default?.() } },
  } : Vue, 'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': options.locale ? I18n : { useI18n: () => ({ t: (key, params) => key + (params ? JSON.stringify(params) : '') }) } }
  const components = { '../components/GraphPanel.vue': graph }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Blob, URL: fileUrl, document: fileDocument, console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
      setInterval: (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id },
      clearInterval: id => intervals.delete(id) }
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      const path = statement.source.value
      let dependency = modules[path] ?? (path.includes('/api/') ? api : null)
      if (path === '../utils/localCastPreset') dependency = LocalCastPreset
      if (path === '../utils/localRunPlan') {
        const utility = readFileSync(new URL('../../src/utils/localRunPlan.js', import.meta.url), 'utf8')
        const exports = [...utility.matchAll(/export (?:const|function) (\w+)/g)].map(match => match[1])
        dependency = vm.runInNewContext(utility.replace(/export /g, '') + '\n;({' + exports.join(',') + '})')
      }
      for (const item of statement.specifiers) {
        globals[item.local.name] = item.type === 'ImportDefaultSpecifier'
          ? components[path] ?? stub : dependency[item.imported.name]
      }
      source = source.slice(0, statement.start) + source.slice(statement.end)
    }
    return vm.runInNewContext(source.replace('export default', 'const component =')
      .replace('export function render', 'function render') + '\n;' + returnName, globals)
  }
  function component(path) {
    const source = readFileSync(new URL('../../src/' + path, import.meta.url), 'utf8')
    const { descriptor } = parse(source, { filename: path })
    const script = compileScript(descriptor, { id: path })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path,
      compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const value = evaluate(script.content)
    value.render = evaluate(template.code, 'render')
    const setup = value.setup
    value.setup = (props, context) => {
      ;(instances[path] ??= []).push(Vue.getCurrentInstance())
      return setup(props, context)
    }
    return value
  }
  if (existsSync(new URL('../../src/components/LocalCastPresetPanel.vue', import.meta.url))) {
    components['./LocalCastPresetPanel.vue'] = component('components/LocalCastPresetPanel.vue')
  }
  if (existsSync(new URL('../../src/components/LocalRunPlanner.vue', import.meta.url))) {
    components['./LocalRunPlanner.vue'] = component('components/LocalRunPlanner.vue')
  }
  components['../components/Step2EnvSetup.vue'] = component(setupChild)
  components['../components/Step3Simulation.vue'] = component(runChild)
  components['../views/SimulationView.vue'] = component(setupView)
  components['../views/SimulationRunView.vue'] = component(runView)
  const router = evaluate(readFileSync(new URL('../../src/router/index.js', import.meta.url), 'utf8'))
  const appSource = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8')
  assert.equal(parse(appSource).descriptor.template.content.trim(), '<router-view />')
  const app = renderer().createApp({ render: () => Vue.h(Router.RouterView) })
  app.use(router)
  if (options.locale) {
    const messages = Object.fromEntries(['en', 'zh'].map(locale => [locale, JSON.parse(readFileSync(new URL('../../../locales/' + locale + '.json', import.meta.url), 'utf8'))]))
    app.use(createI18n({ legacy: false, locale: options.locale, fallbackLocale: 'en', messages }))
  } else {
    app.config.globalProperties.$t = key => key
    app.config.globalProperties.$tm = () => []
  }
  const host = { type: 'root', children: [], parent: null }
  let mounted = false
  return { requests, instances, router, intervals, host, warnings, downloads, revoked, objectUrls,
    state: path => instances[path].at(-1).setupState,
    child: path => instances[path].at(-1),
    graph: () => instances.graph.at(-1),
    calls: name => requests[name] ?? [],
    async mount(url) { await router.push(url); await router.isReady(); app.mount(host); mounted = true; await settle() },
    async navigate(url) { await router.push(url); await settle() },
    async tick(ms) { for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.callback(); await settle() },
    close() { if (mounted) { mounted = false; app.unmount() } },
    find(predicate) {
      const visit = target => predicate(target) ? target : target.children?.map(visit).find(Boolean)
      return visit(host)
    },
  }
}
