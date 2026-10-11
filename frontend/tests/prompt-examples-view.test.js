import assert from 'node:assert/strict'
import test from 'node:test'
import { mountPromptExamplesView, trialSnapshot, trialRequest, flush } from './helpers/prompt-examples-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'
import { evaluatePromptSuiteCheck } from '../src/utils/promptSuites.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
function report(n = 1, { item: overrides, reply = 'Hello back', status = 'succeeded', version = 1, ...options } = {}) {
  const item = { case_id: id(100), ...trialRequest(), expected_text: null, ...overrides }
  if (version >= 2) item.check_kind = options.kind ?? (item.expected_text === null ? 'none' : 'exact_text')
  if (version === 3) item.required_fields = options.requiredFields ?? null
  const snapshot = acceptPromptTrialSnapshot({ success: true, data: trialSnapshot('succeeded') })
  snapshot.run.request_id = id(n + 20)
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, item[key]]))
  snapshot.run.response.content = reply
  const row = { case_id: item.case_id, request_id: snapshot.run.request_id, status, check: 'not_evaluated', snapshot, error_code: null }
  if (status === 'succeeded') row.check = evaluatePromptSuiteCheck(item, status, reply)
  else if (['not_attempted', 'submitting', 'rejected'].includes(status)) { row.snapshot = null; if (status === 'not_attempted') row.request_id = null }
  else if (['running', 'unknown'].includes(status)) {
    snapshot.run.state = 'running'; snapshot.run.finished_at = null; snapshot.run.request_duration_ms = null
    snapshot.run.response = null; snapshot.run.cleanup = { state: 'pending', duration_ms: null }
  } else {
    snapshot.run.state = status
    if (status === 'truncated') snapshot.run.response.finish_reason = 'length'
    else if (status === 'refused') snapshot.run.response = { content: null, refusal: '<b>Recorded refusal</b>', finish_reason: 'content_filter', usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } }
    else { snapshot.run.response = null; snapshot.run.error_code = status === 'timed_out' ? 'request_timeout' : status === 'cancelled' ? 'backend_closing' : 'internal_failure' }
  }
  return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(n),
    definition: { schema_version: version, kind: 'mirofish_local_prompt_suite', name: `Run ${n}`, cases: [item] },
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: status === 'succeeded' ? 'completed' : 'halted', stop_requested: false, halt_code: status === 'succeeded' ? null : 'runtime_failed', cases: [row] }
}
function reportFile(source) {
  const bytes = new TextEncoder().encode(typeof source === 'string' ? source : JSON.stringify(source))
  return { name: 'report.json', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }
}
function pendingFile() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { name: 'pending.json', size: 100, arrayBuffer: () => promise, resolve: source => resolve(new TextEncoder().encode(JSON.stringify(source)).buffer), reject }
}
async function accept(view, source = report()) {
  await view.file(reportFile(source)); assert.ok(view.byId('examples-preview')); await view.click('examples-use')
}
async function approve(view, index = 0, text = 'Human target') {
  await view.input(`examples-row-${index}-target`, text); await view.click(`examples-row-${index}-approve`)
}
async function build(view, source = report()) { await accept(view, source); await approve(view); await view.click('examples-build') }
function noRequests(view) { for (const calls of Object.values(view.requests.calls)) assert.equal(calls.length, 0) }
const handler = (view, name, type = 'onClick') => view.byId(name).props[type]
async function invoke(action, value) { action({ target: { value }, preventDefault() {}, stopPropagation() {}, button: 0 }); await flush() }

