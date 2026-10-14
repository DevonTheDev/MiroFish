import assert from 'node:assert/strict'
import test from 'node:test'
import { toRaw } from 'vue'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { settle, textContent } from './helpers/simulation-platform-fixture.js'

// The actual Step5 script/template, Vue renderer and both locales run here.
// Deferred local API facades record every request; no transport/model is used.
const ok = data => ({ success: true, data })
const byClass = (view, name) => view.all(node => String(node.props.class ?? '').split(' ').includes(name))
const actionbar = view => byClass(view, 'action-bar')[0]
const retryButton = view => byClass(view, 'profiles-retry-btn')[0]
const catalogueStatus = view => byClass(view, 'profile-catalogue-status')[0]
const catalogueError = view => byClass(view, 'profile-catalogue-error')[0]
const snapshot = value => JSON.parse(JSON.stringify(value))

function setup(t, options) {
  const ledger = []
  const calls = Object.fromEntries(['getReport', 'getAgentLog', 'getSimulationProfilesRealtime',
    'chatWithReport', 'interviewAgents'].map(name => [name, []]))
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    const request = { name, args, resolve, reject }
    ledger.push(request)
    calls[name].push(request)
  })]))
  const view = buildSurvey(api, options)
  let closed = false
  const close = () => { if (!closed) { closed = true; view.close() } }
  t.after(() => { close(); assert.deepEqual(view.warnings, []) })
  return { view, calls, ledger, close, profiles: calls.getSimulationProfilesRealtime }
}

async function fail(request, message = 'Private transport detail') {
  request.reject(new Error(message))
  await settle()
}

test('initial pending catalogue replaces zero count on both tabs and starts one read', async t => {
  const { view, calls, profiles, ledger } = setup(t)
  await settle()
  assert.equal(profiles.length, 1)
  assert.equal(calls.getReport.length, 1)
  assert.deepEqual(ledger.map(item => item.name), ['getReport', 'getSimulationProfilesRealtime'])
  assert.equal(profiles[0].args[0], 'sim_single')
  assert.equal(profiles[0].args[1], undefined)
  assert.ok(profiles[0].args[2] instanceof AbortSignal)
  assert.equal(profiles[0].args[2], calls.getReport[0].args[1])
  for (const tab of ['chat', 'survey', 'chat']) {
    view.state().activeTab = tab
    await settle()
    assert.match(textContent(actionbar(view)), /Loading agent profiles/)
    assert.doesNotMatch(textContent(actionbar(view)), /0 agents available/)
    assert.equal(catalogueStatus(view).props.role, 'status')
    assert.equal(catalogueStatus(view).props['aria-live'], 'polite')
    assert.equal(retryButton(view), undefined)
  }
  assert.equal(profiles.length, 1, 'tab changes cannot refresh the catalogue')
})

for (const props of [{ reportId: null }, { simulationId: null }, { reportId: null, simulationId: null }]) {
  test(`incomplete context stays idle without count or read: ${JSON.stringify(props)}`, async t => {
    const { view, ledger } = setup(t, { props })
    await settle()
    assert.equal(ledger.length, 0)
    assert.equal(catalogueStatus(view), undefined)
    assert.equal(catalogueError(view), undefined)
    assert.equal(retryButton(view), undefined)
    assert.doesNotMatch(textContent(actionbar(view)), /agents available|Loading agent profiles/)
  })
}

const invalidEnvelopes = [
  ['unsuccessful', { success: false, error: 'Private envelope detail' }],
  ['null envelope', null], ['missing data', { success: true }],
  ['non-boolean success', { success: 1, data: { profiles: [] } }],
  ['null data', ok(null)], ['array data', ok([])], ['string data', ok('not data')],
  ['missing profiles', ok({})], ['null profiles', ok({ profiles: null })],
  ['object profiles', ok({ profiles: { 0: { username: 'Alice' } } })],
  ['string profiles', ok({ profiles: 'not profiles' })],
  ...[null, [], 'bad', 7, true].map(row => [`invalid row ${JSON.stringify(row)}`,
    ok({ profiles: [{ username: 'Keep index zero' }, row, { name: 'Keep index two' }] })]),
]
for (const [name, response] of invalidEnvelopes) {
  test(`${name} rejects the whole catalogue with a generic error and retry`, async t => {
    const { view, profiles, ledger } = setup(t)
    profiles[0].resolve(response)
    await settle()
    assert.equal(view.state().profiles.length, 0)
    assert.equal(catalogueError(view).props.role, 'alert')
    assert.equal(textContent(catalogueError(view)), 'Could not load agent profiles')
    assert.doesNotMatch(textContent(actionbar(view)), /agents available|Private|Keep index/)
    assert.equal(retryButton(view).type, 'button')
    assert.equal(retryButton(view).props.type, 'button')
    assert.equal(retryButton(view).props.disabled, false)
    assert.equal(view.emitted.filter(line => line.startsWith('Failed to load simulated individuals:')).length, 1)
    if (response?.error) assert.ok(view.emitted.some(line => line.includes(response.error)))
    assert.deepEqual(ledger.map(item => item.name), ['getReport', 'getSimulationProfilesRealtime'])
  })
}

