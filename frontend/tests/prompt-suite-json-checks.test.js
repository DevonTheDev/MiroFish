import assert from 'node:assert/strict'
import test from 'node:test'
import * as suites from '../src/utils/promptSuites.js'
import { comparePromptSuiteReports, exportPromptSuiteComparison } from '../src/utils/promptSuiteComparison.js'
import { trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const capturedAt = '2026-10-04T01:00:00Z'
const item = (kind = 'json_object', expected = null, number = 1) => ({ case_id: id(number), ...trialRequest(), check_kind: kind, expected_text: expected })
const definition = (cases = [item()], version = 2) => ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'JSON format checks', cases })
const legacy = expected => { const value = item('none', expected); delete value.check_kind; return value }
function report(run = 10, inputs = [item()], replies = ['{}'], checks = ['matched'], version = 2) {
  return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(run), definition: definition(inputs, version),
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
    cases: inputs.map((input, index) => {
      const snapshot = trialSnapshot('succeeded'), { case_id, expected_text, check_kind, ...request } = input
      snapshot.run.request_id = id(run * 100 + index); snapshot.run.request = request; snapshot.run.response.content = replies[index]
      return { case_id, request_id: snapshot.run.request_id, status: 'succeeded', check: checks[index], snapshot, error_code: null }
    }) }
}
const compare = (left, right) => comparePromptSuiteReports(left, right, { capturedAt }).toReport()

test('public check helpers normalize admitted v1 and v2 cases without changing definitions', () => {
  assert.equal(typeof suites.getPromptSuiteCheck, 'function')
  assert.equal(typeof suites.evaluatePromptSuiteCheck, 'function')
  assert.equal(typeof suites.isPromptSuiteJsonObjectReply, 'function')
  for (const [source, expected] of [[legacy(null), { kind: 'none', expected_text: null }], [legacy(''), { kind: 'exact_text', expected_text: '' }],
    [legacy('Å'), { kind: 'exact_text', expected_text: 'Å' }], [item('none'), { kind: 'none', expected_text: null }],
    [item('exact_text', ''), { kind: 'exact_text', expected_text: '' }], [item(), { kind: 'json_object', expected_text: null }]]) {
    const before = structuredClone(source)
    assert.deepEqual(suites.getPromptSuiteCheck(source), expected)
    assert.deepEqual(source, before)
  }
})

test('v2 definitions round trip every explicit mode while preserving v1 wire shape', () => {
  const source = definition([item('none', null, 1), item('exact_text', '', 2), item('exact_text', 'Å\r\n', 3), item('json_object', null, 4)])
  assert.deepEqual(suites.parsePromptSuiteDefinition(suites.exportPromptSuiteDefinition(source)), source)
  const accepted = suites.acceptPromptSuiteDefinition(source)
  source.cases[3].check_kind = 'none'
  assert.equal(accepted.cases[3].check_kind, 'json_object')
  for (const expected of [null, '', 'Hello']) {
    const old = definition([legacy(expected)], 1)
    assert.deepEqual(suites.parsePromptSuiteDefinition(suites.exportPromptSuiteDefinition(old)), old)
    assert.equal(Object.hasOwn(suites.acceptPromptSuiteDefinition(old).cases[0], 'check_kind'), false)
  }
})

for (const [name, change] of [
  ['missing mode', value => delete value.cases[0].check_kind], ['unknown mode', value => value.cases[0].check_kind = 'json'],
  ['null mode', value => value.cases[0].check_kind = null], ['object mode', value => value.cases[0].check_kind = { kind: 'json_object' }],
  ['JSON expectation', value => value.cases[0].expected_text = '{}'], ['none expectation', value => { value.cases[0].check_kind = 'none'; value.cases[0].expected_text = '' }],
  ['exact null', value => value.cases[0].check_kind = 'exact_text'], ['missing expectation', value => delete value.cases[0].expected_text],
  ['unsupported version', value => value.schema_version = 3], ['v1 explicit mode', value => value.schema_version = 1],
]) test(`v2 schema rejects ${name}`, () => {
  const source = definition(); change(source)
  assert.throws(() => suites.acceptPromptSuiteDefinition(source), /^Error: Invalid prompt suite definition$/)
  assert.throws(() => suites.parsePromptSuiteDefinition(JSON.stringify(source)), /^Error: Invalid prompt suite definition$/)
})

