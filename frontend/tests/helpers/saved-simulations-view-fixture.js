import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import { createI18n, useI18n } from 'vue-i18n'
import * as PendingUpload from '../../src/store/pendingUpload.js'

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
  const calls = { getComparisonCandidates: [], getSimulationHistory: [] }
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, signal: args.at(-1), resolve, reject })
  })]))
  return { api: new Proxy(api, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `Forbidden API/model call: ${String(key)}`)
    return target[key]
  } }), calls }
}

// The real Vue renderer mounts compiled scripts AND templates through the real
// application router. This host is deliberately not browser/visual validation.
function renderer(focusContract = false) {
  const focusCalls = [], listenerLog = [], leaves = [], documentListeners = new Map()
  const document = {
    activeElement: null,
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set())
      documentListeners.get(type).add(callback); listenerLog.push({ action: 'add', type, callback })
    },
    removeEventListener(type, callback) {
      documentListeners.get(type)?.delete(callback); listenerLog.push({ action: 'remove', type, callback })
    },
    dispatchFocus(target) {
      document.activeElement = target
      for (const callback of [...(documentListeners.get('focusin') ?? [])]) callback({ target })
    },
  }
  const node = (type, text = '') => {
    const value = { type, text, props: {}, children: [], parent: null,
      listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback },
      get isConnected() {
        let current = this
        while (current.parent) current = current.parent
        return current.type === 'root' || current.type === 'body'
      },
      contains(target) { for (let current = target; current; current = current.parent) if (current === this) return true; return false },
    }
    if (focusContract) Object.assign(value, {
      ownerDocument: document,
      focus(options) { focusCalls.push({ target: this, options }); document.dispatchFocus(this) },
      querySelectorAll(selector) {
        assert.equal(selector, 'button:not([disabled])', 'synthetic contract only models enabled dialog buttons')
        const found = []
        const visit = target => { if (target.type === 'button' && !target.props.disabled) found.push(target); target.children.forEach(visit) }
        this.children.forEach(visit); return found
      },
    })
    // Real host elements are opaque to Vue reactivity. Keep synthetic template
    // refs identical to the raw event targets rather than proxying their tree.
    return Vue.markRaw(value)
  }
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
  return { host, root, body, focus: focusContract ? { document, focusCalls, listenerLog, leaves,
    listenerCount: () => documentListeners.get('focusin')?.size ?? 0,
    completeLeave(index = 0) {
      const leave = leaves[index]; assert.ok(leave, 'missing explicitly modeled leave completion')
      leave.callback?.(leave.element)
    },
  } : null }
}

export async function mountSavedSimulations({ api, initialPath = '/simulations', locale = 'en', cacheHandlers = false, keepAlive = false, downloadHooks = {}, focusContract = false } = {}) {
  const requests = api ? null : deferredApi()
  api ??= requests.api
  const warnings = []
  const downloads = [], anchors = [], revoked = [], blobs = new Map(), networkCalls = [], storageWrites = []
  let nextUrl = 0
  const hit = (stage, value) => downloadHooks[stage]?.(value)
  const browser = {
    Blob: class extends Blob { constructor(parts, options) { super(parts, options); hit('blob', this) } },
    URL: {
      createObjectURL(blob) { hit('url'); const url = `blob:fixture-${++nextUrl}`; blobs.set(url, blob); hit('afterUrl', url); return url },
      revokeObjectURL(url) { revoked.push(url); blobs.delete(url); hit('revoke', url) },
    },
    document: {
      createElement(type) {
        assert.equal(type, 'a'); hit('create')
        const anchor = { attached: false, url: '', filename: '',
          set href(value) { this.url = value; hit('href', this) },
          set download(value) { this.filename = value; hit('filename', this) },
          click() { hit('click', this); downloads.push({ filename: this.filename, blob: blobs.get(this.url), url: this.url }); hit('afterClick', this) },
          remove() { hit('beforeRemove', this); this.attached = false; hit('remove', this) },
        }
        anchors.push(anchor); hit('afterCreate', anchor); return anchor
      },
      body: { appendChild(anchor) { anchor.attached = true; hit('append', anchor) } },
    },
    fetch(...args) { networkCalls.push(args); throw Error('Forbidden network call') },
    localStorage: { setItem(...args) { storageWrites.push(args); throw Error('Forbidden storage write') } },
  }
  const { host, root, body, focus } = renderer(focusContract)
  const stub = { render: () => Vue.h('fixture-boundary') }
  const passThrough = { inheritAttrs: false, setup: (_props, { slots, attrs }) => {
    let previous = null
    return () => {
      const children = slots.default?.()
      if (focus) {
        const current = children?.find(child => child.type !== Vue.Comment) ?? null
        if (previous && !current) focus.leaves.push({ element: previous.el, callback: attrs.onAfterLeave })
        previous = current
      }
      return children
    }
  } }
  const modules = {
    vue: { ...Vue, Transition: passThrough },
    'vue-router': { ...Router, createWebHistory: Router.createMemoryHistory },
    'vue-i18n': { useI18n },
    '../store/pendingUpload.js': PendingUpload,
  }
  const components = { '../components/LanguageSwitcher.vue': stub }
  function evaluate(source, returnName = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, Date, Intl, console, ...browser,
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
      compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false, cacheHandlers } })
    assert.deepEqual(template.errors, [])
    const value = evaluate(script.content)
    value.render = evaluate(template.code, 'render')
    return value
  }
  if (existsSync(new URL('../../src/views/SavedSimulationsView.vue', import.meta.url))) {
    components['../views/SavedSimulationsView.vue'] = component('views/SavedSimulationsView.vue')
  }
  components['../components/HistoryDatabase.vue'] = component('components/HistoryDatabase.vue')
  components['../views/Home.vue'] = component('views/Home.vue')
  const router = evaluate(readFileSync(new URL('../../src/router/index.js', import.meta.url), 'utf8'))
  const messages = Object.fromEntries(['en', 'zh'].map(key => [key,
    JSON.parse(readFileSync(new URL('../../../locales/' + key + '.json', import.meta.url), 'utf8'))]))
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages })
  const app = host.createApp({ render: () => keepAlive
    ? Vue.h(Router.RouterView, null, { default: ({ Component }) => Vue.h(Vue.KeepAlive, null, { default: () => Component }) })
    : Vue.h(Router.RouterView) })
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
  return { root, body, router, i18n, warnings, requests, flush, waitFor, all, find, byId, text, focus,
    downloads, anchors, revoked, blobs, networkCalls, storageWrites, downloadHooks,
    async click(id) {
      const target = byId(id); assert.ok(target, `missing clickable control ${id}`)
      assert.ok(!target.props.disabled, `disabled control ${id}`)
      target.props.onClick({ stopPropagation() {}, preventDefault() {} }); await flush()
    },
    async change(id, value) {
      const target = byId(id); assert.ok(target, `missing selection control ${id}`)
      await target.props.onChange({ target: { value } }); await flush()
    },
    async input(id, value) {
      const target = byId(id); assert.ok(target, `missing input ${id}`)
      target.props.onInput({ target: { value } }); await flush()
    },
    async navigate(path) { await router.push(path); await flush() },
    async back() { router.back(); await flush() },
    async forward() { router.forward(); await flush() },
    unmount() { app.unmount() },
  }
}