test('sparse records are accepted in original order without copying or assigning identities', async t => {
  const { view, profiles } = setup(t)
  const rows = [{ name: 'Only name' }, {}, { username: 'Third', custom: { keep: true } }]
  profiles[0].resolve(ok({ profiles: rows, count: 1000, status: 'preparing', error: 'metadata only' }))
  await settle()
  assert.equal(toRaw(view.state().profiles), rows)
  rows.forEach((row, index) => assert.equal(toRaw(view.state().profiles[index]), row))
  assert.match(textContent(actionbar(view)), /3 agents available/)
  assert.equal(retryButton(view), undefined)
  assert.equal(catalogueError(view), undefined)
  assert.ok(view.emitted.includes('Loaded 3 simulated individuals'))
  view.state().selectSurveyTab()
  await settle()
  assert.equal(byClass(view, 'agent-checkbox').length, 3)
  assert.equal(profiles.length, 1)
})

for (const metadata of [{}, { status: 'preparing', count: 5 }, { status: 'failed', error: 'swallowed file failure' },
  { status: null, file_exists: false }]) {
  test(`accepted empty catalogue is honest and final with metadata ${JSON.stringify(metadata)}`, async t => {
    const { view, profiles } = setup(t)
    profiles[0].resolve(ok({ ...metadata, profiles: [] }))
    await settle()
    assert.equal(textContent(catalogueStatus(view)), 'No agent profiles available')
    assert.equal(catalogueStatus(view).props.role, 'status')
    assert.equal(catalogueStatus(view).props['aria-live'], 'polite')
    assert.equal(catalogueError(view), undefined)
    assert.equal(retryButton(view), undefined)
    assert.doesNotMatch(textContent(actionbar(view)), /complete|preparing|failed|0 agents available/i)
    view.state().selectSurveyTab()
    await settle()
    assert.equal(textContent(catalogueStatus(view)), 'No agent profiles available')
    assert.equal(byClass(view, 'survey-selected-only').length, 0)
    assert.equal(profiles.length, 1)
  })
}

for (const rows of [[{ username: 'Recovered' }], []]) {
  test(`failure and repeated retry failure retire the control after accepting ${rows.length} profiles`, async t => {
    const { view, profiles, ledger, calls } = setup(t)
    await fail(profiles[0])
    assert.ok(view.emitted.includes('Failed to load simulated individuals: Private transport detail'))
    const firstButton = retryButton(view), firstRetry = firstButton.props.onClick
    const signal = profiles[0].args[2]
    firstRetry()
    firstRetry()
    await settle()
    assert.equal(profiles.length, 2)
    assert.equal(retryButton(view), firstButton, 'retain a disabled button during retry')
    assert.equal(firstButton.props.disabled, true)
    assert.match(textContent(actionbar(view)), /Loading agent profiles/)
    assert.equal(catalogueError(view), undefined)
    assert.equal(profiles[1].args[2], signal)
    assert.equal(signal.aborted, false)
    assert.equal(calls.getReport.length, 1)
    await fail(profiles[1], 'Second failure')
    const currentRetry = retryButton(view).props.onClick
    firstRetry()
    await settle()
    assert.equal(profiles.length, 2, 'a retained handler from an older failure owns no new retry')
    currentRetry()
    queueMicrotask(currentRetry)
    await settle()
    assert.equal(profiles.length, 3)
    assert.equal(retryButton(view).props.disabled, true)
    profiles[2].resolve(ok({ profiles: rows }))
    await settle()
    assert.equal(retryButton(view), undefined)
    assert.equal(catalogueError(view), undefined)
    assert.match(textContent(actionbar(view)), rows.length ? /1 agents available/ : /No agent profiles available/)
    firstRetry(); currentRetry()
    view.state().selectSurveyTab()
    await settle()
    assert.equal(profiles.length, 3)
    assert.deepEqual(ledger.map(item => item.name), ['getReport', ...Array(3).fill('getSimulationProfilesRealtime')])
    assert.equal(signal.aborted, false)
  })
}

