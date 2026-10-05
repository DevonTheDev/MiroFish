import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites as mountView, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { parsePromptSuiteDefinition, parsePromptSuiteReport } from '../src/utils/promptSuites.js'

// Compile the real component/template with cached handlers and run its real
// state machine. Only transport, clock and download delivery are controlled.
const mountSuites = options => mountView({ ...options, cacheHandlers: true })
const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const labels = {
  en: { include: 'Include in next run', run: 'Run selected cases once', export: 'Download selected definition', fullExport: 'Download full definition',
    count: (selected, total) => `${selected} of ${total} cases selected`, empty: /Select at least one case/, invalid: /selected cases/, full: /full draft/i, session: /Selection.*this page session/ },
  zh: { include: '包含在下次运行中', run: '运行所选用例一次', export: '下载所选用例定义', fullExport: '下载完整定义',
    count: (selected, total) => `已选择 ${selected}/${total} 个用例`, empty: /至少选择一个用例/, invalid: /所选用例/, full: /完整草稿/, session: /选择.*当前页面会话/ },
}
function item(version, kind, number) {
  return { case_id: id(number), ...trialRequest(), label: ` Case ${number} `, system_prompt: ' system\r\n\t',
    user_prompt: ` original ${number}\r\n`, temperature: 0.37, max_output_tokens: 64,
    expected_text: kind === 'exact_text' ? number % 2 ? ' literal\r\n' : '' : null,
    ...(version >= 2 ? { check_kind: kind } : {}),
    ...(version >= 3 ? { required_fields: kind === 'json_fields' ? [{ name: ' answer ', type: 'string' }, { name: '__proto__', type: 'object' }] : null } : {}) }
}
const definition = (version = 1, cases = [item(version, 'none', 100), item(version, 'exact_text', 101)]) =>
  ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: ' Selected suite ', cases })
const counts = view => Object.fromEntries(Object.entries(view.requests.calls).map(([key, calls]) => [key, calls.length]))
const caseIds = view => view.all(node => node.type === 'fieldset' && node.props['data-case-id']).map(node => node.props['data-case-id'])
const file = source => { const text = JSON.stringify(source); return { size: new TextEncoder().encode(text).length, text: async () => text } }
const runFile = source => { const bytes = new TextEncoder().encode(JSON.stringify(source)); return { size: bytes.length, arrayBuffer: async () => bytes.buffer } }
async function importDefinition(view, source) { await view.file(file(source)); await view.click('suite-import-use') }
async function exported(view, kind = 'selection') {
  await view.click(`suite-export-${kind}`)
  return kind === 'run' ? parsePromptSuiteReport(await view.downloads.at(-1).blob.text()) : parsePromptSuiteDefinition(await view.downloads.at(-1).blob.text())
}
async function readiness(view, source = trialSnapshot()) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(source)); await flush() }
async function settlePost(view) {
  const post = view.requests.calls.startPromptTrial.at(-1), snapshot = trialSnapshot('succeeded')
  snapshot.run.request_id = post.args[0].request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, post.args[0][key]]))
  snapshot.run.response.content = '{" answer ":"yes","__proto__":{}}'
  post.resolve(ok(snapshot)); await flush()
}
async function include(view, index, checked) { await view.change(`suite-case-${index}-included`, checked) }
async function invoke(action, checked) { action({ target: { checked }, button: 0, preventDefault() {}, stopPropagation() {} }); await flush() }
function assertSelection(view, included, locale = 'en') {
  const ids = caseIds(view)
  assert.equal(view.text(view.byId('suite-selection-count')), labels[locale].count(included.length, ids.length))
  ids.forEach((caseId, index) => assert.equal(view.byId(`suite-case-${index}-included`).props.checked, included.includes(caseId)))
}

