import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptPromptTrialInputs } from '../src/api/promptTrials.js'
import { createPromptSuiteRunner } from '../src/utils/promptSuiteRunner.js'
import { exportPromptSuiteReport, parsePromptSuiteDefinition, parsePromptSuiteReport } from '../src/utils/promptSuites.js'
import { deferredTrials, fakeTimers, flush, ok, trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const suite = (length = 3, version = 1) => ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Pause checks',
  cases: Array.from({ length }, (_, index) => ({ case_id: id(index + 1), ...trialRequest(), label: `Case ${index + 1}`,
    expected_text: version === 1 ? 'Hello back' : null,
    ...(version >= 2 ? { check_kind: version === 3 ? 'json_fields' : 'json_object' } : {}),
    ...(version === 3 ? { required_fields: [{ name: 'value', type: 'number' }] } : {}) })) })

function fixture(options = {}) {
  const { api, calls } = deferredTrials(), timers = fakeTimers(), changes = []; let counter = 100
  const runner = createPromptSuiteRunner({ api, ...timers, uuid: () => id(++counter),
    now: () => new Date('2026-10-04T00:00:00Z'), onChange: state => changes.push(state), ...options })
  return { runner, calls, timers, changes, state: () => runner.getState(), runId: () => runner.getState().report.run_id }
}
async function ready(f, source = suite()) {
  const pending = f.runner.start(source); await flush()
  f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
  return { pending }
}
function observation(f, state = 'succeeded', content = 'Hello back') {
  const sent = f.calls.startPromptTrial.at(-1).args[0], snapshot = trialSnapshot(state)
  snapshot.run.request_id = sent.request_id; snapshot.run.request = acceptPromptTrialInputs(sent)
  if (snapshot.run.response) snapshot.run.response.content = content
  if (state === 'truncated') snapshot.run.response.finish_reason = 'length'
  if (state === 'refused') snapshot.run.response.finish_reason = 'content_filter'
  if (['failed', 'timed_out', 'cancelled'].includes(state)) {
    snapshot.run.response = null; snapshot.run.error_code = 'request_timeout'
  }
  return snapshot
}
async function admit(f, state = 'succeeded', content = 'Hello back') {
  f.calls.startPromptTrial.at(-1).resolve(ok(observation(f, state, content))); await flush()
}
function parked(f, { error = null, attempted = 1 } = {}) {
  const state = f.state()
  assert.equal(state.phase, 'paused'); assert.equal(state.busy, true)
  assert.equal(state.pause_requested, true); assert.equal(state.can_pause, false); assert.equal(state.can_resume, true)
  assert.equal(state.error_code, error); assert.equal(state.report.status, 'running'); assert.equal(state.report.finished_at, null)
  assert.equal(state.report.halt_code, null); assert.equal(state.report.stop_requested, false)
  assert.equal(state.report.cases.filter(row => row.status !== 'not_attempted').length, attempted)
  assert.equal(f.timers.pending.size, 0)
}
async function quiet(f) {
  const before = Object.values(f.calls).map(calls => calls.length), state = f.state()
  await f.timers.advance(1_000_000)
  assert.deepEqual(Object.values(f.calls).map(calls => calls.length), before)
  assert.deepEqual(f.state(), state); assert.equal(f.timers.pending.size, 0)
}
async function resumeRead(f) {
  const before = f.calls.getPromptTrials.length
  assert.equal(await f.runner.resume(f.runId()), true)
  assert.equal(f.state().pause_requested, false); assert.equal(f.state().can_pause, true); assert.equal(f.state().can_resume, false)
  assert.equal(await f.runner.resume(f.runId()), false); assert.equal(f.timers.pending.size, 1)
  await f.timers.advance(1499); assert.equal(f.calls.getPromptTrials.length, before)
  await f.timers.advance(1); assert.equal(f.calls.getPromptTrials.length, before + 1)
  return f.calls.getPromptTrials.at(-1)
}

test('Pause accepts only an exact current captured automatic run and duplicate calls are inert', async () => {
  const f = fixture()
  assert.equal(f.state().pause_requested, false); assert.equal(f.state().can_pause, false); assert.equal(f.state().can_resume, false)
  assert.equal(f.runner.pause(id(101)), false); assert.equal(await f.runner.resume(id(101)), false)
  f.runner.start(suite()); await flush()
  assert.equal(f.runner.pause(id(101)), false); assert.equal(f.state().can_pause, false)
  f.calls.getPromptTrials[0].resolve(ok(trialSnapshot())); await flush()
  assert.equal(f.state().can_pause, true); assert.equal(f.runner.pause(), false)
  assert.equal(f.runner.pause(id(999)), false); assert.equal(await f.runner.resume(f.runId()), false)
  assert.equal(f.runner.pause(f.runId()), true); const pending = f.state()
  assert.equal(pending.pause_requested, true); assert.equal(pending.can_pause, false); assert.equal(pending.can_resume, false)
  assert.equal(f.runner.pause(f.runId()), false); assert.deepEqual(f.state(), pending)
  await admit(f); parked(f); await quiet(f)
})

