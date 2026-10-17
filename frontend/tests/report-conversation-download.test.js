import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { settle, textContent } from './helpers/simulation-platform-fixture.js'

// Real compiled Step5 script + template and Vue/i18n. Only browser dispatch and
// HTTP boundaries are modeled; this does not establish native file saving.
const id = 'report-conversation-download'
const ok = data => ({ success: true, data })
const byId = (v, name = id) => v.find(node => node.props['data-testid'] === name)
const byClass = (v, name) => v.find(node => String(node.props.class ?? '').split(' ').includes(name))
const action = v => { const button = byId(v); assert.ok(button); return button.props.onClick }
const invoke = callback => callback({ preventDefault() {}, stopPropagation() {} })
const row = (content = 'Stored question', role = 'user') => ({ role, content, timestamp: '2026-10-17T10:00:00.000Z' })
const normalizeTime = text => text.replace(/captured_at:\n  [^\n]+/, 'captured_at:\n  CAPTURE')

function browser(hooks = {}) {
  const downloads = [], anchors = [], revoked = [], blobs = new Map(), calls = []
  let next = 0
  const hit = (stage, value) => { calls.push(stage); hooks[stage]?.(value) }
  const globals = {
    Blob: class extends Blob { constructor(parts, options) { super(parts, options); hit('blob', this) } },
    URL: {
      createObjectURL(blob) { hit('url'); const url = `blob:conversation-${++next}`; blobs.set(url, blob); hit('afterUrl', url); return url },
      revokeObjectURL(url) { revoked.push(url); blobs.delete(url); hit('revoke', url) },
    },
  }
  const document = {
    body: { appendChild(anchor) { anchor.attached = true; hit('append', anchor); return anchor } },
    createElement(type) {
      assert.equal(type, 'a')
      const anchor = { attached: false, url: '', filename: '', removeCalls: 0,
        set href(value) { this.url = value; hit('href', this) },
        set download(value) { this.filename = value; hit('filename', this) },
        click() { hit('click', this); downloads.push({ url: this.url, filename: this.filename, blob: blobs.get(this.url) }); hit('afterClick', this) },
        remove() { this.removeCalls++; hit('beforeRemove', this); this.attached = false; hit('afterRemove', this) },
      }
      anchors.push(anchor); hit('create', anchor); return anchor
    },
  }
  return { globals, document, downloads, anchors, revoked, blobs, calls, hooks }
}

async function setup(t, options = {}) {
  const host = browser(options.hooks), requests = [], ledger = []
  const api = {
    getReport: async () => { ledger.push('report'); return ok({}) },
    getAgentLog: async () => { ledger.push('log'); return ok({ logs: [] }) },
    getSimulationProfilesRealtime: async () => { ledger.push('profiles'); return ok({ profiles: [{ username: 'Synthetic agent' }] }) },
    chatWithReport: (...args) => new Promise((resolve, reject) => { ledger.push('chat'); requests.push({ args, resolve, reject }) }),
    interviewAgents: (...args) => new Promise((resolve, reject) => { ledger.push('interview'); requests.push({ args, resolve, reject }) }),
  }
  const view = buildSurvey(api, { locale: options.locale || 'en', props: options.props, downloadHost: host })
  const close = view.close; let closed = false
  view.close = () => { if (!closed) { closed = true; close() } }
  t.after(() => { view.close(); assert.deepEqual(view.warnings, []) })
  await settle()
  return { view, host, requests, ledger }
}
async function seed(view, messages = [row(), row('Stored answer **literal**', 'assistant')]) {
  view.state().chatHistory = messages
  await settle()
}
async function begin(view, text) {
  byClass(view, 'chat-input').props['onUpdate:modelValue'](text)
  await settle()
  const pending = byClass(view, 'send-btn').props.onClick()
  await settle()
  return { pending }
}
const counts = host => [host.calls.length, host.downloads.length, host.blobs.size, host.anchors.length]

