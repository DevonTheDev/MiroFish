import assert from 'node:assert/strict'
import test from 'node:test'
import { setup, resolve, observation, windowObservation, record, source, flush } from './helpers/saved-interviews-view-fixture.js'

const path = '/simulation/sim_A/interviews'
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const rowIds = h => h.all(n => String(n.props['data-testid'] ?? '').startsWith('interview-row-')).map(n => n.props['data-testid'])
const options = h => h.byId('interviews-question-select').children.filter(n => n.type === 'option')
const selectedPrompt = h => h.text(h.byId('interviews-question-prompt'))
const mode = h => h.byId('interviews-questions-mode').props['aria-pressed']
function multipleQuestions() {
  return observation({ records: [...Array.from({ length: 27 }, (_, i) => record('twitter', String(100 - i), { prompt: 'First question', response: `Answer ${i}` })), ...Array.from({ length: 27 }, (_, i) => record('reddit', String(100 - i), { prompt: 'Second question', response: `Other ${i}` }))] })
}

for (const locale of ['en', 'zh']) test(`exact-question review uses full observation, literal prompts, source counts and local pages in ${locale}`, async t => {
  const { h, calls } = await setup(t, path, locale)
  const prompt = '<script>alert(1)</script>\n<img src=x>\n' + 'Full stored context '.repeat(200)
  const rows = [...Array.from({ length: 28 }, (_, i) => record('twitter', String(100 - i), { prompt, agent_id: '9223372036854775807', response: i === 0 ? null : '<iframe>literal reply</iframe>', warnings: i === 0 ? ['missing_response'] : [] })), record('twitter', '-9223372036854775808', { prompt: 'Other' }), record('reddit', '9223372036854775807', { prompt })]
  const data = observation({ records: rows })
  await resolve(calls.getSavedInterviews[0], data)
  assert.ok(h.byId('interviews-questions-mode'), 'saved-question review control must exist')
  await h.click('interviews-questions-mode')
  assert.equal(mode(h), true); assert.equal(options(h).length, 2)
  assert.equal(selectedPrompt(h), prompt)
  assert.ok(options(h).every(n => h.text(n).length < 220))
  assert.equal(rowIds(h).length, 25)
  assert.match(h.text(h.byId('interviews-question-counts-twitter')), /28/)
  assert.match(h.text(h.byId('interviews-question-counts-reddit')), /1/)
  assert.ok(h.text().includes('9223372036854775807'))
  assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type) || n.props.innerHTML).length, 0)
  assert.equal(h.find(n => n.type === 'label' && n.props.for === h.byId('interviews-question-select').props.id)?.type, 'label')
  await h.click('interviews-next')
  assert.deepEqual(rowIds(h), ['interview-row-twitter:75', 'interview-row-twitter:74', 'interview-row-twitter:73', 'interview-row-reddit:9223372036854775807'])
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  await h.change('interviews-question-select', options(h)[1].props.value)
  assert.equal(selectedPrompt(h), 'Other'); assert.deepEqual(rowIds(h), ['interview-row-twitter:-9223372036854775808'])
  assert.equal(h.byId('interviews-next').props.disabled, true)
  await h.click('interviews-records-mode'); assert.equal(rowIds(h).length, 25)
  assert.equal(calls.getSavedInterviews.length, 1); assert.equal(calls.getSimulationHistory.length, 0)
  assert.deepEqual({ ...h.router.currentRoute.value.query }, {})
  assert.doesNotMatch(h.text(), /savedInterviews\./); assert.deepEqual(h.warnings, [])
})

