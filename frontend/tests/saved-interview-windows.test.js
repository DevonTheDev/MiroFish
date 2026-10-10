import assert from 'node:assert/strict'
import test from 'node:test'
import { validSavedInterviewObservation } from '../src/utils/savedInterviewObservation.js'
import { observation, record, source, setup, resolve, flush } from './helpers/saved-interviews-view-fixture.js'

const revision = 'a'.repeat(64)
const windowObservation = (overrides = {}) => observation({ version: 2,
  filters: { platform: 'twitter', agent_id: '0' },
  records: [record('twitter', '-9223372036854775808')],
  window: { before_row: '9007199254740993', source_revision: revision }, ...overrides })

test('admits exact signed row window provenance without weakening v1', () => {
  const data = windowObservation()
  assert.equal(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), true)
  const v1 = observation()
  assert.equal(validSavedInterviewObservation(v1, { simulation_id: v1.simulation_id, filters: v1.filters }), true)
})

for (const [label, mutate] of [
  ['unknown version', d => { d.version = 3 }], ['missing context', d => { delete d.window }],
  ['extra context', d => { d.window.offset = 1 }], ['numeric boundary', d => { d.window.before_row = 1 }],
  ['negative zero', d => { d.window.before_row = '-0' }], ['overflow', d => { d.window.before_row = '-9223372036854775809' }],
  ['bad revision', d => { d.window.source_revision = 'A'.repeat(64) }], ['wrong side of boundary', d => { d.window.before_row = '-9223372036854775808' }],
  ['both platforms', d => { d.filters.platform = null; d.limits.response_bytes_per_platform = 2093056 }],
  ['v1 with context', d => { d.version = 1 }],
]) test(`rejects invalid window ${label}`, () => {
  const data = windowObservation(); mutate(data)
  assert.equal(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), false)
})

const initialPath = '/simulation/sim_A/interviews?platform=twitter&agent_id=0'
const newest = () => windowObservation({ records: Array.from({ length: 100 }, (_, i) => record('twitter', String(205 - i))),
  window: { before_row: null, source_revision: revision }, availability: 'partial',
  sources: { twitter: source({ returned_count: 100, has_more: true, coverage: 'partial', warnings: ['row_limit'] }),
    reddit: source({ status: 'not_requested', has_more: null, coverage: 'not_requested' }) } })
const event = () => ({ preventDefault() {}, stopPropagation() {} })

test('selected platform acquires its revision and older uses full observation below local search/page', async t => {
  const { h, calls } = await setup(t, initialPath)
  assert.deepEqual({ ...calls.getSavedInterviews[0].args[1] }, { platform: 'twitter', agent_id: '0', window: '1' })
  await resolve(calls.getSavedInterviews[0], newest())
  await h.click('interviews-next'); await h.input('interviews-search', 'absent')
  const older = h.byId('interviews-older').props.onClick, download = h.byId('interviews-download').props.onClick
  older(event()); older(event()); download(event()); await flush()
  assert.equal(calls.getSavedInterviews.length, 2)
  assert.equal(h.downloads.length, 0)
  assert.deepEqual({ ...calls.getSavedInterviews[1].args[1] }, { platform: 'twitter', agent_id: '0', window: '1', before_row: '106', revision })
  assert.equal(Boolean(h.byId('interviews-results')), false)
  const data = windowObservation({ records: [record('twitter', '1', { prompt: 'Old unique question', response: '<literal> oldest reply 雪' })], window: { before_row: '106', source_revision: revision } })
  await resolve(calls.getSavedInterviews[1], data)
  assert.ok(h.text().includes('<literal> oldest reply 雪'))
  assert.ok(h.text().includes('106') && h.text().includes(revision))
  assert.equal(h.byId('interviews-older').props.disabled, true)
  await h.click('interviews-download'); assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), data)
  await h.click('interviews-refresh')
  assert.deepEqual({ ...calls.getSavedInterviews[2].args[1] }, { platform: 'twitter', agent_id: '0', window: '1' })
  assert.equal(h.router.currentRoute.value.query.before_row, undefined)
})

