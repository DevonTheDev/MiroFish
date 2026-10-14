import assert from 'node:assert/strict'
import test from 'node:test'
import { toRaw } from 'vue'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { settle, textContent } from './helpers/simulation-platform-fixture.js'
import { renderMarkdown } from '../src/utils/content.js'

// Real compiled Step5 controls and locales with the existing deferred local API
// fixture. These assertions do not establish native browser layout or transport.
const ok = data => ({ success: true, data })
const snapshot = value => JSON.parse(JSON.stringify(value))
const byClass = (view, name) => view.all(node => String(node.props.class ?? '').split(' ').includes(name))
const control = (view, name) => byClass(view, name)[0]
const rows = view => byClass(view, 'agent-checkbox')
const rowInput = row => row.children.find(node => node.type === 'input')
const matchingButton = view => control(view, 'survey-select-matching')
const selection = view => [...view.state().selectedAgents]

async function acceptCatalogue(calls, profiles) {
  calls.getSimulationProfilesRealtime.at(-1).resolve(ok({ profiles }))
  calls.getReport.at(-1).resolve(ok({}))
  await settle()
  calls.getAgentLog.at(-1).resolve(ok({ logs: [] }))
  await settle()
}

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
  let closed = false
  const close = () => { if (!closed) { closed = true; view.close() } }
  t.after(() => { close(); assert.deepEqual(view.warnings, []) })
  await acceptCatalogue(calls, profiles)
  control(view, 'survey-pill').props.onClick()
  await settle()
  return { view, calls, ledger, close }
}

async function search(view, query) {
  control(view, 'survey-agent-search').props['onUpdate:modelValue'](query)
  await settle()
}

async function selectedOnly(view, checked) {
  control(view, 'survey-selected-only').props.onChange({ target: { checked } })
  await settle()
}

async function submit(view, question) {
  control(view, 'survey-input').props['onUpdate:modelValue'](question)
  await settle()
  control(view, 'survey-submit-btn').props.onClick()
  await settle()
}

