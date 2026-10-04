import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as trials from '../src/api/promptTrials.js'
import * as suites from '../src/utils/promptSuites.js'
import { createPromptSuiteRunner } from '../src/utils/promptSuiteRunner.js'
import { deferredTrials, fakeTimers, flush, ok, trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const definition = (length = 2) => ({ schema_version: 3, kind: 'mirofish_local_prompt_suite', name: 'Required JSON fields',
  cases: Array.from({ length }, (_, index) => ({ case_id: id(index + 1), ...trialRequest(), check_kind: 'json_fields',
    expected_text: null, required_fields: [{ name: 'value', type: 'number' }] })) })
function fixture(create = createPromptSuiteRunner) {
  const { api, calls } = deferredTrials(), timers = fakeTimers(), changes = []; let counter = 100
  const runner = create({ api, ...timers, uuid: () => id(++counter), now: () => new Date('2026-10-04T00:00:00Z'), onChange: value => changes.push(value) })
  return { runner, calls, timers, changes, state: () => runner.getState() }
}
async function ready(f, source) {
  const pending = f.runner.start(source); await flush()
  assert.equal(f.calls.getPromptTrials.length, 1)
  f.calls.getPromptTrials[0].resolve(ok(trialSnapshot())); await flush()
  return { pending }
}
function observation(f, state = 'succeeded', content = '{"value":0}') {
  const sent = f.calls.startPromptTrial.at(-1).args[0], snapshot = trialSnapshot(state)
  snapshot.run.request_id = sent.request_id; snapshot.run.request = trials.acceptPromptTrialInputs(sent)
  if (snapshot.run.response) snapshot.run.response.content = content
  if (state === 'truncated') snapshot.run.response.finish_reason = 'length'
  if (state === 'refused') snapshot.run.response.finish_reason = 'content_filter'
  if (['failed', 'timed_out', 'cancelled'].includes(state)) { snapshot.run.response = null; snapshot.run.error_code = 'request_timeout' }
  return snapshot
}

test('v3 runner owns admitted nested rules across source, state, callback and transport mutations', async () => {
  const f = fixture(), source = definition(), pending = f.runner.start(source); await flush()
  assert.equal(f.calls.getPromptTrials.length, 1)
  source.cases[0].required_fields[0].type = 'string'
  source.cases[1].required_fields[0].name = 'changed'; source.cases[1].required_fields.push({ name: 'extra', type: 'null' })
  f.calls.getPromptTrials[0].resolve(ok(trialSnapshot())); await flush()
  const emitted = f.changes.find(value => value.report)?.report
  emitted.definition.cases[0].required_fields[0].name = 'callback mutation'
  const returned = f.state(); returned.report.definition.cases[0].required_fields.length = 0
  const sent = f.calls.startPromptTrial[0].args[0]
  assert.deepEqual(Object.keys(sent), ['request_id', 'label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens'])
  assert.ok(Object.isFrozen(sent))
  assert.throws(() => { sent.required_fields = [{ name: 'value', type: 'string' }] }, TypeError)
  f.calls.startPromptTrial[0].resolve(ok(observation(f))); await flush(); assert.equal(await pending, true)
  assert.equal(f.state().report.cases[0].check, 'matched')
  await f.timers.advance(1500); f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
  assert.deepEqual(Object.keys(f.calls.startPromptTrial[1].args[0]), Object.keys(sent))
  f.calls.startPromptTrial[1].resolve(ok(observation(f))); await flush()
  const captured = f.state().report
  assert.equal(captured.schema_version, 3); assert.equal(captured.status, 'completed')
  assert.deepEqual(captured.definition.cases.map(input => input.required_fields), [[{ name: 'value', type: 'number' }], [{ name: 'value', type: 'number' }]])
  assert.deepEqual(captured.cases.map(row => row.check), ['matched', 'matched'])
  assert.deepEqual(suites.parsePromptSuiteReport(suites.exportPromptSuiteReport(captured)), captured)
  f.runner.dispose()
})

test('captured runner definitions freeze the admitted rule array and each rule object', async () => {
  // Observe the actual admission boundary without exposing runner internals or
  // changing production APIs. All validation and execution remain real.
  let admitted
  const source = readFileSync(new URL('../src/utils/promptSuiteRunner.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\n/gm, '').replace('export function ', 'function ')
  const create = vm.runInNewContext(source + '\n;createPromptSuiteRunner', {
    ...trials, evaluatePromptSuiteCheck: suites.evaluatePromptSuiteCheck, AbortController,
    acceptPromptSuiteDefinition: value => { admitted = suites.acceptPromptSuiteDefinition(value); return admitted },
  })
  const f = fixture(create), input = definition(1), pending = f.runner.start(input); await flush()
  assert.ok(Object.isFrozen(admitted))
  assert.ok(Object.isFrozen(admitted.cases))
  assert.ok(Object.isFrozen(admitted.cases[0]))
  assert.ok(Object.isFrozen(admitted.cases[0].required_fields))
  assert.ok(Object.isFrozen(admitted.cases[0].required_fields[0]))
  assert.throws(() => { admitted.cases[0].required_fields[0].type = 'null' }, TypeError)
  assert.throws(() => admitted.cases[0].required_fields.push({ name: 'other', type: 'array' }), TypeError)
  assert.equal(Object.isFrozen(input.cases[0].required_fields), false)
  f.runner.stop(); f.calls.getPromptTrials[0].resolve(ok(trialSnapshot())); await flush()
  assert.equal(await pending, false); f.runner.dispose()
})

test('required-field mismatches remain ordinary checks and later cases still execute', async () => {
  const f = fixture(), { pending } = await ready(f, definition())
  f.calls.startPromptTrial[0].resolve(ok(observation(f, 'succeeded', '{"value":null}'))); await flush()
  assert.equal(await pending, true)
  assert.equal(f.state().report.cases[0].check, 'mismatched')
  assert.equal(f.state().busy, true)
  await f.timers.advance(1500); f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
  f.calls.startPromptTrial[1].resolve(ok(observation(f))); await flush()
  assert.equal(f.state().report.status, 'completed')
  assert.deepEqual(f.state().report.cases.map(row => row.check), ['mismatched', 'matched'])
  assert.deepEqual(suites.summarizePromptSuiteReport(f.state().report), { total: 2, attempted: 2, succeeded: 2,
    evaluated: 2, matched: 1, mismatched: 1, not_requested: 0, not_evaluated: 0 })
  f.runner.dispose()
})

for (const status of ['truncated', 'refused', 'failed', 'timed_out', 'cancelled']) test(`v3 ${status} observations never evaluate or continue the suite`, async () => {
  const f = fixture(), { pending } = await ready(f, definition())
  f.calls.startPromptTrial[0].resolve(ok(observation(f, status))); await flush()
  assert.equal(await pending, true)
  assert.equal(f.state().report.status, 'halted')
  assert.deepEqual(f.state().report.cases.map(row => row.check), ['not_evaluated', 'not_evaluated'])
  assert.equal(f.state().report.cases[1].status, 'not_attempted')
  assert.doesNotThrow(() => suites.exportPromptSuiteReport(f.state().report))
  await f.timers.advance(10000); assert.equal(f.calls.startPromptTrial.length, 1)
  f.runner.dispose()
})

test('invalid v3 rules are rejected before any request is sent', async () => {
  const f = fixture(), source = definition(); source.cases[0].required_fields[0].name = ''
  assert.equal(await f.runner.start(source), false)
  assert.equal(f.state().error_code, 'invalid_definition')
  assert.deepEqual(Object.values(f.calls).map(calls => calls.length), [0, 0, 0])
  f.runner.dispose()
})