for (const locale of ['en', 'zh']) test(`explicit review produces two offline captured exports in ${locale}`, async () => {
  const view = await mountPromptExamplesView({ locale })
  try {
    assert.ok(view.byId('examples-file')); assert.ok(view.byId('examples-build').props.disabled); noRequests(view)
    await view.file(reportFile(report(1, { item: { expected_text: 'Hello back' } })))
    assert.ok(view.byId('examples-preview')); assert.equal(view.byId('examples-accepted'), undefined)
    await view.click('examples-use')
    assert.equal(view.byId('examples-row-0-target').props.value, ''); assert.ok(view.byId('examples-row-0-approve').props.disabled)
    assert.equal(view.text(view.byId('examples-selected-count')), locale === 'en' ? '0 targets approved for export' : '已批准导出 0 个目标回复')
    await view.click('examples-row-0-copy'); assert.equal(view.byId('examples-row-0-target').props.value, 'Hello back')
    assert.ok(view.byId('examples-build').props.disabled); assert.equal(view.byId('examples-row-0-remove-approval'), undefined)
    await view.click('examples-row-0-approve'); assert.ok(view.byId('examples-row-0-remove-approval'))
    await view.click('examples-build'); assert.ok(view.byId('examples-bundle'))
    await view.click('examples-export-jsonl'); await view.click('examples-export-review')
    const jsonl = await view.downloads[0].blob.text(), review = JSON.parse(await view.downloads[1].blob.text())
    assert.deepEqual(JSON.parse(jsonl), { messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello back' }] })
    assert.ok(jsonl.endsWith('\n')); assert.equal(review.kind, 'mirofish_reviewed_prompt_examples')
    assert.equal(view.downloads[0].filename, 'reviewed_prompt_examples.jsonl'); assert.equal(view.downloads[1].filename, 'reviewed_prompt_examples.review.json')
    assert.equal(view.revokedUrls.length, 2); assert.equal(view.removedAnchors.length, 2)
    assert.deepEqual(view.warnings, []); assert.doesNotMatch(view.text(), /promptExamples\./); noRequests(view)
  } finally { view.unmount() }
})

for (const version of [1, 2, 3]) test(`version ${version} keeps recorded checks separate from a corrected target`, async () => {
  const view = await mountPromptExamplesView()
  try {
    const source = report(1, { version, item: { expected_text: version === 1 ? 'new target' : null }, reply: 'old reply',
      ...(version === 2 ? { kind: 'json_object' } : version === 3 ? { kind: 'json_fields', requiredFields: [{ name: 'answer', type: 'string' }] } : {}) })
    await accept(view, source); const recorded = view.text(view.byId('examples-row-0-recorded-check'))
    await approve(view, 0, version === 1 ? 'new target' : '{"answer":"new"}')
    assert.equal(view.text(view.byId('examples-row-0-recorded-check')), recorded)
    assert.match(view.text(view.byId('examples-row-0-target-check')), /matched|passed/)
    assert.equal(view.byId('examples-row-0-reply-equal').props['data-equal'], false)
    await view.input('examples-row-0-target', 'mismatching human target')
    assert.equal(view.byId('examples-row-0-remove-approval'), undefined)
    await view.click('examples-row-0-approve'); assert.ok(view.byId('examples-row-0-remove-approval'))
    await view.click('examples-build'); assert.ok(view.byId('examples-bundle')); noRequests(view)
  } finally { view.unmount() }
})

for (const status of ['succeeded','not_attempted','submitting','running','unknown','rejected','truncated','refused','failed','timed_out','cancelled']) test(`${status} stays historical and never auto-selects a target`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view, report(1, { status }))
    assert.equal(view.byId('examples-row-0-target').props.value, '')
    assert.equal(!!view.byId('examples-row-0-copy'), status === 'succeeded')
    assert.equal(view.byId('examples-row-0').props['data-status'], status)
    if (status === 'refused') assert.equal(view.text(view.byId('examples-row-0-refusal')), '<b>Recorded refusal</b>')
    await approve(view); assert.equal(view.byId('examples-row-0-reply-equal').props['data-equal'], status === 'succeeded' ? false : null)
    await view.click('examples-build'); assert.ok(view.byId('examples-bundle')); noRequests(view)
  } finally { view.unmount() }
})

for (const invalid of ['', ' \r\n\t', 'a'.repeat(16385), '🦙'.repeat(16385), '\u0000bad', '\u007fbad', '\u0085bad', '\ud800bad']) test(`invalid target ${JSON.stringify(invalid.slice(0, 12))} cannot be approved`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view); await view.input('examples-row-0-target', invalid)
    assert.ok(view.byId('examples-row-0-approve').props.disabled); assert.ok(view.byId('examples-build').props.disabled)
    assert.equal(view.byId('examples-row-0-target').props.value, invalid)
  } finally { view.unmount() }
})