test('all complete prompts beyond record page one are selectable and the selector is bounded to 200 groups', async t => {
  const { h, calls } = await setup(t)
  const rows = ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 100 }, (_, i) => record(platform, String(100 - i), { prompt: `${platform} prompt ${i}` })))
  await resolve(calls.getSavedInterviews[0], observation({ records: rows })); await h.click('interviews-questions-mode')
  assert.equal(options(h).length, 200)
  await h.change('interviews-question-select', options(h)[199].props.value)
  assert.equal(selectedPrompt(h), 'reddit prompt 99'); assert.deepEqual(rowIds(h), ['interview-row-reddit:1'])
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('ungrouped payloads stay reachable and timestamp-only truncation stays in its complete question', async t => {
  const { h, calls } = await setup(t)
  const rows = [record('twitter', '6', { prompt: '' }), record('twitter', '5', { prompt: null, warnings: ['missing_prompt'] }), record('twitter', '4', { prompt: null, response: null, payload_kind: 'raw', raw_preview: '<img>raw', warnings: ['invalid_json'] }), record('twitter', '3', { prompt: 'Partial claim', truncated: true, warnings: ['payload_truncated'] }), record('twitter', '2', { prompt: 'Complete', truncated: true, warnings: ['timestamp_truncated'] }), record('twitter', '1', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] })]
  await resolve(calls.getSavedInterviews[0], observation({ records: rows })); await h.click('interviews-questions-mode')
  assert.equal(options(h).length, 2); assert.match(h.text(options(h)[0]), /empty saved prompt/i)
  assert.match(h.text(h.byId('interviews-question-ungrouped')), /4.*ungrouped/i)
  assert.match(h.text(h.byId('interviews-question-ungrouped')), /missing.*raw.*incomplete/i)
  await h.change('interviews-question-select', options(h)[1].props.value)
  assert.equal(selectedPrompt(h), 'Complete'); assert.deepEqual(rowIds(h), ['interview-row-twitter:2']); assert.match(h.text(), /timestamp preview was truncated/i)
  await h.click('interviews-records-mode'); assert.equal(rowIds(h).length, 6); assert.ok(h.text().includes('<img>raw'))
})

for (const [status, warning] of [['missing', 'source_missing'], ['unreadable', 'source_unreadable'], ['too_large', 'database_too_large'], ['query_limited', 'query_limited']]) test(`question review preserves partial source coverage with ${status} and avoids claiming absent answers`, async t => {
  const { h, calls } = await setup(t)
  const rows = Array.from({ length: 100 }, (_, i) => record('twitter', String(100 - i)))
  const data = observation({ records: rows, sources: { twitter: source({ returned_count: 100, has_more: true, coverage: 'partial', warnings: ['row_limit'] }), reddit: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }) } })
  await resolve(calls.getSavedInterviews[0], data); await h.click('interviews-questions-mode')
  assert.match(h.text(h.byId('interviews-source-twitter')), /returned rows: 100/i)
  assert.match(h.text(h.byId('interviews-source-twitter')), /more matching saved rows/i)
  assert.match(h.text(h.byId('interviews-source-reddit')), /unknown/i)
  assert.doesNotMatch(h.text(h.byId('interviews-source-reddit')), /no matching saved interviews/i)
  assert.match(h.text(), /missing.*limited.*unhealthy/i)
  assert.match(h.text(h.byId('interviews-question-counts-reddit')), /0/)
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('question mode with no complete prompts explains empty grouping and retains full export', async t => {
  const { h, calls } = await setup(t)
  const data = observation({ records: [record('twitter', '1', { prompt: null, warnings: ['missing_prompt'] })] })
  await resolve(calls.getSavedInterviews[0], data); await h.click('interviews-questions-mode')
  assert.equal(h.byId('interviews-question-select').props.disabled, true)
  assert.match(h.text(), /no complete saved prompts/i); assert.equal(rowIds(h).length, 0)
  assert.equal(h.byId('interviews-next').props.disabled, true)
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  await h.click('interviews-records-mode'); assert.equal(rowIds(h).length, 1)
})

