import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { webcrypto } from 'node:crypto'
import axios from 'axios'
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

export async function mountTrials({ api, initialPath = '/prompt-trials', locale = 'en', timers = fakeTimers() } = {}) {
  const requests = deferredTrials()
  api = { ...trialApi(), ...requests.api, ...api }
  const warnings = [], downloads = [], revokedUrls = []
  const blobs = new Map()
  let urlIndex = 0
  const urlApi = {
    createObjectURL(blob) { const url = `blob:prompt-trial-${++urlIndex}`; blobs.set(url, blob); return url },
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
    const globals = { crypto: webcrypto, TextEncoder, AbortController, Date, Intl, console, Blob, URL: urlApi, document,
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
  components['../views/PromptTrialsView.vue'] = component('views/PromptTrialsView.vue')
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

export const runId = '12345678-1234-4234-9234-123456789abc'
export const nextRunId = '12345678-1234-4234-9234-123456789abd'
export const trialRequest = () => ({ label: 'Trial one', system_prompt: '', user_prompt: 'Hello', temperature: 0.2, max_output_tokens: 128 })
export function trialSnapshot(state = null, overrides = {}) {
  return {
    schema_version: 1, kind: 'mirofish_local_prompt_trials', observed_at: '2026-10-03T13:00:00Z',
    mode: 'local', available: true, unavailable_code: null,
    limits: { max_body_bytes: 32768, label_chars: 80, system_prompt_chars: 1000, user_prompt_chars: 4000,
      max_output_tokens: 512, response_bytes: 65536, retained_output_chars: 16384, gateway_startup_ms: 5000,
      request_ms: 60000, overall_ms: 65000, cleanup_ms: 10000 },
    run: state === null ? null : {
      request_id: runId, fingerprint: 'a'.repeat(64), state,
      started_at: '2026-10-03T12:59:59Z', finished_at: state === 'running' ? null : '2026-10-03T13:00:00Z',
      elapsed_ms: 1000, request_duration_ms: state === 'running' ? null : 750,
      request: trialRequest(), configuration: { model: 'local-chat', reasoning_effort: null },
      response: state === 'running' ? null : { content: 'Hello back', refusal: null, finish_reason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      error_code: null, cleanup: { state: state === 'running' ? 'pending' : 'succeeded', duration_ms: state === 'running' ? null : 5 },
    }, ...overrides,
  }
}
export function deferredTrials() {
  const calls = { getPromptTrials: [], getPromptTrial: [], startPromptTrial: [] }
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, signal: args.at(-1), resolve, reject })
  })]))
  return { calls, api }
}
// Execute the actual dedicated Axios module. Synthetic loopback tests may set a
// transport base URL; browser production keeps its deliberately empty base URL.
export function trialApi({ baseURL, logger = console } = {}) {
  const source = readFileSync(new URL('../../src/api/promptTrials.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
  return new Function('axios', 'console', 'baseURL', source + `
    if (baseURL) { service.defaults.baseURL = baseURL; service.defaults.proxy = false; service.defaults.maxRedirects = 0; }
    return { getPromptTrials, getPromptTrial, startPromptTrial, acceptPromptTrialSnapshot,
      acceptPromptTrialRequest, samePromptTrialRequest, isPromptTrialTerminal, service };
  `)(axios, logger, baseURL)
}
