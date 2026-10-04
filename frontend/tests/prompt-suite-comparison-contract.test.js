import assert from 'node:assert/strict'
import test from 'node:test'
import * as suites from '../src/utils/promptSuites.js'
import { trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as comparisonModule from '../src/utils/promptSuiteComparison.js'
const compare = (...args) => comparisonModule.comparePromptSuiteReports(...args)
const exported = capture => comparisonModule.exportPromptSuiteComparison(capture)

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const capturedAt = '2026-10-04T01:00:00Z'
const caseInput = (number, changes = {}) => ({ case_id: id(number), ...trialRequest(), expected_text: 'Hello back', ...changes })
function report(run = 10, inputs = [caseInput(1)]) {
  return { schema_version: 1, kind: 'mirofish_local_prompt_suite_run', run_id: id(run),
    definition: { schema_version: 1, kind: 'mirofish_local_prompt_suite', name: 'Exact checks', cases: inputs },
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z',
    status: 'completed', stop_requested: false, halt_code: null,
    cases: inputs.map((input, index) => {
      const snapshot = trialSnapshot('succeeded')
      const { case_id, expected_text, ...request } = input
      snapshot.run.request_id = id(run * 100 + index)
      snapshot.run.request = request
      return { case_id, request_id: snapshot.run.request_id, status: 'succeeded',
        check: expected_text === null ? 'not_requested' : expected_text === snapshot.run.response.content ? 'matched' : 'mismatched',
        snapshot, error_code: null }
    }) }
}

test('report text parser admits a real current writer round trip through accepted projection', () => {
  assert.equal(typeof suites.parsePromptSuiteReport, 'function')
  const source = report()
  source.cases[0].snapshot.run.configuration.secret = 'PRIVATE'
  const accepted = suites.acceptPromptSuiteReport(source)
  assert.deepEqual(suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(source)), accepted)
  assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE/)
})

test('report text parser rejects duplicate keys and escaped aliases at every schema depth', () => {
  const source = suites.exportPromptSuiteReport(report())
  for (const bad of [
    source.replace('"schema_version": 1', '"schema_version": 1, "schema_version": 1'),
    source.replace('"run_id":', '"run_id": "first", "run_\\u0069d":'),
    source.replace('"model":', '"mo\\u0064el": "shadow", "model":'),
    source.replace('"content":', '"content": "shadow", "content":'),
  ]) assert.throws(() => suites.parsePromptSuiteReport(bad), /^Error: Invalid prompt suite report$/)
})

test('report parser enforces UTF-8 bytes, nesting and strict JSON before report admission', () => {
  const source = JSON.stringify(report()), cap = suites.PROMPT_SUITE_REPORT_MAX_BYTES
  const atLimit = source + ' '.repeat(cap - new TextEncoder().encode(source).length)
  assert.deepEqual(suites.parsePromptSuiteReport(atLimit), suites.acceptPromptSuiteReport(report()))
  const nested = levels => source.replace('"snapshot":{', '"snapshot":{"extra":' + '['.repeat(levels) + '0' + ']'.repeat(levels) + ',')
  // snapshot is at depth 3; an unknown nested value is still parsed before projection.
  assert.deepEqual(suites.parsePromptSuiteReport(nested(8)), suites.acceptPromptSuiteReport(report()))
  for (const bad of [atLimit + ' ', source + '🦙'.repeat(cap / 4), nested(9), '['.repeat(20000) + ']'.repeat(20000),
    '{"x":1,}', '{"x":NaN}', '\ufeff' + source, source + 'null', 'null', [], null]) {
    assert.throws(() => suites.parsePromptSuiteReport(bad), /^Error: Invalid prompt suite report$/)
  }
})

test('report parser rejects unsupported, forged and comparison schemas', () => {
  for (const change of [r => r.schema_version = 2, r => r.kind = 'mirofish_local_prompt_suite_comparison',
    r => r.cases[0].case_id = id(90), r => r.cases[0].request_id = id(91), r => r.cases[0].check = 'mismatched',
    r => r.cases[0].snapshot.run.request.user_prompt = 'different', r => r.finished_at = null,
    r => r.cases[0].snapshot.run.configuration.model = 'https://private', r => r.private = 'secret']) {
    const source = report(); change(source)
    assert.throws(() => suites.parsePromptSuiteReport(JSON.stringify(source)), /^Error: Invalid prompt suite report$/)
  }
})

