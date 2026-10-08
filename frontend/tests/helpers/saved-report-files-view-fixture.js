import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import { createI18n, useI18n } from 'vue-i18n'
import { pathToFileURL } from 'node:url'
import * as savedReportComparison from '../../src/utils/savedReportComparison.js'
import * as savedReportSearch from '../../src/utils/savedReportSearch.js'

const sourceRoot = process.env.MIRO_REPORT_FILES_SOURCE_ROOT ? pathToFileURL(process.env.MIRO_REPORT_FILES_SOURCE_ROOT + '/frontend/') : new URL('../../', import.meta.url)
const sourceUrl = path => new URL(path, sourceRoot)
const reportFiles = existsSync(sourceUrl('src/utils/savedReportFiles.js')) ? await import(sourceUrl('src/utils/savedReportFiles.js')) : {}
const reportObservation = existsSync(sourceUrl('src/utils/savedReportObservation.js')) ? await import(sourceUrl('src/utils/savedReportObservation.js')) : {}

export const ok = data => ({ success: true, data })
export async function flush() {
  for (let i = 0; i < 20; i++) { await Promise.resolve(); await Vue.nextTick() }
}
export async function waitFor(predicate, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true within the bounded wait')
    await new Promise(resolve => setTimeout(resolve, 5))
    await flush()
  }
}
export function deferredApi() {
  const calls = { getSavedReports: [], getSavedReport: [] }
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, signal: args.at(-1), resolve, reject })
  })]))
  return { api, calls }
}

// The real Vue renderer mounts compiled scripts AND templates through the real
// application router. This host is deliberately not browser/visual validation.
function renderer(scrollCalls) {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null,
    listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback },
    scrollIntoView(options) { scrollCalls.push({ node: this, options }) } })
  const root = node('root'), body = node('body')
  const remove = child => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  }
  const insert = (child, parent, anchor = null) => {
    remove(child)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
    child.parent = parent
  }
  const host = Vue.createRenderer({
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
    querySelector: selector => selector === 'body' ? body : null,
  })
  return { host, root, body }
}

