import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const copy = value => JSON.parse(JSON.stringify(value))
const fieldId = (kind, row = 0, caseIndex = 0) => `suite-case-${caseIndex}-required-field-${row}-${kind}`
const item = (number = 100, required_fields = [{ name: 'status', type: 'string' }]) => ({ case_id: id(number), ...trialRequest(), check_kind: 'json_fields', expected_text: null, required_fields })
const definition = (cases = [item()], schema_version = 3) => ({ schema_version, kind: 'mirofish_local_prompt_suite', name: 'Literal expectations', cases })
const definitionFile = source => { const text = JSON.stringify(source); return { size: new TextEncoder().encode(text).length, text: async () => text } }
const reportFile = source => { const bytes = new TextEncoder().encode(JSON.stringify(source)); return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } }
const event = value => ({ target: { value, checked: value }, preventDefault() {}, stopPropagation() {}, button: 0 })
async function invoke(action, value) { action(event(value)); await flush() }
async function idle(view) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush() }
async function useDefinition(view, source = definition()) { await view.file(definitionFile(source)); await view.click('suite-import-use') }
async function exportDefinition(view, selection = false) { await view.click(selection ? 'suite-export-selection' : 'suite-export-definition'); return JSON.parse(await view.downloads.at(-1).blob.text()) }
async function equals(view, raw, row = 0, caseIndex = 0) { await view.change(fieldId('mode', row, caseIndex), 'equals'); if (raw !== undefined) await view.input(fieldId('value', row, caseIndex), raw) }
function usable(view, expected) {
  assert.equal(view.byId('suite-run').props.disabled, !expected)
  assert.equal(view.byId('suite-export-definition').props.disabled, !expected)
  assert.equal(view.byId('suite-export-selection').props.disabled, !expected)
}
function report(source, content, check = 'mismatched', status = 'succeeded') {
  const snapshot = acceptPromptTrialSnapshot(ok(trialSnapshot(status)))
  snapshot.run.request_id = id(200)
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, source.cases[0][key]]))
  snapshot.run.response.content = content
  return { schema_version: 4, kind: 'mirofish_local_prompt_suite_run', run_id: id(1), definition: copy(source),
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: status === 'succeeded' ? 'completed' : 'halted',
    stop_requested: false, halt_code: status === 'succeeded' ? null : 'case_truncated',
    cases: [{ case_id: source.cases[0].case_id, request_id: id(200), status, check, snapshot, error_code: null }] }
}
async function finishRun(view, content, status = 'succeeded') {
  await view.submit('suite-form'); await idle(view)
  const call = view.requests.calls.startPromptTrial.at(-1), request = call.args[0]
  const snapshot = trialSnapshot(status)
  snapshot.run.request_id = request.request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  snapshot.run.response.content = content
  call.resolve(ok(snapshot)); await flush()
  return request
}

