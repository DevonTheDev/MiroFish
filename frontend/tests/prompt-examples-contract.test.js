import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as examples from '../src/utils/promptExamples.js'
import * as suites from '../src/utils/promptSuites.js'
import { trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const reviewedAt = '2026-10-04T01:00:00Z', capturedAt = '2026-10-04T01:00:01Z'
const input = (number = 1, changes = {}) => ({ case_id: id(number), ...trialRequest(), expected_text: null, ...changes })
function report(inputs = [input()], version = 1) {
  const definition = { schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Reviewed examples', cases: inputs }
  return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(90), definition,
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed',
    stop_requested: false, halt_code: null, cases: inputs.map((item, index) => {
      const snapshot = trialSnapshot('succeeded')
      snapshot.run.request_id = id(100 + index)
      snapshot.run.request = Object.fromEntries(['label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens'].map(key => [key, item[key]]))
      return { case_id: item.case_id, request_id: snapshot.run.request_id, status: 'succeeded',
        check: suites.evaluatePromptSuiteCheck(item, 'succeeded', snapshot.run.response.content), snapshot, error_code: null }
    }) }
}
function setReply(source, content, index = 0) {
  source.cases[index].snapshot.run.response.content = content
  source.cases[index].check = suites.evaluatePromptSuiteCheck(source.definition.cases[index], 'succeeded', content)
}
function setState(source, state) {
  source.status = 'halted'; source.halt_code = 'observation_limit'
  const row = source.cases[0]
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
const capture = source => examples.capturePromptExampleSource(source)
const approve = (source, caseId = id(1), target = 'Reviewed target') => examples.approvePromptExampleTarget(source, caseId, target, { reviewedAt })
const build = (source, approvals) => examples.buildPromptExamples(source, approvals, { capturedAt })
const exported = bundle => examples.exportPromptExamples(bundle)
const invalidSource = /^Error: Invalid prompt examples source$/
const invalidApproval = /^Error: Invalid prompt examples approval$/
const invalidBundle = /^Error: Invalid prompt examples bundle$/
const invalidExport = /^Error: Invalid prompt examples export$/

test('review/export exposes the four factory functions', () => {
  for (const name of ['capturePromptExampleSource', 'approvePromptExampleTarget', 'buildPromptExamples', 'exportPromptExamples']) {
    assert.equal(typeof examples[name], 'function', `${name} must be implemented`)
  }
})

test('captures the actual existing report writer round trip with sanitized detached source data', () => {
  const source = report()
  source.cases[0].snapshot.secret = 'PRIVATE_ENVELOPE'
  source.cases[0].snapshot.run.configuration.secret = 'PRIVATE_CONFIGURATION'
  const written = suites.exportPromptSuiteReport(source)
  const captured = capture(suites.parsePromptSuiteReport(written))
  assert.deepEqual(captured.toReport(), suites.acceptPromptSuiteReport(source))
  assert.doesNotMatch(JSON.stringify(captured.toReport()), /PRIVATE_/)
  assert.ok(Object.isFrozen(captured))
  const first = captured.toReport(), second = captured.toReport()
  assert.notEqual(first, second)
  assert.notEqual(first.definition.cases[0], second.definition.cases[0])
  first.definition.cases[0].user_prompt = 'changed'
  first.cases[0].snapshot.run.response.content = 'changed'
  assert.deepEqual(captured.toReport(), second)
})

test('exports exactly conversational messages plus selected companion provenance', () => {
  const source = report([input(1, { system_prompt: 'System', expected_text: 'Expected' })])
  const captured = capture(source), approval = approve(captured)
  assert.ok(Object.isFrozen(approval))
  assert.deepEqual(approval.toReport(), { case_id: id(1), target_text: 'Reviewed target', reviewed_at: reviewedAt,
    target_check: 'mismatched', captured_reply_equal: false })
  const bundle = build(captured, [approval]), result = bundle.toReport(), output = exported(bundle)
  assert.ok(Object.isFrozen(bundle)); assert.ok(Object.isFrozen(output))
  assert.deepEqual(Object.keys(output), ['jsonl_text', 'review_json_text', 'captured_at'])
  const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Reviewed target' }]
  assert.equal(output.jsonl_text, JSON.stringify({ messages }) + '\n')
  assert.deepEqual(Object.keys(result), ['schema_version', 'kind', 'captured_at', 'source_summary', 'examples', 'notes'])
  assert.equal(result.schema_version, 1); assert.equal(result.kind, 'mirofish_reviewed_prompt_examples')
  assert.equal(result.captured_at, capturedAt); assert.equal(output.captured_at, capturedAt)
  assert.deepEqual(result.source_summary, { schema_version: 1, run_id: id(90), suite_name: 'Reviewed examples',
    started_at: source.started_at, finished_at: source.finished_at, status: 'completed', stop_requested: false,
    halt_code: null, total_case_count: 1 })
  assert.deepEqual(result.examples, [{ position: 1, line_number: 1, case_id: id(1), reviewed_at: reviewedAt, target_check: 'mismatched',
    captured_reply_equal: false, messages, source_input: suites.acceptPromptSuiteReport(source).definition.cases[0],
    source_row: suites.acceptPromptSuiteReport(source).cases[0] }])
  assert.deepEqual(JSON.parse(output.review_json_text), result)
  assert.match(result.notes.join(' '), /user.approved.*export/i)
  assert.match(result.notes.join(' '), /correctness/i)
  assert.match(result.notes.join(' '), /authenticated origin/i)
  assert.match(result.notes.join(' '), /source.*check.*separate/i)
  assert.match(result.notes.join(' '), /training/i)
  assert.match(result.notes.join(' '), /template/i)
  assert.match(result.notes.join(' '), /hardware/i)
  assert.match(result.notes.join(' '), /held.out.*separate/i)
  assert.match(result.notes.join(' '), /selected prompts.*replies/i)
})

test('selection retains original positions/order and never merges identical content with distinct IDs', () => {
  const captured = capture(report([input(1), input(2), input(3), input(4), input(5)]))
  const bundle = build(captured, [approve(captured, id(5)), approve(captured, id(2)), approve(captured, id(1))])
  assert.deepEqual(bundle.toReport().examples.map(item => [item.position, item.line_number, item.case_id]), [[1, 1, id(1)], [2, 2, id(2)], [5, 3, id(5)]])
  const lines = exported(bundle).jsonl_text.trimEnd().split('\n')
  assert.equal(lines.length, 3); assert.equal(new Set(lines).size, 1)
  assert.equal(build(captured, [1, 2, 3, 4, 5].map(number => approve(captured, id(number)))).toReport().examples.length, 5)
})

test('deselected prompts, labels, replies and configuration never appear in either export', () => {
  const source = report([input(1), input(2, { label: 'UNSELECTED_LABEL', user_prompt: 'UNSELECTED_USER', system_prompt: 'UNSELECTED_SYSTEM', expected_text: 'UNSELECTED_EXPECTATION' })])
  setReply(source, 'UNSELECTED_REPLY', 1)
  source.cases[1].snapshot.run.configuration.model = 'UNSELECTED_MODEL'
  const captured = capture(source), bundle = build(captured, [approve(captured)]), output = exported(bundle)
  for (const value of [output.jsonl_text, output.review_json_text, JSON.stringify(bundle.toReport())]) assert.doesNotMatch(value, /UNSELECTED_/)
  assert.equal(bundle.toReport().source_summary.total_case_count, 2)
  assert.equal(bundle.toReport().examples[0].source_row.snapshot.run.configuration.model, 'local-chat')
  assert.doesNotMatch(output.jsonl_text, /local-chat|request_id|case_id|temperature|label|expected_text|check|<\|/)
})

test('empty system is omitted; whitespace-only system and all accepted prompt/target bytes remain literal', () => {
  const literal = ' \r\n\tÅ A\u030a 🦙 \\" <think>answer</think> <|user|>\u202e\u2028\u200b '
  for (const system of ['', ' \r\n\t', literal]) {
    const source = report([input(1, { system_prompt: system, user_prompt: literal })])
    const captured = capture(source), bundle = build(captured, [approve(captured, id(1), literal)])
    const output = exported(bundle), line = JSON.parse(output.jsonl_text)
    assert.deepEqual(line.messages, [...(system === '' ? [] : [{ role: 'system', content: system }]),
      { role: 'user', content: literal }, { role: 'assistant', content: literal }])
    assert.deepEqual(Object.keys(line), ['messages'])
    assert.ok(output.jsonl_text.endsWith('\n'))
    assert.equal(output.jsonl_text.split('\n').length, 2)
    assert.equal(bundle.toReport().examples[0].source_input.user_prompt, literal)
  }
})

for (const [version, changes, target, expected] of [
  [1, { expected_text: 'Å' }, 'Å', 'matched'],
  [1, { expected_text: 'Å' }, 'A\u030a', 'mismatched'],
  [1, { expected_text: '' }, 'x', 'mismatched'],
  [1, {}, 'Manual', 'not_requested'],
  [2, { check_kind: 'none' }, 'Manual', 'not_requested'],
  [2, { check_kind: 'exact_text', expected_text: 'Hello back' }, 'Hello back', 'matched'],
  [2, { check_kind: 'json_object' }, '{}', 'matched'],
  [2, { check_kind: 'json_object' }, '[]', 'mismatched'],
  [3, { check_kind: 'none', required_fields: null }, 'Manual', 'not_requested'],
  [3, { check_kind: 'exact_text', expected_text: 'Exact', required_fields: null }, 'Exact', 'matched'],
  [3, { check_kind: 'json_object', required_fields: null }, '{"x":1,"x":2}', 'mismatched'],
  [3, { check_kind: 'json_fields', required_fields: [{ name: 'ready', type: 'boolean' }] }, '{"ready":true}', 'matched'],
  [3, { check_kind: 'json_fields', required_fields: [{ name: 'ready', type: 'boolean' }] }, '{"ready":"true"}', 'mismatched'],
]) test(`v${version} ${changes.check_kind ?? 'legacy'} evaluates the approved target independently: ${target}`, () => {
  const source = report([input(1, changes)], version)
  const original = suites.exportPromptSuiteReport(source), captured = capture(suites.parsePromptSuiteReport(original))
  const approval = approve(captured, id(1), target), example = build(captured, [approval]).toReport().examples[0]
  assert.equal(approval.toReport().target_check, expected)
  assert.equal(example.target_check, expected)
  assert.equal(example.source_row.check, source.cases[0].check)
  assert.equal(example.source_input.check_kind, source.definition.cases[0].check_kind)
  assert.equal(suites.exportPromptSuiteReport(captured.toReport()), original)
})

test('captured reply equality is exact and does not imply approval or source-check success', () => {
  for (const [reply, target, equal] of [['Å', 'A\u030a', false], ['x\n', 'x', false], ['Wrong', 'Wrong', true], ['', 'Manual', false]]) {
    const source = report([input(1, { expected_text: 'Expected' })]); setReply(source, reply)
    const captured = capture(source), approval = approve(captured, id(1), target)
    assert.equal(approval.toReport().captured_reply_equal, equal)
    assert.equal(build(captured, [approval]).toReport().examples[0].target_check, 'mismatched')
    assert.throws(() => build(captured, []), invalidBundle)
  }
})

for (const state of ['not_attempted', 'submitting', 'running', 'rejected', 'unknown', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`manual approval is allowed for admitted ${state} source with equality unavailable`, () => {
    const source = report([input(1, { expected_text: 'Manual' })]); setState(source, state)
    const captured = capture(source), approval = approve(captured, id(1), 'Manual'), bundle = build(captured, [approval])
    assert.deepEqual(approval.toReport(), { case_id: id(1), target_text: 'Manual', reviewed_at: reviewedAt,
      target_check: 'matched', captured_reply_equal: null })
    assert.equal(bundle.toReport().examples[0].source_row.status, state)
    assert.equal(bundle.toReport().examples[0].source_row.check, 'not_evaluated')
    assert.equal(JSON.parse(exported(bundle).jsonl_text).messages.at(-1).content, 'Manual')
  })
}

test('source acceptance rejects forged identities, snapshots, checks and unsupported schemas with safe errors', () => {
  for (const mutate of [value => value.schema_version = 4, value => value.kind = 'mirofish_reviewed_prompt_examples',
    value => value.cases[0].case_id = id(2), value => value.cases[0].check = 'matched',
    value => value.cases[0].snapshot.run.request.user_prompt = 'PRIVATE_CONFLICT',
    value => value.definition.cases.push({ ...value.definition.cases[0] }), value => value.private = 'PRIVATE_VALUE']) {
    const source = report(); mutate(source)
    assert.throws(() => capture(source), invalidSource)
  }
  for (const source of [null, '', '{}', [], {}, { toReport: () => report() }]) assert.throws(() => capture(source), invalidSource)
  assert.throws(() => capture({ get schema_version() { throw new Error('PRIVATE_THROW') } }), invalidSource)
})

test('approvals belong to the exact source capture, including separately captured identical reports', () => {
  const source = report(), first = capture(source), second = capture(source), approval = approve(first)
  const changed = report(); setReply(changed, 'Changed')
  for (const other of [second, capture(changed), capture(first.toReport())]) {
    assert.throws(() => build(other, [approval]), invalidBundle)
  }
  assert.throws(() => approve(first, id(99)), invalidApproval)
  assert.throws(() => approve(first, new String(id(1))), invalidApproval)
  assert.throws(() => build(first, [approval, approval]), invalidBundle)
  assert.throws(() => build(first, [approval, approve(first)]), invalidBundle)
  for (const forged of [{}, first.toReport(), { ...first }, Object.create(first), new Proxy(first, {})]) {
    assert.throws(() => approve(forged), invalidApproval)
    assert.throws(() => build(forged, [approval]), invalidBundle)
  }
  for (const forged of [{}, approval.toReport(), { ...approval }, Object.create(approval), new Proxy(approval, {})]) {
    assert.throws(() => build(first, [forged]), invalidBundle)
  }
  const bundle = build(first, [approval])
  for (const forged of [{}, bundle.toReport(), { ...bundle }, Object.create(bundle), new Proxy(bundle, {}), null]) {
    assert.throws(() => exported(forged), invalidExport)
  }
})

test('empty, oversized, sparse and non-array approval selections are rejected without deduplication', () => {
  const captured = capture(report()), approval = approve(captured)
  for (const selection of [[], [approval, approval, approval, approval, approval, approval], new Array(1),
    [approval, undefined], null, {}, new Set([approval]), { 0: approval, length: 1 }]) {
    assert.throws(() => build(captured, selection), invalidBundle)
  }
})

test('approval arrays cannot use custom iterators to omit, inject or duplicate selections', () => {
  const captured = capture(report([input(1), input(2)])), first = approve(captured), second = approve(captured, id(2))
  const omitted = [first]
  omitted[Symbol.iterator] = function* () {}
  assert.equal(build(captured, omitted).toReport().examples.length, 1)
  const injected = [first]
  injected[Symbol.iterator] = function* () { yield first; yield second }
  assert.deepEqual(build(captured, injected).toReport().examples.map(item => item.case_id), [id(1)])
  const hiddenDuplicate = [first, first]
  hiddenDuplicate[Symbol.iterator] = function* () { yield first }
  assert.throws(() => build(captured, hiddenDuplicate), invalidBundle)
})

test('approved target bounds count Unicode codepoints and UTF-8 bytes inclusively', () => {
  const captured = capture(report())
  for (const target of ['a'.repeat(16384), '🦙'.repeat(16384)]) {
    const approval = approve(captured, id(1), target)
    assert.equal(approval.toReport().target_text, target)
    assert.equal(JSON.parse(exported(build(captured, [approval])).jsonl_text).messages.at(-1).content, target)
  }
  for (const target of ['a'.repeat(16385), '🦙'.repeat(16385), 'a'.repeat(65537)]) assert.throws(() => approve(captured, id(1), target), invalidApproval)
})

test('blank, nonstring, Cc and unpaired-surrogate targets are rejected while CR/LF/tab survive', () => {
  const captured = capture(report())
  for (const target of ['', ' \r\n\t', '\ufeff', null, 1, {}, ['target'], new String('target'),
    'a\u0000b', 'a\u000bb', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\ud800b', 'a\udfffb']) {
    assert.throws(() => approve(captured, id(1), target), invalidApproval)
  }
  assert.equal(approve(captured, id(1), '\r\n\tTarget\r\n\t').toReport().target_text, '\r\n\tTarget\r\n\t')
  const controlReply = report(); setReply(controlReply, 'Historical\u0000reply')
  const historical = capture(controlReply)
  assert.throws(() => approve(historical, id(1), 'Historical\u0000reply'), invalidApproval)
  assert.equal(build(historical, [approve(historical)]).toReport().examples[0].source_row.snapshot.run.response.content, 'Historical\u0000reply')
})

test('review/build timestamps use valid UTC calendar strings with safe defaults and errors', () => {
  const captured = capture(report()), approval = approve(captured)
  for (const value of [null, '', 'PRIVATE_INVALID', 0, '2026-02-30T01:00:00Z', '2026-10-04', '2026-10-04T01:00:00+05:00', '2026-10-04T24:00:00Z']) {
    assert.throws(() => examples.approvePromptExampleTarget(captured, id(1), 'Target', { reviewedAt: value }), invalidApproval)
    assert.throws(() => examples.buildPromptExamples(captured, [approval], { capturedAt: value }), invalidBundle)
  }
  for (const value of ['2026-10-04T01:00:00+00:00', '2026-10-04T01:00:00.123456Z']) {
    assert.equal(examples.approvePromptExampleTarget(captured, id(1), 'Target', { reviewedAt: value }).toReport().reviewed_at, value)
    assert.equal(examples.buildPromptExamples(captured, [approval], { capturedAt: value }).toReport().captured_at, value)
  }
  assert.match(examples.approvePromptExampleTarget(captured, id(1), 'Target').toReport().reviewed_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(examples.buildPromptExamples(captured, [approval]).toReport().captured_at, /^\d{4}-\d{2}-\d{2}T/)
  for (const options of [null, { get reviewedAt() { throw new Error('PRIVATE') } }]) {
    assert.throws(() => examples.approvePromptExampleTarget(captured, id(1), 'Target', options), invalidApproval)
  }
  for (const options of [null, { get capturedAt() { throw new Error('PRIVATE') } }]) {
    assert.throws(() => examples.buildPromptExamples(captured, [approval], options), invalidBundle)
  }
})

test('input edits and every returned-object edit cannot change capture, approval, bundle or later downloads', () => {
  const source = report([input(1, { check_kind: 'json_fields', required_fields: [{ name: 'ready', type: 'boolean' }] })], 3)
  const captured = capture(source), approval = approve(captured, id(1), '{"ready":true}'), selection = [approval]
  const bundle = build(captured, selection), original = exported(bundle), originalApproval = approval.toReport()
  source.definition.cases[0].user_prompt = 'STALE'; source.definition.cases[0].required_fields[0].type = 'string'
  source.cases[0].snapshot.run.response.content = 'STALE'; selection.splice(0)
  const approvalCopy = approval.toReport(); approvalCopy.target_text = 'STALE'; approvalCopy.target_check = 'mismatched'
  const result = bundle.toReport()
  result.examples[0].messages[0].content = 'STALE'
  result.examples[0].source_input.required_fields[0].name = 'STALE'
  result.examples[0].source_row.snapshot.run.configuration.model = 'STALE'
  result.source_summary.suite_name = 'STALE'; result.notes.push('STALE')
  const beforeMutationApproval = approve(captured, id(1), '{"ready":true}')
  assert.equal(beforeMutationApproval.toReport().target_check, 'matched')
  assert.deepEqual(approval.toReport(), originalApproval)
  assert.deepEqual(exported(bundle), original)
  assert.deepEqual(exported(build(captured, [approval])), original)
  for (const factory of [captured, approval, bundle]) assert.throws(() => { factory.toReport = () => ({}) }, TypeError)
  assert.throws(() => { original.jsonl_text = 'STALE' }, TypeError)
})

test('large admitted source and target fields export completely without truncation', () => {
  const inputs = [1, 2, 3, 4, 5].map(number => input(number, { system_prompt: '🦙'.repeat(1000), user_prompt: '🦙'.repeat(4000) }))
  const source = report(inputs)
  source.cases.forEach((row, index) => setReply(source, '🦙'.repeat(16384), index))
  const captured = capture(suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(source)))
  const bundle = build(captured, inputs.map(item => approve(captured, item.case_id, '🦙'.repeat(16384))))
  const output = exported(bundle), lines = output.jsonl_text.trimEnd().split('\n').map(JSON.parse)
  assert.equal(lines.length, 5)
  for (const line of lines) assert.equal(line.messages.at(-1).content, '🦙'.repeat(16384))
  assert.ok(new TextEncoder().encode(output.jsonl_text).length <= 1024 * 1024)
  assert.ok(new TextEncoder().encode(output.review_json_text).length <= 4 * 1024 * 1024)
  assert.deepEqual(JSON.parse(output.review_json_text), bundle.toReport())
})

test('both export byte limits accept the exact cap, refuse overflow and preserve retryable bundles', () => {
  // Current field limits cannot naturally fill the export caps. Instrument only
  // TextEncoder's measured length; exercise the actual serializers and guards.
  let measuredSize = null, measuredKind = 'jsonl'
  const source = readFileSync(new URL('../src/utils/promptExamples.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export (const|function) /g, '$1 ')
  const module = vm.runInNewContext(source + '\n;({capturePromptExampleSource, approvePromptExampleTarget, buildPromptExamples, exportPromptExamples})', {
    acceptPromptSuiteReport: suites.acceptPromptSuiteReport, getPromptSuiteCheck: suites.getPromptSuiteCheck,
    evaluatePromptSuiteCheck: suites.evaluatePromptSuiteCheck,
    TextEncoder: class { encode(value) {
      const matches = measuredKind === 'jsonl' ? value.startsWith('{"messages":') : value.startsWith('{\n  "schema_version":')
      return measuredSize !== null && matches ? { length: measuredSize } : new TextEncoder().encode(value)
    } },
  })
  const captured = module.capturePromptExampleSource(report())
  const approval = module.approvePromptExampleTarget(captured, id(1), 'Target', { reviewedAt })
  const bundle = module.buildPromptExamples(captured, [approval], { capturedAt }), expected = JSON.stringify(bundle.toReport())
  for (const [kind, cap] of [['jsonl', 1024 * 1024], ['review', 4 * 1024 * 1024]]) {
    measuredKind = kind; measuredSize = cap
    assert.equal(JSON.stringify(JSON.parse(module.exportPromptExamples(bundle).review_json_text)), expected)
    measuredSize++
    assert.throws(() => module.exportPromptExamples(bundle), invalidExport)
    assert.equal(JSON.stringify(bundle.toReport()), expected)
  }
  measuredSize = null
  assert.equal(JSON.stringify(JSON.parse(module.exportPromptExamples(bundle).review_json_text)), expected)
})

test('oversized UTF-16 target input is rejected before allocating codepoint arrays', () => {
  let codepointCopies = 0
  const source = readFileSync(new URL('../src/utils/promptExamples.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export (const|function) /g, '$1 ')
  const module = vm.runInNewContext(source + '\n;({capturePromptExampleSource, approvePromptExampleTarget})', {
    acceptPromptSuiteReport: suites.acceptPromptSuiteReport, getPromptSuiteCheck: suites.getPromptSuiteCheck,
    evaluatePromptSuiteCheck: suites.evaluatePromptSuiteCheck, TextEncoder,
    Array: class extends Array { static from(...args) { codepointCopies++; return Array.from(...args) } },
  })
  const captured = module.capturePromptExampleSource(report())
  for (const target of ['a'.repeat(32769), ' '.repeat(1024 * 1024) + 'x', '🦙'.repeat(16385)]) {
    assert.throws(() => module.approvePromptExampleTarget(captured, id(1), target, { reviewedAt }), invalidApproval)
  }
  assert.equal(codepointCopies, 0)
  assert.equal(module.approvePromptExampleTarget(captured, id(1), '🦙'.repeat(16384), { reviewedAt }).toReport().target_text, '🦙'.repeat(16384))
  assert.equal(codepointCopies, 1)
})