for (const boundary of ['accepted POST', 'lost POST reconciliation', 'observation timer', 'pending observation']) {
  test(`Pause during ${boundary} keeps exact-ID observation through success before parking`, async () => {
    const f = fixture(); await ready(f)
    if (boundary === 'lost POST reconciliation') {
      f.calls.startPromptTrial[0].reject(new Error('PRIVATE lost response')); await flush()
    } else if (['observation timer', 'pending observation'].includes(boundary)) {
      await admit(f, 'running')
      if (boundary === 'pending observation') await f.timers.advance(1500)
    }
    assert.equal(f.runner.pause(f.runId()), true)
    assert.equal(f.state().can_resume, false)
    const activeCall = boundary === 'accepted POST' ? f.calls.startPromptTrial[0] : f.calls.getPromptTrial.at(-1)
    if (activeCall) { assert.equal(activeCall.signal.aborted, false); activeCall.resolve(ok(observation(f, 'running'))); await flush() }
    assert.equal(f.state().phase, 'waiting'); assert.equal(f.timers.pending.size, 1)
    await f.timers.advance(1500)
    const read = f.calls.getPromptTrial.at(-1)
    assert.equal(read.args[0], f.calls.startPromptTrial[0].args[0].request_id)
    assert.equal(read.signal.aborted, false); read.resolve(ok(observation(f))); await flush()
    parked(f); assert.equal(f.calls.startPromptTrial.length, 1); assert.equal(f.calls.getPromptTrials.length, 1)
    assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE/); await quiet(f)
  })
}

test('lost POST followed by exact-ID terminal success parks without replay', async () => {
  const f = fixture(); await ready(f); f.runner.pause(f.runId())
  f.calls.startPromptTrial[0].reject(new Error('PRIVATE')); await flush()
  assert.equal(f.calls.getPromptTrial[0].args[0], f.calls.startPromptTrial[0].args[0].request_id)
  f.calls.getPromptTrial[0].resolve(ok(observation(f))); await flush(); parked(f)
  assert.equal(f.calls.startPromptTrial.length, 1); await quiet(f)
})

for (const boundary of ['between-case delay', 'pending readiness']) {
  test(`Pause during ${boundary} keeps the next case unsent until fresh Resume readiness`, async () => {
    const f = fixture(); await ready(f); await admit(f)
    if (boundary === 'pending readiness') await f.timers.advance(1500)
    f.runner.pause(f.runId())
    if (boundary === 'pending readiness') {
      assert.equal(f.state().can_resume, false)
      f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
    }
    parked(f); await quiet(f)
    const read = await resumeRead(f)
    assert.equal(f.calls.startPromptTrial.length, 1); read.resolve(ok(trialSnapshot())); await flush()
    assert.equal(f.calls.startPromptTrial.length, 2)
    assert.equal(f.calls.startPromptTrial[1].args[0].label, 'Case 2')
    assert.equal(f.calls.startPromptTrial[1].args[0].request_id, id(103))
  })
}

for (const position of ['first', 'next', 'resumed']) {
  test(`synchronous Pause before the ${position} POST restores the row and reuses its original unsent ID exactly once`, async () => {
    let runner, capturedRequestId, pauseNext = position === 'first'
    const f = fixture({ onChange: state => {
      if (state.phase === 'submitting' && pauseNext) {
        pauseNext = false; capturedRequestId = state.report.cases.find(row => row.status === 'submitting').request_id
        assert.equal(runner.pause(state.report.run_id), true)
      }
    } }); runner = f.runner
    await ready(f)
    if (position !== 'first') {
      await admit(f)
      if (position === 'resumed') { f.runner.pause(f.runId()); pauseNext = true; await resumeRead(f) }
      else { pauseNext = true; await f.timers.advance(1500) }
      f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
    }
    const attempted = position === 'first' ? 0 : 1
    parked(f, { attempted }); assert.equal(f.calls.startPromptTrial.length, attempted)
    const row = f.state().report.cases[attempted]
    assert.deepEqual(row, { case_id: id(attempted + 1), request_id: null, status: 'not_attempted', check: 'not_evaluated', snapshot: null, error_code: null })
    assert.doesNotThrow(() => exportPromptSuiteReport(f.state().report)); await quiet(f)
    const read = await resumeRead(f); read.resolve(ok(trialSnapshot())); await flush()
    assert.equal(f.calls.startPromptTrial.length, attempted + 1)
    assert.equal(f.calls.startPromptTrial.at(-1).args[0].request_id, capturedRequestId)
    await admit(f); assert.equal(f.state().report.cases[attempted].status, 'succeeded')
  })
}

