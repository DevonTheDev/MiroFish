import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as d3 from 'd3'
import * as graphViewSvg from '../../src/utils/graphViewSvg.js'
import * as nodeRelationships from '../../src/utils/nodeRelationships.js'
import * as loadedGraphPath from '../../src/utils/loadedGraphPath.js'

// Real Vue SFC, renderer and D3. Only the DOM host is synthetic; this does not
// verify native browser layout, pointer geometry or visual appearance.
function hostDocument(observations, hooks) {
  const document = { createElement: type => element(type),
    createElementNS: (namespace, type) => element(type, namespace) }
  function element(type, namespace = 'http://www.w3.org/1999/xhtml') {
    const listeners = new Map()
    const styleValues = new Map()
    const style = {
      get length() { return styleValues.size },
      item(index) { return [...styleValues.keys()][index] ?? '' },
      setProperty(key, value) { styleValues.set(key, String(value)); this[key] = String(value) },
      removeProperty(key) { styleValues.delete(key); delete this[key] },
      getPropertyValue(key) { return styleValues.get(key) ?? '' },
      getPropertyPriority() { return '' },
    }
    // Native DOM nodes are not Vue-reactive targets. Keep synthetic host
    // identities equally stable when component refs hold them and D3 appends.
    return Vue.markRaw({
      type, namespaceURI: namespace, ownerDocument: document,
      props: {}, children: [], parentNode: null, text: '', clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0,
      style, scrollTop: 0,
      focus(options) { observations.focus.push({ target: this, options }); document.activeElement = this },
      get nodeType() { return this.type === '#text' ? 3 : this.type === '#comment' ? 8 : 1 },
      get localName() { return this.type },
      get data() { return this.text },
      get firstChild() { return this.children[0] ?? null },
      get attributes() {
        const values = Object.entries(this.props).filter(([name, value]) => !name.startsWith('on') && value != null)
          .map(([name, value]) => ({ name, value: String(value), namespaceURI: null }))
        if (style.length) values.push({ name: 'style', value: [...styleValues].map(([key, value]) => `${key}: ${value};`).join(' '), namespaceURI: null })
        return Object.assign(values, { item(index) { return this[index] ?? null } })
      },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null },
      get textContent() { return this.type === '#comment' ? '' : this.text + this.children.map(child => child.textContent).join('') },
      set textContent(text) {
        this.children.forEach(child => { child.parentNode = null })
        this.children = []; this.text = ''
        if (String(text)) this.appendChild(Object.assign(element('#text'), { text: String(text) }))
      },
      setAttribute(key, value) { hooks.attribute?.(this, key, value); this.props[key] = String(value) },
      getAttribute(key) { return key === 'style' && style.length
        ? [...styleValues].map(([name, value]) => `${name}: ${value};`).join(' ') : this.props[key] ?? null },
      removeAttribute(key) { delete this.props[key] },
      appendChild(child) { return this.insertBefore(child, null) },
      insertBefore(child, anchor) {
        child.parentNode?.removeChild(child)
        const index = anchor ? this.children.indexOf(anchor) : -1
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child)
        child.parentNode = this
        return child
      },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        child.parentNode = null
        return child
      },
      matches(selector) {
        if (selector === '*') return !this.type.startsWith('#')
        if (selector.startsWith('.')) return String(this.props.class ?? '').split(/\s+/).includes(selector.slice(1))
        return this.type === selector
      },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(listener)
      },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
      dispatchEvent(event) {
        event.target ??= this
        event.stopPropagation ??= () => { event.stopped = true }
        for (const listener of listeners.get(event.type) ?? []) listener.call(this, event)
        this.props['on' + event.type[0].toUpperCase() + event.type.slice(1)]?.(event)
        if (!event.stopped) this.parentNode?.dispatchEvent(event)
      },
      getBBox() { observations.bbox++; hooks.bbox?.(this); return { width: this.textContent.length * 6, height: 12 } },
      getBoundingClientRect() { observations.viewport++; hooks.viewport?.(this); return { x: 0, y: 0, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight } },
    })
  }
  return { document, element }
}

export async function settle() {
  for (let i = 0; i < 4; i++) { await Promise.resolve(); await Vue.nextTick() }
}

