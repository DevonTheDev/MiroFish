import assert from 'node:assert/strict'
import test from 'node:test'
import { setup, resolve, observation, record, flush } from './helpers/saved-interviews-view-fixture.js'

const rowIds = h => h.all(node => String(node.props['data-testid'] ?? '').startsWith('interview-row-')).map(node => node.props['data-testid'])
const options = h => h.byId('interviews-question-select').children.filter(node => node.type === 'option')
const query = h => h.byId('interviews-search').props.value
function search(h) {
  const input = h.byId('interviews-search')
  assert.ok(input, 'Find saved text input must exist for an accepted observation')
  return input.props.onInput
}
function manyRows() {
  return observation({ records: [
    ...Array.from({ length: 28 }, (_, i) => record('twitter', String(100 - i), { prompt: 'First question', response: i === 27 ? 'Hidden MATCH [.*] <img src=x>' : `Saved answer ${i}` })),
    record('reddit', '2', { prompt: 'First question', response: 'Another match' }),
    record('reddit', '1', { prompt: 'Second question', response: 'Second match' }),
  ] })
}

for (const locale of ['en', 'zh']) test(`local search is accessible, searches before paging and preserves complete downloads in ${locale}`, async t => {
  const { h, calls } = await setup(t, '/simulation/sim_A/interviews', locale)
  assert.equal(h.byId('interviews-search'), undefined)
  const data = manyRows(), original = JSON.stringify(data)
  await resolve(calls.getSavedInterviews[0], data)
  search(h)
  const input = h.byId('interviews-search'), status = h.byId('interviews-search-count')
  assert.equal(input.type, 'input'); assert.equal(input.props.type, 'search')
  assert.ok(h.find(node => node.type === 'label' && node.props.for === input.props.id))
  assert.equal(status.props.role, 'status'); assert.equal(status.props['aria-live'], 'polite')
  assert.ok(input.props['aria-describedby'].split(' ').includes('interviews-search-note'))
  assert.ok(input.props['aria-describedby'].split(' ').includes(status.props.id))
  assert.equal(h.byId('interviews-search-clear').props.disabled, true)
  assert.match(h.text(status), /30.*30/)
  if (locale === 'en') assert.match(h.text(h.byId('interviews-search-note')), /accepted.*stored.*missing.*truncated/is)
  else assert.match(h.text(h.byId('interviews-search-note')), /已接受.*已保存.*缺失.*截断/s)
  const summaries = h.all(node => node.props.class === 'panel source-summary').map(node => h.text(node))
  await h.click('interviews-next')
  await h.input('interviews-search', 'mAtCh')
  assert.equal(query(h), 'mAtCh')
  assert.deepEqual(rowIds(h), ['interview-row-twitter:73', 'interview-row-reddit:2', 'interview-row-reddit:1'])
  assert.equal(h.byId('interviews-previous').props.disabled, true)
  assert.equal(h.byId('interviews-next').props.disabled, true)
  assert.match(h.text(h.byId('interviews-search-count')), /3.*30/)
  assert.deepEqual(h.all(node => node.props.class === 'panel source-summary').map(node => h.text(node)), summaries)
  await h.input('interviews-search', '[.*] <img src=x>')
  assert.deepEqual(rowIds(h), ['interview-row-twitter:73'])
  assert.ok(h.text().includes('Hidden MATCH [.*] <img src=x>'))
  assert.equal(h.all(node => ['img', 'script', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
  await h.click('interviews-download')
  assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.equal(JSON.stringify(data), original)
  await h.click('interviews-search-clear')
  assert.equal(query(h), ''); assert.equal(rowIds(h).length, 25)
  assert.match(h.text(h.byId('interviews-search-count')), /30.*30/)
  assert.equal(calls.getSavedInterviews.length, 1); assert.equal(calls.getSimulationHistory.length, 0)
  assert.equal(h.router.currentRoute.value.fullPath, '/simulation/sim_A/interviews')
  assert.doesNotMatch(h.text(), /savedInterviews\./); assert.deepEqual(h.warnings, [])
})

test('search preserves literal spaces, raw previews, missing payloads and their source warnings', async t => {
  const { h, calls } = await setup(t)
  const data = observation({ records: [
    record('twitter', '4', { prompt: ' left ', response: 'right', warnings: [] }),
    record('twitter', '3', { prompt: null, response: null, raw_preview: 'RAW [.*]  ', payload_kind: 'raw', truncated: true, warnings: ['invalid_json', 'payload_truncated'] }),
    record('twitter', '2', { prompt: null, response: null, raw_preview: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
    record('twitter', '1', { prompt: 'é', response: 'end' }),
  ] })
  await resolve(calls.getSavedInterviews[0], data); search(h)
  const summaries = h.all(node => node.props.class === 'panel source-summary').map(node => h.text(node))
  await h.input('interviews-search', '  ')
  assert.deepEqual(rowIds(h), ['interview-row-twitter:3'])
  assert.match(h.text(h.byId('interview-row-twitter:3')), /truncated/i)
  await h.input('interviews-search', 'left right')
  assert.deepEqual(rowIds(h), []); assert.ok(h.byId('interviews-search-empty'))
  assert.match(h.text(h.byId('interviews-search-count')), /0.*4/)
  await h.input('interviews-search', 'e\u0301')
  assert.deepEqual(rowIds(h), []); assert.ok(h.byId('interviews-search-empty'))
  assert.deepEqual(h.all(node => node.props.class === 'panel source-summary').map(node => h.text(node)), summaries)
  await h.click('interviews-search-clear')
  assert.deepEqual(rowIds(h), ['interview-row-twitter:4', 'interview-row-twitter:3', 'interview-row-twitter:2', 'interview-row-twitter:1'])
  assert.equal(h.byId('interviews-search-empty'), undefined)
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('query persists through records, exact questions and local pages while group counts stay unfiltered', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], manyRows()); search(h)
  await h.input('interviews-search', 'answer')
  await h.click('interviews-next'); assert.equal(query(h), 'answer'); assert.equal(rowIds(h).length, 2)
  await h.click('interviews-questions-mode')
  assert.equal(query(h), 'answer'); assert.equal(rowIds(h).length, 25)
  assert.match(h.text(h.byId('interviews-search-count')), /27.*29/)
  assert.match(h.text(h.byId('interviews-question-counts-twitter')), /28/)
  assert.match(h.text(h.byId('interviews-question-counts-reddit')), /1/)
  assert.equal(options(h).length, 2)
  await h.change('interviews-question-select', options(h)[1].props.value)
  assert.equal(query(h), 'answer'); assert.deepEqual(rowIds(h), [])
  assert.ok(h.byId('interviews-search-empty')); assert.match(h.text(h.byId('interviews-search-count')), /0.*1/)
  await h.input('interviews-search', 'match')
  assert.deepEqual(rowIds(h), ['interview-row-reddit:1'])
  await h.click('interviews-records-mode')
  assert.equal(query(h), 'match'); assert.equal(rowIds(h).length, 3)
  h.i18n.global.locale.value = 'zh'; await flush()
  assert.equal(query(h), 'match'); assert.doesNotMatch(h.text(), /savedInterviews\./)
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('retained search and clear callbacks cannot alter later query, page or question presentations', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], manyRows())
  const firstInput = search(h)
  await h.input('interviews-search', 'answer')
  const oldInput = search(h), oldClear = h.byId('interviews-search-clear').props.onClick
  await h.click('interviews-next')
  let reads = 0
  oldInput({ target: { get value() { reads++; return 'match' } } }); oldClear(); firstInput({ target: { value: 'match' } }); await flush()
  assert.equal(reads, 0); assert.equal(query(h), 'answer'); assert.equal(rowIds(h).length, 2)
  const pageInput = search(h), pageClear = h.byId('interviews-search-clear').props.onClick
  await h.click('interviews-questions-mode')
  pageInput({ target: { value: 'match' } }); pageClear(); await flush()
  assert.equal(query(h), 'answer'); assert.equal(rowIds(h).length, 25)
  const questionInput = search(h), questionClear = h.byId('interviews-search-clear').props.onClick
  await h.change('interviews-question-select', options(h)[1].props.value)
  questionInput({ target: { value: 'match' } }); questionClear(); await flush()
  assert.equal(query(h), 'answer'); assert.deepEqual(rowIds(h), [])
  await h.input('interviews-search', 'Second')
  const queryInput = search(h), queryClear = h.byId('interviews-search-clear').props.onClick
  await h.input('interviews-search', 'match')
  queryInput({ target: { value: 'answer' } }); queryClear(); await flush()
  assert.equal(query(h), 'match'); assert.deepEqual(rowIds(h), ['interview-row-reddit:1'])
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('search reads its value once and rejects non-string values without coercion or state changes', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], manyRows())
  let reads = 0
  search(h)({ target: { get value() { reads++; return reads === 1 ? 'answer' : 'match' } } }); await flush()
  assert.equal(reads, 1); assert.equal(query(h), 'answer')
  await h.click('interviews-next')
  for (const value of [null, undefined, false, 0, [], { toString() { assert.fail('search must not coerce objects') } }]) {
    search(h)({ target: { value } }); await flush()
    assert.equal(query(h), 'answer'); assert.equal(rowIds(h).length, 2)
  }
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('input getters that change the owned page or clear the query cannot overwrite the newer presentation', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], manyRows()); search(h)
  await h.input('interviews-search', 'answer')
  const next = h.byId('interviews-next').props.onClick
  search(h)({ target: { get value() { next(); return 'match' } } }); await flush()
  assert.equal(query(h), 'answer'); assert.equal(rowIds(h).length, 2)
  const clear = h.byId('interviews-search-clear').props.onClick
  search(h)({ target: { get value() { clear(); return 'match' } } }); await flush()
  assert.equal(query(h), ''); assert.equal(rowIds(h).length, 25)
  assert.equal(calls.getSavedInterviews.length, 1)
})

test('input value access cannot restore retired query state across synchronous route retirement', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], manyRows()); search(h)
  await h.input('interviews-search', 'answer')
  search(h)({ target: { get value() { h.router.currentRoute.value = h.router.resolve('/simulation/sim_B/interviews'); return 'match' } } }); await flush()
  assert.equal(h.byId('interviews-search'), undefined)
  await resolve(calls.getSavedInterviews.at(-1), observation({ simulation_id: 'sim_B' }))
  assert.equal(query(h), ''); assert.equal(rowIds(h).length, 2)
  assert.equal(calls.getSavedInterviews.length, 2)
})

test('question value access cannot restore the earlier query after a reentrant search update', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], observation({ records: [
    record('twitter', '3', { prompt: 'First question', response: 'old filter' }),
    record('twitter', '2', { prompt: 'Second question', response: 'new filter' }),
  ] }))
  await h.input('interviews-search', 'old'); await h.click('interviews-questions-mode')
  const input = search(h), select = h.byId('interviews-question-select').props.onChange
  const secondKey = options(h)[1].props.value
  let reads = 0
  select({ target: { get value() { reads++; input({ target: { value: 'new' } }); return secondKey } } }); await flush()
  assert.equal(reads, 1)
  assert.equal(query(h), 'new', 'the older question callback must not replace the newer query')
  assert.equal(h.text(h.byId('interviews-question-prompt')), 'First question')
  assert.deepEqual(rowIds(h), []); assert.ok(h.byId('interviews-search-empty'))
  assert.equal(calls.getSavedInterviews.length, 1)
  assert.deepEqual(h.warnings, [])
})
