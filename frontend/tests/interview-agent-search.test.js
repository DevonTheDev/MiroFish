import assert from 'node:assert/strict'
import test from 'node:test'
import { toRaw } from 'vue'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { settle, textContent } from './helpers/simulation-platform-fixture.js'

// Actual compiled Step5, real Vue/i18n and existing synthetic host. API calls
// are deferred local facades; this does not test native browser geometry.
const ok = data => ({ success: true, data })
const snapshot = value => JSON.parse(JSON.stringify(value))
const byClass = (view, name) => view.all(node => String(node.props.class ?? '').split(' ').includes(name))
const control = (view, name) => byClass(view, name)[0]
const rows = (view, mode) => byClass(view, mode === 'chat' ? 'dropdown-item' : 'agent-checkbox')
const matches = (view, mode) => view.state()[mode === 'chat' ? 'chatAgentMatches' : 'surveyAgentMatches']

async function setup(t, profiles, locale = 'en') {
  const ledger = []
  const calls = Object.fromEntries(['getReport', 'getAgentLog', 'getSimulationProfilesRealtime',
    'chatWithReport', 'interviewAgents'].map(name => [name, []]))
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    const request = { name, args, resolve, reject }
    ledger.push(request)
    calls[name].push(request)
  })]))
  const view = buildSurvey(api, { locale })
  t.after(() => { view.close(); assert.deepEqual(view.warnings, []) })
  calls.getSimulationProfilesRealtime[0].resolve(ok({ profiles }))
  calls.getReport[0].resolve(ok({}))
  await settle()
  calls.getAgentLog[0].resolve(ok({ logs: [] }))
  await settle()
  return { view, ledger, calls }
}

async function openPicker(view, mode) {
  control(view, mode === 'chat' ? 'agent-pill' : 'survey-pill').props.onClick()
  await settle()
}

async function search(view, mode, query) {
  control(view, `${mode}-agent-search`).props['onUpdate:modelValue'](query)
  await settle()
}

const words = {
  en: { label: 'Find agents', clear: 'Clear search', empty: 'No agents match your search',
    count: '1 of 6 agents match', all: 'Select all 6 agents', clearAll: 'Clear all selections',
    hidden: 'Selected agents hidden by search: 1' },
  zh: { label: '查找智能体', clear: '清除搜索', empty: '没有符合搜索条件的智能体',
    count: '匹配 1 / 6 个智能体', all: '选择全部 6 个智能体', clearAll: '清空全部选择',
    hidden: '有 1 个已选智能体被搜索隐藏' },
}

