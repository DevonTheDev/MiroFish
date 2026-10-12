import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, markRaw, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

const frontend = fileURLToPath(new URL('../../', import.meta.url))
const entry = 'locale-preference-test-entry'
const externals = ['vue', 'vue-i18n', 'axios']
// Vite otherwise sets NODE_ENV=production after Node has imported Vue's dev
// runtime, causing the separately imported i18n runtime to select another Vue.
const nodeEnvironment = process.env.NODE_ENV
process.env.NODE_ENV ??= 'test'
const output = await build({
  root: frontend, configFile: false, envFile: false, logLevel: 'silent',
  plugins: [vue(), {
    name: 'locale-preference-test-entry',
    resolveId(id) { if (id === entry) return '\0' + entry },
    load(id) {
      if (id === '\0' + entry) return `
        export { default as i18n, availableLocales } from '${frontend}src/i18n/index.js'
        export { default as LanguageSwitcher } from '${frontend}src/components/LanguageSwitcher.vue'
        export { default as api } from '${frontend}src/api/index.js'
      `
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  build: {
    write: false, minify: false, target: 'esnext',
    rollupOptions: {
      input: entry, external: externals, preserveEntrySignatures: 'strict',
      output: { format: 'es', paths: Object.fromEntries(externals.map(name => [name, import.meta.resolve(name)])) },
    },
  },
})
if (nodeEnvironment === undefined) delete process.env.NODE_ENV
else process.env.NODE_ENV = nodeEnvironment
const chunks = output.output.filter(item => item.type === 'chunk')
assert.equal(chunks.length, 1)
export const compiledInputs = Object.keys(chunks[0].modules).filter(path => !path.startsWith('\0'))
let instance = 0

// Run the actual Vite-transformed module and compiled SFC against real Vue.
// Only the DOM host and storage failure surface are synthetic, not a browser.
export async function loadLocaleFixture(t, { storage, storageGetter } = {}) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const listeners = new Set()
  const document = {
    documentElement: { lang: 'zh' },
    addEventListener(type, listener) { assert.equal(type, 'click'); listeners.add(listener) },
    removeEventListener(type, listener) { assert.equal(type, 'click'); listeners.delete(listener) },
  }
  delete globalThis.localStorage
  if (storageGetter) Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: storageGetter })
  else if (storage !== undefined) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  let app
  t.after(() => {
    app?.unmount()
    assert.equal(listeners.size, 0, 'switcher releases its outside-click listener')
    for (const [key, descriptor] of [['localStorage', previousStorage], ['document', previousDocument]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const module = await import('data:text/javascript;base64,' + Buffer.from(chunks[0].code).toString('base64') + '#' + ++instance)
  const node = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null,
    contains(target) { for (let current = target; current; current = current.parent) if (current === this) return true; return false },
  })
  const remove = target => {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
    target.parent = null
  }
  const insert = (target, parent, anchor = null) => {
    remove(target)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(target)
    else parent.children.splice(index, 0, target)
    target.parent = parent
  }
  const renderer = createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    insert, remove, setText: (target, text) => { target.text = text },
    setElementText: (target, text) => { target.text = text; target.children = [] },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    patchProp: (target, key, _old, value) => { target.props[key] = value },
  })
  const root = node('root')
  const all = predicate => {
    const found = []
    const visit = target => { if (predicate(target)) found.push(target); target.children.forEach(visit) }
    visit(root); return found
  }
  const withClass = name => all(target => String(target.props.class).split(' ').includes(name))
  const text = target => (target.type === '#comment' ? '' : target.text) + target.children.map(text).join('')
  const flush = async () => { await nextTick(); await Promise.resolve(); await nextTick() }
  return { ...module, document, root, all, withClass, text, flush, listeners,
    async mount() {
      app = renderer.createApp({ setup() {
        const { t: translate } = useI18n()
        return () => h('main', [h(module.LanguageSwitcher), h('p', { id: 'translation' }, translate('common.cancel'))])
      } })
      app.use(module.i18n); app.mount(root); await flush()
    },
    async open() { withClass('switcher-trigger')[0].props.onClick(); await flush() },
    async select(key) {
      const option = withClass('switcher-option').find(target => text(target).trim() === module.availableLocales.find(locale => locale.key === key)?.label)
      assert.ok(option, `loaded locale option ${key} must exist`)
      option.props.onClick(); await flush()
    },
    outsideClick(target) { for (const listener of listeners) listener({ target }) },
  }
}
