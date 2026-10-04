import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('prompt suites is a separate discoverable application route', () => {
  const router = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
  assert.match(router, /path: '\/prompt-suites'/)
  for (const name of ['Home', 'RuntimeStatusView', 'PromptTrialsView']) {
    assert.match(readFileSync(new URL(`../src/views/${name}.vue`, import.meta.url), 'utf8'), /to="\/prompt-suites"/)
  }
})

import { mountSuites, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'

async function idle(view, snapshot = trialSnapshot()) {
  view.requests.calls.getPromptTrials.at(-1).resolve(ok(snapshot)); await flush()
}
async function fill(view, index = 0, request = trialRequest()) {
  await view.input('suite-name', 'Two precise replies')
  for (const [key, value] of Object.entries(request)) await view.input(`suite-case-${index}-${key}`, value)
}
function ownedSnapshot(view, state = 'succeeded', content = 'Hello back') {
  const request = view.requests.calls.startPromptTrial.at(-1).args[0]
  const data = trialSnapshot(state)
  data.run.request_id = request.request_id
  data.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  if (data.run.response) data.run.response.content = content
  return data
}
async function begin(view) {
  await view.submit('suite-form')
  assert.equal(view.requests.calls.startPromptTrial.length, 0)
  await idle(view)
  assert.equal(view.requests.calls.startPromptTrial.length, 1)
}

for (const locale of ['en', 'zh']) test(`real suite editor mounts passively and exports offline in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    const cloud = trialSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required' })
    cloud.limits.max_output_tokens = null
    await idle(view, cloud); await fill(view)
    assert.ok(view.byId('suite-run').props.disabled)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    await view.click('suite-export-definition')
    const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.kind, 'mirofish_local_prompt_suite')
    assert.equal(saved.schema_version, 1); assert.equal(Object.hasOwn(saved.cases[0], 'check_kind'), false)
    assert.equal(saved.cases[0].user_prompt, 'Hello')
    assert.equal(saved.cases[0].expected_text, null)
    assert.equal(view.revokedUrls.length, 1)
    assert.match(view.text(), locale === 'en' ? /local mode/ : /本地模式/)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('editor keeps stable case identities and bounds cases, strings, controls and the loaded cap', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    await view.click('suite-export-definition')
    const first = JSON.parse(await view.downloads[0].blob.text()).cases[0].case_id
    for (let i = 1; i < 5; i++) { await view.click('suite-add-case'); await fill(view, i) }
    assert.ok(view.byId('suite-add-case').props.disabled)
    await view.click('suite-case-1-remove')
    assert.equal(view.all(node => node.props['data-testid']?.match(/^suite-case-\d+-label$/)).length, 4)
    await view.click('suite-export-definition')
    assert.equal(JSON.parse(await view.downloads[1].blob.text()).cases[0].case_id, first)
    for (const [key, value] of [['label', 'x'.repeat(81)], ['system_prompt', 'x'.repeat(1001)], ['user_prompt', 'x'.repeat(4001)], ['temperature', ''], ['temperature', 1.1], ['max_output_tokens', 513]]) {
      const previous = view.byId(`suite-case-0-${key}`).props.value
      await view.input(`suite-case-0-${key}`, value)
      assert.ok(view.byId('suite-export-definition').props.disabled, key)
      await view.input(`suite-case-0-${key}`, previous)
    }
    const lowerCap = trialSnapshot(); lowerCap.limits.max_output_tokens = 64
    await view.click('suite-refresh'); await idle(view, lowerCap)
    assert.ok(view.byId('suite-run').props.disabled)
    assert.equal(view.byId('suite-export-definition').props.disabled, false)
    assert.ok(view.byId('suite-cap-warning'))
  } finally { view.unmount() }
})

test('explicit empty expected reply is checked exactly and a captured run survives draft edits', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    await view.change('suite-case-0-check_enabled', true)
    assert.equal(view.byId('suite-case-0-expected_text').props.value, '')
    await begin(view)
    await view.input('suite-case-0-user_prompt', 'Another draft')
    await view.input('suite-name', 'New draft title')
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view, 'succeeded', ''))); await flush()
    assert.match(view.text(view.byId('suite-result-0-check')), /Exact reply matched/)
    assert.equal(view.text(view.byId('suite-result-0-reply')), '')
    assert.match(view.text(view.byId('suite-run-report')), /Two precise replies/)
    await view.click('suite-export-run')
    const report = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(report.definition.name, 'Two precise replies')
    assert.equal(report.definition.cases[0].user_prompt, 'Hello')
    assert.equal(report.definition.cases[0].expected_text, '')
    assert.equal(report.cases[0].snapshot.run.response.content, '')
    assert.equal(report.cases[0].check, 'matched')
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

const definition = (name = 'Imported suite', overrides = {}) => ({ schema_version: 1, kind: 'mirofish_local_prompt_suite', name,
  cases: [{ case_id: '12345678-1234-4234-9234-123456789abc', ...trialRequest(), expected_text: null }], ...overrides })
const suiteFile = value => {
  const content = typeof value === 'string' ? value : JSON.stringify(value)
  return { name: 'suite.json', size: new TextEncoder().encode(content).length, text: async () => content }
}
const pendingFile = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { name: 'slow.json', size: 100, text: () => promise, resolve, reject }
}

for (const locale of ['en', 'zh']) test(`two cases run sequentially with literal results and independent exact checks in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view); await fill(view)
    await view.change('suite-case-0-check_enabled', true)
    await view.input('suite-case-0-expected_text', 'Hello back')
    await view.click('suite-add-case'); await fill(view, 1, { ...trialRequest(), label: 'Second case', user_prompt: 'Do not execute <script>malicious()</script>' })
    await view.submit('suite-form'); await view.submit('suite-form')
    await idle(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    const literal = 'Hello back\n<think> Keep EXACT casing </think>\n<script>malicious()</script>'
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view, 'succeeded', literal))); await flush()
    assert.equal(view.byId('suite-result-0').props['data-check'], 'mismatched')
    assert.equal(view.text(view.byId('suite-result-0-reply')), literal)
    assert.equal(view.all(node => node.type === 'script').length, 0)
    await view.timers.advance(1499)
    assert.equal(view.requests.calls.getPromptTrials.length, 2)
    await view.timers.advance(1)
    assert.equal(view.requests.calls.getPromptTrials.length, 3)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    await idle(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 2)
    view.requests.calls.startPromptTrial[1].resolve(ok(ownedSnapshot(view))); await flush()
    assert.equal(view.byId('suite-run-report').props['data-status'], 'completed')
    assert.equal(view.byId('suite-result-1').props['data-check'], 'not_requested')
    assert.match(view.text(view.byId('suite-result-1-model')), /local-chat/)
    await view.click('suite-export-run')
    const report = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(report.cases[0].snapshot.run.response.content, literal)
    assert.equal(report.cases[0].snapshot.run.request.user_prompt, 'Hello')
    assert.notEqual(report.cases[0].request_id, report.cases[1].request_id)
    assert.equal(view.revokedUrls.length, 1)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('definition import requires review and explicit use, preserves exact values and leaves captured run intact', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await begin(view)
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view))); await flush()
    const imported = definition('  Imported exact name  ')
    imported.cases[0].expected_text = '\r\n Reply <b>exact</b> '
    imported.cases[0].system_prompt = '\tSystem\r\n'
    await view.file(suiteFile(imported))
    assert.ok(view.byId('suite-import-preview'))
    assert.equal(view.byId('suite-name').props.value, 'Two precise replies')
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    await view.click('suite-import-use')
    assert.equal(view.byId('suite-name').props.value, imported.name)
    assert.equal(view.byId('suite-case-0-expected_text').props.value, imported.cases[0].expected_text)
    assert.equal(view.byId('suite-case-0-check_enabled').props.checked, true)
    assert.equal(view.byId('suite-import-preview'), undefined)
    assert.match(view.text(view.byId('suite-run-report')), /Two precise replies/)
    await view.input('suite-case-0-label', 'Mutable imported label')
    await view.click('suite-export-definition')
    const exported = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(exported.cases[0].case_id, imported.cases[0].case_id)
    assert.equal(exported.cases[0].expected_text, imported.cases[0].expected_text)
    assert.equal(exported.cases[0].system_prompt, imported.cases[0].system_prompt)
    assert.equal(exported.cases[0].label, 'Mutable imported label')
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
  } finally { view.unmount() }
})

