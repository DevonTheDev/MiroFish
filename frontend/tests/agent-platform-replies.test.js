import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick } from 'vue'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { renderMarkdown } from '../src/utils/content.js'

// Mount the actual Step5 script and template. Only API/document boundaries are
// local facades: no backend, network, model, browser, timer or campaign is run.
const ok = data => ({ success: true, data })
const dual = (twitter, reddit, id = 0) => ok({ result: { results: {
  [`twitter_${id}`]: { response: twitter }, [`reddit_${id}`]: { response: reddit },
} } })
const canonical = (twitter, reddit) => `Twitter:\n${twitter}\n\nReddit:\n${reddit}`
const snapshot = value => JSON.parse(JSON.stringify(value))
const byClass = (view, name) => view.all(node => String(node.props.class ?? '').split(' ').includes(name))
const textContent = node => [node.text ?? '', ...node.children.filter(child => child.type !== '#comment').map(textContent)].join(' ')
const labels = view => byClass(view, 'platform-reply-label').map(textContent)
const bodies = view => byClass(view, 'platform-reply-text').map(node => node.props.innerHTML)
const assistants = view => view.state().chatHistory.filter(item => item.role === 'assistant')
async function settle() {
  for (let i = 0; i < 14; i++) { await Promise.resolve(); await nextTick() }
}

async function setup(t, options) {
  const calls = Object.fromEntries(['getReport', 'getAgentLog', 'getSimulationProfilesRealtime',
    'chatWithReport', 'interviewAgents'].map(name => [name, []]))
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, resolve, reject })
  })]))
  const view = buildSurvey(api, options)
  let closed = false
  const close = () => { if (!closed) { closed = true; view.close() } }
  t.after(() => { close(); assert.deepEqual(view.warnings, []) })
  calls.getSimulationProfilesRealtime[0].resolve(ok({ profiles: [{ username: 'Alice' }, { username: 'Bob' }] }))
  calls.getReport[0].resolve(ok({}))
  await settle()
  calls.getAgentLog[0].resolve(ok({ logs: [] }))
  view.state().selectAgent(view.state().profiles[0], 0)
  await settle()
  const send = async (message = 'First question') => {
    byClass(view, 'chat-input')[0].props['onUpdate:modelValue'](message)
    await settle()
    byClass(view, 'send-btn')[0].props.onClick()
    await settle()
    return calls.interviewAgents.at(-1)
  }
  const respond = async response => {
    const request = await send()
    request.resolve(response)
    await settle()
  }
  return { view, calls, send, respond, close }
}

test('two exact platform replies produce one assistant turn and one unchanged interview request', async t => {
  const { view, calls, respond } = await setup(t)
  const twitter = '  Twitter original\n雪 ', reddit = 'Reddit original\n🌊  '
  await respond(dual(twitter, reddit))
  assert.equal(calls.interviewAgents.length, 1)
  assert.deepEqual(snapshot(calls.interviewAgents[0].args[0]), {
    simulation_id: 'sim_single', interviews: [{ agent_id: 0, prompt: 'First question' }],
  })
  assert.equal(calls.interviewAgents[0].args[1].aborted, false)
  assert.equal(calls.chatWithReport.length, 0)
  assert.equal(view.state().chatHistory.length, 2)
  assert.equal(assistants(view).length, 1)
  assert.equal(assistants(view)[0].content, canonical(twitter, reddit))
  assert.deepEqual(snapshot(assistants(view)[0].platformReplies), [
    { platform: 'twitter', content: twitter }, { platform: 'reddit', content: reddit },
  ])
  assert.deepEqual(labels(view), ['Twitter:', 'Reddit:'])
  assert.deepEqual(bodies(view), [twitter, reddit].map(renderMarkdown))
  assert.equal(view.state().isSending, false)
})

// Null/empty response fields occur in the native producer. Structured values and
// error records below are defensive fixtures, not claimed producer guarantees.
for (const platform of ['twitter', 'reddit']) {
  for (const [name, peer] of [
    ['absent', undefined], ['null response', { response: null }],
    ['empty response', { response: '' }], ['non-string response', { response: { answer: 'Not text' } }],
    ['error record', { error: 'No peer reply' }],
  ]) {
    test(`${platform} text stays exact and unlabelled with ${name} peer`, async t => {
      const { view, respond } = await setup(t)
      const text = '  **Only reply**\n雪\n '
      const results = { [`${platform}_0`]: { response: text } }
      if (peer !== undefined) results[`${platform === 'twitter' ? 'reddit' : 'twitter'}_0`] = peer
      await respond(ok({ results }))
      assert.equal(assistants(view).length, 1)
      assert.equal(assistants(view)[0].content, text)
      assert.equal(assistants(view)[0].platformReplies, undefined)
      assert.deepEqual(labels(view), [])
      assert.deepEqual(byClass(view, 'message-text').map(node => node.props.innerHTML), [renderMarkdown('First question'), renderMarkdown(text)])
    })
  }
}

