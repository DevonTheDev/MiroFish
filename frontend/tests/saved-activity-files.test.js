import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountSavedActivity, flush, ok } from './helpers/saved-activity-view-fixture.js'
import * as utility from '../src/utils/savedActivityFiles.js'

// Synthetic current-production observation from the 2026-10-08 saved-workflow
// audit: complete source coverage, but only one of three matching records.
const captured = JSON.parse(readFileSync(new URL('./fixtures/saved-activity-page.json', import.meta.url), 'utf8'))
function reader() {
  assert.equal(typeof utility.readSavedActivityFile, 'function', 'the local saved activity file reader must exist')
  return utility.readSavedActivityFile
}
const invalid = error => error instanceof Error && error.message === 'Invalid or unsupported saved activity file'
const bytes = text => new TextEncoder().encode(text)
const file = input => {
  const payload = typeof input === 'string' ? bytes(input) : input
  return { size: payload.byteLength, async arrayBuffer() { return payload.slice().buffer } }
}
const download = data => file(JSON.stringify(data, null, 2) + '\n')
const page = () => structuredClone(captured)
const empty = () => ({ ...page(), offset: 0, returned_count: 0, matched_count: 0, has_more: false, actions: [] })

test('opens the actual SavedActivityView page download and preserves historical pagination', async t => {
  const read = reader(), data = page(), { format_version, ...observation } = data
  assert.equal(format_version, 1)
  const h = await mountSavedActivity({ initialPath: `/simulation/${data.simulation_id}/activity?offset=1&limit=1&revision=${data.source_revision}` })
  t.after(() => h.unmount())
  h.requests.calls.getSavedActivity[0].resolve(ok(observation)); await flush()
  await h.click('download')
  assert.equal(h.downloads.length, 1)
  assert.deepEqual(await read(h.downloads[0].blob), data)
  assert.equal(data.availability, 'complete')
  assert.equal(data.returned_count, 1); assert.equal(data.matched_count, 3); assert.equal(data.has_more, true)
})

test('keeps all 100 rows and exact decimal and literal strings in a detached deeply frozen payload', async () => {
  const data = page(), original = data.actions[0]
  data.offset = 0; data.limit = 100; data.returned_count = 100; data.matched_count = 100; data.has_more = false
  data.actions = Array.from({ length: 100 }, (_, i) => ({ ...original, record_id: `twitter:${i + 1}` }))
  data.actions[0].agent_id = '9'.repeat(100)
  data.actions[0].round_num = '8'.repeat(100)
  data.context.requested_rounds = '7'.repeat(100)
  data.actions[0].agent_name = '  <img src=x onerror=alert(1)>\r\n\u0000e\u0301\ud800'
  data.actions[0].timestamp = '\udfff😀'
  data.actions[0].details_json = '{"number":90071992547409931234567890,"text":"<script>literal</script>","escaped":"\\ud800"}'
  const input = bytes(JSON.stringify(data)), actual = await reader()(file(input))
  assert.deepEqual(actual, data)
  function checkFrozen(value) {
    if (!value || typeof value !== 'object') return
    assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(checkFrozen)
  }
  checkFrozen(actual)
  assert.throws(() => { actual.actions[0].agent_id = '0' }, TypeError)
  input.fill(0); data.actions[0].agent_name = 'changed'
  assert.equal(actual.actions[0].agent_id, '9'.repeat(100))
  assert.match(actual.actions[0].agent_name, /<img/)
})

test('preserves empty, partial, unavailable and beyond-offset observations without deriving coverage', async () => {
  const cases = [empty(), { ...empty(), offset: 500000, matched_count: 17 },
    { ...empty(), availability: 'partial', platform_availability: { twitter: 'partial', reddit: 'unavailable' }, warnings: [{ code: 'invalid_records', platform: 'twitter', count: 1 }, { code: 'platform_log_missing', platform: 'reddit' }] },
    { ...empty(), availability: 'unavailable', platform_availability: { twitter: 'unavailable', reddit: 'unavailable' }, matched_count: null, warnings: [{ code: 'no_action_logs' }] },
    { ...empty(), platform_availability: { twitter: 'complete', reddit: 'unavailable' } },
    { ...empty(), platform_availability: { twitter: 'unavailable', reddit: 'unavailable' } }]
  for (const data of cases) assert.deepEqual(await reader()(download(data)), data)
})

