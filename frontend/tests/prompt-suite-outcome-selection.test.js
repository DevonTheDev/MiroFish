import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites as mountView, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'
import { evaluatePromptSuiteCheck, parsePromptSuiteDefinition, parsePromptSuiteReport } from '../src/utils/promptSuites.js'

// Exercise the actual compiled component and its production-cached handlers.
const mount = options => mountView({ ...options, cacheHandlers: true })
const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const clone = value => JSON.parse(JSON.stringify(value))
const kinds = version => ['none', 'exact_text', 'exact_text', ...(version >= 2 ? ['json_object'] : []), ...(version >= 3 ? ['json_fields'] : [])]
function captured({ version = 3, name = '<script>Captured 雪</script>', outcome = null, healthy = false } = {}) {
  const definition = { schema_version: version, kind: 'mirofish_local_prompt_suite', name,
    cases: kinds(version).map((kind, index) => ({ case_id: id(100 + index), ...trialRequest(),
      label: `Case <${index}>`, system_prompt: '\tKeep <b>literal</b>\r\n', user_prompt: ` reply ${index} 雪\r\n`,
      temperature: 0.37, max_output_tokens: 64, expected_text: kind === 'exact_text' ? index === 1 ? '' : ' expected\r\n' : null,
      ...(version >= 2 ? { check_kind: kind } : {}), ...(version >= 3 ? { required_fields: kind === 'json_fields'
        ? [{ name: ' answer ', type: 'string' }, { name: '__proto__', type: 'object' }] : null } : {}) })) }
  const cases = definition.cases.map((item, index) => {
    const status = !outcome || index < 1 ? 'succeeded' : index === 1 ? outcome : 'not_attempted'
    const kind = kinds(version)[index]
    const reply = kind === 'none' ? 'PRIVATE historical reply' : kind === 'exact_text' ? healthy || index === 1 ? item.expected_text : 'wrong'
      : healthy ? '{" answer ":"yes","__proto__":{}}' : kind === 'json_object' ? '[]' : '{}'
    let snapshot = null
    if (!['not_attempted', 'submitting', 'rejected'].includes(status)) {
      const raw = trialSnapshot(status === 'unknown' ? 'running' : status)
      raw.run.request_id = id(200 + index)
      raw.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, item[key]]))
      raw.run.configuration.model = 'historical-private-model'
      if (raw.run.response) raw.run.response.content = reply
      if (status === 'truncated') raw.run.response.finish_reason = 'length'
      if (status === 'refused') raw.run.response.refusal = 'Recorded refusal'
      if (['failed', 'timed_out', 'cancelled'].includes(status)) { raw.run.response = null; raw.run.error_code = 'internal_failure' }
      snapshot = acceptPromptTrialSnapshot(ok(raw))
    }
    return { case_id: item.case_id, request_id: status === 'not_attempted' ? null : id(200 + index), status,
      check: evaluatePromptSuiteCheck(item, status, reply), snapshot, error_code: status === 'unknown' ? 'read_failed' : null }
  })
  const status = !outcome ? 'completed' : ['running', 'submitting'].includes(outcome) ? 'running' : outcome === 'not_attempted' ? 'stopped' : 'halted'
  const report = { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(1), definition,
    started_at: '2026-10-03T12:59:59Z', finished_at: status === 'running' ? null : '2026-10-03T13:00:00Z',
    status, stop_requested: status === 'stopped', halt_code: status === 'halted' ? 'runtime_failed' : null, cases }
  // Invalid fixture shapes must fail before testing any view behavior.
  parsePromptSuiteReport(JSON.stringify(report))
  return report
}
const runFile = value => { const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)); return { size: bytes.length, arrayBuffer: async () => bytes.buffer } }
const definitionFile = value => { const text = JSON.stringify(value); return { size: new TextEncoder().encode(text).length, text: async () => text } }
const counts = view => Object.fromEntries(Object.entries(view.requests.calls).map(([key, calls]) => [key, calls.length]))
const action = (view, name, event = 'onClick') => { const control = view.byId(name); assert.ok(control, `missing ${name}`); return control.props[event] }
async function invoke(handler, checked) { handler({ target: { checked }, button: 0, preventDefault() {}, stopPropagation() {} }); await flush() }
async function ready(view) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush() }
async function exported(view, kind = 'definition') {
  await view.click(`suite-export-${kind}`)
  const text = await view.downloads.at(-1).blob.text()
  return kind === 'run' ? parsePromptSuiteReport(text) : parsePromptSuiteDefinition(text)
}
const words = {
  en: { outcome: 'Recorded outcome', check: 'Recorded check', include: 'Include in reused draft', all: 'Select all', attention: 'Select cases needing attention',
    apply: 'Use selected cases as draft', full: 'Use captured cases as draft', empty: /Select at least one captured case/, count: (a, b) => `${a} of ${b} cases selected` },
  zh: { outcome: '记录的运行结果', check: '记录的检查结果', include: '纳入复用草稿', all: '选择全部', attention: '选择需要关注的用例',
    apply: '将所选用例用作草稿', full: '将已捕获用例用作草稿', empty: /至少选择一个已捕获用例/, count: (a, b) => `已选择 ${a}/${b} 个用例` },
}
function selection(view, source, indices, locale = 'en') {
  const count = view.byId('suite-import-selection-count')
  assert.ok(count, 'saved-run previews show selected/total count')
  assert.equal(view.text(count), words[locale].count(indices.length, source.definition.cases.length))
  source.definition.cases.forEach((_item, index) => assert.equal(view.byId(`suite-import-case-${index}-included`).props.checked, indices.includes(index)))
  assert.equal(view.byId('suite-import-use').props.disabled, indices.length === 0)
}

