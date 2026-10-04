import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { webcrypto, createHash } from 'node:crypto'
import vm from 'node:vm'
import { parse as parseJavaScript } from '@babel/parser'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { createI18n, useI18n } from 'vue-i18n'
import { trialSnapshot, flush } from './helpers/prompt-trials-view-fixture.js'

const componentUrl = new URL('../src/components/PromptTrialSuiteBuilder.vue', import.meta.url)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`
function saved(number = 1, inputs = {}) {
  const snapshot = trialSnapshot('succeeded')
  snapshot.run.request_id = id(number)
  snapshot.run.request = { ...snapshot.run.request, label: `Pin ${number}`, ...inputs }
  return snapshot
}

// Real production-compiled Vue scripts/templates, with cached handlers enabled.
// Only browser download primitives are injected; no model or network boundary exists.
async function mountBuilder({ pins = [saved()], locale = 'en', importedOrigins = new Map(), hooks = {}, uuid } = {}) {
  assert.ok(existsSync(componentUrl), 'the pinned-trial suite builder component exists')
  const builderModule = await import('../src/utils/promptTrialSuite.js')
  const props = Vue.shallowReactive({ pins: Vue.reactive(pins), importedOrigins })
  const downloads = [], revoked = [], removed = [], created = [], warnings = [], uuids = []
  const blobs = new Map()
  let nextUrl = 0
  const URL = {
    createObjectURL(blob) { const url = `blob:builder-${++nextUrl}`; created.push(url); blobs.set(url, blob); hooks.url?.(); return url },
    revokeObjectURL(url) { revoked.push(url); blobs.delete(url); hooks.revoke?.() },
  }
  const document = {
    createElement(type) {
      assert.equal(type, 'a'); hooks.create?.()
      return { click() { hooks.click?.(); downloads.push({ blob: blobs.get(this.href), filename: this.download }) }, remove() { removed.push(this); hooks.remove?.() } }
    },
    body: { appendChild() { hooks.append?.() } },
  }
  function evaluate(source, returnName = 'component') {
    const globals = { crypto: { randomUUID() { const value = uuid ? uuid() : webcrypto.randomUUID(); uuids.push(value); return value } }, Map, TextEncoder, Blob, URL, document }
    const modules = { vue: Vue, 'vue-i18n': { useI18n }, '../utils/promptTrialSuite.js': builderModule }
    const ast = parseJavaScript(source, { sourceType: 'module' })
    for (const statement of ast.program.body.filter(item => item.type === 'ImportDeclaration').reverse()) {
      assert.ok(modules[statement.source.value], `unexpected dependency ${statement.source.value}`)
      for (const item of statement.specifiers) globals[item.local.name] = modules[statement.source.value][item.imported.name]
      source = source.slice(0, statement.start) + source.slice(statement.end)
    }
    return vm.runInNewContext(source.replace('export default', 'const component =').replace('export function render', 'function render') + '\n;' + returnName, globals)
  }
  const { descriptor } = parse(readFileSync(componentUrl, 'utf8'), { filename: 'PromptTrialSuiteBuilder.vue' })
  const script = compileScript(descriptor, { id: 'builder', isProd: true })
  const template = compileTemplate({ source: descriptor.template.content, filename: 'PromptTrialSuiteBuilder.vue', id: 'builder', isProd: true,
    compilerOptions: { bindingMetadata: script.bindings, cacheHandlers: true, hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  const component = evaluate(script.content); component.render = evaluate(template.code, 'render')
  const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
  const root = node('root')
  const remove = child => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }
  const insert = (child, parent, anchor) => { remove(child); const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child); child.parent = parent }
  const host = Vue.createRenderer({ createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text), insert, remove,
    setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    patchProp: (target, key, _previous, value) => { target.props[key] = value },
  })
  const messages = Object.fromEntries(['en', 'zh'].map(language => [language, JSON.parse(readFileSync(new globalThis.URL('../../locales/' + language + '.json', import.meta.url), 'utf8'))]))
  const app = host.createApp({ render: () => Vue.h(component, props) })
  app.use(createI18n({ legacy: false, locale, fallbackLocale: 'en', messages })); app.config.warnHandler = message => warnings.push(message)
  app.mount(root); await flush()
  const all = predicate => { const found = []; const visit = target => { if (predicate(target)) found.push(target); target.children.forEach(visit) }; visit(root); return found }
  const byId = value => all(target => target.props['data-testid'] === value)[0]
  const text = (target = root) => (target.type === '#comment' ? '' : target.text) + target.children.map(text).join(' ')
  return { props, hooks, downloads, revoked, removed, created, warnings, uuids, all, byId, text,
    async input(value) { byId('trial-suite-name').props.onInput({ target: { value } }); await flush() },
    async select(number, checked = true) { const control = byId(`trial-suite-select-${id(number)}`); assert.ok(!control.props.disabled); control.props.onChange({ target: { checked } }); await flush() },
    async click(testId) { const control = byId(testId); assert.ok(control, `missing ${testId}`); assert.ok(!control.props.disabled, `disabled ${testId}`); control.props.onClick(); await flush() },
    async replace(nextPins) { props.pins = Vue.reactive(nextPins); await flush() },
    unmount() { app.unmount() },
  }
}
async function build(view, numbers = [1], name = 'Reusable suite') { await view.input(name); for (const number of numbers) await view.select(number); await view.click('trial-suite-build') }
const captured = view => JSON.parse(view.text(view.byId('trial-suite-json-preview')))

for (const locale of ['en', 'zh']) test(`captured definitions expose exact full literal inputs and requested settings in ${locale}`, async () => {
  const first = saved(1, { label: '<b>Literal pin</b>', system_prompt: '  System <script>stay literal</script>\n\t' + '界'.repeat(940), user_prompt: '  User <img src=x onerror=alert(1)>\n\t' + '🦙'.repeat(3900), temperature: 0.875, max_output_tokens: 400 })
  const pins = [first, saved(2)], original = hash(pins)
  const view = await mountBuilder({ pins, locale, importedOrigins: new Map([[id(1), { filename: '<b>history.json</b>' }]]) })
  try {
    assert.match(view.text(), locale === 'en' ? /historical/i : /历史/)
    assert.match(view.text(), locale === 'en' ? /requested settings/i : /请求设置/)
    assert.match(view.text(), locale === 'en' ? /separately|separate Run/i : /单独/)
    assert.ok(view.text().includes('<b>history.json</b>'))
    await build(view, [2, 1], '  <b>Suite 🦙</b>  ')
    const definition = captured(view)
    assert.equal(definition.name, '  <b>Suite 🦙</b>  ')
    assert.deepEqual(definition.cases.map(item => item.label), [first.run.request.label, 'Pin 2'])
    for (const [index, pin] of pins.entries()) {
      const item = definition.cases[index]
      for (const key of ['label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens']) assert.equal(item[key], pin.run.request[key])
      assert.equal(item.expected_text, null); assert.notEqual(item.case_id, pin.run.request_id)
      assert.deepEqual(Object.keys(item).sort(), ['case_id', 'expected_text', 'label', 'max_output_tokens', 'system_prompt', 'temperature', 'user_prompt'].sort())
      const preview = view.text(view.byId(`trial-suite-case-${index}`))
      for (const key of ['label', 'system_prompt', 'user_prompt']) assert.ok(preview.includes(item[key]), `${key} is shown in full`)
    }
    assert.equal(view.all(target => ['script', 'img', 'b'].includes(target.type)).length, 0)
    assert.equal(view.uuids.length, 2)
    await view.click('trial-suite-download'); await view.click('trial-suite-download')
    assert.equal(await view.downloads[0].blob.text(), await view.downloads[1].blob.text())
    assert.deepEqual(JSON.parse(await view.downloads[0].blob.text()), definition)
    assert.equal(view.uuids.length, 2); assert.equal(view.downloads[0].filename, 'local_prompt_suite.json')
    await view.click('trial-suite-build')
    assert.equal(view.uuids.length, 4); assert.notDeepEqual(captured(view).cases.map(item => item.case_id), definition.cases.map(item => item.case_id))
    assert.equal(hash(pins), original); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('build requires a valid 1–80 code point name and one to five independent pins', async () => {
  const view = await mountBuilder({ pins: Array.from({ length: 6 }, (_, index) => saved(index + 1)) })
  try {
    assert.equal(view.byId('trial-suite-build').props.disabled, true)
    await view.input('Valid'); assert.equal(view.byId('trial-suite-build').props.disabled, true)
    await view.select(1)
    for (const name of ['', '   ', 'a'.repeat(81), 'line\nname', 'hidden\u200bname']) {
      await view.input(name); assert.equal(view.byId('trial-suite-build').props.disabled, true)
      view.byId('trial-suite-build').props.onClick(); await flush(); assert.equal(view.byId('trial-suite-preview'), undefined)
    }
    await view.input('🦙'.repeat(80)); assert.equal(view.byId('trial-suite-build').props.disabled, false)
    for (const number of [2, 3, 4, 5]) await view.select(number)
    assert.equal(view.byId(`trial-suite-select-${id(6)}`).props.disabled, true)
    view.byId(`trial-suite-select-${id(6)}`).props.onChange({ target: { checked: true } }); await flush()
    await view.click('trial-suite-build'); assert.equal(captured(view).cases.length, 5)
    await view.select(1, false); await view.select(6)
    await view.click('trial-suite-build'); assert.deepEqual(captured(view).cases.map(item => item.label), ['Pin 2', 'Pin 3', 'Pin 4', 'Pin 5', 'Pin 6'])
  } finally { view.unmount() }
})

test('draft edits retire capture, download errors and cached download/build handlers', async () => {
  const view = await mountBuilder({ pins: [saved(1), saved(2)] })
  try {
    await build(view)
    const oldDownload = view.byId('trial-suite-download').props.onClick, oldBuild = view.byId('trial-suite-build').props.onClick
    view.hooks.url = () => { throw new Error('secret failure') }
    await view.click('trial-suite-download'); assert.ok(view.byId('trial-suite-error')); assert.doesNotMatch(view.text(), /secret failure/)
    delete view.hooks.url
    await view.input('Changed'); assert.equal(view.byId('trial-suite-preview'), undefined); assert.equal(view.byId('trial-suite-error'), undefined)
    oldBuild(); oldDownload(); await flush(); assert.equal(view.byId('trial-suite-preview'), undefined); assert.equal(view.downloads.length, 0)
    await view.click('trial-suite-build'); oldDownload(); await flush(); assert.equal(view.downloads.length, 0)
    await view.select(2); assert.equal(view.byId('trial-suite-preview'), undefined)
    await view.click('trial-suite-build'); assert.equal(captured(view).cases.length, 2)
  } finally { view.unmount() }
})

for (const field of ['name', 'selection']) test(`${field} A to B to A never revives stale Build or download handlers`, async () => {
  const view = await mountBuilder({ pins: [saved(1), saved(2)] })
  try {
    await build(view)
    const oldBuild = view.byId('trial-suite-build').props.onClick, oldDownload = view.byId('trial-suite-download').props.onClick
    if (field === 'name') { await view.input('B'); await view.input('Reusable suite') }
    else { await view.select(2); await view.select(2, false) }
    oldBuild(); oldDownload(); await flush()
    assert.equal(view.byId('trial-suite-preview'), undefined); assert.equal(view.downloads.length, 0); assert.equal(view.uuids.length, 1)
    await view.click('trial-suite-build'); oldDownload(); await flush()
    assert.equal(view.downloads.length, 0); assert.equal(view.uuids.length, 2)
  } finally { view.unmount() }
})

test('removing and reinserting the same object requires explicit reselection', async () => {
  const first = saved(1), second = saved(2), view = await mountBuilder({ pins: [first, second] })
  try {
    await build(view)
    const oldDownload = view.byId('trial-suite-download').props.onClick, oldSelect = view.byId(`trial-suite-select-${id(1)}`).props.onChange
    await view.replace([second]); await view.replace([first, second])
    assert.equal(view.byId(`trial-suite-select-${id(1)}`).props.checked, false)
    assert.equal(view.byId('trial-suite-build').props.disabled, true)
    oldDownload(); oldSelect({ target: { checked: true } }); await flush()
    assert.equal(view.downloads.length, 0); assert.equal(view.byId(`trial-suite-select-${id(1)}`).props.checked, false)
  } finally { view.unmount() }
})

test('exact selected pin identity and displayed order own captures while unrelated pins preserve them', async () => {
  const first = saved(1), second = saved(2), third = saved(3)
  const view = await mountBuilder({ pins: [first, second] })
  try {
    await build(view); const json = view.text(view.byId('trial-suite-json-preview'))
    const oldSelect = view.byId(`trial-suite-select-${id(1)}`).props.onChange, oldDownload = view.byId('trial-suite-download').props.onClick
    await view.replace([first, second, third]); assert.equal(view.text(view.byId('trial-suite-json-preview')), json)
    await view.replace([first, third]); assert.equal(view.text(view.byId('trial-suite-json-preview')), json)
    await view.replace([saved(1, { user_prompt: 'Replacement' }), third])
    assert.equal(view.byId(`trial-suite-select-${id(1)}`).props.checked, false); assert.equal(view.byId('trial-suite-preview'), undefined)
    oldSelect({ target: { checked: true } }); oldDownload(); await flush()
    assert.equal(view.byId(`trial-suite-select-${id(1)}`).props.checked, false); assert.equal(view.downloads.length, 0)
    await view.select(1); await view.select(3); await view.click('trial-suite-build')
    await view.replace([...view.props.pins].reverse()); assert.equal(view.byId('trial-suite-preview'), undefined)
    await view.click('trial-suite-build'); assert.deepEqual(captured(view).cases.map(item => item.label), ['Pin 3', 'Pin 1'])
    await view.replace([view.props.pins[1]]); assert.equal(view.byId('trial-suite-preview'), undefined)
    await view.click('trial-suite-build'); assert.equal(captured(view).cases.length, 1)
  } finally { view.unmount() }
})

for (const boundary of ['url', 'create', 'append']) test(`reentrant draft retirement at ${boundary} cannot download and still cleans allocated resources`, async () => {
  const view = await mountBuilder()
  try {
    await build(view)
    view.hooks[boundary] = () => view.byId('trial-suite-name').props.onInput({ target: { value: 'Changed during download' } })
    await view.click('trial-suite-download')
    assert.equal(view.downloads.length, 0); assert.equal(view.byId('trial-suite-preview'), undefined)
    assert.deepEqual(view.revoked, view.created)
    if (boundary !== 'url') assert.equal(view.removed.length, 1)
  } finally { view.unmount() }
})

for (const change of ['replace selected pin', 'rebuild', 'unmount']) test(`reentrant ${change} cannot export a replaced capture`, async () => {
  const view = await mountBuilder()
  try {
    await build(view)
    view.hooks.append = () => {
      if (change === 'replace selected pin') view.props.pins[0] = saved(1, { user_prompt: 'Replacement' })
      else if (change === 'rebuild') view.byId('trial-suite-build').props.onClick()
      else view.unmount()
    }
    await view.click('trial-suite-download')
    assert.equal(view.downloads.length, 0); assert.equal(view.removed.length, 1); assert.deepEqual(view.revoked, view.created)
    if (change === 'replace selected pin') { assert.equal(view.byId('trial-suite-preview'), undefined); assert.equal(view.byId(`trial-suite-select-${id(1)}`).props.checked, false) }
    if (change === 'rebuild') { assert.equal(view.uuids.length, 2); assert.ok(view.byId('trial-suite-preview')) }
  } finally { if (change !== 'unmount') view.unmount() }
})

test('reentrant name change during UUID allocation cannot publish a stale capture or error', async () => {
  let view
  view = await mountBuilder({ uuid: () => { view.byId('trial-suite-name').props.onInput({ target: { value: 'Changed during Build' } }); return webcrypto.randomUUID() } })
  try {
    await build(view)
    assert.equal(view.byId('trial-suite-preview'), undefined); assert.equal(view.byId('trial-suite-error'), undefined); assert.equal(view.downloads.length, 0)
  } finally { view.unmount() }
})

test('a newer nested Build owns its capture when an older UUID allocation finishes', async () => {
  let view, nested = false
  view = await mountBuilder({ uuid: () => {
    if (!nested) { nested = true; view.byId('trial-suite-build').props.onClick() }
    return webcrypto.randomUUID()
  } })
  try {
    await build(view)
    assert.equal(view.uuids.length, 2); assert.equal(captured(view).cases[0].case_id, view.uuids[0])
  } finally { view.unmount() }
})

for (const boundary of ['click', 'remove', 'revoke']) test(`download cleanup remains independent when ${boundary} throws`, async () => {
  const view = await mountBuilder()
  try {
    await build(view); view.hooks[boundary] = () => { throw new Error('private browser error') }
    await view.click('trial-suite-download')
    assert.equal(view.removed.length, 1); assert.deepEqual(view.revoked, view.created)
    assert.ok(view.byId('trial-suite-error')); assert.doesNotMatch(view.text(), /private browser error/)
    assert.ok(view.byId('trial-suite-preview'))
  } finally { view.unmount() }
})

test('retired handlers cannot build, change membership or download after unmount', async () => {
  const view = await mountBuilder(); await build(view)
  const download = view.byId('trial-suite-download').props.onClick, buildHandler = view.byId('trial-suite-build').props.onClick, select = view.byId(`trial-suite-select-${id(1)}`).props.onChange
  view.unmount(); download(); buildHandler(); select({ target: { checked: true } }); await flush()
  assert.equal(view.downloads.length, 0); assert.equal(view.created.length, 0); assert.equal(view.uuids.length, 1)
})

test('a terminal historical pin above its observed runtime cap remains reusable offline', async () => {
  const pin = saved(1, { max_output_tokens: 400 }); pin.limits.max_output_tokens = 64
  const view = await mountBuilder({ pins: [pin] })
  try { await build(view); assert.equal(captured(view).cases[0].max_output_tokens, 400); await view.click('trial-suite-download'); assert.equal(view.downloads.length, 1) }
  finally { view.unmount() }
})

test('invalid selected snapshot fails the whole build with a static localized error', async () => {
  const bad = saved(2); bad.run.request.user_prompt = '\u0000secret invalid prompt'
  const view = await mountBuilder({ pins: [saved(), bad] })
  try {
    await build(view, [1, 2]); assert.equal(view.byId('trial-suite-preview'), undefined); assert.ok(view.byId('trial-suite-error'))
    assert.doesNotMatch(view.text(view.byId('trial-suite-error')), /secret invalid prompt/)
    await view.select(2, false); assert.equal(view.byId('trial-suite-error'), undefined)
    await view.click('trial-suite-build'); assert.equal(captured(view).cases.length, 1)
  } finally { view.unmount() }
})
