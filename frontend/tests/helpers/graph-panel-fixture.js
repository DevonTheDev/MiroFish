import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as d3 from 'd3'

// Real Vue SFC, renderer and D3. Only the DOM host is synthetic; this does not
// verify native browser layout, pointer geometry or visual appearance.
function hostDocument() {
  const document = { createElement: type => element(type),
    createElementNS: (namespace, type) => element(type, namespace) }
  function element(type, namespace = 'http://www.w3.org/1999/xhtml') {
    const listeners = new Map()
    return {
      type, namespaceURI: namespace, ownerDocument: document,
      props: {}, children: [], parentNode: null, text: '', clientWidth: 800, clientHeight: 600,
      style: { setProperty(key, value) { this[key] = value },
        removeProperty(key) { delete this[key] }, getPropertyValue(key) { return this[key] ?? '' } },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null },
      get textContent() { return this.type === '#comment' ? '' : this.text + this.children.map(child => child.textContent).join('') },
      set textContent(text) {
        this.children.forEach(child => { child.parentNode = null })
        this.children = []; this.text = String(text)
      },
      setAttribute(key, value) { this.props[key] = String(value) },
      getAttribute(key) { return this.props[key] ?? null },
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
      getBBox() { return { width: this.textContent.length * 6, height: 12 } },
    }
  }
  return { document, element }
}

export async function settle() {
  for (let i = 0; i < 4; i++) { await Promise.resolve(); await Vue.nextTick() }
}

export function mountGraphPanel(t) {
  // D3's touch detection needs a browser navigator, absent in supported Node 20.
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: 0 } })
    t.after(() => { delete globalThis.navigator })
  }
  const filename = 'GraphPanel.vue'
  const source = readFileSync(new URL('../../src/components/GraphPanel.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename })
  let code = compileScript(descriptor, { id: filename, inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  const windowListeners = new Set(), emitted = [], warnings = []
  const globals = { window: {
    addEventListener: (_type, fn) => windowListeners.add(fn),
    removeEventListener: (_type, fn) => windowListeners.delete(fn),
  } }
  const modules = { vue: Vue, d3 }
  for (const statement of parseJavaScript(code, { sourceType: 'module' }).program.body
    .filter(node => node.type === 'ImportDeclaration').reverse()) {
    const dependency = modules[statement.source.value]
    assert.ok(dependency, `unexpected GraphPanel dependency: ${statement.source.value}`)
    for (const specifier of statement.specifiers) globals[specifier.local.name] =
      specifier.type === 'ImportNamespaceSpecifier' ? dependency : dependency[specifier.imported.name]
    code = code.slice(0, statement.start) + code.slice(statement.end)
  }
  const GraphPanel = vm.runInNewContext(code.replace('export default', 'const component =') + '\n;component', globals)
  const { document, element } = hostDocument()
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
  const props = Vue.reactive({ graphData: null, loading: false, currentPhase: 2, isSimulating: false })
  const app = renderer.createApp({ render: () => Vue.h(GraphPanel, { ...props, onRefresh: () => emitted.push('refresh') }) })
  app.config.globalProperties.$t = key => key
  app.config.warnHandler = message => warnings.push(message)
  const host = element('root')
  app.mount(host)
  t.after(() => {
    app.unmount()
    assert.equal(windowListeners.size, 0, 'unmount removes its resize listener')
    assert.deepEqual(warnings, [], 'mount and updates have no Vue warnings')
  })
  return {
    host, props, emitted,
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
