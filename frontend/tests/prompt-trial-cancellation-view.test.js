import assert from 'node:assert/strict'
import test from 'node:test'
import { mountTrials, trialSnapshot, trialRequest, runId, nextRunId, ok, flush } from './helpers/prompt-trials-view-fixture.js'
import { parsePromptTrialFile } from '../src/utils/promptTrialFiles.js'

const instanceId = '22345678-1234-4234-9234-123456789abc'
const anotherInstance = '22345678-1234-4234-9234-123456789abd'
const fresh = (state = 'running', source = null) => {
  const data = trialSnapshot(state)
  data.run.instance_id = instanceId
  if (source) {
    data.run.request_id = source.request_id
    data.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, source[key]]))
  }
  return data
}
const stopped = (state = 'cancelled', source = null) => {
  const data = fresh(state, source)
  data.run.error_code = 'user_cancelled'; data.run.response = null
  if (state === 'running') data.run.cleanup.state = 'running'
  return data
}
const enabled = v => !!v.byId('trial-stop') && !v.byId('trial-stop').props.disabled
async function idle(v, data = trialSnapshot()) { v.requests.calls.getPromptTrials.at(-1).resolve(ok(data)); await flush() }
async function start(v) {
  await idle(v)
  for (const [key, value] of Object.entries(trialRequest())) await v.input('trial-' + key, value)
  await v.submit('trial-form')
  return v.requests.calls.startPromptTrial.at(-1).args[0]
}
async function admitted(v) {
  const source = await start(v)
  v.requests.calls.startPromptTrial.at(-1).resolve(ok(fresh('running', source))); await flush()
  return source
}
function invoke(handler) { handler({ button: 0, stopPropagation() {}, preventDefault() {} }) }

for (const locale of ['en', 'zh']) test(`explicit stop adopts passive current identity, freezes settings and observes cleanup in ${locale}`, async () => {
  const v = await mountTrials({ locale, cancellation: true })
  try {
    const data = fresh(); await idle(v, data)
    assert.equal(enabled(v), true)
    assert.match(v.text(v.byId('trial-stop')), locale === 'en' ? /Stop waiting for this trial/ : /停止等待此试验/)
    assert.match(v.text(), locale === 'en' ? /another tab or suite/ : /其他标签页或套件/)
    await v.input('trial-user_prompt', 'Next draft')
    await v.click('trial-stop')
    const call = v.requests.calls.cancelPromptTrial[0]
    assert.deepEqual({ ...call.args[0] }, { request_id: runId, instance_id: instanceId, fingerprint: 'a'.repeat(64) })
    assert.equal(enabled(v), false); assert.equal(call.signal.aborted, false)
    data.run.instance_id = anotherInstance; data.run.request.user_prompt = 'MUTATED'
    call.resolve(ok(stopped('running'))); await flush()
    assert.equal(enabled(v), false)
    assert.match(v.text(v.byId('trial-state')), locale === 'en' ? /Running/ : /运行中/)
    assert.match(v.text(v.byId('trial-notice')), locale === 'en' ? /cleanup/ : /清理/)
    await v.timers.advance(1500)
    assert.equal(v.requests.calls.getPromptTrial[0].args[0], runId)
    v.requests.calls.getPromptTrial[0].resolve(ok(stopped())); await flush()
    assert.match(v.text(v.byId('trial-state')), locale === 'en' ? /Cancelled/ : /已取消/)
    assert.equal(v.byId('trial-user_prompt').props.value, 'Next draft')
    await v.click('trial-pin'); await v.click('trial-download')
    const saved = JSON.parse(await v.downloads[0].blob.text())
    assert.deepEqual(saved, stopped())
    assert.deepEqual(parsePromptTrialFile(JSON.stringify(saved)).snapshots[0], saved)
    await v.click('trial-reuse'); assert.equal(v.byId('trial-user_prompt').props.value, 'Hello')
    await v.timers.advance(100000)
    assert.equal(v.requests.calls.getPromptTrials.length, 1); assert.equal(v.requests.calls.getPromptTrial.length, 1)
    assert.equal(v.requests.calls.startPromptTrial.length, 0); assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})

for (const kind of ['old running', 'terminal', 'stale', 'no run']) test(`${kind} current observation has no stop action`, async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v, kind === 'old running' ? trialSnapshot('running') : kind === 'terminal' ? fresh('succeeded') : kind === 'no run' ? trialSnapshot() : fresh())
    if (kind === 'stale') { await v.click('trial-refresh'); v.requests.calls.getPromptTrials.at(-1).reject(new Error('PRIVATE')); await flush() }
    assert.equal(enabled(v), false); assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
  } finally { v.unmount() }
})

