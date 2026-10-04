import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { mountSuiteComparison } from './helpers/prompt-suite-comparison-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const clone = value => JSON.parse(JSON.stringify(value))
const types = ['string', 'number', 'boolean', 'object', 'array', 'null']
const rules = () => [
  { name: ' answer ', type: 'string' }, { name: '__proto__', type: 'object' },
  { name: 'constructor', type: 'array' }, { name: '<b>literal</b>', type: 'boolean' },
  { name: 'Å', type: 'number' }, { name: 'A\u030a', type: 'null' },
]
const reply = '{" answer ":"yes","__proto__":{},"constructor":[],"<b>literal</b>":true,"Å":1,"A\\u030a":null}'
const item = (number = 100, required_fields = rules()) => ({ case_id: id(number), ...trialRequest(), check_kind: 'json_fields', expected_text: null, required_fields })
const definition = (cases = [item()], version = 3) => ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Required fields', cases })
const definitionFile = source => { const text = JSON.stringify(source); return { size: new TextEncoder().encode(text).length, text: async () => text } }
const runFile = source => { const bytes = new TextEncoder().encode(JSON.stringify(source)); return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } }
function report(n = 1, source = definition(), content = reply, check = 'matched') {
  return { schema_version: source.schema_version, kind: 'mirofish_local_prompt_suite_run', run_id: id(n), definition: clone(source),
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
    cases: source.cases.map((input, index) => {
      const snapshot = acceptPromptTrialSnapshot(ok(trialSnapshot('succeeded')))
      snapshot.run.request_id = id(n * 1000 + index)
      snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, input[key]]))
      snapshot.run.response.content = content
      return { case_id: input.case_id, request_id: snapshot.run.request_id, status: 'succeeded', check, snapshot, error_code: null }
    }) }
}
async function idle(view) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot())); await flush() }
async function ready(view) {
  await idle(view); await view.input('suite-name', 'Required fields')
  for (const [key, value] of Object.entries(trialRequest())) await view.input(`suite-case-0-${key}`, value)
}
async function fieldsMode(view, index = 0) {
  await view.change(`suite-case-${index}-check_enabled`, true)
  await view.change(`suite-case-${index}-check_kind`, 'json_fields')
  assert.ok(view.byId(`suite-case-${index}-required-field-0-name`), 'JSON fields creates a blank literal-name row')
}
async function field(view, index, name, type, caseIndex = 0) {
  await view.input(`suite-case-${caseIndex}-required-field-${index}-name`, name)
  await view.change(`suite-case-${caseIndex}-required-field-${index}-type`, type)
}
async function exported(view, kind = 'definition') {
  await view.click(`suite-export-${kind}`); return JSON.parse(await view.downloads.at(-1).blob.text())
}
async function acceptDefinition(view, source) { await view.file(definitionFile(source)); await view.click('suite-import-use') }
function usable(view, expected) {
  assert.equal(view.byId('suite-run').props.disabled, !expected)
  assert.equal(view.byId('suite-export-definition').props.disabled, !expected)
}
const event = value => ({ target: { value, checked: value }, preventDefault() {}, stopPropagation() {}, button: 0 })
async function invoke(action, value) { action(event(value)); await flush() }
function literalRules(view, selector, expected = rules()) {
  const target = view.byId(selector); assert.ok(target, `missing captured requirements ${selector}`)
  const text = view.text(target)
  for (const rule of expected) assert.ok(text.includes(`${JSON.stringify(rule.name)}: ${rule.type}`), `literal name/type missing: ${rule.name}`)
  assert.equal(view.all(node => node.type === 'b' || node.type === 'script').length, 0)
}