for (const locale of ['en', 'zh']) {
  for (const mode of ['chat', 'survey']) {
    test(`${locale} ${mode} search matches string fields literally, shows counts and clears through rendered controls`, async t => {
      const profiles = [
        { username: 'Alice [QA]', name: 'elodie', profession: 'Engineer' },
        { username: 'Bob', name: '李雪', profession: 'Urban Planner' },
        { username: 'Other', name: 'Élodie', profession: 'C++ Developer' },
        { username: 'literal.*', name: 'A|B', profession: 'Writer' },
        { username: 47, name: true, profession: { text: 'Do not search this' } }, {},
      ]
      const { view, ledger } = await setup(t, profiles, locale)
      await openPicker(view, mode)
      const input = control(view, `${mode}-agent-search`)
      assert.equal(input.type, 'input')
      assert.equal(input.props.type, 'search')
      assert.equal(input.parent.type, 'label')
      assert.match(textContent(input.parent), new RegExp(words[locale].label))
      assert.equal(control(view, 'agent-search-clear'), undefined)
      assert.equal(rows(view, mode).length, 6)
      for (const [query, expected] of [
        [' ALIce ', [0]], ['[qa]', [0]], ['ELODIE', [0]], ['ÉLODIE', [2]],
        ['雪', [1]], ['planner', [1]], ['c++', [2]], ['.*', [3]], ['a|b', [3]],
        ['47', []], ['true', []], ['[object Object]', []], ['Do not search', []], ['missing', []],
        ['  \t ', [0, 1, 2, 3, 4, 5]],
      ]) {
        await search(view, mode, query)
        assert.deepEqual(snapshot(matches(view, mode).map(entry => entry.originalIndex)), expected, query)
        assert.equal(rows(view, mode).length, expected.length, query)
        assert.equal(Boolean(control(view, 'agent-search-empty')), expected.length === 0, query)
        if (expected.length === 0) assert.equal(textContent(control(view, 'agent-search-empty')), words[locale].empty)
      }
      await search(view, mode, 'planner')
      assert.equal(textContent(control(view, 'agent-search-count')), words[locale].count)
      assert.equal(control(view, 'agent-search-count').props['aria-live'], 'polite')
      const clear = control(view, 'agent-search-clear')
      assert.equal(clear.props.type, 'button')
      assert.equal(textContent(clear), words[locale].clear)
      clear.props.onClick()
      await settle()
      assert.equal(control(view, `${mode}-agent-search`).value, '')
      assert.equal(rows(view, mode).length, 6)
      assert.equal(toRaw(view.state().profiles), profiles)
      profiles.forEach((profile, index) => assert.equal(toRaw(view.state().profiles[index]), profile))
      assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog'])
    })
  }

  test(`${locale} independent queries preserve hidden survey selections and make bulk actions global`, async t => {
    const profiles = Array.from({ length: 6 }, (_, index) => ({ username: `Agent ${index}` }))
    const { view, ledger } = await setup(t, profiles, locale)
    await openPicker(view, 'chat')
    await search(view, 'chat', 'Agent 5')
    await openPicker(view, 'survey')
    assert.equal(control(view, 'survey-agent-search').value, '')
    rows(view, 'survey')[5].children.find(node => node.type === 'input').props.onChange()
    await search(view, 'survey', 'Agent 0')
    assert.deepEqual([...view.state().selectedAgents], [5])
    assert.equal(textContent(control(view, 'agent-search-hidden')), words[locale].hidden)
    const [selectAll, clearAll] = byClass(view, 'action-link')
    assert.equal(textContent(selectAll), words[locale].all)
    assert.equal(textContent(clearAll), words[locale].clearAll)
    selectAll.props.onClick()
    await settle()
    assert.deepEqual([...view.state().selectedAgents], [0, 1, 2, 3, 4, 5])
    assert.equal(rows(view, 'survey')[0].children.find(node => node.type === 'input').props.checked, true)
    assert.equal(view.state().hiddenSelectedAgentCount, 5)
    await search(view, 'survey', 'no match')
    assert.equal(view.state().hiddenSelectedAgentCount, 6)
    clearAll.props.onClick()
    await settle()
    assert.equal(view.state().selectedAgents.size, 0)
    assert.equal(control(view, 'agent-search-hidden'), undefined)
    await openPicker(view, 'chat')
    assert.equal(control(view, 'chat-agent-search').value, 'Agent 5')
    control(view, 'agent-search-clear').props.onClick()
    await openPicker(view, 'survey')
    assert.equal(control(view, 'survey-agent-search').value, 'no match')
    assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog'])
  })
}

