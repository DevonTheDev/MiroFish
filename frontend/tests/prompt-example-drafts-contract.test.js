import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as examples from '../src/utils/promptExamples.js'
import * as suites from '../src/utils/promptSuites.js'
import { parseBoundedJson } from '../src/utils/boundedJson.js'
import { trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const capturedAt = '2026-10-04T01:00:01.123456Z'
const invalidDraft = /^Error: Invalid prompt examples draft$/
const invalidExport = /^Error: Invalid prompt examples draft export$/
const maxBytes = 4 * 1024 * 1024
function report(count = 1, version = 1) {
  const inputs = Array.from({ length: count }, (_, index) => ({ case_id: id(index + 1), ...trialRequest(),
    ...(version >= 2 ? { check_kind: 'none' } : {}), expected_text: null,
    ...(version === 3 ? { required_fields: null } : {}) }))
  return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(90),
    definition: { schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Curation drafts', cases: inputs },
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed',
    stop_requested: false, halt_code: null, cases: inputs.map((item, index) => {
      const snapshot = trialSnapshot('succeeded')
      snapshot.run.request_id = id(100 + index)
      snapshot.run.request = Object.fromEntries(['label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens'].map(key => [key, item[key]]))
      return { case_id: item.case_id, request_id: snapshot.run.request_id, status: 'succeeded',
        check: suites.evaluatePromptSuiteCheck(item, 'succeeded', snapshot.run.response.content), snapshot, error_code: null }
    }) }
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
const targets = (source, values = []) => source.definition.cases.map((item, index) => ({ case_id: item.case_id, target_text: values[index] ?? '' }))
const rawDraft = (source = report(), values = []) => ({ schema_version: 1, kind: 'mirofish_prompt_example_draft',
  captured_at: capturedAt, source_report: source, targets: targets(source, values) })
const captureSource = source => examples.capturePromptExampleSource(source)
const captureDraft = (source, rows) => examples.capturePromptExampleDraft(source, rows, { capturedAt })
const parseDraft = value => examples.parsePromptExampleDraft(typeof value === 'string' ? value : JSON.stringify(value))
const exportDraft = value => examples.exportPromptExampleDraft(value)

// Evaluate real production code in a separate realm only to observe allocation
// guards and exercise otherwise unreachable export-size boundaries.
function instrument(overrides = {}) {
  const source = readFileSync(new URL('../src/utils/promptExamples.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export (const|function) /g, '$1 ')
  return vm.runInNewContext(source + '\n;({capturePromptExampleSource, capturePromptExampleDraft, parsePromptExampleDraft, exportPromptExampleDraft})', {
    acceptPromptSuiteReport: suites.acceptPromptSuiteReport, parsePromptSuiteReport: suites.parsePromptSuiteReport,
    getPromptSuiteCheck: suites.getPromptSuiteCheck, evaluatePromptSuiteCheck: suites.evaluatePromptSuiteCheck,
    parseBoundedJson, TextEncoder, ...overrides,
  })
}

test('draft API exposes three factories and the independent 4 MiB bound', () => {
  for (const name of ['capturePromptExampleDraft', 'parsePromptExampleDraft', 'exportPromptExampleDraft']) {
    assert.equal(typeof examples[name], 'function', `${name} must be implemented`)
  }
  assert.equal(examples.PROMPT_EXAMPLES_DRAFT_MAX_BYTES, maxBytes)
})

for (let count = 1; count <= 5; count++) test(`draft round trip retains all ${count} ordered cases, including empty and unapproved targets`, () => {
  const source = report(count), values = ['', ' \r\n\t', 'UNAPPROVED', '{"incomplete":', 'target']
  const sourceCapture = captureSource(source), rows = targets(source, values), handle = captureDraft(sourceCapture, rows)
  const expected = rawDraft(suites.acceptPromptSuiteReport(source), values)
  assert.ok(Object.isFrozen(handle))
  assert.deepEqual(Object.keys(handle), ['toReport'])
  assert.deepEqual(handle.toReport(), expected)
  const output = exportDraft(handle)
  assert.ok(Object.isFrozen(output))
  assert.deepEqual(Object.keys(output), ['draft_json_text', 'captured_at'])
  assert.equal(output.captured_at, capturedAt)
  assert.equal(output.draft_json_text, JSON.stringify(expected, null, 2))
  assert.deepEqual(parseDraft(output.draft_json_text).toReport(), expected)
  assert.deepEqual(exportDraft(parseDraft(output.draft_json_text)), output)
  assert.deepEqual(sourceCapture.toReport(), source)
})

for (const version of [1, 2, 3]) test(`v${version} source definition and full historical metadata remain unchanged`, () => {
  const source = report(3, version)
  source.definition.cases[1].expected_text = 'Different'
  if (version >= 2) source.definition.cases[1].check_kind = 'exact_text'
  source.cases[1].check = 'mismatched'
  if (version === 3) {
    source.definition.cases[2].check_kind = 'json_fields'
    source.definition.cases[2].required_fields = [{ name: 'ready', type: 'boolean' }]
    source.cases[2].check = 'mismatched'
  }
  const original = suites.exportPromptSuiteReport(source)
  const admitted = suites.parsePromptSuiteReport(original)
  const handle = captureDraft(captureSource(admitted), targets(admitted, ['', '{', ' \t']))
  const restored = parseDraft(exportDraft(handle).draft_json_text).toReport()
  assert.equal(suites.exportPromptSuiteReport(restored.source_report), original)
  assert.deepEqual(restored.source_report, admitted)
  assert.equal(restored.targets[1].target_text, '{')
})

for (const state of ['not_attempted', 'submitting', 'running', 'rejected', 'unknown', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`draft round trip keeps admitted ${state} source state`, () => {
    const source = report(); setState(source, state)
    const original = suites.exportPromptSuiteReport(source)
    const handle = captureDraft(captureSource(source), targets(source))
    const restored = parseDraft(exportDraft(handle).draft_json_text).toReport()
    assert.equal(suites.exportPromptSuiteReport(restored.source_report), original)
    assert.deepEqual(restored.targets, targets(source))
  })
}

test('suite running, stopped and halted metadata remains distinct', () => {
  for (const state of ['running', 'stopped', 'halted']) {
    const source = report(); setState(source, 'not_attempted')
    source.status = state
    source.halt_code = state === 'halted' ? 'observation_limit' : null
    source.stop_requested = state === 'stopped'
    source.finished_at = state === 'running' ? null : source.finished_at
    assert.deepEqual(parseDraft(rawDraft(source)).toReport().source_report, suites.acceptPromptSuiteReport(source))
  }
})

test('literal Unicode, whitespace and historical reply controls survive without normalization', () => {
  const literal = ' \r\n\tÅ A\u030a 🦙 \\" <think>answer</think> <|user|>\u202e\u2028\u200b\ufeff '
  const source = report()
  for (const key of ['user_prompt', 'system_prompt']) {
    source.definition.cases[0][key] = literal
    source.cases[0].snapshot.run.request[key] = literal
  }
  source.cases[0].snapshot.run.response.content = '\u0000\u000b\u001f\u007f\u0085' + literal
  for (const value of ['', ' \r\n\t', '\ufeff', literal]) {
    const restored = parseDraft(exportDraft(captureDraft(captureSource(source), targets(source, [value]))).draft_json_text).toReport()
    assert.equal(restored.targets[0].target_text, value)
    assert.deepEqual(restored.source_report, source)
  }
})

test('draft target limits include 16,384 codepoints and 64 KiB while blank drafts remain bounded', () => {
  const source = report(), captured = captureSource(source)
  for (const value of ['a'.repeat(16384), ' '.repeat(16384), '🦙'.repeat(16384)]) {
    const rows = targets(source, [value])
    assert.equal(captureDraft(captured, rows).toReport().targets[0].target_text, value)
    assert.equal(parseDraft(rawDraft(source, [value])).toReport().targets[0].target_text, value)
  }
  for (const value of ['a'.repeat(16385), ' '.repeat(16385), '🦙'.repeat(16385), 'a'.repeat(65537)]) {
    assert.throws(() => captureDraft(captured, targets(source, [value])), invalidDraft)
    assert.throws(() => parseDraft(rawDraft(source, [value])), invalidDraft)
  }
})

test('draft targets reject nonstrings, forbidden controls and unpaired surrogates', () => {
  const source = report(), captured = captureSource(source)
  for (const value of [null, 1, {}, ['target'], new String('target'), undefined, true,
    'a\u0000b', 'a\u000bb', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\ud800b', 'a\udfffb']) {
    const rows = [{ case_id: id(1), target_text: value }]
    assert.throws(() => captureDraft(captured, rows), invalidDraft)
    // JSON serializes String objects as strings, so that separate programmatic
    // validation case cannot be represented as the same invalid JSON value.
    if (!(value instanceof String)) assert.throws(() => parseDraft({ ...rawDraft(source), targets: rows }), invalidDraft)
  }
})

test('target arrays must cover every source case exactly once and in source order', () => {
  const source = report(2), captured = captureSource(source), valid = targets(source, ['one', 'two'])
  for (const rows of [[], valid.slice(0, 1), [...valid, { case_id: id(3), target_text: '' }],
    valid.toReversed(), [valid[0], valid[0]], [{ case_id: id(9), target_text: '' }, valid[1]],
    [valid[0], { case_id: 'ABCDEFAB-1234-4234-9234-000000000002', target_text: '' }], new Array(2),
    [valid[0], undefined], null, {}, new Set(valid), { 0: valid[0], 1: valid[1], length: 2 }]) {
    assert.throws(() => captureDraft(captured, rows), invalidDraft)
    assert.throws(() => parseDraft({ ...rawDraft(source), targets: rows }), invalidDraft)
  }
})

test('targets require only exact case_id and target_text fields and never persist approval flags', () => {
  const source = report(), captured = captureSource(source)
  for (const key of ['approved', 'approval', 'reviewed_at', 'target_check', 'selected', '__proto__']) {
    const row = { ...targets(source)[0], [key]: true }
    assert.throws(() => captureDraft(captured, [row]), invalidDraft)
    assert.throws(() => parseDraft({ ...rawDraft(source), targets: [row] }), invalidDraft)
  }
  for (const row of [{ case_id: id(1) }, { target_text: '' }, { ...targets(source)[0], [Symbol('hidden')]: true }]) {
    assert.throws(() => captureDraft(captured, [row]), invalidDraft)
  }
  const inherited = Object.create(targets(source)[0])
  assert.throws(() => captureDraft(captured, [inherited]), invalidDraft)
  assert.throws(() => captureDraft(captured, [{ case_id: id(1), get target_text() { throw new Error('PRIVATE_TARGET') } }]), invalidDraft)
})

test('programmatic arrays use numeric positions and accept arrays from another realm', () => {
  const source = report(2), captured = captureSource(source)
  const rows = targets(source, ['first', 'second'])
  rows[Symbol.iterator] = function* () { throw new Error('PRIVATE_ITERATOR') }
  assert.deepEqual(captureDraft(captured, rows).toReport().targets, targets(source, ['first', 'second']))
  const missing = [rows[0]]
  missing[Symbol.iterator] = function* () { yield rows[0]; yield rows[1] }
  assert.throws(() => captureDraft(captured, missing), invalidDraft)
  const duplicate = [rows[0], rows[0]]
  duplicate[Symbol.iterator] = function* () { yield rows[0]; yield rows[1] }
  assert.throws(() => captureDraft(captured, duplicate), invalidDraft)
  const crossRealm = vm.runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(targets(source, ['first', 'second'])))})`)
  assert.deepEqual(captureDraft(captured, crossRealm).toReport().targets, targets(source, ['first', 'second']))
})

test('capture reads each numeric row once and rejects inherited sparse-array entries', () => {
  const source = report(), captured = captureSource(source)
  let reads = 0
  const rows = []
  Object.defineProperty(rows, 0, { get() {
    reads++
    return reads === 1 ? { case_id: id(1), target_text: 'Captured once' }
      : { case_id: id(1), target_text: 'PRIVATE_REPLACEMENT', approved: true }
  } })
  assert.deepEqual(captureDraft(captured, rows).toReport().targets, targets(source, ['Captured once']))
  assert.equal(reads, 1)
  const inherited = new Array(1)
  Object.setPrototypeOf(inherited, { 0: targets(source)[0] })
  assert.throws(() => captureDraft(captured, inherited), invalidDraft)
})

test('parser requires exact draft schema and rejects selected-review or suite artifacts', () => {
  for (const mutate of [value => value.schema_version = 2, value => value.schema_version = '1',
    value => value.kind = 'mirofish_reviewed_prompt_examples', value => value.extra = 'PRIVATE_EXTRA',
    value => value.approvals = [], value => value.approved = true, value => value.selected = true,
    value => delete value.source_report, value => delete value.targets, value => delete value.captured_at]) {
    const value = rawDraft(); mutate(value)
    assert.throws(() => parseDraft(value), invalidDraft)
  }
  const source = captureSource(report())
  const approval = examples.approvePromptExampleTarget(source, id(1), 'Target')
  const bundle = examples.buildPromptExamples(source, [approval])
  const reviewed = examples.exportPromptExamples(bundle)
  for (const value of [report(), reviewed.review_json_text, reviewed.jsonl_text, null, [], {}, 'null', 'true', '42', '']) {
    assert.throws(() => parseDraft(value), invalidDraft)
  }
  for (const value of [undefined, 1, {}, [], new String(JSON.stringify(rawDraft()))]) {
    assert.throws(() => examples.parsePromptExampleDraft(value), invalidDraft)
  }
})

test('parser rejects duplicate keys and escaped aliases at outer, target and source depths', () => {
  const original = JSON.stringify(rawDraft())
  for (const [from, to] of [
    ['"schema_version":1', '"schema_version":1,"schema_version":1'],
    ['"schema_version":1', '"schema_version":1,"schema_vers\\u0069on":1'],
    ['"target_text":""', '"target_text":"","target_\\u0074ext":""'],
    ['"observed_at":', '"observed_at":"2026-10-04T00:00:00Z","observed_at":'],
    ['"configuration":{', '"configuration":{"extra":1,"\\u0065xtra":2,'],
  ]) assert.throws(() => parseDraft(original.replace(from, to)), invalidDraft)
  for (const text of [original + '{}', original + '\nnull', '\ufeff' + original, original.slice(0, -1) + ',}', '{"x":01}']) {
    assert.throws(() => parseDraft(text), invalidDraft)
  }
})

test('strict parser rejects nonfinite numbers and lone surrogates even in ignored source fields', () => {
  for (const raw of ['1e400', '-1e400', '"\\ud800"', '"\\udfff"', '{"\\ud800":1}']) {
    const text = JSON.stringify(rawDraft()).replace('"configuration":{', `"configuration":{"ignored":${raw},`)
    assert.throws(() => parseDraft(text), invalidDraft)
  }
  assert.throws(() => parseDraft(JSON.stringify(rawDraft()).replace('"target_text":""', '"target_text":"\ud800"')), invalidDraft)
})

test('embedded source is independently readmitted and unknown snapshot fields retain projection rules', () => {
  const source = report()
  source.cases[0].snapshot.secret = 'PRIVATE_ENVELOPE'
  source.cases[0].snapshot.run.configuration.secret = 'PRIVATE_CONFIGURATION'
  const handle = parseDraft(rawDraft(source))
  assert.deepEqual(handle.toReport().source_report, suites.parsePromptSuiteReport(JSON.stringify(source)))
  assert.doesNotMatch(exportDraft(handle).draft_json_text, /PRIVATE_/)
  for (const mutate of [value => value.schema_version = 4, value => value.cases[0].case_id = id(2),
    value => value.cases[0].check = 'matched', value => value.definition.cases[0].case_id = id(2),
    value => value.cases[0].snapshot.run.request.user_prompt = 'PRIVATE_CONFLICT', value => value.private = true]) {
    const badSource = report(); mutate(badSource)
    assert.throws(() => parseDraft(rawDraft(badSource)), invalidDraft)
  }
})

test('embedded source raw ignored fields cannot evade its separate 1 MiB cap', () => {
  const source = report()
  source.cases[0].snapshot.ignored = ''
  const baseBytes = Buffer.byteLength(JSON.stringify(source))
  source.cases[0].snapshot.ignored = 'x'.repeat(suites.PROMPT_SUITE_REPORT_MAX_BYTES - baseBytes)
  assert.equal(Buffer.byteLength(JSON.stringify(source)), suites.PROMPT_SUITE_REPORT_MAX_BYTES)
  const accepted = parseDraft(rawDraft(source))
  assert.equal(accepted.toReport().source_report.cases[0].snapshot.ignored, undefined)
  source.cases[0].snapshot.ignored += 'x'
  assert.ok(Buffer.byteLength(JSON.stringify(rawDraft(source))) < maxBytes)
  assert.throws(() => parseDraft(rawDraft(source)), invalidDraft)
})

test('embedded source raw ignored fields cannot evade its separate depth 12 cap', () => {
  const source = report()
  // snapshot is depth 3 within a source; ignored is depth 4. Eight nested
  // arrays put the scalar at depth 12, nine at 13 (still within outer 14).
  let nested = 'value'
  for (let index = 0; index < 8; index++) nested = [nested]
  source.cases[0].snapshot.ignored = nested
  assert.equal(parseDraft(rawDraft(source)).toReport().source_report.cases[0].snapshot.ignored, undefined)
  source.cases[0].snapshot.ignored = [nested]
  assert.throws(() => parseDraft(rawDraft(source)), invalidDraft)
})

test('outer parser enforces inclusive 4 MiB UTF-8 input with whitespace and multibyte content', () => {
  const text = JSON.stringify(rawDraft(report(), ['🦙']))
  const atLimit = text + ' '.repeat(maxBytes - Buffer.byteLength(text))
  assert.equal(Buffer.byteLength(atLimit), maxBytes)
  assert.equal(parseDraft(atLimit).toReport().targets[0].target_text, '🦙')
  assert.throws(() => parseDraft(atLimit + ' '), invalidDraft)
  const utf16Fits = JSON.stringify(rawDraft(report(), ['🦙'.repeat(16384)]))
  assert.throws(() => parseDraft(utf16Fits + ' '.repeat(maxBytes - utf16Fits.length)), invalidDraft)
})

test('parser rejects oversized strings before encoding and supplies strict depth-14 bounds', () => {
  const calls = [], parserCalls = []
  const module = instrument({ TextEncoder: class { encode(value) { calls.push(value.length); return new TextEncoder().encode(value) } },
    parseBoundedJson(...args) { parserCalls.push(args.slice(1)); return parseBoundedJson(...args) } })
  assert.throws(() => module.parsePromptExampleDraft(' '.repeat(maxBytes + 1)), invalidDraft)
  assert.deepEqual(calls, [])
  assert.deepEqual(parserCalls, [])
  module.parsePromptExampleDraft(JSON.stringify(rawDraft()))
  assert.equal(parserCalls.length, 1)
  assert.equal(parserCalls[0][0], maxBytes)
  assert.equal(parserCalls[0][1], 14)
  assert.equal(parserCalls[0][3], true)
})

test('draft target UTF-16 length gate runs before codepoint copies or target encoding', () => {
  let copies = 0, targetEncodes = 0
  const module = instrument({
    Array: class extends Array { static from(...args) { copies++; return Array.from(...args) } },
    TextEncoder: class { encode(value) { if (!value.startsWith('{')) targetEncodes++; return new TextEncoder().encode(value) } },
  })
  const source = report(), captured = module.capturePromptExampleSource(source)
  for (const value of ['a'.repeat(32769), ' '.repeat(1024 * 1024), '🦙'.repeat(16385)]) {
    assert.throws(() => module.capturePromptExampleDraft(captured, targets(source, [value]), { capturedAt }), invalidDraft)
  }
  assert.equal(copies, 0); assert.equal(targetEncodes, 0)
  assert.equal(module.capturePromptExampleDraft(captured, targets(source, ['🦙'.repeat(16384)]), { capturedAt }).toReport().targets[0].target_text, '🦙'.repeat(16384))
  assert.equal(copies, 1); assert.equal(targetEncodes, 1)
})

test('draft capture and export independently enforce inclusive byte limits and preserve retryable handles', () => {
  let measured = null
  const module = instrument({ TextEncoder: class { encode(value) {
    return measured !== null && value.includes('"kind": "mirofish_prompt_example_draft"')
      ? { length: measured } : new TextEncoder().encode(value)
  } } })
  const source = report(), captured = module.capturePromptExampleSource(source)
  measured = maxBytes
  const handle = module.capturePromptExampleDraft(captured, targets(source), { capturedAt })
  const expected = module.exportPromptExampleDraft(handle)
  measured++
  assert.throws(() => module.capturePromptExampleDraft(captured, targets(source), { capturedAt }), invalidDraft)
  assert.throws(() => module.exportPromptExampleDraft(handle), invalidExport)
  measured = maxBytes
  assert.deepEqual(module.exportPromptExampleDraft(handle), expected)
})

test('draft timestamps use strict valid UTC dates and capture has a safe default', () => {
  const source = report(), captured = captureSource(source), rows = targets(source)
  for (const value of [null, '', 'PRIVATE_INVALID', 0, '2026-02-30T01:00:00Z', '2026-10-04',
    '2026-10-04T01:00:00+05:00', '2026-10-04T24:00:00Z', '2026-10-04T01:00:00.1234567Z',
    '2026-10-04T01:00:00-00:00', '2026-10-04t01:00:00z']) {
    assert.throws(() => examples.capturePromptExampleDraft(captured, rows, { capturedAt: value }), invalidDraft)
    assert.throws(() => parseDraft({ ...rawDraft(source), captured_at: value }), invalidDraft)
  }
  for (const value of ['2026-10-04T01:00:00+00:00', '2026-10-04T01:00:00.123456Z', '2028-02-29T00:00:00Z']) {
    assert.equal(examples.capturePromptExampleDraft(captured, rows, { capturedAt: value }).toReport().captured_at, value)
    assert.equal(parseDraft({ ...rawDraft(source), captured_at: value }).toReport().captured_at, value)
  }
  assert.match(examples.capturePromptExampleDraft(captured, rows).toReport().captured_at, /^\d{4}-\d{2}-\d{2}T/)
  for (const options of [null, { get capturedAt() { throw new Error('PRIVATE_TIME') } }]) {
    assert.throws(() => examples.capturePromptExampleDraft(captured, rows, options), invalidDraft)
  }
})

test('handles and exports are frozen while every reported source and target copy is detached', () => {
  const source = report(2, 3), captured = captureSource(source), rows = targets(source, ['one', 'two'])
  const handle = captureDraft(captured, rows), expected = exportDraft(handle)
  source.definition.cases[0].user_prompt = 'STALE_SOURCE'
  rows[0].target_text = 'STALE_TARGET'; rows.reverse(); rows.push({ case_id: id(3), target_text: '' })
  const first = handle.toReport(), second = handle.toReport()
  assert.notEqual(first, second); assert.notEqual(first.targets[0], second.targets[0])
  assert.notEqual(first.source_report.cases[0].snapshot.run.response, second.source_report.cases[0].snapshot.run.response)
  first.targets[0].case_id = id(99); first.targets[0].target_text = 'STALE_REPORT'
  first.source_report.definition.cases[0].user_prompt = 'STALE_REPORT'
  first.source_report.cases[0].snapshot.run.response.content = 'STALE_REPORT'
  assert.deepEqual(handle.toReport(), second)
  assert.deepEqual(exportDraft(handle), expected)
  const parsed = parseDraft(expected.draft_json_text), parsedCopy = parsed.toReport()
  parsedCopy.targets.splice(0); parsedCopy.source_report.cases.splice(0)
  assert.deepEqual(exportDraft(parsed), expected)
  for (const factory of [handle, parsed]) assert.throws(() => { factory.toReport = () => ({}) }, TypeError)
  assert.throws(() => { expected.draft_json_text = 'STALE' }, TypeError)
})

test('draft capture and export reject forged handles, other factory handles and cross-source rows', () => {
  const source = report(), captured = captureSource(source), rows = targets(source)
  const handle = captureDraft(captured, rows), parsed = parseDraft(exportDraft(handle).draft_json_text)
  const approval = examples.approvePromptExampleTarget(captured, id(1), 'Target')
  const bundle = examples.buildPromptExamples(captured, [approval])
  for (const forged of [{}, source, { ...captured }, Object.create(captured), new Proxy(captured, {}), null, handle, parsed, approval, bundle]) {
    assert.throws(() => captureDraft(forged, rows), invalidDraft)
  }
  for (const forged of [{}, handle.toReport(), { ...handle }, Object.create(handle), new Proxy(handle, {}), null, captured, approval, bundle]) {
    assert.throws(() => exportDraft(forged), invalidExport)
  }
  const other = report(); other.definition.cases[0].case_id = id(2); other.cases[0].case_id = id(2)
  assert.throws(() => captureDraft(captured, targets(other)), invalidDraft)
  assert.throws(() => captureDraft(captureSource(other), rows), invalidDraft)
})

test('restoring drafts never creates approvals and old approvals cannot authorize a restored source', () => {
  const source = report(), captured = captureSource(source)
  const approval = examples.approvePromptExampleTarget(captured, id(1), 'Hello back')
  const before = examples.exportPromptExamples(examples.buildPromptExamples(captured, [approval], { capturedAt }))
  const parsed = parseDraft(exportDraft(captureDraft(captured, targets(source, ['Hello back']))).draft_json_text)
  const restored = captureSource(parsed.toReport().source_report)
  for (const selection of [[], [approval], [parsed], [parsed.toReport().targets[0]]]) {
    assert.throws(() => examples.buildPromptExamples(restored, selection), /Invalid prompt examples bundle/)
  }
  assert.throws(() => examples.exportPromptExamples(parsed), /Invalid prompt examples export/)
  const freshApproval = examples.approvePromptExampleTarget(restored, id(1), parsed.toReport().targets[0].target_text,
    { reviewedAt: approval.toReport().reviewed_at })
  assert.deepEqual(examples.exportPromptExamples(examples.buildPromptExamples(restored, [freshApproval], { capturedAt })), before)
  assert.deepEqual(Object.keys(parsed.toReport()), ['schema_version', 'kind', 'captured_at', 'source_report', 'targets'])
  assert.deepEqual(Object.keys(parsed.toReport().targets[0]), ['case_id', 'target_text'])
})

test('capture, import and export require no network, model calls or target approval evaluation', () => {
  const module = instrument({
    getPromptSuiteCheck() { assert.fail('draft must not inspect target checks') },
    evaluatePromptSuiteCheck() { assert.fail('draft must not approve or evaluate a target') },
    fetch() { assert.fail('draft must not access network') },
    XMLHttpRequest: class { constructor() { assert.fail('draft must not access network') } },
    startPromptTrial() { assert.fail('draft must not invoke a model') },
  })
  const source = report(), captured = module.capturePromptExampleSource(source)
  const handle = module.capturePromptExampleDraft(captured, targets(source, ['{']), { capturedAt })
  const result = module.exportPromptExampleDraft(handle)
  assert.equal(module.parsePromptExampleDraft(result.draft_json_text).toReport().targets[0].target_text, '{')
})

test('v1 draft captures v4 literals and targets without approvals or aliasing', () => {
  const source = report(2, 3); source.schema_version = 4; source.definition.schema_version = 4
  const input = source.definition.cases[0]
  input.check_kind = 'json_fields'; input.required_fields = [{ name: 'ready', type: 'boolean', equals: false }]
  source.cases[0].snapshot.run.response.content = '{"ready":true}'; source.cases[0].check = 'mismatched'
  const captured = captureSource(source), rows = targets(source, ['', '{"ready":false}'])
  const handle = captureDraft(captured, rows), output = exportDraft(handle)
  source.definition.cases[0].required_fields[0].equals = true; rows[1].target_text = 'changed'
  const returned = handle.toReport(); returned.source_report.definition.cases[0].required_fields[0].equals = true
  assert.deepEqual(exportDraft(handle), output)
  const restored = parseDraft(output.draft_json_text).toReport()
  assert.equal(restored.schema_version, 1); assert.equal(restored.source_report.schema_version, 4)
  assert.equal(restored.source_report.definition.cases[0].required_fields[0].equals, false)
  assert.deepEqual(restored.targets.map(row => row.target_text), ['', '{"ready":false}'])
  assert.deepEqual(Object.keys(restored), ['schema_version', 'kind', 'captured_at', 'source_report', 'targets'])
})