const compareReport = (baseline = report(), comparison = report(11)) => compare(baseline, comparison, { capturedAt }).toReport()
const setReply = (source, reply, index = 0) => {
  source.cases[index].snapshot.run.response.content = reply
  const expected = source.definition.cases[index].expected_text
  source.cases[index].check = expected === null ? 'not_requested' : expected === reply ? 'matched' : 'mismatched'
}
const setState = (source, state, index = 0) => {
  source.status = 'halted'; source.halt_code = 'observation_limit'
  const row = source.cases[index]
  row.status = state; row.check = 'not_evaluated'
  if (['not_attempted', 'submitting', 'rejected'].includes(state)) row.snapshot = null
  else {
    const run = row.snapshot.run
    run.state = state === 'unknown' ? 'running' : state
    if (run.state === 'running') {
      run.finished_at = null; run.response = null; run.request_duration_ms = null
      run.cleanup = { state: 'pending', duration_ms: null }
    } else if (state === 'truncated') run.response.finish_reason = 'length'
    else if (state === 'refused') { run.response.finish_reason = 'content_filter'; run.response.refusal = 'No' }
    else run.error_code = 'internal_failure'
  }
  if (state === 'not_attempted') row.request_id = null
}

test('comparison API captures exactly the fixed report, row and summary contracts', () => {
  assert.equal(typeof comparisonModule.comparePromptSuiteReports, 'function')
  assert.equal(typeof comparisonModule.exportPromptSuiteComparison, 'function')
  const baseline = report(), candidate = report(11), result = compareReport(baseline, candidate)
  assert.deepEqual(result, {
    schema_version: 1, kind: 'mirofish_local_prompt_suite_comparison', captured_at: capturedAt,
    baseline: suites.acceptPromptSuiteReport(baseline), comparison: suites.acceptPromptSuiteReport(candidate),
    definition_changes: { name: false, relative_order: false },
    configuration_summary: {
      baseline: { observed: [{ model: 'local-chat', reasoning_effort: null }], missing_cases: 0, mixed: false },
      comparison: { observed: [{ model: 'local-chat', reasoning_effort: null }], missing_cases: 0, mixed: false },
    },
    rows: [{ case_id: id(1), membership: 'shared', baseline_position: 1, comparison_position: 1,
      label_changed: false, input_changes: { system_prompt: false, user_prompt: false, temperature: false, max_output_tokens: false, expected_text: false },
      same_inputs: true, request_id_overlap: false, paired_succeeded: true, exact_transition: 'retained_match', reply_equal: true, request_duration_delta_ms: 0 }],
    summary: { baseline_cases: 1, comparison_cases: 1, added: 0, removed: 0, shared: 1, same_inputs: 1,
      paired_succeeded: 1, evaluated_pairs: 1, gained_matches: 0, lost_matches: 0, retained_matches: 1, retained_mismatches: 0, overlapping_request_pairs: 0 },
  })
})

test('exact case ID joins preserve comparison order then baseline-only order', () => {
  const baseline = report(10, [caseInput(1), caseInput(2), caseInput(3)]), candidate = report(11, [caseInput(4), caseInput(3), caseInput(1)])
  const result = compareReport(baseline, candidate)
  assert.deepEqual(result.rows.map(row => [row.case_id, row.membership, row.baseline_position, row.comparison_position]),
    [[id(4), 'added', null, 1], [id(3), 'shared', 3, 2], [id(1), 'shared', 1, 3], [id(2), 'removed', 2, null]])
  assert.equal(result.definition_changes.relative_order, true)
  for (const row of [result.rows[0], result.rows[3]]) {
    assert.deepEqual([row.label_changed, row.input_changes, row.same_inputs, row.request_id_overlap, row.paired_succeeded,
      row.exact_transition, row.reply_equal, row.request_duration_delta_ms], [false, null, null, null, false, null, null, null])
  }
  assert.deepEqual([result.summary.added, result.summary.removed, result.summary.shared], [1, 1, 2])
})

test('added and removed positions alone never imply changed shared relative order', () => {
  for (const cases of [[caseInput(4), caseInput(1), caseInput(3)], [caseInput(4)], [caseInput(3)]]) {
    assert.equal(compareReport(report(10, [caseInput(1), caseInput(2), caseInput(3)]), report(11, cases)).definition_changes.relative_order, false)
  }
})