test('unresolved start and lost admission never offer cancellation before exact admission is confirmed', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    const source = await start(v)
    assert.equal(enabled(v), false)
    v.requests.calls.startPromptTrial[0].reject(new Error('PRIVATE')); await flush()
    assert.equal(enabled(v), false); assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
    v.requests.calls.getPromptTrial[0].resolve(ok(fresh('running', source))); await flush()
    assert.equal(enabled(v), true)
    await v.click('trial-stop')
    assert.equal(v.requests.calls.cancelPromptTrial[0].args[0].request_id, source.request_id)
    assert.equal(v.requests.calls.startPromptTrial.length, 1)
  } finally { v.unmount() }
})

for (const cacheHandlers of [true, false]) test(`render-local stop handler cannot target a replaced observation (cacheHandlers=${cacheHandlers})`, async () => {
  const v = await mountTrials({ cacheHandlers, cancellation: true })
  try {
    await idle(v, fresh())
    assert.equal(enabled(v), true)
    const old = v.byId('trial-stop').props.onClick
    await v.click('trial-refresh')
    invoke(old); await flush(); assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
    const replacement = fresh(); replacement.run.request_id = nextRunId; replacement.run.instance_id = anotherInstance
    await idle(v, replacement)
    invoke(old); await flush(); assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
    await v.click('trial-stop')
    assert.equal(v.requests.calls.cancelPromptTrial[0].args[0].request_id, nextRunId)
    assert.equal(v.requests.calls.cancelPromptTrial[0].args[0].instance_id, anotherInstance)
  } finally { v.unmount() }
})

test('same-observation duplicate stop and old handlers cannot overlap a stop or replay it after reconciliation', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    const source = await admitted(v)
    assert.equal(enabled(v), true)
    const handler = v.byId('trial-stop').props.onClick
    invoke(handler); invoke(handler); await flush()
    assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
    v.requests.calls.cancelPromptTrial[0].reject(new Error('PRIVATE')); await flush()
    invoke(handler); await flush(); assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
    v.requests.calls.getPromptTrial.at(-1).resolve(ok(fresh('running', source))); await flush()
    assert.equal(enabled(v), true)
    assert.match(v.text(v.byId('trial-notice')), /not confirmed/)
    invoke(handler); await flush(); assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
    await v.click('trial-stop'); assert.equal(v.requests.calls.cancelPromptTrial.length, 2)
    assert.equal(v.requests.calls.getPromptTrials.length, 1); assert.equal(v.requests.calls.startPromptTrial.length, 1)
  } finally { v.unmount() }
})

for (const mismatch of ['instance', 'missing instance', 'fingerprint', 'inputs', 'id']) test(`owned observation rejects changed ${mismatch} and keeps stop disabled`, async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    const source = await admitted(v), data = fresh('running', source)
    const old = v.byId('trial-stop')?.props.onClick
    assert.ok(old)
    await v.timers.advance(1500)
    if (mismatch === 'instance') data.run.instance_id = anotherInstance
    if (mismatch === 'missing instance') delete data.run.instance_id
    if (mismatch === 'fingerprint') data.run.fingerprint = 'b'.repeat(64)
    if (mismatch === 'inputs') data.run.request.user_prompt = 'PRIVATE'
    if (mismatch === 'id') data.run.request_id = nextRunId
    v.requests.calls.getPromptTrial[0].resolve(ok(data)); await flush()
    assert.ok(v.byId('trial-stale')); assert.equal(enabled(v), false)
    invoke(old); await flush(); assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
    assert.doesNotMatch(v.text(), /PRIVATE/)
  } finally { v.unmount() }
})