for (const outcome of ['success', 'failure']) {
  test(`A to B to A ignores late retry ${outcome}, logs, finally and retained old handlers`, async t => {
    const { view, profiles } = setup(t, { props: { reportId: 'A', simulationId: 'SA' } })
    await fail(profiles[0])
    const oldRetry = retryButton(view).props.onClick
    oldRetry(); await settle()
    const oldRequest = profiles[1]
    Object.assign(view.props, { reportId: 'B', simulationId: 'SB' })
    await settle()
    Object.assign(view.props, { reportId: 'A', simulationId: 'SA' })
    await settle()
    assert.equal(profiles.length, 4)
    assert.equal(oldRequest.args[2].aborted, true)
    const beforeLogs = [...view.emitted]
    if (outcome === 'success') oldRequest.resolve(ok({ profiles: [{ username: 'Stale A' }] }))
    else oldRequest.reject(new Error('Stale A failure'))
    await settle()
    assert.deepEqual(view.emitted, beforeLogs)
    assert.equal(view.state().profiles.length, 0)
    assert.match(textContent(actionbar(view)), /Loading agent profiles/)
    oldRetry()
    assert.equal(profiles.length, 4)
    await fail(profiles[3], 'Current A failure')
    const currentRetry = retryButton(view).props.onClick
    oldRetry()
    assert.equal(profiles.length, 4, 'matching IDs do not revive an earlier generation')
    currentRetry(); await settle()
    assert.equal(profiles.length, 5, 'old finally cannot release or strand the current request')
    oldRetry(); currentRetry()
    assert.equal(profiles.length, 5)
    profiles[4].resolve(ok({ profiles: [{ username: 'Current A' }] }))
    await settle()
    assert.equal(view.state().profiles[0].username, 'Current A')
  })
}

for (const transition of ['clear', 'unmount']) {
  for (const outcome of ['success', 'failure']) {
    test(`${transition} ignores late retry ${outcome} and retained retry`, async t => {
      const { view, profiles, close } = setup(t)
      await fail(profiles[0])
      const oldRetry = retryButton(view).props.onClick
      oldRetry(); await settle()
      const request = profiles[1]
      if (transition === 'clear') {
        Object.assign(view.props, { reportId: null, simulationId: null })
        await settle()
      } else close()
      const beforeLogs = [...view.emitted]
      if (outcome === 'success') request.resolve(ok({ profiles: [{ username: 'Late' }] }))
      else request.reject(new Error('Late failure'))
      await settle()
      oldRetry()
      assert.equal(request.args[2].aborted, true)
      assert.equal(profiles.length, 2)
      assert.equal(view.state().profiles.length, 0)
      assert.deepEqual(view.emitted, beforeLogs)
      if (transition === 'clear') {
        assert.equal(retryButton(view), undefined)
        assert.equal(catalogueStatus(view), undefined)
        assert.equal(catalogueError(view), undefined)
        assert.doesNotMatch(textContent(actionbar(view)), /agents available/)
      } else assert.equal(view.listeners.size, 0)
    })
  }
}

test('retry preserves pending report chat, input, history, cache and shared signal', async t => {
  const { view, profiles, calls, ledger } = setup(t)
  calls.getReport[0].resolve(ok({}))
  await settle()
  calls.getAgentLog[0].resolve(ok({ logs: [{ action: 'planning_complete', details: { outline: { title: 'Kept report', sections: [] } } }] }))
  await settle()
  view.state().chatHistory = [{ role: 'assistant', content: 'Earlier answer' }]
  view.state().chatInput = 'Continue report'
  view.state().sendMessage()
  await settle()
  view.state().chatInput = 'Unsent draft'
  view.state().surveyQuestion = 'Unsubmitted question'
  const chat = calls.chatWithReport[0]
  const history = view.state().chatHistory, cache = view.state().chatHistoryCache
  await fail(profiles[0])
  const before = ledger.length
  retryButton(view).props.onClick()
  await settle()
  assert.deepEqual(ledger.slice(before).map(item => item.name), ['getSimulationProfilesRealtime'])
  assert.equal(view.state().chatHistory, history)
  assert.equal(view.state().chatHistoryCache, cache)
  assert.equal(view.state().chatInput, 'Unsent draft')
  assert.equal(view.state().isSending, true)
  assert.equal(view.state().surveyQuestion, 'Unsubmitted question')
  assert.equal(view.state().reportOutline.title, 'Kept report')
  assert.equal(profiles[1].args[2], chat.args[1])
  assert.equal(chat.args[1].aborted, false)
  profiles[1].resolve(ok({ profiles: [{ username: 'Recovered agent' }] }))
  await settle()
  assert.equal(view.state().isSending, true)
  chat.resolve(ok({ response: 'Report answer survived' }))
  await settle()
  assert.equal(view.state().chatHistory.at(-1).content, 'Report answer survived')
  assert.equal(view.state().chatInput, 'Unsent draft')
  assert.equal(view.state().isSending, false)
})