test('empty or missing-context control is disabled and a disabled callback cannot later acquire history', async t => {
  const { view, host } = await setup(t)
  assert.equal(byId(view).props.type, 'button'); assert.equal(byId(view).props.disabled, true)
  const disabled = action(view)
  await seed(view)
  invoke(disabled); assert.deepEqual(counts(host), [0, 0, 0, 0])
  view.props.reportId = null; await settle(); assert.equal(byId(view).props.disabled, true)
})

for (const locale of ['en', 'zh']) test(`${locale} renders localized controls and honest outcome with fixed TXT attributes`, async t => {
  const { view, host, ledger } = await setup(t, { locale })
  await seed(view)
  assert.equal(textContent(byId(view)), locale === 'en' ? 'Download conversation TXT' : '下载对话 TXT')
  assert.equal(byId(view).props['aria-describedby'], 'report-conversation-download-note')
  assert.match(textContent(byId(view, 'report-conversation-download-note')), locale === 'en' ? /Chats aren’t restored/ : /刷新页面后不会恢复/)
  const before = [...ledger]
  invoke(action(view)); await settle()
  assert.equal(host.downloads.length, 1)
  assert.equal(host.downloads[0].filename, 'mirofish-report-conversation.txt')
  assert.equal(host.downloads[0].blob.type, 'text/plain;charset=utf-8')
  const text = await host.downloads[0].blob.text()
  assert.ok(text.startsWith('MiroFish Report Agent conversation\nformat_version: 1\n'))
  assert.ok(text.includes('report_id:\n  report_fixture\nsimulation_id:\n  sim_single\n'))
  assert.ok(text.endsWith('content:\n  Stored answer **literal**\n'))
  const status = byId(view, 'report-conversation-download-status')
  assert.equal(status.props.role, 'status'); assert.equal(status.props['aria-live'], 'polite')
  assert.match(textContent(status), locale === 'en' ? /saving the file isn’t confirmed/ : /尚未确认文件是否已保存/)
  assert.deepEqual(ledger, before); assert.ok(host.anchors.every(a => !a.attached)); assert.equal(host.blobs.size, 1)
})

test('ordinary successful and failed sends export the displayed session, excluding draft, caches and tool metadata', async t => {
  const { view, host, requests, ledger } = await setup(t)
  const first = await begin(view, 'First question')
  requests[0].resolve(ok({ response: 'Actual answer', tool_calls: [{ private: 'TOOL_ONLY' }] })); await first.pending; await settle()
  const stale = action(view)
  const second = await begin(view, 'Second question')
  assert.equal(byId(view).props.disabled, true)
  invoke(stale); assert.equal(host.calls.length, 0)
  requests[1].reject(new Error('synthetic offline')); await second.pending; await settle()
  view.state().chatInput = 'UNSENT_ONLY'
  view.state().chatHistoryCache.agent_0 = [row('OTHER_AGENT_ONLY')]
  view.state().surveyResults = [{ answer: 'SURVEY_ONLY' }]
  const history = JSON.stringify(view.state().chatHistory), before = [...ledger]
  invoke(action(view)); await settle()
  const text = await host.downloads[0].blob.text()
  assert.equal((text.match(/^Message \d+$/gm) || []).length, 4)
  for (const value of ['First question', 'Actual answer', 'Second question', 'synthetic offline']) assert.ok(text.includes(value))
  for (const value of ['UNSENT_ONLY', 'OTHER_AGENT_ONLY', 'SURVEY_ONLY', 'TOOL_ONLY']) assert.ok(!text.includes(value))
  assert.equal(JSON.stringify(view.state().chatHistory), history); assert.equal(view.state().chatInput, 'UNSENT_ONLY'); assert.deepEqual(ledger, before)
})

for (const field of ['reportId', 'simulationId']) for (const sameTick of [false, true]) test(`${field} A-B-A retires retained callbacks (${sameTick ? 'actual child props before flush' : 'settled parent renders'})`, async t => {
  const { view, host } = await setup(t); await seed(view)
  const old = action(view), props = sameTick ? view.childProps() : view.props, original = props[field]
  props[field] = 'replacement'; if (!sameTick) await settle()
  props[field] = original
  if (sameTick) { invoke(old); assert.equal(host.calls.length, 0, 'retire before the queued context-reset watcher runs') }
  await settle()
  await seed(view, [row('New current conversation')])
  invoke(old); assert.equal(host.calls.length, 0)
  invoke(action(view)); assert.equal(host.downloads.length, 1)
})

