import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBoundedJson } from '../src/utils/boundedJson.js'
import { validSavedInterviewDecimal, validSavedInterviewObservation, validSavedInterviewSelection, savedInterviewExactKeys } from '../src/utils/savedInterviewObservation.js'
import { readSavedInterviewFile, SAVED_INTERVIEW_FILE_MAX_BYTES } from '../src/utils/savedInterviewFiles.js'

const limits = { rows_per_platform: 100, rows_total: 200, database_bytes: 167772160, wal_bytes: 67108864, vm_operations_per_platform: 2000000, lock_timeout_seconds: 0.25, payload_bytes: 16384, timestamp_bytes: 256, response_bytes: 4194304 }
const record = (platform = 'twitter', row_id = '1', extra = {}) => ({ platform, row_id, record_id: `${platform}:${row_id}`, agent_id: '0', timestamp: '2026-10-06T09:00:00Z', prompt: 'Saved prompt', response: `${platform} saved reply`, payload_kind: 'structured', raw_preview: null, payload_bytes: 80, truncated: false, warnings: [], ...extra })
const source = (extra = {}) => ({ status: 'available', returned_count: 0, has_more: false, coverage: 'complete', warnings: [], ...extra })
function observation(extra = {}) {
  const records = extra.records ?? [record('twitter'), record('reddit')]
  const filters = extra.filters ?? { platform: null, agent_id: null }
  const sources = extra.sources ?? Object.fromEntries(['twitter', 'reddit'].map(platform => [platform, filters.platform && filters.platform !== platform ? source({ status: 'not_requested', has_more: null, coverage: 'not_requested' }) : source({ returned_count: records.filter(row => row.platform === platform).length, ...(records.some(row => row.platform === platform && row.warnings.length) ? { coverage: 'partial', warnings: ['record_warnings'] } : {}) })]))
  const requested = Object.values(sources).filter(item => item.status !== 'not_requested')
  const availability = requested.every(item => item.coverage === 'complete') ? 'complete' : requested.some(item => ['complete', 'partial'].includes(item.coverage)) ? 'partial' : 'unavailable'
  return { version: 1, simulation_id: 'sim_A', filters, observed_at: '2026-10-06T09:00:00Z', order: 'platform_then_row_desc', limits: { ...limits, response_bytes_per_platform: filters.platform === null ? 2093056 : 4186112 }, availability, sources, records, ...extra }
}
const selection = data => ({ simulation_id: data.simulation_id, filters: data.filters })
const bytes = text => new TextEncoder().encode(text)
const file = input => {
  const payload = typeof input === 'string' ? bytes(input) : input
  return { size: payload.byteLength, async arrayBuffer() { return payload.slice().buffer } }
}
const download = data => file(JSON.stringify(data, null, 2) + '\n')
function reader() { assert.equal(typeof readSavedInterviewFile, 'function', 'the local saved interview reader must be available'); return readSavedInterviewFile }
const invalid = error => error instanceof Error && error.message === 'Invalid saved interview file'

test('shared decimal validation rejects the entire noncanonical input, including final newlines', () => {
  for (const value of ['0', '1', '9223372036854775807']) assert.equal(validSavedInterviewDecimal(value), true)
  for (const value of ['-9223372036854775808', '-1', '0']) assert.equal(validSavedInterviewDecimal(value, true), true)
  for (const value of ['1\n', '1\r', '1\r\n', '1\u2028', '1\u2029', ' 1', '1 ', '00', '+1', '-0', '1e1', '9223372036854775808', '', null, 1]) {
    assert.equal(validSavedInterviewDecimal(value), false, JSON.stringify(value))
    assert.equal(validSavedInterviewDecimal(value, true), false, JSON.stringify(value))
  }
  assert.equal(validSavedInterviewDecimal('-1'), false)
  assert.equal(validSavedInterviewDecimal('-9223372036854775809', true), false)
})