test('target bounds preserve exact Unicode text, whitespace and line endings', async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view); await approve(view, 0, '🦙'.repeat(16384)); await view.click('examples-build'); await view.click('examples-export-jsonl')
    assert.equal(JSON.parse(await view.downloads[0].blob.text()).messages[1].content, '🦙'.repeat(16384))
    const text = '  A\r\n\t<think>e\u0301 🦙</think>  '
    await approve(view, 0, text); await view.click('examples-build'); await view.click('examples-export-jsonl')
    assert.equal(JSON.parse(await view.downloads[1].blob.text()).messages[1].content, text)
  } finally { view.unmount() }
})

test('selected targets retain source order and omit unselected secrets without deduplication', async () => {
  const view = await mountPromptExamplesView()
  try {
    const source = report()
    for (let n = 1; n < 5; n++) {
      const other = report(n + 1, { item: { case_id: id(100 + n), label: `Case ${n}`, user_prompt: n === 1 ? 'UNSELECTED SECRET' : 'Hello' }, reply: n === 1 ? 'UNSELECTED REPLY' : 'Hello back' })
      source.definition.cases.push(other.definition.cases[0]); source.cases.push(other.cases[0])
    }
    await accept(view, source); await approve(view, 4, 'last'); await approve(view, 0, 'first'); await approve(view, 2, 'middle')
    assert.match(view.text(view.byId('examples-selected-count')), /^3 /); assert.ok(view.byId('examples-repeated-input-notice'))
    await view.click('examples-build'); await view.click('examples-export-jsonl'); await view.click('examples-export-review')
    assert.deepEqual((await view.downloads[0].blob.text()).trimEnd().split('\n').map(line => JSON.parse(line).messages.at(-1).content), ['first','middle','last'])
    assert.doesNotMatch(await view.downloads[1].blob.text(), /UNSELECTED SECRET|UNSELECTED REPLY/)
  } finally { view.unmount() }
})

for (const failure of ['malformed','duplicate','nested duplicate','deep','wrong kind','identity','bad UTF-8','BOM','read error','oversize before','oversize after','text-only','non-buffer']) test(`bad ${failure} replacement retains targets, approvals and captured bundle`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); await view.click('examples-export-review'); const original = await view.downloads[0].blob.text()
    let file = reportFile(report(2)), reads = 0
    if (failure === 'malformed') file = reportFile('{')
    if (failure === 'duplicate') file = reportFile(JSON.stringify(report(2)).replace('"schema_version":1','"schema_version":1,"schema_version":1'))
    if (failure === 'nested duplicate') file = reportFile(JSON.stringify(report(2)).replace('"model":"local-chat"','"model":"local-chat","model":"new"'))
    if (failure === 'deep') file = reportFile('['.repeat(13)+']'.repeat(13))
    if (failure === 'wrong kind') file = reportFile({ ...report(2), kind: 'mirofish_reviewed_prompt_examples' })
    if (failure === 'identity') { const source = report(2); source.cases[0].request_id = id(999); file = reportFile(source) }
    if (failure === 'bad UTF-8') file = { size: 2, arrayBuffer: async () => Uint8Array.from([0xc0,0xaf]).buffer }
    if (failure === 'BOM') file = reportFile('\ufeff' + JSON.stringify(report(2)))
    if (failure === 'read error') file = { size: 10, arrayBuffer: async () => { throw new Error('PRIVATE FILE FAILURE') } }
    if (failure.startsWith('oversize')) file = { size: failure === 'oversize before' ? 1048577 : 10, arrayBuffer: async () => { reads++; return new ArrayBuffer(1048577) } }
    if (failure === 'text-only') file = { size: 10, text: async () => JSON.stringify(report(2)) }
    if (failure === 'non-buffer') file = { size: 10, arrayBuffer: async () => new Uint8Array(10) }
    await view.file(file)
    assert.ok(view.byId('examples-import-error')); assert.ok(view.byId('examples-retained')); assert.ok(view.byId('examples-bundle'))
    assert.equal(view.byId('examples-preview'), undefined); assert.equal(view.byId('examples-row-0-target').props.value, 'Human target')
    assert.ok(view.byId('examples-row-0-remove-approval')); assert.doesNotMatch(view.text(), /PRIVATE FILE FAILURE/)
    await view.click('examples-export-review'); assert.equal(await view.downloads[1].blob.text(), original)
    if (failure === 'oversize before') assert.equal(reads, 0)
    noRequests(view)
  } finally { view.unmount() }
})

