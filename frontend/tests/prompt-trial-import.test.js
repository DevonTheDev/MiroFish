import assert from 'node:assert/strict'
import test from 'node:test'
import { mountTrials, trialSnapshot, trialRequest, runId, nextRunId, ok, flush } from './helpers/prompt-trials-view-fixture.js'

const MAX_BYTES = 512 * 1024
const id = index => `12345678-1234-4234-9234-${String(index).padStart(12, '0')}`
const terminal = (requestId = runId, state = 'succeeded') => {
  const saved = trialSnapshot(state); saved.run.request_id = requestId
  if (state === 'truncated') saved.run.response.finish_reason = 'length'
  if (state === 'refused') { saved.run.response.content = null; saved.run.response.refusal = '<refusal>literal</refusal>'; saved.run.response.finish_reason = 'content_filter' }
  if (['failed', 'timed_out', 'cancelled'].includes(state)) {
    saved.run.response = null; saved.run.error_code = state === 'failed' ? 'cleanup_failed' : state === 'timed_out' ? 'request_timeout' : 'backend_closing'
    if (state === 'failed') saved.run.cleanup.state = 'failed'
  }
  return saved
}
const pair = (left = terminal(), right = terminal(nextRunId)) => ({ schema_version: 1, kind: 'mirofish_local_prompt_trial_comparison', trials: [left, right] })
function file(value, name = 'saved.json', extra = {}) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  return { name, size: bytes.byteLength, type: 'application/json', arrayBuffer: async () => bytes.buffer, ...extra }
}
async function choose(v, chosen) {
  const input = v.byId('trial-import-file'); assert.ok(input, 'saved trials file picker is available')
  const target = { files: chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen], value: 'C:\\fakepath\\chosen.json' }
  const promise = input.props.onChange({ target }); await flush()
  assert.equal(target.value, '', 'input is reset so the same file can be selected again')
  return { promise }
}
async function importFile(v, value, name) { const { promise } = await choose(v, file(value, name)); await promise; await flush() }
async function idle(v, snapshot = trialSnapshot()) { v.requests.calls.getPromptTrials.at(-1).resolve(ok(snapshot)); await flush() }
async function fill(v, value = trialRequest()) { for (const [key, input] of Object.entries(value)) await v.input('trial-' + key, input) }
const pinCount = v => v.all(n => n.props['data-testid']?.startsWith('pin-item-')).length
const importCount = v => v.all(n => n.props['data-testid']?.startsWith('trial-import-result-')).length
const requests = v => Object.fromEntries(Object.entries(v.requests.calls).map(([key, calls]) => [key, calls.length]))
async function pinImported(v, value) { await importFile(v, value); await v.click('trial-import-add') }