test('preserves exact filters and recorded search excerpts without rerunning backend Unicode matching', async () => {
  const data = page(), row = data.actions[0]
  data.filters = { platform: 'twitter', agent_id: row.agent_id, round_num: row.round_num, action_type: ' POST ', q: ' STRASSE ', case_sensitive: false, outcome: 'failed' }
  row.action_type = ' POST '; row.match_preview = ' Straße '
  assert.deepEqual(await reader()(download(data)), data)
  for (const [outcome, success] of [['success', true], ['failed', false], ['unknown', null]]) {
    data.filters.outcome = outcome; row.success = success
    assert.deepEqual(await reader()(download(data)), data)
  }
  data.filters.q = '😀'.repeat(200); row.match_preview = '😀'.repeat(240)
  data.filters.action_type = '😀'.repeat(256); row.action_type = data.filters.action_type
  assert.deepEqual(await reader()(download(data)), data)
  for (const label of ['\ufeff', '\ud800']) {
    data.filters.action_type = label; data.filters.q = label; row.action_type = label; row.match_preview = label
    assert.deepEqual(await reader()(download(data)), data)
  }
})

test('accepts source labels with embedded controls without applying query-only restrictions to rows', async () => {
  const data = page()
  data.actions[0].action_type = 'POST\nEND'
  assert.deepEqual(await reader()(download(data)), data)
})

test('accepts forward source ordering with skipped physical lines and legacy interleaved platforms', async () => {
  const data = page(), row = data.actions[0]
  data.offset = 0; data.limit = 3; data.returned_count = 3; data.matched_count = 3; data.has_more = false
  data.actions = [ { ...row, record_id: 'twitter:2' }, { ...row, record_id: 'twitter:10' }, { ...row, record_id: 'reddit:1', platform: 'reddit' } ]
  assert.deepEqual(await reader()(download(data)), data)
  data.actions = data.actions.map((action, i) => ({ ...action, record_id: `legacy:${i + 1}`, platform: i === 1 ? 'reddit' : 'twitter' }))
  assert.deepEqual(await reader()(download(data)), data)
})

test('accepts every current warning shape while retaining nullable context text exactly', async () => {
  const data = empty()
  data.warnings = [
    ...['config_unavailable', 'run_state_unavailable', 'run_not_terminal', 'partial_run', 'no_action_logs'].map(code => ({ code })),
    ...['platform_log_missing', 'platform_not_configured'].map(code => ({ code, platform: 'reddit' })),
    ...['source_unreadable', 'source_too_large'].flatMap(code => [{ code }, { code, platform: 'twitter' }]),
    { code: 'invalid_records', count: 1 }, { code: 'invalid_records', platform: 'twitter', count: 250000 },
  ]
  for (const key of ['status', 'created_at', 'updated_at', 'started_at', 'completed_at']) data.context[key] = null
  assert.deepEqual(await reader()(download(data)), data)
})

test('checks the inclusive 8 MiB cap before reading and verifies returned bytes exactly', async () => {
  const read = reader(), maximum = utility.SAVED_ACTIVITY_FILE_MAX_BYTES
  assert.equal(maximum, 8 * 1024 * 1024)
  for (const size of [-1, 0.25, NaN, Infinity, maximum + 1, '1', undefined]) {
    let reads = 0
    await assert.rejects(read({ size, arrayBuffer() { reads++; throw new Error('PRIVATE') } }), invalid)
    assert.equal(reads, 0)
  }
  const payload = bytes(JSON.stringify(page()))
  for (const candidate of [null, {}, { size: payload.length }, { size: payload.length, arrayBuffer: async () => payload }, { size: payload.length + 1, arrayBuffer: async () => payload.buffer }, { size: 1, arrayBuffer: async () => new ArrayBuffer(maximum + 1) }, { size: payload.length, arrayBuffer() { throw new Error('PRIVATE_FILE_PATH') } }]) await assert.rejects(read(candidate), invalid)
  const text = JSON.stringify(page()), padded = text + ' '.repeat(maximum - bytes(text).length)
  assert.deepEqual(await read(file(padded)), page())
  await assert.rejects(read(file(padded + ' ')), invalid)
})

test('uses only the file admission cap, preserving large current context fields without a second encoding cap', async () => {
  const data = page()
  // Current state metadata can hold this ASCII string and the source response
  // still fits 4 MiB. A new arbitrary per-field limit would reject its export.
  data.context.created_at = 'x'.repeat(900000)
  assert.deepEqual(await reader()(download(data)), data)
})

test('rejects malformed UTF-8, a BOM, syntax errors and duplicate or escaped-alias keys', async () => {
  const read = reader(), text = JSON.stringify(page())
  for (const payload of [new Uint8Array([0xc3, 0x28]), new Uint8Array([...bytes(text), 0xff]), new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)])]) await assert.rejects(read(file(payload)), invalid)
  for (const content of ['', text + ' garbage', text.slice(0, -1), text.replace('"format_version":1', '"format_version":1,"format_version":1'), text.replace('"format_version":1', '"format_version":1,"\\u0066ormat_version":1'), text.replace('"platform":null', '"platform":null,"platform":null'), text.replace('"agent_name":null', '"agent_name":null,"\\u0061gent_name":null')]) await assert.rejects(read(file(content)), invalid)
})