test('suite names and labels are display changes, independent of five evaluation inputs', () => {
  const candidate = report(11, [caseInput(1, { label: 'A new label' })]); candidate.definition.name = 'Renamed suite'
  const result = compareReport(report(), candidate)
  assert.equal(result.definition_changes.name, true)
  assert.equal(result.rows[0].label_changed, true)
  assert.equal(result.rows[0].same_inputs, true)
  assert.equal(result.rows[0].paired_succeeded, true)
  assert.equal(result.rows[0].exact_transition, 'retained_match')
})

for (const [field, value] of [['system_prompt', 'New'], ['user_prompt', 'New'], ['temperature', 0], ['max_output_tokens', 1], ['expected_text', '']]) {
  test(`changed ${field} remains inspectable but excludes all paired findings`, () => {
    const result = compareReport(report(), report(11, [caseInput(1, { [field]: value })])), row = result.rows[0]
    assert.deepEqual(row.input_changes, Object.fromEntries(['system_prompt', 'user_prompt', 'temperature', 'max_output_tokens', 'expected_text'].map(key => [key, key === field])))
    assert.deepEqual([row.same_inputs, row.paired_succeeded, row.exact_transition, row.reply_equal, row.request_duration_delta_ms], [false, false, null, null, null])
    assert.equal(result.summary.paired_succeeded, 0)
  })
}

test('all exact-check transitions count only matching-input independent successful observations', () => {
  const inputs = [1, 2, 3, 4].map(number => caseInput(number, { expected_text: 'x' }))
  const baseline = report(10, inputs), candidate = report(11, inputs)
  ;['wrong', 'x', 'x', 'wrong'].forEach((reply, index) => setReply(baseline, reply, index))
  ;['x', 'wrong', 'x', 'wrong'].forEach((reply, index) => setReply(candidate, reply, index))
  const result = compareReport(baseline, candidate)
  assert.deepEqual(result.rows.map(row => row.exact_transition), ['gained_match', 'lost_match', 'retained_match', 'retained_mismatch'])
  assert.deepEqual([result.summary.evaluated_pairs, result.summary.gained_matches, result.summary.lost_matches, result.summary.retained_matches, result.summary.retained_mismatches], [4, 1, 1, 1, 1])
})

test('disabled expectation, empty expectation and literal Unicode replies remain distinct', () => {
  for (const [expected, left, right, transition, equal] of [[null, '', '', null, true], ['', '', '', 'retained_match', true],
    ['Å', 'Å', 'A\u030a', 'lost_match', false], ['x', 'x', 'x\n', 'lost_match', false], ['x', '<think>x</think>', 'x', 'gained_match', false]]) {
    const baseline = report(10, [caseInput(1, { expected_text: expected })]), candidate = report(11, [caseInput(1, { expected_text: expected })])
    setReply(baseline, left); setReply(candidate, right)
    const result = compareReport(baseline, candidate)
    assert.equal(result.rows[0].exact_transition, transition); assert.equal(result.rows[0].reply_equal, equal)
    assert.equal(result.summary.evaluated_pairs, expected === null ? 0 : 1)
    assert.equal(result.comparison.cases[0].snapshot.run.response.content, right)
  }
  assert.equal(compareReport(report(10, [caseInput(1, { expected_text: null })]), report(11, [caseInput(1, { expected_text: '' })])).rows[0].same_inputs, false)
})

test('the same request ID records the same observation even in two distinct suite runs', () => {
  const baseline = report(), candidate = report(11)
  candidate.cases[0].request_id = baseline.cases[0].request_id
  candidate.cases[0].snapshot.run.request_id = baseline.cases[0].request_id
  const result = compareReport(baseline, candidate), row = result.rows[0]
  assert.deepEqual([row.request_id_overlap, row.paired_succeeded, row.exact_transition, row.reply_equal, row.request_duration_delta_ms], [true, false, null, null, null])
  assert.equal(result.summary.overlapping_request_pairs, 1)
  assert.equal(result.summary.evaluated_pairs, 0)
})