for (const locale of ['en', 'zh']) test(`individual/comparison previews show literal full details and historical scope in ${locale}`, async () => {
  const v = await mountTrials({ locale })
  try {
    assert.equal(v.all(n => n.type === 'input' && n.props.type === 'file').length, 1)
    assert.equal(v.byId('trial-import-file').props.multiple, undefined)
    const saved = terminal(); saved.run.request.label = '<b>historical label</b>'; saved.run.request.system_prompt = '<system>literal</system>'
    saved.run.request.user_prompt = '<img src=x onerror=alert(1)>'; saved.run.response.content = '\u0000<think>literal</think>\u202e'
    saved.run.response.refusal = ''; saved.run.configuration.model = 'historical-local-model'; saved.run.configuration.reasoning_effort = 'high'
    const filename = '../private/<img src=x>.json'; await importFile(v, saved, filename)
    assert.equal(v.text(v.byId('trial-import-name')), filename); assert.equal(importCount(v), 1); assert.equal(pinCount(v), 0)
    assert.equal(v.text(v.byId('import-' + runId + '-response')), saved.run.response.content)
    const preview = v.text(v.byId('trial-import-preview'))
    for (const literal of [saved.run.request.user_prompt, saved.run.request.system_prompt, saved.run.request_id, 'historical-local-model', 'high', '750', '1000', '12', '3', '15']) assert.ok(preview.includes(literal), literal)
    assert.match(preview, locale === 'en' ? /Historical|historical/ : /历史/); assert.match(preview, locale === 'en' ? /not authenticated/ : /未经认证/)
    assert.ok(v.find(n => n.type === 'time' && n.props.datetime === saved.observed_at))
    assert.equal(v.all(n => ['img', 'system', 'think', 'b'].includes(n.type) || n.props.innerHTML).length, 0)
    assert.ok(v.byId('trial-run').props.disabled); assert.equal(v.byId('trial-result'), undefined)
    assert.deepEqual(requests(v), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
    await importFile(v, pair(saved, terminal(nextRunId, 'refused')))
    assert.equal(importCount(v), 2); assert.equal(pinCount(v), 0); assert.equal(v.text(v.byId('import-' + nextRunId + '-refusal')), '<refusal>literal</refusal>')
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})
for (const state of ['succeeded', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']) test(`historical ${state} pins independently of availability`, async () => {
  const v = await mountTrials()
  try {
    const saved = terminal(runId, state); saved.available = false; saved.unavailable_code = 'invalid_configuration'; saved.limits.max_output_tokens = null
    await pinImported(v, saved); assert.equal(pinCount(v), 1); assert.equal(v.byId('trial-import-preview'), undefined)
    assert.match(v.text(v.byId('pin-item-' + runId)), /Imported historical/); assert.ok(v.byId('trial-run').props.disabled)
    await v.click('pin-download-' + runId); assert.deepEqual(JSON.parse(await v.downloads[0].blob.text()), saved)
    assert.deepEqual(requests(v), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { v.unmount() }
})
for (const mode of ['pending', 'offline', 'cloud', 'stale']) test(`import works while live observation is ${mode} without changing readiness`, async () => {
  const v = await mountTrials()
  try {
    if (mode === 'offline') { v.requests.calls.getPromptTrials[0].reject(new Error('private failure')); await flush() }
    if (mode === 'cloud') { const cloud = trialSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required' }); cloud.limits.max_output_tokens = null; await idle(v, cloud) }
    if (mode === 'stale') { await idle(v, terminal(id(1))); await v.click('trial-pin'); await v.click('trial-refresh'); v.requests.calls.getPromptTrials.at(-1).reject(new Error('offline')); await flush() }
    await fill(v, { ...trialRequest(), user_prompt: 'draft retained' }); const before = requests(v); await pinImported(v, pair())
    assert.equal(pinCount(v), mode === 'stale' ? 3 : 2); assert.equal(v.byId('trial-user_prompt').props.value, 'draft retained')
    assert.ok(v.byId('trial-run').props.disabled); assert.deepEqual(requests(v), before)
    if (mode === 'stale') assert.equal(v.text(v.byId('trial-response')), 'Hello back'); else assert.equal(v.byId('trial-result'), undefined)
    await v.change('pin-select-' + nextRunId, true); await v.change('pin-select-' + runId, true)
    assert.match(v.text(v.byId('comparison-' + runId)), /Imported historical/)
    await v.click('comparison-download'); const exported = JSON.parse(await v.downloads[0].blob.text())
    assert.deepEqual(Object.keys(exported), ['schema_version', 'kind', 'trials']); assert.deepEqual(exported, pair(terminal(nextRunId), terminal()))
    assert.equal(v.revokedUrls.length, 1); assert.deepEqual(requests(v), before)
  } finally { v.unmount() }
})
test('import preserves an in-flight owner, exact refresh identity, live response, and draft', async () => {
  const v = await mountTrials()
  try {
    await idle(v); await fill(v); await v.submit('trial-form'); const active = v.requests.calls.startPromptTrial[0], sent = active.args[0]
    await pinImported(v, pair()); assert.equal(active.signal.aborted, false)
    const owned = terminal(sent.request_id); owned.run.request = trialRequest(); owned.run.response.content = 'owned live response'; active.resolve(ok(owned)); await flush()
    assert.equal(v.text(v.byId('trial-response')), 'owned live response'); assert.equal(v.byId('trial-run').props.disabled, false)
    assert.equal(v.byId('trial-user_prompt').props.value, 'Hello'); assert.equal(pinCount(v), 2)
    await v.click('trial-refresh'); assert.equal(v.requests.calls.getPromptTrial[0].args[0], sent.request_id)
    assert.notEqual(sent.request_id, runId); assert.notEqual(sent.request_id, nextRunId)
  } finally { v.unmount() }
})
test('reuse imported inputs requires explicit Run with fresh UUID and current local cap', async () => {
  const v = await mountTrials()
  try {
    const current = trialSnapshot(); current.limits.max_output_tokens = 64; await idle(v, current)
    const saved = terminal(); saved.run.request = { label: 'Saved inputs', system_prompt: 'saved system', user_prompt: 'saved user', temperature: 0.8, max_output_tokens: 128 }
    saved.run.configuration.model = 'old-local-model'; saved.run.configuration.reasoning_effort = 'high'; await pinImported(v, saved); await v.click('pin-reuse-' + runId)
    for (const [key, input] of Object.entries(saved.run.request)) assert.equal(v.byId('trial-' + key).props.value, input)
    assert.equal(v.requests.calls.startPromptTrial.length, 0); await v.submit('trial-form'); assert.equal(v.requests.calls.startPromptTrial.length, 0)
    assert.match(v.text(), /within the loaded limit/); await v.input('trial-max_output_tokens', 64); await v.submit('trial-form')
    assert.equal(v.requests.calls.startPromptTrial.length, 1); const sent = v.requests.calls.startPromptTrial[0].args[0]
    assert.deepEqual(Object.keys(sent), ['request_id', 'label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens'])
    assert.notEqual(sent.request_id, runId); assert.deepEqual({ ...sent, request_id: undefined }, { ...saved.run.request, max_output_tokens: 64, request_id: undefined })
    assert.equal(v.requests.calls.getPromptTrial.length, 0)
  } finally { v.unmount() }
})
test('duplicate/capacity refusals preserve full preview and commit all or none after correction', async () => {
  const v = await mountTrials()
  try {
    await idle(v, terminal()); await importFile(v, pair()); const commit = v.byId('trial-import-add').props.onClick
    await v.click('trial-pin'); commit(); await flush(); assert.equal(pinCount(v), 1); assert.equal(importCount(v), 2)
    assert.match(v.text(v.byId('trial-import-error')), /already pinned/); assert.doesNotMatch(v.text(v.byId('pin-item-' + runId)), /Imported historical/)
    await v.click('pin-remove-' + runId); await v.click('trial-import-add'); assert.equal(pinCount(v), 2)
    for (let i = 1; i <= 7; i++) await pinImported(v, terminal(id(i)))
    await importFile(v, pair(terminal(id(8)), terminal(id(9)))); await v.click('trial-import-add')
    assert.equal(pinCount(v), 9); assert.equal(importCount(v), 2); assert.equal(v.byId('pin-item-' + id(8)), undefined)
    assert.match(v.text(v.byId('trial-import-error')), /10/); await v.click('pin-remove-' + id(7)); await v.click('trial-import-add')
    assert.equal(pinCount(v), 10); assert.ok(v.byId('pin-item-' + id(8))); assert.ok(v.byId('pin-item-' + id(9)))
  } finally { v.unmount() }
})
test('old pin handlers cannot select/remove/reuse/download a same-ID replacement', async () => {
  const v = await mountTrials()
  try {
    await pinImported(v, terminal()); const old = Object.fromEntries(['remove', 'reuse', 'download', 'select'].map(action => [action, v.byId('pin-' + action + '-' + runId).props[action === 'select' ? 'onChange' : 'onClick']]))
    await v.click('pin-remove-' + runId); const replacement = terminal(); replacement.run.request.user_prompt = 'replacement'; await pinImported(v, replacement)
    await fill(v, { ...trialRequest(), user_prompt: 'untouched draft' }); old.select({ target: { checked: true } }); old.remove(); old.reuse(); old.download(); await flush()
    assert.equal(pinCount(v), 1); assert.equal(v.byId('pin-select-' + runId).props.checked, false)
    assert.equal(v.byId('trial-user_prompt').props.value, 'untouched draft'); assert.equal(v.downloads.length, 0)
    await v.click('pin-download-' + runId); assert.equal(JSON.parse(await v.downloads[0].blob.text()).run.request.user_prompt, 'replacement')
  } finally { v.unmount() }
})
for (const [name, mutate] of [
  ['negative size', f => ({ ...f, size: -1 })], ['fractional size', f => ({ ...f, size: 1.1 })], ['non-number size', f => ({ ...f, size: '2' })],
  ['oversize declared', f => ({ ...f, size: MAX_BYTES + 1 })], ['missing reader', f => ({ ...f, arrayBuffer: undefined })],
  ['long filename', f => ({ ...f, name: 'x'.repeat(513) })], ['invalid filename type', f => ({ ...f, name: {} })],
]) test(`preflight rejects ${name} before reading bytes and preserves live state`, async () => {
  const v = await mountTrials()
  try {
    await idle(v, terminal()); await v.click('trial-pin'); await fill(v)
    let reads = 0; const invalid = mutate(file(terminal(nextRunId), 'saved.json', { arrayBuffer() { reads++; throw new Error('private detail') } }))
    const { promise } = await choose(v, invalid); await promise; await flush()
    assert.equal(reads, 0); assert.ok(v.byId('trial-import-error')); assert.equal(v.byId('trial-import-preview'), undefined)
    assert.equal(pinCount(v), 1); assert.equal(v.text(v.byId('trial-response')), 'Hello back'); assert.equal(v.byId('trial-user_prompt').props.value, 'Hello')
    assert.equal(v.byId('trial-run').props.disabled, false); assert.doesNotMatch(v.text(), /private detail/)
  } finally { v.unmount() }
})
for (const [name, makeFile] of [
  ['reader failure', () => file(terminal(), 'bad.json', { arrayBuffer: async () => { throw new Error('private reader error') } })],
  ['oversize actual bytes', () => file(terminal(), 'bad.json', { arrayBuffer: async () => new ArrayBuffer(MAX_BYTES + 1) })],
  ['wrong bytes type', () => file(terminal(), 'bad.json', { arrayBuffer: async () => new Uint8Array([1, 2]) })],
  ['malformed UTF-8', () => file(terminal(), 'bad.json', { arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer })],
  ['UTF-8 BOM', () => file('\ufeff' + JSON.stringify(terminal()))], ['invalid JSON', () => file('{private garbage}')],
  ['API envelope', () => file(ok(terminal()))], ['active run', () => file(trialSnapshot('running'))], ['empty observation', () => file(trialSnapshot())],
  ['duplicate comparison IDs', () => file(pair(terminal(), terminal()))], ['unknown comparison key', () => file({ ...pair(), secret: 'private error' })],
]) test(`admission rejects ${name} without exposing errors or changing draft/pins`, async () => {
  const v = await mountTrials()
  try {
    await idle(v, terminal(id(1))); await v.click('trial-pin'); await fill(v); await importFile(v, terminal(nextRunId))
    const { promise } = await choose(v, makeFile()); await promise; await flush()
    assert.ok(v.byId('trial-import-error')); assert.equal(v.byId('trial-import-preview'), undefined); assert.equal(pinCount(v), 1)
    assert.equal(v.byId('trial-user_prompt').props.value, 'Hello'); assert.equal(v.text(v.byId('trial-response')), 'Hello back')
    assert.doesNotMatch(v.text(), /private reader|private garbage|private error/); assert.deepEqual(requests(v), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { v.unmount() }
})
test('exact byte cap and 512 Unicode filename code points are accepted', async () => {
  const v = await mountTrials()
  try {
    const content = JSON.stringify(terminal()); const padded = content + ' '.repeat(MAX_BYTES - new TextEncoder().encode(content).length)
    await importFile(v, padded, '🧪'.repeat(512)); assert.equal(importCount(v), 1)
    assert.equal(v.text(v.byId('trial-import-name')), '🧪'.repeat(512)); assert.equal(v.byId('trial-import-error'), undefined)
  } finally { v.unmount() }
})
for (const resolution of ['resolve', 'reject']) test(`new selection retires older ${resolution} and old preview add/discard/clear`, async () => {
  const v = await mountTrials()
  try {
    await importFile(v, terminal()); const add = v.byId('trial-import-add').props.onClick, discard = v.byId('trial-import-discard').props.onClick
    let resolve, reject; const pending = new Promise((a, b) => { resolve = a; reject = b })
    const first = await choose(v, file(terminal(), 'first.json', { arrayBuffer: () => pending })); const oldClear = v.byId('trial-import-clear').props.onClick
    await importFile(v, terminal(nextRunId), 'second.json'); add(); discard(); oldClear(); await flush()
    assert.equal(pinCount(v), 0); assert.equal(v.text(v.byId('trial-import-name')), 'second.json')
    if (resolution === 'resolve') resolve(new TextEncoder().encode(JSON.stringify(terminal())).buffer); else reject(new Error('private old failure'))
    await first.promise; await flush(); assert.equal(v.text(v.byId('trial-import-name')), 'second.json'); assert.equal(v.byId('trial-import-error'), undefined)
    await v.click('trial-import-add'); assert.equal(pinCount(v), 1); assert.ok(v.byId('pin-item-' + nextRunId))
  } finally { v.unmount() }
})
for (const retirement of ['clear', 'empty selection', 'discard', 'navigation']) test(`${retirement} retires pending reads and stale preview handlers`, async () => {
  const v = await mountTrials()
  try {
    await importFile(v, terminal()); const add = v.byId('trial-import-add').props.onClick, discard = v.byId('trial-import-discard').props.onClick
    if (retirement === 'discard') await v.click('trial-import-discard')
    let resolve; const pending = new Promise(done => { resolve = done }); const old = await choose(v, file(terminal(), 'pending.json', { arrayBuffer: () => pending }))
    if (retirement === 'clear' || retirement === 'discard') await v.click('trial-import-clear')
    if (retirement === 'empty selection') { const empty = await choose(v, null); await empty.promise }
    if (retirement === 'navigation') { await v.navigate('/'); await v.navigate('/prompt-trials') }
    add(); discard(); resolve(new TextEncoder().encode(JSON.stringify(terminal())).buffer); await old.promise; await flush()
    assert.equal(v.byId('trial-import-preview'), undefined); assert.equal(pinCount(v), 0); assert.equal(v.byId('trial-import-error'), undefined)
    assert.equal(v.requests.calls.startPromptTrial.length, 0); assert.equal(v.requests.calls.getPromptTrial.length, 0)
  } finally { v.unmount() }
})


test('a multi-file event rejects the complete selection without reading either file', async () => {
  const v = await mountTrials()
  try {
    await importFile(v, terminal()); let reads = 0
    const first = file(terminal(), 'first.json', { arrayBuffer: async () => { reads++; return new ArrayBuffer(0) } })
    const second = file(terminal(nextRunId), 'second.json', { arrayBuffer: async () => { reads++; return new ArrayBuffer(0) } })
    const selected = await choose(v, [first, second]); await selected.promise; await flush()
    assert.equal(reads, 0); assert.ok(v.byId('trial-import-error')); assert.equal(v.byId('trial-import-preview'), undefined); assert.equal(pinCount(v), 0)
  } finally { v.unmount() }
})

test('a very large filename is rejected without reading its contents', async () => {
  const v = await mountTrials()
  try {
    let reads = 0; const selected = await choose(v, file(terminal(), 'x'.repeat(1025), { arrayBuffer: async () => { reads++; return new ArrayBuffer(0) } }))
    await selected.promise; await flush(); assert.equal(reads, 0); assert.ok(v.byId('trial-import-error')); assert.equal(v.byId('trial-import-preview'), undefined)
  } finally { v.unmount() }
})

test('capacity is rechecked when a live pin is added after preview', async () => {
  const v = await mountTrials()
  try {
    await idle(v, terminal(id(99)))
    for (let i = 0; i < 8; i++) await pinImported(v, terminal(id(i)))
    await importFile(v, pair()); const add = v.byId('trial-import-add').props.onClick
    await v.click('trial-pin'); add(); await flush()
    assert.equal(pinCount(v), 9); assert.equal(importCount(v), 2); assert.match(v.text(v.byId('trial-import-error')), /10/)
    assert.equal(v.byId('pin-item-' + runId), undefined); assert.equal(v.byId('pin-item-' + nextRunId), undefined)
    await v.click('pin-remove-' + id(99)); await v.click('trial-import-add'); assert.equal(pinCount(v), 10)
  } finally { v.unmount() }
})

test('import while an owned running trial is waiting preserves its scheduled exact-ID poll', async () => {
  const v = await mountTrials()
  try {
    await idle(v); await fill(v); await v.submit('trial-form')
    const sent = v.requests.calls.startPromptTrial[0].args[0], owned = trialSnapshot('running'); owned.run.request_id = sent.request_id
    v.requests.calls.startPromptTrial[0].resolve(ok(owned)); await flush(); assert.equal(v.timers.pending.size, 1)
    await pinImported(v, pair()); assert.equal(v.timers.pending.size, 1); assert.match(v.text(v.byId('trial-state')), /Running/)
    await v.timers.advance(1500); assert.equal(v.requests.calls.getPromptTrial.length, 1); assert.equal(v.requests.calls.getPromptTrial[0].args[0], sent.request_id)
    const finished = terminal(sent.request_id); finished.run.response.content = 'live completion'
    v.requests.calls.getPromptTrial[0].resolve(ok(finished)); await flush(); assert.equal(v.text(v.byId('trial-response')), 'live completion')
    assert.equal(pinCount(v), 2); assert.equal(v.timers.pending.size, 0); assert.equal(v.requests.calls.startPromptTrial.length, 1)
  } finally { v.unmount() }
})

for (const count of [1, 2]) test(`native input reset clearing its live FileList preserves ${count === 1 ? 'the selected file' : 'multi-file rejection'}`, async () => {
  const v = await mountTrials()
  try {
    let reads = 0
    const bytes = new TextEncoder().encode(JSON.stringify(terminal())).buffer
    const chosen = file(terminal(), 'native.json', { arrayBuffer: async () => { reads++; return bytes } })
    const files = { length: count, 0: chosen, ...(count === 2 ? { 1: file(terminal(nextRunId)) } : {}) }
    let value = 'C:\\fakepath\\native.json'
    const target = { files, get value() { return value }, set value(next) {
      value = next
      if (next === '') { delete files[0]; delete files[1]; files.length = 0 }
    } }
    await v.byId('trial-import-file').props.onChange({ target }); await flush()
    assert.equal(target.value, ''); assert.equal(files.length, 0)
    assert.equal(reads, count === 1 ? 1 : 0)
    assert.equal(Boolean(v.byId('trial-import-status')), false, 'input reset must not leave a pending read stuck')
    if (count === 1) {
      assert.equal(importCount(v), 1); assert.equal(v.text(v.byId('trial-import-name')), 'native.json')
      await v.click('trial-import-add'); assert.equal(pinCount(v), 1)
    } else { assert.ok(v.byId('trial-import-error')); assert.equal(importCount(v), 0) }
  } finally { v.unmount() }
})
