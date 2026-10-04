import assert from 'node:assert/strict'
import test from 'node:test'
import * as suites from '../src/utils/promptSuites.js'
import { acceptPromptTrialInputs } from '../src/api/promptTrials.js'
import { trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const rule = (name = 'value', type = 'string') => ({ name, type })
const item = (rules = [rule()], number = 1) => ({ case_id: id(number), ...trialRequest(), check_kind: 'json_fields', expected_text: null, required_fields: rules })
const definition = (cases = [item()]) => ({ schema_version: 3, kind: 'mirofish_local_prompt_suite', name: 'Required JSON fields', cases })
const evaluate = (rules, content, status = 'succeeded') => suites.evaluatePromptSuiteCheck(item(rules), status, content)
function report(inputs = [item()], replies = ['{"value":""}'], checks = ['matched']) {
  return { schema_version: 3, kind: 'mirofish_local_prompt_suite_run', run_id: id(10), definition: definition(inputs),
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
    cases: inputs.map((input, index) => {
      const snapshot = trialSnapshot('succeeded')
      snapshot.run.request_id = id(100 + index); snapshot.run.request = acceptPromptTrialInputs(input); snapshot.run.response.content = replies[index]
      return { case_id: input.case_id, request_id: snapshot.run.request_id, status: 'succeeded', check: checks[index], snapshot, error_code: null }
    }) }
}

test('v3 admits every mode with explicit requirements, exact order and detached nested rules', () => {
  const source = definition([item([rule('🦙'.repeat(80), 'null'), rule(' value ', 'boolean')]),
    { ...item(null, 2), check_kind: 'none' }, { ...item(null, 3), check_kind: 'exact_text', expected_text: '' },
    { ...item(null, 4), check_kind: 'json_object' }])
  const accepted = suites.acceptPromptSuiteDefinition(source)
  assert.deepEqual(accepted, source)
  assert.deepEqual(Object.keys(accepted.cases[0]), ['case_id', 'label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens', 'check_kind', 'expected_text', 'required_fields'])
  assert.deepEqual(suites.parsePromptSuiteDefinition(suites.exportPromptSuiteDefinition(source)), source)
  assert.notEqual(accepted.cases[0].required_fields, source.cases[0].required_fields)
  assert.notEqual(accepted.cases[0].required_fields[0], source.cases[0].required_fields[0])
  source.cases[0].required_fields[0].name = 'changed'; source.cases[0].required_fields.push(rule('other'))
  assert.deepEqual(accepted.cases[0].required_fields, [rule('🦙'.repeat(80), 'null'), rule(' value ', 'boolean')])
  assert.deepEqual(suites.getPromptSuiteCheck(accepted.cases[0]), { kind: 'json_fields', expected_text: null, required_fields: accepted.cases[0].required_fields })
  for (const input of accepted.cases.slice(1)) assert.deepEqual(suites.getPromptSuiteCheck(input), { kind: input.check_kind, expected_text: input.expected_text })
  const maximum = definition([item(Array.from({ length: 10 }, (_, index) => rule(String(index))))])
  assert.deepEqual(suites.parsePromptSuiteDefinition(JSON.stringify(maximum)), maximum)
})

for (const [name, change] of [
  ['missing requirements', value => delete value.cases[0].required_fields],
  ['null requirements', value => value.cases[0].required_fields = null],
  ['object requirements', value => value.cases[0].required_fields = {}],
  ['empty rules', value => value.cases[0].required_fields = []],
  ['eleven rules', value => value.cases[0].required_fields = Array.from({ length: 11 }, (_, index) => rule(String(index)))],
  ['sparse rules', value => value.cases[0].required_fields = Array(1)],
  ['null rule', value => value.cases[0].required_fields = [null]],
  ['array rule', value => value.cases[0].required_fields = [['value', 'string']]],
  ['missing name', value => delete value.cases[0].required_fields[0].name],
  ['missing type', value => delete value.cases[0].required_fields[0].type],
  ['extra rule key', value => value.cases[0].required_fields[0].extra = true],
  ['blank name', value => value.cases[0].required_fields[0].name = ' \t '],
  ['empty name', value => value.cases[0].required_fields[0].name = ''],
  ['nonstring name', value => value.cases[0].required_fields[0].name = 1],
  ['81-codepoint name', value => value.cases[0].required_fields[0].name = '🦙'.repeat(81)],
  ...['\u0000', '\u0085', '\u202e', '\ud800', '\ue000', '\u0378'].map(character => ['invalid name ' + JSON.stringify(character), value => value.cases[0].required_fields[0].name = 'x' + character]),
  ['duplicate names', value => value.cases[0].required_fields.push(rule('value', 'number'))],
  ...['integer', 'String', '', null, [], {}].map(type => ['invalid type ' + JSON.stringify(type), value => value.cases[0].required_fields[0].type = type]),
  ['nonnull expectation', value => value.cases[0].expected_text = '{}'],
  ['missing expectation', value => delete value.cases[0].expected_text],
  ['missing mode', value => delete value.cases[0].check_kind],
  ['unknown mode', value => value.cases[0].check_kind = 'schema'],
  ['none with rules', value => value.cases[0].check_kind = 'none'],
  ['object with rules', value => value.cases[0].check_kind = 'json_object'],
  ['exact with rules', value => { value.cases[0].check_kind = 'exact_text'; value.cases[0].expected_text = '' }],
  ['v2 with requirements', value => value.schema_version = 2],
  ['v2 JSON fields mode', value => { value.schema_version = 2; delete value.cases[0].required_fields }],
  ['v1 with requirements', value => { value.schema_version = 1; delete value.cases[0].check_kind }],
  ['unknown version', value => value.schema_version = 4],
]) test(`v3 schema rejects ${name}`, () => {
  const source = definition(); change(source)
  assert.throws(() => suites.acceptPromptSuiteDefinition(source), /^Error: Invalid prompt suite definition$/)
  assert.throws(() => suites.parsePromptSuiteDefinition(JSON.stringify(source)), /^Error: Invalid prompt suite definition$/)
})

test('v3 rules require own exact string keys and reject escaped duplicate schema/name aliases', () => {
  const inherited = definition(); inherited.cases[0].required_fields[0] = Object.create(rule())
  assert.throws(() => suites.acceptPromptSuiteDefinition(inherited), /Invalid prompt suite definition/)
  const symbol = definition(); symbol.cases[0].required_fields[0][Symbol('extra')] = true
  assert.throws(() => suites.acceptPromptSuiteDefinition(symbol), /Invalid prompt suite definition/)
  const raw = JSON.stringify(definition())
  for (const value of [raw.replace('"name":"value"', '"name":"ignored","na\\u006de":"value"'),
    raw.replace('[{"name":"value","type":"string"}]', '[{"name":"value","type":"string"},{"name":"val\\u0075e","type":"number"}]')]) {
    assert.throws(() => suites.parsePromptSuiteDefinition(value), /Invalid prompt suite definition/)
  }
})

test('field checks distinguish all six types, missing null, falsy values and unchecked extra keys', () => {
  const values = { string: '', number: 0, boolean: false, object: {}, array: [], null: null }
  for (const [type, value] of Object.entries(values)) {
    for (const [otherType, otherValue] of Object.entries(values)) {
      assert.equal(evaluate([rule('value', type)], JSON.stringify({ value: otherValue, extra: true })), type === otherType ? 'matched' : 'mismatched', `${type} versus ${otherType}`)
    }
    assert.equal(evaluate([rule('value', type)], '{}'), 'mismatched')
  }
  const rules = Object.keys(values).map(type => rule(type, type))
  assert.equal(evaluate(rules, JSON.stringify(values)), 'matched')
  assert.equal(evaluate([rule('value', 'object')], '{"value":{"children":[null,1,"x"]}}'), 'matched')
  assert.equal(evaluate([rule('value', 'array')], '{"value":[null,{},false]}'), 'matched')
  for (const number of ['-0', '1.25', '1e308', '9007199254740993', '1.0000000000000001', '1e-400']) {
    assert.equal(evaluate([rule('value', 'number')], '{"value":' + number + '}'), 'matched')
  }
})

test('literal field names preserve prototype-like keys, Unicode distinctions, case and outer spaces', () => {
  const names = ['__proto__', 'constructor', 'toString', 'a.b[0]', 'Å', 'A\u030a', ' Value ', 'value', '🦙', '<b>']
  const rules = names.map(name => rule(name, 'null'))
  assert.deepEqual(suites.acceptPromptSuiteDefinition(definition([item(rules)])).cases[0].required_fields, rules)
  assert.equal(evaluate(rules, JSON.stringify(Object.fromEntries(names.map(name => [name, null])))), 'matched')
  for (const name of names) assert.equal(evaluate([rule(name, 'null')], '{}'), 'mismatched')
  assert.equal(evaluate([rule('a.b[0]', 'number')], '{"a":{"b":[0]}}'), 'mismatched')
  assert.equal(evaluate([rule('value')], '{"Value":"x"}'), 'mismatched')
  assert.equal(evaluate([rule(' Value ')], '{"Value":"x"}'), 'mismatched')
  assert.equal(evaluate([rule('Å')], '{"A\\u030a":"x"}'), 'mismatched')
  assert.equal(evaluate([rule('value')], '{"val\\u0075e":""}'), 'matched')
})

test('field checks apply the strict complete-object parser even to unrequired values', () => {
  for (const content of [null, undefined, {}, [], 1, '', '[]', '[{}]', 'null', 'true', '0', '"{}"',
    '```json\n{"value":""}\n```', '<think>x</think>{"value":""}', '{"value":""} trailing', '\ufeff{"value":""}',
    '{"value":"",}', '{"value":"","extra":1,"ex\\u0074ra":2}', '{"value":"","extra":{"a":0,"a":1}}',
    '{"value":"","extra":1e999}', '{"value":"","extra":"\\ud800"}', '{"value":"","\\udfff":0}',
    '{"value":"","extra":["\ud800"]}', '{"value":"","extra":NaN}', '{"value":""}\u00a0']) {
    assert.equal(evaluate([rule()], content), 'mismatched', String(content))
  }
  for (const content of [' \n{"value":"","extra":"\\u0000"}\t', '{"value":"","extra":"\\ud83e\\udd99"}']) {
    assert.equal(evaluate([rule()], content), 'matched')
  }
})

test('field checks share strict reply UTF-8 byte and value-depth boundaries', () => {
  const cap = 64 * 1024, prefix = '{"value":"', suffix = '"}'
  for (const character of ['a', '🦙']) {
    const size = new TextEncoder().encode(character).length
    const padding = cap - prefix.length - suffix.length
    const reply = prefix + character.repeat(Math.floor(padding / size)) + 'a'.repeat(padding % size) + suffix
    assert.equal(new TextEncoder().encode(reply).length, cap)
    assert.equal(evaluate([rule()], reply), 'matched')
    assert.equal(evaluate([rule()], reply + ' '), 'mismatched')
  }
  const nested = levels => '{"value":0,"extra":' + '['.repeat(levels) + '0' + ']'.repeat(levels) + '}'
  assert.equal(evaluate([rule('value', 'number')], nested(15)), 'matched')
  assert.equal(evaluate([rule('value', 'number')], nested(16)), 'mismatched')
  assert.equal(evaluate([rule('value', 'array')], '{"value":' + '['.repeat(16) + ']'.repeat(16) + '}'), 'matched')
  assert.equal(evaluate([rule('value', 'array')], '{"value":' + '['.repeat(17) + ']'.repeat(17) + '}'), 'mismatched')
  assert.equal(evaluate([rule('value', 'number')], nested(20000)), 'mismatched')
})

test('only succeeded rows evaluate required fields', () => {
  for (const status of ['not_attempted', 'submitting', 'running', 'rejected', 'unknown', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
    assert.equal(evaluate([rule()], '{"value":""}', status), 'not_evaluated')
    assert.equal(evaluate([rule()], 'invalid', status), 'not_evaluated')
  }
})

test('v3 definitions keep 128 KiB and reports keep 1 MiB/depth-12 parse limits', () => {
  const rawDefinition = JSON.stringify(definition()), definitionCap = suites.PROMPT_SUITE_MAX_BYTES
  const paddedDefinition = rawDefinition.padEnd(definitionCap)
  assert.deepEqual(suites.parsePromptSuiteDefinition(paddedDefinition), definition())
  assert.throws(() => suites.parsePromptSuiteDefinition(paddedDefinition + ' '), /Invalid prompt suite definition/)
  const source = report(), rawReport = JSON.stringify(source), reportCap = suites.PROMPT_SUITE_REPORT_MAX_BYTES
  assert.deepEqual(suites.parsePromptSuiteReport(rawReport.padEnd(reportCap)), suites.acceptPromptSuiteReport(source))
  assert.throws(() => suites.parsePromptSuiteReport(rawReport.padEnd(reportCap) + ' '), /Invalid prompt suite report/)
  const nested = levels => rawReport.replace('"snapshot":{', '"snapshot":{"ignored":' + '['.repeat(levels) + '0' + ']'.repeat(levels) + ',')
  assert.deepEqual(suites.parsePromptSuiteReport(nested(8)), suites.acceptPromptSuiteReport(source))
  assert.throws(() => suites.parsePromptSuiteReport(nested(9)), /Invalid prompt suite report/)
})

test('v3 report import recomputes all outcomes and preserves requirements without aliasing', () => {
  const source = report([item([rule('value', 'null')]), item([rule('value', 'number')], 2), item([rule()], 3)],
    ['{"value":null}', '{"value":"0"}', '{"value":"","unused":1e999}'], ['matched', 'mismatched', 'mismatched'])
  const accepted = suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(source))
  assert.deepEqual(accepted, suites.acceptPromptSuiteReport(source))
  assert.deepEqual(suites.summarizePromptSuiteReport(source), { total: 3, attempted: 3, succeeded: 3, evaluated: 3,
    matched: 1, mismatched: 2, not_requested: 0, not_evaluated: 0 })
  for (const index of [0, 1, 2]) {
    const forged = structuredClone(source); forged.cases[index].check = index === 0 ? 'mismatched' : 'matched'
    assert.throws(() => suites.parsePromptSuiteReport(JSON.stringify(forged)), /Invalid prompt suite report/)
  }
  const changedRule = structuredClone(source); changedRule.definition.cases[0].required_fields[0].type = 'number'
  assert.throws(() => suites.acceptPromptSuiteReport(changedRule), /Invalid prompt suite report/)
  source.definition.cases[0].required_fields[0].name = 'changed'
  assert.equal(accepted.definition.cases[0].required_fields[0].name, 'value')
})

test('v3 import preserves historical projection of ignored nonfinite and surrogate snapshot fields', () => {
  const source = report(), raw = JSON.stringify(source).replace('"snapshot":{', '"snapshot":{"ignoredNumber":1e999,"ignoredText":"\\ud800",')
  assert.deepEqual(suites.parsePromptSuiteReport(raw), suites.acceptPromptSuiteReport(source))
})
