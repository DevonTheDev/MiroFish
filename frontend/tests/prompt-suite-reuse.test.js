import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'
import { evaluatePromptSuiteCheck, parsePromptSuiteReport } from '../src/utils/promptSuites.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const clone = value => JSON.parse(JSON.stringify(value))
function savedRun({ version = 1, count = 3, name = 'Captured suite', status = 'completed', rowStatus = 'succeeded' } = {}) {
  const definition = { schema_version: version, kind: 'mirofish_local_prompt_suite', name,
    cases: Array.from({ length: count }, (_, index) => ({ case_id: id(100 + index), ...trialRequest(),
      label: `Case ${index + 1}`, system_prompt: '\tKeep <b>exact</b>\r\n', user_prompt: `Reply ${index + 1} 🦙`,
      expected_text: index === 1 ? '' : index === 2 && version === 1 ? 'Hello back' : null,
      ...(version === 2 ? { check_kind: ['none', 'exact_text', 'json_object'][index % 3] } : {}) })) }
  const cases = definition.cases.map((item, index) => {
    const state = index === 0 ? rowStatus : rowStatus === 'succeeded' ? 'succeeded' : 'not_attempted'
    let snapshot = null
    if (!['not_attempted', 'submitting', 'rejected'].includes(state)) {
      const raw = trialSnapshot(state === 'unknown' ? 'running' : state)
      if (state === 'truncated') raw.run.response.finish_reason = 'length'
      snapshot = acceptPromptTrialSnapshot(ok(raw))
      snapshot.run.request_id = id(200 + index)
      snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, item[key]]))
      snapshot.run.configuration.model = index === 0 ? 'historical-model-a' : 'historical-model-b'
      if (snapshot.run.response) snapshot.run.response.content = index === 1 ? '' : index === 2 && version === 2 ? '{"ok":true}' : 'Hello back'
      if (state === 'truncated') snapshot.run.response.finish_reason = 'length'
    }
    return { case_id: item.case_id, request_id: state === 'not_attempted' ? null : id(200 + index), status: state,
      check: evaluatePromptSuiteCheck(item, state, snapshot?.run.response?.content), snapshot, error_code: state === 'unknown' ? 'read_failed' : null }
  })
  return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(1), definition,
    started_at: '2026-10-03T12:59:59Z', finished_at: status === 'running' ? null : '2026-10-03T13:00:00Z',
    status, stop_requested: status === 'stopped', halt_code: status === 'halted' ? 'runtime_failed' : null, cases }
}
const encoded = source => new TextEncoder().encode(typeof source === 'string' ? source : JSON.stringify(source))
const runFile = source => { const bytes = encoded(source); return { name: 'run.json', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } }
const definitionFile = source => { const text = typeof source === 'string' ? source : JSON.stringify(source); return { size: encoded(text).length, text: async () => text } }
const calls = view => Object.fromEntries(Object.entries(view.requests.calls).map(([key, value]) => [key, value.length]))
async function idle(view, snapshot = trialSnapshot()) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(snapshot)); await flush() }
async function exported(view, kind = 'definition') {
  await view.click(`suite-export-${kind}`)
  return JSON.parse(await view.downloads.at(-1).blob.text())
}
const handler = (view, control) => view.byId(control).props.onClick
async function invoke(action) { action({ preventDefault() {}, stopPropagation() {}, button: 0 }); await flush() }
function pendingFile(type) {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { size: 100, [type === 'run' ? 'arrayBuffer' : 'text']: () => promise,
    resolve: source => resolve(type === 'run' ? encoded(source).buffer : JSON.stringify(source)), reject }
}

