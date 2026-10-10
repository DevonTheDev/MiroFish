import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSurvey } from './helpers/platform-survey-fixture.js'
import { settle, textContent } from './helpers/simulation-platform-fixture.js'
import { renderMarkdown } from '../src/utils/content.js'

// These regressions mount the actual Step5 script AND template. Only the API
// boundary is deferred: controls, request capture, reply rendering and i18n run.
const profiles = [{ username: 'Alice', profession: 'Writer' }, { username: 'Bob', profession: 'Teacher' }]
const ok = data => ({ success: true, data })
const nested = results => ok({ result: { interviews_count: Object.keys(results).length, results } })
const byClass = (view, name) => view.all(node => String(node.props.class ?? '').split(' ').includes(name))
const cards = view => byClass(view, 'result-card')
const answers = view => byClass(view, 'result-answer').map(node => node.props.innerHTML)
const labels = view => byClass(view, 'result-platform').map(textContent)
const summary = view => textContent(byClass(view, 'results-header')[0])
const states = view => byClass(view, 'result-reply-status').map(textContent)
const cardReplies = (view, index = 0) => Array.from(view.state().surveyResults[index].replies)

async function setup(t, { selected = [0], locale = 'en' } = {}) {
  const requests = []
  const view = buildSurvey({
    getReport: async () => ok({}),
    getAgentLog: async () => ok({ logs: [] }),
    getSimulationProfilesRealtime: async () => ok({ profiles }),
    interviewAgents: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
  }, { locale })
  t.after(() => view.close())
  await settle()
  view.state().selectSurveyTab()
  await settle()
  const checkboxes = view.all(node => node.type === 'input' && node.props.type === 'checkbox')
  selected.forEach(index => checkboxes[index].props.onChange())
  const question = byClass(view, 'survey-input')[0]
  question.props['onUpdate:modelValue']('Original question 雪')
  await settle()
  const submit = byClass(view, 'survey-submit-btn')[0]
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  submit.props.onClick()
  assert.equal(requests.length, 1, 'a double click must make one batch request')
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].args[0])), {
    simulation_id: 'sim_single', interviews: selected.map(agent_id => ({ agent_id, prompt: 'Original question 雪' })),
  })
  assert.ok(requests[0].args[1] instanceof AbortSignal)
  return { view, requests, async respond(envelope) { requests[0].resolve(envelope); await settle() } }
}

test('Both survey keeps every platform reply under one card per submitted agent', async t => {
  const { view, requests, respond } = await setup(t, { selected: [0, 1] })
  view.state().surveyQuestion = 'Edited question'
  view.state().profiles = [{ username: 'Replacement' }]
  await respond(nested({
    twitter_0: { agent_id: 0, platform: 'twitter', response: 'Twitter Alice 雪\nsecond line' },
    reddit_0: { agent_id: 0, platform: 'reddit', response: 'Reddit Alice' },
    twitter_1: { agent_id: 1, platform: 'twitter', response: 'Twitter Bob' },
    reddit_1: { agent_id: 1, platform: 'reddit', response: 'Reddit Bob' },
  }))
  assert.equal(cards(view).length, 2)
  assert.equal(answers(view).length, 4, 'Both must not collapse to the preferred platform')
  assert.deepEqual(labels(view), ['Twitter', 'Reddit', 'Twitter', 'Reddit'])
  assert.deepEqual(answers(view), ['Twitter Alice 雪\nsecond line', 'Reddit Alice', 'Twitter Bob', 'Reddit Bob'].map(renderMarkdown))
  assert.deepEqual(Array.from(view.state().surveyResults, item => [item.agent_id, item.agent_name, item.profession, item.question]), [
    [0, 'Alice', 'Writer', 'Original question 雪'], [1, 'Bob', 'Teacher', 'Original question 雪'],
  ])
  assert.equal(cardReplies(view)[0].answer, 'Twitter Alice 雪\nsecond line')
  assert.match(summary(view), /2 targets/)
  assert.match(summary(view), /4 replies with text/)
  assert.ok(view.emitted.includes('Received 4 replies with text for 2 targets'))
  assert.equal(requests.length, 1)
  assert.deepEqual(view.warnings, [])
})