test('rejects excessive nesting and parsed value counts within the byte cap', async () => {
  for (const text of ['['.repeat(1000) + '0' + ']'.repeat(1000), '[' + Array.from({ length: 10001 }, () => '0').join(',') + ']']) await assert.rejects(reader()(file(text)), invalid)
})

const malformed = [
  ['root array', () => []], ['API envelope', d => ({ success: true, data: d })],
  ['extra root field', d => { d.kind = 'saved_activity' }], ['missing format', d => { delete d.format_version }], ['unsupported format', d => { d.format_version = 2 }],
  ['simulation path', d => { d.simulation_id = '../sim' }], ['simulation newline', d => { d.simulation_id += '\n' }], ['simulation reserved name', d => { d.simulation_id = 'LPT9' }], ['simulation empty', d => { d.simulation_id = '' }], ['simulation length', d => { d.simulation_id = 's'.repeat(129) }],
  ['revision newline', d => { d.source_revision += '\n' }], ['revision case', d => { d.source_revision = 'A'.repeat(64) }], ['revision short', d => { d.source_revision = 'a'.repeat(63) }], ['observed type', d => { d.observed_at = null }],
  ['context extra field', d => { d.context.extra = 1 }], ['context missing field', d => { delete d.context.status }], ['context text type', d => { d.context.started_at = 1 }], ['context decimal type', d => { d.context.requested_rounds = 1 }], ['context decimal newline', d => { d.context.last_saved_round = '0\n' }],
  ['availability unknown', d => { d.availability = 'current' }], ['platform availability extra', d => { d.platform_availability.other = 'complete' }], ['platform availability missing', d => { delete d.platform_availability.reddit }], ['platform availability unknown', d => { d.platform_availability.twitter = 'missing' }], ['row platform unavailable', d => { d.platform_availability.twitter = 'unavailable' }],
  ['order', d => { d.order = 'timestamp' }], ['offset negative', d => { d.offset = -1 }], ['offset fraction', d => { d.offset = 0.5 }], ['offset unsafe', d => { d.offset = 9007199254740992 }], ['offset too large', d => { d.offset = 500001 }], ['limit zero', d => { d.limit = 0 }], ['limit too large', d => { d.limit = 101 }], ['returned count wrong', d => { d.returned_count = 0 }], ['returned count over limit', d => { d.actions.push({ ...d.actions[0], record_id: 'twitter:3' }); d.returned_count = 2 }], ['matched count negative', d => { d.matched_count = -1 }], ['matched count too large', d => { d.matched_count = 500001 }], ['matched count string', d => { d.matched_count = '3' }], ['has-more mismatch', d => { d.has_more = false }], ['has-more type', d => { d.has_more = 'true' }], ['count before offset', d => { d.matched_count = 1; d.has_more = false }], ['available null count', d => { d.matched_count = null; d.has_more = false }], ['unavailable numeric count', d => { d.availability = 'unavailable' }],
  ['filters extra', d => { d.filters.extra = true }], ['filters missing search', d => { delete d.filters.q }], ['filters missing case', d => { delete d.filters.case_sensitive }], ['filters missing outcome', d => { delete d.filters.outcome }], ['legacy four-field filters', d => { delete d.filters.q; delete d.filters.case_sensitive; delete d.filters.outcome; delete d.actions[0].match_preview }],
  ['filter platform unsupported', d => { d.filters.platform = 'legacy' }], ['filter agent not canonical', d => { d.filters.agent_id = '01' }], ['filter agent newline', d => { d.filters.agent_id = '1\n' }], ['filter decimal too long', d => { d.filters.agent_id = '1'.repeat(65); d.actions[0].agent_id = d.filters.agent_id }], ['filter round numeric', d => { d.filters.round_num = 1 }], ['filter case string', d => { d.filters.case_sensitive = 'false' }], ['filter outcome unknown', d => { d.filters.outcome = 'pending' }],
  ['platform alignment', d => { d.filters.platform = 'reddit' }], ['agent alignment', d => { d.filters.agent_id = '0' }], ['round alignment', d => { d.filters.round_num = '2' }], ['action alignment', d => { d.filters.action_type = 'OTHER' }], ['outcome alignment', d => { d.filters.outcome = 'success' }], ['selected platform coverage', d => { d.filters.platform = 'twitter'; d.availability = 'partial' }],
  ['row extra', d => { d.actions[0].extra = 'private' }], ['row missing preview', d => { delete d.actions[0].match_preview }], ['row platform unknown', d => { d.actions[0].platform = 'other' }], ['row decimal numeric', d => { d.actions[0].agent_id = 9007199254740992 }], ['row round leading zero', d => { d.actions[0].round_num = '01' }], ['row decimal newline', d => { d.actions[0].agent_id += '\n' }], ['row negative round', d => { d.actions[0].round_num = '-1' }], ['row missing details', d => { delete d.actions[0].details_json }], ['row object details', d => { d.actions[0].details_json = {} }], ['row success numeric', d => { d.actions[0].success = 1 }], ['row agent name numeric', d => { d.actions[0].agent_name = 2 }], ['row timestamp object', d => { d.actions[0].timestamp = {} }], ['row action empty', d => { d.actions[0].action_type = '' }], ['row action too long', d => { d.actions[0].action_type = 'x'.repeat(257) }],
  ['record ID arbitrary', d => { d.actions[0].record_id = 'arbitrary' }], ['record ID platform mismatch', d => { d.actions[0].record_id = 'reddit:2' }], ['record ID zero', d => { d.actions[0].record_id = 'twitter:0' }], ['record ID leading zero', d => { d.actions[0].record_id = 'twitter:02' }], ['record ID newline', d => { d.actions[0].record_id += '\n' }],
  ['unexpected preview without search', d => { d.actions[0].match_preview = 'text' }], ['missing preview with search', d => { d.filters.q = 'text' }], ['empty preview with search', d => { d.filters.q = 'text'; d.actions[0].match_preview = '' }], ['long preview with search', d => { d.filters.q = 'text'; d.actions[0].match_preview = '😀'.repeat(241) }],
  ['warnings not array', d => { d.warnings = {} }], ['warning unknown', d => { d.warnings = [{ code: 'private' }] }], ['warning extra', d => { d.warnings = [{ code: 'no_action_logs', private: 'x' }] }], ['warning required platform', d => { d.warnings = [{ code: 'platform_log_missing' }] }], ['warning invalid platform', d => { d.warnings = [{ code: 'source_unreadable', platform: 'legacy' }] }], ['warning inappropriate platform', d => { d.warnings = [{ code: 'config_unavailable', platform: 'twitter' }] }], ['warning required count', d => { d.warnings = [{ code: 'invalid_records' }] }], ['warning count zero', d => { d.warnings = [{ code: 'invalid_records', count: 0 }] }], ['warning count fraction', d => { d.warnings = [{ code: 'invalid_records', count: 0.5 }] }], ['warning count unsafe', d => { d.warnings = [{ code: 'invalid_records', count: 9007199254740992 }] }], ['warning inappropriate count', d => { d.warnings = [{ code: 'partial_run', count: 1 }] }],
]
for (const key of ['q', 'action_type']) {
  for (const value of ['', ' \u2002', '\nword', 'word\u0085', 'word\u2028', 'word\u2029', '😀'.repeat(key === 'q' ? 201 : 257), {}, 1]) malformed.push([`invalid ${key} filter ${JSON.stringify(value)}`, d => { d.filters[key] = value }])
}
for (const [label, mutate] of malformed) test(`rejects ${label}`, async () => {
  const data = page(), replacement = mutate(data)
  await assert.rejects(reader()(download(replacement ?? data)), invalid)
})