for (const target of ['agent', 'survey']) for (const sameTick of [false, true]) test(`${target} away-and-back retires retained selection (${sameTick ? 'same tick' : 'settled'})`, async t => {
  const { view, host } = await setup(t); await seed(view)
  const old = action(view)
  if (sameTick) {
    // Exercise actual child-ref transitions without replacing the source array.
    // Otherwise a source-identity check alone could hide a missing revision.
    if (target === 'agent') { view.state().chatTarget = 'agent'; view.state().chatTarget = 'report_agent' }
    else { view.state().activeTab = 'survey'; view.state().activeTab = 'chat' }
    invoke(old); assert.equal(host.calls.length, 0)
  } else {
    if (target === 'agent') view.state().selectAgent(view.state().profiles[0], 0)
    else view.state().selectSurveyTab()
    await settle(); assert.equal(byId(view), undefined)
    view.state().selectReportAgentChat()
  }
  await settle()
  invoke(old); assert.equal(host.calls.length, 0)
  invoke(action(view)); assert.equal(host.downloads.length, 1)
})

test('ordinary repeat clicks remain valid; a replaced source invalidates an old callback and cleans prior URLs', async t => {
  const { view, host } = await setup(t); await seed(view, Array.from({ length: 14 }, (_, i) => row(`turn ${i}`, i % 2 ? 'assistant' : 'user')))
  const repeat = action(view)
  invoke(repeat); invoke(repeat); await settle()
  assert.equal(host.downloads.length, 2); assert.equal(host.blobs.size, 1)
  assert.deepEqual(host.revoked, [host.downloads[0].url])
  assert.equal(normalizeTime(await host.downloads[0].blob.text()), normalizeTime(await host.downloads[1].blob.text()))
  assert.equal((await host.downloads[1].blob.text()).match(/^Message \d+$/gm).length, 14)
  await seed(view, [row('Replacement')]); const before = counts(host)
  invoke(repeat); assert.deepEqual(counts(host), before); assert.equal(host.blobs.size, 0)
})

test('immutable text capture survives a later source mutation at Blob construction', async t => {
  const { view, host } = await setup(t); await seed(view)
  host.hooks.blob = () => { delete host.hooks.blob; view.state().chatHistory[0].content = 'MUTATED_AFTER_CAPTURE' }
  invoke(action(view))
  const text = await host.downloads[0].blob.text()
  assert.ok(text.includes('Stored question')); assert.ok(!text.includes('MUTATED_AFTER_CAPTURE'))
})

const boundaries = ['blob', 'url', 'afterUrl', 'create', 'href', 'filename', 'append', 'click', 'afterClick', 'beforeRemove', 'afterRemove']
for (const stage of boundaries) test(`selection retirement at ${stage} stops stale continuation and releases its resources`, async t => {
  const { view, host } = await setup(t); await seed(view)
  host.hooks[stage] = () => { delete host.hooks[stage]; view.state().selectSurveyTab() }
  invoke(action(view)); await settle()
  assert.equal(host.blobs.size, 0); assert.ok(host.anchors.every(a => !a.attached))
  assert.ok(host.downloads.length <= 1, 'a reached click cannot be undone')
  assert.equal(byId(view, 'report-conversation-download-status'), undefined)
})

for (const stage of boundaries) test(`newer download reentry at ${stage} keeps the newer attempt and feedback`, async t => {
  const { view, host } = await setup(t); await seed(view)
  const current = action(view)
  host.hooks[stage] = () => { delete host.hooks[stage]; invoke(current) }
  invoke(current); await settle()
  assert.ok(host.downloads.length >= 1 && host.downloads.length <= 2)
  assert.equal(host.blobs.size, 1)
  assert.ok(host.downloads.some(d => host.blobs.has(d.url)), 'the retained URL belongs to a dispatched current attempt')
  assert.ok(host.anchors.every(a => !a.attached))
  assert.equal(byId(view, 'report-conversation-download-status').props.role, 'status')
})