for (const outcome of ['cancelled', 'running accepted', 'running unconfirmed', 'succeeded', '404', 'different instance']) test(`lost stop acknowledgment reconciles exact ID only: ${outcome}`, async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v, fresh()); assert.equal(enabled(v), true); await v.click('trial-stop')
    v.requests.calls.cancelPromptTrial[0].reject(new Error('PRIVATE')); await flush()
    assert.equal(v.requests.calls.getPromptTrial[0].args[0], runId)
    assert.equal(enabled(v), false)
    if (outcome === '404') v.requests.calls.getPromptTrial[0].reject({ response: { status: 404, data: { success: false, error_code: 'run_not_found' } } })
    else {
      const data = outcome === 'cancelled' ? stopped() : outcome === 'running accepted' ? stopped('running') : fresh(outcome === 'succeeded' ? 'succeeded' : 'running')
      if (outcome === 'different instance') data.run.instance_id = anotherInstance
      v.requests.calls.getPromptTrial[0].resolve(ok(data))
    }
    await flush(); await v.timers.advance(100000)
    assert.equal(v.requests.calls.cancelPromptTrial.length, 1); assert.equal(v.requests.calls.startPromptTrial.length, 0)
    assert.equal(v.requests.calls.getPromptTrials.length, 1)
    assert.doesNotMatch(v.text(), /PRIVATE/)
    if (['404', 'different instance'].includes(outcome)) {
      assert.ok(v.byId('trial-stale')); assert.equal(enabled(v), false)
      await v.click('trial-refresh'); assert.equal(v.requests.calls.getPromptTrial.at(-1).args[0], runId)
    } else if (outcome === 'succeeded') assert.match(v.text(v.byId('trial-state')), /Succeeded/)
    else if (outcome === 'cancelled') assert.match(v.text(v.byId('trial-state')), /Cancelled/)
  } finally { v.unmount() }
})

test('a stop response that has no cancellation decision triggers read reconciliation without claiming success', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v, fresh()); assert.equal(enabled(v), true); await v.click('trial-stop')
    v.requests.calls.cancelPromptTrial[0].resolve(ok(fresh())); await flush()
    assert.equal(v.requests.calls.getPromptTrial.length, 1)
    v.requests.calls.getPromptTrial[0].resolve(ok(fresh())); await flush()
    assert.match(v.text(v.byId('trial-notice')), /not confirmed/); assert.equal(enabled(v), true)
    assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
  } finally { v.unmount() }
})

test('a completed reply that wins the stop race remains completed and downloadable', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    const source = await admitted(v); assert.equal(enabled(v), true); await v.click('trial-stop')
    v.requests.calls.cancelPromptTrial[0].resolve(ok(fresh('succeeded', source))); await flush()
    assert.match(v.text(v.byId('trial-state')), /Succeeded/); assert.equal(enabled(v), false)
    await v.click('trial-download')
    assert.equal(JSON.parse(await v.downloads[0].blob.text()).run.response.content, 'Hello back')
    await v.timers.advance(100000); assert.equal(v.requests.calls.getPromptTrial.length, 0)
  } finally { v.unmount() }
})

for (const phase of ['stop', 'cleanup poll', 'start', 'poll']) test(`navigation aborts ${phase} transport and ignores late replies without implicit cancellation`, async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    let pending, result
    if (phase === 'start') { const source = await start(v); pending = v.requests.calls.startPromptTrial[0]; result = fresh('running', source) }
    else {
      const source = await admitted(v); assert.equal(enabled(v), true)
      if (phase !== 'poll') {
        await v.click('trial-stop'); pending = v.requests.calls.cancelPromptTrial[0]; result = stopped('running', source)
        if (phase === 'cleanup poll') { pending.resolve(ok(result)); await flush() }
      }
      if (phase.endsWith('poll')) { await v.timers.advance(1500); pending = v.requests.calls.getPromptTrial[0]; result = stopped('cancelled', source) }
    }
    const count = v.requests.calls.cancelPromptTrial.length
    await v.navigate('/'); assert.equal(pending.signal.aborted, true)
    await v.navigate('/prompt-trials'); pending.resolve(ok(result)); await flush()
    assert.equal(v.byId('trial-result'), undefined)
    await idle(v, fresh()); assert.equal(enabled(v), true)
    assert.equal(v.requests.calls.cancelPromptTrial.length, count)
    assert.equal(v.timers.pending.size, 0); assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})