for (const locale of ['en', 'zh']) {
  test(`${locale} matching action requires a nonblank search and an unselected literal match`, async t => {
    const { view, ledger } = await setup(t, [{ username: 'Literal [QA]' }, { username: 'QA' }], locale)
    assert.equal(matchingButton(view), undefined)
    await search(view, ' \t ')
    assert.equal(matchingButton(view), undefined)
    await search(view, 'missing')
    assert.ok(matchingButton(view), 'nonblank survey search exposes the matching action')
    assert.equal(matchingButton(view).type, 'button')
    assert.equal(matchingButton(view).props.type, 'button')
    assert.equal(textContent(matchingButton(view)), locale === 'en' ? 'Select matching agents' : '选择匹配的智能体')
    assert.equal(matchingButton(view).props.disabled, true)
    matchingButton(view).props.onClick()
    await settle()
    assert.deepEqual(selection(view), [])
    await search(view, '  [qA]  ')
    assert.equal(rows(view).length, 1, 'punctuation is literal and surrounding spaces are ignored')
    assert.equal(matchingButton(view).props.disabled, false)
    const click = matchingButton(view).props.onClick
    click(); click()
    await settle()
    assert.deepEqual(selection(view), [0])
    assert.equal(view.state().surveyAgentQuery, '  [qA]  ')
    assert.equal(matchingButton(view).props.disabled, true)
    const selected = view.state().selectedAgents
    click()
    await settle()
    assert.equal(view.state().selectedAgents, selected, 'an already-selected match is an idempotent no-op')
    rowInput(rows(view)[0]).props.onChange()
    await settle()
    assert.equal(matchingButton(view).props.disabled, false)
    await search(view, 'QA')
    click()
    await settle()
    assert.deepEqual(selection(view), [], 'a retained click from another query cannot select its old matches')
    matchingButton(view).props.onClick()
    await settle()
    assert.deepEqual(selection(view), [0, 1])
    const clear = control(view, 'agent-search-clear').props.onClick
    clear()
    await settle()
    assert.equal(matchingButton(view), undefined)
    assert.deepEqual(selection(view), [0, 1])
    byClass(view, 'action-link')[1].props.onClick()
    await settle()
    click()
    await settle()
    assert.deepEqual(selection(view), [], 'retained handler cannot add after clearing the search')
    await search(view, ' \t ')
    click()
    await settle()
    assert.equal(matchingButton(view), undefined)
    assert.deepEqual(selection(view), [])
    assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog'])
  })

  test(`${locale} matching selection appends catalogue indices across searches and preserves hidden Set order`, async t => {
    const profiles = [{ id: 88, agent_id: 900, username: 'Duplicate [QA]' }, { name: 'Only name' }, {},
      { id: 88, agent_id: 900, username: 'Duplicate [QA]' }, { profession: 'Engineer' }, { username: 'Hidden' }]
    const { view, ledger } = await setup(t, profiles, locale)
    for (const index of [5, 2, 3]) rowInput(rows(view)[index]).props.onChange()
    await settle()
    const original = view.state().selectedAgents
    await search(view, '[qa]')
    matchingButton(view).props.onClick()
    await settle()
    assert.deepEqual([...original], [5, 2, 3], 'selection updates copy the existing Set')
    assert.notEqual(view.state().selectedAgents, original)
    assert.deepEqual(selection(view), [5, 2, 3, 0], 'keep earlier insertion order and append only new catalogue matches')
    assert.equal(view.state().hiddenSelectedAgentCount, 2)
    assert.equal(matchingButton(view).props.disabled, true)
    await search(view, 'only NAME')
    matchingButton(view).props.onClick()
    await settle()
    await search(view, 'ENGINEER')
    matchingButton(view).props.onClick()
    await settle()
    assert.deepEqual(selection(view), [5, 2, 3, 0, 1, 4], 'name and profession matches keep sparse-row original indices')
    assert.equal(view.state().hiddenSelectedAgentCount, 5)
    assert.equal(toRaw(view.state().profiles), profiles)
    profiles.forEach((profile, index) => assert.equal(toRaw(view.state().profiles[index]), profile))
    await search(view, '[qa]')
    matchingButton(view).props.onClick()
    await settle()
    assert.deepEqual(selection(view), [5, 2, 3, 0, 1, 4], 'returning to an earlier query never reorders or duplicates selections')
    assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog'])
  })

  test(`${locale} selected-only and chat hide matching action while global selection controls retain their scope`, async t => {
    const { view, ledger } = await setup(t, [{ username: 'Alpha' }, { username: 'Hidden' }, { username: 'Alpha two' }], locale)
    view.state().chatAgentQuery = 'Independent chat search'
    view.state().chatInput = 'Unsent chat'
    view.state().chatHistory = [{ role: 'assistant', content: 'Kept answer' }]
    view.state().chatHistoryCache = { agent_1: [{ role: 'user', content: 'Kept cached question' }] }
    const history = view.state().chatHistory, cache = view.state().chatHistoryCache
    await search(view, 'Alpha')
    const click = matchingButton(view).props.onClick
    click()
    await settle()
    assert.equal(view.state().chatAgentQuery, 'Independent chat search')
    assert.equal(view.state().chatInput, 'Unsent chat')
    assert.equal(view.state().chatHistory, history)
    assert.equal(view.state().chatHistoryCache, cache)
    assert.equal(view.state().chatTarget, 'report_agent')
    assert.equal(view.state().selectedAgentIndex, null)
    await selectedOnly(view, true)
    assert.equal(matchingButton(view), undefined)
    rowInput(rows(view)[0]).props.onChange()
    await settle()
    click()
    await settle()
    assert.deepEqual(selection(view), [2], 'retained handler cannot add while selected-only is active')
    await selectedOnly(view, false)
    assert.equal(view.state().surveyAgentQuery, 'Alpha')
    assert.equal(matchingButton(view).props.disabled, false)
    const [all, clear] = byClass(view, 'action-link')
    all.props.onClick()
    await settle()
    assert.deepEqual(selection(view), [0, 1, 2], 'global All includes hidden catalogue rows')
    assert.equal(matchingButton(view).props.disabled, true)
    clear.props.onClick()
    await settle()
    assert.deepEqual(selection(view), [], 'global Clear removes hidden selections')
    assert.equal(matchingButton(view).props.disabled, false)
    assert.equal(view.state().surveyAgentQuery, 'Alpha')
    assert.equal(view.state().surveySelectedOnly, false)
    control(view, 'agent-pill').props.onClick()
    await settle()
    assert.equal(matchingButton(view), undefined)
    click()
    await settle()
    assert.deepEqual(selection(view), [], 'retained handler cannot add from chat')
    control(view, 'survey-pill').props.onClick()
    await settle()
    assert.equal(view.state().surveyAgentQuery, 'Alpha')
    assert.equal(matchingButton(view).props.disabled, false)
    matchingButton(view).props.onClick()
    await selectedOnly(view, true)
    control(view, 'agent-search-clear').props.onClick()
    await settle()
    assert.equal(view.state().surveySelectedOnly, true)
    assert.equal(matchingButton(view), undefined)
    assert.deepEqual(selection(view), [0, 2])
    assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog'])
  })
}

