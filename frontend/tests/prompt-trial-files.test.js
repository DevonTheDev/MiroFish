import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptPromptTrialSnapshot, isPromptTrialTerminal } from '../src/api/promptTrials.js'
import { PROMPT_TRIAL_FILE_MAX_BYTES, parsePromptTrialFile } from '../src/utils/promptTrialFiles.js'
import { trialSnapshot, nextRunId } from './helpers/prompt-trials-view-fixture.js'

const singleKind = 'mirofish_local_prompt_trials'
const comparisonKind = 'mirofish_local_prompt_trial_comparison'
const invalidMessage = 'Invalid prompt trial file'
const project = data => acceptPromptTrialSnapshot({ success: true, data })
const parse = data => parsePromptTrialFile(JSON.stringify(data))
function terminal(state = 'succeeded', requestId) {
  const data = trialSnapshot(state)
  if (requestId) data.run.request_id = requestId
  if (state === 'truncated') data.run.response.finish_reason = 'length'
  if (state === 'refused') {
    data.run.response.content = null
    data.run.response.refusal = 'Cannot answer'
    data.run.response.finish_reason = 'content_filter'
  }
  if (['failed', 'timed_out', 'cancelled'].includes(state)) {
    data.run.response = null
    data.run.error_code = { failed: 'model_unavailable', timed_out: 'request_timeout', cancelled: 'backend_closing' }[state]
  }
  return data
}
const comparison = (left = terminal(), right = terminal('truncated', nextRunId)) => ({ schema_version: 1, kind: comparisonKind, trials: [left, right] })
function rejects(source) {
  assert.throws(() => parsePromptTrialFile(source), error => {
    assert.equal(error.constructor, Error)
    assert.equal(error.message, invalidMessage)
    assert.deepEqual(Object.keys(error), [])
    assert.equal(error.cause, undefined)
    return true
  })
}

test('saved trial file admission uses a 512 KiB byte limit', () => {
  assert.equal(PROMPT_TRIAL_FILE_MAX_BYTES, 512 * 1024)
})

for (const state of ['succeeded', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`reopens the existing ${state} single-trial download through real snapshot admission`, () => {
    const saved = project(terminal(state))
    assert.equal(isPromptTrialTerminal(saved.run), true)
    assert.deepEqual(parsePromptTrialFile(JSON.stringify(saved, null, 2)), {
      source_kind: singleKind, snapshots: [saved],
    })
  })
}

test('reopens a terminal cleanup failure without requiring present runtime readiness', () => {
  const saved = terminal('failed')
  saved.available = false; saved.unavailable_code = 'cleanup_failed'; saved.limits.max_output_tokens = null
  saved.run.error_code = 'cleanup_failed'; saved.run.cleanup.state = 'failed'
  assert.deepEqual(parse(saved).snapshots, [project(saved)])
})

for (const [available, cap] of [[false, null], [false, 64], [true, 64]]) {
  test(`preserves historical availability ${available} and output cap ${cap} below the recorded request`, () => {
    const saved = terminal()
    saved.available = available; saved.unavailable_code = available ? null : 'invalid_configuration'
    saved.limits.max_output_tokens = cap
    assert.deepEqual(parse(saved).snapshots, [project(saved)])
    assert.equal(parse(saved).snapshots[0].run.request.max_output_tokens, 128)
  })
}

test('reopens the existing comparison wrapper in order without requiring matching configurations or requests', () => {
  const saved = comparison()
  saved.trials[1].run.configuration = { model: 'other-local-model', reasoning_effort: 'high' }
  saved.trials[1].run.request.user_prompt = 'Another prompt'
  saved.trials[1].run.request.max_output_tokens = 256
  saved.trials[1].limits.max_output_tokens = 16
  saved.trials = saved.trials.map(project)
  assert.deepEqual(parsePromptTrialFile(JSON.stringify(saved, null, 2)), { source_kind: comparisonKind, snapshots: saved.trials })
})

test('drops unknown snapshot fields at every level and retains only the existing projection', () => {
  const data = terminal()
  const expected = project(data)
  for (const object of [data, data.limits, data.run, data.run.request, data.run.configuration, data.run.response, data.run.response.usage, data.run.cleanup]) {
    object.endpoint = 'PRIVATE_ENDPOINT'
    object.raw_error = { message: 'PRIVATE_ERROR' }
    Object.defineProperty(object, '__proto__', { value: { polluted: true }, enumerable: true })
  }
  const result = parse(data)
  assert.deepEqual(result.snapshots, [expected])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|endpoint|raw_error|__proto__|polluted/)
  assert.equal({}.polluted, undefined)
})