test('adopted cancellation cleanup polling is bounded and stale control never resends a stop', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v, fresh()); assert.equal(enabled(v), true); await v.click('trial-stop')
    v.requests.calls.cancelPromptTrial[0].resolve(ok(stopped('running'))); await flush()
    for (let i = 0; i < 60; i++) {
      await v.timers.advance(1500); assert.equal(v.requests.calls.getPromptTrial.length, i + 1)
      v.requests.calls.getPromptTrial[i].resolve(ok(stopped('running'))); await flush()
    }
    assert.ok(v.byId('trial-stale')); assert.equal(enabled(v), false)
    await v.timers.advance(1000000)
    assert.equal(v.requests.calls.getPromptTrial.length, 60); assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
    assert.equal(v.requests.calls.getPromptTrials.length, 1); assert.equal(v.requests.calls.startPromptTrial.length, 0)
  } finally { v.unmount() }
})

test('imported and pinned historical cancellation records never provide a stop target', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v)
    const data = stopped(), bytes = new TextEncoder().encode(JSON.stringify(data))
    await v.byId('trial-import-file').props.onChange({ target: { files: [{ name: 'cancelled.json', size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer }], value: 'cancelled.json' } }); await flush()
    assert.ok(v.byId('trial-import-preview')); assert.equal(enabled(v), false)
    await v.click('trial-import-add'); assert.ok(v.byId(`pin-item-${runId}`)); assert.equal(enabled(v), false)
    await v.click(`pin-reuse-${runId}`); await v.click(`pin-download-${runId}`)
    assert.equal(enabled(v), false); assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
    assert.equal(v.requests.calls.getPromptTrial.length, 0); assert.equal(v.requests.calls.startPromptTrial.length, 0)
  } finally { v.unmount() }
})

test('a retired stop handler cannot act after navigation; the newly read live observation can', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v, fresh()); const old = v.byId('trial-stop')?.props.onClick; assert.ok(old)
    await v.navigate('/'); await v.navigate('/prompt-trials')
    await idle(v, fresh()); invoke(old); await flush()
    assert.equal(v.requests.calls.cancelPromptTrial.length, 0)
    await v.click('trial-stop')
    assert.deepEqual({ ...v.requests.calls.cancelPromptTrial[0].args[0] }, { request_id: runId, instance_id: instanceId, fingerprint: 'a'.repeat(64) })
    assert.equal(v.requests.calls.startPromptTrial.length, 0)
  } finally { v.unmount() }
})

for (const mismatch of ['instance', 'missing instance', 'inputs', 'fingerprint', 'id']) test(`stop reply rejects changed ${mismatch} and reconciles the adopted exact identity`, async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    await idle(v, fresh()); await v.click('trial-stop')
    const changed = stopped()
    if (mismatch === 'instance') changed.run.instance_id = anotherInstance
    if (mismatch === 'missing instance') delete changed.run.instance_id
    if (mismatch === 'inputs') changed.run.request.user_prompt = 'PRIVATE'
    if (mismatch === 'fingerprint') changed.run.fingerprint = 'b'.repeat(64)
    if (mismatch === 'id') changed.run.request_id = nextRunId
    v.requests.calls.cancelPromptTrial[0].resolve(ok(changed)); await flush()
    assert.equal(v.requests.calls.getPromptTrial[0].args[0], runId)
    assert.equal(enabled(v), false); assert.doesNotMatch(v.text(), /PRIVATE/)
    v.requests.calls.getPromptTrial[0].resolve(ok(stopped())); await flush()
    assert.match(v.text(v.byId('trial-state')), /Cancelled/)
    assert.equal(v.requests.calls.getPromptTrials.length, 1); assert.equal(v.requests.calls.cancelPromptTrial.length, 1)
  } finally { v.unmount() }
})

test('a legacy owned observation becomes cancellable only when its instance has been confirmed', async () => {
  const v = await mountTrials({ cancellation: true })
  try {
    const source = await start(v), legacy = fresh('running', source); delete legacy.run.instance_id
    v.requests.calls.startPromptTrial[0].resolve(ok(legacy)); await flush()
    assert.equal(enabled(v), false)
    await v.timers.advance(1500); v.requests.calls.getPromptTrial[0].resolve(ok(fresh('running', source))); await flush()
    assert.equal(enabled(v), true); await v.click('trial-stop')
    assert.equal(v.requests.calls.cancelPromptTrial[0].args[0].instance_id, instanceId)
  } finally { v.unmount() }
})
