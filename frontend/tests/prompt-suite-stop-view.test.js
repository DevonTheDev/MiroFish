import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { parsePromptSuiteReport } from '../src/utils/promptSuites.js'

// Exercise retained callbacks from the actual compiled Vue page and real runner.
// This synthetic renderer is callback-level coverage, not a browser reproduction.
const event = () => ({ button: 0, preventDefault() {}, stopPropagation() {} })
const stopHandler = view => view.byId('suite-stop').props.onClick
const counts = view => Object.fromEntries(Object.entries(view.requests.calls).map(([key, calls]) => [key, calls.length]))
async function invoke(handler) { handler(event()); await flush() }
async function readiness(view) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush() }
async function fill(view) {
  await view.input('suite-name', 'Stop ownership')
  for (let index = 0; index < 2; index++) {
    if (index) await view.click('suite-add-case')
    for (const [key, value] of Object.entries({ ...trialRequest(), label: `Case ${index + 1}` })) {
      await view.input(`suite-case-${index}-${key}`, value)
    }
  }
}
async function start(view) { await view.submit('suite-form'); await readiness(view) }
function observation(view, state = 'succeeded') {
  const request = view.requests.calls.startPromptTrial.at(-1).args[0], snapshot = trialSnapshot(state)
  snapshot.run.request_id = request.request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  return snapshot
}
async function settle(view, state = 'succeeded') {
  view.requests.calls.startPromptTrial.at(-1).resolve(ok(observation(view, state))); await flush()
}
async function report(view) {
  await view.click('suite-export-run')
  return parsePromptSuiteReport(await view.downloads.at(-1).blob.text())
}
async function finishA(view, outcome) {
  await start(view); await settle(view); await view.click('suite-pause')
  const stop = stopHandler(view)
  if (outcome === 'stopped') await view.click('suite-stop')
  else {
    await view.click('suite-resume'); await view.timers.advance(1500); await readiness(view); await settle(view)
  }
  return stop
}