test('synchronous Pause from readiness notification prevents the GET and retains the next index', async () => {
  let runner, pauseNext = false
  const f = fixture({ onChange: state => {
    if (state.phase === 'checking' && pauseNext) { pauseNext = false; runner.pause(state.report.run_id) }
  } }); runner = f.runner
  await ready(f); await admit(f); pauseNext = true; await f.timers.advance(1500)
  parked(f); assert.equal(f.calls.getPromptTrials.length, 1)
  const read = await resumeRead(f); read.resolve(ok(trialSnapshot())); await flush()
  assert.equal(f.calls.startPromptTrial[1].args[0].request_id, id(103))
})

for (const version of [1, 2, 3]) {
  test(`v${version} paused exports remain historical running reports and Resume preserves all captured inputs and IDs`, async () => {
    const f = fixture(), source = suite(3, version), original = structuredClone(source)
    await ready(f, source); const runId = f.runId(), firstId = f.calls.startPromptTrial[0].args[0].request_id
    f.runner.pause(runId); await admit(f, 'succeeded', version === 1 ? 'Hello back' : '{"value":0}'); parked(f)
    source.cases.reverse(); source.cases[0].user_prompt = 'EDITED DRAFT'; source.name = 'Edited'
    if (version === 3) source.cases[1].required_fields[0].type = 'string'
    const importedDraft = parsePromptSuiteDefinition(JSON.stringify(suite(1, version)))
    assert.equal(await f.runner.start(importedDraft), false); assert.equal(await f.runner.refresh(), false); assert.equal(await f.runner.reconcile(), false)
    const detached = f.state(); detached.report.definition.cases.reverse(); detached.pause_requested = false
    const report = f.state().report, exported = exportPromptSuiteReport(report)
    assert.deepEqual(parsePromptSuiteReport(exported), report); assert.deepEqual(report.definition, original)
    assert.equal(report.schema_version, version); assert.equal(report.run_id, runId); assert.equal(report.cases[0].request_id, firstId)
    assert.equal(Object.hasOwn(report, 'pause_requested'), false); assert.equal(Object.hasOwn(report, 'phase'), false)
    await quiet(f)
    for (let index = 1; index < 3; index++) {
      if (index === 1) await resumeRead(f); else await f.timers.advance(1500)
      f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
      const request = f.calls.startPromptTrial.at(-1).args[0]
      assert.equal(request.request_id, id(102 + index)); assert.deepEqual(acceptPromptTrialInputs(request), acceptPromptTrialInputs(original.cases[index]))
      assert.equal(Object.isFrozen(request), true)
      await admit(f, 'succeeded', version === 1 ? 'Hello back' : '{"value":0}')
    }
    assert.equal(f.state().report.run_id, runId); assert.equal(f.state().report.status, 'completed')
    assert.deepEqual(f.state().report.cases.map(row => row.check), ['matched', 'matched', 'matched'])
    assert.equal(f.calls.startPromptTrial.length, 3); assert.equal(f.state().can_resume, false)
    assert.equal(await f.runner.resume(runId), false); assert.equal(f.runner.pause(runId), false)
  })
}

for (const terminal of ['succeeded', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`pending Pause cannot override final ${terminal} outcome`, async () => {
    const f = fixture(); await ready(f, suite(1)); f.runner.pause(f.runId()); await admit(f, terminal)
    assert.equal(f.state().report.status, terminal === 'succeeded' ? 'completed' : 'halted')
    assert.equal(f.state().busy, false); assert.equal(f.state().pause_requested, false)
    assert.equal(f.state().can_pause, false); assert.equal(f.state().can_resume, false)
    assert.equal(await f.runner.resume(f.runId()), false); await quiet(f)
  })
}

