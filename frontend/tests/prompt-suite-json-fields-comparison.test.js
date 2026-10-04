import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as suites from '../src/utils/promptSuites.js'
import { acceptPromptTrialInputs } from '../src/api/promptTrials.js'
import { comparePromptSuiteReports, exportPromptSuiteComparison } from '../src/utils/promptSuiteComparison.js'
import { trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const capturedAt = '2026-10-04T01:00:00Z'
const rule = (name = 'value', type = 'number') => ({ name, type })
const item = (rules = [rule()], number = 1) => ({ case_id: id(number), ...trialRequest(), check_kind: 'json_fields', expected_text: null, required_fields: rules })
function report(run = 10, inputs = [item()], replies = ['{"value":0}'], checks = ['matched'], version = 3, name = 'Required JSON fields') {
  return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(run),
    definition: { schema_version: version, kind: 'mirofish_local_prompt_suite', name, cases: inputs },
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
    cases: inputs.map((input, index) => {
      const snapshot = trialSnapshot('succeeded')
      snapshot.run.request_id = id(run * 100 + index); snapshot.run.request = acceptPromptTrialInputs(input); snapshot.run.response.content = replies[index]
      return { case_id: input.case_id, request_id: snapshot.run.request_id, status: 'succeeded', check: checks[index], snapshot, error_code: null }
    }) }
}
const compare = (left = report(), right = report(11)) => comparePromptSuiteReports(left, right, { capturedAt }).toReport()

test('v3 comparisons record generic transitions, literal replies and required-field input equality', () => {
  const inputs = [1, 2, 3, 4].map(number => item([rule()], number))
  const left = report(10, inputs, ['{}', '{"value":0}', '{"value":0}', '{}'], ['mismatched', 'matched', 'matched', 'mismatched'])
  const right = report(11, inputs, ['{"value":0}', '{}', '{ "value" : 0 }', '{}'], ['matched', 'mismatched', 'matched', 'mismatched'])
  const capture = comparePromptSuiteReports(left, right, { capturedAt }), result = capture.toReport()
  assert.equal(result.schema_version, 3)
  assert.deepEqual(result.rows.map(row => row.check_transition), ['gained_match', 'lost_match', 'retained_match', 'retained_mismatch'])
  assert.deepEqual(result.rows.map(row => row.reply_equal), [false, false, false, true])
  assert.deepEqual(result.rows[0].input_changes, { system_prompt: false, user_prompt: false, temperature: false,
    max_output_tokens: false, expected_text: false, check_kind: false, required_fields: false })
  assert.ok(result.rows.every(row => !Object.hasOwn(row, 'exact_transition')))
  assert.deepEqual([result.summary.evaluated_pairs, result.summary.gained_matches, result.summary.lost_matches,
    result.summary.retained_matches, result.summary.retained_mismatches], [4, 1, 1, 1, 1])
  const exported = exportPromptSuiteComparison(capture)
  assert.deepEqual(JSON.parse(exported.json_text), result)
  assert.match(exported.text, /required top-level fields and types/)
  assert.match(exported.text, /not full schema or meaning/)
})

test('requirement order is semantically equal while captured names, types and order stay verbatim', () => {
  const rules = [rule('__proto__', 'null'), rule('Å', 'string'), rule('A\u030a', 'string'), rule(' value ', 'boolean')]
  const reply = '{"__proto__":null,"Å":"","A\\u030a":""," value ":false}'
  const left = report(10, [item(rules)], [reply]), right = report(11, [item([...rules].reverse())], [reply])
  const result = compare(left, right), row = result.rows[0]
  assert.equal(row.input_changes.required_fields, false)
  assert.deepEqual([row.same_inputs, row.paired_succeeded, row.check_transition, row.reply_equal, row.request_duration_delta_ms], [true, true, 'retained_match', true, 0])
  assert.deepEqual(result.baseline.definition.cases[0].required_fields, rules)
  assert.deepEqual(result.comparison.definition.cases[0].required_fields, [...rules].reverse())
})