for (const failure of ['invalid JSON', 'duplicate keys', 'extra endpoint', 'result archive', 'read failed', 'oversize before', 'oversize after']) test(`invalid import (${failure}) preserves the draft and avoids inference`, async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    let readCount = 0
    let file
    if (failure === 'invalid JSON') file = suiteFile('{')
    if (failure === 'duplicate keys') file = suiteFile(JSON.stringify(definition()).replace('"schema_version":1', '"schema_version":1,"schema_version":1'))
    if (failure === 'extra endpoint') file = suiteFile({ ...definition(), endpoint: 'https://untrusted.invalid' })
    if (failure === 'result archive') file = suiteFile({ ...definition(), kind: 'mirofish_local_prompt_suite_run' })
    if (failure === 'read failed') file = { size: 10, text: async () => { throw new Error('PRIVATE FILE ERROR') } }
    if (failure.startsWith('oversize')) file = { size: failure === 'oversize before' ? 131073 : 10, text: async () => { readCount++; return ' '.repeat(131073) } }
    await view.file(file)
    assert.ok(view.byId('suite-import-error'))
    assert.equal(view.byId('suite-name').props.value, 'Two precise replies')
    assert.equal(view.byId('suite-case-0-user_prompt').props.value, 'Hello')
    assert.equal(view.byId('suite-import-preview'), undefined)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    assert.doesNotMatch(view.text(), /PRIVATE FILE ERROR|untrusted\.invalid/)
    if (failure === 'oversize before') assert.equal(readCount, 0)
    if (failure === 'oversize after') assert.equal(readCount, 1)
  } finally { view.unmount() }
})