for (const cacheHandlers of [false, true]) {
  for (const outcome of ['completed', 'stopped']) {
    for (const phase of ['checking', 'running', 'paused']) {
      test(`retained Stop from ${outcome} A cannot stop B during ${phase} (cacheHandlers=${cacheHandlers})`, async () => {
        const view = await mountSuites({ cacheHandlers })
        try {
          await readiness(view); await fill(view)
          const oldStop = await finishA(view, outcome), oldReport = await report(view)
          await view.submit('suite-form')
          if (phase !== 'checking') await readiness(view)
          if (phase === 'paused') { await settle(view); await view.click('suite-pause') }
          const before = await report(view), beforeCounts = counts(view), timers = view.timers.pending.size
          await invoke(oldStop); await invoke(oldStop)
          assert.deepEqual(await report(view), before, 'a retired Stop must not mutate the displayed report')
          assert.deepEqual(counts(view), beforeCounts); assert.equal(view.timers.pending.size, timers)
          if (phase === 'checking') {
            assert.deepEqual(before, oldReport, 'initial readiness still displays A, so run_id alone cannot own Stop')
            await readiness(view)
            assert.equal(view.requests.calls.startPromptTrial.length, beforeCounts.startPromptTrial + 1,
              'retired Stop must not suppress B admission')
          } else assert.notEqual(before.run_id, oldReport.run_id)
          if (phase !== 'paused') { await settle(view); await view.click('suite-pause') }
          assert.equal(view.byId('suite-scheduling-state').props['data-phase'], 'paused')
          const paused = await report(view), parkedCounts = counts(view)
          await invoke(oldStop); await view.timers.advance(100000)
          assert.deepEqual(await report(view), paused); assert.deepEqual(counts(view), parkedCounts)
          await view.click('suite-stop')
          const stopped = await report(view)
          assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stop_requested, true)
          assert.equal(stopped.cases[1].status, 'not_attempted'); assert.deepEqual(view.warnings, [])
        } finally { view.unmount() }
      })
    }

    test(`retired Stop cannot stop replacement readiness before Vue rerenders (A ${outcome}, cacheHandlers=${cacheHandlers})`, async () => {
      const view = await mountSuites({ cacheHandlers })
      try {
        await readiness(view); await fill(view)
        const oldStop = await finishA(view, outcome), saved = await report(view), before = counts(view)
        // No microtask/render flush separates B's synchronous start and A's callback.
        view.byId('suite-form').props.onSubmit(event()); oldStop(event())
        await readiness(view)
        assert.equal(view.requests.calls.startPromptTrial.length, before.startPromptTrial + 1)
        assert.notEqual((await report(view)).run_id, saved.run_id)
        assert.equal((await report(view)).stop_requested, false)
      } finally { view.unmount() }
    })
  }

  for (const previousReport of [false, true]) {
    test(`current Stop works during initial readiness with previous report=${previousReport} (cacheHandlers=${cacheHandlers})`, async () => {
      const view = await mountSuites({ cacheHandlers })
      try {
        await readiness(view); await fill(view)
        if (previousReport) await finishA(view, 'completed')
        const saved = previousReport ? await report(view) : null, before = counts(view)
        await view.submit('suite-form')
        const currentStop = stopHandler(view), read = view.requests.calls.getPromptTrials.at(-1)
        assert.equal(view.byId('suite-stop').props.disabled, false)
        await invoke(currentStop); await invoke(currentStop)
        assert.equal(read.signal.aborted, false)
        await readiness(view); await view.timers.advance(100000)
        assert.equal(view.requests.calls.startPromptTrial.length, before.startPromptTrial)
        assert.equal(view.timers.pending.size, 0); assert.equal(view.byId('suite-run').props.disabled, false)
        if (saved) assert.deepEqual(await report(view), saved)
        else assert.equal(!!view.byId('suite-run-report'), false)
        await start(view)
        const replacement = await report(view)
        await invoke(currentStop)
        assert.deepEqual(await report(view), replacement)
      } finally { view.unmount() }
    })
  }

  for (const phase of ['active', 'pause_pending', 'paused', 'resume_delay', 'resume_readiness']) {
    test(`current Stop during ${phase} preserves owned work and prevents further POSTs (cacheHandlers=${cacheHandlers})`, async () => {
      const view = await mountSuites({ cacheHandlers })
      try {
        await readiness(view); await fill(view); await start(view)
        const captured = await report(view), post = view.requests.calls.startPromptTrial[0]
        if (phase !== 'active') await view.click('suite-pause')
        if (!['active', 'pause_pending'].includes(phase)) await settle(view)
        if (phase.startsWith('resume_')) await view.click('suite-resume')
        if (phase === 'resume_readiness') await view.timers.advance(1500)
        const stop = stopHandler(view)
        await invoke(stop); await invoke(stop)
        if (['active', 'pause_pending'].includes(phase)) {
          assert.equal(post.signal.aborted, false); await settle(view, 'running')
          await view.timers.advance(1500)
          const exact = view.requests.calls.getPromptTrial.at(-1)
          assert.equal(exact.args[0], post.args[0].request_id); assert.equal(exact.signal.aborted, false)
          exact.resolve(ok(observation(view))); await flush()
        } else if (phase === 'resume_readiness') await readiness(view)
        const stopped = await report(view), before = counts(view)
        assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stop_requested, true)
        assert.equal(stopped.run_id, captured.run_id); assert.deepEqual(stopped.definition, captured.definition)
        assert.equal(stopped.cases[0].request_id, post.args[0].request_id)
        assert.equal(stopped.cases[1].request_id, null); assert.equal(stopped.cases[1].status, 'not_attempted')
        await invoke(stop); await view.timers.advance(100000)
        assert.deepEqual(await report(view), stopped); assert.deepEqual(counts(view), before)
        assert.equal(view.requests.calls.startPromptTrial.length, 1); assert.equal(view.timers.pending.size, 0)
        assert.equal(view.byId('suite-resume').props.disabled, true); assert.deepEqual(view.warnings, [])
      } finally { view.unmount() }
    })
  }

  test(`disabled idle and disposed Stop callbacks cannot affect a later run (cacheHandlers=${cacheHandlers})`, async () => {
    const view = await mountSuites({ cacheHandlers })
    let unmounted = false
    try {
      const idleStop = stopHandler(view)
      await readiness(view); await fill(view); await start(view)
      const captured = await report(view)
      await invoke(idleStop); assert.deepEqual(await report(view), captured)
      const oldStop = stopHandler(view), pending = view.requests.calls.startPromptTrial.at(-1), late = observation(view)
      await view.navigate('/'); assert.equal(pending.signal.aborted, true)
      await view.navigate('/prompt-suites'); await readiness(view); await fill(view); await start(view)
      await settle(view); await view.click('suite-pause')
      const current = await report(view), before = counts(view)
      pending.resolve(ok(late)); await invoke(oldStop); await view.timers.advance(100000)
      assert.deepEqual(await report(view), current); assert.deepEqual(counts(view), before)
      const currentStop = stopHandler(view)
      view.unmount(); unmounted = true
      await invoke(currentStop); await view.timers.advance(100000)
      assert.deepEqual(counts(view), before); assert.equal(view.timers.pending.size, 0)
    } finally { if (!unmounted) view.unmount() }
  })
}
