import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { compiledInputs, loadLocaleFixture } from './helpers/locale-preference-fixture.js'

const denied = () => { throw new DOMException('Storage unavailable', 'SecurityError') }
const storage = saved => ({ getItem(key) { assert.equal(key, 'locale'); return saved }, setItem() {} })
const translation = fixture => fixture.text(fixture.all(node => node.props.id === 'translation')[0])

test('fixture compiles the actual locale module, switcher template and API interceptor', () => {
  for (const suffix of ['/src/i18n/index.js', '/src/components/LanguageSwitcher.vue', '/src/api/index.js', '/locales/en.json', '/locales/zh.json', '/locales/languages.json']) {
    assert.ok(compiledInputs.some(path => path.endsWith(suffix)), `missing compiled input ${suffix}`)
  }
})

for (const key of ['en', 'zh']) {
  test(`initialization retains loaded preference ${key}`, async t => {
    const fixture = await loadLocaleFixture(t, { storage: storage(key) })
    assert.equal(fixture.i18n.global.locale.value, key)
    assert.deepEqual(fixture.availableLocales.map(locale => locale.key).sort(), ['en', 'zh'])
    await fixture.mount()
    assert.equal(fixture.document.documentElement.lang, key)
    assert.equal(fixture.text(fixture.withClass('switcher-trigger')[0]).replace('▼', '').trim(), key === 'en' ? 'English' : '中文')
    assert.equal(translation(fixture), key === 'en' ? 'Cancel' : '取消')
  })
}

test('initialization sets document language from the accepted preference before mounting', async t => {
  const fixture = await loadLocaleFixture(t, { storage: storage('en') })
  assert.equal(fixture.document.documentElement.lang, 'en')
})

for (const [name, options] of [
  ['absent storage', {}],
  ['throwing storage getter', { storageGetter: denied }],
  ['throwing getItem', { storage: { getItem: denied } }],
  ['missing preference', { storage: storage(null) }],
  ['empty preference', { storage: storage('') }],
  ['catalogue-only preference', { storage: storage('es') }],
  ['unknown preference', { storage: storage('xx') }],
  ['prototype-name preference', { storage: storage('toString') }],
]) {
  test(`initialization uses the existing zh default with ${name}`, async t => {
    const fixture = await loadLocaleFixture(t, options)
    assert.equal(fixture.i18n.global.locale.value, 'zh')
    await fixture.mount()
    assert.equal(translation(fixture), '取消')
    assert.equal(fixture.document.documentElement.lang, 'zh')
  })
}

for (const failure of ['setter', 'getter', 'absent']) {
  test(`switching remains coherent and repeatable after storage ${failure} failure`, async t => {
    const saved = storage('en')
    const fixture = await loadLocaleFixture(t, { storage: saved })
    await fixture.mount()
    if (failure === 'setter') saved.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError') }
    if (failure === 'getter') Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: denied })
    if (failure === 'absent') delete globalThis.localStorage
    for (const key of ['zh', 'en']) {
      await fixture.open()
      assert.equal(fixture.withClass('switcher-option').length, 2)
      let error
      try { await fixture.select(key) } catch (caught) { error = caught }
      await fixture.flush()
      assert.equal(fixture.i18n.global.locale.value, key)
      assert.equal(fixture.document.documentElement.lang, key)
      assert.equal(fixture.withClass('switcher-dropdown').length, 0)
      assert.ifError(error)
      assert.equal(fixture.text(fixture.withClass('switcher-trigger')[0]).replace('▼', '').trim(), key === 'en' ? 'English' : '中文')
      assert.equal(translation(fixture), key === 'en' ? 'Cancel' : '取消')
      const response = await fixture.api.get('/locale-test', { adapter: async config => ({
        data: { success: true, locale: config.headers.get('Accept-Language') }, status: 200, statusText: 'OK', headers: {}, config,
      }) })
      assert.equal(response.locale, key, 'real interceptor uses the current session locale without network')
    }
  })
}

test('successful switches persist the existing locale key and outside dismissal still works', async t => {
  const saved = storage('en'), writes = []
  saved.setItem = (key, value) => { writes.push([key, value]); saved.getItem = () => value }
  const fixture = await loadLocaleFixture(t, { storage: saved })
  await fixture.mount(); await fixture.open(); await fixture.select('zh')
  assert.deepEqual(writes, [['locale', 'zh']])
  await fixture.open()
  fixture.outsideClick(fixture.withClass('switcher-trigger')[0]); await fixture.flush()
  assert.equal(fixture.withClass('switcher-dropdown').length, 1)
  fixture.outsideClick({}); await fixture.flush()
  assert.equal(fixture.withClass('switcher-dropdown').length, 0)
  assert.equal(fixture.listeners.size, 1)
})

test('initial HTML scripts tolerate denied storage before Vue starts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const context = { document: { documentElement: { lang: 'zh' } } }
  Object.defineProperty(context, 'localStorage', { get: denied })
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (script[1].trim()) assert.doesNotThrow(() => vm.runInNewContext(script[1], context))
  }
  assert.equal(context.document.documentElement.lang, 'zh')
})