const validReplies = ['{}', ' \n\r\t{ "b": [null, true, false, -0, 1.5, 1e308], "a": {} } \n',
  '{"a":{"x":1},"b":{"x":2}}', '{"__proto__":{},"constructor":"ordinary"}', '{"a":"\\u0000\\n\\t\\r"}',
  '{"🦙":"🧪"}', '{"\\ud83e\\udd99":"\\ud83e\\uddea"}', '{"x":"\\ud83e\udd99"}', '{"x":"\ud83e\\udd99"}',
  '{"n":9007199254740993,"small":1e-400}', '{"x":"\\\" \\\\ end"}']
for (const [index, content] of validReplies.entries()) test(`JSON-object check accepts complete valid object ${index}`, () => {
  assert.equal(typeof suites.isPromptSuiteJsonObjectReply, 'function')
  assert.equal(suites.isPromptSuiteJsonObjectReply(content), true)
})

const invalidReplies = [null, undefined, 1, {}, [], '', ' ', 'null', 'true', '0', '"{}"', '[]', '[{}]',
  '```json\n{}\n```', '<think>done</think>{}', '{} trailing', '{}{}', '{}\0', '\ufeff{}', '{}\u00a0',
  '{', '{"a":}', '{"a":1,}', '{"a":[1,]}', '{"a":NaN}', '{"a":Infinity}', '{"a":undefined}',
  '{"a":01}', '{"a":+1}', '{"a":.5}', '{"a":1.}', '{"a":1e}', '{"a":truefalse}', '{/*comment*/}',
  '{"a":"raw\nline"}', '{"a":"\\x20"}', '{"a":"\\u12"}', '{"a":"unterminated}',
  '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '{"__proto__":1,"__proto__":2}',
  '{"a":1e309}', '{"a":[-1e999]}', '{"a":"\\ud800"}', '{"a":"\\udfff"}', '{"\\ud800":1}',
  '{"a":"\ud800"}', '{"\udfff":1}', '{"a":"\\ud800x\\udc00"}', '{"a":"\\udc00\\ud800"}',
  '{"a":"\\ud800\\ud800"}', '{"a":{"b":"\\udfff"}}']
for (const [index, content] of invalidReplies.entries()) test(`JSON-object check rejects malformed, nonobject or ambiguous reply ${index}`, () => {
  assert.equal(typeof suites.isPromptSuiteJsonObjectReply, 'function')
  assert.equal(suites.isPromptSuiteJsonObjectReply(content), false)
})

test('JSON-object checks count raw UTF-8 bytes including surrounding whitespace at 64 KiB', () => {
  assert.equal(typeof suites.isPromptSuiteJsonObjectReply, 'function')
  const cap = 64 * 1024, ascii = '{"x":"' + 'a'.repeat(cap - 8) + '"}'
  const unicode = '{"x":"' + '🦙'.repeat((cap - 8) / 4) + '"}'
  for (const content of [ascii, unicode, '{}'.padEnd(cap)]) {
    assert.equal(new TextEncoder().encode(content).length, cap)
    assert.equal(suites.isPromptSuiteJsonObjectReply(content), true)
    assert.equal(suites.isPromptSuiteJsonObjectReply(content + ' '), false)
  }
})

test('JSON-object checks bound every value depth at 16 with object root at depth zero', () => {
  assert.equal(typeof suites.isPromptSuiteJsonObjectReply, 'function')
  const nestedArrays = levels => '{"x":' + '['.repeat(levels) + '0' + ']'.repeat(levels) + '}'
  const nestedObjects = levels => '{"x":'.repeat(levels) + '0' + '}'.repeat(levels)
  assert.equal(suites.isPromptSuiteJsonObjectReply(nestedArrays(15)), true)
  assert.equal(suites.isPromptSuiteJsonObjectReply(nestedArrays(16)), false)
  assert.equal(suites.isPromptSuiteJsonObjectReply(nestedObjects(16)), true)
  assert.equal(suites.isPromptSuiteJsonObjectReply(nestedObjects(17)), false)
  assert.equal(suites.isPromptSuiteJsonObjectReply('{"x":' + '['.repeat(16) + ']'.repeat(16) + '}'), true)
  assert.equal(suites.isPromptSuiteJsonObjectReply('{"x":' + '['.repeat(17) + ']'.repeat(17) + '}'), false)
  assert.equal(suites.isPromptSuiteJsonObjectReply('{"x":' + '['.repeat(20000) + ']'.repeat(20000) + '}'), false)
})