export function mountGraphPanel(t, { messages = {}, deferGraphRedraw = false, initialGraph = null,
  controlledTicks = false, controlledPathJobs = false, touchEnabled = false } = {}) {
  // D3's touch detection needs a browser navigator, absent in supported Node 20.
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: touchEnabled ? 1 : 0 } })
  let navigatorRestored = false
  const restoreNavigator = () => {
    if (navigatorRestored) return
    navigatorRestored = true
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator); else delete globalThis.navigator
  }
  t.after(restoreNavigator)
  const filename = 'GraphPanel.vue'
  const source = readFileSync(new URL('../../src/components/GraphPanel.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename })
  let code = compileScript(descriptor, { id: filename, inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  const windowListeners = new Set(), emitted = [], warnings = [], captures = [], retired = [], simulations = []
  const observations = { viewport: 0, bbox: 0, ticks: 0, stops: 0, restarts: 0, focus: [] }, hooks = {}
  let nextPathTaskId = 0
  const pathTasks = new Map(), pathTaskQueue = []
  const globals = {
    setTimeout: controlledPathJobs ? callback => {
      const id = ++nextPathTaskId
      pathTasks.set(id, callback)
      pathTaskQueue.push(id)
      return id
    } : globalThis.setTimeout,
    clearTimeout: controlledPathJobs ? id => pathTasks.delete(id) : globalThis.clearTimeout,
    performance: controlledPathJobs ? { now: () => 0 } : globalThis.performance,
    window: {
      addEventListener: (_type, fn) => windowListeners.add(fn),
      removeEventListener: (_type, fn) => windowListeners.delete(fn),
    },
  }
  const redraws = []
  const modules = { vue: deferGraphRedraw ? { ...Vue, nextTick: callback => {
    if (callback) { redraws.push(callback); return Promise.resolve() }
    return Vue.nextTick()
  } } : Vue, d3: controlledTicks ? { ...d3, forceSimulation(nodes) {
    const simulation = d3.forceSimulation(nodes).stop()
    simulations.push(simulation)
    for (const [method, counter] of [['tick', 'ticks'], ['stop', 'stops'], ['restart', 'restarts']]) {
      const original = simulation[method]
      simulation[method] = function(...args) { observations[counter]++; return original.apply(this, args) }
    }
    return simulation
  } } : d3, '../utils/graphViewSvg.js': graphViewSvg, '../utils/nodeRelationships.js': nodeRelationships,
    '../utils/loadedGraphPath.js': loadedGraphPath }
  for (const statement of parseJavaScript(code, { sourceType: 'module' }).program.body
    .filter(node => node.type === 'ImportDeclaration').reverse()) {
    const dependency = modules[statement.source.value]
    assert.ok(dependency, `unexpected GraphPanel dependency: ${statement.source.value}`)
    for (const specifier of statement.specifiers) globals[specifier.local.name] =
      specifier.type === 'ImportNamespaceSpecifier' ? dependency : dependency[specifier.imported.name]
    code = code.slice(0, statement.start) + code.slice(statement.end)
  }
  const GraphPanel = vm.runInNewContext(code.replace('export default', 'const component =') + '\n;component', globals)
  const { document, element } = hostDocument(observations, hooks)
  const renderer = Vue.createRenderer({
    createElement: (type, namespace) => namespace === 'svg'
      ? document.createElementNS('http://www.w3.org/2000/svg', type) : document.createElement(type),
    createText: text => Object.assign(element('#text'), { text }),
    createComment: text => Object.assign(element('#comment'), { text }),
    insert: (child, parent, anchor) => parent.insertBefore(child, anchor),
    remove: child => child.parentNode?.removeChild(child),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.textContent = text },
    parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
    patchProp: (node, key, _old, value) => { node.props[key] = value },
  })
  const props = Vue.reactive({ graphData: initialGraph, loading: false, currentPhase: 2, isSimulating: false })
  const app = renderer.createApp({ render: () => Vue.h(GraphPanel, { ...props,
    onRefresh: () => emitted.push('refresh'), onToggleMaximize: () => emitted.push('toggle-maximize'),
    onGraphViewCapture: value => captures.push(value), onGraphViewRetired: value => retired.push(value) }) })
  app.config.globalProperties.$t = (key, values = {}) => {
    const message = key.split('.').reduce((value, part) => value?.[part], messages) ?? key
    return message.replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''))
  }
  app.config.warnHandler = message => warnings.push(message)
  const host = element('root')
  app.mount(host)
  let closed = false
  const close = () => { if (!closed) { closed = true; app.unmount(); restoreNavigator() } }
  t.after(() => {
    close()
    assert.equal(windowListeners.size, 0, 'unmount removes its resize listener')
    assert.deepEqual(warnings, [], 'mount and updates have no Vue warnings')
  })
  return {
    host, props, emitted, close, captures, retired, simulations, observations, hooks,
    tick(simulation = simulations.at(-1)) {
      assert.ok(simulation, 'a controlled real D3 simulation exists')
      simulation.tick()
      simulation.on('tick')?.call(simulation)
    },
    takeRedraws: () => redraws.splice(0),
    async runNextPathTask() {
      assert.ok(controlledPathJobs, 'path tasks must be explicitly controlled')
      while (pathTaskQueue.length) {
        const id = pathTaskQueue.shift(), callback = pathTasks.get(id)
        if (!callback) continue
        pathTasks.delete(id)
        callback()
        await settle()
        return true
      }
      return false
    },
    takePathTasks() {
      assert.ok(controlledPathJobs, 'path tasks must be explicitly controlled')
      // Detach actual callbacks so callers can retain them across cancellation
      // and then challenge stale job ownership directly.
      const callbacks = pathTaskQueue.splice(0).flatMap(id => {
        const callback = pathTasks.get(id)
        pathTasks.delete(id)
        return callback ? [callback] : []
      })
      return callbacks
    },
    resize() { for (const listener of windowListeners) listener() },
    async input(value) {
      const input = host.querySelector('.node-search-input')
      assert.ok(input, 'the search input exists')
      input.dispatchEvent({ type: 'input', target: { value } }); await settle()
    },
    find: selector => host.querySelector(selector),
    async load(graphData) { props.graphData = graphData; await settle() },
    async click(node) { assert.ok(node, 'the rendered target exists'); node.dispatchEvent({ type: 'click' }); await settle() },
    async select(uuid) {
      const node = host.querySelector('.nodes')?.querySelectorAll('circle').find(circle => circle.__data__.id === uuid)
      assert.ok(node, `D3 rendered graph node ${uuid}`)
      node.dispatchEvent({ type: 'click' }); await settle()
      assert.ok(host.querySelector('.detail-panel'), 'the real D3 click opens node details')
    },
    properties() {
      return Object.fromEntries(host.querySelectorAll('.property-item').map(row => [
        row.querySelector('.property-key').textContent.slice(0, -1),
        row.querySelector('.property-value').textContent,
      ]))
    },
  }
}
