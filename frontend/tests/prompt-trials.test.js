import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountTrials, trialSnapshot, trialRequest, trialApi, runId, nextRunId, ok, flush } from './helpers/prompt-trials-view-fixture.js'

test('prompt trials is a discoverable real application route', () => {
  const router = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
  assert.match(router, /path: '\/prompt-trials'/)
  for (const file of ['Home.vue', 'RuntimeStatusView.vue']) assert.match(readFileSync(new URL('../src/views/' + file, import.meta.url), 'utf8'), /to="\/prompt-trials"/)
})

export async function idle(view, snapshot = trialSnapshot()) {
  view.requests.calls.getPromptTrials.at(-1).resolve(ok(snapshot)); await flush()
}
export async function fill(view, request = trialRequest()) {
  for (const key of Object.keys(request)) await view.input('trial-' + key, request[key])
}
export function ownedSnapshot(view, state = 'running') {
  const request = view.requests.calls.startPromptTrial.at(-1).args[0]
  const data = trialSnapshot(state)
  data.run.request_id = request.request_id
  data.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  return data
}
export async function run(view) {
  await idle(view); await fill(view); await view.submit('trial-form')
  view.requests.calls.startPromptTrial.at(-1).resolve(ok(ownedSnapshot(view))); await flush()
}

test('passive mount and refresh never run inference or poll an unowned active trial', async () => {
  const v = await mountTrials()
  try {
    await idle(v, trialSnapshot('running'))
    await v.timers.advance(1000000)
    assert.equal(v.requests.calls.getPromptTrials.length, 1)
    assert.equal(v.requests.calls.getPromptTrial.length, 0)
    assert.equal(v.requests.calls.startPromptTrial.length, 0)
    assert.ok(v.byId('trial-run').props.disabled)
    await v.click('trial-refresh')
    await idle(v)
    assert.equal(v.requests.calls.getPromptTrials.length, 2)
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})

test('explicit run freezes exact input with a fresh UUID and only observes that identity', async () => {
  const v = await mountTrials()
  try {
    await idle(v); await fill(v)
    await v.submit('trial-form'); await v.submit('trial-form')
    assert.equal(v.requests.calls.startPromptTrial.length, 1)
    const sent = v.requests.calls.startPromptTrial[0].args[0]
    assert.match(sent.request_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.deepEqual({ ...sent, request_id: undefined }, { ...trialRequest(), request_id: undefined })
    await v.input('trial-user_prompt', 'Next draft')
    assert.equal(sent.user_prompt, 'Hello')
    v.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(v))); await flush()
    await v.timers.advance(1500)
    assert.equal(v.requests.calls.getPromptTrial[0].args[0], sent.request_id)
    await v.timers.advance(100000)
    assert.equal(v.requests.calls.getPromptTrial.length, 1)
    v.requests.calls.getPromptTrial[0].resolve(ok(ownedSnapshot(v, 'succeeded'))); await flush()
    await v.timers.advance(100000)
    assert.equal(v.requests.calls.getPromptTrial.length, 1)
    assert.equal(v.byId('trial-user_prompt').props.value, 'Next draft')
    assert.equal(v.byId('trial-download').props.disabled, false)
  } finally { v.unmount() }
})