for (const terminal of ['truncated', 'refused', 'failed', 'timed_out', 'cancelled']) {
  test(`pending Pause does not make a nonfinal ${terminal} case resumable`, async () => {
    const f = fixture(); await ready(f); f.runner.pause(f.runId()); await admit(f, terminal)
    assert.equal(f.state().report.status, 'halted'); assert.equal(f.state().report.halt_code, 'runtime_failed')
    assert.equal(f.state().report.cases[1].status, 'not_attempted'); assert.equal(await f.runner.resume(f.runId()), false)
    assert.doesNotThrow(() => exportPromptSuiteReport(f.state().report)); await quiet(f)
  })
}

for (const [status, code] of [[400, 'invalid_request'], [403, 'local_mode_required'], [403, 'local_browser_required'], [409, 'already_running'], [409, 'request_conflict']]) {
  test(`pending Pause preserves definitive ${code} rejection without reconciliation`, async () => {
    const f = fixture(); await ready(f); f.runner.pause(f.runId())
    f.calls.startPromptTrial[0].reject({ response: { status, data: { success: false, error_code: code, error: 'PRIVATE' } } }); await flush()
    assert.equal(f.state().report.status, 'halted'); assert.equal(f.state().report.cases[0].status, 'rejected')
    assert.equal(f.state().report.halt_code, 'admission_rejected'); assert.equal(f.calls.getPromptTrial.length, 0)
    assert.equal(await f.runner.resume(f.runId()), false); assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE/); await quiet(f)
  })
}

for (const invalid of ['read failure', 'missing run', 'different ID', 'changed input', 'changed fingerprint', 'invalid snapshot']) {
  test(`pending Pause preserves unknown for ${invalid}, and explicit reconciliation never enables Resume`, async () => {
    const f = fixture(); await ready(f); await admit(f, 'running'); f.runner.pause(f.runId()); await f.timers.advance(1500)
    if (invalid === 'read failure') f.calls.getPromptTrial[0].reject(new Error('PRIVATE'))
    else {
      const snapshot = observation(f)
      if (invalid === 'missing run') snapshot.run = null
      if (invalid === 'different ID') snapshot.run.request_id = id(999)
      if (invalid === 'changed input') snapshot.run.request.user_prompt = 'PRIVATE'
      if (invalid === 'changed fingerprint') snapshot.run.fingerprint = 'b'.repeat(64)
      if (invalid === 'invalid snapshot') snapshot.schema_version = 99
      f.calls.getPromptTrial[0].resolve(ok(snapshot))
    }
    await flush(); assert.equal(f.state().report.cases[0].status, 'unknown'); assert.equal(f.state().report.status, 'halted')
    assert.equal(f.state().pause_requested, false); assert.equal(await f.runner.resume(f.runId()), false); await quiet(f)
    f.runner.reconcile(); await flush()
    assert.equal(f.runner.pause(f.runId()), false); assert.equal(f.state().can_pause, false)
    f.calls.getPromptTrial.at(-1).resolve(ok(observation(f, 'running'))); await flush(); await f.timers.advance(1500)
    f.calls.getPromptTrial.at(-1).resolve(ok(observation(f))); await flush()
    assert.equal(f.state().report.status, 'halted'); assert.equal(await f.runner.resume(f.runId()), false)
    assert.equal(f.calls.startPromptTrial.length, 1); assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE/); await quiet(f)
  })
}

test('Pause retains the existing sixty-observation limit and cannot resume an unknown result', async () => {
  const f = fixture(); await ready(f); f.runner.pause(f.runId()); await admit(f, 'running')
  for (let index = 0; index < 60; index++) {
    await f.timers.advance(1500); assert.equal(f.calls.getPromptTrial.length, index + 1)
    f.calls.getPromptTrial[index].resolve(ok(observation(f, 'running'))); await flush()
  }
  assert.equal(f.state().report.halt_code, 'observation_limit'); assert.equal(f.state().report.cases[0].status, 'unknown')
  assert.equal(await f.runner.resume(f.runId()), false); await quiet(f)
})

for (const failure of ['read_failed', 'invalid_observation', 'backend_running', 'backend_unavailable', 'loaded_cap']) {
  test(`Resume ${failure} remains safely paused with unchanged cases and allows explicit retry`, async () => {
    const f = fixture(), source = suite(); source.cases[0].max_output_tokens = 512
    source.cases[1].max_output_tokens = 64; source.cases[2].max_output_tokens = 32
    await ready(f, source); f.runner.pause(f.runId()); await admit(f); const report = f.state().report
    const read = await resumeRead(f)
    if (failure === 'read_failed') read.reject(new Error('PRIVATE'))
    else if (failure === 'invalid_observation') read.resolve({ success: true, data: { secret: 'PRIVATE' } })
    else {
      const snapshot = trialSnapshot(failure === 'backend_running' ? 'running' : null)
      if (failure === 'backend_unavailable') { snapshot.available = false; snapshot.unavailable_code = 'backend_closing' }
      if (failure === 'loaded_cap') snapshot.limits.max_output_tokens = 128
      read.resolve(ok(snapshot))
    }
    await flush(); parked(f, { error: failure }); assert.deepEqual(f.state().report, report)
    assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE/); assert.equal(f.calls.startPromptTrial.length, 1); await quiet(f)
    const retry = await resumeRead(f); assert.equal(f.state().error_code, null)
    retry.resolve(ok(trialSnapshot())); await flush()
    assert.equal(f.calls.startPromptTrial.length, 2); assert.equal(f.calls.startPromptTrial[1].args[0].request_id, id(103))
  })
}