test('preview cancellation and latest-only file reads preserve accepted work', async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); const slow = pendingFile(); await view.file(slow)
    await view.file(reportFile(report(2))); const oldUse = handler(view,'examples-use'), oldCancel = handler(view,'examples-cancel')
    await view.file(reportFile(report(3))); await invoke(oldUse); await invoke(oldCancel)
    assert.match(view.text(view.byId('examples-preview')), /Run 3/); assert.match(view.text(view.byId('examples-accepted')), /Run 1/)
    slow.reject(new Error('OLD ERROR')); await flush(); assert.equal(view.byId('examples-import-error'), undefined)
    await view.click('examples-cancel'); assert.ok(view.byId('examples-bundle')); assert.ok(view.byId('examples-retained'))
    const cancelled = pendingFile(); await view.file(cancelled); await view.file(null); cancelled.resolve(report(4)); await flush()
    assert.equal(view.byId('examples-preview'), undefined); assert.ok(view.byId('examples-bundle'))
    await view.file(reportFile(report(5))); await view.click('examples-use')
    assert.equal(view.byId('examples-row-0-target').props.value, ''); assert.equal(view.byId('examples-bundle'), undefined)
    assert.ok(view.byId('examples-build').props.disabled); noRequests(view)
  } finally { view.unmount() }
})

test('editing invalidates approval and bundle synchronously and defeats ABA stale handlers', async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); const oldInput = handler(view,'examples-row-0-target','onInput'), oldCopy = handler(view,'examples-row-0-copy'), oldApprove = handler(view,'examples-row-0-approve'), oldRemove = handler(view,'examples-row-0-remove-approval'), oldBuild = handler(view,'examples-build'), oldDownload = handler(view,'examples-export-jsonl')
    oldInput({ target: { value: 'Changed' } }); oldDownload({}); oldBuild({}); oldApprove({}); oldRemove({}); oldCopy({})
    await flush(); assert.equal(view.byId('examples-bundle'), undefined); assert.equal(view.byId('examples-row-0-remove-approval'), undefined); assert.equal(view.downloads.length, 0)
    assert.equal(view.byId('examples-row-0-target').props.value, 'Changed')
    await view.input('examples-row-0-target','Human target')
    await invoke(oldApprove); await invoke(oldInput,'STALE'); await invoke(oldCopy); await invoke(oldBuild)
    assert.equal(view.byId('examples-row-0-target').props.value, 'Human target'); assert.equal(view.byId('examples-row-0-remove-approval'), undefined)
    await view.click('examples-row-0-approve'); await view.click('examples-build'); await invoke(oldDownload); assert.equal(view.downloads.length, 0)
  } finally { view.unmount() }
})

test('copy and remove approval retire bundles and old approvals even when text stays equal', async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view, report(1,{ reply:'Human target' })); const oldApprove = handler(view,'examples-row-0-approve')
    await view.click('examples-row-0-copy'); assert.equal(view.byId('examples-bundle'), undefined); assert.equal(view.byId('examples-row-0-remove-approval'), undefined)
    await invoke(oldApprove); assert.ok(view.byId('examples-build').props.disabled)
    await view.click('examples-row-0-approve'); await view.click('examples-build'); const oldDownload = handler(view,'examples-export-review')
    await view.click('examples-row-0-remove-approval'); await invoke(oldDownload)
    assert.equal(view.downloads.length, 0); assert.equal(view.byId('examples-bundle'), undefined); assert.equal(view.byId('examples-row-0-target').props.value,'Human target')
  } finally { view.unmount() }
})

for (const action of ['replacement','clear','unmount','navigate']) test(`${action} retires source-bound row and download handlers`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); const actions = ['examples-row-0-copy','examples-row-0-approve','examples-row-0-remove-approval','examples-build','examples-export-jsonl','examples-export-review'].map(name=>handler(view,name))
    const oldInput = handler(view,'examples-row-0-target','onInput'); const slow = pendingFile(); await view.file(slow)
    if (action === 'replacement') { await view.file(reportFile(report(2))); await view.click('examples-use') }
    if (action === 'clear') await view.click('examples-clear')
    if (action === 'unmount') view.unmount()
    if (action === 'navigate') { await view.navigate('/'); await view.navigate('/prompt-examples') }
    for (const fn of actions) await invoke(fn)
    await invoke(oldInput,'STALE'); slow.resolve(report(9)); await flush()
    assert.equal(view.downloads.length, 0); assert.equal(view.byId('examples-bundle'), undefined); assert.equal(view.byId('examples-preview'), undefined)
    if (action === 'replacement') assert.equal(view.byId('examples-row-0-target').props.value,'')
    noRequests(view)
  } finally { if(action !== 'unmount') view.unmount() }
})