test('request IDs swapped across shared case IDs cannot create independent paired gains or losses', () => {
  const inputs = [caseInput(1), caseInput(2)], baseline = report(10, inputs), candidate = report(11, inputs)
  setReply(baseline, 'wrong', 0); setReply(candidate, 'wrong', 1)
  candidate.cases.forEach((row, index) => {
    row.request_id = baseline.cases[1 - index].request_id
    row.snapshot.run.request_id = row.request_id
  })
  const result = compareReport(baseline, candidate)
  assert.deepEqual(result.rows.map(row => [row.case_id, row.membership, row.request_id_overlap, row.paired_succeeded,
    row.exact_transition, row.reply_equal, row.request_duration_delta_ms]),
  [1, 2].map(number => [id(number), 'shared', true, false, null, null, null]))
  assert.equal(result.summary.overlapping_request_pairs, 2)
  assert.equal(result.summary.evaluated_pairs, 0)
  assert.equal(result.summary.gained_matches, 0)
  assert.equal(result.summary.lost_matches, 0)
})

test('a shared case overlaps observations on opposite added or removed cases without changing the case join', () => {
  for (const direction of ['added', 'removed']) {
    const baseline = report(10, [caseInput(1), caseInput(2)]), candidate = report(11, [caseInput(1), caseInput(3)])
    const destination = direction === 'added' ? candidate.cases[1] : baseline.cases[1]
    destination.request_id = direction === 'added' ? baseline.cases[0].request_id : candidate.cases[0].request_id
    destination.snapshot.run.request_id = destination.request_id
    const result = compareReport(baseline, candidate)
    assert.deepEqual(result.rows.map(row => [row.case_id, row.membership, row.request_id_overlap]),
      [[id(1), 'shared', true], [id(3), 'added', null], [id(2), 'removed', null]])
    assert.deepEqual([result.rows[0].paired_succeeded, result.rows[0].exact_transition, result.rows[0].reply_equal, result.rows[0].request_duration_delta_ms], [false, null, null, null])
    assert.equal(result.summary.overlapping_request_pairs, 1)
  }
})

test('null request IDs are not observations and disjoint reports remain eligible', () => {
  const baseline = report(), candidate = report(11)
  const disjoint = compareReport(baseline, candidate)
  assert.equal(disjoint.rows[0].request_id_overlap, false)
  assert.equal(disjoint.rows[0].paired_succeeded, true)
  assert.equal(disjoint.summary.overlapping_request_pairs, 0)
  setState(baseline, 'not_attempted'); setState(candidate, 'not_attempted')
  const unattempted = compareReport(baseline, candidate)
  assert.equal(unattempted.rows[0].request_id_overlap, false)
  assert.equal(unattempted.rows[0].paired_succeeded, false)
  assert.equal(unattempted.summary.overlapping_request_pairs, 0)
})

test('zero request durations are valid and missing durations never become a zero delta', () => {
  for (const [left, right, delta] of [[0, 0, 0], [0, 12, 12], [12, 0, -12], [null, 0, null], [0, null, null], [null, null, null]]) {
    const baseline = report(), candidate = report(11)
    baseline.cases[0].snapshot.run.request_duration_ms = left
    candidate.cases[0].snapshot.run.request_duration_ms = right
    baseline.cases[0].snapshot.run.elapsed_ms = 10000; candidate.cases[0].snapshot.run.elapsed_ms = 30000
    const result = compareReport(baseline, candidate)
    assert.equal(result.rows[0].request_duration_delta_ms, delta)
    assert.equal(result.rows[0].paired_succeeded, true)
    assert.equal(result.baseline.cases[0].snapshot.run.elapsed_ms, 10000)
    assert.equal(result.comparison.cases[0].snapshot.run.elapsed_ms, 30000)
  }
})

for (const state of ['not_attempted', 'submitting', 'running', 'rejected', 'unknown', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`${state} rows preserve recorded data but never contribute paired findings`, () => {
    const candidate = report(11); setState(candidate, state)
    const result = compareReport(report(), candidate), row = result.rows[0]
    assert.deepEqual([row.paired_succeeded, row.exact_transition, row.reply_equal, row.request_duration_delta_ms], [false, null, null, null])
    assert.equal(row.request_id_overlap, false)
    assert.equal(result.comparison.cases[0].status, state)
    assert.equal(result.comparison.status, 'halted')
  })
}

