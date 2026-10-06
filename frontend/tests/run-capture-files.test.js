import assert from 'node:assert/strict'
import test from 'node:test'

const moduleUrl = new URL('../src/utils/runCaptureFiles.js', import.meta.url)
let files = {}
try { files = await import(moduleUrl) } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
const { parseRunCaptureFile, readRunCaptureFile, compareRunCaptureFiles } = files
const LEFT = 'a'.repeat(32), RIGHT = 'b'.repeat(32)
const TIME = '2026-10-06T12:34:56.123456+00:00'
const invalidMessage = 'Invalid run capture file'
const plain = value => JSON.parse(JSON.stringify(value))
const asciiJson = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
const parse = value => parseRunCaptureFile(JSON.stringify(value))
const platform = (count = 0, availability = 'complete') => ({ availability, recorded_actions: availability === 'unavailable' ? null : count, active_agents: availability === 'unavailable' ? null : Math.min(count, 1) })
function capture(id = LEFT, names = [['POST', 3]], availability = 'complete') {
  const count = names.reduce((sum, [, value]) => sum + value, 0)
  return { schema_version: 1, capture_id: id, label: 'Historical capture', note: 'line\n\ttab', captured_at: TIME, observation: {
    schema_version: 1, source_revision: 'd'.repeat(64), observed_at: TIME,
    summary: { simulation_id: 'sim_same', project_id: '900719925474099312345', graph_id: null, scenario: 'Saved scenario', configured_model: 'saved-model', configured_agents: '900719925474099312345', status: 'completed', created_at: 'historical date', updated_at: null, started_at: null, completed_at: null, requested_rounds: '20', last_saved_round: '0', availability, warnings: [],
      metrics: { recorded_actions: availability === 'unavailable' ? null : count, rounds_with_actions: availability === 'unavailable' ? null : Math.min(count, 1), platforms: { twitter: platform(count, availability), reddit: platform(0, 'unavailable') }, action_types: names.map(([action_type, count]) => ({ action_type, count })) },
    },
  } }
}
function pair(left = capture(), right = capture(RIGHT, [])) {
  return { schema_version: 1, left, right, generated_at: TIME, differences: {
    recorded_actions: -3, rounds_with_actions: -1,
    platforms: { twitter: { recorded_actions: -3, active_agents: -1 }, reddit: { recorded_actions: null, active_agents: null } },
    action_types: [{ action_type: 'POST', left: 3, right: 0, difference: -3 }],
  } }
}
function rejects(source) {
  assert.throws(() => parseRunCaptureFile(source), error => {
    assert.equal(error.constructor, Error); assert.equal(error.message, invalidMessage)
    assert.deepEqual(Object.keys(error), []); assert.equal(error.cause, undefined)
    return true
  })
}
function frozen(value) {
  if (!value || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen)
}

test('run-capture file utility is available as a bounded local parser', () => {
  assert.equal(typeof parseRunCaptureFile, 'function', 'The local capture-file parser is missing')
  assert.equal(typeof readRunCaptureFile, 'function')
  assert.equal(typeof compareRunCaptureFiles, 'function')
  assert.equal(files.RUN_CAPTURE_FILE_MAX_BYTES, 2 * 1024 * 1024)
})

test('admits exact individual and comparison exports with deeply frozen historical values', () => {
  const single = capture(), comparison = pair()
  const one = parseRunCaptureFile(JSON.stringify(single, null, 2)), two = parse(comparison)
  assert.deepEqual(plain(one), { kind: 'capture', captures: [single] })
  assert.deepEqual(plain(two), { kind: 'comparison', captures: [comparison.left, comparison.right], generated_at: TIME })
  frozen(one); frozen(two)
  assert.throws(() => { one.captures[0].observation.summary.scenario = 'changed' }, TypeError)
  assert.notEqual(parse(single).captures[0], one.captures[0])
})

test('complete zero and unavailable counts remain distinct and same simulation is allowed', () => {
  const left = capture(LEFT, []), right = capture(RIGHT, [], 'unavailable')
  const result = compareRunCaptureFiles(left, right, TIME)
  assert.equal(result.left.observation.summary.metrics.recorded_actions, 0)
  assert.equal(result.right.observation.summary.metrics.recorded_actions, null)
  assert.deepEqual(result.differences, { recorded_actions: null, rounds_with_actions: null, platforms: { twitter: { recorded_actions: null, active_agents: null }, reddit: { recorded_actions: null, active_agents: null } }, action_types: [] })
  assert.equal(result.generated_at, TIME); frozen(result)
  assert.deepEqual(plain(parse(result).captures), [left, right])
})