test('double-click handlers cannot silently reapprove, rebuild or redownload', async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view); await view.input('examples-row-0-target','Target'); const approveOnce = handler(view,'examples-row-0-approve')
    approveOnce({}); approveOnce({}); await flush(); assert.match(view.text(view.byId('examples-selected-count')), /^1 /)
    const buildOnce = handler(view,'examples-build'); buildOnce({}); await flush(); const download = handler(view,'examples-export-jsonl'); buildOnce({}); await flush()
    download({}); download({}); await flush(); assert.equal(view.downloads.length, 1)
    await view.click('examples-export-review'); assert.equal(view.downloads.length, 2)
  } finally { view.unmount() }
})

for (const downloadError of [true,'click']) test(`download error ${downloadError} keeps review bundle and cleans resources`, async () => {
  const view = await mountPromptExamplesView({ downloadError })
  try {
    await build(view); await view.click('examples-export-jsonl'); await view.click('examples-export-review')
    assert.ok(view.byId('examples-bundle')); assert.ok(view.byId('examples-export-error')); assert.equal(view.downloads.length,0)
    assert.equal(view.revokedUrls.length,downloadError === true ? 0 : 2); assert.equal(view.removedAnchors.length,downloadError === true ? 0 : 2)
    assert.doesNotMatch(view.text(), /Private URL failure|Private anchor failure/)
  } finally { view.unmount() }
})

test('export preparation failure preserves approved targets and disables downloads', async () => {
  const view = await mountPromptExamplesView({ examplesExportError: true })
  try {
    await build(view); assert.ok(view.byId('examples-row-0-remove-approval')); assert.ok(view.byId('examples-build-error'))
    assert.equal(view.byId('examples-bundle'),undefined); assert.doesNotMatch(view.text(),/Private export preparation failure/)
  } finally { view.unmount() }
})

test('one MiB imports and literal HTML prompts remain bounded historical text', async () => {
  const view = await mountPromptExamplesView()
  try {
    const literal = '<script>alert(1)</script>\r\n<think>e\u0301 🦙</think>'
    const source = JSON.stringify(report(1,{ item:{ system_prompt:literal,user_prompt:literal,expected_text:literal },reply:literal }))
    await view.file(reportFile(source + ' '.repeat(1048576-new TextEncoder().encode(source).length))); await view.click('examples-use')
    for(const key of ['reply','system-prompt','user-prompt','expected']) assert.equal(view.text(view.byId(`examples-row-0-${key}`)),literal)
    assert.equal(view.all(node=>node.type==='script').length,0); assert.equal(view.all(node=>node.props.innerHTML !== undefined).length,0)
    await view.click('examples-row-0-copy'); assert.equal(view.byId('examples-row-0-target').props.value,literal)
    assert.equal(view.byId('examples-row-0-reply-equal').props['data-equal'],true)
  } finally { view.unmount() }
})


test('a fresh build action can retry a transient export-preparation failure', async () => {
  let failure = true
  const view = await mountPromptExamplesView({ examplesExportError: () => failure })
  try {
    await build(view); assert.ok(view.byId('examples-build-error')); assert.equal(view.byId('examples-bundle'), undefined)
    failure = false
    await view.click('examples-build'); assert.ok(view.byId('examples-bundle')); assert.equal(view.byId('examples-build-error'), undefined)
  } finally { view.unmount() }
})

for (const reply of ['', '\u0000kept only as history']) test('a succeeded source with an invalid copied target still needs a valid human target', async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view, report(1, { reply })); await view.click('examples-row-0-copy')
    assert.equal(view.byId('examples-row-0-target').props.value, reply)
    assert.equal(view.text(view.byId('examples-row-0-reply')), reply)
    assert.ok(view.byId('examples-row-0-approve').props.disabled)
    assert.equal(view.text(view.byId('examples-row-0-approve')), 'Approve this target for export')
    await approve(view); await view.click('examples-build'); assert.ok(view.byId('examples-bundle'))
  } finally { view.unmount() }
})