test('returns fresh deeply frozen projections including arrays and nested request, usage, and cleanup objects', () => {
  const saved = comparison(), result = parse(saved), another = parse(saved)
  function assertFrozen(value) {
    if (value === null || typeof value !== 'object') return
    assert.ok(Object.isFrozen(value))
    for (const child of Object.values(value)) assertFrozen(child)
  }
  assertFrozen(result)
  assert.notEqual(result, another); assert.notEqual(result.snapshots[0], another.snapshots[0])
  assert.notEqual(result.snapshots[0].run.request, another.snapshots[0].run.request)
  saved.trials[0].run.request.user_prompt = 'Changed'
  assert.equal(result.snapshots[0].run.request.user_prompt, 'Hello')
  assert.throws(() => result.snapshots.push(result.snapshots[0]), TypeError)
  assert.throws(() => { result.snapshots[0].run.response.usage.total_tokens = 99 }, TypeError)
})

test('preserves literal reply controls, markup, valid Unicode pairs, and prompt whitespace', () => {
  const saved = terminal()
  saved.run.request.system_prompt = 'line\nnext\t🦙'
  saved.run.request.user_prompt = '  🦙\r\nKeep whitespace  '
  saved.run.response.content = '\u0000\u001b\u007f\u202e<script>literal</script>🦙\n\t'
  saved.run.response.refusal = ''
  assert.deepEqual(parse(saved).snapshots, [project(saved)])
})