for (const boundary of ['parked', 'resume delay', 'resume readiness']) {
  for (const action of ['pause', 'stop', 'dispose']) {
    test(`${action} during ${boundary} wins and no stale readiness can submit`, async () => {
      const f = fixture(); await ready(f); f.runner.pause(f.runId()); await admit(f)
      if (boundary === 'resume delay') assert.equal(await f.runner.resume(f.runId()), true)
      if (boundary === 'resume readiness') await resumeRead(f)
      const runId = f.runId(), before = f.state()
      f.runner[action](runId)
      if (boundary === 'resume readiness') {
        if (action === 'dispose') assert.equal(f.calls.getPromptTrials.at(-1).signal.aborted, true)
        f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
      }
      if (action === 'pause') { parked(f); if (boundary === 'parked') assert.deepEqual(f.state(), before) }
      else if (action === 'stop') { assert.equal(f.state().report.status, 'stopped'); assert.equal(f.state().report.stop_requested, true); assert.equal(await f.runner.resume(runId), false) }
      else { assert.equal(f.state().phase, 'disposed'); assert.equal(f.state().can_pause, false); assert.equal(f.state().can_resume, false); assert.equal(await f.runner.resume(runId), false) }
      assert.equal(f.calls.startPromptTrial.length, 1); await quiet(f)
    })
  }
}

test('Stop while Pause awaits accepted work remains sticky until observation settles', async () => {
  const f = fixture(); await ready(f); f.runner.pause(f.runId()); f.runner.stop(); await admit(f, 'running')
  assert.equal(f.state().can_pause, false); assert.equal(f.state().can_resume, false)
  await f.timers.advance(1500); f.calls.getPromptTrial[0].resolve(ok(observation(f))); await flush()
  assert.equal(f.state().report.status, 'stopped'); assert.equal(await f.runner.resume(f.runId()), false); await quiet(f)
})

test('late failure from readiness canceled by Pause stays paused without a fabricated case or error', async () => {
  const f = fixture(); await ready(f); await admit(f); await f.timers.advance(1500); f.runner.pause(f.runId())
  f.calls.getPromptTrials.at(-1).reject(new Error('PRIVATE')); await flush(); parked(f)
  assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE/); await quiet(f)
})

test('Pause and immediate Resume retire an already settled readiness continuation before it can submit', async () => {
  const f = fixture(); await ready(f); await admit(f); await f.timers.advance(1500)
  f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot()))
  // The transport is settled, but continueRun has not consumed its result yet.
  await Promise.resolve()
  assert.equal(f.runner.pause(f.runId()), true); parked(f)
  assert.equal(await f.runner.resume(f.runId()), true); await flush()
  assert.equal(f.calls.startPromptTrial.length, 1); assert.equal(f.timers.pending.size, 1)
  await f.timers.advance(1499); assert.equal(f.calls.getPromptTrials.length, 2)
  await f.timers.advance(1); assert.equal(f.calls.getPromptTrials.length, 3)
  f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush()
  assert.equal(f.calls.startPromptTrial.length, 2); assert.equal(f.calls.startPromptTrial[1].args[0].request_id, id(103))
})

test('stale handlers from a stopped run cannot Pause or Resume a replacement run', async () => {
  const f = fixture(); await ready(f); f.runner.pause(f.runId()); await admit(f); const oldId = f.runId()
  f.runner.stop(); await ready(f); const currentId = f.runId(), before = f.state()
  assert.notEqual(currentId, oldId); assert.equal(f.runner.pause(oldId), false); assert.equal(await f.runner.resume(oldId), false)
  assert.deepEqual(f.state(), before); f.runner.pause(currentId); await admit(f); const saved = f.state()
  assert.equal(await f.runner.resume(oldId), false); assert.deepEqual(f.state(), saved)
  assert.equal(f.runner.pause(currentId), false); await quiet(f)
})
