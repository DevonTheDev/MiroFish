import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptSuiteRunner } from '../src/utils/promptSuiteRunner.js'
import { exportPromptSuiteReport, parsePromptSuiteReport } from '../src/utils/promptSuites.js'
import { deferredTrials, fakeTimers, flush, ok, trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const instanceId = id(701), anotherInstance = id(702)
const definition = (version = 1) => ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Cancellation checks',
  cases: [1, 2].map(n => ({ case_id: id(n), ...trialRequest(), expected_text: version === 1 ? 'Hello back' : null,
    ...(version >= 2 ? { check_kind: version === 2 ? 'json_object' : 'json_fields' } : {}),
    ...(version === 3 ? { required_fields: [{ name: 'ok', type: 'boolean' }] } : {}) })) })
function fixture(t) {
  const { api, calls } = deferredTrials({ cancellation: true }), timers = fakeTimers(); let counter = 100
  const runner = createPromptSuiteRunner({ api, ...timers, uuid: () => id(++counter), now: () => new Date('2026-10-04T00:00:00Z') })
  t.after(() => runner.dispose())
  return { runner, calls, timers, state: () => runner.getState() }
}
async function ready(f, version = 1) {
  f.runner.start(definition(version)); await flush()
  f.calls.getPromptTrials[0].resolve(ok(trialSnapshot())); await flush()
}
function observation(f, state = 'running', instance = instanceId) {
  const sent = f.calls.startPromptTrial.at(-1).args[0], data = trialSnapshot(state)
  data.run.request_id = sent.request_id
  data.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, sent[key]]))
  if (instance !== undefined) data.run.instance_id = instance
  return data
}
function cancelled(f, state = 'cancelled') {
  const data = observation(f, state)
  data.run.response = null; data.run.error_code = 'user_cancelled'
  if (state === 'running') data.run.cleanup.state = 'running'
  return data
}

for (const replacement of ['different', 'missing']) test(`suite rejects ${replacement} instance after confirmed admission, including explicit reconciliation`, async t => {
  const f = fixture(t); await ready(f)
  f.calls.startPromptTrial[0].resolve(ok(observation(f))); await flush()
  await f.timers.advance(1500)
  const replaced = observation(f, 'succeeded', anotherInstance)
  if (replacement === 'missing') delete replaced.run.instance_id
  f.calls.getPromptTrial[0].resolve(ok(replaced)); await flush()
  assert.equal(f.state().report.halt_code, 'identity_mismatch')
  assert.equal(f.state().report.cases[0].status, 'unknown')
  assert.equal(f.state().report.cases[0].snapshot.run.instance_id, instanceId)
  f.runner.reconcile(); await flush()
  f.calls.getPromptTrial[1].resolve(ok(replaced)); await flush()
  assert.equal(f.state().report.halt_code, 'identity_mismatch')
  assert.equal(f.state().report.cases[0].status, 'unknown')
  assert.equal(f.calls.startPromptTrial.length, 1); assert.equal(f.calls.cancelPromptTrial.length, 0)
})

test('legacy suite observation can confirm an instance once, then rejects a later replacement', async t => {
  const f = fixture(t); await ready(f)
  const legacy = observation(f); delete legacy.run.instance_id
  f.calls.startPromptTrial[0].resolve(ok(legacy)); await flush()
  await f.timers.advance(1500); f.calls.getPromptTrial[0].resolve(ok(legacy)); await flush()
  assert.equal(f.state().report.cases[0].status, 'running')
  assert.equal(Object.hasOwn(f.state().report.cases[0].snapshot.run, 'instance_id'), false)
  await f.timers.advance(1500); f.calls.getPromptTrial[1].resolve(ok(observation(f))); await flush()
  assert.equal(f.state().report.cases[0].snapshot.run.instance_id, instanceId)
  await f.timers.advance(1500); f.calls.getPromptTrial[2].resolve(ok(observation(f, 'succeeded', anotherInstance))); await flush()
  assert.equal(f.state().report.halt_code, 'identity_mismatch')
})

for (const version of [1, 2, 3]) test(`suite v${version} preserves pending user cancellation export and halts terminal cancelled checks unevaluated`, async t => {
  const f = fixture(t); await ready(f, version)
  f.calls.startPromptTrial[0].resolve(ok(observation(f))); await flush()
  await f.timers.advance(1500); f.calls.getPromptTrial[0].resolve(ok(cancelled(f, 'running'))); await flush()
  const pending = parsePromptSuiteReport(exportPromptSuiteReport(f.state().report))
  assert.equal(pending.schema_version, version); assert.equal(pending.status, 'running')
  assert.equal(pending.cases[0].snapshot.run.instance_id, instanceId)
  assert.equal(pending.cases[0].snapshot.run.error_code, 'user_cancelled')
  assert.equal(pending.cases[0].check, 'not_evaluated')
  await f.timers.advance(1500); f.calls.getPromptTrial[1].resolve(ok(cancelled(f))); await flush()
  await f.timers.advance(100000)
  const terminal = parsePromptSuiteReport(exportPromptSuiteReport(f.state().report))
  assert.equal(terminal.status, 'halted'); assert.equal(terminal.halt_code, 'runtime_failed')
  assert.equal(terminal.cases[0].status, 'cancelled'); assert.equal(terminal.cases[0].check, 'not_evaluated')
  assert.equal(terminal.cases[0].snapshot.run.error_code, 'user_cancelled')
  assert.equal(terminal.cases[0].snapshot.run.instance_id, instanceId)
  assert.equal(terminal.cases[1].status, 'not_attempted')
  assert.equal(f.calls.startPromptTrial.length, 1); assert.equal(f.calls.cancelPromptTrial.length, 0)
})
