import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import { createI18n, useI18n } from 'vue-i18n'
import * as savedInterviewQuestions from '../../src/utils/savedInterviewQuestions.js'

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
  const calls = { getSavedInterviews: [], getSimulationHistory: [] }
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, signal: args.at(-1), resolve, reject })
  })]))
  return { api, calls }
}

// The real Vue renderer mounts compiled scripts AND templates through the real
// application router. This host is deliberately not browser/visual validation.
function renderer() {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
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

export async function mountSavedInterviews({ api, initialPath = '/simulation/sim_A/interviews', locale = 'en', downloadHooks = {} } = {}) {
  const requests = api ? null : deferredApi()
  api ??= requests.api
  const warnings = [], downloads = [], revokedUrls = [], anchors = []
  const blobs = new Map()
  let urlIndex = 0
  const urlApi = {
    createObjectURL(blob) { downloadHooks.url?.(); const url = `blob:saved-interviews-${++urlIndex}`; blobs.set(url, blob); return url },
    revokeObjectURL(url) { revokedUrls.push(url); blobs.delete(url) },
  }
  const document = {
    createElement(type) {
      assert.equal(type, 'a')
      downloadHooks.element?.()
      const anchor = { attached: false, click() { downloadHooks.click?.(); downloads.push({ blob: blobs.get(this.href), filename: this.download, url: this.href }) }, remove() { this.attached = false; downloadHooks.remove?.() } }
      anchors.push(anchor); return anchor
    },
    body: { appendChild(anchor) { anchor.attached = true; downloadHooks.append?.() } },
  }
  const { host, root, body } = renderer()
  const stub = { render: () => Vue.h('fixture-boundary') }
  const passThrough = { setup: (_props, { slots }) => () => slots.default?.() }
  const modules = {
    vue: { ...Vue, Transition: passThrough },
    'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': { useI18n },
    '../utils/savedInterviewQuestions': savedInterviewQuestions,
  }
  const components = { '../components/LanguageSwitcher.vue': stub }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Date, Intl, console, Blob: class extends Blob { constructor(...args) { super(...args); downloadHooks.blob?.() } }, URL: urlApi, document,
      setTimeout: () => 0, clearTimeout() {},
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
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path,
      compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } })
    assert.deepEqual(template.errors, [])
    const value = evaluate(script.content)
    value.render = evaluate(template.code, 'render')
    return value
  }
  if (existsSync(new URL('../../src/views/SavedInterviewsView.vue', import.meta.url))) components['../views/SavedInterviewsView.vue'] = component('views/SavedInterviewsView.vue')
  const history = component('components/HistoryDatabase.vue')
  components['../views/Home.vue'] = { render: () => Vue.h(history) }
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
  return { root, body, router, i18n, warnings, requests, flush, waitFor, all, find, byId, text, downloads, revokedUrls, anchors,
    async click(id) {
      const target = byId(id); assert.ok(target, `missing clickable control ${id}`)
      assert.ok(!target.props.disabled, `disabled control ${id}`)
      target.props.onClick({ stopPropagation() {}, preventDefault() {} }); await flush()
    },
    async change(id, value) {
      const target = byId(id); assert.ok(target, `missing selection control ${id}`)
      await (target.props.onChange ?? target.props.onInput)({ target: { value } }); await flush()
    },
    async input(id, value) {
      const target = byId(id); assert.ok(target, `missing input control ${id}`)
      target.props.onInput({ target: { value } }); await flush()
    },
    async submit(id) {
      const target = byId(id); assert.ok(target, `missing form ${id}`)
      target.props.onSubmit({ preventDefault() {} }); await flush()
    },
    async navigate(path) { await router.push(path); await flush() },
    async back() { router.back(); await flush() },
    async forward() { router.forward(); await flush() },
    unmount() { if (root.children.length) app.unmount() },
  }
}

export const limits = { rows_per_platform: 100, rows_total: 200, database_bytes: 167772160, wal_bytes: 67108864, vm_operations_per_platform: 2000000, lock_timeout_seconds: 0.25, payload_bytes: 16384, timestamp_bytes: 256, response_bytes: 4194304 }
export const record = (platform = 'twitter', row_id = '1', overrides = {}) => ({ platform, row_id, record_id: `${platform}:${row_id}`, agent_id: '0', timestamp: '2026-10-06T09:00:00Z', prompt: 'Saved prompt', response: `${platform} saved reply`, payload_kind: 'structured', raw_preview: null, payload_bytes: 80, truncated: false, warnings: [], ...overrides })
export const source = (overrides = {}) => ({ status: 'available', returned_count: 0, has_more: false, coverage: 'complete', warnings: [], ...overrides })
export function observation(overrides = {}) {
  const records = overrides.records ?? [record('twitter'), record('reddit')]
  const filters = overrides.filters ?? { platform: null, agent_id: null }
  const sources = overrides.sources ?? Object.fromEntries(['twitter', 'reddit'].map(platform => [platform, filters.platform && filters.platform !== platform ? source({ status: 'not_requested', has_more: null, coverage: 'not_requested' }) : source({ returned_count: records.filter(row => row.platform === platform).length, ...(records.some(row => row.platform === platform && row.warnings.length) ? { coverage: 'partial', warnings: ['record_warnings'] } : {}) })]))
  const requested = Object.values(sources).filter(item => item.status !== 'not_requested')
  const availability = requested.every(item => item.coverage === 'complete') ? 'complete' : requested.some(item => ['complete', 'partial'].includes(item.coverage)) ? 'partial' : 'unavailable'
  return { version: 1, simulation_id: 'sim_A', filters, observed_at: '2026-10-06T09:00:00Z', order: 'platform_then_row_desc', limits: { ...limits, response_bytes_per_platform: filters.platform === null ? 2093056 : 4186112 }, availability, sources, records, ...overrides }
}
export async function setup(t, initialPath = '/simulation/sim_A/interviews', locale = 'en') {
  const d = deferredApi(), h = await mountSavedInterviews({ api: d.api, initialPath, locale })
  t.after(() => h.unmount()); return { ...d, h }
}
export async function resolve(call, data = observation()) { assert.ok(call, 'Saved interviews request must exist'); call.resolve(ok(data)); await flush() }