test('newer file, cancelled file and retired file reads cannot replace the preview or expose stale errors', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    const older = pendingFile(); await view.file(older)
    await view.file(suiteFile(definition('Newer import')))
    older.reject(new Error('PRIVATE OLD READ')); await flush()
    assert.match(view.text(view.byId('suite-import-preview')), /Newer import/)
    assert.equal(view.byId('suite-import-error'), undefined)
    const cancelled = pendingFile(); await view.file(cancelled)
    await view.click('suite-import-cancel')
    cancelled.resolve(JSON.stringify(definition('Cancelled import'))); await flush()
    assert.equal(view.byId('suite-import-preview'), undefined)
    assert.equal(view.byId('suite-name').props.value, 'Two precise replies')
    const retired = pendingFile(); await view.file(retired)
    await view.navigate('/prompt-trials'); await view.navigate('/prompt-suites')
    retired.resolve(JSON.stringify(definition('Retired import'))); await flush()
    assert.equal(view.byId('suite-import-preview'), undefined)
    assert.equal(view.byId('suite-name').props.value, '')
    assert.doesNotMatch(view.text(), /PRIVATE OLD READ|Cancelled import|Retired import/)
  } finally { view.unmount() }
})

test('expected reply checkbox preserves an intentional empty string and enforces Unicode character bounds', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    assert.equal(view.byId('suite-case-0-expected_text'), undefined)
    await view.change('suite-case-0-check_enabled', true)
    await view.input('suite-case-0-expected_text', '🧪'.repeat(500))
    assert.equal(view.byId('suite-export-definition').props.disabled, false)
    await view.input('suite-case-0-expected_text', '🧪'.repeat(501))
    assert.ok(view.byId('suite-export-definition').props.disabled)
    await view.input('suite-case-0-expected_text', '')
    await view.click('suite-export-definition')
    assert.equal(JSON.parse(await view.downloads[0].blob.text()).cases[0].expected_text, '')
    await view.change('suite-case-0-check_enabled', false)
    await view.click('suite-export-definition')
    assert.equal(JSON.parse(await view.downloads[1].blob.text()).cases[0].expected_text, null)
    assert.ok(view.byId('suite-case-0-remove').props.disabled)
  } finally { view.unmount() }
})

test('stop during initial readiness admits no request and a later run still needs an explicit click', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    await view.submit('suite-form'); await view.click('suite-stop'); await idle(view)
    await view.timers.advance(100000)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    assert.equal(view.byId('suite-run-report'), undefined)
    await view.submit('suite-form'); await idle(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
  } finally { view.unmount() }
})