for (const locale of ['en', 'zh']) test(`selection defaults, empty guidance and native checkbox controls in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    const checkbox = view.byId('suite-case-0-included')
    assert.ok(checkbox, 'every draft case needs an inclusion checkbox')
    assert.equal(checkbox.type, 'input'); assert.equal(checkbox.props.type, 'checkbox')
    assert.equal(checkbox.props.checked, true); assert.equal(checkbox.parent.type, 'label')
    assert.equal(view.text(checkbox.parent).trim(), labels[locale].include)
    assert.equal(view.text(view.byId('suite-run')), labels[locale].run)
    assert.equal(view.text(view.byId('suite-export-definition')), labels[locale].fullExport)
    assert.equal(view.text(view.byId('suite-export-selection')), labels[locale].export)
    assertSelection(view, caseIds(view), locale)
    assert.match(view.text(view.byId('suite-selection-validation')), labels[locale].invalid)
    assert.match(view.text(), labels[locale].session)
    assert.equal(view.byId('suite-export-selection').props.disabled, true)
    assert.ok(Object.hasOwn(view.byId('suite-form').props, 'novalidate'), 'native validation must not block excluded invalid fields')
    await readiness(view)
    const source = definition()
    await importDefinition(view, source)
    const before = counts(view)
    assertSelection(view, source.cases.map(value => value.case_id), locale)
    assert.equal(view.byId('suite-run').props.disabled, false)
    for (let index = 0; index < source.cases.length; index++) await include(view, index, false)
    assertSelection(view, [], locale)
    assert.equal(view.byId('suite-run').props.disabled, true)
    assert.equal(view.byId('suite-export-selection').props.disabled, true)
    assert.equal(view.byId('suite-export-definition').props.disabled, false)
    assert.match(view.text(view.byId('suite-selection-validation')), labels[locale].empty)
    await invoke(view.byId('suite-export-selection').props.onClick)
    await view.submit('suite-form')
    assert.equal(view.downloads.length, 0)
    assert.deepEqual(await exported(view, 'definition'), source)
    await include(view, 1, true)
    assertSelection(view, [source.cases[1].case_id], locale)
    assert.equal(view.byId('suite-selection-validation'), undefined)
    assert.deepEqual(await exported(view), { ...source, cases: [source.cases[1]] })
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) for (const version of [1, 2, 3]) test(`v${version} subset exports retain original ordered IDs and checks offline in ${locale}`, async () => {
  const view = await mountSuites({ locale }), fresh = await mountSuites({ locale })
  try {
    const kinds = ['none', 'exact_text', 'exact_text', ...(version >= 2 ? ['json_object'] : []), ...(version >= 3 ? ['json_fields'] : [])]
    const source = definition(version, kinds.map((kind, index) => item(version, kind, 99 + index)))
    await importDefinition(view, source)
    const before = counts(view)
    assert.equal(view.byId('suite-run').props.disabled, true, 'readiness remains unresolved')
    await include(view, 0, false)
    await view.click(`suite-case-${source.cases.length - 1}-move-up`)
    const ordered = [...source.cases], last = ordered.pop(); ordered.splice(ordered.length - 1, 0, last)
    const selected = { ...source, cases: ordered.filter(value => value.case_id !== source.cases[0].case_id) }
    assert.deepEqual(await exported(view), selected)
    assert.equal(view.downloads.at(-1).filename, 'local_prompt_suite_selection.json')
    assert.equal(view.downloads.at(-1).blob.type, 'application/json')
    assert.deepEqual(await exported(view, 'definition'), { ...source, cases: ordered })
    assert.equal(view.downloads.at(-1).filename, 'local_prompt_suite.json')
    assert.equal(view.revokedUrls.length, 2); assert.equal(view.removedAnchors.length, 2)
    await importDefinition(fresh, selected)
    assertSelection(fresh, selected.cases.map(value => value.case_id), locale)
    assert.deepEqual(await exported(fresh, 'definition'), selected)
    assert.deepEqual(await exported(fresh), selected)
    // Selecting only the legacy-compatible case must still retain v2/v3.
    for (let index = 0; index < ordered.length; index++) await include(view, index, index === 0)
    assert.deepEqual(await exported(view), { ...source, cases: [source.cases[0]] })
    assert.deepEqual(counts(view), before)
    assert.deepEqual(view.warnings, []); assert.deepEqual(fresh.warnings, [])
  } finally { view.unmount(); fresh.unmount() }
})

for (const locale of ['en', 'zh']) for (const invalid of ['user_prompt', 'temperature', 'max_output_tokens', 'required-field']) {
  test(`invalid ${invalid} blocks only an included case in ${locale}`, async () => {
    const view = await mountSuites({ locale })
    try {
      await readiness(view)
      const source = definition(3, [item(3, 'none', 100), item(3, 'json_fields', 101)])
      await importDefinition(view, source)
      await view.input(`suite-case-1-${invalid === 'required-field' ? 'required-field-0-name' : invalid}`, '')
      assert.equal(view.byId('suite-run').props.disabled, true)
      assert.equal(view.byId('suite-export-selection').props.disabled, true)
      assert.match(view.text(view.byId('suite-selection-validation')), labels[locale].invalid)
      const invalidCounts = counts(view)
      await view.submit('suite-form')
      assert.deepEqual(counts(view), invalidCounts, 'invalid selected cases cannot trigger readiness or inference')
      await include(view, 1, false)
      assert.equal(view.byId('suite-run').props.disabled, false)
      assert.equal(view.byId('suite-export-selection').props.disabled, false)
      assert.equal(view.byId('suite-export-definition').props.disabled, true)
      assert.equal(view.byId('suite-selection-validation'), undefined)
      assert.match(view.text(view.byId('suite-validation')), labels[locale].full)
      const selected = { ...source, cases: [source.cases[0]] }, before = counts(view)
      assert.deepEqual(await exported(view), selected)
      await invoke(view.byId('suite-export-definition').props.onClick)
      assert.equal(view.downloads.length, 1); assert.deepEqual(counts(view), before)
      await view.input('suite-name', '')
      assert.equal(view.byId('suite-run').props.disabled, true)
      assert.equal(view.byId('suite-export-selection').props.disabled, true)
      await view.input('suite-name', source.name)
      await view.submit('suite-form'); await readiness(view)
      assert.equal(view.requests.calls.startPromptTrial.length, 1)
      assert.equal(view.requests.calls.startPromptTrial[0].args[0].user_prompt, source.cases[0].user_prompt)
      await settlePost(view)
      const report = await exported(view, 'run')
      assert.deepEqual(report.definition, selected); assert.equal(report.status, 'completed')
      await include(view, 1, true)
      assert.equal(view.byId('suite-run').props.disabled, true)
      assert.deepEqual(view.warnings, [])
    } finally { view.unmount() }
  })
}

for (const locale of ['en', 'zh']) test(`loaded output cap applies to the selected subset only in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    const snapshot = trialSnapshot(); snapshot.limits.max_output_tokens = 100
    await readiness(view, snapshot)
    const source = definition(1, [item(1, 'none', 100), { ...item(1, 'none', 101), max_output_tokens: 200 }])
    await importDefinition(view, source)
    assert.equal(view.byId('suite-run').props.disabled, true); assert.ok(view.byId('suite-cap-warning'))
    const before = counts(view)
    await include(view, 1, false)
    assert.equal(view.byId('suite-run').props.disabled, false)
    assert.equal(view.byId('suite-cap-warning'), undefined)
    assert.deepEqual(await exported(view), { ...source, cases: [source.cases[0]] })
    assert.deepEqual(await exported(view, 'definition'), source)
    await include(view, 0, false)
    assert.equal(view.byId('suite-run').props.disabled, true); assert.equal(view.byId('suite-cap-warning'), undefined)
    await include(view, 1, true)
    assert.equal(view.byId('suite-run').props.disabled, true); assert.ok(view.byId('suite-cap-warning'))
    assert.deepEqual(await exported(view), { ...source, cases: [source.cases[1]] })
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('add, duplicate, reorder and remove retain object membership and the original five-case/minimum-one limits', async () => {
  const view = await mountSuites()
  try {
    const source = definition(3, [item(3, 'json_fields', 100), item(3, 'exact_text', 101)])
    await importDefinition(view, source)
    const before = counts(view)
    await include(view, 0, false)
    const originalInclude = view.byId('suite-case-0-included').props.onChange
    await view.click('suite-case-0-duplicate')
    const copyId = caseIds(view)[1]
    assertSelection(view, [copyId, source.cases[1].case_id])
    assert.deepEqual((await exported(view)).cases[0], { ...source.cases[0], case_id: copyId })
    await view.click('suite-case-0-move-down')
    assertSelection(view, [copyId, source.cases[1].case_id])
    await invoke(originalInclude, true)
    assertSelection(view, [copyId, source.cases[0].case_id, source.cases[1].case_id])
    await invoke(originalInclude, false)
    assertSelection(view, [copyId, source.cases[1].case_id])
    await view.click('suite-add-case')
    const newId = caseIds(view)[3]
    assertSelection(view, [copyId, source.cases[1].case_id, newId])
    await include(view, 3, false)
    assert.deepEqual((await exported(view)).cases.map(value => value.case_id), [copyId, source.cases[1].case_id])
    await view.click('suite-case-0-duplicate')
    assert.equal(caseIds(view).length, 5)
    assert.equal(view.byId('suite-add-case').props.disabled, true)
    for (let index = 0; index < 5; index++) assert.equal(view.byId(`suite-case-${index}-duplicate`).props.disabled, true)
    await view.click('suite-case-2-remove')
    assert.equal(caseIds(view).includes(source.cases[0].case_id), false)
    assertSelection(view, caseIds(view).filter(value => value !== newId))
    while (caseIds(view).length > 1) await view.click('suite-case-0-remove')
    assertSelection(view, [])
    assert.equal(view.byId('suite-case-0-remove').props.disabled, true)
    await invoke(view.byId('suite-case-0-remove').props.onClick)
    assert.deepEqual(caseIds(view), [newId])
    await view.click('suite-add-case')
    assertSelection(view, [caseIds(view)[1]])
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const replacement of ['removed case', 'same-ID import', 'navigation', 'unmount']) test(`retained inclusion and removal callbacks are inert after ${replacement}`, async () => {
  const view = await mountSuites()
  let unmounted = false
  try {
    const source = definition(3, [item(3, 'json_fields', 100), item(3, 'none', 101)])
    await importDefinition(view, source)
    const oldInclude = view.byId('suite-case-0-included').props.onChange
    const oldRemove = view.byId('suite-case-0-remove').props.onClick
    await include(view, 0, false)
    if (replacement === 'removed case') await view.click('suite-case-0-remove')
    if (replacement === 'same-ID import') await importDefinition(view, { ...source, name: 'Replacement' })
    if (replacement === 'navigation') { await view.navigate('/'); await view.navigate('/prompt-suites'); await importDefinition(view, source) }
    const saved = await exported(view, 'definition'), selected = await exported(view)
    const before = counts(view)
    if (replacement === 'unmount') { view.unmount(); unmounted = true }
    for (const action of [() => invoke(oldInclude, false), () => invoke(oldInclude, true), () => invoke(oldRemove)]) {
      await action()
      if (!unmounted) {
        assert.deepEqual(await exported(view, 'definition'), saved)
        assert.deepEqual(await exported(view), selected)
        assertSelection(view, selected.cases.map(value => value.case_id))
      }
    }
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { if (!unmounted) view.unmount() }
})

test('invalid, canceled and pending imports preserve membership; successful definition and report reuse include every case', async () => {
  const view = await mountSuites()
  try {
    await readiness(view)
    const source = definition()
    await importDefinition(view, source)
    await view.submit('suite-form'); await readiness(view); await settlePost(view)
    await view.timers.advance(1500); await readiness(view); await settlePost(view)
    const report = await exported(view, 'run')
    await include(view, 0, false)
    const selected = { ...source, cases: [source.cases[1]] }, before = counts(view)
    await view.file({ size: 1, text: async () => '{' })
    assert.ok(view.byId('suite-import-error')); assert.deepEqual(await exported(view), selected)
    await view.file(file(source)); await view.click('suite-import-cancel')
    assert.deepEqual(await exported(view), selected)
    await view.file(null); assert.deepEqual(await exported(view), selected)
    let finish
    await view.file({ size: 100, text: () => new Promise(resolve => { finish = resolve }) })
    assert.deepEqual(await exported(view), selected)
    await view.click('suite-import-cancel'); finish(JSON.stringify(source)); await flush()
    assert.deepEqual(await exported(view), selected)
    await importDefinition(view, source)
    assertSelection(view, source.cases.map(value => value.case_id))
    await include(view, 1, false)
    await view.runFile(runFile(report))
    assertSelection(view, [source.cases[0].case_id])
    await view.click('suite-import-use')
    assertSelection(view, source.cases.map(value => value.case_id))
    assert.deepEqual(await exported(view), source)
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const phase of ['checking', 'active', 'paused', 'completed']) for (const version of [1, 2, 3]) test(`v${version} selected capture survives ${phase} draft changes and resume uses the captured schedule`, async () => {
  const view = await mountSuites()
  try {
    await readiness(view)
    const source = definition(version, [item(version, version === 3 ? 'json_fields' : version === 2 ? 'json_object' : 'exact_text', 100), item(version, 'none', 101), item(version, 'exact_text', 102)])
    await importDefinition(view, source); await include(view, 1, false)
    const selected = { ...source, cases: [source.cases[0], source.cases[2]] }
    await view.submit('suite-form')
    if (phase !== 'checking') await readiness(view)
    if (phase === 'paused' || phase === 'completed') {
      await settlePost(view)
      if (phase === 'paused') await view.click('suite-pause')
      else { await view.timers.advance(1500); await readiness(view); await settlePost(view) }
    }
    const saved = phase === 'checking' ? null : await exported(view, 'run'), before = counts(view)
    await include(view, 0, false); await include(view, 1, true); await include(view, 2, false)
    await view.input('suite-case-2-user_prompt', 'This draft edit must not run')
    await view.click('suite-case-2-move-up')
    await importDefinition(view, { ...source, name: 'Replacement while running', cases: source.cases.map(value => ({ ...value, user_prompt: 'Replacement input' })) })
    for (let index = 0; index < source.cases.length; index++) await include(view, index, false)
    if (saved) assert.deepEqual(await exported(view, 'run'), saved)
    assert.deepEqual(counts(view), before)
    if (phase !== 'completed') {
      if (phase === 'checking') await readiness(view)
      if (phase === 'checking' || phase === 'active') await settlePost(view)
      else await view.click('suite-resume')
      await view.timers.advance(1500); await readiness(view)
      const post = view.requests.calls.startPromptTrial.at(-1)
      assert.equal(post.args[0].user_prompt, source.cases[2].user_prompt)
      await settlePost(view)
    }
    const completed = await exported(view, 'run')
    assert.equal(completed.status, 'completed'); assert.deepEqual(completed.definition, selected)
    assert.deepEqual(completed.cases.map(value => value.case_id), selected.cases.map(value => value.case_id))
    assert.equal(view.requests.calls.startPromptTrial.length, 2)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const failure of [true, 'click']) for (const locale of ['en', 'zh']) test(`selected export cleans up and uses the existing safe failure notice for ${failure} in ${locale}`, async () => {
  const view = await mountSuites({ locale, downloadError: failure })
  try {
    await importDefinition(view, definition()); await include(view, 0, false)
    const before = counts(view)
    await view.click('suite-export-selection')
    assert.ok(view.byId('suite-export-error')); assert.equal(view.byId('suite-export-error').props.role, 'alert')
    assert.doesNotMatch(view.text(), /Private|promptSuites\./)
    assert.equal(view.downloads.length, 0)
    assert.equal(view.revokedUrls.length, failure === 'click' ? 1 : 0)
    assert.equal(view.removedAnchors.length, failure === 'click' ? 1 : 0)
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})