test('409 retires accepted controls and exposes deliberate Refresh newest without automatic reads', async t => {
  const { h, calls } = await setup(t, initialPath); await resolve(calls.getSavedInterviews[0], newest())
  const stale = h.byId('interviews-older').props.onClick
  await h.click('interviews-older')
  calls.getSavedInterviews[1].reject({ response: { status: 409, data: { error_code: 'source_changed' } } }); await flush()
  assert.match(h.text(h.byId('interviews-error')), /changed/i)
  assert.match(h.text(h.byId('interviews-refresh')), /Refresh newest/i)
  stale(event()); await flush(); assert.equal(calls.getSavedInterviews.length, 2)
  assert.equal(h.byId('interviews-download').props.disabled, true)
  await h.click('interviews-refresh')
  assert.equal(calls.getSavedInterviews.length, 3)
  assert.equal(calls.getSavedInterviews[2].args[1].before_row, undefined)
})

for (const retire of ['filter', 'route', 'file', 'unmount']) test(`older callback is inert after ${retire} retirement`, async t => {
  const { h, calls } = await setup(t, initialPath); await resolve(calls.getSavedInterviews[0], newest())
  const stale = h.byId('interviews-older').props.onClick
  if (retire === 'filter') await h.input('interviews-agent-id', '1')
  else if (retire === 'route') { await h.navigate('/simulation/sim_B/interviews'); await h.navigate(initialPath) }
  else if (retire === 'file') { await h.navigate('/interview-files'); await h.navigate(initialPath) }
  else h.unmount()
  const count = calls.getSavedInterviews.length; stale(event()); await flush()
  assert.equal(calls.getSavedInterviews.length, count)
})

test('zero retained rows and query-limited windows never offer a safe continuation', async t => {
  for (const status of ['available', 'query_limited']) {
    const { h, calls } = await setup(t, initialPath)
    const data = windowObservation({ records: [], window: { before_row: null, source_revision: revision },
      sources: { twitter: source({ status, returned_count: 0, has_more: status === 'available' ? true : null,
        coverage: status === 'available' ? 'partial' : 'unavailable', warnings: [status === 'available' ? 'response_limit' : 'query_limited'] }),
      reddit: source({ status: 'not_requested', has_more: null, coverage: 'not_requested' }) },
      availability: status === 'available' ? 'partial' : 'unavailable' })
    await resolve(calls.getSavedInterviews[0], data)
    assert.equal(h.byId('interviews-older').props.disabled, true)
    assert.match(h.text(h.byId('interviews-older-reason')), status === 'available' ? /No row fits/ : /unavailable or query-limited/)
    assert.ok(h.text().includes(h.i18n.global.t(`savedInterviews.warnings.${status === 'available' ? 'response_limit' : 'query_limited'}`)))
    await flush(); assert.equal(calls.getSavedInterviews.length, 1)
  }
})

for (const query of ['window=1', 'platform=twitter&window=2', 'platform=twitter&before_row=1', `platform=twitter&window=1&before_row=-0&revision=${revision}`,
  `platform=twitter&window=1&revision=${revision}`, `platform=twitter&window=1&before_row=1&revision=${revision}&revision=${revision}`])
test(`invalid route window makes no API request: ${query}`, async t => {
  const { h, calls } = await setup(t, '/simulation/sim_A/interviews?' + query)
  assert.equal(calls.getSavedInterviews.length, 0); assert.ok(h.byId('interviews-error'))
})

for (const ending of ['\n', '\r', '\u2028']) {
  test(`rejects revision line terminator in file admission ${JSON.stringify(ending)}`, () => {
    const data = windowObservation(); data.window.source_revision += ending
    assert.equal(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), false)
  })
  test(`rejects revision line terminator before route read ${JSON.stringify(ending)}`, async t => {
    const { h, calls } = await setup(t, initialPath + `&window=1&before_row=106&revision=${revision}${encodeURIComponent(ending)}`)
    assert.equal(calls.getSavedInterviews.length, 0); assert.ok(h.byId('interviews-error'))
  })
}