test('matching edits during a pending survey affect only the next submitted targets and question', async t => {
  const profiles = [{ id: 7, username: 'First [QA]', profession: 'Writer' }, {},
    { id: 7, username: 'Next target' }, { username: 'Last [QA]', profession: 'Reader' }]
  const { view, calls, ledger } = await setup(t, profiles)
  for (const index of [3, 1]) rowInput(rows(view)[index]).props.onChange()
  await search(view, '[QA]')
  matchingButton(view).props.onClick()
  await settle()
  assert.deepEqual(selection(view), [3, 1, 0])
  await submit(view, '  Captured question 雪  ')
  const request = calls.interviewAgents[0]
  const payload = { simulation_id: 'sim_single', interviews: [3, 1, 0].map(agent_id => ({ agent_id, prompt: 'Captured question 雪' })) }
  assert.deepEqual(snapshot(request.args[0]), payload)
  await search(view, 'Next')
  assert.equal(matchingButton(view).props.disabled, false, 'pending survey does not disable selection edits')
  matchingButton(view).props.onClick()
  await settle()
  assert.deepEqual(selection(view), [3, 1, 0, 2])
  rowInput(rows(view)[0]).props.onChange()
  await settle()
  assert.deepEqual(selection(view), [3, 1, 0])
  matchingButton(view).props.onClick()
  await selectedOnly(view, true)
  const [all, clear] = byClass(view, 'action-link')
  clear.props.onClick(); all.props.onClick()
  await settle()
  assert.deepEqual(selection(view), [0, 1, 2, 3], 'existing global selection edits remain available while pending')
  await selectedOnly(view, false)
  clear.props.onClick()
  await settle()
  matchingButton(view).props.onClick()
  await settle()
  assert.deepEqual(selection(view), [2])
  control(view, 'survey-input').props['onUpdate:modelValue']('Next question')
  await settle()
  control(view, 'survey-submit-btn').props.onClick()
  assert.equal(calls.interviewAgents.length, 1)
  assert.equal(view.state().isSurveying, true)
  assert.equal(request.args[1].aborted, false)
  assert.deepEqual(snapshot(request.args[0]), payload)
  request.resolve(ok({ result: { platforms: ['twitter', 'reddit'], results: Object.fromEntries([3, 1, 0].flatMap(id =>
    ['twitter', 'reddit'].map(platform => [`${platform}_${id}`, { response: `${platform} ${id} 雪` }]))) } }))
  await settle()
  assert.deepEqual(snapshot(view.state().surveyResults.map(result => [result.agent_id, result.agent_name, result.profession, result.question])), [
    [3, 'Last [QA]', 'Reader', 'Captured question 雪'], [1, 'Agent 1', null, 'Captured question 雪'],
    [0, 'First [QA]', 'Writer', 'Captured question 雪'],
  ])
  assert.deepEqual(byClass(view, 'result-answer').map(node => node.props.innerHTML),
    [3, 1, 0].flatMap(id => ['twitter', 'reddit'].map(platform => renderMarkdown(`${platform} ${id} 雪`))))
  assert.equal(view.state().surveyTextReplyCount, 6)
  assert.equal(view.state().isSurveying, false)
  assert.deepEqual(selection(view), [2])
  control(view, 'survey-submit-btn').props.onClick()
  await settle()
  assert.deepEqual(snapshot(calls.interviewAgents[1].args[0]), {
    simulation_id: 'sim_single', interviews: [{ agent_id: 2, prompt: 'Next question' }],
  })
  calls.interviewAgents[1].resolve(ok({ results: { twitter_2: { response: 'Next answer' } } }))
  await settle()
  assert.equal(view.state().surveyResults[0].agent_name, 'Next target')
  assert.equal(view.state().surveyResults[0].question, 'Next question')
  assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog', 'interviewAgents', 'interviewAgents'])
})

