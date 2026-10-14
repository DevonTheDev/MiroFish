import assert from 'node:assert/strict'
import test from 'node:test'
import { toRaw } from 'vue'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { settle, textContent } from './helpers/simulation-platform-fixture.js'
import { renderMarkdown } from '../src/utils/content.js'

// The existing compiled Step5 fixture exercises real Vue and i18n with deferred
// local APIs. These are rendered control tests, not native browser layout tests.
const ok = data => ({ success: true, data })
const snapshot = value => JSON.parse(JSON.stringify(value))
const byClass = (view, name) => view.all(node => String(node.props.class ?? '').split(' ').includes(name))
const control = (view, name) => byClass(view, name)[0]
const rows = view => byClass(view, 'agent-checkbox')
const rowInput = row => row.children.find(node => node.type === 'input')
const indices = view => Array.from(view.state().surveyVisibleAgents, entry => entry.originalIndex)
const count = view => textContent(control(view, 'agent-search-count'))
const empty = view => textContent(control(view, 'agent-search-empty'))

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

async function selectedOnly(view, checked) {
  control(view, 'survey-selected-only').props.onChange({ target: { checked } })
  await settle()
}

async function search(view, query) {
  control(view, 'survey-agent-search').props['onUpdate:modelValue'](query)
  await settle()
}

async function submit(view, question) {
  control(view, 'survey-input').props['onUpdate:modelValue'](question)
  await settle()
  control(view, 'survey-submit-btn').props.onClick()
  await settle()
}

const words = {
  en: { label: 'Selected only', none: 'No agents selected', noMatch: 'No selected agents match your search',
    allCount: '3 of 3 agents match', match: '1 of 3 agents match', zero: 'Showing 0 of 0 selected agents',
    two: 'Showing 2 of 2 selected agents', one: 'Showing 1 of 2 selected agents',
    hidden: 'Selected agents hidden by search: 1' },
  zh: { label: '仅显示已选', none: '尚未选择智能体', noMatch: '没有符合搜索条件的已选智能体',
    allCount: '匹配 3 / 3 个智能体', match: '匹配 1 / 3 个智能体', zero: '显示 0 / 0 个已选智能体',
    two: '显示 2 / 2 个已选智能体', one: '显示 1 / 2 个已选智能体',
    hidden: '有 1 个已选智能体被搜索隐藏' },
}

