import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptPromptTrialInputs } from '../src/api/promptTrials.js'
import { createPromptSuiteRunner } from '../src/utils/promptSuiteRunner.js'
import { exportPromptSuiteReport, parsePromptSuiteReport } from '../src/utils/promptSuites.js'
import { deferredTrials, fakeTimers, flush, ok, trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const suite = (length = 2) => ({ schema_version: 1, kind: 'mirofish_local_prompt_suite', name: 'Stop ownership',
  cases: Array.from({ length }, (_, index) => ({ case_id: id(index + 1), ...trialRequest(), label: `Case ${index + 1}`, expected_text: 'Hello back' })) })
function fixture(options = {}) {
  const { api, calls } = deferredTrials(), timers = fakeTimers(), changes = []; let counter = 100
  const runner = createPromptSuiteRunner({ api, ...timers, uuid: () => id(++counter),
    now: () => new Date('2026-10-05T00:00:00Z'), onChange: state => changes.push(state), ...options })
  return { runner, calls, timers, changes, state: () => runner.getState(), runId: () => runner.getState().report.run_id }
}
async function readiness(f) { f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush() }
async function start(f, definition = suite()) { f.runner.start(definition); await readiness(f) }
function observation(f, state = 'succeeded') {
  const request = f.calls.startPromptTrial.at(-1).args[0], snapshot = trialSnapshot(state)
  snapshot.run.request_id = request.request_id; snapshot.run.request = acceptPromptTrialInputs(request)
  return snapshot
}
async function settle(f, state = 'succeeded') { f.calls.startPromptTrial.at(-1).resolve(ok(observation(f, state))); await flush() }
const counts = f => Object.fromEntries(Object.entries(f.calls).map(([key, calls]) => [key, calls.length]))
async function quiet(f) {
  const before = f.state(), beforeCounts = counts(f)
  await f.timers.advance(100000)
  assert.deepEqual(f.state(), before); assert.deepEqual(counts(f), beforeCounts); assert.equal(f.timers.pending.size, 0)
}

for (const outcome of ['completed', 'stopped']) {
  test(`captured Stop from ${outcome} A is inert across B readiness, active work and pause`, async () => {
    const f = fixture()
    assert.equal(typeof f.runner.captureStopHandler, 'function', 'the controller must provide an operation-owned Stop callback')
    await start(f, suite(1)); const oldStop = f.runner.captureStopHandler()
    if (outcome === 'stopped') oldStop()
    await settle(f)
    const oldReport = f.state().report
    f.runner.start(suite())
    // B is active synchronously before any promise continuation; its report is A's.
    const checking = f.state(); assert.deepEqual(checking.report, oldReport)
    oldStop(); oldStop(); assert.deepEqual(f.state(), checking)
    await readiness(f)
    assert.equal(f.calls.startPromptTrial.length, 2); assert.notEqual(f.runId(), oldReport.run_id)
    const running = f.state(); oldStop(); assert.deepEqual(f.state(), running)
    f.runner.pause(f.runId()); await settle(f)
    const paused = f.state(); assert.equal(paused.phase, 'paused')
    oldStop(); assert.deepEqual(f.state(), paused); await quiet(f)
    const currentStop = f.runner.captureStopHandler(); currentStop()
    const stopped = f.state(); assert.equal(stopped.report.status, 'stopped')
    currentStop(); oldStop(); assert.deepEqual(f.state(), stopped); await quiet(f)
    assert.equal(f.calls.startPromptTrial.length, 2)
  })
}

for (const previousReport of [false, true]) {
  test(`captured current Stop prevents initial admission and preserves previous report=${previousReport}`, async () => {
    const f = fixture()
    if (previousReport) { await start(f, suite(1)); await settle(f) }
    const saved = f.state().report, before = counts(f)
    f.runner.start(suite())
    const currentStop = f.runner.captureStopHandler(), read = f.calls.getPromptTrials.at(-1)
    currentStop(); currentStop(); assert.equal(read.signal.aborted, false)
    await readiness(f)
    assert.deepEqual(f.state().report, saved); assert.equal(f.state().busy, false)
    assert.equal(f.calls.startPromptTrial.length, before.startPromptTrial); await quiet(f)
    f.runner.start(suite()); currentStop(); await readiness(f)
    assert.equal(f.calls.startPromptTrial.length, before.startPromptTrial + 1)
    assert.equal(f.state().report.stop_requested, false)
  })
}

for (const phase of ['checking', 'submitting']) {
  test(`capturing and invoking current Stop from synchronous ${phase} notification prevents the first POST`, async () => {
    let runner, stop
    const f = fixture({ onChange: state => {
      if (state.phase === phase && !stop) { stop = runner.captureStopHandler(); stop() }
    } }); runner = f.runner
    await start(f)
    assert.equal(typeof stop, 'function'); assert.equal(f.calls.startPromptTrial.length, 0)
    assert.equal(f.state().busy, false)
    if (phase === 'checking') assert.equal(f.state().report, null)
    else {
      assert.equal(f.state().report.status, 'stopped')
      assert.equal(f.state().report.cases[0].status, 'not_attempted')
      assert.equal(f.state().report.cases[0].request_id, null)
    }
    await quiet(f)
  })
}

for (const phase of ['accepted POST', 'uncertain POST', 'observation', 'between cases', 'next readiness', 'pause pending', 'paused', 'resume delay', 'resume readiness']) {
  test(`Stop captured during initial readiness still owns ${phase} without cancelling or replaying inference`, async () => {
    const f = fixture(), source = suite(), original = structuredClone(source)
    f.runner.start(source); const stop = f.runner.captureStopHandler(); await readiness(f)
    const report = f.state().report, post = f.calls.startPromptTrial[0]
    source.name = 'Edited'; source.cases[1].user_prompt = 'Draft edit'
    if (phase === 'uncertain POST') { post.reject(new Error('PRIVATE lost response')); await flush() }
    if (phase === 'observation') { await settle(f, 'running'); await f.timers.advance(1500) }
    if (['pause pending', 'paused', 'resume delay', 'resume readiness'].includes(phase)) f.runner.pause(f.runId())
    if (['between cases', 'next readiness', 'paused', 'resume delay', 'resume readiness'].includes(phase)) await settle(f)
    if (phase.startsWith('resume ')) await f.runner.resume(f.runId())
    if (['next readiness', 'resume readiness'].includes(phase)) await f.timers.advance(1500)
    stop(); stop()
    assert.equal(post.signal.aborted, false)
    if (['accepted POST', 'pause pending'].includes(phase)) await settle(f, 'running')
    if (['uncertain POST', 'observation'].includes(phase)) {
      const read = f.calls.getPromptTrial.at(-1)
      assert.equal(read.args[0], post.args[0].request_id); assert.equal(read.signal.aborted, false)
      read.resolve(ok(observation(f, 'running'))); await flush()
    }
    if (['accepted POST', 'uncertain POST', 'observation', 'pause pending'].includes(phase)) {
      await f.timers.advance(1500)
      const exact = f.calls.getPromptTrial.at(-1)
      assert.equal(exact.args[0], post.args[0].request_id); assert.equal(exact.signal.aborted, false)
      exact.resolve(ok(observation(f))); await flush()
    } else if (['next readiness', 'resume readiness'].includes(phase)) await readiness(f)
    const stopped = f.state().report
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stop_requested, true)
    assert.equal(stopped.run_id, report.run_id); assert.deepEqual(stopped.definition, original)
    assert.equal(stopped.cases[0].request_id, post.args[0].request_id)
    assert.equal(stopped.cases[1].request_id, null); assert.equal(stopped.cases[1].status, 'not_attempted')
    assert.deepEqual(parsePromptSuiteReport(exportPromptSuiteReport(stopped)), stopped)
    assert.deepEqual(Object.keys(stopped).sort(), Object.keys(report).sort())
    assert.equal(f.calls.startPromptTrial.length, 1); assert.equal(f.state().can_resume, false)
    assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE/)
    stop(); await quiet(f)
  })
}