for (const [name, rules] of [['type', [rule('value', 'string')]], ['added', [rule(), rule('other', 'null')]],
  ['removed', [rule('other', 'null')]], ['case', [rule('Value')]], ['space', [rule(' value ')]],
  ['prototype', [rule('__proto__')]], ['Unicode', [rule('Å')]]]) test(`changed ${name} requirement excludes every paired finding`, () => {
  const leftRules = name === 'removed' ? [rule(), rule('other', 'null')] : name === 'Unicode' ? [rule('A\u030a')] : [rule()]
  const result = compare(report(10, [item(leftRules)], ['{}'], ['mismatched']), report(11, [item(rules)], ['{}'], ['mismatched']))
  const row = result.rows[0]
  assert.equal(row.input_changes.required_fields, true)
  assert.equal(row.input_changes.check_kind, false)
  assert.deepEqual([row.same_inputs, row.paired_succeeded, row.check_transition, row.reply_equal, row.request_duration_delta_ms], [false, false, null, null, null])
  assert.equal(result.summary.evaluated_pairs, 0)
})

test('v1/v2 no-requirement cases remain comparable against v3 in both directions', () => {
  for (const [version, kind, expected, reply, check] of [[1, 'none', null, 'anything', 'not_requested'], [1, 'exact_text', '', '', 'matched'],
    [2, 'none', null, 'anything', 'not_requested'], [2, 'exact_text', 'Å', 'Å', 'matched'], [2, 'json_object', null, '{}', 'matched']]) {
    const input = { case_id: id(1), ...trialRequest(), ...(version === 2 ? { check_kind: kind } : {}), expected_text: expected }
    const old = report(10, [input], [reply], [check], version)
    const modern = report(11, [{ ...input, check_kind: kind, required_fields: null }], [reply], [check])
    for (const [left, right] of [[old, modern], [modern, old]]) {
      const result = compare(left, right), row = result.rows[0]
      assert.equal(result.schema_version, 3)
      assert.equal(row.input_changes.required_fields, false)
      assert.equal(row.input_changes.check_kind, false)
      assert.equal(row.paired_succeeded, true)
      assert.equal(row.check_transition, kind === 'none' ? null : 'retained_match')
      assert.equal(result.baseline.schema_version, left.schema_version)
      assert.equal(result.comparison.schema_version, right.schema_version)
    }
  }
})

test('changing between JSON object and fields records both semantic input changes', () => {
  const object = { ...item(null), check_kind: 'json_object' }
  const row = compare(report(10, [object]), report(11)).rows[0]
  assert.equal(row.input_changes.required_fields, true)
  assert.equal(row.input_changes.check_kind, true)
  assert.equal(row.paired_succeeded, false)
})

test('v3 retains opposite-request overlap exclusion and added/removed row shapes', () => {
  const left = report(10, [item(), item([rule()], 2)], ['{"value":0}', '{"value":0}'], ['matched', 'matched'])
  const right = report(11, [item(), item([rule()], 3)], ['{"value":0}', '{"value":0}'], ['matched', 'matched'])
  right.cases[1].request_id = left.cases[0].request_id; right.cases[1].snapshot.run.request_id = left.cases[0].request_id
  const result = compare(left, right)
  assert.deepEqual(result.rows.map(row => row.membership), ['shared', 'added', 'removed'])
  assert.deepEqual([result.rows[0].request_id_overlap, result.rows[0].paired_succeeded, result.rows[0].check_transition,
    result.rows[0].reply_equal, result.rows[0].request_duration_delta_ms], [true, false, null, null, null])
  assert.ok(result.rows.slice(1).every(row => row.input_changes === null && row.check_transition === null))
})