export async function mountReportFiles({ api, initialPath = '/report-files', locale = 'en', timers = fakeTimers(), deferredScrolls = null, onSearchIndex = null, cacheHandlers, downloadHooks = {} } = {}) {
  const requests = api ? null : deferredApi()
  api ??= requests.api
  const warnings = [], downloads = [], revokedUrls = [], scrollCalls = [], storageWrites = [], networkCalls = [], anchors = []
  const storage = { getItem: () => null, setItem: (...args) => storageWrites.push(args), removeItem: (...args) => storageWrites.push(args), clear: () => storageWrites.push(['clear']) }
  const blobs = new Map()
  let urlIndex = 0
  const urlApi = {
    createObjectURL(blob) { const url = `blob:report-files-${++urlIndex}`; downloadHooks.beforeCreate?.(blob); blobs.set(url, blob); downloadHooks.create?.(url, blob); return url },
    revokeObjectURL(url) { revokedUrls.push(url); blobs.delete(url); downloadHooks.revoke?.(url) },
  }
  const document = {
    createElement(type) {
      assert.equal(type, 'a')
      downloadHooks.beforeAnchor?.()
      const anchor = { attached: false, removed: false, click() { downloadHooks.click?.(this); downloads.push({ blob: blobs.get(this.href), filename: this.download, url: this.href }) }, remove() { this.attached = false; this.removed = true; downloadHooks.remove?.(this) } }; anchors.push(anchor); downloadHooks.anchor?.(anchor); return anchor
    },
    body: { appendChild(anchor) { anchor.attached = true; downloadHooks.append?.(anchor) } },
  }
  const { host, root, body } = renderer(scrollCalls)
  const stub = { render: () => Vue.h('fixture-boundary') }
  const passThrough = { setup: (_props, { slots }) => () => slots.default?.() }
  const modules = {
    vue: { ...Vue, Transition: passThrough,
      // Exercise the real nextTick callback with controllable late delivery.
      // The host only records scroll requests; it makes no layout assertion.
      nextTick: callback => Vue.nextTick(callback && (() => deferredScrolls ? deferredScrolls.push(callback) : callback())),
    },
    'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': { useI18n },
    '../utils/savedReportComparison.js': savedReportComparison,
    '../utils/savedReportObservation.js': reportObservation,
    '../utils/savedReportFiles.js': reportFiles,
    '../utils/savedReportSearch.js': { ...savedReportSearch,
      createReportSearchIndex: text => {
        const index = savedReportSearch.createReportSearchIndex(text)
        onSearchIndex?.(index)
        return index
      },
    },
  }
  const components = { '../components/LanguageSwitcher.vue': stub }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Date, Intl, console, Blob, TextEncoder, TextDecoder, URL: urlApi, document, localStorage: storage, sessionStorage: storage, indexedDB: { open: (...args) => { storageWrites.push(args); throw Error('Persistence forbidden') } }, fetch: (...args) => { networkCalls.push(args); throw Error('Network forbidden') },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      IntersectionObserver: class { observe() {} disconnect() {} } }
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      const path = statement.source.value
      const dependency = modules[path] ?? (path.includes('/api/') ? api : null)
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
    const { descriptor } = parse(readFileSync(sourceUrl('src/' + path), 'utf8'), { filename: path })
    const script = compileScript(descriptor, { id: path })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, transformAssetUrls: false,
      compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false, ...(cacheHandlers === undefined ? {} : { cacheHandlers }) } })
    assert.deepEqual(template.errors, [])
    const value = evaluate(script.content)
    value.render = evaluate(template.code, 'render')
    return value
  }
  components['../components/SavedReportComparison.vue'] = component('components/SavedReportComparison.vue')
  components['../components/SavedReportReader.vue'] = component('components/SavedReportReader.vue')
  components['../views/SavedReportsView.vue'] = component('views/SavedReportsView.vue')
  if (existsSync(sourceUrl('src/views/SavedReportFilesView.vue'))) components['../views/SavedReportFilesView.vue'] = component('views/SavedReportFilesView.vue')
  components['../views/Home.vue'] = component('views/Home.vue')
  const router = evaluate(readFileSync(sourceUrl('src/router/index.js'), 'utf8'))
  const messages = Object.fromEntries(['en', 'zh'].map(key => [key,
    JSON.parse(readFileSync(sourceUrl('../locales/' + key + '.json'), 'utf8'))]))
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages })
  const app = host.createApp({ render: () => Vue.h(Router.RouterView) })
  app.use(router); app.use(i18n)
  app.config.warnHandler = warning => warnings.push(warning)
  await router.push(initialPath); await router.isReady(); app.mount(root); await flush()
  const all = predicate => {
    const found = []
    const visit = target => { if (predicate(target)) found.push(target); target.children?.forEach(visit) }
    visit(root); visit(body); return found
  }
  const find = predicate => all(predicate)[0]
  const byId = id => find(node => node.props['data-testid'] === id)
  const text = (target = root) => (target.type === '#comment' ? '' : target.text ?? '') + (target.children ?? []).map(text).join(' ')
  return { root, body, router, i18n, warnings, requests, flush, waitFor, all, find, byId, text, downloads, revokedUrls, timers, scrollCalls, blobs, anchors, storageWrites, networkCalls, downloadHooks,
    async click(id) {
      const target = byId(id); assert.ok(target, `missing clickable control ${id}`)
      assert.ok(!target.props.disabled, `disabled control ${id}`)
      const handlers = [].concat(target.props.onClick ?? [])
      for (const handler of handlers) handler({ button: 0, stopPropagation() {}, preventDefault() {} })
      // A browser click on a submit button dispatches the form's submit event.
      if (target.type === 'button' && target.props.type === 'submit') {
        let form = target.parent
        while (form && form.type !== 'form') form = form.parent
        form?.props.onSubmit?.({ preventDefault() {} })
      }
      await flush()
    },
    async change(id, value) {
      const target = byId(id); assert.ok(target, `missing selection control ${id}`)
      await (target.props.onChange ?? target.props.onInput)({ target: { value, checked: value } }); await flush()
    },
    async input(id, value) {
      const target = byId(id); assert.ok(target, `missing input control ${id}`)
      target.props.onInput({ target: { value, checked: value } }); await flush()
    },
    async submit(id) {
      const target = byId(id); assert.ok(target, `missing form ${id}`)
      target.props.onSubmit({ preventDefault() {} }); await flush()
    },
    async navigate(path) { await router.push(path); await flush() },
    async back() { router.back(); await flush() },
    async forward() { router.forward(); await flush() },
    unmount() { app.unmount() },
  }
}

// Deterministic host clock; advancing a timer never settles a pending request.
export function fakeTimers() {
  let now = 0, nextId = 0
  const pending = new Map()
  return {
    pending,
    setTimeout(callback, delay) { const id = ++nextId; pending.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { pending.delete(id) },
    async advance(milliseconds) {
      const end = now + milliseconds
      while (true) {
        const entry = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        now = entry[1].at; pending.delete(entry[0]); entry[1].callback(); await flush()
      }
      now = end; await flush()
    },
  }
}

export function syntheticReport(id = 'report_A', content = 'Needle\r\nneedle 😀\n<script>literal</script>\n') {
  return { report_id: id, simulation_id: 'sim_A', title: 'Saved report', summary_preview: 'Summary', requirement_preview: 'Requirement', status: 'completed', created_at: 'recorded creation', completed_at: null, source: 'modern', metadata_revision: 'a'.repeat(64), observed_at: 'recorded observation', content_available: true, content_source: 'full_report.md', markdown_content: content, content_bytes: new TextEncoder().encode(content).length, content_revision: 'b'.repeat(64), content_error: null }
}
export function file(value, name = 'report.json', overrides = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify({ format: 'mirofish-saved-report-observation', version: 1, observation: value }) + '\n'
  const bytes = new TextEncoder().encode(text)
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer, ...overrides }
}
export async function chooseFile(view, chosen) {
  const input = view.byId('report-file'); assert.ok(input, 'The saved report file picker is missing')
  const target = { files: chosen === null ? [] : Array.isArray(chosen) ? chosen : [chosen], value: 'chosen.json' }
  const pending = input.props.onChange({ target }); await flush(); return { pending, target }
}
export async function previewFile(view, value, name) { const { pending } = await chooseFile(view, file(value, name)); await pending; await flush() }
export async function acceptFile(view, value, name) { await previewFile(view, value, name); await view.click('open-file') }