test('retired Stop cannot alter later reconciliation even when the report run_id is unchanged', async () => {
  const f = fixture(); await start(f)
  const oldStop = f.runner.captureStopHandler(), runId = f.runId()
  f.calls.startPromptTrial[0].reject(new Error('lost')); await flush()
  f.calls.getPromptTrial[0].reject(new Error('lost observation')); await flush()
  f.runner.reconcile(); const before = f.state()
  assert.equal(f.runId(), runId); oldStop(); assert.deepEqual(f.state(), before)
  f.calls.getPromptTrial.at(-1).resolve(ok(observation(f))); await flush()
  assert.equal(f.state().report.status, 'halted'); assert.equal(f.state().report.stop_requested, false)
  assert.equal(f.calls.startPromptTrial.length, 1); await quiet(f)
})

test('idle, failed-readiness, refreshed and disposed Stop callbacks remain inert', async () => {
  const f = fixture(), idleStop = f.runner.captureStopHandler()
  f.runner.start(suite()); const failedStop = f.runner.captureStopHandler()
  f.calls.getPromptTrials[0].reject(new Error('PRIVATE')); await flush()
  f.runner.refresh(); const refreshStop = f.runner.captureStopHandler(); await readiness(f)
  await start(f)
  const before = f.state(); idleStop(); failedStop(); refreshStop(); assert.deepEqual(f.state(), before)
  const currentStop = f.runner.captureStopHandler(), pending = f.calls.startPromptTrial[0], late = observation(f)
  f.runner.dispose(); const disposedStop = f.runner.captureStopHandler(), saved = f.state()
  assert.equal(pending.signal.aborted, true); pending.resolve(ok(late)); await flush()
  for (const stop of [idleStop, failedStop, refreshStop, currentStop, disposedStop]) stop()
  assert.deepEqual(f.state(), saved); assert.equal(f.calls.startPromptTrial.length, 1); await quiet(f)
})

test('direct stop() retains its current-operation API during readiness and active observation', async () => {
  const f = fixture(); f.runner.start(suite()); f.runner.stop(); await readiness(f)
  assert.equal(f.calls.startPromptTrial.length, 0); assert.equal(f.state().report, null)
  await start(f); f.runner.stop(); await settle(f)
  assert.equal(f.state().report.status, 'stopped'); assert.equal(f.calls.startPromptTrial.length, 1)
  await quiet(f)
})