test('only succeeded checks evaluate, with empty exact text distinct from none and JSON mode', () => {
  assert.equal(typeof suites.evaluatePromptSuiteCheck, 'function')
  for (const status of ['not_attempted', 'submitting', 'running', 'rejected', 'unknown', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
    for (const input of [legacy(null), legacy(''), item()]) assert.equal(suites.evaluatePromptSuiteCheck(input, status, '{}'), 'not_evaluated')
  }
  for (const [input, reply, expected] of [[legacy(null), '{}', 'not_requested'], [item('none'), '{}', 'not_requested'],
    [legacy(''), '', 'matched'], [item('exact_text', ''), '', 'matched'], [item('exact_text', 'Å'), 'A\u030a', 'mismatched'],
    [item('exact_text', '{}'), '{ }', 'mismatched'], [item(), '{ }', 'matched'], [item(), '[]', 'mismatched'], [item(), null, 'mismatched']]) {
    assert.equal(suites.evaluatePromptSuiteCheck(input, 'succeeded', reply), expected)
  }
})

test('v2 reports round trip derived outcomes and reject forged outcomes or mismatched schema versions', () => {
  const source = report(10, [item('json_object', null, 1), item('json_object', null, 2), item('none', null, 3), item('exact_text', '', 4)],
    ['{}', '[]', 'anything', ''], ['matched', 'mismatched', 'not_requested', 'matched'])
  assert.deepEqual(suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(source)), suites.acceptPromptSuiteReport(source))
  assert.deepEqual(suites.summarizePromptSuiteReport(source), { total: 4, attempted: 4, succeeded: 4, evaluated: 3, matched: 2,
    mismatched: 1, not_requested: 1, not_evaluated: 0 })
  for (const index of [0, 1, 2, 3]) {
    const forged = structuredClone(source); forged.cases[index].check = source.cases[index].check === 'matched' ? 'mismatched' : 'matched'
    assert.throws(() => suites.parsePromptSuiteReport(JSON.stringify(forged)), /^Error: Invalid prompt suite report$/)
  }
  const wrongVersion = structuredClone(source); wrongVersion.schema_version = 1
  assert.throws(() => suites.acceptPromptSuiteReport(wrongVersion), /Invalid prompt suite report/)
  const oldDefinition = report(10, [legacy(null)], ['{}'], ['not_requested'], 1); oldDefinition.schema_version = 2
  assert.throws(() => suites.acceptPromptSuiteReport(oldDefinition), /Invalid prompt suite report/)
})

test('response-only strict parsing preserves legacy projection of nonfinite numbers and lone surrogates in ignored snapshot fields', () => {
  const old = report(10, [legacy(null)], ['ordinary'], ['not_requested'], 1)
  const raw = JSON.stringify(old).replace('"snapshot":{', '"snapshot":{"ignoredNumber":1e999,"ignoredText":"\\ud800",')
  assert.deepEqual(suites.parsePromptSuiteReport(raw), suites.acceptPromptSuiteReport(old))
})

test('escaped invalid JSON reply content is retained literally and checks are recomputed on report import', () => {
  const reply = '{"value":"\\ud800","overflow":1e309}'
  const source = report(10, [item()], [reply], ['mismatched'])
  const accepted = suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(source))
  assert.equal(accepted.cases[0].check, 'mismatched')
  assert.equal(accepted.cases[0].snapshot.run.response.content, reply)
  source.cases[0].check = 'matched'
  assert.throws(() => suites.parsePromptSuiteReport(JSON.stringify(source)), /Invalid prompt suite report/)
})