test('halted and stopped reports can retain successful eligible rows after reconciliation', () => {
  const baseline = report(), candidate = report(11)
  baseline.status = 'halted'; baseline.halt_code = 'invalid_observation'; baseline.cases[0].error_code = 'read_failed'
  candidate.status = 'stopped'; candidate.stop_requested = true
  const result = compareReport(baseline, candidate)
  assert.equal(result.rows[0].paired_succeeded, true)
  assert.equal(result.baseline.halt_code, 'invalid_observation')
  assert.equal(result.baseline.cases[0].error_code, 'read_failed')
  assert.equal(result.comparison.stop_requested, true)
})

test('configuration summary retains each recorded model and reasoning pair and unknown cases', () => {
  const inputs = [1, 2, 3, 4, 5].map(number => caseInput(number)), candidate = report(11, inputs)
  candidate.cases[1].snapshot.run.configuration = { model: 'local-chat', reasoning_effort: 'high' }
  candidate.cases[2].snapshot.run.configuration = { model: 'another-local-model', reasoning_effort: null }
  candidate.cases[3].snapshot.run.configuration = { model: 'local-chat', reasoning_effort: 'high' }
  setState(candidate, 'not_attempted', 4)
  const result = compareReport(report(10, inputs), candidate)
  assert.deepEqual(result.configuration_summary.comparison, { observed: [
    { model: 'local-chat', reasoning_effort: null }, { model: 'local-chat', reasoning_effort: 'high' },
    { model: 'another-local-model', reasoning_effort: null }], missing_cases: 1, mixed: true })
  assert.equal(result.comparison.cases[3].snapshot.run.configuration.reasoning_effort, 'high')
})

test('all missing configuration remains unknown and an unknown running observation keeps its recorded configuration', () => {
  const baseline = report(), candidate = report(11)
  setState(baseline, 'not_attempted'); setState(candidate, 'unknown')
  const result = compareReport(baseline, candidate)
  assert.deepEqual(result.configuration_summary.baseline, { observed: [], missing_cases: 1, mixed: false })
  assert.deepEqual(result.configuration_summary.comparison, { observed: [{ model: 'local-chat', reasoning_effort: null }], missing_cases: 0, mixed: false })
})