test('recomputes right minus left and retains original capture times', () => {
  const expected = pair(), result = compareRunCaptureFiles(expected.left, expected.right, TIME)
  assert.deepEqual(plain(result), expected)
  const now = compareRunCaptureFiles(parse(expected.left).captures[0], parse(expected.right).captures[0])
  assert.match(now.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  assert.equal(now.left.captured_at, TIME); assert.equal(now.left.observation.observed_at, TIME)
})

test('partial global coverage independently preserves complete platform differences and absent-type nulls', () => {
  const left = capture(LEFT, [['LEFT', 2]], 'partial'), right = capture(RIGHT, [['RIGHT', 5]])
  left.observation.summary.status = 'stopped'
  left.observation.summary.metrics.platforms.twitter.availability = 'complete'
  left.observation.summary.warnings = [{ code: 'partial_run' }, { code: 'platform_log_missing', platform: 'reddit' }]
  const difference = compareRunCaptureFiles(left, right, TIME).differences
  assert.equal(difference.recorded_actions, null); assert.equal(difference.rounds_with_actions, null)
  assert.deepEqual(difference.platforms.twitter, { recorded_actions: 3, active_agents: 0 })
  assert.deepEqual(difference.action_types, [{ action_type: 'LEFT', left: 2, right: 0, difference: null }, { action_type: 'RIGHT', left: null, right: 5, difference: null }])
  const reverse = compareRunCaptureFiles(right, left, TIME).differences.action_types
  assert.deepEqual(reverse, [{ action_type: 'LEFT', left: 0, right: 2, difference: null }, { action_type: 'RIGHT', left: 5, right: null, difference: null }])
})

test('Python code-point ordering and prototype-looking action names remain literal data', () => {
  const names = ['__proto__', 'constructor', 'toString', '\uD800', '\uE000', '\u{10000}']
  const left = capture(LEFT, names.map(name => [name, 1])), right = capture(RIGHT, [])
  const result = compareRunCaptureFiles(parse(left).captures[0], right, TIME)
  assert.deepEqual(result.differences.action_types, names.map(action_type => ({ action_type, left: 1, right: 0, difference: -1 })))
  assert.equal({}.polluted, undefined)
  const wrongOrder = capture(LEFT, [...names].sort().map(name => [name, 1]))
  rejects(JSON.stringify(wrongOrder))
})

test('saved context preserves escaped surrogates, controls, literal markup and exact decimal strings', () => {
  const value = capture()
  for (const key of ['scenario', 'project_id', 'graph_id', 'configured_model', 'created_at', 'updated_at', 'started_at', 'completed_at']) value.observation.summary[key] = '  \ud800\u0000<script>literal</script>🦙\n'
  const result = parse(value).captures[0]
  assert.deepEqual(plain(result), value)
  assert.equal(result.observation.summary.configured_agents, '900719925474099312345')
  const source = JSON.stringify(value).replace('\\ud800', '\ud800')
  rejects(source)
})

test('labels and notes use code-point lengths and the native control-character policy', () => {
  const value = capture(); value.label = '😀'.repeat(120); value.note = '😀'.repeat(2000)
  assert.equal(parse(value).captures[0].label, value.label)
  for (const [key, text] of [['label', '😀'.repeat(121)], ['note', '😀'.repeat(2001)], ['label', ' \t '], ['label', 'x\n'], ['label', '\ud800'], ['note', '\ud800'], ['note', '\r'], ['label', '\u0085'], ['note', '\u007f']]) {
    const changed = capture(); changed[key] = text; rejects(JSON.stringify(changed))
  }
  const pythonBlank = capture(); pythonBlank.label = '\u001c'; rejects(JSON.stringify(pythonBlank))
  value.label = '\uFEFF'; value.note = '\n\t'; assert.equal(parse(value).captures[0].label, '\uFEFF')
})

for (const [name, mutate] of [
  ['unknown version', v => v.schema_version = 2], ['observation version', v => v.observation.schema_version = true],
  ['extra root key', v => v.secret = 'PRIVATE'], ['extra observation key', v => v.observation.secret = 'PRIVATE'],
  ['extra summary key', v => v.observation.summary.secret = 'PRIVATE'], ['extra metrics key', v => v.observation.summary.metrics.secret = 'PRIVATE'],
  ['extra platform key', v => v.observation.summary.metrics.platforms.other = platform()], ['extra platform metric', v => v.observation.summary.metrics.platforms.twitter.secret = 'PRIVATE'],
  ['extra action key', v => v.observation.summary.metrics.action_types[0].secret = 'PRIVATE'],
  ['uppercase capture ID', v => v.capture_id = 'A'.repeat(32)], ['short capture ID', v => v.capture_id = 'a'.repeat(31)],
  ['invalid revision', v => v.observation.source_revision = 'd'.repeat(63)], ['uppercase revision', v => v.observation.source_revision = 'D'.repeat(64)],
  ['traversal simulation', v => v.observation.summary.simulation_id = '../secret'], ['reserved simulation', v => v.observation.summary.simulation_id = 'cOm1'], ['long simulation', v => v.observation.summary.simulation_id = 'a'.repeat(129)],
  ['nonterminal status', v => v.observation.summary.status = 'running'], ['unknown availability', v => v.observation.summary.availability = 'unknown'],
  ['numeric configured count', v => v.observation.summary.configured_agents = 3], ['negative context count', v => v.observation.summary.requested_rounds = '-1'], ['padded context count', v => v.observation.summary.last_saved_round = '01'],
  ['numeric context ID', v => v.observation.summary.project_id = 9], ['numeric date context', v => v.observation.summary.created_at = 5], ['null scenario', v => v.observation.summary.scenario = null],
  ['unknown warning', v => v.observation.summary.warnings = [{ code: 'PRIVATE' }]], ['extra warning key', v => v.observation.summary.warnings = [{ code: 'partial_run', secret: 'PRIVATE' }]],
  ['missing warning count', v => v.observation.summary.warnings = [{ code: 'invalid_records' }]], ['zero warning count', v => v.observation.summary.warnings = [{ code: 'invalid_records', count: 0 }]],
  ['wrong warning count', v => v.observation.summary.warnings = [{ code: 'partial_run', count: 1 }]], ['wrong warning platform', v => v.observation.summary.warnings = [{ code: 'partial_run', platform: 'PRIVATE' }]],
  ['too many warnings', v => v.observation.summary.warnings = Array.from({ length: 33 }, () => ({ code: 'partial_run' }))],
  ['negative count', v => v.observation.summary.metrics.recorded_actions = -1], ['boolean count', v => v.observation.summary.metrics.recorded_actions = true], ['fraction count', v => v.observation.summary.metrics.recorded_actions = 1.5], ['overflow count', v => v.observation.summary.metrics.recorded_actions = 500001], ['unsafe count', v => v.observation.summary.metrics.recorded_actions = 9007199254740992],
  ['missing aggregate count', v => v.observation.summary.metrics.recorded_actions = null], ['inconsistent action sum', v => v.observation.summary.metrics.action_types[0].count = 2], ['inconsistent platform sum', v => v.observation.summary.metrics.platforms.twitter.recorded_actions = 2], ['too many rounds', v => v.observation.summary.metrics.rounds_with_actions = 4],
  ['too many active agents', v => v.observation.summary.metrics.platforms.twitter.active_agents = 4], ['missing platform count', v => v.observation.summary.metrics.platforms.twitter.active_agents = null], ['unavailable platform count', v => v.observation.summary.metrics.platforms.reddit.recorded_actions = 0],
  ['inconsistent availability', v => v.observation.summary.metrics.platforms.twitter.availability = 'partial'], ['unavailable aggregate with observations', v => v.observation.summary.availability = 'unavailable'],
  ['blank action', v => v.observation.summary.metrics.action_types[0].action_type = '\u001c'], ['long action', v => v.observation.summary.metrics.action_types[0].action_type = '😀'.repeat(257)], ['zero action count', v => v.observation.summary.metrics.action_types[0].count = 0], ['duplicate action', v => v.observation.summary.metrics.action_types.push(v.observation.summary.metrics.action_types[0])],
]) test(`rejects ${name}`, () => { const value = capture(); mutate(value); rejects(JSON.stringify(value)) })

test('admits maximum counts, warnings and action rows; rejects one row over the bound', () => {
  const value = capture(LEFT, Array.from({ length: 256 }, (_, index) => [String(index).padStart(3, '0'), index ? 1 : 499745]))
  value.observation.summary.warnings = Array.from({ length: 32 }, () => ({ code: 'invalid_records', platform: 'twitter', count: 500000 }))
  assert.equal(parse(value).captures[0].observation.summary.metrics.recorded_actions, 500000)
  value.observation.summary.metrics.action_types.push({ action_type: 'extra', count: 1 })
  rejects(JSON.stringify(value))
})

test('derives the full 512-row union of separately admitted maximum action-type arrays', () => {
  const names = side => Array.from({ length: 256 }, (_, index) => [side + String(index).padStart(3, '0') + 'x'.repeat(252), 1])
  const left = capture(LEFT, names('L')), right = capture(RIGHT, names('R'))
  const result = compareRunCaptureFiles(left, right, TIME)
  assert.equal(result.differences.action_types.length, 512)
  assert.deepEqual(result.differences.action_types[0], { action_type: names('L')[0][0], left: 1, right: 0, difference: -1 })
  assert.deepEqual(result.differences.action_types[511], { action_type: names('R')[255][0], left: 0, right: 1, difference: 1 })
  assert.deepEqual(plain(parse(result).captures), [left, right])
})

test('accepts producer UTC timestamps and validates real calendar dates without rewriting history', () => {
  for (const time of ['0001-01-01T00:00:00+00:00', '2000-02-29T23:59:59.1Z', '2026-10-06T12:34:56Z', '9999-12-31T23:59:59.999999+00:00']) {
    const value = capture(); value.captured_at = value.observation.observed_at = time
    assert.equal(parse(value).captures[0].captured_at, time)
  }
  for (const time of ['2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '0000-01-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00+01:00', '20260101T000000Z', '2026-W01-1T00:00:00Z', '2026-01-01T00:00:00.1234567Z']) {
    for (const location of ['capture', 'observation', 'comparison']) {
      const value = location === 'comparison' ? pair() : capture()
      if (location === 'capture') value.captured_at = time
      else if (location === 'observation') value.observation.observed_at = time
      else value.generated_at = time
      rejects(JSON.stringify(value))
    }
  }
})

test('rejects malformed JSON, duplicate escaped keys, envelopes and forbidden numeric lexemes', () => {
  const source = JSON.stringify(capture())
  for (const bad of [null, undefined, 1, '', '{', source.slice(0, -1), source + ' trailing', source.replace('"schema_version":1', '"schema_version":1,"schema_versi\\u006fn":1'), source.replace('"count":3', '"count":3,"count":3'), source.replace('"schema_version":1', '"schema_version":1.0'), source.replace('"schema_version":1', '"schema_version":1e0'), source.replace('"count":3', '"count":3.0000000000000001'), source.replace('"count":3', '"count":1e309'), JSON.stringify({ success: true, data: capture() }), '[]', 'null']) rejects(bad)
  const literal = capture(); literal.observation.summary.scenario = '1.0 1e309 "schema_version":1e0'
  assert.equal(parse(literal).captures[0].observation.summary.scenario, literal.observation.summary.scenario)
})

test('IDs, decimal context and UTC timestamps reject every trailing newline', () => {
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const mutate of [v => v.capture_id += ending, v => v.observation.source_revision += ending, v => v.observation.summary.simulation_id += ending, v => v.observation.summary.configured_agents += ending, v => v.captured_at += ending, v => v.observation.observed_at += ending]) {
      const value = capture(); mutate(value); rejects(JSON.stringify(value))
    }
    const comparison = pair(); comparison.generated_at += ending; rejects(JSON.stringify(comparison))
  }
})