for (const locale of ['en', 'zh']) for (const version of [1, 2]) test(`saved v${version} run becomes an exact detached editable draft in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view)
    const source = savedRun({ version, name: '<script>literal 🦙 suite</script>' }), original = clone(source.definition)
    const before = calls(view)
    await view.runFile(runFile(source))
    const preview = view.byId('suite-import-preview')
    assert.ok(preview)
    assert.equal(view.byId('suite-name').props.value, '')
    assert.match(view.text(preview), /<script>literal 🦙 suite<\/script>/)
    assert.equal(view.all(node => node.type === 'script').length, 0)
    assert.match(view.text(preview), new RegExp(source.run_id))
    assert.match(view.text(preview), /2026-10-03T12:59:59Z/)
    assert.match(view.text(preview), /2026-10-03T13:00:00Z/)
    assert.match(view.text(preview), locale === 'en' ? /historical/ : /历史/)
    assert.doesNotMatch(view.text(preview), /historical-model-a|historical-model-b/)
    assert.match(view.text(view.byId('suite-import-use')), locale === 'en' ? /Use captured cases as draft/ : /将已捕获用例用作草稿/)
    assert.equal(view.byId('suite-run-report'), undefined)
    source.definition.cases[0].user_prompt = 'Mutated original'
    await view.click('suite-import-use')
    assert.deepEqual(await exported(view), original)
    assert.deepEqual(calls(view), before)
    assert.equal(view.byId('suite-import-preview'), undefined)
    assert.equal(view.byId('suite-run-report'), undefined)
    await view.input('suite-case-0-user_prompt', 'Editable copy')
    assert.equal((await exported(view)).cases[0].user_prompt, 'Editable copy')
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('queued use and discard belong to the rendered preview across both inputs and A→B→A', async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const a = savedRun({ name: 'Run A' }), b = savedRun({ name: 'Definition B' }).definition
    await view.runFile(runFile(a))
    const useA = handler(view, 'suite-import-use'), cancelA = handler(view, 'suite-import-cancel')
    await view.file(definitionFile(b))
    await invoke(useA); await invoke(cancelA)
    assert.match(view.text(view.byId('suite-import-preview')), /Definition B/)
    assert.equal(view.byId('suite-name').props.value, '')
    const useB = handler(view, 'suite-import-use'), cancelB = handler(view, 'suite-import-cancel')
    await view.runFile(runFile(a))
    await invoke(useA); await invoke(cancelA); await invoke(useB); await invoke(cancelB)
    assert.match(view.text(view.byId('suite-import-preview')), /Run A/)
    assert.equal(view.byId('suite-name').props.value, '')
    await view.click('suite-import-use')
    assert.equal(view.byId('suite-name').props.value, 'Run A')
    assert.deepEqual(calls(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

for (const version of [1, 2]) for (const [status, rowStatus] of [
  ['running', 'running'], ['running', 'submitting'], ['halted', 'unknown'], ['halted', 'truncated'],
  ['halted', 'rejected'], ['stopped', 'not_attempted'],
]) test(`v${version} ${status}/${rowStatus} captures reuse every case without resuming history`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const source = savedRun({ version, status, rowStatus })
    parsePromptSuiteReport(JSON.stringify(source))
    await view.runFile(runFile(source))
    const provenance = view.byId('suite-import-provenance')
    assert.ok(provenance)
    assert.match(view.text(provenance), new RegExp(source.run_id))
    assert.match(view.text(provenance), new RegExp(`Attempted\\s+${rowStatus === 'not_attempted' ? 0 : 1}\\s+Cases\\s+3`))
    assert.match(view.text(view.byId('suite-import-preview')), /including unattempted ones/)
    assert.equal(view.all(node => node.type === 'li' && view.text(node).includes('Review exact prompts')).length, 3)
    if (status === 'running') assert.match(view.text(provenance), /Not reported/)
    await view.click('suite-import-use')
    assert.deepEqual(await exported(view), source.definition)
    assert.equal(view.byId('suite-run-report'), undefined)
    assert.equal(view.byId('suite-reconcile'), undefined)
    assert.equal(view.byId('suite-stop').props.disabled, true)
    assert.equal(view.byId('suite-run').props.disabled, false)
    assert.equal(view.timers.pending.size, 0)
    await view.timers.advance(100000)
    assert.deepEqual(calls(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

test('the report input validates the entire capture, not only the definition', async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const original = savedRun({ name: 'Existing draft', count: 1 }).definition
    await view.file(definitionFile(original)); await view.click('suite-import-use')
    const cases = {
      'unsupported schema': source => { source.schema_version = 2 },
      'unsupported kind': source => { source.kind = 'mirofish_local_prompt_suite_comparison' },
      'extra archive field': source => { source.private = 'PRIVATE INVALID FIELD' },
      'duplicate case identity': source => { source.definition.cases[1].case_id = source.definition.cases[0].case_id },
      'mismatched row identity': source => { source.cases[0].case_id = id(999) },
      'mismatched request identity': source => { source.cases[0].request_id = id(999) },
      'duplicate request identity': source => { source.cases[1].request_id = source.cases[0].request_id; source.cases[1].snapshot.run.request_id = source.cases[0].request_id },
      'different captured prompt': source => { source.cases[0].snapshot.run.request.user_prompt = 'Other request' },
      'forged exact check': source => { source.cases[1].check = 'mismatched' },
      'forged JSON check': source => { source.schema_version = source.definition.schema_version = 2; source.definition.cases.forEach((item, index) => { item.check_kind = index === 1 ? 'json_object' : 'none'; item.expected_text = null }); source.cases[1].check = 'matched'; source.cases[2].check = 'not_requested' },
      'invalid finish time': source => { source.finished_at = null },
      'invalid model field': source => { source.cases[0].snapshot.run.configuration.model = 'https://invalid.example/private' },
      'out of order execution': source => { source.status = 'halted'; source.halt_code = 'runtime_failed'; source.cases[0] = { case_id: source.cases[0].case_id, request_id: null, status: 'not_attempted', snapshot: null, check: 'not_evaluated', error_code: null } },
      'case order differs': source => { source.cases.reverse() },
      'unknown with terminal snapshot': source => { source.status = 'halted'; source.halt_code = 'read_failed'; source.cases[2].status = 'unknown'; source.cases[2].check = 'not_evaluated' },
    }
    for (const [name, change] of Object.entries(cases)) {
      const source = savedRun(); change(source)
      await view.runFile(runFile(source))
      assert.ok(view.byId('suite-import-error'), name)
      assert.equal(view.byId('suite-import-preview'), undefined, name)
      assert.deepEqual(await exported(view), original, name)
      assert.equal(view.byId('suite-run-report'), undefined, name)
    }
    assert.doesNotMatch(view.text(), /PRIVATE INVALID FIELD|invalid\.example/)
    assert.deepEqual(calls(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

test('raw report admission enforces byte size, ArrayBuffer, fatal UTF-8, BOM, duplicates and depth', async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const source = JSON.stringify(savedRun({ count: 1 })), original = savedRun({ name: 'Safe draft', count: 1 }).definition
    const [beforeName, afterName] = source.split('Captured suite')
    await view.file(definitionFile(original)); await view.click('suite-import-use')
    const invalid = {
      malformed: runFile('{'),
      'duplicate root': runFile(source.replace('"schema_version":1', '"schema_version":1,"schema_version":1')),
      'escaped duplicate': runFile(source.replace('"run_id":', `"run_id":"${id(1)}","run_\\u0069d":`)),
      'nested duplicate': runFile(source.replace('"model":"historical-model-a"', '"model":"historical-model-a","model":"other"')),
      'too deep ignored value': runFile(source.replace('"snapshot":{', '"snapshot":{"ignored":' + '['.repeat(9) + '0' + ']'.repeat(9) + ',')),
      'BOM': runFile('\ufeff' + source),
      'bad UTF-8': { size: encoded(source).length, arrayBuffer: async () => Uint8Array.from([...encoded(beforeName), 0xc0, 0xaf, ...encoded(afterName)]).buffer },
      'read error': { size: 100, arrayBuffer: async () => { throw new Error('PRIVATE FILE ERROR') } },
      'typed array': { size: 100, arrayBuffer: async () => encoded(source) },
      'string read': { size: 100, arrayBuffer: async () => source },
      'text-only': { size: 100, text: async () => source },
      'definition file': runFile(savedRun().definition),
    }
    for (const [name, file] of Object.entries(invalid)) {
      await view.runFile(file)
      assert.ok(view.byId('suite-import-error'), name)
      assert.equal(view.byId('suite-import-preview'), undefined, name)
      assert.deepEqual(await exported(view), original, name)
    }
    let reads = 0
    for (const size of [-1, 0.5, NaN, Infinity, undefined, 1048577]) {
      await view.runFile({ size, arrayBuffer: async () => { reads++; return encoded(source).buffer } })
      assert.ok(view.byId('suite-import-error'))
    }
    assert.equal(reads, 0)
    await view.runFile({ size: 1, arrayBuffer: async () => { reads++; return new ArrayBuffer(1048577) } })
    assert.equal(reads, 1); assert.ok(view.byId('suite-import-error'))
    const atLimit = source + ' '.repeat(1048576 - encoded(source).length)
    await view.runFile({ ...runFile(atLimit), text: async () => { throw new Error('Must use raw bytes') } })
    assert.ok(view.byId('suite-import-preview'))
    await view.click('suite-import-cancel')
    // The separate definition input keeps its original text-only 128 KiB contract.
    const definitionText = JSON.stringify(original)
    await view.file({ ...definitionFile(definitionText + ' '.repeat(131072 - encoded(definitionText).length)), arrayBuffer: async () => { throw new Error('Must use text') } })
    assert.ok(view.byId('suite-import-preview'))
    await view.file(definitionFile(definitionText + ' '.repeat(131073 - encoded(definitionText).length)))
    assert.ok(view.byId('suite-import-error'))
    assert.deepEqual(await exported(view), original)
    assert.doesNotMatch(view.text(), /PRIVATE FILE ERROR|Must use/)
    assert.deepEqual(calls(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

for (const version of [1, 2]) test(`v${version} report import preserves legacy projection of ignored snapshot fields`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const source = savedRun({ version }), plain = JSON.stringify(source)
    const projected = plain.replace('"snapshot":{', '"snapshot":{"ignored":{"overflow":1e400,"surrogate":"\\ud800","depth":' + '['.repeat(7) + '0' + ']'.repeat(7) + '},')
    assert.deepEqual(parsePromptSuiteReport(projected).definition, source.definition)
    await view.runFile(runFile(projected)); assert.ok(view.byId('suite-import-preview'))
    await view.click('suite-import-use')
    assert.deepEqual(await exported(view), source.definition)
    assert.equal(view.byId('suite-run-report'), undefined)
    assert.deepEqual(calls(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

for (const first of ['run', 'definition']) test(`a pending ${first} read cannot overwrite or cancel a newer cross-input selection`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const other = first === 'run' ? 'definition' : 'run'
    const select = (type, file) => type === 'run' ? view.runFile(file) : view.file(file)
    const source = type => type === 'run' ? savedRun({ name: 'Latest selected suite' }) : savedRun({ name: 'Latest selected suite' }).definition
    const old = pendingFile(first); await select(first, old)
    const oldCancel = handler(view, 'suite-import-cancel')
    const newer = pendingFile(other); await select(other, newer)
    await invoke(oldCancel)
    assert.ok(view.byId('suite-import-cancel'))
    old.reject(new Error('PRIVATE STALE READ')); await flush()
    assert.equal(view.byId('suite-import-error'), undefined)
    newer.resolve(source(other)); await flush()
    assert.match(view.text(view.byId('suite-import-preview')), /Latest selected suite/)
    await invoke(oldCancel)
    assert.ok(view.byId('suite-import-preview'))
    await view.click('suite-import-use')
    assert.equal(view.byId('suite-name').props.value, 'Latest selected suite')
    assert.doesNotMatch(view.text(), /PRIVATE STALE READ/)
    const cancelled = pendingFile(first); await select(first, cancelled)
    await view.click('suite-import-cancel'); cancelled.resolve(source(first)); await flush()
    assert.equal(view.byId('suite-import-preview'), undefined)
    const empty = pendingFile(first); await select(first, empty); await select(other, null)
    empty.resolve(source(first)); await flush()
    assert.equal(view.byId('suite-import-preview'), undefined)
    assert.equal(view.byId('suite-name').props.value, 'Latest selected suite')
  } finally { view.unmount() }
})

test('queued preview and pending-read controls retire after adoption, navigation and unmount', async () => {
  const view = await mountSuites()
  let unmounted = false
  try {
    await idle(view)
    await view.runFile(runFile(savedRun()))
    const oldUse = handler(view, 'suite-import-use'), oldCancel = handler(view, 'suite-import-cancel')
    await view.click('suite-import-use')
    await view.input('suite-name', 'Edited after adoption')
    await invoke(oldUse); await invoke(oldCancel)
    assert.equal(view.byId('suite-name').props.value, 'Edited after adoption')
    const pending = pendingFile('run'); await view.runFile(pending)
    const loadingCancel = handler(view, 'suite-import-cancel')
    await view.navigate('/prompt-trials'); await view.navigate('/prompt-suites'); await idle(view)
    await view.runFile(runFile(savedRun({ name: 'New page preview' })))
    pending.resolve(savedRun({ name: 'Retired read' })); await flush()
    await invoke(oldUse); await invoke(oldCancel); await invoke(loadingCancel)
    assert.match(view.text(view.byId('suite-import-preview')), /New page preview/)
    assert.equal(view.byId('suite-name').props.value, '')
    const newUse = handler(view, 'suite-import-use'), newCancel = handler(view, 'suite-import-cancel')
    const finalRead = pendingFile('run'); await view.runFile(finalRead)
    view.unmount(); unmounted = true
    finalRead.reject(new Error('PRIVATE RETIRED ERROR'))
    await invoke(newUse); await invoke(newCancel)
    assert.equal(view.downloads.length, 0)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    assert.equal(view.timers.pending.size, 0)
  } finally { if (!unmounted) view.unmount() }
})

for (const type of ['run', 'definition']) test(`queued loading discard still owns its ${type} file after that read completes`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const pending = pendingFile(type)
    await (type === 'run' ? view.runFile(pending) : view.file(pending))
    const discard = handler(view, 'suite-import-cancel')
    pending.resolve(type === 'run' ? savedRun() : savedRun().definition); await flush()
    assert.ok(view.byId('suite-import-preview'))
    await invoke(discard)
    assert.equal(!!view.byId('suite-import-preview'), false)
    assert.equal(view.byId('suite-import-error'), undefined)
    assert.equal(view.byId('suite-name').props.value, '')
  } finally { view.unmount() }
})

function ownedSnapshot(view, index = 0, state = 'succeeded', content = 'Current response') {
  const request = view.requests.calls.startPromptTrial[index].args[0], snapshot = trialSnapshot(state)
  snapshot.run.request_id = request.request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  snapshot.run.configuration = { model: 'current-configured-model', reasoning_effort: 'low' }
  if (snapshot.run.response) snapshot.run.response.content = content
  return snapshot
}

for (const phase of ['submitting', 'running', 'waiting', 'unknown', 'completed']) test(`report reuse preserves the current ${phase} capture and its execution ownership`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const current = savedRun({ name: 'Current suite', count: phase === 'completed' ? 1 : 2 }).definition
    current.cases.forEach((item, index) => { item.user_prompt = `Current prompt ${index}`; item.expected_text = null })
    await view.file(definitionFile(current)); await view.click('suite-import-use')
    await view.submit('suite-form'); await idle(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    if (phase === 'unknown') {
      view.requests.calls.startPromptTrial[0].reject(new Error('Uncertain submission')); await flush()
      view.requests.calls.getPromptTrial[0].reject(new Error('Uncertain observation')); await flush()
      assert.ok(view.byId('suite-reconcile'))
    } else if (phase !== 'submitting') {
      view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view, 0, phase === 'running' ? 'running' : 'succeeded'))); await flush()
    }
    const existing = await exported(view, 'run'), before = calls(view), timers = [...view.timers.pending]
    const source = savedRun({ version: 2, name: 'Historical draft replacement', status: 'halted', rowStatus: 'unknown' })
    // Rejected, failed and discarded imports preserve both the current draft and captured run.
    const invalid = clone(source); invalid.cases[0].request_id = id(999)
    await view.runFile(runFile(invalid)); assert.ok(view.byId('suite-import-error'))
    assert.deepEqual(await exported(view), current)
    assert.deepEqual(await exported(view, 'run'), existing)
    await view.runFile({ size: 10, arrayBuffer: async () => { throw new Error('PRIVATE READ FAILURE') } })
    assert.deepEqual(await exported(view, 'run'), existing)
    await view.runFile(runFile(source)); await view.click('suite-import-cancel')
    assert.deepEqual(await exported(view), current)
    await view.runFile(runFile(source)); await view.click('suite-import-use')
    assert.deepEqual(await exported(view), source.definition)
    assert.deepEqual(await exported(view, 'run'), existing)
    assert.deepEqual(calls(view), before)
    assert.deepEqual([...view.timers.pending], timers)
    assert.equal(view.requests.calls.startPromptTrial[0].signal.aborted, false)
    if (phase === 'unknown') {
      assert.ok(view.byId('suite-reconcile'))
      await view.click('suite-reconcile')
      const reconciliation = view.requests.calls.getPromptTrial.at(-1)
      assert.equal(reconciliation.args[0], existing.cases[0].request_id)
      assert.notEqual(reconciliation.args[0], source.cases[0].request_id)
      reconciliation.resolve(ok(ownedSnapshot(view))); await flush()
      await view.timers.advance(100000)
      assert.equal(view.requests.calls.startPromptTrial.length, 1)
      const reconciled = await exported(view, 'run')
      assert.equal(reconciled.cases[0].status, 'succeeded')
      assert.equal(reconciled.cases[1].status, 'not_attempted')
      assert.deepEqual(reconciled.definition, current)
    } else if (phase !== 'completed') {
      if (phase === 'submitting') { view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view))); await flush() }
      if (phase === 'running') {
        await view.timers.advance(1499); assert.deepEqual(calls(view), before)
        await view.timers.advance(1)
        const observation = view.requests.calls.getPromptTrial.at(-1)
        assert.equal(observation.args[0], existing.cases[0].request_id)
        observation.resolve(ok(ownedSnapshot(view))); await flush()
      }
      await view.timers.advance(1500); await idle(view)
      assert.equal(view.requests.calls.startPromptTrial.length, 2)
      assert.equal(view.requests.calls.startPromptTrial[1].args[0].user_prompt, current.cases[1].user_prompt)
      view.requests.calls.startPromptTrial[1].resolve(ok(ownedSnapshot(view, 1))); await flush()
      const completed = await exported(view, 'run')
      assert.equal(completed.status, 'completed')
      assert.deepEqual(completed.definition, current)
      assert.equal(completed.cases[0].snapshot.run.configuration.model, 'current-configured-model')
      assert.deepEqual(await exported(view), source.definition)
    }
    assert.doesNotMatch(view.text(), /PRIVATE READ FAILURE/)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const version of [1, 2]) test(`explicit Run of imported v${version} cases uses fresh IDs, readiness and current observations`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const source = savedRun({ version, status: 'halted', rowStatus: 'truncated' })
    await view.runFile(runFile(source)); await view.click('suite-import-use')
    const before = calls(view)
    await view.timers.advance(100000)
    assert.deepEqual(calls(view), before)
    await view.submit('suite-form')
    assert.equal(view.requests.calls.getPromptTrials.length, 2)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    await idle(view)
    const requestIds = new Set(), sourceIds = new Set([source.run_id, ...source.cases.map(row => row.request_id).filter(Boolean)])
    for (let index = 0; index < source.definition.cases.length; index++) {
      if (index > 0) { await view.timers.advance(1500); await idle(view) }
      const request = view.requests.calls.startPromptTrial[index].args[0], item = source.definition.cases[index]
      assert.ok(!sourceIds.has(request.request_id)); assert.ok(!requestIds.has(request.request_id))
      requestIds.add(request.request_id)
      assert.deepEqual(Object.keys(request).sort(), [...Object.keys(trialRequest()), 'request_id'].sort())
      for (const key of Object.keys(trialRequest())) assert.equal(request[key], item[key])
      const reply = index === 1 ? '' : index === 2 && version === 2 ? '{"ok":true}' : 'Hello back'
      view.requests.calls.startPromptTrial[index].resolve(ok(ownedSnapshot(view, index, 'succeeded', reply))); await flush()
    }
    const rerun = await exported(view, 'run')
    assert.equal(rerun.status, 'completed')
    assert.equal(rerun.schema_version, version)
    assert.deepEqual(rerun.definition, source.definition)
    assert.ok(!sourceIds.has(rerun.run_id)); assert.ok(!requestIds.has(rerun.run_id))
    assert.deepEqual(rerun.cases.map(row => row.case_id), source.definition.cases.map(item => item.case_id))
    assert.deepEqual(rerun.cases.map(row => row.snapshot.run.configuration.model), Array(3).fill('current-configured-model'))
    assert.equal(rerun.cases[1].check, 'matched'); assert.equal(rerun.cases[2].check, 'matched')
    assert.equal(view.requests.calls.getPromptTrial.length, 0)
    assert.deepEqual(calls(view), { getPromptTrials: 4, getPromptTrial: 0, startPromptTrial: 3 })
  } finally { view.unmount() }
})

test('adopted cases remain offline-editable and explicit Run obeys current readiness and freshly loaded caps', async () => {
  const view = await mountSuites()
  try {
    const offline = trialSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required' })
    offline.limits.max_output_tokens = null
    await idle(view, offline)
    const source = savedRun({ version: 2 })
    await view.runFile(runFile(source)); await view.click('suite-import-use')
    assert.deepEqual(await exported(view), source.definition)
    assert.equal(view.byId('suite-run').props.disabled, true)
    assert.deepEqual(calls(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
    const lower = trialSnapshot(); lower.limits.max_output_tokens = 64
    await view.click('suite-refresh'); await idle(view, lower)
    assert.ok(view.byId('suite-cap-warning'))
    assert.equal(view.byId('suite-run').props.disabled, true)
    await view.click('suite-refresh'); await idle(view)
    assert.equal(view.byId('suite-run').props.disabled, false)
    await view.submit('suite-form'); await idle(view, lower)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    assert.equal(view.byId('suite-run-report'), undefined)
    assert.match(view.text(view.byId('suite-error')), /output limit/)
    assert.deepEqual(await exported(view), source.definition)
  } finally { view.unmount() }
})
