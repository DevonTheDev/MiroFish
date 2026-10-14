import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Group 5 mounts the actual GraphPanel SFC in the existing synthetic host.
// These checks do not establish browser layout or native download completion.
test('GraphPanel hides download controls when its optional descriptor is absent', async t => {
  const h = mountGraphPanel(t)
  await settle()
  assert.equal(h.find('.graph-download-button'), null)
  assert.equal(h.find('.graph-download-copy'), null)
  assert.equal(String(h.find('.graph-panel').props.class).includes('has-graph-download'), false)
})

test('GraphPanel disabled download has no callable rendered handler', async t => {
  const h = mountGraphPanel(t)
  let calls = 0
  h.props.graphDownload = { enabled: false, action: () => { calls++ }, status: '', error: '' }
  await settle()
  const button = h.find('.graph-download-button')
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props.onClick, undefined)
  await h.click(button)
  assert.equal(calls, 0, 'forced synthetic activation cannot call the disabled descriptor')
  assert.equal(h.find('.graph-download-status'), null)
  assert.equal(h.find('.graph-download-error'), null)
})

test('GraphPanel binds the captured download action without redirecting it after descriptor replacement', async t => {
  const h = mountGraphPanel(t)
  const calls = []
  const first = () => calls.push('first')
  const second = () => calls.push('second')
  h.props.graphDownload = { enabled: true, action: first, status: '', error: '' }
  await settle()
  const button = h.find('.graph-download-button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.disabled, false)
  const captured = button.props.onClick
  assert.strictEqual(captured, first)
  await h.click(button)
  assert.deepEqual(calls, ['first'])

  h.props.graphDownload = { enabled: true, action: second, status: '', error: '' }
  await settle()
  assert.strictEqual(h.find('.graph-download-button').props.onClick, second)
  captured()
  assert.deepEqual(calls, ['first', 'first'], 'retaining the old function cannot resolve the newest descriptor')
  await h.click(h.find('.graph-download-button'))
  assert.deepEqual(calls, ['first', 'first', 'second'])
})

for (const [locale, label, note] of [
  ['en', 'Download loaded graph JSON', 'Downloads the loaded graph values currently held for this project; they may differ from the current server graph.'],
  ['zh', '下载已加载图谱 JSON', '下载本项目当前保留的已加载图谱数据；这些数据可能与服务器上的当前图谱不同。'],
]) {
  test(`${locale} GraphPanel download copy is localized and supplied status and error stay literal`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { messages })
    const status = `${messages.graph.download.retained} <b>{status}</b>`
    const error = `${messages.graph.download.invalid} <script>{error}</script>`
    h.props.graphDownload = { enabled: true, action: () => {}, status, error }
    await settle()
    assert.equal(h.find('.graph-download-button').textContent, label)
    assert.equal(h.find('.graph-download-note').textContent, note)
    assert.equal(h.find('.graph-download-status').props.role, 'status')
    assert.equal(h.find('.graph-download-status').props['aria-live'], 'polite')
    assert.equal(h.find('.graph-download-error').props.role, 'alert')
    assert.equal(h.find('.graph-download-status').textContent, status)
    assert.equal(h.find('.graph-download-error').textContent, error)
    assert.equal(h.find('.graph-download-copy').querySelector('b'), null)
    assert.equal(h.find('.graph-download-copy').querySelector('script'), null)
  })
}