test('rejects deep input and enforces UTF-8 transport size including whitespace', () => {
  const source = JSON.stringify(capture()), cap = files.RUN_CAPTURE_FILE_MAX_BYTES
  const atLimit = source + ' '.repeat(cap - new TextEncoder().encode(source).length)
  assert.equal(parseRunCaptureFile(atLimit).kind, 'capture'); rejects(atLimit + ' ')
  rejects('{"deep":' + '['.repeat(11) + '0' + ']'.repeat(11) + '}')
  rejects(JSON.stringify({ scenario: '😀'.repeat(cap / 4) }))
})

test('counts the exact 256 KiB Python canonical ASCII boundary, including DEL, astral and legacy surrogate text', () => {
  const value = capture(); value.observation.summary.scenario = '\u007f\u0080😀\ud800\n\t"\\'
  value.observation.summary.scenario += 'x'.repeat(256 * 1024 - asciiJson(value).length)
  assert.equal(asciiJson(value).length, 256 * 1024)
  assert.deepEqual(plain(parse(value).captures[0]), value)
  value.observation.summary.scenario += 'x'; rejects(JSON.stringify(value))
  value.observation.summary.scenario = '😀'.repeat(23000)
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length < 256 * 1024)
  rejects(JSON.stringify(value))
})

test('comparison rejects every changed derived value, added key, row order and repeated capture ID', () => {
  for (const change of [v => v.differences.recorded_actions++, v => v.differences.rounds_with_actions = null, v => v.differences.platforms.reddit.active_agents = 0, v => v.differences.platforms.twitter.active_agents = 0, v => v.differences.action_types[0].difference = 0, v => v.differences.action_types[0].right = null, v => v.differences.action_types[0].extra = 0, v => v.differences.extra = 0, v => v.extra = 0, v => v.right.capture_id = v.left.capture_id, v => v.schema_version = 2, v => v.left.observation.summary.metrics.recorded_actions = 500001]) {
    const value = pair(); change(value); rejects(JSON.stringify(value))
  }
  const value = compareRunCaptureFiles(capture(LEFT, [['A', 1], ['B', 1]]), capture(RIGHT, []), TIME)
  const changed = plain(value); changed.differences.action_types.reverse(); rejects(JSON.stringify(changed))
  rejects(JSON.stringify(pair()).replace('"difference":-3', '"difference":-3.0'))
})

