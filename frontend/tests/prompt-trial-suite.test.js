import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'
import { buildPromptSuiteFromTrials } from '../src/utils/promptTrialSuite.js'
import { exportPromptSuiteDefinition, parsePromptSuiteDefinition, PROMPT_SUITE_MAX_BYTES } from '../src/utils/promptSuites.js'
import { trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const requestId = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const caseId = index => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
const invalidMessage = 'Invalid prompt trial suite'
const byteLength = value => new TextEncoder().encode(value).length
function terminal(state = 'succeeded', index = 1) {
  const source = trialSnapshot(state)
  source.run.request_id = requestId(index)
  if (state === 'truncated') source.run.response.finish_reason = 'length'
  if (state === 'refused') {
    source.run.response.content = null
    source.run.response.refusal = 'Cannot answer'
    source.run.response.finish_reason = 'content_filter'
  }
  if (['failed', 'timed_out', 'cancelled'].includes(state)) {
    source.run.response = null
    source.run.error_code = { failed: 'model_unavailable', timed_out: 'request_timeout', cancelled: 'backend_closing' }[state]
  }
  return source
}
const draft = (length = 1) => ({ name: 'Captured trials', snapshots: Array.from({ length }, (_, index) => terminal('succeeded', index + 1)),
  caseIds: Array.from({ length }, (_, index) => caseId(index + 1)) })
const expectedDefinition = ({ name, snapshots, caseIds }) => ({ schema_version: 1, kind: 'mirofish_local_prompt_suite', name,
  cases: snapshots.map((snapshot, index) => ({ case_id: caseIds[index], label: snapshot.run.request.label,
    system_prompt: snapshot.run.request.system_prompt, user_prompt: snapshot.run.request.user_prompt,
    temperature: snapshot.run.request.temperature, max_output_tokens: snapshot.run.request.max_output_tokens, expected_text: null })) })
function rejects(source) {
  let output = null
  assert.throws(() => { output = buildPromptSuiteFromTrials(source) }, error => {
    assert.equal(error.constructor, Error)
    assert.equal(error.message, invalidMessage)
    assert.deepEqual(Object.keys(error), [])
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(output, null)
}
function assertFrozen(value) {
  if (value === null || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value))
  Object.values(value).forEach(assertFrozen)
}

for (const state of ['succeeded', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`builds a v1 definition from the exact inputs of a ${state} local trial`, () => {
    const source = draft()
    source.snapshots = [terminal(state)]
    const result = buildPromptSuiteFromTrials(source)
    assert.deepEqual(result.definition, expectedDefinition(source))
    assert.equal(result.json_text, exportPromptSuiteDefinition(result.definition))
    assert.deepEqual(parsePromptSuiteDefinition(result.json_text), result.definition)
    assert.deepEqual(Object.keys(result), ['definition', 'json_text'])
    assert.equal(result.definition.cases[0].expected_text, null)
  })
}

for (const [available, cap] of [[false, null], [false, 16], [true, 16], [true, 512]]) {
  test(`historical availability ${available} and cap ${cap} do not alter reusable inputs`, () => {
    const source = draft(), snapshot = source.snapshots[0]
    snapshot.available = available
    snapshot.unavailable_code = available ? null : 'invalid_configuration'
    snapshot.limits.max_output_tokens = cap
    const result = buildPromptSuiteFromTrials(source)
    assert.deepEqual(result.definition, expectedDefinition(source))
    assert.equal(result.definition.cases[0].max_output_tokens, 128)
  })
}

test('terminal cleanup failures remain reusable when the backend is unavailable', () => {
  const source = draft(), snapshot = terminal('failed')
  snapshot.available = false; snapshot.unavailable_code = 'cleanup_failed'; snapshot.limits.max_output_tokens = null
  snapshot.run.error_code = 'cleanup_failed'; snapshot.run.cleanup.state = 'failed'
  source.snapshots = [snapshot]
  assert.deepEqual(buildPromptSuiteFromTrials(source).definition, expectedDefinition(source))
})

test('five selected trials preserve displayed order across differing models and outcomes', () => {
  const source = draft(5), states = ['cancelled', 'succeeded', 'refused', 'truncated', 'timed_out']
  source.snapshots = states.map((state, index) => {
    const snapshot = terminal(state, 5 - index)
    snapshot.run.request.label = `Trial ${5 - index}`
    snapshot.run.request.user_prompt = `Exact prompt ${index}`
    snapshot.run.configuration = { model: `local-model-${index}`, reasoning_effort: index % 2 ? 'high' : null }
    return snapshot
  })
  const result = buildPromptSuiteFromTrials(source)
  assert.deepEqual(result.definition, expectedDefinition(source))
  assert.deepEqual(result.definition.cases.map(item => item.label), ['Trial 5', 'Trial 4', 'Trial 3', 'Trial 2', 'Trial 1'])
})

test('copies only admitted input fields and never source identities, results, or configuration', () => {
  const source = draft(), snapshot = source.snapshots[0]
  snapshot.run.configuration = { model: 'PRIVATE_MODEL', reasoning_effort: 'PRIVATE_EFFORT' }
  snapshot.run.response.content = 'PRIVATE_REPLY'; snapshot.run.fingerprint = 'b'.repeat(64)
  for (const object of [snapshot, snapshot.limits, snapshot.run, snapshot.run.request, snapshot.run.configuration,
    snapshot.run.response, snapshot.run.response.usage, snapshot.run.cleanup]) {
    object.endpoint = 'PRIVATE_ENDPOINT'; object.raw_error = { text: 'PRIVATE_ERROR' }
    Object.defineProperty(object, '__proto__', { value: { polluted: true }, enumerable: true })
  }
  snapshot.run.request.case_id = 'PRIVATE_CASE'; snapshot.run.request.expected_text = 'PRIVATE_EXPECTATION'
  const result = buildPromptSuiteFromTrials(source)
  assert.deepEqual(result.definition, expectedDefinition(source))
  assert.doesNotMatch(result.json_text, /PRIVATE_|request_id|fingerprint|response|configuration|state|usage|cleanup|__proto__/)
  assert.ok(!result.json_text.includes(snapshot.run.request_id))
  assert.equal({}.polluted, undefined)
})

test('fresh deeply frozen output never freezes or mutates its source and keeps repeated JSON exact', () => {
  const source = draft(2), original = structuredClone(source)
  const first = buildPromptSuiteFromTrials(source), second = buildPromptSuiteFromTrials(source)
  assert.deepEqual(source, original); assert.equal(Object.isFrozen(source.snapshots[0].run.request), false)
  assertFrozen(first); assertFrozen(second)
  assert.notEqual(first, second); assert.notEqual(first.definition, second.definition)
  assert.notEqual(first.definition.cases, second.definition.cases)
  first.definition.cases.forEach((item, index) => {
    assert.notEqual(item, second.definition.cases[index])
    assert.notEqual(item, source.snapshots[index].run.request)
  })
  assert.equal(first.json_text, second.json_text)
  assert.throws(() => { first.definition.cases[0].user_prompt = 'changed' }, TypeError)
  assert.throws(() => first.definition.cases.push({}), TypeError)
  source.snapshots[0].run.request.user_prompt = 'changed'
  source.caseIds[0] = caseId(9); source.name = 'changed'
  assert.deepEqual(first.definition, expectedDefinition(original))
  assert.equal(first.json_text, exportPromptSuiteDefinition(first.definition))
})

test('accepts deeply frozen admitted snapshots without modifying them', () => {
  const source = draft()
  source.snapshots[0] = acceptPromptTrialSnapshot({ success: true, data: source.snapshots[0] })
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
    return value
  }
  freeze(source)
  assert.deepEqual(buildPromptSuiteFromTrials(source).definition, expectedDefinition(source))
})

test('literal Unicode, markup, whitespace, and exact numerical settings survive existing suite import', () => {
  const source = draft(2)
  source.name = '  Å A\u030a 🦙 <suite>  '
  Object.assign(source.snapshots[0].run.request, { label: '  Å A\u030a 🦙 <trial>  ', system_prompt: '\r\n\t  <system>\u202e🦙 A\u030a </system>  ',
    user_prompt: '  \t\r\n<script>literal</script> 🦙 Å A\u030a\u200b  ', temperature: 0, max_output_tokens: 1 })
  Object.assign(source.snapshots[1].run.request, { label: 'boundary', system_prompt: '', user_prompt: 'exact', temperature: 1, max_output_tokens: 512 })
  const result = buildPromptSuiteFromTrials(source)
  assert.deepEqual(result.definition, expectedDefinition(source))
  assert.deepEqual(parsePromptSuiteDefinition(result.json_text), expectedDefinition(source))
  assert.equal(result.json_text, JSON.stringify(expectedDefinition(source), null, 2))
})

test('maximal admitted Unicode names and inputs remain exact within the suite byte budget', () => {
  const source = draft(5)
  source.name = '🦙'.repeat(80)
  for (const snapshot of source.snapshots) Object.assign(snapshot.run.request, {
    label: '🦙'.repeat(80), system_prompt: '🦙'.repeat(1000), user_prompt: '🦙'.repeat(4000), temperature: 1, max_output_tokens: 512,
  })
  const result = buildPromptSuiteFromTrials(source)
  assert.deepEqual(result.definition, expectedDefinition(source))
  assert.deepEqual(parsePromptSuiteDefinition(result.json_text), result.definition)
  assert.ok(byteLength(result.json_text) < PROMPT_SUITE_MAX_BYTES)
  assert.ok(byteLength(result.json_text) > byteLength(JSON.stringify(result.definition)))
})

for (const source of [undefined, null, [], 'PRIVATE', 1, true]) {
  test(`rejects invalid builder arguments ${Object.prototype.toString.call(source)} with a static error`, () => rejects(source))
}

for (const [name, mutate] of [
  ['missing selection', source => delete source.snapshots], ['null selection', source => source.snapshots = null],
  ['object selection', source => source.snapshots = { 0: source.snapshots[0], length: 1 }],
  ['empty selection', source => { source.snapshots = []; source.caseIds = [] }],
  ['six trials', source => Object.assign(source, draft(6))],
  ['sparse selection', source => source.snapshots = new Array(1)],
  ['same source twice', source => { source.snapshots.push(source.snapshots[0]); source.caseIds.push(caseId(2)) }],
  ['cloned duplicate request ID', source => { source.snapshots.push(structuredClone(source.snapshots[0])); source.caseIds.push(caseId(2)) }],
  ['missing case IDs', source => delete source.caseIds], ['null case IDs', source => source.caseIds = null],
  ['object case IDs', source => source.caseIds = { 0: caseId(1), length: 1 }],
  ['too few case IDs', source => source.caseIds = []], ['too many case IDs', source => source.caseIds.push(caseId(2))],
  ['sparse case IDs', source => source.caseIds = new Array(1)],
  ['repeated case ID', source => { Object.assign(source, draft(2)); source.caseIds[1] = source.caseIds[0] }],
  ['own source request ID reused', source => source.caseIds[0] = source.snapshots[0].run.request_id],
  ['other source request ID reused', source => { Object.assign(source, draft(2)); source.caseIds[0] = source.snapshots[1].run.request_id }],
  ['invalid case ID', source => source.caseIds[0] = 'PRIVATE'],
  ['uppercase case ID', source => source.caseIds[0] = 'ABCDEFAB-1234-4234-9234-123456789abc'],
  ['boxed case ID', source => source.caseIds[0] = new String(caseId(1))],
]) test(`rejects ${name} atomically`, () => {
  const source = draft(); mutate(source); const before = structuredClone(source)
  rejects(source); assert.deepEqual(source, before)
})

for (const [name, value] of [
  ['missing', undefined], ['null', null], ['empty', ''], ['blank', '  '], ['newline', 'a\n'], ['tab', 'a\t'],
  ['format control', 'a\u202e'], ['NUL', 'a\0'], ['surrogate', '\ud800'], ['81 code points', '🦙'.repeat(81)],
  ['object', {}], ['number', 1], ['boxed string', new String('Suite')],
]) test(`rejects ${name} suite name using existing definition rules`, () => {
  const source = draft(); source.name = value; rejects(source)
})

for (const [name, snapshot] of [
  ['null', null], ['array', []], ['string', 'PRIVATE'], ['number', 1], ['boolean', true],
  ['API envelope', { success: true, data: terminal() }], ['idle', trialSnapshot()], ['running', trialSnapshot('running')],
  ['cloud', trialSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required',
    limits: { ...trialSnapshot().limits, max_output_tokens: null } })],
]) test(`rejects ${name} snapshot`, () => {
  const source = draft(); source.snapshots[0] = snapshot; rejects(source)
})