test('capture admission rejects same suite run IDs, malformed reports and invalid capture timestamps', () => {
  assert.throws(() => compare(report(), report()), /^Error: Invalid prompt suite comparison$/)
  for (const value of [null, '2026-02-30T01:00:00Z', '2026-10-04', '2026-10-04T01:00:00+05:00', 0]) {
    assert.throws(() => compare(report(), report(11), { capturedAt: value }), /^Error: Invalid prompt suite comparison$/)
  }
  const malformed = report(11); malformed.cases[0].check = 'mismatched'
  assert.throws(() => compare(report(), malformed), /^Error: Invalid prompt suite comparison$/)
  assert.match(compare(report(), report(11)).toReport().captured_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('capture is frozen, detached and protected from mutation through inputs and every returned report', () => {
  const baseline = report(), candidate = report(11)
  baseline.cases[0].snapshot.secret = 'PRIVATE'
  const capture = compare(baseline, candidate, { capturedAt }), expected = capture.toReport()
  assert.ok(Object.isFrozen(capture))
  assert.throws(() => capture.toReport = () => ({}), TypeError)
  baseline.definition.name = 'mutated'; candidate.cases[0].snapshot.run.response.content = 'mutated'
  const result = capture.toReport()
  result.baseline.definition.cases[0].user_prompt = 'mutated'
  result.comparison.cases[0].snapshot.run.configuration.model = 'mutated'
  result.rows[0].input_changes.user_prompt = true
  result.summary.evaluated_pairs = 100
  result.configuration_summary.baseline.observed[0].model = 'mutated'
  assert.deepEqual(capture.toReport(), expected)
  assert.doesNotMatch(JSON.stringify(expected), /PRIVATE/)
  assert.equal(JSON.stringify(expected).match(/mirofish_local_prompt_suite_run/g).length, 2)
})

test('exports use one historical capture and literal safe text without importing comparison bundles', () => {
  const baseline = report(), candidate = report(11)
  const literal = 'Header\nRun: forged\r\t\u0000\u0085\u202e\u2028\u2029\u{e0001}<script>🦙'
  setReply(candidate, literal)
  const capture = compare(baseline, candidate, { capturedAt }), output = exported(capture)
  assert.deepEqual(Object.keys(output), ['json_text', 'text', 'captured_at'])
  assert.deepEqual(JSON.parse(output.json_text), capture.toReport())
  assert.equal(output.captured_at, capturedAt)
  assert.equal(JSON.parse(output.json_text).comparison.cases[0].snapshot.run.response.content, literal)
  assert.doesNotMatch(output.text, /[\u0000\u0085\u202e\u2028\u2029\u{e0001}]/u)
  assert.match(output.text, /Header\\nRun: forged\\r\\t\\u0000\\u0085\\u202e\\u2028\\u2029\\udb40\\udc01/)
  assert.match(output.text, /elapsed_ms/); assert.match(output.text, /request_duration_ms/)
  assert.deepEqual(exported(capture), output)
  assert.throws(() => suites.parsePromptSuiteReport(output.json_text), /Invalid prompt suite report/)
  assert.throws(() => exported({ toReport: () => capture.toReport() }), /^Error: Invalid prompt suite comparison export$/)
  for (const value of [output.json_text, output.text]) assert.ok(new TextEncoder().encode(value).length <= 4 * 1024 * 1024)
})

test('maximum-size admitted field values keep complete literal exports within the output cap', () => {
  const marker = '\u{e0001}'
  const inputs = [1, 2, 3, 4, 5].map(number => caseInput(number, { label: 'L'.repeat(80), system_prompt: marker.repeat(1000),
    user_prompt: marker.repeat(4000), max_output_tokens: 512, expected_text: marker.repeat(500) }))
  const baseline = report(10, inputs), candidate = report(11, inputs)
  for (const source of [baseline, candidate]) {
    source.definition.name = 'N'.repeat(80)
    source.cases.forEach((row, index) => {
      setReply(source, marker.repeat(16384), index)
      row.snapshot.run.configuration = { model: 'm'.repeat(256), reasoning_effort: 'r'.repeat(64) }
    })
    setState(source, 'refused', 4)
    source.cases[4].snapshot.run.response.refusal = marker.repeat(16384)
    assert.deepEqual(suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(source)), suites.acceptPromptSuiteReport(source))
  }
  const capture = compare(baseline, candidate, { capturedAt }), output = exported(capture)
  assert.ok(new TextEncoder().encode(output.text).length > 3 * 1024 * 1024)
  for (const value of [output.json_text, output.text]) assert.ok(new TextEncoder().encode(value).length <= 4 * 1024 * 1024)
  assert.deepEqual(JSON.parse(output.json_text), capture.toReport())
  assert.equal(JSON.parse(output.json_text).comparison.cases[4].snapshot.run.response.refusal, marker.repeat(16384))
})

test('export byte-limit failures leave the valid capture intact and retryable', () => {
  // Instrument only the browser byte-counting boundary to test an output beyond
  // the current small report field limits without allocating an oversized input.
  let measuredSize = null, oversizedKind = 'json'
  const source = readFileSync(new URL('../src/utils/promptSuiteComparison.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export (const|function) /g, '$1 ')
  const module = vm.runInNewContext(source + '\n;({comparePromptSuiteReports, exportPromptSuiteComparison})', {
    acceptPromptSuiteReport: suites.acceptPromptSuiteReport,
    getPromptSuiteCheck: suites.getPromptSuiteCheck,
    TextEncoder: class { encode(value) {
      return measuredSize !== null && (oversizedKind === 'json' ? value.startsWith('{') : value.startsWith('MiroFish'))
        ? { length: measuredSize } : new TextEncoder().encode(value)
    } },
  })
  const capture = module.comparePromptSuiteReports(report(), report(11), { capturedAt }), expected = JSON.stringify(capture.toReport())
  for (const kind of ['json', 'text']) {
    oversizedKind = kind; measuredSize = 4 * 1024 * 1024
    assert.equal(JSON.stringify(JSON.parse(module.exportPromptSuiteComparison(capture).json_text)), expected)
    measuredSize++
    assert.throws(() => module.exportPromptSuiteComparison(capture), /^Error: Invalid prompt suite comparison export$/)
    assert.equal(JSON.stringify(capture.toReport()), expected)
  }
  measuredSize = null
  assert.equal(JSON.stringify(JSON.parse(module.exportPromptSuiteComparison(capture).json_text)), expected)
})