for (const count of [0, 6]) test(`report with ${count} cases cannot replace accepted work`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view)
    const source = report(2)
    source.definition.cases = []; source.cases = []
    for (let index = 0; index < count; index++) {
      const other = report(index + 10, { item: { case_id: id(index + 100) } })
      source.definition.cases.push(other.definition.cases[0]); source.cases.push(other.cases[0])
    }
    await view.file(reportFile(source))
    assert.ok(view.byId('examples-import-error')); assert.ok(view.byId('examples-bundle'))
    assert.equal(view.byId('examples-row-0-target').props.value, 'Human target')
  } finally { view.unmount() }
})

test('all five explicitly approved cases are exported once in source order', async () => {
  const view = await mountPromptExamplesView()
  try {
    const source = report()
    for (let index = 1; index < 5; index++) {
      const other = report(index + 1, { item: { case_id: id(index + 100) } })
      source.definition.cases.push(other.definition.cases[0]); source.cases.push(other.cases[0])
    }
    await accept(view, source)
    for (let index = 4; index >= 0; index--) await approve(view, index, `Target ${index}`)
    await view.click('examples-build'); await view.click('examples-export-jsonl'); await view.click('examples-export-review')
    const lines = (await view.downloads[0].blob.text()).trimEnd().split('\n').map(JSON.parse)
    assert.deepEqual(lines.map(line => line.messages.at(-1).content), ['Target 0','Target 1','Target 2','Target 3','Target 4'])
    const review = JSON.parse(await view.downloads[1].blob.text())
    assert.equal(review.examples.length, 5); assert.deepEqual(review.examples.map(example => example.line_number), [1,2,3,4,5])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`v4 shows safe literal previews and independent historical/target failures in ${locale}`, async () => {
  const view = await mountPromptExamplesView({ locale })
  try {
    const required_fields = [{ name: 'answer', type: 'string', equals: '<b>ok</b>\u202e\u2028' }, { name: 'ready', type: 'boolean', equals: false }]
    const source = report(1, { version: 3, kind: 'json_fields', requiredFields: required_fields, reply: '{"answer":"old","ready":false}' })
    source.schema_version = 4; source.definition.schema_version = 4
    await view.file(reportFile(source))
    const expected = '"answer": string = "<b>ok</b>\\u202e\\u2028"\n"ready": boolean = false'
    assert.ok(view.byId('examples-preview-required-fields-0'), 'preview must disclose literal assertions before Use')
    assert.equal(view.text(view.byId('examples-preview-required-fields-0')), expected)
    await view.click('examples-use')
    assert.equal(view.text(view.byId('examples-row-0-required-fields')), expected)
    const recorded = view.byId('examples-row-0-recorded-failure'); assert.ok(recorded)
    assert.match(view.text(recorded), /"old"/)
    await view.input('examples-row-0-target', '{"answer":"new","ready":false}')
    assert.ok(view.byId('examples-row-0-target-failure')); assert.match(view.text(view.byId('examples-row-0-target-failure')), /"new"/)
    assert.match(view.text(view.byId('examples-row-0-recorded-failure')), /"old"/)
    await view.click('examples-row-0-approve'); await view.click('examples-build')
    await view.click('examples-export-review')
    const saved = JSON.parse(await view.downloads.at(-1).blob.text())
    assert.equal(saved.source_summary.schema_version, 4); assert.equal(saved.examples[0].target_check, 'mismatched')
    const staleApprove = handler(view, 'examples-row-0-remove-approval')
    await view.input('examples-row-0-target', JSON.stringify({ answer: required_fields[0].equals, ready: false }))
    await invoke(staleApprove)
    assert.equal(view.byId('examples-row-0-target-failure'), undefined); assert.ok(view.byId('examples-row-0-recorded-failure'))
    assert.equal(view.byId('examples-bundle'), undefined); assert.equal(view.byId('examples-row-0-remove-approval'), undefined)
    assert.equal(view.all(node => ['script', 'b'].includes(node.type) || node.props.innerHTML !== undefined).length, 0)
    assert.deepEqual(view.warnings, []); noRequests(view)
  } finally { view.unmount() }
})