test('retained matching handler cannot apply to a replaced catalogue at the same indices', async t => {
  const { view } = await setup(t, [{ username: 'Match old' }])
  await search(view, 'Match')
  const click = matchingButton(view).props.onClick
  view.state().profiles = [{ username: 'Match replacement' }]
  await settle()
  click()
  await settle()
  assert.deepEqual(selection(view), [])
  matchingButton(view).props.onClick()
  await settle()
  assert.deepEqual(selection(view), [0])
})

for (const transition of ['report replacement', 'simulation A to B to A']) {
  for (const outcome of ['success', 'failure']) {
    test(`${transition} retires matching handlers and old survey ${outcome} without changing the current survey`, async t => {
      const { view, calls } = await setup(t, [{ username: 'Match old' }])
      await search(view, 'Match')
      const oldClick = matchingButton(view).props.onClick
      oldClick()
      await submit(view, 'Old question')
      const old = calls.interviewAgents[0]
      if (transition === 'report replacement') {
        view.props.reportId = 'next-report'
        await settle()
      } else {
        view.props.simulationId = 'next-sim'
        await settle()
        view.props.simulationId = 'sim_single'
        await settle()
      }
      oldClick()
      await settle()
      assert.deepEqual(selection(view), [])
      assert.equal(view.state().surveyAgentQuery, '')
      assert.equal(view.state().surveySelectedOnly, false)
      assert.equal(view.state().surveyQuestion, '')
      assert.equal(matchingButton(view), undefined)
      assert.equal(old.args[1].aborted, true)
      await acceptCatalogue(calls, [{ username: 'Match new' }, { username: 'Other new' }])
      control(view, 'survey-pill').props.onClick()
      await settle()
      await search(view, 'Match')
      oldClick()
      await settle()
      assert.deepEqual(selection(view), [], 'same query and indices cannot revive an earlier context')
      matchingButton(view).props.onClick()
      await submit(view, 'New question')
      await search(view, 'Other')
      matchingButton(view).props.onClick()
      await settle()
      const emitted = [...view.emitted]
      if (outcome === 'success') old.resolve(ok({ results: { twitter_0: { response: 'Retired text' } } }))
      else old.reject(new Error('Retired failure'))
      await settle()
      assert.equal(view.state().isSurveying, true)
      assert.equal(view.state().surveyResults.length, 0)
      assert.deepEqual(view.emitted, emitted)
      assert.deepEqual(selection(view), [0, 1])
      calls.interviewAgents[1].resolve(ok({ results: { reddit_0: { response: 'Current text' } } }))
      await settle()
      assert.equal(view.state().isSurveying, false)
      assert.equal(view.state().surveyResults.length, 1)
      assert.equal(view.state().surveyResults[0].agent_name, 'Match new')
      assert.equal(view.state().surveyResults[0].question, 'New question')
      assert.equal(view.state().surveyResults[0].replies[0].answer, 'Current text')
    })
  }
}

test('unmount retires the retained matching action and pending result', async t => {
  const { view, calls, close } = await setup(t, [{ username: 'Match old' }])
  await search(view, 'Match')
  const click = matchingButton(view).props.onClick
  click()
  await submit(view, 'Old question')
  byClass(view, 'action-link')[1].props.onClick()
  await settle()
  close()
  const emitted = [...view.emitted]
  click()
  calls.interviewAgents[0].resolve(ok({ results: { twitter_0: { response: 'Retired text' } } }))
  await settle()
  assert.deepEqual(selection(view), [])
  assert.equal(calls.interviewAgents[0].args[1].aborted, true)
  assert.equal(view.state().surveyResults.length, 0)
  assert.deepEqual(view.emitted, emitted)
  assert.equal(view.listeners.size, 0)
})