test('retired retry cannot change accepted indices, pending agent chat or survey state/results', async t => {
  const { view, profiles, calls, ledger } = setup(t)
  await fail(profiles[0])
  const retiredRetry = retryButton(view).props.onClick
  retiredRetry(); await settle()
  profiles[1].resolve(ok({ profiles: [{ username: 'Alice' }, { username: 'Bob' }] }))
  await settle()
  view.state().selectAgent(view.state().profiles[1], 1)
  view.state().chatInput = 'Question for Bob'
  view.state().sendMessage()
  await settle()
  view.state().selectSurveyTab()
  await settle()
  const checkbox = byClass(view, 'agent-checkbox')[0].children.find(node => node.type === 'input')
  checkbox.props.onChange()
  byClass(view, 'survey-input')[0].props['onUpdate:modelValue']('Survey for Alice')
  await settle()
  byClass(view, 'survey-submit-btn')[0].props.onClick()
  await settle()
  assert.equal(calls.interviewAgents.length, 2)
  assert.equal(calls.interviewAgents[0].args[0].interviews[0].agent_id, 1)
  assert.equal(calls.interviewAgents[1].args[0].interviews[0].agent_id, 0)
  const before = ledger.length, accepted = view.state().profiles, history = view.state().chatHistory
  retiredRetry(); await settle()
  assert.equal(ledger.length, before)
  assert.equal(view.state().profiles, accepted)
  assert.equal(view.state().selectedAgent, accepted[1])
  assert.equal(view.state().selectedAgentIndex, 1)
  assert.equal(view.state().chatHistory, history)
  assert.equal(view.state().isSending, true)
  assert.equal(view.state().isSurveying, true)
  assert.deepEqual(Array.from(view.state().selectedAgents), [0])
  assert.equal(view.state().surveyQuestion, 'Survey for Alice')
  calls.interviewAgents[0].resolve(ok({ results: { twitter_1: { response: 'Bob survives' } } }))
  calls.interviewAgents[1].resolve(ok({ result: { platform: 'twitter', results: { twitter_0: { response: 'Alice survives' } } } }))
  await settle()
  assert.equal(view.state().chatHistoryCache.agent_1.at(-1).content, 'Bob survives')
  assert.equal(view.state().surveyResults[0].replies[0].answer, 'Alice survives')
  const results = snapshot(view.state().surveyResults)
  retiredRetry(); await settle()
  assert.equal(ledger.length, before)
  assert.deepEqual(snapshot(view.state().surveyResults), results)
  assert.equal(view.state().selectedAgentIndex, 1)
})

for (const [locale, loading, error, retry, empty] of [
  ['en', 'Loading agent profiles…', 'Could not load agent profiles', 'Retry loading profiles', 'No agent profiles available'],
  ['zh', '正在加载个体档案…', '无法加载个体档案', '重试加载档案', '暂无可用的个体档案'],
]) {
  test(`${locale} catalogue feedback is localized and accessible in both tabs`, async t => {
    const { view, profiles } = setup(t, { locale })
    await settle()
    assert.equal(textContent(catalogueStatus(view)), loading)
    await fail(profiles[0], '<script>private transport detail</script>')
    for (const tab of ['chat', 'survey']) {
      view.state().activeTab = tab
      await settle()
      assert.equal(textContent(catalogueError(view)), error)
      assert.equal(catalogueError(view).props.role, 'alert')
      assert.equal(textContent(retryButton(view)), retry)
      assert.equal(retryButton(view).props.type, 'button')
      assert.doesNotMatch(textContent(actionbar(view)), /private transport|step5\./)
    }
    retryButton(view).props.onClick()
    await settle()
    assert.equal(retryButton(view).props.disabled, true)
    assert.equal(textContent(catalogueStatus(view)), loading)
    profiles[1].resolve(ok({ profiles: [] }))
    await settle()
    assert.equal(textContent(catalogueStatus(view)), empty)
    assert.equal(retryButton(view), undefined)
  })
}
