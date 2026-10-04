import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { mountSuites as mountView, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'

// Exercise the compiled production template, including Vue's cached handlers.
// Only transport, timers and deliberate UUID failures use controlled boundaries.
const mountSuites = options => mountView({ ...options, cacheHandlers: true })
const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
const labels = {
  en: { duplicate: 'Duplicate case', 'move-up': 'Move up', 'move-down': 'Move down', error: 'Could not duplicate this case. Try again.' },
  zh: { duplicate: '复制用例', 'move-up': '上移', 'move-down': '下移', error: '无法复制此用例，请重试。' },
}
const rules = () => [{ name: ' answer ', type: 'string' }, { name: '__proto__', type: 'object' }, { name: 'constructor', type: 'array' }]
function item(version, kind = 'none', number = 100, expected = '') {
  return { case_id: id(number), ...trialRequest(), label: ` Case ${number} `, system_prompt: ' system\r\n\t',
    user_prompt: ' user\r\n', temperature: 0.37, max_output_tokens: 123,
    expected_text: kind === 'exact_text' ? expected : null,
    ...(version >= 2 ? { check_kind: kind } : {}),
    ...(version >= 3 ? { required_fields: kind === 'json_fields' ? rules() : null } : {}) }
}
const definition = (version = 1, cases = [item(version)]) => ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Case editing', cases })
const counts = view => Object.fromEntries(Object.entries(view.requests.calls).map(([key, calls]) => [key, calls.length]))
const controls = view => view.all(node => node.type === 'fieldset' && node.props['data-case-id'])
const handler = (view, index, action) => {
  const control = view.byId(`suite-case-${index}-${action}`)
  assert.ok(control, `missing ${action} case control`)
  assert.equal(control.props.type, 'button', 'editing must not submit the suite')
  return control.props.onClick
}
async function invoke(action, value) { action({ target: { value }, button: 0, preventDefault() {}, stopPropagation() {} }); await flush() }
async function importDefinition(view, source) {
  const text = JSON.stringify(source)
  await view.file({ size: new TextEncoder().encode(text).length, text: async () => text })
  await view.click('suite-import-use')
}
async function exported(view, kind = 'definition') {
  await view.click(`suite-export-${kind}`)
  return JSON.parse(await view.downloads.at(-1).blob.text())
}
async function readiness(view, source = trialSnapshot()) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(source)); await flush() }
async function settlePost(view) {
  const post = view.requests.calls.startPromptTrial.at(-1), snapshot = trialSnapshot('succeeded')
  snapshot.run.request_id = post.args[0].request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, post.args[0][key]]))
  snapshot.run.response.content = '{" answer ":"yes","__proto__":{},"constructor":[]}'
  post.resolve(ok(snapshot)); await flush()
}

