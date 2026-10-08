import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import { createI18n, useI18n } from 'vue-i18n'
import * as activityFiles from '../../src/utils/savedActivityFiles.js'

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
  const calls = { getSavedActivity: [], getSavedActivityRounds: [], getSimulationHistory: [] }
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, signal: args.at(-1), resolve, reject })
  })]))
  return { api, calls }
}

// The real Vue renderer mounts compiled scripts AND templates through the real
// application router. This host is deliberately not browser/visual validation.
function renderer() {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null,
    listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback } })
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

export async function mountActivityFiles({ api, initialPath = '/activity-files', locale = 'en', timers = fakeTimers(), crypto = globalThis.crypto, cacheHandlers, failDownload = false } = {}) {
  const requests = api ? null : deferredApi()
  api ??= requests.api
  const warnings = [], downloads = [], revokedUrls = [], storageWrites = [], networkCalls = []
  const storage = { getItem: () => null, setItem: (...args) => storageWrites.push(['setItem', ...args]), removeItem: (...args) => storageWrites.push(['removeItem', ...args]), clear: () => storageWrites.push(['clear']) }
  const blobs = new Map()
  let urlIndex = 0
  const urlApi = {
    createObjectURL(blob) { if (failDownload === true || failDownload === 'create') throw new Error('private download failure'); const url = `blob:activity-files-${++urlIndex}`; blobs.set(url, blob); return url },
    revokeObjectURL(url) { revokedUrls.push(url); blobs.delete(url) },
  }
  const document = {
    createElement(type) {
      assert.equal(type, 'a')
      return { click() { if (failDownload === 'click') throw new Error('private click failure'); downloads.push({ blob: blobs.get(this.href), filename: this.download, url: this.href }) }, remove() {} }
    },
    body: { appendChild() { if (failDownload === 'append') throw new Error('private append failure') } },
  }
  const { host, root, body } = renderer()
  const stub = { render: () => Vue.h('fixture-boundary') }
  const passThrough = { inheritAttrs: false, setup: (_props, { slots }) => () => slots.default?.() }
  const modules = {
    vue: { ...Vue, Transition: passThrough },
    'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': { useI18n },
    '../utils/savedActivityFiles.js': activityFiles,
  }
  const components = { '../components/LanguageSwitcher.vue': stub }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Date, Intl, console, Blob, URL: urlApi, document, crypto, TextEncoder, TextDecoder, localStorage: storage, sessionStorage: storage, indexedDB: { open: (...args) => { storageWrites.push(['indexedDB.open', ...args]); throw new Error('Persistence forbidden') } }, fetch: (...args) => { networkCalls.push(args); throw new Error('Network forbidden') },
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
    const { descriptor } = parse(readFileSync(new URL('../../src/' + path, import.meta.url), 'utf8'), { filename: path })
    const script = compileScript(descriptor, { id: path })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, transformAssetUrls: false,
      compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false, ...(cacheHandlers === undefined ? {} : { cacheHandlers }) } })
    assert.deepEqual(template.errors, [])
    const value = evaluate(script.content)
    value.render = evaluate(template.code, 'render')
    return value
  }
  components['../views/SavedActivityView.vue'] = component('views/SavedActivityView.vue')
  components['../views/SavedActivityFilesView.vue'] = component('views/SavedActivityFilesView.vue')
  components['../components/HistoryDatabase.vue'] = component('components/HistoryDatabase.vue')
  components['../views/Home.vue'] = component('views/Home.vue')
  const router = evaluate(readFileSync(new URL('../../src/router/index.js', import.meta.url), 'utf8'))
  const messages = Object.fromEntries(['en', 'zh'].map(key => [key,
    JSON.parse(readFileSync(new URL('../../../locales/' + key + '.json', import.meta.url), 'utf8'))]))
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
  return { root, body, router, i18n, warnings, requests, flush, waitFor, all, find, byId, text, downloads, revokedUrls, timers, storageWrites, networkCalls, blobs,
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

export function syntheticActivityPage(simulationId = 'sim_file_A') {
  return {
    format_version: 1, simulation_id: simulationId,
    source_revision: 'a'.repeat(64), observed_at: '2026-10-08T01:02:03.123456+00:00',
    context: { status: 'completed', created_at: null, updated_at: null, started_at: null, completed_at: null, requested_rounds: '3', last_saved_round: '3' },
    availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'complete' }, warnings: [],
    filters: { platform: null, agent_id: null, round_num: null, action_type: null, q: null, case_sensitive: false, outcome: null },
    order: 'source_record', offset: 1, limit: 1, returned_count: 1, matched_count: 3, has_more: true,
    actions: [{ record_id: 'twitter:2', platform: 'twitter', agent_id: '9007199254740993', round_num: '1', agent_name: null, timestamp: null,
      action_type: 'CREATE_POST', success: false, match_preview: null,
      details_json: '{"action_args":{"text":"Original literal <tag> action 1"},"action_type":"CREATE_POST","agent_id":9007199254740993,"round":1,"success":false}' }],
  }
}
export function file(value, name = 'saved-activity.json', extra = {}) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  return { name, size: bytes.byteLength, type: 'application/json', arrayBuffer: async () => bytes.buffer, ...extra }
}
export async function chooseFile(view, files) {
  const target = { files: files == null ? [] : Array.isArray(files) ? files : [files], value: 'chosen.json' }
  const input = view.byId('activity-file')
  assert.ok(input, 'The saved activity file picker is missing')
  const pending = input.props.onChange({ target }); await flush()
  assert.equal(target.value, '')
  return { pending }
}
export async function previewFile(view, value, name) {
  const { pending } = await chooseFile(view, file(value, name)); await pending; await flush()
}
export async function acceptFile(view, value, name) {
  await previewFile(view, value, name); await view.click('open-file')
}