for (const [label, ids, platforms] of [
  ['duplicate record IDs', ['twitter:2', 'twitter:2'], ['twitter', 'twitter']],
  ['descending physical lines', ['twitter:10', 'twitter:2'], ['twitter', 'twitter']],
  ['descending modern platforms', ['reddit:1', 'twitter:2'], ['reddit', 'twitter']],
  ['mixed legacy and modern sources', ['legacy:1', 'twitter:2'], ['twitter', 'twitter']],
  ['descending legacy lines', ['legacy:10', 'legacy:2'], ['twitter', 'reddit']],
]) test(`rejects ${label}`, async () => {
  const data = page()
  data.offset = 0; data.limit = 2; data.returned_count = 2; data.matched_count = 2; data.has_more = false
  data.actions = ids.map((record_id, i) => ({ ...data.actions[0], record_id, platform: platforms[i] }))
  await assert.rejects(reader()(download(data)), invalid)
})

test('rejects nonfinite schema numbers even though source strings may contain their literal text', async () => {
  for (const [field, value] of [['offset', '1e999'], ['matched_count', '1e999'], ['limit', '1e999']]) {
    const text = JSON.stringify(page()).replace(new RegExp(`"${field}":\\d+`), `"${field}":${value}`)
    await assert.rejects(reader()(file(text)), invalid)
  }
})

test('rejects an empty capture inside the recorded matching range', async () => {
  const data = { ...empty(), limit: 50, matched_count: 3, has_more: true }
  await assert.rejects(reader()(download(data)), invalid)
})

test('rejects a shortened page that omits rows from its recorded matching range', async () => {
  for (const availability of ['complete', 'partial']) {
    const data = { ...page(), availability, offset: 0, limit: 3 }
    await assert.rejects(reader()(download(data)), invalid)
  }
})