test('selection validation matches backend record IDs and canonical exact filters', () => {
  assert.equal(typeof validSavedInterviewSelection, 'function')
  for (const id of ['sim_A', '0', 'CON_ok', 'com0', 'lpt10', 'x'.repeat(128)]) assert.equal(validSavedInterviewSelection(selection(observation({ simulation_id: id }))), true)
  for (const id of ['', 'sim\n', 'sim/other', '.', '..', 'x'.repeat(129), 'con', 'PrN', 'AUX', 'nul', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`), 1, null]) assert.equal(validSavedInterviewSelection(selection(observation({ simulation_id: id }))), false, String(id))
  for (const selected of [null, {}, { ...selection(observation()), extra: true }, { simulation_id: 'sim_A', filters: null }, { simulation_id: 'sim_A', filters: {} }, { simulation_id: 'sim_A', filters: { platform: null, agent_id: null, extra: 1 } }, ...['', 'reddit\n', 'mastodon', [], 1].map(platform => ({ simulation_id: 'sim_A', filters: { platform, agent_id: null } })), ...['1\n', '-1', '01', '', 1].map(agent_id => ({ simulation_id: 'sim_A', filters: { platform: null, agent_id } }))]) assert.equal(validSavedInterviewSelection(selected), false)
  assert.equal(savedInterviewExactKeys(Object.assign(Object.create(null), { a: 1 }), ['a']), true)
  for (const value of [null, [], { a: 1, b: 2 }, Object.create({ a: 1 })]) assert.equal(savedInterviewExactKeys(value, ['a']), false)
})

test('observation validator rejects an invalid self-declared selection before trusting aligned fields', () => {
  for (const extra of [{ simulation_id: 'CON' }, { simulation_id: 'sim_A\n' }, { filters: { platform: 'mastodon', agent_id: null }, records: [] }, { filters: { platform: null, agent_id: '1\n' }, records: [] }]) {
    const data = observation(extra)
    assert.equal(validSavedInterviewObservation(data, selection(data)), false, JSON.stringify(extra))
  }
  const data = observation()
  for (const selected of [null, {}, { simulation_id: 'sim_A', filters: null }, { ...selection(data), extra: true }]) assert.equal(validSavedInterviewObservation(data, selected), false)
  assert.equal(validSavedInterviewObservation(data, { ...selection(data), simulation_id: 'sim_B' }), false)
  assert.equal(validSavedInterviewObservation(data, { simulation_id: 'sim_A', filters: { platform: null, agent_id: '1' } }), false)
  for (const field of ['row_id', 'agent_id']) {
    const changed = observation(); changed.records[0][field] = '1\n'
    if (field === 'row_id') changed.records[0].record_id = 'twitter:1\n'
    assert.equal(validSavedInterviewObservation(changed, selection(changed)), false, field)
  }
})

test('opens the existing bare download, preserving all 200 rows, decimal IDs and exact strings immutably', async () => {
  const rows = ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 100 }, (_, i) => record(platform, String(100 - i))))
  rows[0].row_id = '9223372036854775807'; rows[0].record_id = `twitter:${rows[0].row_id}`; rows[0].agent_id = '9223372036854775807'
  rows[1].prompt = '  <script>literal</script>\r\n\u0000e\u0301\ud800'; rows[1].response = '\udfff😀'
  const data = observation({ records: rows })
  assert.equal(SAVED_INTERVIEW_FILE_MAX_BYTES, 8 * 1024 * 1024)
  const actual = await reader()(download(data))
  assert.deepEqual(actual, data); assert.equal(actual.records.length, 200); assert.equal(actual.limits.lock_timeout_seconds, 0.25)
  const checkFrozen = value => { if (value && typeof value === 'object') { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(checkFrozen) } }
  checkFrozen(actual)
  assert.throws(() => { actual.records[1].prompt = 'changed' }, TypeError)
  assert.equal(actual.records[1].prompt, data.records[1].prompt)
})

test('retains empty, missing, raw, truncated and partial observations without inventing completion', async () => {
  const rows = [record('twitter', '3', { prompt: '', response: null, warnings: ['missing_response'] }), record('twitter', '2', { payload_kind: 'raw', prompt: null, response: null, raw_preview: '\ufffd\ud800{bad', payload_bytes: 17000, truncated: true, warnings: ['payload_truncated'] }), record('reddit', '-9223372036854775808', { agent_id: null, timestamp: null, prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['invalid_agent_id', 'missing_timestamp', 'missing_payload'] })]
  const data = observation({ records: rows })
  assert.deepEqual(await reader()(download(data)), data)
  const empty = observation({ records: [] }); assert.deepEqual(await reader()(download(empty)), empty)
  for (const [status, warning] of [['missing', 'source_missing'], ['unreadable', 'source_unreadable'], ['too_large', 'database_too_large'], ['too_large', 'wal_too_large'], ['query_limited', 'query_limited']]) {
    const unavailable = observation({ records: [], sources: { twitter: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }), reddit: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }) } })
    assert.deepEqual(await reader()(download(unavailable)), unavailable)
  }
  const filtered = observation({ filters: { platform: 'reddit', agent_id: '0' }, records: [record('reddit')] })
  assert.deepEqual(await reader()(download(filtered)), filtered)
})

test('rejects unbounded metadata before reading and verifies the actual ArrayBuffer size', async () => {
  const read = reader(), maximum = SAVED_INTERVIEW_FILE_MAX_BYTES
  for (const size of [-1, 0.25, NaN, Infinity, maximum + 1, '1', undefined]) {
    let reads = 0
    await assert.rejects(read({ size, arrayBuffer() { reads++; throw new Error('private') } }), invalid)
    assert.equal(reads, 0)
  }
  const payload = bytes(JSON.stringify(observation()))
  for (const candidate of [null, {}, { size: payload.length }, { size: payload.length, arrayBuffer: async () => payload }, { size: payload.length + 1, arrayBuffer: async () => payload.buffer }, { size: 1, arrayBuffer: async () => new ArrayBuffer(maximum + 1) }, { size: payload.length, arrayBuffer() { throw new Error('PRIVATE_FILE_PATH') } }]) await assert.rejects(read(candidate), invalid)
  const text = JSON.stringify(observation()), padded = text + ' '.repeat(maximum - bytes(text).length)
  assert.deepEqual(await read(file(padded)), observation())
  await assert.rejects(read(file(padded + ' ')), invalid)
})

test('rejects malformed UTF-8, BOM, syntax and duplicate or escaped-alias keys', async () => {
  const read = reader(), text = JSON.stringify(observation())
  for (const payload of [new Uint8Array([0xc3, 0x28]), new Uint8Array([...bytes(text), 0xff]), new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)])]) await assert.rejects(read(file(payload)), invalid)
  for (const content of ['', text + ' garbage', text.slice(0, -1), text.replace('"version":1', '"version":1,"version":1'), text.replace('"version":1', '"version":1,"\\u0076ersion":1'), text.replace('"agent_id":null', '"agent_id":null,"agent_id":null'), text.replace('"prompt":"Saved prompt"', '"prompt":"Saved prompt","\\u0070rompt":"Saved prompt"'), text.replace('"warnings":[]', '"warnings":[],"warnings":[]'), JSON.stringify({ success: true, data: observation() })]) await assert.rejects(read(file(content)), invalid)
})

test('bounded JSON value budget is optional, inclusive, and checked before further materialization', () => {
  const reject = () => { throw new Error('bounded') }
  assert.deepEqual(parseBoundedJson('[0,1,2]', 100, 4, reject), [0, 1, 2])
  assert.deepEqual(parseBoundedJson('[0,1,2]', 100, 4, reject, false, 4), [0, 1, 2])
  assert.throws(() => parseBoundedJson('[0,1,2]', 100, 4, reject, false, 3), /bounded/)
  assert.equal(Object.keys(parseBoundedJson('{"a":0}', 100, 4, reject, false, 2)).length, 1)
  assert.throws(() => parseBoundedJson('{"a":0}', 100, 4, reject, false, 1), /bounded/)
  const atLimit = '[' + Array.from({ length: 9999 }, () => 'null').join(',') + ']'
  assert.equal(parseBoundedJson(atLimit, 100000, 4, reject, false, 10000).length, 9999)
  assert.throws(() => parseBoundedJson(atLimit.replace(']', ',null]'), 100000, 4, reject, false, 10000), /bounded/)
  assert.equal(parseBoundedJson('"\\ud800"', 100, 4, reject), '\ud800')
  assert.throws(() => parseBoundedJson('"\\ud800"', 100, 4, reject, true), /bounded/)
})

test('rejects deeply nested and excessive-value files within the byte cap', async () => {
  for (const text of ['['.repeat(1000) + '0' + ']'.repeat(1000), '[' + Array.from({ length: 10001 }, () => '0').join(',') + ']']) await assert.rejects(reader()(file(text)), invalid)
})

const malformed = [
  ['root extra', d => { d.secret = 'hidden' }], ['root missing', d => { delete d.version }], ['version', d => { d.version = 2 }], ['root array', () => []],
  ['reserved simulation', d => { d.simulation_id = 'NUL' }], ['newline simulation', d => { d.simulation_id += '\n' }], ['order', d => { d.order = 'timestamp' }], ['observed time', d => { d.observed_at = null }],
  ['filter extra', d => { d.filters.q = '' }], ['filter platform', d => { d.filters.platform = 'mastodon' }], ['filter agent', d => { d.filters.agent_id = '1\n' }],
  ['agent alignment', d => { d.filters.agent_id = '1' }], ['platform alignment', d => { d.filters.platform = 'twitter'; d.limits.response_bytes_per_platform = 4186112 }],
  ['row decimal', d => { d.records[0].row_id = '1\n'; d.records[0].record_id = 'twitter:1\n' }], ['agent decimal', d => { d.records[0].agent_id = '0\n' }],
  ['row range', d => { d.records[0].row_id = '9223372036854775808'; d.records[0].record_id = 'twitter:9223372036854775808' }], ['row record ID', d => { d.records[0].record_id = 'reddit:1' }],
  ['row extra', d => { d.records[0].secret = 'x' }], ['row duplicate', d => { d.records.splice(1, 0, d.records[0]); d.sources.twitter.returned_count++ }], ['row order', d => { d.records.reverse() }],
  ['row limit', d => { d.records = Array.from({ length: 101 }, (_, i) => record('twitter', String(101-i))); d.sources.twitter.returned_count = 101; d.sources.reddit.returned_count = 0 }],
  ['payload text', d => { d.records[0].prompt = {} }], ['payload length', d => { d.records[0].prompt = 'x'.repeat(16385) }], ['timestamp length', d => { d.records[0].timestamp = 'x'.repeat(257) }],
  ['payload bytes', d => { d.records[0].payload_bytes = -1 }], ['payload extra preview', d => { d.records[0].raw_preview = 'x' }], ['missing payload fields', d => { d.records[0].payload_kind = 'missing' }], ['truncated', d => { d.records[0].truncated = true }],
  ['warning unknown', d => { d.records[0].warnings = ['hidden'] }], ['warning duplicate', d => { d.records[0].warnings = ['invalid_json', 'invalid_json'] }],
  ['source extra', d => { d.sources.twitter.extra = 1 }], ['source platform', d => { d.sources.mastodon = source() }], ['source count', d => { d.sources.twitter.returned_count = 0 }], ['source status', d => { d.sources.twitter.status = 'unknown' }],
  ['source coverage', d => { d.sources.twitter.coverage = 'partial' }], ['source missing', d => { d.sources.twitter.status = 'missing' }], ['source more', d => { d.sources.twitter.has_more = true }], ['source warnings', d => { d.sources.twitter.warnings = ['source_missing'] }],
  ['limit value', d => { d.limits.rows_per_platform = 101 }], ['limit fraction', d => { d.limits.lock_timeout_seconds = 0.5 }], ['limit missing', d => { delete d.limits.wal_bytes }], ['limit extra', d => { d.limits.unknown = 1 }], ['platform budget', d => { d.limits.response_bytes_per_platform = 4186112 }], ['availability', d => { d.availability = 'partial' }],
]
for (const [label, mutate] of malformed) test(`file admission rejects ${label}`, async () => {
  const data = observation(), result = mutate(data)
  await assert.rejects(reader()(download(result ?? data)), invalid)
})

test('preserves the existing conservative ASCII response budget for non-ASCII payloads', async () => {
  const data = observation({ records: ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 40 }, (_, i) => record(platform, String(40-i), { response: '\u00e9'.repeat(10000), payload_bytes: 16384 }))) })
  assert.ok(bytes(JSON.stringify(data)).length < 8 * 1024 * 1024)
  assert.equal(validSavedInterviewObservation(data, selection(data)), false)
  await assert.rejects(reader()(download(data)), invalid)
})
