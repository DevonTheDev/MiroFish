import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import { createI18n, useI18n } from 'vue-i18n'

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
  const calls = { getRuntimeStatus: [] }
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

export async function mountRuntime({ api, initialPath = '/runtime', locale = 'en', timers = fakeTimers(), includeReadiness = false } = {}) {
  const requests = api ? null : deferredApi()
  api = { ...runtimeApi(), ...(api ?? requests.api) }
  const warnings = [], downloads = [], revokedUrls = []
  const blobs = new Map()
  let urlIndex = 0
  const urlApi = {
    createObjectURL(blob) { const url = `blob:runtime-${++urlIndex}`; blobs.set(url, blob); return url },
    revokeObjectURL(url) { revokedUrls.push(url); blobs.delete(url) },
  }
  const document = {
    createElement(type) {
      assert.equal(type, 'a')
      return { click() { downloads.push({ blob: blobs.get(this.href), filename: this.download, url: this.href }) }, remove() {} }
    },
    body: { appendChild() {} },
  }
  const { host, root, body } = renderer()
  const stub = { render: () => Vue.h('fixture-boundary') }
  const passThrough = { setup: (_props, { slots }) => () => slots.default?.() }
  const modules = {
    vue: { ...Vue, Transition: passThrough },
    'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': { useI18n },
  }
  const components = { '../components/LanguageSwitcher.vue': stub }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Date, Intl, console, Blob, URL: urlApi, document,
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
      compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } })
    assert.deepEqual(template.errors, [])
    const value = evaluate(script.content)
    value.render = evaluate(template.code, 'render')
    return value
  }
  if (includeReadiness && existsSync(new URL('../../src/components/LocalReadinessPanel.vue', import.meta.url))) {
    components['../components/LocalReadinessPanel.vue'] = component('components/LocalReadinessPanel.vue')
  }
  components['../views/RuntimeStatusView.vue'] = component('views/RuntimeStatusView.vue')
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
  return { root, body, router, i18n, warnings, requests, flush, waitFor, all, find, byId, text, downloads, revokedUrls, timers,
    async click(id) {
      const target = byId(id); assert.ok(target, `missing clickable control ${id}`)
      assert.ok(!target.props.disabled, `disabled control ${id}`)
      const handlers = [].concat(target.props.onClick ?? [])
      for (const handler of handlers) handler({ button: 0, stopPropagation() {}, preventDefault() {} })
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

// Real production projection and GET wrapper, with only the HTTP boundary supplied.
export function runtimeApi(service = { get() { throw new Error('unexpected HTTP request') } }) {
  const source = readFileSync(new URL('../../src/api/runtime.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
  return new Function('service', source + '\nreturn { getRuntimeStatus, acceptRuntimeSnapshot };')(service)
}

export function runtimeSnapshot(overrides = {}) {
  return {
    schema_version: 1, kind: 'mirofish_local_runtime_status',
    observed_at: '2026-10-03T13:00:00+00:00', mode: 'local',
    configuration: { valid: true, issues: [], chat_model: 'local-chat', embedding_model: 'local-embedding',
      chat_endpoint: 'http://127.0.0.1:11434/v1', embedding_endpoint: 'http://127.0.0.1:11434/v1',
      graph_endpoint: 'bolt://127.0.0.1:7687', embedding_dimensions: 768, context_tokens: 8192,
      max_agents: 12, max_rounds: 10, max_agent_iterations: 3, reasoning_effort: null,
      gateway_limits: { max_concurrency: 2, max_queue: 6, request_timeout: 180, max_output_tokens: 2048, max_input_chars: 32000 } },
    gateway: { state: 'running', instance_id: '12345678-1234-1234-1234-123456789abc',
      started_at: '2026-10-03T12:00:00+00:00', uptime_seconds: 3600.5,
      limits: { max_concurrency: 1, max_queue: 4, request_timeout: 120, max_output_tokens: 1024, max_input_chars: 16000 },
      metrics: { admitted_connections: 2, rejected_connections: 5, queued_requests: 1, active_requests: 1,
        started_requests: 12, succeeded_requests: 6, failed_requests: 2, timed_out_requests: 1, cancelled_requests: 1 } },
    ...overrides,
  }
}