for (const locale of ['en', 'zh']) test(`cloud mode has no active controls in ${locale}`, async () => {
  const v = await mountTrials({ locale })
  try {
    const data = trialSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required' }); data.limits.max_output_tokens = null
    await idle(v, data); await fill(v); await v.submit('trial-form'); await v.timers.advance(100000)
    assert.equal(v.requests.calls.startPromptTrial.length, 0)
    assert.ok(v.byId('trial-run').props.disabled)
    assert.match(v.text(), locale === 'en' ? /only in local mode/ : /仅在本地模式/)
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})

for (const outcome of ['owned running', 'owned terminal', 'unrelated', 'not found', 'network failure', 'changed input']) {
  test(`lost POST reconciles ${outcome} by exact ID without replay or adopting unrelated state`, async () => {
    const v = await mountTrials()
    try {
      await idle(v); await fill(v); await v.submit('trial-form')
      v.requests.calls.startPromptTrial[0].reject(new Error('PRIVATE POST')); await flush()
      assert.equal(v.requests.calls.getPromptTrial.length, 1)
      assert.equal(v.requests.calls.getPromptTrials.length, 1)
      const read = v.requests.calls.getPromptTrial[0]
      assert.equal(read.args[0], v.requests.calls.startPromptTrial[0].args[0].request_id)
      if (outcome === 'network failure') read.reject(new Error('PRIVATE READ'))
      else if (outcome === 'not found') read.reject({ response: { status: 404, data: { success: false, error_code: 'run_not_found' } } })
      else {
        const data = ownedSnapshot(v, outcome === 'owned running' ? 'running' : 'succeeded')
        if (outcome === 'unrelated') data.run.request_id = nextRunId
        if (outcome === 'changed input') data.run.request.user_prompt = 'DIFFERENT'
        read.resolve(ok(data))
      }
      await flush()
      assert.equal(v.requests.calls.startPromptTrial.length, 1)
      assert.doesNotMatch(v.text(), /PRIVATE|DIFFERENT/)
      if (outcome.startsWith('owned')) assert.match(v.text(v.byId('trial-state')), outcome === 'owned running' ? /Running/ : /Succeeded/)
      else {
        assert.ok(v.byId('trial-run').props.disabled)
        assert.ok(v.byId('trial-download').props.disabled)
        assert.equal(v.byId('trial-user_prompt').props.value, 'Hello')
        await v.timers.advance(100000)
        assert.equal(v.requests.calls.getPromptTrial.length, 1)
        await v.click('trial-refresh')
        assert.equal(v.requests.calls.getPromptTrial.length, 2)
      }
    } finally { v.unmount() }
  })
}

test('poll failure marks current output stale and blocks pin/export until explicit exact refresh', async () => {
  const v = await mountTrials()
  try {
    await run(v); await v.timers.advance(1500)
    v.requests.calls.getPromptTrial[0].reject(new Error('private')); await flush()
    assert.ok(v.byId('trial-stale')); assert.ok(v.byId('trial-pin').props.disabled); assert.ok(v.byId('trial-download').props.disabled)
    await v.timers.advance(100000)
    assert.equal(v.requests.calls.getPromptTrial.length, 1)
    await v.click('trial-refresh')
    v.requests.calls.getPromptTrial[1].resolve(ok(ownedSnapshot(v, 'succeeded'))); await flush()
    assert.equal(v.byId('trial-stale'), undefined)
    assert.equal(v.byId('trial-pin').props.disabled, false)
  } finally { v.unmount() }
})

for (const phase of ['initial', 'start', 'reconcile', 'poll']) test(`route retirement aborts ${phase} and ignores late A→B→A responses`, async () => {
  const v = await mountTrials()
  try {
    let old = v.requests.calls.getPromptTrials[0], result = trialSnapshot('succeeded')
    if (phase !== 'initial') {
      await idle(v); await fill(v); await v.submit('trial-form'); old = v.requests.calls.startPromptTrial[0]; result = ownedSnapshot(v, 'succeeded')
      if (phase === 'reconcile') { old.reject(new Error('lost')); await flush(); old = v.requests.calls.getPromptTrial[0] }
      if (phase === 'poll') { old.resolve(ok(ownedSnapshot(v))); await flush(); await v.timers.advance(1500); old = v.requests.calls.getPromptTrial[0] }
    }
    await v.navigate('/'); assert.ok(old.signal.aborted); await v.navigate('/prompt-trials')
    old.resolve(ok(result)); await flush()
    assert.equal(v.byId('trial-result'), undefined)
    await idle(v); await v.timers.advance(100000)
    assert.equal(v.byId('trial-result'), undefined)
    assert.equal(v.timers.pending.size, 0)
    assert.equal(v.byId('trial-user_prompt').props.value, '')
  } finally { v.unmount() }
})

test('literal empty reply, refusal, and provider truncation remain distinct and export captured data', async () => {
  const v = await mountTrials()
  try {
    const data = trialSnapshot('succeeded')
    data.run.request.label = '<b>label</b>'; data.run.response.content = '<think>literal</think>\n<img src=x onerror=alert(1)>'
    data.secret = 'STRIPPED'; data.run.response.unknown = 'STRIPPED'
    await idle(v, data); data.run.response.content = 'MUTATED'
    assert.match(v.text(v.byId('trial-response')), /<think>literal<\/think>/)
    assert.equal(v.all(n => ['img', 'think', 'b'].includes(n.type) || n.props.innerHTML).length, 0)
    await v.click('trial-download')
    const saved = JSON.parse(await v.downloads[0].blob.text())
    assert.equal(saved.run.response.content, '<think>literal</think>\n<img src=x onerror=alert(1)>')
    assert.equal(saved.run.request.label, '<b>label</b>'); assert.doesNotMatch(JSON.stringify(saved), /STRIPPED|MUTATED/)
    assert.equal(v.requests.calls.getPromptTrials.length, 1)
    for (const state of ['succeeded', 'truncated', 'refused']) {
      await v.click('trial-refresh')
      const next = trialSnapshot(state)
      next.run.response.content = state === 'refused' ? null : ''
      next.run.response.finish_reason = state === 'truncated' ? 'length' : state === 'refused' ? 'content_filter' : 'stop'
      for (const field of Object.keys(next.run.response.usage)) next.run.response.usage[field] = null
      await idle(v, next)
      assert.match(v.text(v.byId('trial-response')), state === 'refused' ? /No reply content/ : /empty reply/)
      assert.match(v.text(v.byId('trial-state')), state === 'refused' ? /Refused/ : state === 'truncated' ? /Truncated/ : /Succeeded/)
      assert.match(v.text(), /Not reported/)
    }
  } finally { v.unmount() }
})

test('pins are detached, identity based, capped at ten and compare exactly two captured trials', async () => {
  const v = await mountTrials()
  try {
    const first = trialSnapshot('succeeded'); await idle(v, first); await v.click('trial-pin')
    assert.ok(v.byId('trial-pin').props.disabled)
    first.run.response.content = 'MUTATED'
    for (let i = 1; i < 11; i++) {
      await v.click('trial-refresh'); const d = trialSnapshot('succeeded'); d.run.request_id = `12345678-1234-4234-9234-${String(i).padStart(12, '0')}`; d.run.request.label = `Trial ${i}`; await idle(v, d)
      if (i < 10) await v.click('trial-pin')
      else assert.ok(v.byId('trial-pin').props.disabled)
    }
    assert.equal(v.all(n => n.props['data-testid']?.startsWith('pin-item-')).length, 10)
    const secondId = '12345678-1234-4234-9234-000000000001'
    await v.change('pin-select-' + runId, true); await v.change('pin-select-' + secondId, true)
    assert.equal(v.all(n => n.type === 'article' && n.props['data-testid']?.startsWith('comparison-')).length, 2)
    assert.doesNotMatch(v.text(v.byId('comparison-' + runId)), /MUTATED/)
    await v.click('pin-download-' + runId)
    assert.equal(JSON.parse(await v.downloads[0].blob.text()).run.response.content, 'Hello back')
    await v.click('pin-reuse-' + runId)
    assert.equal(v.byId('trial-user_prompt').props.value, 'Hello')
    assert.equal(v.requests.calls.startPromptTrial.length, 0)
    await v.click('pin-remove-' + runId)
    assert.equal(v.byId('comparison-' + runId), undefined)
    assert.equal(v.byId('trial-pin').props.disabled, false)
    await v.navigate('/'); await v.navigate('/prompt-trials'); await idle(v)
    assert.equal(v.all(n => n.props['data-testid']?.startsWith('pin-item-')).length, 0)
  } finally { v.unmount() }
})

for (const [status, code] of [[400, 'invalid_request'], [403, 'local_mode_required'], [403, 'local_browser_required'], [409, 'already_running'], [409, 'request_conflict']]) {
  test(`definitive admission refusal ${code} permits deliberate fresh-status recovery without reconciliation`, async () => {
    const v = await mountTrials()
    try {
      await idle(v); await fill(v); await v.submit('trial-form')
      v.requests.calls.startPromptTrial[0].reject({ response: { status, data: { success: false, error_code: code, error: 'RAW SECRET', data: trialSnapshot('succeeded') } } }); await flush()
      assert.equal(v.requests.calls.getPromptTrial.length, 0)
      assert.match(v.text(v.byId('trial-notice')), /did not admit/)
      assert.doesNotMatch(v.text(), /RAW SECRET|Hello back/)
      await v.click('trial-refresh'); await idle(v)
      assert.equal(v.byId('trial-label').props.value, 'Trial one')
      await v.submit('trial-form')
      assert.equal(v.requests.calls.startPromptTrial.length, 2)
      assert.notEqual(v.requests.calls.startPromptTrial[0].args[0].request_id, v.requests.calls.startPromptTrial[1].args[0].request_id)
    } finally { v.unmount() }
  })
}

test('explicit release preserves pins/draft, observes latest and requires a new Run with a new ID', async () => {
  const v = await mountTrials()
  try {
    await idle(v, trialSnapshot('succeeded')); await v.click('trial-pin'); await fill(v); await v.submit('trial-form')
    v.requests.calls.startPromptTrial[0].reject(new Error('lost')); await flush()
    v.requests.calls.getPromptTrial[0].reject({ response: { status: 404 } }); await flush()
    assert.match(v.text(), /old request may have run/)
    await v.click('trial-release')
    assert.equal(v.requests.calls.startPromptTrial.length, 1)
    await idle(v)
    assert.equal(v.byId('trial-user_prompt').props.value, 'Hello')
    assert.ok(v.byId('pin-item-' + runId))
    await v.submit('trial-form')
    assert.equal(v.requests.calls.startPromptTrial.length, 2)
    assert.notEqual(v.requests.calls.startPromptTrial[0].args[0].request_id, v.requests.calls.startPromptTrial[1].args[0].request_id)
  } finally { v.unmount() }
})

test('comparison JSON captures exactly two selected snapshots and remains available when current status is stale', async () => {
  const v = await mountTrials()
  try {
    await idle(v, trialSnapshot('succeeded')); await v.click('trial-pin')
    await v.click('trial-refresh'); const second = trialSnapshot('succeeded'); second.run.request_id = nextRunId; second.run.response.content = 'second'; await idle(v, second); await v.click('trial-pin')
    await v.change('pin-select-' + nextRunId, true); await v.change('pin-select-' + runId, true)
    await v.click('comparison-download')
    const exported = JSON.parse(await v.downloads[0].blob.text())
    assert.deepEqual(Object.keys(exported), ['schema_version', 'kind', 'trials'])
    assert.equal(exported.schema_version, 1); assert.equal(exported.kind, 'mirofish_local_prompt_trial_comparison')
    assert.deepEqual(exported.trials.map(d => d.run.request_id), [nextRunId, runId])
    assert.deepEqual(exported.trials[0], trialApi().acceptPromptTrialSnapshot(ok(second)))
    assert.equal(v.requests.calls.getPromptTrials.length, 2)
    const oldHandler = v.byId('comparison-download').props.onClick
    await v.click('trial-refresh'); v.requests.calls.getPromptTrials.at(-1).reject(new Error('lost')); await flush()
    assert.equal(v.byId('comparison-download').props.disabled, false)
    assert.equal(v.byId('pin-download-' + runId).props.disabled, false)
    oldHandler(); await flush(); assert.equal(v.downloads.length, 2)
    assert.deepEqual(JSON.parse(await v.downloads[1].blob.text()), exported)
    await v.click('pin-download-' + runId)
    assert.equal(JSON.parse(await v.downloads[2].blob.text()).run.request_id, runId)
    assert.equal(v.requests.calls.getPromptTrials.length, 3)
    const removedHandler = v.byId('pin-download-' + runId).props.onClick
    await v.click('pin-remove-' + runId); removedHandler(); oldHandler(); await flush()
    assert.equal(v.downloads.length, 3)
  } finally { v.unmount() }
})

test('reply control characters and empty refusal survive literal display and export unchanged', async () => {
  const v = await mountTrials()
  try {
    const data = trialSnapshot('succeeded'); data.run.response.content = '\u0000\u001b[31m<think>\u202e'; data.run.response.refusal = ''
    await idle(v, data)
    assert.equal(v.text(v.byId('trial-response')), data.run.response.content)
    await v.click('trial-download')
    assert.deepEqual(JSON.parse(await v.downloads[0].blob.text()).run.response, data.run.response)
  } finally { v.unmount() }
})

for (const [field, input] of [['label', ''], ['label', 'x'.repeat(81)], ['label', 'bad\nlabel'], ['system_prompt', 'x'.repeat(1001)], ['user_prompt', ' '], ['user_prompt', 'x'.repeat(4001)], ['user_prompt', '\u0000'], ['temperature', ''], ['temperature', -0.1], ['temperature', 1.1], ['max_output_tokens', 0], ['max_output_tokens', 1.5], ['max_output_tokens', 513], ['max_output_tokens', 65]]) {
  test(`invalid form ${field} ${JSON.stringify(input).slice(0, 12)} does not send inference`, async () => {
    const v = await mountTrials()
    try {
      const data = trialSnapshot(); data.limits.max_output_tokens = 64
      await idle(v, data); await fill(v, { ...trialRequest(), max_output_tokens: 64 }); await v.input('trial-' + field, input); await v.submit('trial-form')
      assert.equal(v.requests.calls.startPromptTrial.length, 0)
      assert.match(v.text(), /Check the required label/)
    } finally { v.unmount() }
  })
}

for (const [state, code] of [['failed', 'response_too_large'], ['timed_out', 'request_timeout'], ['cancelled', 'backend_closing']]) test(`${state} has unavailable content, safe cause and nullable usage instead of false empty success`, async () => {
  const v = await mountTrials()
  try {
    const data = trialSnapshot(state); data.run.response = null; data.run.error_code = code; data.run.request_duration_ms = null
    await idle(v, data)
    assert.ok(v.byId('trial-result')); assert.match(v.text(v.byId('trial-response')), /No reply content/)
    assert.doesNotMatch(v.text(v.byId('trial-response')), /empty reply/)
    assert.equal(v.byId('trial-download').props.disabled, false)
    await v.click('trial-download'); assert.equal(JSON.parse(await v.downloads[0].blob.text()).run.error_code, code)
  } finally { v.unmount() }
})

test('stale event handlers after navigation cannot start, pin, refresh or download retired state', async () => {
  const v = await mountTrials()
  try {
    await idle(v, trialSnapshot('succeeded')); await fill(v)
    const download = v.byId('trial-download').props.onClick, pin = v.byId('trial-pin').props.onClick
    const start = v.byId('trial-form').props.onSubmit, refresh = v.byId('trial-refresh').props.onClick
    await v.navigate('/')
    download(); pin(); start({ preventDefault() {} }); refresh(); await flush()
    assert.equal(v.downloads.length, 0); assert.equal(v.requests.calls.startPromptTrial.length, 0)
    assert.equal(v.requests.calls.getPromptTrials.length, 1); assert.equal(v.timers.pending.size, 0)
  } finally { v.unmount() }
})

test('an owned fingerprint change cannot overwrite the captured run even with matching input and ID', async () => {
  const v = await mountTrials()
  try {
    await run(v); await v.timers.advance(1500)
    const different = ownedSnapshot(v, 'succeeded'); different.run.fingerprint = 'b'.repeat(64)
    v.requests.calls.getPromptTrial[0].resolve(ok(different)); await flush()
    assert.match(v.text(v.byId('trial-state')), /Running/)
    assert.ok(v.byId('trial-stale')); assert.ok(v.byId('trial-download').props.disabled)
    assert.equal(v.timers.pending.size, 0)
  } finally { v.unmount() }
})

test('successful empty string reply with empty refusal remains exportable success', async () => {
  const v = await mountTrials()
  try {
    const data = trialSnapshot('succeeded'); data.run.response.content = ''; data.run.response.refusal = ''
    await idle(v, data)
    assert.match(v.text(v.byId('trial-state')), /Succeeded/); assert.match(v.text(v.byId('trial-response')), /empty reply/)
    await v.click('trial-download'); assert.equal(JSON.parse(await v.downloads[0].blob.text()).run.response.content, '')
  } finally { v.unmount() }
})

test('malformed admission error envelopes stay uncertain and reconcile only the owned ID', async () => {
  const v = await mountTrials()
  try {
    await idle(v); await fill(v); await v.submit('trial-form')
    v.requests.calls.startPromptTrial[0].reject({ response: { status: 400, data: { success: false, error_code: { toString: null } } } }); await flush()
    assert.equal(v.requests.calls.getPromptTrial.length, 1)
    assert.equal(v.requests.calls.getPromptTrial[0].args[0], v.requests.calls.startPromptTrial[0].args[0].request_id)
  } finally { v.unmount() }
})