test('stop observes an active accepted case, preserves a partial export, and never schedules another case', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await view.click('suite-add-case'); await fill(view, 1)
    await begin(view)
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view, 'running'))); await flush()
    await view.click('suite-stop'); await view.click('suite-export-run')
    const partial = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(partial.status, 'running')
    assert.equal(partial.stop_requested, true)
    assert.equal(partial.cases[1].status, 'not_attempted')
    await view.timers.advance(1500)
    view.requests.calls.getPromptTrial[0].resolve(ok(ownedSnapshot(view))); await flush()
    await view.timers.advance(100000)
    assert.equal(view.byId('suite-run-report').props['data-status'], 'stopped')
    assert.equal(view.byId('suite-result-1').props['data-status'], 'not_attempted')
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    assert.ok(view.byId('suite-stop').props.disabled)
  } finally { view.unmount() }
})

test('lost submission reconciliation is explicit after failure and never resumes remaining cases', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await view.click('suite-add-case'); await fill(view, 1)
    await begin(view)
    view.requests.calls.startPromptTrial[0].reject(new Error('PRIVATE POST FAILURE')); await flush()
    const automatic = view.requests.calls.getPromptTrial[0]
    assert.equal(automatic.args[0], view.requests.calls.startPromptTrial[0].args[0].request_id)
    automatic.reject(new Error('PRIVATE GET FAILURE')); await flush()
    assert.equal(view.byId('suite-result-0').props['data-status'], 'unknown')
    assert.ok(view.byId('suite-reconcile'))
    await view.click('suite-reconcile')
    view.requests.calls.getPromptTrial[1].resolve(ok(ownedSnapshot(view))); await flush()
    assert.equal(view.byId('suite-result-0').props['data-status'], 'succeeded')
    assert.equal(view.byId('suite-result-1').props['data-status'], 'not_attempted')
    await view.timers.advance(100000)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    assert.doesNotMatch(view.text(), /PRIVATE POST FAILURE|PRIVATE GET FAILURE/)
  } finally { view.unmount() }
})

for (const phase of ['readiness', 'submission', 'observation', 'waiting']) test(`navigation retires ${phase} without resuming after A–B–A return`, async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await view.click('suite-add-case'); await fill(view, 1)
    await view.submit('suite-form')
    let pending = view.requests.calls.getPromptTrials.at(-1)
    if (phase !== 'readiness') {
      await idle(view); pending = view.requests.calls.startPromptTrial[0]
      if (['observation', 'waiting'].includes(phase)) {
        pending.resolve(ok(ownedSnapshot(view, phase === 'observation' ? 'running' : 'succeeded'))); await flush()
        if (phase === 'observation') { await view.timers.advance(1500); pending = view.requests.calls.getPromptTrial[0] }
        else pending = null
      }
    }
    const started = view.requests.calls.startPromptTrial.length
    await view.navigate('/prompt-trials')
    if (pending) assert.equal(pending.signal.aborted, true)
    assert.equal(view.timers.pending.size, 0)
    await view.navigate('/prompt-suites'); await idle(view)
    pending?.reject(new Error('PRIVATE RETIRED FAILURE')); await flush()
    await view.timers.advance(100000)
    assert.equal(view.requests.calls.startPromptTrial.length, started)
    assert.equal(view.byId('suite-run-report'), undefined)
    assert.equal(view.byId('suite-name').props.value, '')
    assert.equal(view.byId('suite-error'), undefined)
    assert.doesNotMatch(view.text(), /PRIVATE RETIRED FAILURE/)
  } finally { view.unmount() }
})

test('read failures are safely shown, keep the report, and require a fresh readiness observation before a new run', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await begin(view)
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view))); await flush()
    await view.click('suite-refresh')
    view.requests.calls.getPromptTrials.at(-1).reject(new Error('SECRET NETWORK ERROR')); await flush()
    assert.ok(view.byId('suite-error'))
    assert.ok(view.byId('suite-stale'))
    assert.ok(view.byId('suite-run').props.disabled)
    assert.equal(view.byId('suite-run-report').props['data-status'], 'completed')
    assert.doesNotMatch(view.text(), /SECRET NETWORK ERROR/)
    await view.click('suite-refresh'); await idle(view)
    assert.equal(view.byId('suite-error'), undefined)
    assert.equal(view.byId('suite-run').props.disabled, false)
  } finally { view.unmount() }
})