test('response-or-answer aliases, exact keys and whitespace text retain chat compatibility', async t => {
  const { view, respond } = await setup(t)
  await respond(ok({ results: {
    // Chat has never imposed survey identity checks on these exact keyed rows.
    twitter_0: { response: '', answer: 'Alias Twitter', agent_id: 99, platform: 'reddit' },
    reddit_0: { response: null, answer: ' \n ', agent_id: 98, platform: 'twitter', error: 'Ignored metadata' },
    twitter_99: { response: 'Foreign text' },
  } }))
  assert.equal(assistants(view)[0].content, canonical('Alias Twitter', ' \n '))
  assert.deepEqual(bodies(view), ['Alias Twitter', ' \n '].map(renderMarkdown))
})

test('truthy non-string response does not use its answer alias when the other exact platform has text', async t => {
  const { view, respond } = await setup(t)
  await respond(ok({ results: { reddit_0: { response: { invalid: true }, answer: 'Not selected' }, twitter_0: { response: 'Usable text' } } }))
  assert.equal(assistants(view)[0].content, 'Usable text')
  assert.deepEqual(labels(view), [])
})

for (const [name, data, expected] of [
  ['nested result dictionary', { result: { results: { other: { response: 'First legacy record' } } } }, 'First legacy record'],
  ['result dictionary', { results: { legacy: { answer: 'Legacy alias' }, another: { response: 'Second ignored' } } }, 'Legacy alias'],
  ['direct dictionary', { other: { response: 'Direct text' } }, 'Direct text'],
  ['nested array', { result: { results: [{ answer: 'First array record' }, { response: 'Second ignored' }] } }, 'First array record'],
  ['direct array', [{ response: 'Direct array' }], 'Direct array'],
  ['foreign keyed fallback', { results: { twitter_77: { response: 'Legacy foreign fallback' } } }, 'Legacy foreign fallback'],
  ['truthy structured legacy text', { results: { other: { response: { old: 'behavior' } } } }, { old: 'behavior' }],
]) {
  test(`no usable exact-key text preserves ${name}`, async t => {
    const { view, respond } = await setup(t)
    await respond(ok(data))
    assert.deepEqual(snapshot(assistants(view)[0].content), expected)
    assert.equal(assistants(view)[0].platformReplies, undefined)
    assert.deepEqual(labels(view), [])
  })
}

for (const [name, response, expected] of [
  ['empty dictionary', ok({ results: {} }), 'No response'],
  ['empty array', ok({ results: [] }), 'No response'],
  ['empty exact records', ok({ results: { twitter_0: { response: '' }, reddit_0: { response: null } } }), 'No response'],
  ['false success', { success: false, error: 'Batch rejected' }, 'Batch rejected'],
]) {
  test(`${name} retains one existing error turn and releases pending ownership`, async t => {
    const { view, respond } = await setup(t)
    await respond(response)
    assert.equal(assistants(view).length, 1)
    assert.equal(assistants(view)[0].content, `Sorry, an error occurred: ${expected}`)
    assert.deepEqual(labels(view), [])
    assert.equal(view.state().isSending, false)
  })
}

test('rejected request retains its error and permits a later send', async t => {
  const { view, calls, send } = await setup(t)
  const first = await send()
  first.reject(new Error('Transport rejected'))
  await settle()
  assert.equal(assistants(view)[0].content, 'Sorry, an error occurred: Transport rejected')
  assert.equal(view.state().isSending, false)
  const second = await send('Try again')
  assert.equal(calls.interviewAgents.length, 2)
  second.resolve(dual('New Twitter', 'New Reddit'))
  await settle()
  assert.equal(assistants(view).at(-1).content, canonical('New Twitter', 'New Reddit'))
})

test('shared follow-up prompt includes each visible canonical turn once within the six-message cap', async t => {
  const { view, calls, send } = await setup(t)
  const history = []
  for (let index = 0; index < 5; index++) {
    const message = `Question ${index}`, twitter = `Twitter answer ${index}`, reddit = `Reddit answer ${index}`
    const request = await send(message)
    const expected = history.length
      ? `以下是我们之前的对话：\n${history.slice(-6).map(item => `${item.role === 'user' ? '提问者' : '你'}：${item.content}`).join('\n')}\n\n现在我的新问题是：${message}`
      : message
    assert.equal(request.args[0].interviews[0].prompt, expected)
    assert.equal(request.args[0].interviews.length, 1)
    if (index === 4) {
      assert.doesNotMatch(expected, /Question 0|answer 0/)
      for (let previous = 1; previous < 4; previous++) {
        assert.equal(expected.split(canonical(`Twitter answer ${previous}`, `Reddit answer ${previous}`)).length - 1, 1)
      }
    }
    request.resolve(dual(twitter, reddit))
    await settle()
    const content = canonical(twitter, reddit)
    assert.equal(assistants(view).at(-1).content, content)
    history.push({ role: 'user', content: message }, { role: 'assistant', content })
  }
  assert.equal(calls.interviewAgents.length, 5)
  assert.equal(view.state().chatHistory.length, 10)
})