for (const platform of ['twitter', 'reddit']) {
  for (const shape of ['nested', 'direct']) {
    test(`${platform}-only ${shape} envelope labels the actual reply without a disabled-peer placeholder`, async t => {
      const { view, respond } = await setup(t)
      const payload = { platform, platforms: [platform], results: { [`${platform}_0`]: { agent_id: 0, platform, response: `${platform} text` } } }
      await respond(ok(shape === 'nested' ? { result: payload } : payload))
      assert.deepEqual(labels(view), [platform === 'twitter' ? 'Twitter' : 'Reddit'])
      assert.deepEqual(answers(view), [renderMarkdown(`${platform} text`)])
      assert.deepEqual(states(view), [])
      assert.equal(byClass(view, 'result-coverage').length, 0)
      assert.match(summary(view), /1 targets.*1 replies with text/)
    })
  }
}

for (const healthy of ['twitter', 'reddit']) {
  const other = healthy === 'twitter' ? 'reddit' : 'twitter'
  for (const [label, response, expectedState] of [
    ['null', null, 'No reply returned'], ['empty', '', 'Empty reply'],
    ['invalid', { private: 'not text' }, 'Invalid reply format'],
  ]) {
    test(`healthy ${healthy} text survives a ${label} ${other} record`, async t => {
      const { view, respond } = await setup(t)
      await respond(nested({
        [`${other}_0`]: { agent_id: 0, platform: other, response },
        [`${healthy}_0`]: { agent_id: 0, platform: healthy, response: `${healthy} survives` },
      }))
      assert.ok(answers(view).includes(renderMarkdown(`${healthy} survives`)), 'an unusable peer cannot hide text')
      assert.equal(labels(view).length, 2)
      assert.ok(states(view).includes(expectedState))
      assert.match(summary(view), /1 replies with text/)
      const reply = cardReplies(view).find(item => item.platform === other)
      assert.equal(reply.answer, label === 'empty' ? '' : null)
      assert.doesNotMatch(answers(view).join(' '), /\[object Object\]|not text/)
    })
  }
}

test('omitted parallel rows retain unknown coverage without inventing a missing platform or failure', async t => {
  const { view, respond } = await setup(t)
  await respond(nested({ twitter_0: { response: 'Surviving Twitter text' } }))
  assert.deepEqual(labels(view), ['Twitter'])
  assert.deepEqual(answers(view), [renderMarkdown('Surviving Twitter text')])
  assert.match(textContent(byClass(view, 'result-coverage')[0]), /Platform coverage was not recorded/)
  assert.doesNotMatch(textContent(cards(view)[0]), /Reddit|failed|disabled|timed out/i)
})

test('declared platform with an omitted row reports no returned reply without a failure reason', async t => {
  const { view, respond } = await setup(t)
  await respond(ok({ result: { platform: 'twitter', platforms: ['twitter'], results: {} } }))
  assert.deepEqual(labels(view), ['Twitter'])
  assert.deepEqual(states(view), ['No reply returned'])
  assert.match(summary(view), /1 targets.*0 replies with text/)
  assert.doesNotMatch(textContent(cards(view)[0]), /Reddit|failed|disabled|timed out/i)
})

test('explicit record errors stay separate from healthy reply text and are safely rendered', async t => {
  const { view, respond } = await setup(t)
  await respond(nested({
    twitter_0: { response: 'Kept text', error: '<script>known warning</script>' },
    reddit_0: { response: null, error: 'Recorded failure reason' },
  }))
  assert.deepEqual(answers(view), [renderMarkdown('Kept text')])
  assert.deepEqual(byClass(view, 'result-reply-error').map(textContent), ['<script>known warning</script>', 'Recorded failure reason'])
  assert.equal(byClass(view, 'result-reply-error').some(node => node.props.innerHTML), false)
  assert.match(summary(view), /1 replies with text/)
})

test('all missing or foreign rows retain target identity and zero text replies', async t => {
  const { view, respond } = await setup(t, { selected: [0, 1] })
  await respond(nested({ twitter_0: { response: null }, reddit_0: {}, twitter_7: { response: 'Foreign text' } }))
  assert.equal(cards(view).length, 2)
  assert.deepEqual(answers(view), [])
  assert.match(summary(view), /2 targets.*0 replies with text/)
  assert.ok(view.emitted.includes('Received 0 replies with text for 2 targets'))
  assert.equal(cardReplies(view, 1).length, 0)
  assert.match(textContent(cards(view)[1]), /No reply returned/)
  assert.doesNotMatch(textContent(view.host), /Foreign text/)
})

