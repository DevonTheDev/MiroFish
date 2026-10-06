import assert from 'node:assert/strict'
import test from 'node:test'
import { setup, resolve, observation, record, source, flush } from './helpers/saved-interviews-view-fixture.js'

const malformed = [
  ['version', d => { d.version = 2 }], ['ID', d => { d.simulation_id = 'other' }],
  ['order', d => { d.order = 'timestamp' }], ['time', d => { d.observed_at = null }],
  ['extra field', d => { d.secret = 'hidden' }], ['missing field', d => { delete d.version }],
  ['filter', d => { d.filters.agent_id = '1' }], ['extra filter', d => { d.filters.q = null }],
  ['numeric ID', d => { d.records[0].agent_id = 0 }], ['padded ID', d => { d.records[0].agent_id = '00' }],
  ['overflow ID', d => { d.records[0].agent_id = '9223372036854775808' }], ['negative agent', d => { d.records[0].agent_id = '-1' }],
  ['numeric row', d => { d.records[0].row_id = 1 }], ['negative zero row', d => { d.records[0].row_id = '-0' }],
  ['overflow row', d => { d.records[0].row_id = '-9223372036854775809' }], ['record ID mismatch', d => { d.records[0].record_id = 'reddit:1' }],
  ['duplicate row', d => { d.records.push(d.records[0]); d.sources.twitter.returned_count++ }],
  ['platform order', d => { d.records.reverse() }], ['row order', d => { d.records = [record('twitter', '1'), record('twitter', '2')]; d.sources.twitter.returned_count = 2; d.sources.reddit.returned_count = 0 }],
  ['extra record', d => { d.records[0].secret = 'hidden' }], ['missing record key', d => { delete d.records[0].raw_preview }],
  ['nontext prompt', d => { d.records[0].prompt = {} }], ['oversized prompt', d => { d.records[0].prompt = 'x'.repeat(16385) }],
  ['oversized timestamp', d => { d.records[0].timestamp = 'x'.repeat(257) }], ['raw as structured', d => { d.records[0].raw_preview = 'secret' }],
  ['raw decoded fields', d => { d.records[0].payload_kind = 'raw'; d.records[0].raw_preview = 'raw' }],
  ['missing with bytes', d => { d.records[0].payload_kind = 'missing'; d.records[0].prompt = null; d.records[0].response = null }],
  ['negative bytes', d => { d.records[0].payload_bytes = -1 }], ['nonboolean truncated', d => { d.records[0].truncated = 1 }],
  ['unknown warning', d => { d.records[0].warnings = ['private_text'] }], ['repeated warning', d => { d.records[0].warnings = ['missing_prompt', 'missing_prompt'] }],
  ['unknown source warning', d => { d.sources.twitter.warnings = ['private_text'] }], ['source count', d => { d.sources.twitter.returned_count = 0 }],
  ['unknown status', d => { d.sources.twitter.status = 'corrupt' }], ['unknown coverage', d => { d.sources.twitter.coverage = 'maybe' }],
  ['unrequested with records', d => { d.sources.twitter.status = 'not_requested'; d.sources.twitter.coverage = 'not_requested' }],
  ['unknown source', d => { d.sources.mastodon = source() }], ['extra source key', d => { d.sources.twitter.total = 1 }],
  ['raw without warning', d => { d.records[0].payload_kind = 'raw'; d.records[0].prompt = null; d.records[0].response = null; d.records[0].raw_preview = '{bad' }],
  ['source missing without warning', d => { d.records = []; d.sources.twitter = source({ status: 'missing', has_more: null, coverage: 'unavailable' }); d.sources.reddit = source(); d.availability = 'partial' }],
  ['unavailable falsely exhausted', d => { d.records = []; d.sources.twitter = source({ status: 'unreadable', has_more: false, coverage: 'unavailable', warnings: ['source_unreadable'] }); d.sources.reddit = source(); d.availability = 'partial' }],
  ['available with missing warning', d => { d.sources.twitter.warnings = ['source_missing']; d.sources.twitter.coverage = 'partial'; d.availability = 'partial' }],
  ['more without reason', d => { d.sources.twitter.has_more = true; d.sources.twitter.coverage = 'partial'; d.availability = 'partial' }],
  ['false row limit', d => { d.sources.twitter.has_more = true; d.sources.twitter.coverage = 'partial'; d.sources.twitter.warnings = ['row_limit']; d.availability = 'partial' }],
  ['wrong platform budget', d => { d.limits.response_bytes_per_platform = 4186112 }],
  ['wrong limit', d => { d.limits.rows_per_platform = 101 }], ['missing limit', d => { delete d.limits.response_bytes }],
  ['unknown limit', d => { d.limits.all_rows = 200 }], ['false complete coverage', d => { d.sources.twitter.has_more = true }],
  ['wrong overall coverage', d => { d.availability = 'partial' }], ['unknown has more', d => { d.sources.twitter.has_more = 'true' }],
  ['missing source claims empty', d => { d.records = []; d.sources.twitter = source({ status: 'missing' }); d.sources.reddit = source() }],
]
for (const [label, mutate] of malformed) test(`rejects ${label} and cannot export it`, async t => {
  const { h, calls } = await setup(t), data = observation(); mutate(data)
  await resolve(calls.getSavedInterviews[0], data)
  assert.equal(Boolean(h.byId('interviews-results')), false); assert.ok(h.byId('interviews-error')); assert.equal(h.byId('interviews-download').props.disabled, true)
})
for (const envelope of [d => ({ success: 'true', data: d }), d => ({ success: 1, data: d }), d => ({ success: true, data: d, hidden: true }), d => ({ success: true }), d => ({ data: d })]) test('rejects an invalid outer success envelope', async t => {
  const { h, calls } = await setup(t); assert.ok(calls.getSavedInterviews[0]); calls.getSavedInterviews[0].resolve(envelope(observation())); await flush()
  assert.equal(Boolean(h.byId('interviews-results')), false); assert.ok(h.byId('interviews-error'))
})
test('rejects a row outside the exact requested platform or agent filter', async t => {
  for (const records of [[record('reddit')], [record('twitter', '1', { agent_id: '1' })]]) {
    const { h, calls } = await setup(t, '/simulation/sim_A/interviews?platform=twitter&agent_id=0')
    await resolve(calls.getSavedInterviews[0], observation({ filters: { platform: 'twitter', agent_id: '0' }, records }))
    assert.equal(Boolean(h.byId('interviews-results')), false); assert.ok(h.byId('interviews-error'))
  }
})
test('accepts signed row extrema and replacement-decoded raw previews without rounding', async t => {
  const { h, calls } = await setup(t)
  const rows = [record('twitter', '9223372036854775807'), record('twitter', '-9223372036854775808', { prompt: null, response: null, payload_kind: 'raw', raw_preview: '\ufffd'.repeat(16384), warnings: ['invalid_utf8'] })]
  await resolve(calls.getSavedInterviews[0], observation({ records: rows })); assert.ok(h.byId('interviews-results'))
  await h.click('interviews-download'); assert.equal(JSON.parse(await h.downloads[0].blob.text()).records[1].row_id, '-9223372036854775808')
})