for (const locale of ['en', 'zh']) {
  test(`${locale} selected-only controls retain search, global selection and tab state with distinct empty feedback`, async t => {
    const { view, ledger } = await setup(t, [{ username: 'Alice' }, { username: 'Bob' }, { username: 'Carol' }], locale)
    const checkbox = control(view, 'survey-selected-only')
    assert.equal(checkbox.type, 'input')
    assert.equal(checkbox.props.type, 'checkbox')
    assert.equal(checkbox.props.checked, false)
    assert.equal(checkbox.props.disabled, undefined, 'empty selection must not disable the view')
    assert.equal(checkbox.parent.type, 'label')
    assert.match(textContent(checkbox.parent), new RegExp(words[locale].label))
    assert.equal(count(view), words[locale].allCount)
    assert.equal(rows(view).length, 3)
    await selectedOnly(view, true)
    assert.equal(rows(view).length, 0)
    assert.equal(count(view), words[locale].zero)
    assert.equal(empty(view), words[locale].none)
    assert.equal(control(view, 'agent-search-hidden'), undefined)
    assert.equal(control(view, 'survey-submit-btn').props.disabled, true)
    await selectedOnly(view, false)
    rowInput(rows(view)[2]).props.onChange()
    rowInput(rows(view)[0]).props.onChange()
    await selectedOnly(view, true)
    assert.deepEqual(indices(view), [0, 2])
    assert.equal(count(view), words[locale].two)
    await search(view, 'Alice')
    assert.equal(count(view), words[locale].one)
    assert.equal(control(view, 'agent-search-count').props['aria-live'], 'polite')
    assert.equal(textContent(control(view, 'agent-search-hidden')), words[locale].hidden)
    await selectedOnly(view, false)
    assert.equal(view.state().surveyAgentQuery, 'Alice')
    assert.deepEqual([...view.state().selectedAgents], [2, 0])
    assert.equal(count(view), words[locale].match)
    await selectedOnly(view, true)
    await search(view, 'missing')
    assert.equal(empty(view), words[locale].noMatch)
    control(view, 'agent-search-clear').props.onClick()
    await settle()
    assert.equal(view.state().surveyAgentQuery, '')
    assert.equal(control(view, 'survey-selected-only').props.checked, true)
    assert.deepEqual([...view.state().selectedAgents], [2, 0])
    rowInput(rows(view)[0]).props.onChange()
    await settle()
    assert.deepEqual(indices(view), [2], 'deselecting a visible row removes its original index and hides it')
    assert.deepEqual([...view.state().selectedAgents], [2])
    await search(view, 'Alice')
    const [all, clear] = byClass(view, 'action-link')
    all.props.onClick()
    await settle()
    assert.deepEqual([...view.state().selectedAgents], [0, 1, 2], 'Select all includes hidden catalogue rows')
    assert.deepEqual(indices(view), [0])
    assert.equal(view.state().surveyAgentQuery, 'Alice')
    assert.equal(control(view, 'survey-selected-only').props.checked, true)
    assert.equal(view.state().hiddenSelectedAgentCount, 2)
    clear.props.onClick()
    await settle()
    assert.equal(view.state().selectedAgents.size, 0, 'Clear all includes hidden selections')
    assert.equal(view.state().surveyAgentQuery, 'Alice')
    assert.equal(control(view, 'survey-selected-only').props.checked, true)
    assert.equal(count(view), words[locale].zero)
    assert.equal(empty(view), words[locale].none)
    control(view, 'agent-pill').props.onClick()
    await settle()
    assert.equal(control(view, 'survey-selected-only'), undefined, 'the control is survey-only')
    assert.equal(byClass(view, 'dropdown-item').length, 3, 'survey view does not filter chat')
    control(view, 'survey-pill').props.onClick()
    await settle()
    assert.equal(control(view, 'survey-selected-only').props.checked, true)
    assert.equal(view.state().surveyAgentQuery, 'Alice')
    assert.equal(empty(view), words[locale].none)
    assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog'])
  })
}

test('nonadjacent duplicate and sparse profiles retain identities and captured Set order through pending view edits', async t => {
  const profiles = [{ username: 'Duplicate', profession: 'First' }, { name: 'Only name' }, {},
    { username: 'Duplicate', profession: 'Second' }, { username: 'Other' }, { username: 'Visible [QA]', profession: 'Writer' }]
  const { view, calls, ledger } = await setup(t, profiles)
  for (const index of [5, 3, 2, 0]) rowInput(rows(view)[index]).props.onChange()
  await selectedOnly(view, true)
  assert.deepEqual(indices(view), [0, 2, 3, 5], 'display retains catalogue order despite reverse selection order')
  assert.deepEqual(byClass(view, 'checkbox-name').map(textContent), ['Duplicate', '', 'Duplicate', 'Visible [QA]'])
  for (const entry of view.state().surveyVisibleAgents) assert.equal(toRaw(entry.profile), profiles[entry.originalIndex])
  assert.equal(toRaw(view.state().profiles), profiles)
  assert.equal(toRaw(view.state().profiles[2]), profiles[2], 'sparse accepted row remains at its original position')
  await search(view, ' [qa] ')
  assert.deepEqual(indices(view), [5])
  assert.equal(view.state().hiddenSelectedAgentCount, 3)
  await submit(view, '  Captured question 雪  ')
  const request = calls.interviewAgents[0]
  const payload = { simulation_id: 'sim_single', interviews: [5, 3, 2, 0].map(agent_id => ({ agent_id, prompt: 'Captured question 雪' })) }
  assert.deepEqual(snapshot(request.args[0]), payload)
  assert.ok(request.args[1] instanceof AbortSignal)
  rowInput(rows(view)[0]).props.onChange()
  await settle()
  assert.deepEqual(indices(view), [])
  control(view, 'agent-search-clear').props.onClick()
  await settle()
  assert.deepEqual(indices(view), [0, 2, 3])
  const [all, clear] = byClass(view, 'action-link')
  clear.props.onClick()
  all.props.onClick()
  await selectedOnly(view, false)
  await search(view, 'duplicate')
  control(view, 'survey-input').props['onUpdate:modelValue']('Edited question')
  view.state().profiles = [{ username: 'Replacement' }]
  await settle()
  control(view, 'survey-submit-btn').props.onClick()
  assert.equal(calls.interviewAgents.length, 1, 'pending guard owns the original request despite view and selection edits')
  assert.equal(view.state().isSurveying, true)
  assert.equal(request.args[1].aborted, false)
  assert.deepEqual(snapshot(request.args[0]), payload)
  const results = Object.fromEntries([5, 3, 2, 0].flatMap(id => ['twitter', 'reddit'].map(platform =>
    [`${platform}_${id}`, { response: `${platform} ${id} 雪` }])))
  request.resolve(ok({ result: { platforms: ['twitter', 'reddit'], results } }))
  await settle()
  assert.deepEqual(snapshot(view.state().surveyResults.map(result => [result.agent_id, result.agent_name, result.profession, result.question])), [
    [5, 'Visible [QA]', 'Writer', 'Captured question 雪'], [3, 'Duplicate', 'Second', 'Captured question 雪'],
    [2, 'Agent 2', null, 'Captured question 雪'], [0, 'Duplicate', 'First', 'Captured question 雪'],
  ])
  assert.deepEqual(byClass(view, 'result-platform').map(textContent), ['Twitter', 'Reddit', 'Twitter', 'Reddit', 'Twitter', 'Reddit', 'Twitter', 'Reddit'])
  assert.deepEqual(byClass(view, 'result-answer').map(node => node.props.innerHTML),
    [5, 3, 2, 0].flatMap(id => ['twitter', 'reddit'].map(platform => renderMarkdown(`${platform} ${id} 雪`))))
  assert.equal(view.state().surveyTextReplyCount, 8)
  assert.equal(view.state().isSurveying, false)
  assert.deepEqual(ledger.map(call => call.name), ['getReport', 'getSimulationProfilesRealtime', 'getAgentLog', 'interviewAgents'])
})