test('pending duplicate send, tab and agent switches preserve both replies in the captured cache', async t => {
  const { view, calls, send } = await setup(t)
  const first = await send()
  view.state().chatInput = 'Keep unsent draft'
  view.state().sendMessage()
  view.state().selectAgent(view.state().profiles[1], 1)
  view.state().sendMessage()
  await settle()
  assert.equal(calls.interviewAgents.length, 1)
  assert.equal(view.state().isSending, true)
  assert.equal(view.state().chatInput, 'Keep unsent draft')
  first.resolve(ok({ results: {
    twitter_0: { response: 'Alice Twitter' }, reddit_0: { response: 'Alice Reddit' },
    reddit_1: { response: 'Wrong agent' },
  } }))
  await settle()
  assert.equal(view.state().chatHistory.length, 0)
  assert.equal(view.state().isSending, false)
  assert.equal(view.state().chatHistoryCache.agent_0.length, 2)
  view.state().selectAgent(view.state().profiles[0], 0)
  await settle()
  const original = snapshot(assistants(view)[0])
  assert.equal(original.content, canonical('Alice Twitter', 'Alice Reddit'))
  assert.deepEqual(labels(view), ['Twitter:', 'Reddit:'])
  view.state().selectSurveyTab()
  await settle()
  view.state().selectReportAgentChat()
  await settle()
  assert.equal(view.state().chatHistory.length, 0)
  assert.deepEqual(labels(view), [])
  view.state().selectAgent(view.state().profiles[0], 0)
  await settle()
  assert.deepEqual(snapshot(assistants(view)[0]), original)
  assert.deepEqual(bodies(view), ['Alice Twitter', 'Alice Reddit'].map(renderMarkdown))
})

for (const outcome of ['success', 'failure']) {
  test(`A to B to A discards late ${outcome} without unlocking the new dual reply request`, async t => {
    const { view, calls, send } = await setup(t)
    const old = await send('Old question')
    Object.assign(view.props, { reportId: 'B', simulationId: 'SB' })
    await settle()
    Object.assign(view.props, { reportId: 'report_fixture', simulationId: 'sim_single' })
    await settle()
    view.state().selectAgent({ username: 'Current Alice' }, 0)
    await settle()
    const current = await send('Current question')
    const before = snapshot(view.state().chatHistory), beforeLogs = [...view.emitted]
    if (outcome === 'success') old.resolve(dual('Stale Twitter', 'Stale Reddit'))
    else old.reject(new Error('Stale failure'))
    await settle()
    assert.equal(old.args[1].aborted, true)
    assert.equal(current.args[1].aborted, false)
    assert.equal(view.state().isSending, true)
    assert.deepEqual(snapshot(view.state().chatHistory), before)
    assert.deepEqual(view.emitted, beforeLogs)
    assert.deepEqual(labels(view), [])
    current.resolve(dual('Current Twitter', 'Current Reddit'))
    await settle()
    assert.equal(calls.interviewAgents.length, 2)
    assert.equal(view.state().isSending, false)
    assert.equal(assistants(view)[0].content, canonical('Current Twitter', 'Current Reddit'))
  })
  test(`unmount discards late ${outcome}, cache writes and logs`, async t => {
    const { view, send, close } = await setup(t)
    const request = await send()
    close()
    const before = snapshot(view.state().chatHistoryCache), beforeLogs = [...view.emitted]
    if (outcome === 'success') request.resolve(dual('Late Twitter', 'Late Reddit'))
    else request.reject(new Error('Late failure'))
    await settle()
    assert.equal(request.args[1].aborted, true)
    assert.deepEqual(snapshot(view.state().chatHistoryCache), before)
    assert.deepEqual(view.emitted, beforeLogs)
    assert.equal(view.listeners.size, 0)
  })
}

for (const locale of ['en', 'zh']) {
  test(`${locale} renders independent Markdown, invariant plain labels and escaped Unicode/HTML`, async t => {
    const { view, respond } = await setup(t, { locale })
    const twitter = '雪 **Twitter**\n<script>alert(1)</script>\n```js\nUnclosed fence',
      reddit = '海 **Reddit**\n<img src=x onerror=alert(2)>\n```\nSecond line'
    await respond(dual(twitter, reddit))
    assert.equal(assistants(view)[0].content, canonical(twitter, reddit))
    assert.deepEqual(labels(view), ['Twitter:', 'Reddit:'])
    assert.equal(byClass(view, 'platform-reply-label').every(node => node.props.innerHTML === undefined), true)
    assert.deepEqual(bodies(view), [twitter, reddit].map(renderMarkdown))
    assert.doesNotMatch(bodies(view).join(''), /<script\b|<img\b|<pre\b/)
    assert.match(bodies(view)[0], /雪 <strong>Twitter<\/strong>/)
    assert.match(bodies(view)[1], /海 <strong>Reddit<\/strong>/)
    assert.deepEqual(view.warnings, [])
  })
}