test('legacy arrays keep every attributable record and do not invent an unrecorded platform', async t => {
  const { view, respond } = await setup(t)
  await respond(ok({ results: [
    { agent_id: 0, platform: 'reddit', response: 'Reddit first' },
    { agent_id: 0, platform: 'twitter', answer: 'Twitter second' },
    { agent_id: 0, response: 'Platform not stored' },
    { agent_id: 0, platform: 'reddit', response: 'Repeated attributable record' },
    { agent_id: 9, platform: 'twitter', response: 'Foreign text' },
    { response: 'Unattributed text' }, null,
  ] }))
  assert.equal(cards(view).length, 1)
  assert.deepEqual(labels(view), ['Reddit', 'Twitter', 'Platform not recorded', 'Reddit'])
  assert.deepEqual(answers(view), ['Reddit first', 'Twitter second', 'Platform not stored', 'Repeated attributable record'].map(renderMarkdown))
  assert.match(summary(view), /1 targets.*4 replies with text/)
})

for (const [label, malformed] of [['array', ['twitter']], ['object', { toString: 'not callable' }]]) {
  test(`malformed ${label} platform metadata stays unknown without hiding healthy replies`, async t => {
    const { view, respond } = await setup(t)
    await respond(ok({ result: { platforms: [malformed], results: [
      { agent_id: 0, platform: malformed, response: 'Unrecorded platform text' },
      { agent_id: 0, platform: 'reddit', response: 'Healthy Reddit text' },
    ] } }))
    assert.equal(cards(view).length, 1, 'malformed metadata cannot discard the batch')
    assert.deepEqual(labels(view), ['Platform not recorded', 'Reddit'])
    assert.deepEqual(answers(view), ['Unrecorded platform text', 'Healthy Reddit text'].map(renderMarkdown))
    assert.match(textContent(byClass(view, 'result-coverage')[0]), /Platform coverage was not recorded/)
    assert.match(summary(view), /2 replies with text/)
    assert.deepEqual(view.warnings, [])
  })
}

test('direct result dictionaries preserve explicit empty text rather than falling back to an alias', async t => {
  const { view, respond } = await setup(t)
  await respond(ok({ twitter_0: { response: '', answer: 'Must not replace explicit empty text' }, reddit_0: { answer: 'Legacy answer' } }))
  assert.deepEqual(answers(view), [renderMarkdown('Legacy answer')])
  assert.ok(states(view).includes('Empty reply'))
  assert.equal(cardReplies(view).find(item => item.platform === 'twitter').answer, '')
  assert.match(summary(view), /1 replies with text/)
})

for (const locale of ['en', 'zh']) {
  test(`${locale} labels preserve independent Unicode, line breaks and escaped markup through the existing renderer`, async t => {
    const { view, respond } = await setup(t, { locale })
    const source = ['雪 **Twitter**\n<script>alert(1)</script>', '海 <img src=x onerror=alert(2)>\nSecond line']
    await respond(nested({ twitter_0: { response: source[0] }, reddit_0: { response: source[1] } }))
    assert.deepEqual(cardReplies(view).map(item => item.answer), source)
    assert.deepEqual(answers(view), source.map(renderMarkdown))
    assert.deepEqual(labels(view), ['Twitter', 'Reddit'])
    assert.doesNotMatch(answers(view).join(' '), /<script>|<img /)
    assert.match(summary(view), locale === 'en' ? /1 targets.*2 replies with text/ : /1 个对象.*2 条文字回复/)
    assert.deepEqual(view.warnings, [])
  })
}

test('unsuccessful batch does not fabricate cards or a received-reply count', async t => {
  const { view, respond } = await setup(t)
  await respond({ success: false, error: 'Batch rejected' })
  assert.equal(cards(view).length, 0)
  assert.equal(view.state().isSurveying, false)
  assert.ok(view.emitted.includes('Survey send failed: Batch rejected'))
  assert.equal(view.emitted.some(message => message.startsWith('Received ')), false)
})