for (const [name, mutate] of [
  ['wrong version', snapshot => snapshot.schema_version = 2], ['unknown kind', snapshot => snapshot.kind = 'PRIVATE'],
  ['missing run', snapshot => delete snapshot.run], ['inconsistent availability', snapshot => snapshot.available = false],
  ['zero runtime cap', snapshot => snapshot.limits.max_output_tokens = 0], ['changed fixed limit', snapshot => snapshot.limits.response_bytes++],
  ['invalid source ID', snapshot => snapshot.run.request_id = 'PRIVATE'], ['invalid fingerprint', snapshot => snapshot.run.fingerprint = 'PRIVATE'],
  ['unknown state', snapshot => snapshot.run.state = 'PRIVATE'], ['missing finished time', snapshot => snapshot.run.finished_at = null],
  ['negative duration', snapshot => snapshot.run.elapsed_ms = -1], ['nonterminal cleanup', snapshot => snapshot.run.cleanup.state = 'pending'],
  ['inconsistent success error', snapshot => snapshot.run.error_code = 'cleanup_failed'],
  ['invalid model', snapshot => snapshot.run.configuration.model = 'http://PRIVATE'],
  ['missing response', snapshot => snapshot.run.response = null], ['mismatched finish', snapshot => snapshot.run.response.finish_reason = 'length'],
  ['negative usage', snapshot => snapshot.run.response.usage.total_tokens = -1],
  ['oversized reply', snapshot => snapshot.run.response.content = 'x'.repeat(16385)],
]) test(`reuses full snapshot admission for ${name}`, () => {
  const source = draft(); mutate(source.snapshots[0])
  assert.throws(() => acceptPromptTrialSnapshot({ success: true, data: source.snapshots[0] }))
  rejects(source)
})