test('retained mode, selection and paging callbacks cannot change another view in the same observation', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0], multipleQuestions())
  assert.ok(h.byId('interviews-questions-mode'), 'saved-question review control must exist')
  const oldMode = h.byId('interviews-questions-mode').props.onClick
  await h.click('interviews-questions-mode')
  const oldSelect = h.byId('interviews-question-select').props.onChange
  const oldNext = h.byId('interviews-next').props.onClick
  const oldRecords = h.byId('interviews-records-mode').props.onClick
  await h.change('interviews-question-select', options(h)[1].props.value)
  oldSelect(event('question-0')); oldNext(event()); oldRecords(event()); oldMode(event()); await flush()
  assert.equal(selectedPrompt(h), 'Second question'); assert.equal(mode(h), true)
  assert.equal(rowIds(h)[0], 'interview-row-reddit:100')
  const priorPage = h.byId('interviews-next').props.onClick
  await h.click('interviews-next'); const oldPrevious = h.byId('interviews-previous').props.onClick
  await h.click('interviews-records-mode'); priorPage(event()); oldPrevious(event()); await flush()
  assert.equal(mode(h), false); assert.equal(rowIds(h)[0], 'interview-row-twitter:100')
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('refresh with reused IDs retires exact old observation handlers and starts in record mode', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0], multipleQuestions()); await h.click('interviews-questions-mode')
  const oldMode = h.byId('interviews-questions-mode').props.onClick, oldSelect = h.byId('interviews-question-select').props.onChange, oldPage = h.byId('interviews-next').props.onClick
  await h.click('interviews-refresh')
  oldMode(event()); oldSelect(event('question-1')); oldPage(event()); await flush()
  assert.equal(Boolean(h.byId('interviews-results')), false)
  const replacement = multipleQuestions(); replacement.records.forEach(row => { row.prompt = `Replacement ${row.platform}`; row.response = 'NEW' })
  await resolve(calls.getSavedInterviews.at(-1), replacement)
  assert.equal(mode(h), false); await h.click('interviews-questions-mode')
  oldMode(event()); oldSelect(event('question-1')); oldPage(event()); await flush()
  assert.equal(selectedPrompt(h), 'Replacement twitter'); assert.equal(rowIds(h)[0], 'interview-row-twitter:100')
  assert.equal(calls.getSavedInterviews.length, 2)
})

test('route A to B to A and filter edits retire groups despite old successes and failures', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0], multipleQuestions()); await h.click('interviews-questions-mode')
  const oldMode = h.byId('interviews-questions-mode').props.onClick, oldSelect = h.byId('interviews-question-select').props.onChange, oldNext = h.byId('interviews-next').props.onClick
  await h.navigate('/simulation/sim_B/interviews'); await h.navigate(path)
  calls.getSavedInterviews[1].reject(new Error('OLD_PRIVATE')); await flush()
  assert.ok(h.byId('interviews-loading')); assert.equal(Boolean(h.byId('interviews-results')), false)
  await resolve(calls.getSavedInterviews[2], multipleQuestions())
  oldMode(event()); oldSelect(event('question-1')); oldNext(event()); await flush()
  assert.equal(mode(h), false); assert.equal(rowIds(h)[0], 'interview-row-twitter:100')
  await h.click('interviews-questions-mode'); await h.input('interviews-agent-id', '0')
  oldMode(event()); oldSelect(event('question-1')); oldNext(event()); await flush()
  assert.equal(Boolean(h.byId('interviews-results')), false)
  await h.click('interviews-apply'); await resolve(calls.getSavedInterviews[3], { ...multipleQuestions(), filters: { platform: null, agent_id: '0' } })
  assert.equal(mode(h), false); assert.doesNotMatch(h.text(), /OLD_PRIVATE/)
})

test('language changes preserve current group and full literal prompt while Back, Forward and unmount retire it', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0], multipleQuestions()); await h.click('interviews-questions-mode')
  await h.change('interviews-question-select', options(h)[1].props.value)
  h.i18n.global.locale.value = 'zh'; await flush()
  assert.equal(selectedPrompt(h), 'Second question'); assert.doesNotMatch(h.text(), /savedInterviews\./)
  const oldSelect = h.byId('interviews-question-select').props.onChange, oldPage = h.byId('interviews-next').props.onClick
  await h.navigate(`${path}?platform=twitter`); await h.back()
  await resolve(calls.getSavedInterviews.at(-1), multipleQuestions()); assert.equal(mode(h), false)
  await h.forward(); await resolve(calls.getSavedInterviews.at(-1), windowObservation({ filters: { platform: 'twitter', agent_id: null }, records: multipleQuestions().records.filter(row => row.platform === 'twitter') }))
  oldSelect(event('question-1')); oldPage(event()); await flush(); assert.equal(mode(h), false)
  await h.click('interviews-questions-mode'); const currentSelect = h.byId('interviews-question-select').props.onChange
  h.unmount(); currentSelect(event('question-0')); oldPage(event()); await flush()
  assert.equal(h.root.children.length, 0); assert.equal(calls.getSavedInterviews.at(-1).signal.aborted, true)
  assert.equal(calls.getSavedInterviews.length, 4); assert.deepEqual(h.warnings, [])
})