test('1,000 profiles keep original index 999 for chat, cache and survey while searches change during requests', async t => {
  const profiles = Array.from({ length: 1000 }, (_, index) => ({ username: `Person ${String(index).padStart(4, '0')}` }))
  const { view, calls, ledger } = await setup(t, profiles)
  await openPicker(view, 'chat')
  assert.equal(rows(view, 'chat').length, 1000, 'no result cap')
  await search(view, 'chat', 'person 0999')
  rows(view, 'chat')[0].props.onClick()
  await settle()
  assert.equal(view.state().selectedAgentIndex, 999)
  assert.equal(toRaw(view.state().selectedAgent), profiles[999])
  control(view, 'chat-input').props['onUpdate:modelValue']('Last agent question')
  await settle()
  control(view, 'send-btn').props.onClick()
  await settle()
  const chatRequest = calls.interviewAgents[0]
  assert.deepEqual(snapshot(chatRequest.args[0]), {
    simulation_id: 'sim_single', interviews: [{ agent_id: 999, prompt: 'Last agent question' }],
  })
  const history = view.state().chatHistory
  await openPicker(view, 'chat')
  await search(view, 'chat', 'no match')
  control(view, 'agent-search-clear').props.onClick()
  await settle()
  assert.equal(view.state().selectedAgentIndex, 999)
  assert.equal(view.state().chatHistory, history)
  assert.equal(view.state().isSending, true)
  assert.equal(chatRequest.args[1].aborted, false)
  assert.equal(calls.interviewAgents.length, 1)
  chatRequest.resolve(ok({ results: {
    twitter_999: { response: 'Twitter last' }, reddit_999: { response: 'Reddit last' },
  } }))
  await settle()
  assert.equal(view.state().isSending, false)
  assert.equal(view.state().chatHistory[1].content, 'Twitter:\nTwitter last\n\nReddit:\nReddit last')
  assert.deepEqual(snapshot(view.state().chatHistoryCache.agent_999), snapshot(view.state().chatHistory))
  rows(view, 'chat')[0].props.onClick()
  await settle()
  assert.equal(view.state().selectedAgentIndex, 0)
  assert.equal(view.state().chatHistory.length, 0)
  await openPicker(view, 'chat')
  await search(view, 'chat', '0999')
  rows(view, 'chat')[0].props.onClick()
  await settle()
  assert.equal(view.state().chatHistory.length, 2, 'restore original-index cache')
  await openPicker(view, 'survey')
  assert.equal(rows(view, 'survey').length, 1000)
  await search(view, 'survey', '0999')
  rows(view, 'survey')[0].children.find(node => node.type === 'input').props.onChange()
  await search(view, 'survey', '0000')
  assert.equal(view.state().hiddenSelectedAgentCount, 1)
  rows(view, 'survey')[0].children.find(node => node.type === 'input').props.onChange()
  control(view, 'survey-input').props['onUpdate:modelValue']('Hidden and visible question')
  await settle()
  control(view, 'survey-submit-btn').props.onClick()
  await settle()
  const surveyRequest = calls.interviewAgents[1]
  assert.deepEqual(snapshot(surveyRequest.args[0]), { simulation_id: 'sim_single', interviews: [
    { agent_id: 999, prompt: 'Hidden and visible question' }, { agent_id: 0, prompt: 'Hidden and visible question' },
  ] })
  await search(view, 'survey', 'no match')
  assert.equal(view.state().hiddenSelectedAgentCount, 2)
  assert.deepEqual([...view.state().selectedAgents], [999, 0])
  assert.equal(view.state().isSurveying, true)
  assert.equal(surveyRequest.args[1], chatRequest.args[1])
  assert.equal(surveyRequest.args[1].aborted, false)
  surveyRequest.resolve(ok({ results: { twitter_999: { response: 'Last result' }, twitter_0: { response: 'First result' } } }))
  await settle()
  assert.equal(view.state().isSurveying, false)
  assert.equal(view.state().surveyResults.length, 2)
  assert.deepEqual(snapshot(view.state().surveyResults.map(result => result.agent_name)), ['Person 0999', 'Person 0000'])
  control(view, 'agent-search-clear').props.onClick()
  await settle()
  assert.equal(rows(view, 'survey')[999].children.find(node => node.type === 'input').props.checked, true)
  assert.equal(rows(view, 'survey')[0].children.find(node => node.type === 'input').props.checked, true)
  assert.equal(view.state().hiddenSelectedAgentCount, 0)
  assert.equal(toRaw(view.state().profiles), profiles)
  assert.deepEqual(ledger.map(call => call.name), [
    'getReport', 'getSimulationProfilesRealtime', 'getAgentLog', 'interviewAgents', 'interviewAgents',
  ])
})

test('existing context reset clears both queries and retires pending work without search-owned requests', async t => {
  const { view, calls, ledger } = await setup(t, [{ username: 'Alice' }])
  await openPicker(view, 'chat')
  await search(view, 'chat', 'Alice')
  rows(view, 'chat')[0].props.onClick()
  await settle()
  control(view, 'chat-input').props['onUpdate:modelValue']('Old chat')
  await settle()
  control(view, 'send-btn').props.onClick()
  await openPicker(view, 'survey')
  await search(view, 'survey', 'Alice')
  rows(view, 'survey')[0].children.find(node => node.type === 'input').props.onChange()
  control(view, 'survey-input').props['onUpdate:modelValue']('Old survey')
  await settle()
  control(view, 'survey-submit-btn').props.onClick()
  await settle()
  const oldRequests = [...calls.interviewAgents]
  assert.equal(oldRequests.length, 2)
  Object.assign(view.props, { reportId: 'next', simulationId: 'next_sim' })
  await settle()
  assert.equal(view.state().chatAgentQuery, '')
  assert.equal(view.state().surveyAgentQuery, '')
  assert.equal(view.state().selectedAgents.size, 0)
  assert.equal(view.state().selectedAgentIndex, null)
  for (const request of oldRequests) {
    assert.equal(request.args[1].aborted, true)
    request.resolve(ok({ results: { twitter_0: { response: 'Old response' } } }))
  }
  await settle()
  assert.equal(view.state().chatHistory.length, 0)
  assert.equal(view.state().surveyResults.length, 0)
  assert.equal(view.state().isSending, false)
  assert.equal(view.state().isSurveying, false)
  assert.deepEqual(ledger.map(call => call.name), [
    'getReport', 'getSimulationProfilesRealtime', 'getAgentLog', 'interviewAgents', 'interviewAgents',
    'getReport', 'getSimulationProfilesRealtime',
  ])
})