for (const locale of ['en', 'zh']) for (const version of [1, 2, 3]) test(`v${version} recorded checks select exact detached source-order subsets in ${locale}`, async () => {
  const view = await mount({ locale })
  try {
    const source = captured({ version }), expected = clone(source.definition), before = counts(view)
    await view.runFile(runFile(source))
    selection(view, source, source.cases.map((_row, index) => index), locale)
    assert.equal(view.text(view.byId('suite-import-use')), words[locale].full)
    assert.equal(view.text(view.byId('suite-import-select-all')), words[locale].all)
    assert.equal(view.text(view.byId('suite-import-select-attention')), words[locale].attention)
    assert.equal(view.byId('suite-name').props.value, '')
    const preview = view.byId('suite-import-preview')
    assert.match(view.text(preview), /<script>Captured 雪<\/script>/)
    assert.equal(view.all(node => node.type === 'script' || Object.hasOwn(node.props, 'innerHTML')).length, 0)
    assert.doesNotMatch(view.text(preview), /historical-private-model|PRIVATE historical reply/)
    source.cases.forEach((row, index) => {
      const outcome = view.byId(`suite-import-case-${index}-status`), check = view.byId(`suite-import-case-${index}-check`)
      assert.equal(view.text(outcome), view.i18n.global.t(`promptSuites.caseStates.${row.status}`))
      const group = kinds(version)[index] === 'json_fields' ? 'jsonFieldsChecks' : kinds(version)[index] === 'json_object' ? 'jsonChecks' : 'checks'
      assert.equal(view.text(check), view.i18n.global.t(`promptSuites.${group}.${row.check}`))
      assert.match(view.text(outcome.parent), new RegExp(words[locale].outcome))
      assert.match(view.text(check.parent), new RegExp(words[locale].check))
      const checkbox = view.byId(`suite-import-case-${index}-included`)
      assert.equal(checkbox.type, 'input'); assert.equal(checkbox.props.type, 'checkbox'); assert.equal(checkbox.parent.type, 'label')
      assert.equal(view.text(checkbox.parent).trim(), words[locale].include)
    })
    await view.click('suite-import-select-attention')
    selection(view, source, source.cases.map((_row, index) => index).filter(index => index >= 2), locale)
    assert.equal(view.text(view.byId('suite-import-use')), words[locale].apply)
    // Inclusion order is independent of click order, and empty exact text survives.
    for (let index = source.cases.length - 1; index >= 0; index--) await view.change(`suite-import-case-${index}-included`, false)
    await view.change(`suite-import-case-${source.cases.length - 1}-included`, true)
    await view.change('suite-import-case-1-included', true)
    selection(view, source, [1, source.cases.length - 1], locale)
    source.definition.cases[1].expected_text = 'mutated source'
    if (version === 3) source.definition.cases.at(-1).required_fields[0].name = 'mutated source'
    await view.click('suite-import-use')
    const selected = { ...expected, cases: [expected.cases[1], expected.cases.at(-1)] }
    assert.deepEqual(await exported(view), selected)
    assert.deepEqual(await exported(view, 'selection'), selected)
    selected.cases.forEach((_item, index) => assert.equal(view.byId(`suite-case-${index}-included`).props.checked, true))
    assert.equal(view.byId('suite-import-preview'), undefined); assert.equal(view.byId('suite-run-report'), undefined)
    assert.deepEqual(counts(view), before)
    await view.input('suite-case-0-user_prompt', 'changed draft')
    if (version === 3) await view.input('suite-case-1-required-field-0-name', 'changed draft field')
    await view.runFile(runFile(captured({ version })))
    assert.match(view.text(view.byId('suite-import-preview')), /reply 1 雪/)
    if (version === 3) assert.match(view.text(view.byId(`suite-import-case-${source.cases.length - 1}-required-fields`)), /" answer ": string/)
    // Retain the original schema even when its only modern check is omitted.
    for (let index = 1; index < source.cases.length; index++) await view.change(`suite-import-case-${index}-included`, false)
    await view.click('suite-import-use')
    assert.deepEqual(await exported(view), { ...expected, cases: [expected.cases[0]] })
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) for (const outcome of ['failed', 'truncated', 'refused', 'timed_out', 'cancelled', 'rejected', 'unknown', 'running', 'submitting', 'not_attempted']) {
  test(`${outcome} and unattempted tails keep their recorded identity when selected in ${locale}`, async () => {
    const view = await mount({ locale })
    try {
      const source = captured({ outcome }), before = counts(view)
      await view.runFile(runFile(source)); await view.click('suite-import-select-attention')
      selection(view, source, [1, 2, 3, 4], locale)
      assert.equal(view.text(view.byId('suite-import-case-1-status')), view.i18n.global.t(`promptSuites.caseStates.${outcome}`))
      assert.equal(view.text(view.byId('suite-import-case-2-status')), view.i18n.global.t('promptSuites.caseStates.not_attempted'))
      assert.equal(view.text(view.byId('suite-import-case-1-check')), view.i18n.global.t('promptSuites.checks.not_evaluated'))
      await view.click('suite-import-use')
      assert.deepEqual(await exported(view), { ...source.definition, cases: source.definition.cases.slice(1) })
      assert.equal(view.byId('suite-run-report'), undefined); assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
    } finally { view.unmount() }
  })
}

for (const locale of ['en', 'zh']) test(`healthy captures select no attention cases and empty Apply stays inert in ${locale}`, async () => {
  const view = await mount({ locale })
  try {
    const source = captured({ healthy: true }), original = captured({ version: 1 }).definition
    await view.file(definitionFile(original)); await view.click('suite-import-use'); await view.change('suite-case-0-included', false)
    const before = counts(view)
    await view.runFile(runFile(source)); const apply = action(view, 'suite-import-use')
    await view.click('suite-import-select-attention')
    selection(view, source, [], locale)
    assert.match(view.text(view.byId('suite-import-selection-empty')), words[locale].empty)
    await invoke(apply); await invoke(action(view, 'suite-import-use'))
    assert.ok(view.byId('suite-import-preview'))
    assert.deepEqual(await exported(view), original)
    assert.equal(view.byId('suite-case-0-included').props.checked, false)
    await view.click('suite-import-select-all')
    selection(view, source, [0, 1, 2, 3, 4], locale)
    assert.equal(view.byId('suite-import-selection-empty'), undefined)
    assert.equal(view.text(view.byId('suite-import-use')), words[locale].full)
    await view.click('suite-import-use'); assert.deepEqual(await exported(view), source.definition)
    assert.ok(source.definition.cases.every((_item, index) => view.byId(`suite-case-${index}-included`).props.checked))
    await view.file(definitionFile(original))
    assert.equal(view.byId('suite-import-select-all'), undefined); assert.equal(view.byId('suite-import-selection-count'), undefined)
    assert.equal(view.byId('suite-import-case-0-included'), undefined)
    await view.click('suite-import-use'); assert.deepEqual(await exported(view), original)
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('checkbox, shortcut and Apply owners survive valid changes but retire across A→B→A and every dismissal', async () => {
  const view = await mount()
  let unmounted = false
  try {
    const a = captured(), b = captured({ name: 'Replacement B' }), before = counts(view)
    const captureHandlers = () => ({ checkbox: action(view, 'suite-import-case-0-included', 'onChange'),
      attention: action(view, 'suite-import-select-attention'), all: action(view, 'suite-import-select-all'), apply: action(view, 'suite-import-use') })
    const stale = async controls => { await invoke(controls.checkbox, false); await invoke(controls.attention); await invoke(controls.all); await invoke(controls.apply) }
    await view.runFile(runFile(a)); const oldA = captureHandlers()
    await invoke(oldA.checkbox, false); selection(view, a, [1, 2, 3, 4])
    await invoke(oldA.checkbox, true); selection(view, a, [0, 1, 2, 3, 4])
    await view.runFile(runFile(b)); const oldB = captureHandlers()
    await stale(oldA); selection(view, b, [0, 1, 2, 3, 4]); assert.equal(view.byId('suite-name').props.value, '')
    await view.runFile(runFile(a)); await stale(oldA); await stale(oldB)
    selection(view, a, [0, 1, 2, 3, 4]); assert.equal(view.byId('suite-name').props.value, '')
    for (const replacement of ['discard', 'invalid', 'empty-file', 'definition', 'pending', 'apply']) {
      const old = captureHandlers()
      if (replacement === 'discard') await view.click('suite-import-cancel')
      if (replacement === 'invalid') await view.runFile(runFile('{'))
      if (replacement === 'empty-file') await view.runFile(null)
      if (replacement === 'definition') await view.file(definitionFile(b.definition))
      let resolve
      if (replacement === 'pending') await view.runFile({ size: 100, arrayBuffer: () => new Promise(done => { resolve = done }) })
      if (replacement === 'apply') await view.click('suite-import-use')
      await stale(old)
      if (resolve) { resolve(new TextEncoder().encode(JSON.stringify(b)).buffer); await flush() }
      await view.runFile(runFile(a)); await view.change('suite-import-case-0-included', false)
      await stale(old); selection(view, a, [1, 2, 3, 4])
    }
    const old = captureHandlers()
    await view.navigate('/prompt-trials'); await view.navigate('/prompt-suites')
    await view.runFile(runFile(b)); await stale(old); selection(view, b, [0, 1, 2, 3, 4])
    assert.equal(view.byId('suite-name').props.value, '')
    const final = captureHandlers(), downloads = view.downloads.length
    view.unmount(); unmounted = true; await stale(final)
    assert.equal(view.downloads.length, downloads); assert.equal(view.requests.calls.startPromptTrial.length, before.startPromptTrial)
    assert.equal(view.timers.pending.size, 0); assert.deepEqual(view.warnings, [])
  } finally { if (!unmounted) view.unmount() }
})

test('a forged healthy row still rejects the whole report before attention filtering', async () => {
  const view = await mount()
  try {
    const source = captured(), original = captured({ version: 1 }).definition
    await view.file(definitionFile(original)); await view.click('suite-import-use')
    await view.runFile(runFile(source)); const old = action(view, 'suite-import-select-attention')
    source.cases[0].snapshot.run.request.user_prompt = 'forged excluded unchecked case'
    await view.runFile(runFile(source)); await invoke(old)
    assert.ok(view.byId('suite-import-error')); assert.equal(view.byId('suite-import-preview'), undefined)
    assert.deepEqual(await exported(view), original); assert.deepEqual(counts(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

test('Apply owns its rendered selection revision, including selection A→B→A', async () => {
  const view = await mount()
  try {
    const source = captured()
    await view.runFile(runFile(source))
    const originalApply = action(view, 'suite-import-use'), checkbox = action(view, 'suite-import-case-0-included', 'onChange')
    await invoke(checkbox, false)
    const subsetApply = action(view, 'suite-import-use')
    await invoke(originalApply)
    assert.equal(view.byId('suite-name').props.value, ''); selection(view, source, [1, 2, 3, 4])
    await invoke(checkbox, true)
    await invoke(originalApply); await invoke(subsetApply)
    assert.equal(view.byId('suite-name').props.value, ''); selection(view, source, [0, 1, 2, 3, 4])
    await view.click('suite-import-select-attention'); const attentionApply = action(view, 'suite-import-use')
    await view.click('suite-import-select-all'); await invoke(attentionApply)
    selection(view, source, [0, 1, 2, 3, 4]); assert.equal(view.byId('suite-name').props.value, '')
    await view.click('suite-import-use'); assert.deepEqual(await exported(view), source.definition)
    assert.deepEqual(counts(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
  } finally { view.unmount() }
})

function currentSnapshot(view, index, status = 'succeeded') {
  const request = view.requests.calls.startPromptTrial[index].args[0], snapshot = trialSnapshot(status)
  snapshot.run.request_id = request.request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  snapshot.run.configuration.model = 'current-configured-model'
  return snapshot
}
for (const phase of ['submitting', 'running', 'paused', 'unknown', 'completed']) test(`outcome selection preserves the current ${phase} execution and displayed report`, async () => {
  const view = await mount()
  try {
    await ready(view)
    const source = captured(), current = captured({ version: 1, name: 'Current suite' }).definition
    if (phase === 'completed') current.cases = [current.cases[0]]
    await view.file(definitionFile(current)); await view.click('suite-import-use')
    await view.submit('suite-form'); await ready(view)
    if (phase === 'paused') await view.click('suite-pause')
    if (phase === 'unknown') {
      view.requests.calls.startPromptTrial[0].reject(new Error('Unconfirmed POST')); await flush()
      view.requests.calls.getPromptTrial[0].reject(new Error('Unconfirmed GET')); await flush()
    } else if (phase !== 'submitting') {
      view.requests.calls.startPromptTrial[0].resolve(ok(currentSnapshot(view, 0, phase === 'running' ? 'running' : 'succeeded'))); await flush()
    }
    const report = await exported(view, 'run'), before = counts(view), timers = [...view.timers.pending]
    if (phase === 'paused') assert.equal(view.byId('suite-scheduling-state').props['data-phase'], 'paused')
    await view.runFile(runFile(source)); await view.click('suite-import-select-attention')
    await view.change('suite-import-case-2-included', false); await view.click('suite-import-use')
    assert.deepEqual(await exported(view), { ...source.definition, cases: source.definition.cases.slice(3) })
    assert.deepEqual(await exported(view, 'run'), report)
    assert.deepEqual(counts(view), before); assert.deepEqual([...view.timers.pending], timers)
    assert.equal(view.requests.calls.startPromptTrial[0].signal.aborted, false)
    if (phase === 'paused') {
      assert.equal(view.byId('suite-resume').props.disabled, false)
      await view.click('suite-resume'); await view.timers.advance(1500); await ready(view)
      assert.equal(view.requests.calls.startPromptTrial[1].args[0].user_prompt, current.cases[1].user_prompt)
    }
    if (phase === 'unknown') {
      await view.click('suite-reconcile')
      assert.equal(view.requests.calls.getPromptTrial.at(-1).args[0], report.cases[0].request_id)
    }
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const version of [1, 2, 3]) test(`explicit rerun of selected v${version} cases creates fresh execution IDs with exact inputs`, async () => {
  const view = await mount()
  try {
    await ready(view)
    const source = captured({ version }), selected = { ...source.definition, cases: source.definition.cases.slice(2) }
    await view.runFile(runFile(source)); await view.click('suite-import-select-attention'); await view.click('suite-import-use')
    assert.deepEqual(counts(view), { getPromptTrials: 1, getPromptTrial: 0, startPromptTrial: 0 })
    await view.submit('suite-form')
    assert.equal(view.requests.calls.getPromptTrials.length, 2); assert.equal(view.requests.calls.startPromptTrial.length, 0)
    await ready(view)
    for (let index = 0; index < selected.cases.length; index++) {
      if (index) { await view.timers.advance(1500); await ready(view) }
      const request = view.requests.calls.startPromptTrial[index].args[0]
      assert.deepEqual(Object.keys(request).sort(), [...Object.keys(trialRequest()), 'request_id'].sort())
      assert.deepEqual(Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]])),
        Object.fromEntries(Object.keys(trialRequest()).map(key => [key, selected.cases[index][key]])))
      view.requests.calls.startPromptTrial[index].resolve(ok(currentSnapshot(view, index))); await flush()
    }
    const result = await exported(view, 'run'), oldIds = new Set([source.run_id, ...source.cases.map(row => row.request_id)]), newIds = [result.run_id, ...result.cases.map(row => row.request_id)]
    assert.equal(result.status, 'completed'); assert.deepEqual(result.definition, selected)
    assert.equal(new Set(newIds).size, newIds.length); assert.ok(newIds.every(id => !oldIds.has(id)))
    assert.ok(result.cases.every(row => row.snapshot.run.configuration.model === 'current-configured-model'))
    assert.equal(view.requests.calls.startPromptTrial.length, selected.cases.length)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})