test('comparison validates raw arguments without freezing or mutating caller objects', () => {
  const left = capture(), right = capture(RIGHT, [])
  const result = compareRunCaptureFiles(left, right, TIME)
  assert.notEqual(result.left, left); assert.equal(Object.isFrozen(left), false)
  left.label = 'Changed'; assert.equal(result.left.label, 'Historical capture')
  for (const [a, b, when] of [[left, left, TIME], [left, right, 'bad'], [{}, right, TIME], [left, { ...right, extra: true }, TIME]]) assert.throws(() => compareRunCaptureFiles(a, b, when), { message: invalidMessage })
})

test('reads only bounded strict UTF-8 array buffers and ignores filename and MIME labels', async () => {
  const source = JSON.stringify(capture()), bytes = new TextEncoder().encode(source)
  const file = { name: '<script>.txt', type: 'application/octet-stream', size: bytes.length, arrayBuffer: async () => bytes.buffer, text: () => { throw Error('must use strict bytes') } }
  assert.deepEqual(plain(await readRunCaptureFile(file)), { kind: 'capture', captures: [capture()] })
  let reads = 0
  for (const size of [-1, NaN, Infinity, 1.5, files.RUN_CAPTURE_FILE_MAX_BYTES + 1]) await assert.rejects(readRunCaptureFile({ size, arrayBuffer: async () => { reads++; return bytes.buffer } }), { message: invalidMessage })
  assert.equal(reads, 0)
  const position = source.indexOf('Saved scenario')
  const prefix = new TextEncoder().encode(source.slice(0, position)), suffix = new TextEncoder().encode(source.slice(position + 'Saved scenario'.length))
  for (const sequence of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc2]]) {
    // Replacement decoding would create an otherwise valid historical string.
    const bad = new Uint8Array([...prefix, ...sequence, ...suffix])
    await assert.rejects(readRunCaptureFile({ size: bad.byteLength, arrayBuffer: async () => bad.buffer }), { message: invalidMessage })
  }
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])
  await assert.rejects(readRunCaptureFile({ size: bom.byteLength, arrayBuffer: async () => bom.buffer }), { message: invalidMessage })
  await assert.rejects(readRunCaptureFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(files.RUN_CAPTURE_FILE_MAX_BYTES + 1) }), { message: invalidMessage })
  await assert.rejects(readRunCaptureFile({ size: bytes.length + 1, arrayBuffer: async () => bytes.buffer }), { message: invalidMessage })
  await assert.rejects(readRunCaptureFile({ size: 1, arrayBuffer: async () => { throw Error('PRIVATE_PATH') } }), { message: invalidMessage })
})