test('v3 comparisons exclude nonsucceeded observations and reject forged imported checks', () => {
  const right = report(11)
  right.status = 'halted'; right.halt_code = 'runtime_failed'; right.cases[0].status = 'truncated'; right.cases[0].check = 'not_evaluated'
  right.cases[0].snapshot.run.state = 'truncated'; right.cases[0].snapshot.run.response.finish_reason = 'length'
  const row = compare(report(), right).rows[0]
  assert.deepEqual([row.same_inputs, row.paired_succeeded, row.check_transition, row.reply_equal, row.request_duration_delta_ms], [true, false, null, null, null])
  const forged = report(11); forged.cases[0].check = 'mismatched'
  assert.throws(() => compare(report(), forged), /Invalid prompt suite comparison/)
})

test('captured v3 comparison exports ignore nested source and returned-report mutations', () => {
  const left = report(), right = report(11), capture = comparePromptSuiteReports(left, right, { capturedAt })
  const expected = exportPromptSuiteComparison(capture)
  left.definition.cases[0].required_fields[0].name = 'changed'
  right.definition.cases[0].required_fields.push(rule('new', 'array'))
  const returned = capture.toReport()
  returned.baseline.definition.cases[0].required_fields[0].type = 'object'
  returned.comparison.definition.cases[0].required_fields.length = 0
  assert.deepEqual(exportPromptSuiteComparison(capture), expected)
})

// Captured from efbcca3 before adding v3; these fixed digests include property
// ordering, whitespace, Unicode and the complete historical TXT explanatory text.
const historical = {
  1: { definition: 'c708ee3df15807601417479685f1415d46c268136798a5b80193e760b4847e00', report: '7f1562a2243314dec90f260b3a6190cfd3e1a2686b26844d3a5c47597aa3ef6e',
    comparisonJson: '9680a0348ea81df73284779194fd788ef806ee250c1b2f9bcbe33e4354685b7f', comparisonText: '5058b4c2f9f0bd0cfb4a97a2ddd4bb17fb73bb23d188cde40fe2bea1ef970555' },
  2: { definition: 'c372a1ce4a69bf57ef1a7e8cbbbca74f8618a20d0a01b4539dcd4738a78a4cfb', report: 'f5598d6d52642f2366e431c6e7a13a4e4324ef3e35f7b13a4a07785bd68b67bc',
    comparisonJson: '712cb82c160123ec834bdd8a71f1d6f8f64fc2b3677f199fbcf362daab7f74f3', comparisonText: '14b3e003294438a06dd5043fafc45034d856e28caad50b91e2cc84240f4d6aa3' },
}
for (const version of [1, 2]) test(`v${version} definition/run/comparison JSON and TXT export bytes remain historical`, () => {
  const inputs = (version === 1 ? [null, '', 'Å\r\n'] : ['none', 'exact_text', 'json_object']).map((value, index) => ({
    case_id: id(index + 1), ...trialRequest(), ...(version === 2 ? { check_kind: value } : {}),
    expected_text: version === 1 ? value : value === 'exact_text' ? '' : null }))
  const replies = ['anything', '', version === 1 ? 'Å\r\n' : '{}']
  const make = run => report(run, inputs, replies, ['not_requested', 'matched', 'matched'], version, 'Historical bytes 🦙')
  const source = make(10), comparison = exportPromptSuiteComparison(comparePromptSuiteReports(source, make(11), { capturedAt }))
  const outputs = { definition: suites.exportPromptSuiteDefinition(source.definition), report: suites.exportPromptSuiteReport(source),
    comparisonJson: comparison.json_text, comparisonText: comparison.text }
  for (const [name, output] of Object.entries(outputs)) assert.equal(createHash('sha256').update(output).digest('hex'), historical[version][name], name)
  assert.equal(Object.hasOwn(suites.acceptPromptSuiteDefinition(source.definition).cases[0], 'required_fields'), false)
  const projected = JSON.stringify(source).replace('"snapshot":{', '"snapshot":{"ignoredNumber":1e999,"ignoredText":"\\ud800",')
  assert.deepEqual(suites.parsePromptSuiteReport(projected), suites.acceptPromptSuiteReport(source))
})