for (const [name, data] of [
  ['null', null], ['array', []], ['string', 'PRIVATE'], ['number', 1], ['boolean', true],
  ['API envelope', { success: true, data: terminal() }],
  ['suite report', { schema_version: 1, kind: 'mirofish_local_prompt_suite_run', cases: [] }],
  ['suite comparison', { schema_version: 1, kind: 'mirofish_local_prompt_suite_comparison', trials: comparison().trials }],
  ['idle snapshot', trialSnapshot()], ['running snapshot', trialSnapshot('running')],
  ['cloud snapshot', trialSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required', limits: { ...trialSnapshot().limits, max_output_tokens: null } })],
]) test(`rejects ${name} with a static error`, () => rejects(JSON.stringify(data)))

for (const [name, mutate] of [
  ['wrong version', data => data.schema_version = 2], ['unknown kind', data => data.kind = 'PRIVATE'],
  ['missing run', data => delete data.run], ['inconsistent availability', data => data.available = false],
  ['zero runtime cap', data => data.limits.max_output_tokens = 0], ['changed fixed limit', data => data.limits.response_bytes++],
  ['invalid identity', data => data.run.request_id = 'PRIVATE'], ['invalid fingerprint', data => data.run.fingerprint = 'PRIVATE'],
  ['unknown state', data => data.run.state = 'PRIVATE'], ['missing terminal timestamp', data => data.run.finished_at = null],
  ['backward timestamp', data => data.run.finished_at = '2026-10-03T12:00:00Z'], ['negative duration', data => data.run.elapsed_ms = -1],
  ['nonterminal cleanup', data => data.run.cleanup.state = 'pending'], ['failed cleanup with successful run', data => data.run.cleanup.state = 'failed'],
  ['success error', data => data.run.error_code = 'cleanup_failed'], ['cloud model', data => data.run.configuration.model = 'model:cloud'],
  ['model endpoint', data => data.run.configuration.model = 'http://private.example'], ['blank prompt', data => data.run.request.user_prompt = ' '],
  ['prompt control', data => data.run.request.user_prompt = '\u0000'], ['temperature string', data => data.run.request.temperature = '0.2'],
  ['request cap overflow', data => data.run.request.max_output_tokens = 513], ['missing response', data => data.run.response = null],
  ['mismatched finish', data => data.run.response.finish_reason = 'length'], ['negative usage', data => data.run.response.usage.total_tokens = -1],
  ['oversized response', data => data.run.response.content = 'x'.repeat(16385)],
]) test(`rejects invalid nested snapshot: ${name}`, () => {
  const data = terminal(); mutate(data); rejects(JSON.stringify(data))
})

for (const [name, mutate] of [
  ['extra field', data => data.endpoint = 'PRIVATE'], ['missing version', data => delete data.schema_version],
  ['wrong version', data => data.schema_version = 2], ['missing kind', data => delete data.kind],
  ['missing trials', data => delete data.trials], ['null trials', data => data.trials = null],
  ['object trials', data => data.trials = { 0: data.trials[0], 1: data.trials[1] }],
  ['zero trials', data => data.trials = []], ['one trial', data => data.trials.pop()],
  ['three trials', data => data.trials.push(terminal())], ['repeated request ID', data => data.trials[1].run.request_id = data.trials[0].run.request_id],
]) test(`rejects comparison wrapper ${name}`, () => {
  const data = comparison(); mutate(data); rejects(JSON.stringify(data))
})

for (const index of [0, 1]) test(`comparison validates atomically when snapshot ${index + 1} is invalid`, () => {
  const data = comparison()
  data.trials[index].run.cleanup.state = 'running'
  let result = null
  assert.throws(() => { result = parse(data) }, { message: invalidMessage })
  assert.equal(result, null)
  for (const invalid of [trialSnapshot(), trialSnapshot('running'), { success: true, data: terminal() }]) {
    data.trials[index] = invalid
    rejects(JSON.stringify(data))
  }
})

test('enforces the UTF-8 byte boundary before projecting ignored data', () => {
  const source = JSON.stringify({ ...terminal(), ignored: '' })
  const available = PROMPT_TRIAL_FILE_MAX_BYTES - new TextEncoder().encode(source).length
  const atLimit = source.replace('"ignored":""', '"ignored":"' + 'x'.repeat(available) + '"')
  assert.equal(new TextEncoder().encode(atLimit).length, PROMPT_TRIAL_FILE_MAX_BYTES)
  assert.deepEqual(parsePromptTrialFile(atLimit).snapshots, [project(terminal())])
  rejects(atLimit + ' ')
  const unicodeOverLimit = source.replace('"ignored":""', '"ignored":"' + '🦙'.repeat(Math.floor(available / 4) + 1) + '"')
  assert.ok(unicodeOverLimit.length < PROMPT_TRIAL_FILE_MAX_BYTES)
  assert.ok(new TextEncoder().encode(unicodeOverLimit).length > PROMPT_TRIAL_FILE_MAX_BYTES)
  rejects(unicodeOverLimit)
})

test('rejects over-limit UTF-16 source before allocating a UTF-8 encoding', t => {
  let encodings = 0
  t.mock.method(TextEncoder.prototype, 'encode', () => { encodings++; throw new Error('encoding must not happen') })
  rejects(' '.repeat(PROMPT_TRIAL_FILE_MAX_BYTES + 1))
  assert.equal(encodings, 0)
})

test('caps parser depth at 10 even for discarded unknown fields', () => {
  const nested = levels => {
    let value = null
    for (let index = 0; index < levels; index++) value = [value]
    return { ...terminal(), ignored: value }
  }
  assert.deepEqual(parse(nested(9)).snapshots, [project(terminal())])
  rejects(JSON.stringify(nested(10)))
})

const validSource = JSON.stringify(terminal())
for (const [name, source] of [
  ['leading BOM', '\ufeff' + validSource], ['BOM after whitespace', ' \ufeff' + validSource],
  ['trailing prose', validSource + ' PRIVATE'], ['trailing object', validSource + '{}'],
  ['trailing comma', validSource.slice(0, -1) + ',}'], ['malformed escape', validSource.replace('Hello back', '\\q')],
  ['literal JSON string control', validSource.replace('Hello back', '\u0000')], ['unclosed string', '{"kind":"PRIVATE'],
  ['duplicate top-level key', validSource.replace('"mode":"local"', '"mode":"local","mode":"local"')],
  ['escaped duplicate top-level key', validSource.replace('"mode":"local"', '"mode":"local","\\u006dode":"local"')],
  ['escaped duplicate nested key', validSource.replace('"label":"Trial one"', '"label":"Trial one","\\u006cabel":"PRIVATE"')],
  ['duplicate ignored key', validSource.slice(0, -1) + ',"ignored":{"a":1,"\\u0061":2}}'],
  ['positive non-finite ignored number', validSource.slice(0, -1) + ',"ignored":1e400}'],
  ['negative non-finite ignored number', validSource.slice(0, -1) + ',"ignored":-1e400}'],
  ['NaN token', validSource.slice(0, -1) + ',"ignored":NaN}'],
  ['Infinity token', validSource.slice(0, -1) + ',"ignored":Infinity}'],
  ['escaped high surrogate', validSource.slice(0, -1) + ',"ignored":"\\ud800"}'],
  ['escaped low surrogate', validSource.slice(0, -1) + ',"ignored":"\\udfff"}'],
  ['literal high surrogate', validSource.slice(0, -1) + ',"ignored":"\ud800"}'],
  ['literal low surrogate', validSource.slice(0, -1) + ',"ignored":"\udfff"}'],
  ['surrogate key', validSource.slice(0, -1) + ',"\\ud800":null}'],
]) test(`strict parsing rejects ${name} without echoing source data`, () => rejects(source))

for (const source of [undefined, null, {}, [], 1, true, new String(validSource)]) {
  test(`rejects non-string source ${Object.prototype.toString.call(source)}`, () => rejects(source))
}