for (const locale of ['en', 'zh']) for (const version of [1, 2, 3]) {
  for (const kind of ['none', 'exact_text', ...(version >= 2 ? ['json_object'] : []), ...(version >= 3 ? ['json_fields'] : [])]) {
    test(`duplicate preserves v${version} ${kind} exactly without readiness in ${locale}`, async () => {
      const view = await mountSuites({ locale })
      try {
        const source = definition(version, [item(version, 'none', 99), item(version, kind), item(version, 'exact_text', 101, ' literal \r\n')])
        await importDefinition(view, source)
        const before = counts(view)
        for (const action of ['duplicate', 'move-up', 'move-down']) {
          handler(view, 1, action)
          assert.equal(view.text(view.byId(`suite-case-1-${action}`)), labels[locale][action])
          assert.equal(view.byId(`suite-case-1-${action}`).props.disabled, false)
        }
        assert.equal(view.byId('suite-run').props.disabled, true, 'no backend observation is available')
        await view.click('suite-case-1-duplicate')
        const saved = await exported(view), copy = saved.cases[2]
        assert.match(copy.case_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
        assert.equal(new Set(saved.cases.map(value => value.case_id)).size, 4)
        assert.deepEqual(saved, { ...source, cases: [source.cases[0], source.cases[1], { ...source.cases[1], case_id: copy.case_id }, source.cases[2]] })
        await view.click('suite-case-3-duplicate')
        const literalCopy = (await exported(view)).cases[4]
        assert.equal(saved.cases.some(value => value.case_id === literalCopy.case_id), false)
        assert.deepEqual(literalCopy, { ...source.cases[2], case_id: literalCopy.case_id })
        await view.input('suite-case-2-label', 'Edited copy')
        assert.equal((await exported(view)).cases[1].label, source.cases[1].label)
        if (kind === 'json_fields') {
          await view.input('suite-case-2-required-field-0-name', 'copied field')
          await view.change('suite-case-2-required-field-1-type', 'null')
          await view.click('suite-case-2-required-field-2-remove')
          assert.deepEqual((await exported(view)).cases[1].required_fields, rules())
          await view.input('suite-case-1-required-field-0-name', 'original field')
          assert.deepEqual((await exported(view)).cases[2].required_fields, [{ name: 'copied field', type: 'string' }, { name: '__proto__', type: 'null' }])
        }
        assert.deepEqual(counts(view), before)
        assert.deepEqual(view.warnings, [])
      } finally { view.unmount() }
    })
  }
}

for (const version of [1, 2, 3]) test(`reorder keeps v${version} case objects, IDs and exact exports`, async () => {
  const view = await mountSuites()
  try {
    const source = definition(version, [item(version, 'exact_text', 100, ' literal\n'), item(version, version >= 2 ? 'json_object' : 'none', 101), item(version, version === 3 ? 'json_fields' : 'exact_text', 102)])
    await importDefinition(view, source)
    const before = counts(view), nodes = controls(view)
    const editFirst = view.byId('suite-case-0-user_prompt').props.onInput
    const editLast = version === 3 ? view.byId('suite-case-2-required-field-0-name').props.onInput : null
    const moveFirstDown = handler(view, 0, 'move-down')
    await view.click('suite-case-1-move-up')
    assert.deepEqual((await exported(view)).cases, [source.cases[1], source.cases[0], source.cases[2]])
    assert.equal(controls(view)[0], nodes[1])
    await invoke(moveFirstDown)
    assert.deepEqual((await exported(view)).cases, [source.cases[1], source.cases[2], source.cases[0]])
    assert.equal(controls(view)[2], nodes[0])
    await invoke(editFirst, 'Original object after moves')
    if (editLast) await invoke(editLast, 'Same required-field object')
    const saved = await exported(view)
    assert.equal(saved.cases[2].user_prompt, 'Original object after moves')
    if (editLast) assert.equal(saved.cases[1].required_fields[0].name, 'Same required-field object')
    assert.equal(saved.schema_version, version)
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const version of [1, 2, 3]) test(`incomplete v${version} drafts can duplicate and move while export and run stay invalid`, async () => {
  const view = await mountSuites()
  try {
    await readiness(view)
    await importDefinition(view, definition(version, [item(version, version === 3 ? 'json_fields' : 'exact_text')]))
    for (const key of ['label', 'user_prompt', 'temperature', 'max_output_tokens']) await view.input(`suite-case-0-${key}`, '')
    if (version === 3) {
      await view.input('suite-case-0-required-field-0-name', '')
      await view.change('suite-case-0-required-field-0-type', '')
    }
    const before = counts(view), downloads = view.downloads.length
    await view.click('suite-case-0-duplicate'); await view.click('suite-case-1-move-up')
    assert.equal(controls(view).length, 2)
    for (const index of [0, 1]) for (const key of ['label', 'user_prompt', 'temperature', 'max_output_tokens']) assert.equal(view.byId(`suite-case-${index}-${key}`).props.value, '')
    if (version === 3) {
      assert.equal(view.byId('suite-case-0-required-field-0-name').props.value, '')
      assert.equal(view.byId('suite-case-0-required-field-0-type').props.value, '')
      await view.input('suite-case-0-required-field-0-name', 'fixed copy')
      assert.equal(view.byId('suite-case-1-required-field-0-name').props.value, '')
    } else assert.equal(view.byId('suite-case-0-expected_text').props.value, '')
    assert.equal(view.byId('suite-export-definition').props.disabled, true)
    assert.equal(view.byId('suite-run').props.disabled, true)
    await invoke(view.byId('suite-export-definition').props.onClick); await view.submit('suite-form')
    assert.equal(view.downloads.length, downloads); assert.deepEqual(counts(view), before)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('case limits and boundaries are enforced by both controls and retained handlers', async () => {
  const view = await mountSuites()
  try {
    await importDefinition(view, definition())
    for (const action of ['move-up', 'move-down']) {
      assert.equal(view.byId(`suite-case-0-${action}`).props.disabled, true)
      await invoke(handler(view, 0, action))
    }
    const duplicate = handler(view, 0, 'duplicate')
    const before = counts(view)
    for (let index = 0; index < 4; index++) await invoke(duplicate)
    const saved = await exported(view)
    assert.equal(saved.cases.length, 5)
    for (let index = 0; index < 5; index++) assert.equal(view.byId(`suite-case-${index}-duplicate`).props.disabled, true)
    await invoke(duplicate)
    await invoke(handler(view, 0, 'move-up')); await invoke(handler(view, 4, 'move-down'))
    assert.deepEqual(await exported(view), saved)
    await view.click('suite-case-4-move-up'); await view.click('suite-case-3-move-down')
    assert.deepEqual(await exported(view), saved)
    await view.click('suite-case-4-remove')
    assert.equal(view.byId('suite-case-0-duplicate').props.disabled, false)
    await view.click('suite-case-0-duplicate')
    assert.equal((await exported(view)).cases.length, 5)
    assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const replacement of ['removed case', 'different-ID import', 'same-ID import', 'navigation', 'unmount']) {
  test(`retained case editing callbacks do nothing after ${replacement}`, async () => {
    const view = await mountSuites()
    let unmounted = false
    try {
      const source = definition(3, [item(3, 'none', 99), item(3, 'json_fields'), item(3, 'exact_text', 101)])
      await importDefinition(view, source)
      const callbacks = ['duplicate', 'move-up', 'move-down'].map(action => handler(view, 1, action))
      if (replacement === 'removed case') await view.click('suite-case-1-remove')
      if (replacement.endsWith('import')) await importDefinition(view, { ...source, name: 'Replacement draft', cases: source.cases.map((value, index) => ({ ...value, case_id: replacement === 'same-ID import' ? value.case_id : id(500 + index), label: `Replacement ${index}` })) })
      if (replacement === 'navigation') { await view.navigate('/prompt-trials'); await view.navigate('/prompt-suites'); await importDefinition(view, source) }
      const saved = await exported(view), before = counts(view)
      if (replacement === 'unmount') { view.unmount(); unmounted = true }
      for (const callback of callbacks) await invoke(callback)
      if (!unmounted) assert.deepEqual(await exported(view), saved)
      assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
    } finally { if (!unmounted) view.unmount() }
  })
}

for (const locale of ['en', 'zh']) for (const failure of ['throw', 'collision', 'invalid']) {
  test(`duplicate UUID ${failure} leaves the draft unchanged and shows a safe notice in ${locale}`, async context => {
    const view = await mountSuites({ locale })
    try {
      const source = definition(3, [item(3, 'json_fields'), item(3, 'none', 101)])
      await importDefinition(view, source)
      const before = counts(view)
      context.mock.method(webcrypto, 'randomUUID', () => { if (failure === 'throw') throw new Error('PRIVATE UUID FAILURE'); return failure === 'collision' ? source.cases[1].case_id : 'invalid' })
      await view.click('suite-case-0-duplicate')
      assert.deepEqual(await exported(view), source)
      const error = view.byId('suite-duplicate-error'); assert.ok(error)
      assert.equal(error.props.role, 'alert'); assert.equal(view.text(error), labels[locale].error)
      assert.doesNotMatch(view.text(), /PRIVATE UUID FAILURE|promptSuites\./)
      context.mock.restoreAll()
      await view.click('suite-case-0-duplicate')
      assert.equal((await exported(view)).cases.length, 3)
      assert.equal(view.byId('suite-duplicate-error'), undefined)
      assert.deepEqual(counts(view), before); assert.deepEqual(view.warnings, [])
    } finally { context.mock.restoreAll(); view.unmount() }
  })
}

for (const phase of ['active', 'paused', 'completed']) test(`duplicate and move leave the ${phase} run capture unchanged`, async () => {
  const view = await mountSuites()
  try {
    await readiness(view)
    const source = definition(3, [item(3, 'json_fields'), item(3, 'exact_text', 101)])
    await importDefinition(view, source); await view.submit('suite-form'); await readiness(view)
    if (phase !== 'active') {
      await settlePost(view)
      if (phase === 'paused') await view.click('suite-pause')
      else { await view.timers.advance(1500); await readiness(view); await settlePost(view) }
    }
    const saved = await exported(view, 'run'), before = counts(view)
    await view.click('suite-case-0-duplicate'); await view.click('suite-case-2-move-up')
    await view.input('suite-case-0-required-field-0-name', 'draft changed')
    assert.deepEqual(await exported(view, 'run'), saved)
    assert.deepEqual(counts(view), before)
    assert.equal((await exported(view)).cases.length, 3)
    if (phase !== 'completed') {
      if (phase === 'active') await settlePost(view)
      else await view.click('suite-resume')
      await view.timers.advance(1500); await readiness(view)
      const request = view.requests.calls.startPromptTrial.at(-1).args[0]
      assert.deepEqual(Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]])), Object.fromEntries(Object.keys(trialRequest()).map(key => [key, source.cases[1][key]])))
      await settlePost(view)
      const completed = await exported(view, 'run')
      assert.equal(completed.status, 'completed'); assert.deepEqual(completed.definition, source)
    }
    assert.equal(view.requests.calls.startPromptTrial.length, 2)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`a successful replacement import clears the previous draft's duplicate notice in ${locale}`, async context => {
  const view = await mountSuites({ locale })
  try {
    const source = definition(3, [item(3, 'json_fields')])
    await importDefinition(view, source)
    context.mock.method(webcrypto, 'randomUUID', () => { throw new Error('PRIVATE UUID FAILURE') })
    await view.click('suite-case-0-duplicate')
    assert.equal(view.text(view.byId('suite-duplicate-error')), labels[locale].error)
    context.mock.restoreAll()
    const replacement = { ...source, name: 'Imported replacement' }
    const text = JSON.stringify(replacement)
    await view.file({ size: new TextEncoder().encode(text).length, text: async () => text })
    assert.ok(view.byId('suite-duplicate-error'), 'preview alone does not replace the draft')
    await view.click('suite-import-use')
    assert.equal(!!view.byId('suite-duplicate-error'), false, 'a replacement draft must retire the old duplicate notice')
    assert.deepEqual(await exported(view), replacement)
    assert.deepEqual(view.warnings, [])
  } finally { context.mock.restoreAll(); view.unmount() }
})