// These assertions exercise the compiled Vue template, the real admission and
// runner code, and synthetic transport. Removing explicit literal promotion,
// invalidation, identity ownership, or captured diagnostics makes them fail.
for (const version of [1, 2]) test(`Equals explicitly promotes v${version} through v3 without changing other cases or later downgrading`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const cases = [null, '', ' kept \r\n'].map((expected_text, index) => ({ case_id: id(100 + index), ...trialRequest(), expected_text,
      ...(version >= 2 ? { check_kind: expected_text === null ? 'none' : 'exact_text' } : {}) }))
    await useDefinition(view, definition(cases, version))
    await view.change('suite-case-0-check_enabled', true); await view.change('suite-case-0-check_kind', 'json_fields')
    await view.input(fieldId('name'), 'status'); await view.change(fieldId('type'), 'string')
    assert.equal((await exportDefinition(view)).schema_version, 3)
    assert.ok(view.byId(fieldId('mode')), 'primitive fields expose an explicit literal mode')
    assert.equal(view.byId(fieldId('mode')).props.value, 'type_only')
    assert.equal(view.byId(fieldId('value')), undefined)
    await equals(view)
    assert.equal(view.byId(fieldId('value')).props.value, ''); usable(view, false)
    await view.input(fieldId('value'), '"approved"')
    const promoted = await exportDefinition(view)
    assert.equal(promoted.schema_version, 4)
    assert.deepEqual(promoted.cases[0].required_fields, [{ name: 'status', type: 'string', equals: 'approved' }])
    assert.deepEqual(promoted.cases.slice(1), cases.slice(1).map(current => ({ ...current, check_kind: 'exact_text', required_fields: null })))
    await view.change(fieldId('mode'), 'type_only')
    let saved = await exportDefinition(view)
    assert.equal(saved.schema_version, 4); assert.equal(Object.hasOwn(saved.cases[0].required_fields[0], 'equals'), false)
    await equals(view)
    assert.equal(view.byId(fieldId('value')).props.value, ''); usable(view, false)
    await view.change(fieldId('mode'), 'type_only'); await view.change('suite-case-0-check_kind', 'json_object')
    await view.click('suite-add-case'); await view.input('suite-case-3-user_prompt', 'A new case')
    saved = await exportDefinition(view)
    assert.equal(saved.schema_version, 4); assert.equal(saved.cases[3].required_fields, null)
    assert.equal(view.requests.calls.startPromptTrial.length, 0); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('invalid raw scalars immediately block run and downloads, preserve input, and respect strict editor bounds', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await useDefinition(view); await equals(view, '"approved"'); usable(view, true)
    const invalid = ['', ' ', '"unfinished', 'approved', '```json\n"approved"\n```', '"approved" true', '{}', '[]', 'false', 'null', '3', '"\\ud800"', '"\\u0000"', JSON.stringify('x'.repeat(501)), ' '.repeat(4095) + '""']
    for (const raw of invalid) {
      await view.input(fieldId('value'), raw); usable(view, false)
      assert.equal(view.byId(fieldId('value')).props.value, raw)
      assert.equal(view.byId(fieldId('value')).props['aria-invalid'], true)
      assert.ok(view.byId(fieldId('literal-error')))
      const before = view.downloads.length
      await invoke(view.byId('suite-export-definition').props.onClick)
      await invoke(view.byId('suite-export-selection').props.onClick)
      await view.submit('suite-form')
      assert.equal(view.downloads.length, before); assert.equal(view.requests.calls.startPromptTrial.length, 0)
      await view.input(fieldId('value'), '"approved"'); usable(view, true)
    }
    for (const raw of ['"', '"still partial', '"another partial']) {
      await view.input(fieldId('value'), raw); usable(view, false)
      assert.equal(view.byId(fieldId('value')).props.value, raw, 'consecutive invalid input stays reactive')
    }
    for (const raw of ['""', ' "  \\t\\r\\n" ', JSON.stringify('🦙'.repeat(500)), ' '.repeat(4094) + '""']) {
      await view.input(fieldId('value'), raw); usable(view, true)
      assert.equal((await exportDefinition(view)).cases[0].required_fields[0].equals, JSON.parse(raw))
      assert.equal(view.byId(fieldId('literal-error')), undefined)
    }
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('primitive types preserve raw input without coercion and container options cannot bypass Equals', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await useDefinition(view); await equals(view, '"approved"')
    for (const [type, raw, expected] of [['number', '3e0', 3], ['number', '-0', 0], ['number', '9007199254740993', 9007199254740992], ['number', '1e-400', 0], ['boolean', 'false', false], ['null', 'null', null], ['string', '""', '']]) {
      await view.change(fieldId('type'), type)
      await view.input(fieldId('value'), raw); usable(view, true)
      assert.equal((await exportDefinition(view)).cases[0].required_fields[0].equals, expected)
      assert.equal(view.byId(fieldId('value')).props.value, raw)
      assert.equal(!!view.byId(fieldId('number-note')), type === 'number')
    }
    await view.change(fieldId('type'), 'number')
    assert.equal(view.byId(fieldId('value')).props.value, '""'); usable(view, false)
    await view.input(fieldId('value'), '0'); usable(view, true)
    assert.match(view.text(view.byId(fieldId('number-note'))), /JavaScript|finite|precision/i)
    for (const type of ['object', 'array']) {
      const option = view.byId(fieldId('type')).children.find(node => node.props.value === type)
      assert.equal(option.props.disabled, true)
      await invoke(view.byId(fieldId('type')).props.onChange, type)
      assert.equal(view.byId(fieldId('type')).props.value, 'number')
      assert.equal(view.byId(fieldId('value')).props.value, '0')
    }
    await view.change(fieldId('mode'), 'type_only')
    for (const type of ['object', 'array']) {
      await view.change(fieldId('type'), type)
      assert.ok(view.byId(fieldId('mode-hint')))
      assert.equal(view.byId(fieldId('mode')).children.find(node => node.props.value === 'equals').props.disabled, true)
      await invoke(view.byId(fieldId('mode')).props.onChange, 'equals')
      assert.equal(view.byId(fieldId('value')), undefined); usable(view, true)
    }
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('duplicating valid and invalid literals copies raw text independently and selected subsets omit invalid cases', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await useDefinition(view); await equals(view, ' "approved" ')
    await view.click('suite-case-0-duplicate')
    assert.equal(view.byId(fieldId('value', 0, 1)).props.value, ' "approved" ')
    await view.input(fieldId('value', 0, 1), '"different"')
    let saved = await exportDefinition(view)
    assert.deepEqual(saved.cases.map(current => current.required_fields[0].equals), ['approved', 'different'])
    await view.input(fieldId('value'), '"partial')
    await view.click('suite-case-0-duplicate')
    assert.equal(view.byId(fieldId('value', 0, 1)).props.value, '"partial')
    await view.input(fieldId('value'), '"repaired"')
    assert.equal(view.byId(fieldId('value', 0, 1)).props.value, '"partial'); usable(view, false)
    await view.change('suite-case-1-included', false)
    assert.equal(view.byId('suite-run').props.disabled, false)
    assert.equal(view.byId('suite-export-definition').props.disabled, true)
    saved = await exportDefinition(view, true)
    assert.equal(saved.schema_version, 4)
    assert.deepEqual(saved.cases.map(current => current.required_fields[0].equals), ['repaired', 'different'])
    for (const current of saved.cases) assert.deepEqual(Object.keys(current.required_fields[0]), ['name', 'type', 'equals'])
    await view.click('suite-case-1-move-down')
    assert.equal(view.byId(fieldId('value', 0, 2)).props.value, '"partial')
    await view.click('suite-case-2-remove'); usable(view, true)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const replacement of ['removed rule', 'type cycle', 'literal mode cycle', 'check mode cycle', 'disabled cycle', 'same-ID import', 'removed case', 'navigation']) test(`retained literal mode/type/value callbacks are inert after ${replacement}`, async () => {
  const view = await mountSuites({ cacheHandlers: true })
  try {
    await idle(view); await useDefinition(view, definition([item(100, [{ name: 'status', type: 'string' }, { name: 'rest', type: 'array' }])]))
    assert.ok(view.byId(fieldId('mode')), 'literal mode is available before capturing a callback')
    const staleEnable = view.byId(fieldId('mode')).props.onChange
    await equals(view, '"approved"')
    const oldMode = view.byId(fieldId('mode')).props.onChange, oldType = view.byId(fieldId('type')).props.onChange, oldValue = view.byId(fieldId('value')).props.onInput
    if (replacement === 'removed rule') await view.click(fieldId('remove'))
    if (replacement === 'type cycle') { await view.change(fieldId('type'), 'number'); await view.change(fieldId('type'), 'string') }
    if (replacement === 'literal mode cycle') { await view.change(fieldId('mode'), 'type_only'); await equals(view, '"current"') }
    if (replacement === 'check mode cycle') { await view.change('suite-case-0-check_kind', 'exact_text'); await view.change('suite-case-0-check_kind', 'json_fields'); await view.input(fieldId('name'), 'current'); await view.change(fieldId('type'), 'string') }
    if (replacement === 'disabled cycle') { await view.change('suite-case-0-check_enabled', false); await view.change('suite-case-0-check_enabled', true) }
    if (replacement === 'same-ID import') await useDefinition(view, definition([item(100, [{ name: 'current', type: 'string', equals: 'fresh' }])], 4))
    if (replacement === 'removed case') { await view.click('suite-add-case'); await view.input('suite-case-1-user_prompt', 'Remaining'); await view.click('suite-case-0-remove') }
    if (replacement === 'navigation') { await view.navigate('/prompt-trials'); await view.navigate('/prompt-suites'); await idle(view); await useDefinition(view) }
    const before = await exportDefinition(view)
    await invoke(staleEnable, 'equals'); await invoke(oldMode, 'type_only'); await invoke(oldType, 'number'); await invoke(oldValue, '"stale"')
    assert.deepEqual(await exportDefinition(view), before)
    assert.equal(view.requests.calls.startPromptTrial.length, 0); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`v4 import, capture and saved-run reuse show safe literal text and localized feedback in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view)
    const rules = [{ name: '<b>status</b>', type: 'string', equals: '<script>\u202e\u2028\u200d' }, { name: 'flag', type: 'boolean', equals: false }, { name: 'count', type: 'number', equals: 0 }, { name: 'empty', type: 'string', equals: '' }, { name: 'missing', type: 'null', equals: null }, { name: 'items', type: 'array' }]
    const source = definition([item(100, rules)], 4)
    await view.file(definitionFile(source))
    assert.ok(view.byId('suite-import-case-0-required-fields'), 'v4 requirements are reviewable before use')
    const requirements = view.text(view.byId('suite-import-case-0-required-fields'))
    for (const text of ['"<b>status</b>": string = "<script>\\u202e\\u2028\\u200d"', '"flag": boolean = false', '"count": number = 0', '"empty": string = ""', '"missing": null = null', '"items": array']) assert.ok(requirements.includes(text), text)
    await view.click('suite-import-use')
    for (let row = 0; row < 5; row++) assert.equal(view.byId(fieldId('value', row)).props.value, JSON.stringify(rules[row].equals))
    assert.equal(view.byId(fieldId('value', 5)), undefined)
    assert.match(view.text(view.byId(fieldId('mode'))), locale === 'en' ? /Type only.*Equals value/s : /仅检查类型.*等于指定值/s)
    const request = await finishRun(view, '{"<b>status</b>":"rejected","flag":false,"count":0,"empty":"","missing":null,"items":[]}')
    assert.deepEqual(Object.keys(request).sort(), [...Object.keys(trialRequest()), 'request_id'].sort())
    assert.equal(view.text(view.byId('suite-result-0-required-fields')), requirements)
    assert.match(view.text(view.byId('suite-result-0-field-failure')), locale === 'en' ? /must equal.*received/s : /必须等于.*实际为/s)
    await view.input(fieldId('value'), '"edited"')
    assert.equal(view.text(view.byId('suite-result-0-required-fields')), requirements)
    await view.click('suite-export-run')
    const saved = JSON.parse(await view.downloads.at(-1).blob.text())
    assert.deepEqual(saved.definition, source); assert.equal(saved.cases[0].check, 'mismatched')
    await view.runFile(reportFile(saved))
    assert.equal(view.text(view.byId('suite-import-case-0-required-fields')), requirements)
    assert.equal(view.text(view.byId('suite-import-case-0-field-failure')), view.text(view.byId('suite-result-0-field-failure')))
    await view.click('suite-import-use'); assert.deepEqual(await exportDefinition(view), source)
    assert.equal(view.all(node => node.type === 'b' || node.type === 'script').length, 0)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`captured first-failure diagnostics distinguish object, missing, type and literal failures in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view)
    const source = definition([item(100, [{ name: 'status', type: 'string', equals: 'approved' }, { name: 'count', type: 'number', equals: 3 }])], 4)
    const failures = [
      ['bad json', /one valid JSON object/, /一个有效 JSON 对象/],
      ['{}', /Required field "status" is missing/, /缺少必需字段 "status"/],
      ['{"status":false}', /must be string; received boolean/, /必须是string（字符串）.*实际为boolean（布尔值）/],
      ['{"status":"rejected"}', /must equal "approved"; received "rejected"/, /必须等于 "approved".*实际为 "rejected"/],
      [JSON.stringify({ status: 'x'.repeat(501) }), /received a different string; see the captured reply/, /不同的字符串.*查看捕获的回复/],
    ]
    for (const [content, english, chinese] of failures) {
      await view.runFile(reportFile(report(source, content)))
      const failure = view.byId('suite-import-case-0-field-failure'); assert.ok(failure)
      assert.match(view.text(failure), locale === 'en' ? english : chinese)
      assert.equal(view.text(failure).includes('x'.repeat(501)), false)
      await view.click('suite-import-cancel')
    }
    await view.runFile(reportFile(report(source, '{"status":"approved","count":3}', 'matched')))
    assert.equal(view.byId('suite-import-case-0-field-failure'), undefined)
    await view.click('suite-import-cancel')
    await useDefinition(view, source); await finishRun(view, '{"status":"rejected"}', 'truncated')
    assert.equal(view.byId('suite-result-0-field-failure'), undefined)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})