// These mounted-template assertions fail if promotion loses an existing case,
// chooses an invented rule, downgrades, or applies rules to another check mode.
for (const version of [1, 2]) test(`JSON fields promotes v${version} with blank choices and preserves every other case`, async () => {
  const view = await mountSuites()
  try {
    await idle(view)
    const inputs = [null, '', ' literal \r\n', null].map((expected, index) => {
      const value = { case_id: id(100 + index), ...trialRequest(), expected_text: expected }
      if (version === 2) value.check_kind = index === 3 ? 'json_object' : expected === null ? 'none' : 'exact_text'
      return value
    })
    const source = definition(inputs, version)
    await acceptDefinition(view, source)
    assert.deepEqual(await exported(view), source)
    await fieldsMode(view)
    assert.equal(view.byId('suite-case-0-required-field-0-name').props.value, '')
    assert.equal(view.byId('suite-case-0-required-field-0-type').props.value, '')
    usable(view, false)
    await field(view, 0, ' answer ', 'string')
    const promoted = await exported(view)
    assert.equal(promoted.schema_version, 3)
    assert.deepEqual(promoted.cases, inputs.map((value, index) => ({ ...value,
      check_kind: index === 0 ? 'json_fields' : value.check_kind ?? (value.expected_text === null ? 'none' : 'exact_text'),
      required_fields: index === 0 ? [{ name: ' answer ', type: 'string' }] : null })))
    await view.click('suite-add-case'); await view.input('suite-case-4-user_prompt', 'New prompt')
    assert.equal((await exported(view)).cases[4].required_fields, null)
    await view.change('suite-case-0-check_kind', 'exact_text')
    assert.equal(view.byId('suite-case-0-expected_text').props.value, '')
    await view.input('suite-case-0-expected_text', 'discard me')
    await view.change('suite-case-0-check_kind', 'json_object')
    let saved = await exported(view)
    assert.equal(saved.schema_version, 3); assert.equal(saved.cases[0].expected_text, null); assert.equal(saved.cases[0].required_fields, null)
    await view.change('suite-case-0-check_kind', 'json_fields'); usable(view, false)
    assert.equal(view.byId('suite-case-0-required-field-0-name').props.value, '')
    await view.change('suite-case-0-check_enabled', false)
    saved = await exported(view)
    assert.equal(saved.schema_version, 3); assert.equal(saved.cases[0].check_kind, 'none'); assert.equal(saved.cases[0].required_fields, null)
    assert.equal(view.requests.calls.startPromptTrial.length, 0); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('JSON fields editor enforces one to ten rules, all six explicit types and literal name bounds', async () => {
  const view = await mountSuites()
  try {
    await ready(view); await fieldsMode(view)
    const select = view.byId('suite-case-0-required-field-0-type')
    assert.deepEqual(select.children.filter(node => node.type === 'option').map(node => node.props.value), ['', ...types])
    assert.ok(view.byId('suite-case-0-required-field-0-remove').props.disabled)
    await invoke(view.byId('suite-case-0-required-field-0-remove').props.onClick)
    assert.ok(view.byId('suite-case-0-required-field-0-name'))
    for (const name of ['', '   ', 'x'.repeat(81), '🦙'.repeat(81), 'a\n', 'a\u0000', 'a\u007f', 'a\u202e', 'a\u200d', '\ud800', '\ue000', '\u0378']) {
      await field(view, 0, name, 'string'); usable(view, false)
      const before = view.downloads.length
      await invoke(view.byId('suite-export-definition').props.onClick)
      await view.submit('suite-form')
      assert.equal(view.downloads.length, before); assert.equal(view.requests.calls.startPromptTrial.length, 0)
    }
    for (const name of ['x', 'x'.repeat(80), '🦙'.repeat(80), ' answer ', '__proto__', 'constructor', 'hasOwnProperty']) {
      await field(view, 0, name, 'string'); usable(view, true)
      assert.equal((await exported(view)).cases[0].required_fields[0].name, name)
    }
    for (const type of ['', 'integer', 'STRING', 'undefined']) { await field(view, 0, 'name', type); usable(view, false) }
    await field(view, 0, 'Å', 'string')
    for (let index = 1; index < 10; index++) {
      await view.click('suite-case-0-add-required-field')
      assert.equal(view.byId(`suite-case-0-required-field-${index}-name`).props.value, '')
      assert.equal(view.byId(`suite-case-0-required-field-${index}-type`).props.value, '')
      usable(view, false)
      await field(view, index, index === 1 ? 'A\u030a' : `field ${index}`, types[index % 6]); usable(view, true)
    }
    assert.ok(view.byId('suite-case-0-add-required-field').props.disabled)
    await invoke(view.byId('suite-case-0-add-required-field').props.onClick)
    assert.equal((await exported(view)).cases[0].required_fields.length, 10)
    await field(view, 1, 'Å', 'number'); usable(view, false)
    await field(view, 1, 'å', 'number'); usable(view, true)
    await view.click('suite-case-0-required-field-0-remove')
    assert.equal((await exported(view)).cases[0].required_fields[0].name, 'å')
    assert.equal(view.byId('suite-case-0-add-required-field').props.disabled, false)
  } finally { view.unmount() }
})

for (const replacement of ['removed rule', 'mode cycle', 'disabled cycle', 'same-ID import', 'removed case', 'navigation']) test(`stale required-field handlers cannot mutate after ${replacement}`, async () => {
  const view = await mountSuites()
  try {
    await idle(view); await acceptDefinition(view, definition())
    const controls = ['name', 'type', 'remove'].map(kind => view.byId(`suite-case-0-required-field-0-${kind}`))
    const oldName = controls[0].props.onInput, oldType = controls[1].props.onChange, oldRemove = controls[2].props.onClick
    const oldAdd = view.byId('suite-case-0-add-required-field').props.onClick
    if (replacement === 'removed rule') await view.click('suite-case-0-required-field-0-remove')
    if (replacement === 'mode cycle') { await view.change('suite-case-0-check_kind', 'exact_text'); await view.change('suite-case-0-check_kind', 'json_fields'); await field(view, 0, 'current', 'boolean') }
    if (replacement === 'disabled cycle') { await view.change('suite-case-0-check_enabled', false); await fieldsMode(view); await field(view, 0, 'current', 'boolean') }
    if (replacement === 'same-ID import') await acceptDefinition(view, definition([item(100, [{ name: 'current', type: 'boolean' }])]))
    if (replacement === 'removed case') { await view.click('suite-add-case'); await view.input('suite-case-1-user_prompt', 'Remaining prompt'); await view.click('suite-case-0-remove') }
    if (replacement === 'navigation') { await view.navigate('/prompt-trials'); await view.navigate('/prompt-suites'); await ready(view) }
    const before = await exported(view)
    await invoke(oldName, 'stale'); await invoke(oldType, 'null'); await invoke(oldRemove)
    // Add still belongs to the current list when only one rule was removed.
    if (replacement !== 'removed rule') await invoke(oldAdd)
    assert.deepEqual(await exported(view), before)
    assert.equal(view.requests.calls.startPromptTrial.length, 0); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`literal requirements survive import previews, capture, edits and saved-run reuse in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view)
    const source = definition()
    await view.file(definitionFile(source)); literalRules(view, 'suite-import-case-0-required-fields')
    await view.click('suite-import-use'); await view.submit('suite-form'); await idle(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    const request = view.requests.calls.startPromptTrial[0].args[0]
    assert.deepEqual(Object.keys(request).sort(), [...Object.keys(trialRequest()), 'request_id'].sort())
    await field(view, 0, 'edited draft', 'null')
    const snapshot = trialSnapshot('succeeded'); snapshot.run.request_id = request.request_id
    snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]])); snapshot.run.response.content = reply
    view.requests.calls.startPromptTrial[0].resolve(ok(snapshot)); await flush()
    const saved = await exported(view, 'run')
    assert.deepEqual(saved.definition, source); assert.equal(saved.cases[0].check, 'matched')
    literalRules(view, 'suite-result-0-required-fields')
    assert.equal(view.text(view.byId('suite-result-0-reply')), reply)
    assert.match(view.text(view.byId('suite-result-0-check')), locale === 'en' ? /JSON fields check passed/ : /JSON 字段检查通过/)
    assert.match(view.text(view.byId('suite-summary')), locale === 'en' ? /Checks passed.*Checks failed/s : /检查通过.*检查未通过/s)
    assert.doesNotMatch(view.text(view.byId('suite-summary')), /Exact matches|Exact mismatches/)
    const history = report(8, definition([item(100, [{ name: 'saved field', type: 'null' }])]), '{"saved field":null}')
    await view.runFile(runFile(history)); literalRules(view, 'suite-import-case-0-required-fields', history.definition.cases[0].required_fields)
    await view.click('suite-import-use')
    assert.deepEqual(await exported(view), history.definition)
    assert.deepEqual(await exported(view, 'run'), saved)
    literalRules(view, 'suite-result-0-required-fields')
    assert.equal(view.requests.calls.startPromptTrial.length, 1); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

async function acceptReport(view, side, source) { await view.file(side, runFile(source)); await view.click(`comparison-${side}-use`) }
async function compare(view, left, right) { await acceptReport(view, 'baseline', left); await acceptReport(view, 'comparison', right); await view.click('comparison-run') }
function noRequests(view) { for (const calls of Object.values(view.requests.calls)) assert.equal(calls.length, 0) }

for (const locale of ['en', 'zh']) test(`comparison renders literal requirements in both previews and sides, preserving rule order in ${locale}`, async () => {
  const view = await mountSuiteComparison({ locale })
  try {
    const left = report(1), right = report(2, definition([item(100, rules().reverse())]))
    for (const [side, source] of [['baseline', left], ['comparison', right]]) {
      await view.file(side, runFile(source)); literalRules(view, `comparison-${side}-preview-case-0-required-fields`, source.definition.cases[0].required_fields)
      await view.click(`comparison-${side}-use`)
    }
    await view.click('comparison-run')
    for (const side of ['baseline', 'comparison']) literalRules(view, `comparison-row-0-${side}-required-fields`)
    assert.equal(view.byId('comparison-row-0').props['data-paired'], true)
    assert.match(view.text(view.byId('comparison-row-0-transition')), locale === 'en' ? /JSON fields check still passes/ : /JSON 字段检查仍通过/)
    assert.match(view.text(view.byId('comparison-summary')), locale === 'en' ? /Pairs with a check/ : /启用检查的配对/)
    await view.click('comparison-export-json')
    const output = JSON.parse(await view.downloads.at(-1).blob.text())
    assert.equal(output.schema_version, 3); assert.equal(output.rows[0].input_changes.required_fields, false)
    assert.equal(output.rows[0].check_transition, 'retained_match')
    assert.deepEqual(output.baseline.definition.cases[0].required_fields, rules())
    assert.deepEqual(output.comparison.definition.cases[0].required_fields, rules().reverse())
    noRequests(view); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('changed field requirements are named and exclude paired findings without hiding captured sides', async () => {
  const view = await mountSuiteComparison()
  try {
    const changed = [{ name: 'other', type: 'null' }]
    await compare(view, report(1), report(2, definition([item(100, changed)]), '{"other":null}'))
    assert.match(view.text(view.byId('comparison-row-0-changed-inputs')), /Required top-level fields/)
    assert.equal(view.byId('comparison-row-0').props['data-paired'], false)
    assert.equal(view.text(view.byId('comparison-row-0-transition')), 'Not comparable')
    literalRules(view, 'comparison-row-0-baseline-required-fields'); literalRules(view, 'comparison-row-0-comparison-required-fields', changed)
    noRequests(view)
  } finally { view.unmount() }
})

for (const version of [1, 2]) for (const kind of ['none', 'exact_text', ...(version === 2 ? ['json_object'] : [])]) test(`mixed v${version}/v3 ${kind} comparisons retain generic summaries and matching inputs`, async () => {
  const view = await mountSuiteComparison()
  try {
    const old = { case_id: id(100), ...trialRequest(), expected_text: kind === 'exact_text' ? '{}' : null, ...(version === 2 ? { check_kind: kind } : {}) }
    const current = { ...old, check_kind: kind, required_fields: null }
    const check = kind === 'none' ? 'not_requested' : 'matched'
    for (const reversed of [false, true]) {
      const pair = [report(1, definition([old], version), '{}', check), report(2, definition([current]), '{}', check)]
      if (reversed) pair.reverse()
      await compare(view, ...pair)
      assert.equal(view.byId('comparison-row-0').props['data-paired'], true)
      assert.match(view.text(view.byId('comparison-summary')), /Pairs with a check/)
      assert.equal(view.text(view.byId('comparison-row-0-transition')), kind === 'none' ? 'Not comparable' : kind === 'json_object' ? 'JSON format check still passes' : 'Retained exact match')
      assert.equal(view.byId('comparison-row-0-changed-inputs'), undefined)
    }
    noRequests(view); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})