test('JSON comparisons use v2 generic transitions while keeping literal reply inequality', () => {
  const inputs = [1, 2, 3, 4].map(number => item('json_object', null, number))
  const left = report(10, inputs, ['[]', '{}', '{"a":1,"b":2}', 'no'], ['mismatched', 'matched', 'matched', 'mismatched'])
  const right = report(11, inputs, ['{}', '[]', '{ "b": 2, "a": 1 }', 'no'], ['matched', 'mismatched', 'matched', 'mismatched'])
  const capture = comparePromptSuiteReports(left, right, { capturedAt }), result = capture.toReport()
  assert.equal(result.schema_version, 2)
  assert.deepEqual(result.rows.map(row => row.check_transition), ['gained_match', 'lost_match', 'retained_match', 'retained_mismatch'])
  assert.deepEqual(result.rows.map(row => row.reply_equal), [false, false, false, true])
  assert.ok(result.rows.every(row => !Object.hasOwn(row, 'exact_transition') && row.input_changes.check_kind === false))
  assert.deepEqual([result.summary.evaluated_pairs, result.summary.gained_matches, result.summary.lost_matches,
    result.summary.retained_matches, result.summary.retained_mismatches], [4, 1, 1, 1, 1])
  const output = exportPromptSuiteComparison(capture)
  assert.deepEqual(JSON.parse(output.json_text), result)
  assert.match(output.text, /"check_transition": "retained_match"/)
  assert.doesNotMatch(output.text, /"exact_transition"/)
  assert.match(output.text, /JSON-object matches verify bounded object format only, not fields, schema or meaning\. Reply equality remains literal\./)
})

for (const expected of [null, '', 'Å']) test(`mixed v1/v2 ${JSON.stringify(expected)} checks compare semantically in either direction`, () => {
  const reply = expected ?? 'anything', state = expected === null ? 'not_requested' : 'matched'
  const old = report(10, [legacy(expected)], [reply], [state], 1)
  const modern = report(11, [item(expected === null ? 'none' : 'exact_text', expected)], [reply], [state])
  for (const [left, right] of [[old, modern], [modern, old]]) {
    const result = compare(left, right), row = result.rows[0]
    assert.equal(result.schema_version, 2)
    assert.deepEqual(row.input_changes, { system_prompt: false, user_prompt: false, temperature: false,
      max_output_tokens: false, expected_text: false, check_kind: false })
    assert.equal(row.paired_succeeded, true)
    assert.equal(row.check_transition, expected === null ? null : 'retained_match')
    assert.equal(row.reply_equal, true)
    assert.equal(result.baseline.schema_version, left.schema_version)
    assert.equal(result.comparison.schema_version, right.schema_version)
    assert.equal(Object.hasOwn((left.schema_version === 1 ? result.baseline : result.comparison).definition.cases[0], 'check_kind'), false)
  }
})

test('changing only check kind excludes paired findings even when request inputs and replies match', () => {
  for (const left of [report(10, [legacy(null)], ['{}'], ['not_requested'], 1), report(10, [item('none')], ['{}'], ['not_requested'])]) {
    const result = compare(left, report(11)), row = result.rows[0]
    assert.deepEqual(row.input_changes, { system_prompt: false, user_prompt: false, temperature: false,
      max_output_tokens: false, expected_text: false, check_kind: true })
    assert.deepEqual([row.same_inputs, row.paired_succeeded, row.check_transition, row.reply_equal, row.request_duration_delta_ms], [false, false, null, null, null])
    assert.equal(result.summary.evaluated_pairs, 0)
  }
})

test('v2 comparison preserves any-opposite-case request overlap exclusion and added/removed rows', () => {
  const left = report(10, [item('json_object', null, 1), item('json_object', null, 2)], ['{}', '{}'], ['matched', 'matched'])
  const right = report(11, [item('json_object', null, 1), item('json_object', null, 3)], ['{}', '{}'], ['matched', 'matched'])
  right.cases[1].request_id = left.cases[0].request_id; right.cases[1].snapshot.run.request_id = left.cases[0].request_id
  const result = compare(left, right), row = result.rows[0]
  assert.deepEqual(result.rows.map(value => value.membership), ['shared', 'added', 'removed'])
  assert.deepEqual([row.request_id_overlap, row.paired_succeeded, row.check_transition, row.reply_equal, row.request_duration_delta_ms], [true, false, null, null, null])
  assert.equal(result.summary.overlapping_request_pairs, 1)
  assert.ok(result.rows.slice(1).every(value => value.input_changes === null && value.check_transition === null && !Object.hasOwn(value, 'exact_transition')))
})