test('reentry while revoking a previous successful URL wins over the older new invocation', async t => {
  const { view, host } = await setup(t); await seed(view); const current = action(view)
  invoke(current)
  host.hooks.revoke = () => { delete host.hooks.revoke; invoke(current) }
  invoke(current); await settle()
  assert.equal(host.downloads.length, 2); assert.equal(host.blobs.size, 1)
  assert.deepEqual(host.revoked, [host.downloads[0].url]); assert.ok(host.blobs.has(host.downloads[1].url))
})

for (const locale of ['en', 'zh']) test(`${locale} oversize and invalid text refuse before resources and recover on a valid retry`, async t => {
  const { view, host } = await setup(t, { locale })
  await seed(view, [row('a'.repeat(1048577))]); invoke(action(view)); await settle()
  assert.equal(host.calls.length, 0)
  const error = byId(view, 'report-conversation-download-error'); assert.equal(error.props.role, 'alert')
  assert.match(textContent(error), /1 MiB/)
  await seed(view, [row('Valid')]); view.state().chatHistory[0].timestamp = null
  invoke(action(view)); await settle(); assert.equal(host.calls.length, 0)
  assert.match(textContent(byId(view, 'report-conversation-download-error')), locale === 'en' ? /Couldn’t complete/ : /未能完成/)
  await seed(view); invoke(action(view)); await settle(); assert.equal(host.downloads.length, 1)
  assert.equal(byId(view, 'report-conversation-download-error'), undefined)
})

for (const stage of ['blob', 'url', 'create', 'href', 'filename', 'append', 'click', 'afterClick']) test(`primary ${stage} failure reports an honest error and cleans acquired resources`, async t => {
  const { view, host } = await setup(t); await seed(view)
  host.hooks[stage] = () => { delete host.hooks[stage]; throw new Error('synthetic failure') }
  invoke(action(view)); await settle()
  assert.match(textContent(byId(view, 'report-conversation-download-error')), /Check your browser’s downloads/)
  assert.equal(host.blobs.size, 0); assert.ok(host.anchors.every(a => !a.attached))
  assert.equal(host.downloads.length, stage === 'afterClick' ? 1 : 0)
})

test('cleanup exceptions are independent and do not turn a returned click into a false failure', async t => {
  const { view, host } = await setup(t); await seed(view)
  host.hooks.beforeRemove = () => { throw new Error('remove refused') }
  invoke(action(view)); await settle()
  assert.equal(host.downloads.length, 1); assert.equal(host.anchors[0].removeCalls, 1)
  assert.equal(byId(view, 'report-conversation-download-status').props.role, 'status')
  host.hooks.revoke = () => { throw new Error('revoke refused after recording attempt') }
  view.state().selectSurveyTab(); await settle()
  assert.deepEqual(host.revoked, [host.downloads[0].url]); assert.equal(host.blobs.size, 0)
})

test('unmount retires successful URLs, retained callbacks and late HTTP replies', async t => {
  const { view, host, requests } = await setup(t); await seed(view)
  const old = action(view); invoke(old)
  const send = await begin(view, 'Pending after download')
  view.close(); const before = counts(host)
  invoke(old); requests[0].resolve(ok({ response: 'LATE_REPLY' })); await send.pending; await settle()
  assert.deepEqual(counts(host), before); assert.equal(host.blobs.size, 0); assert.equal(host.downloads.length, 1)
})


test('a retired attempt failure cannot publish feedback into a returned Report Agent selection', async t => {
  const { view, host } = await setup(t); await seed(view)
  host.hooks.blob = () => {
    delete host.hooks.blob
    view.state().chatTarget = 'agent'; view.state().chatTarget = 'report_agent'
    throw new Error('stale failure')
  }
  invoke(action(view)); await settle()
  assert.equal(byId(view, 'report-conversation-download-error'), undefined)
  assert.equal(byId(view, 'report-conversation-download-status'), undefined)
  assert.equal(host.blobs.size, 0); assert.equal(host.downloads.length, 0)
})