test('download failures disclose a safe error and preserve the editable definition', async () => {
  const view = await mountSuites({ downloadError: true })
  try {
    await idle(view); await fill(view)
    await view.click('suite-export-definition')
    assert.ok(view.byId('suite-export-error'))
    assert.equal(view.byId('suite-name').props.value, 'Two precise replies')
    assert.equal(view.downloads.length, 0)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    assert.doesNotMatch(view.text(), /Private URL failure/)
  } finally { view.unmount() }
})

test('download cleanup removes its anchor and revokes its object URL even when clicking fails', async () => {
  const view = await mountSuites({ downloadError: 'click' })
  try {
    await idle(view); await fill(view)
    await view.click('suite-export-definition')
    assert.ok(view.byId('suite-export-error'))
    assert.equal(view.downloads.length, 0)
    assert.equal(view.revokedUrls.length, 1)
    assert.equal(view.removedAnchors.length, 1)
    assert.doesNotMatch(view.text(), /Private anchor failure/)
  } finally { view.unmount() }
})

test('retired file and download handlers cannot produce a download after navigation', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view)
    const download = view.byId('suite-export-definition').props.onClick
    await view.navigate('/prompt-trials')
    download(); await flush()
    assert.equal(view.downloads.length, 0)
    assert.equal(view.revokedUrls.length, 0)
  } finally { view.unmount() }
})