for (const [name, field, value] of [
  ['blank label', 'label', ' '], ['label overflow', 'label', '🦙'.repeat(81)], ['label control', 'label', 'a\n'],
  ['system overflow', 'system_prompt', '🦙'.repeat(1001)], ['system NUL', 'system_prompt', '\0'],
  ['blank user prompt', 'user_prompt', '\t\r\n '], ['user overflow', 'user_prompt', '🦙'.repeat(4001)],
  ['user NUL', 'user_prompt', '\0'], ['user surrogate', 'user_prompt', '\udfff'],
  ['string temperature', 'temperature', '0.2'], ['negative temperature', 'temperature', -0.01], ['high temperature', 'temperature', 1.01],
  ['nonfinite temperature', 'temperature', Infinity], ['NaN temperature', 'temperature', NaN],
  ['zero cap', 'max_output_tokens', 0], ['cap overflow', 'max_output_tokens', 513],
  ['fractional cap', 'max_output_tokens', 1.5], ['string cap', 'max_output_tokens', '128'],
]) test(`rejects ${name} without weakening admitted input boundaries`, () => {
  const source = draft(); source.snapshots[0].run.request[field] = value; rejects(source)
})

for (const invalidIndex of [0, 2, 4]) test(`an invalid snapshot at position ${invalidIndex + 1} prevents any partial result`, () => {
  const source = draft(5), before = structuredClone(source)
  source.snapshots[invalidIndex].run.request.user_prompt = ''
  rejects(source)
  source.snapshots[invalidIndex].run.request.user_prompt = before.snapshots[invalidIndex].run.request.user_prompt
  assert.deepEqual(source, before)
})

test('valid caller-supplied fresh case identities are stable per capture and replaceable on rebuild', () => {
  const source = draft(2), first = buildPromptSuiteFromTrials(source)
  source.caseIds = [caseId(3), caseId(4)]
  const rebuilt = buildPromptSuiteFromTrials(source)
  assert.deepEqual(first.definition.cases.map(item => item.case_id), [caseId(1), caseId(2)])
  assert.deepEqual(rebuilt.definition.cases.map(item => item.case_id), [caseId(3), caseId(4)])
  assert.notEqual(first.json_text, rebuilt.json_text)
})
