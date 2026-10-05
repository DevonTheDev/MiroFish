import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as I18n from 'vue-i18n'
import * as content from '../../src/utils/content.js'

// Compile the unchanged interaction script AND template. Real Vue reactivity,
// model bindings, survey controls and answer rendering run in a custom host.
// Browser geometry/document listeners and unrelated report reads are seams.
export function buildSurvey(api) {
  const warnings = [], emitted = [], listeners = new Set()
  let instance
  const previousDocument = globalThis.document
  const document = { activeElement: null, querySelector: () => null,
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener) }
  // Vue's actual v-model directive consults the host document on updates.
  globalThis.document = document
  const modules = { vue: Vue, 'vue-i18n': I18n, '../utils/content.js': content }
  function evaluate(source, name = 'component') {
    const ast = parseJavaScript(source, { sourceType: 'module' })
    const globals = { AbortController, document,
      console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) } }
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      const dependency = modules[statement.source.value] ?? api
      for (const item of statement.specifiers) globals[item.local.name] = dependency[item.imported.name]
      source = source.slice(0, statement.start) + source.slice(statement.end)
    }
    return vm.runInNewContext(source.replace('export default', 'const component =')
      .replace('export function render', 'function render') + '\n;' + name, globals)
  }
  const filename = 'Step5Interaction.vue'
  const { descriptor } = parse(readFileSync(new URL('../../src/components/' + filename, import.meta.url), 'utf8'), { filename })
  const script = compileScript(descriptor, { id: filename })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: filename,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = evaluate(script.content)
  component.render = evaluate(template.code, 'render')
  const setup = component.setup
  component.setup = (props, context) => { instance = Vue.getCurrentInstance(); return setup(props, context) }
  const node = (type, text = '') => ({ type, text, tagName: type.toUpperCase(), props: {}, children: [], parent: null,
    style: {}, addEventListener() {}, removeEventListener() {} })
  const remove = child => {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
    child.parent = null
  }
  const insert = (child, parent, anchor) => {
    remove(child)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
    child.parent = parent
  }
  const renderer = Vue.createRenderer({ createElement: type => node(type), createText: text => node('#text', text),
    createComment: text => node('#comment', text), insert, remove,
    insertStaticContent(text, parent, anchor) { const child = node('#static', text); insert(child, parent, anchor); return [child, child] },
    setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    patchProp: (target, key, _previous, value) => { target.props[key] = value },
  })
  const app = renderer.createApp(component, { reportId: 'report_fixture', simulationId: 'sim_single',
    onAddLog: message => emitted.push(message) })
  const messages = { en: JSON.parse(readFileSync(new URL('../../../locales/en.json', import.meta.url), 'utf8')) }
  app.use(I18n.createI18n({ legacy: false, locale: 'en', messages }))
  app.config.warnHandler = (...args) => warnings.push(args)
  const host = node('root')
  app.mount(host)
  const all = predicate => {
    const visit = target => [...(predicate(target) ? [target] : []), ...target.children.flatMap(visit)]
    return visit(host)
  }
  return { host, warnings, emitted, listeners, all, find: predicate => all(predicate)[0],
    state: () => instance.setupState, close: () => {
      app.unmount()
      if (previousDocument === undefined) delete globalThis.document
      else globalThis.document = previousDocument
    } }
}