test('a denied new run preserves the previous report until a later explicit fresh-ready run is admitted', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await begin(view)
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view))); await flush()
    await view.input('suite-name', 'Second run')
    await view.submit('suite-form'); await idle(view, trialSnapshot('running'))
    assert.match(view.text(view.byId('suite-run-report')), /Two precise replies/)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    await view.click('suite-refresh'); await idle(view)
    assert.match(view.text(view.byId('suite-run-report')), /Two precise replies/)
    await view.submit('suite-form'); await idle(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 2)
    assert.match(view.text(view.byId('suite-run-report')), /Second run/)
    assert.doesNotMatch(view.text(view.byId('suite-run-report')), /Two precise replies/)
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`explicit JSON mode promotes the draft once and preserves other case inputs in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view)
    const imported = definition('Imported v1 with checks')
    imported.cases[0].expected_text = ' {"answer": 1} '
    imported.cases.push({ ...imported.cases[0], case_id: '12345678-1234-4234-9234-123456789abd', label: 'Unchecked case', expected_text: null })
    imported.cases.push({ ...imported.cases[0], case_id: '12345678-1234-4234-9234-123456789abe', label: 'Empty exact case', expected_text: '' })
    imported.cases.push({ ...imported.cases[0], case_id: '12345678-1234-4234-9234-123456789abf', label: 'Kept unchecked case', expected_text: null })
    await view.file(suiteFile(imported)); await view.click('suite-import-use')
    assert.equal(view.byId('suite-case-0-check_kind')?.props.value, 'exact_text')
    assert.equal(view.byId('suite-case-1-check_kind'), undefined)
    await view.click('suite-export-definition')
    assert.deepEqual(JSON.parse(await view.downloads[0].blob.text()), imported)
    await view.change('suite-case-1-check_enabled', true)
    assert.equal(view.byId('suite-case-1-check_kind').props.value, 'exact_text')
    await view.change('suite-case-1-check_kind', 'json_object')
    assert.equal(view.byId('suite-case-1-expected_text'), undefined)
    assert.match(view.text(), locale === 'en' ? /format only.*64 KiB/s : /仅检查格式.*64 KiB/s)
    await view.click('suite-export-definition')
    const promoted = JSON.parse(await view.downloads[1].blob.text())
    assert.equal(promoted.schema_version, 2)
    assert.deepEqual(promoted.cases, imported.cases.map((item, index) => ({ ...item, check_kind: index === 1 ? 'json_object' : item.expected_text === null ? 'none' : 'exact_text' })))
    await view.click('suite-add-case'); await fill(view, 4)
    await view.change('suite-case-1-check_kind', 'exact_text')
    assert.equal(view.byId('suite-case-1-expected_text').props.value, '')
    await view.change('suite-case-1-check_enabled', false)
    await view.click('suite-export-definition')
    const edited = JSON.parse(await view.downloads[2].blob.text())
    assert.equal(edited.schema_version, 2)
    assert.equal(edited.cases[1].check_kind, 'none'); assert.equal(edited.cases[1].expected_text, null)
    assert.equal(edited.cases[3].check_kind, 'none'); assert.equal(edited.cases[3].expected_text, null)
    assert.equal(edited.cases[4].check_kind, 'none'); assert.equal(edited.cases[4].expected_text, null)
    assert.equal(view.requests.calls.startPromptTrial.length, 0)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) for (const [reply, check] of [[' {"items": [1, {}]} \n', 'matched'], ['{"a":1,"a":2}', 'mismatched']]) test(`captured JSON ${check} and imported kind render correctly in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await idle(view)
    const imported = definition('JSON format check', { schema_version: 2 })
    imported.cases[0].check_kind = 'json_object'
    await view.file(suiteFile(imported))
    assert.match(view.text(view.byId('suite-import-preview')), locale === 'en' ? /JSON object/ : /JSON 对象/)
    await view.click('suite-import-use')
    assert.equal(view.byId('suite-case-0-check_enabled').props.checked, true)
    assert.equal(view.byId('suite-case-0-check_kind').props.value, 'json_object')
    assert.equal(view.byId('suite-case-0-expected_text'), undefined)
    await begin(view)
    assert.deepEqual(Object.keys(view.requests.calls.startPromptTrial[0].args[0]).sort(), [...Object.keys(trialRequest()), 'request_id'].sort())
    await view.change('suite-case-0-check_kind', 'exact_text')
    await view.input('suite-case-0-expected_text', 'Edited after capture')
    view.requests.calls.startPromptTrial[0].resolve(ok(ownedSnapshot(view, 'succeeded', reply))); await flush()
    assert.equal(view.byId('suite-result-0').props['data-check'], check)
    assert.match(view.text(view.byId('suite-result-0-check')), locale === 'en' ? /JSON object format/ : /JSON 对象格式/)
    assert.doesNotMatch(view.text(view.byId('suite-result-0-check')), /Exact reply|完整回复/)
    assert.match(view.text(view.byId('suite-result-0-kind')), locale === 'en' ? /JSON object/ : /JSON 对象/)
    assert.match(view.text(view.byId('suite-summary')), locale === 'en' ? /Checks passed.*Checks failed/s : /检查通过.*检查未通过/s)
    assert.equal(view.text(view.byId('suite-result-0-reply')), reply)
    await view.click('suite-export-run')
    const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.schema_version, 2); assert.deepEqual(saved.definition, imported)
    assert.equal(saved.cases[0].check, check)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('check handlers for replaced or retired drafts cannot change a new import', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await view.change('suite-case-0-check_enabled', true)
    const oldMode = view.byId('suite-case-0-check_kind')?.props.onChange
    assert.equal(typeof oldMode, 'function')
    await view.file(suiteFile(definition('Replacement'))); await view.click('suite-import-use')
    oldMode({ target: { value: 'json_object' } }); await flush()
    await view.click('suite-export-definition')
    assert.equal(JSON.parse(await view.downloads[0].blob.text()).schema_version, 1)
    await view.navigate('/prompt-trials'); oldMode({ target: { value: 'json_object' } }); await flush()
    assert.equal(view.downloads.length, 1)
  } finally { view.unmount() }
})

test('queued hidden check controls cannot re-enable a check or restore a JSON expectation', async () => {
  const view = await mountSuites()
  try {
    await idle(view); await fill(view); await view.change('suite-case-0-check_enabled', true)
    const oldMode = view.byId('suite-case-0-check_kind').props.onChange
    const oldExpected = view.byId('suite-case-0-expected_text').props.onInput
    await view.change('suite-case-0-check_enabled', false)
    oldMode({ target: { value: 'json_object' } }); await flush()
    await view.click('suite-export-definition')
    assert.equal(JSON.parse(await view.downloads[0].blob.text()).schema_version, 1)
    await view.change('suite-case-0-check_enabled', true); await view.change('suite-case-0-check_kind', 'json_object')
    oldExpected({ target: { value: 'Stale expectation' } }); await flush()
    assert.equal(view.byId('suite-export-definition').props.disabled, false)
    await view.click('suite-export-definition')
    const saved = JSON.parse(await view.downloads[1].blob.text())
    assert.equal(saved.schema_version, 2); assert.equal(saved.cases[0].check_kind, 'json_object'); assert.equal(saved.cases[0].expected_text, null)
  } finally { view.unmount() }
})
