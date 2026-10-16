import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFileSync, existsSync } from 'node:fs'
import { createI18n } from 'vue-i18n'
import * as I18n from 'vue-i18n'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import * as PendingUpload from '../../src/store/pendingUpload.js'
import * as LocalCastPreset from '../../src/utils/localCastPreset.js'
import * as LoadedGraphFile from '../../src/utils/loadedGraphFile.js'
import * as GraphViewSvg from '../../src/utils/graphViewSvg.js'

export const graphView = 'views/MainView.vue'
export const graphChild = 'components/Step1GraphBuild.vue'
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
function renderer(historyDocument = null) {
  const node = (type, text = '') => {
    const value = { type, text, tagName: type.toUpperCase(), props: {},
    children: [], parent: null, style: {}, listeners: {},
    ...(historyDocument ? {
      ownerDocument: historyDocument,
      contains(target) { for (let current = target; current; current = current.parent) if (current === this) return true; return false },
      focus() { historyDocument.activeElement = this },
    } : {}),
    get isConnected() { if (!historyDocument) return undefined; let current = this; while (current.parent) current = current.parent; return current.type === 'root' || current === historyDocument.body },
    addEventListener(event, callback) { this.listeners[event] = callback },
    removeEventListener(event) { delete this.listeners[event] },
    setAttribute(key, value) { this.props[key] = value }, removeAttribute(key) { delete this.props[key] } }
    // Native DOM nodes preserve identity when assigned to Vue template refs.
    return historyDocument ? Vue.markRaw(value) : value
  }
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
    ...(historyDocument ? { querySelector: selector => selector === 'body' ? historyDocument.body : null } : {}),
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
  // Opt-in History host support leaves the established route fixtures unchanged.
  // Home, History and Teleport still use their real compiled templates/actions.
  const historyDocument = options.historyRoute ? {
    body: { type: 'body', children: [], parent: null }, activeElement: null,
    addEventListener() {}, removeEventListener() {},
  } : null
  const historyTimeouts = new Map()
  const downloads = options.downloads ?? [], revoked = options.revoked ?? [], objectUrls = new Map()
  const downloadHooks = options.downloadHooks ?? {}, anchors = []
  class DownloadBlob extends Blob {
    constructor(parts, options) { downloadHooks.blob?.(); super(parts, options) }
  }
  let nextObjectUrl = 0
  const fileUrl = {
    createObjectURL(blob) { downloadHooks.createObjectURL?.(); const url = 'blob:preset-fixture-' + (++nextObjectUrl); objectUrls.set(url, blob); return url },
    revokeObjectURL(url) { revoked.push(url); objectUrls.delete(url); downloadHooks.revokeObjectURL?.() },
  }
  const fileDocument = {
    body: { appendChild(anchor) { downloadHooks.append?.(); anchor.attached = true } },
    createElement(type) {
      assert.equal(type, 'a'); downloadHooks.anchor?.()
      const anchor = { href: '', download: '', attached: false,
        click() { downloadHooks.click?.(); downloads.push({ href: this.href, filename: this.download, blob: objectUrls.get(this.href) }) },
        remove() { this.attached = false },
      }
      anchors.push(anchor)
      return anchor
    },
  }
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
  const graph = { name: 'GraphBoundary', props: ['graphData', 'loading', 'currentPhase', 'isSimulating', 'graphDownload', 'graphViewDownload'],
    emits: ['refresh', 'toggle-maximize', 'graph-view-capture', 'graph-view-retired'], setup() {
      ;(instances.graph ??= []).push(Vue.getCurrentInstance())
      return () => Vue.h('graph-boundary')
    } }
  const modules = { vue: options.disableTransitions ? { ...Vue,
    Transition: { props: ['name', 'mode', 'onAfterLeave'], setup(_props, { slots }) { return () => slots.default?.() } },
    TransitionGroup: { props: ['name', 'mode'], setup(_props, { slots }) { return () => slots.default?.() } },
  } : Vue, 'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': options.locale ? I18n : { useI18n: () => ({ t: (key, params) => key + (params ? JSON.stringify(params) : ''), tm: () => [] }) } }
  const components = { '../components/GraphPanel.vue': graph }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Blob: DownloadBlob, File: options.fileConstructor ?? File, FormData, TextEncoder, alert: message => warnings.push(['alert', message]), URL: fileUrl, document: fileDocument, console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
      setInterval: (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id },
      clearInterval: id => intervals.delete(id) }
    if (options.historyRoute) Object.assign(globals, {
      setTimeout: (callback, ms) => { const id = nextTimer++; historyTimeouts.set(id, { callback, ms }); return id },
      clearTimeout: id => historyTimeouts.delete(id),
      IntersectionObserver: class { observe() {} disconnect() {} },
    })
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      const path = statement.source.value
      let dependency = modules[path] ?? (path.includes('/api/') ? api : null)
      if (path === '../store/pendingUpload' || path === '../store/pendingUpload.js') dependency = PendingUpload
      if (path === '../utils/localCastPreset') dependency = LocalCastPreset
      if (path === '../utils/loadedGraphFile.js') dependency = LoadedGraphFile
      if (path === '../utils/graphViewSvg.js') dependency = GraphViewSvg
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
      .replace('export function render', 'function render') + '\n;' + returnName, globals, {
      // The unchanged pre-fix Home dynamically imports the real pending store.
      // Node's supported VM import callback keeps baseline witnesses about Home
      // behavior rather than a missing VM loader (run with --experimental-vm-modules).
      importModuleDynamically(specifier) {
        assert.equal(specifier, '../store/pendingUpload.js')
        return import('../../src/store/pendingUpload.js')
      },
    })
  }
  function component(path) {
    const source = options.sources?.[path] ?? readFileSync(new URL('../../src/' + path, import.meta.url), 'utf8')
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
  if (options.historyRoute) {
    components['../components/HistoryDatabase.vue'] = component('components/HistoryDatabase.vue')
    components['../views/Home.vue'] = component('views/Home.vue')
  }
  if (options.graphRoute) {
    components['../components/Step1GraphBuild.vue'] = component(graphChild)
    components['../views/MainView.vue'] = component(graphView)
  }
  for (const path of options.extraViews ?? []) components['../' + path] = component(path)
  const router = evaluate(readFileSync(new URL('../../src/router/index.js', import.meta.url), 'utf8'))
  const appSource = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8')
  assert.equal(parse(appSource).descriptor.template.content.trim(), '<router-view />')
  const app = renderer(historyDocument).createApp({ render: () => Vue.h(Router.RouterView) })
  if (options.assertNoWarnings) app.config.warnHandler = message => warnings.push(['Vue warning', message])
  app.use(router)
  let i18n
  if (options.locale) {
    const messages = Object.fromEntries(['en', 'zh'].map(locale => [locale, JSON.parse(readFileSync(new URL('../../../locales/' + locale + '.json', import.meta.url), 'utf8'))]))
    i18n = createI18n({ legacy: false, locale: options.locale, fallbackLocale: 'en', messages })
    app.use(i18n)
  } else {
    app.config.globalProperties.$t = key => key
    app.config.globalProperties.$tm = () => []
  }
  // Observe the real navigation promise without replacing guard execution or
  // settlement semantics. Tests can await the exact automatic opening attempt.
  const pushes = []
  const push = router.push
  router.push = (...args) => {
    const promise = push(...args)
    pushes.push({ args, promise })
    return promise
  }
  const host = { type: 'root', children: [], parent: null }
  let mounted = false
  return { requests, instances, router, i18n, intervals, host, warnings, downloads, revoked, objectUrls, pushes, downloadHooks, anchors,
    state: path => instances[path].at(-1).setupState,
    child: path => instances[path].at(-1),
    graph: () => instances.graph.at(-1),
    calls: name => requests[name] ?? [],
    async mount(url) { await router.push(url); await router.isReady(); app.mount(host); mounted = true; await settle() },
    async navigate(url) { await router.push(url); await settle() },
    async tick(ms) { for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.callback(); await settle() },
    close() {
      if (mounted) { mounted = false; app.unmount() }
      if (options.assertNoWarnings) assert.deepEqual(warnings, [], 'selected route cases emit no application or Vue diagnostics')
    },
    find(predicate) {
      const visit = target => predicate(target) ? target : target.children?.map(visit).find(Boolean)
      return visit(host) || (historyDocument && visit(historyDocument.body)) || undefined
    },
  }
}