for (const transition of ['report replacement', 'simulation A to B to A']) {
  test(`${transition} resets selected-only and retires the old survey without unlocking a newer one`, async t => {
    const { view, calls } = await setup(t, [{ username: 'Old' }])
    rowInput(rows(view)[0]).props.onChange()
    await selectedOnly(view, true)
    await search(view, 'Old')
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
    assert.equal(view.state().surveySelectedOnly, false)
    assert.equal(view.state().surveyAgentQuery, '')
    assert.equal(view.state().selectedAgents.size, 0)
    assert.equal(view.state().surveyQuestion, '')
    assert.equal(old.args[1].aborted, true)
    await acceptCatalogue(calls, [{ username: 'New' }])
    control(view, 'survey-pill').props.onClick()
    await settle()
    assert.equal(control(view, 'survey-selected-only').props.checked, false)
    rowInput(rows(view)[0]).props.onChange()
    await selectedOnly(view, true)
    await submit(view, 'New question')
    const emittedCount = view.emitted.length
    if (transition === 'report replacement') old.resolve(ok({ results: { twitter_0: { response: 'Retired text' } } }))
    else old.reject(new Error('Retired failure'))
    await settle()
    assert.equal(view.state().isSurveying, true)
    assert.equal(view.state().surveyResults.length, 0)
    assert.equal(view.emitted.length, emittedCount)
    assert.equal(control(view, 'survey-selected-only').props.checked, true)
    calls.interviewAgents[1].resolve(ok({ results: { reddit_0: { response: 'Current text' } } }))
    await settle()
    assert.equal(view.state().isSurveying, false)
    assert.equal(view.state().surveyResults[0].agent_name, 'New')
    assert.equal(view.state().surveyResults[0].question, 'New question')
    assert.equal(view.state().surveyResults[0].replies[0].answer, 'Current text')
  })
}

test('unmount with selected-only active retires the pending survey and its logs', async t => {
  const { view, calls, close } = await setup(t, [{ username: 'Old' }])
  rowInput(rows(view)[0]).props.onChange()
  await selectedOnly(view, true)
  await submit(view, 'Old question')
  close()
  const emittedCount = view.emitted.length
  assert.equal(calls.interviewAgents[0].args[1].aborted, true)
  calls.interviewAgents[0].resolve(ok({ results: { twitter_0: { response: 'Retired text' } } }))
  await settle()
  assert.equal(view.state().surveyResults.length, 0)
  assert.equal(view.emitted.length, emittedCount)
  assert.equal(view.listeners.size, 0)
})
