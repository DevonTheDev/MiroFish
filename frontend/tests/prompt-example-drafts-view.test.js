import assert from 'node:assert/strict'
import test from 'node:test'
import { mountPromptExamplesView, trialSnapshot, trialRequest, flush } from './helpers/prompt-examples-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const capturedAt = '2026-10-04T12:34:56Z'
const literal = '<script>alert(1)</script>\r\n<think>e\u0301 🦙</think>\t '
function report(n = 1, count = 3) {
  const definition = { schema_version: 1, kind: 'mirofish_local_prompt_suite', name: `Run ${n}`, cases: [] }, cases = []
  for (let index = 0; index < count; index++) {
    const item = { case_id: id(100 + index), ...trialRequest(), label: `Case ${index}`, system_prompt: `System ${index} ${literal}`, user_prompt: `User ${index} ${literal}`, expected_text: null }
    const snapshot = acceptPromptTrialSnapshot({ success: true, data: trialSnapshot('succeeded') })
    snapshot.run.request_id = id(1000 + index)
    snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, item[key]]))
    snapshot.run.response.content = `Reply ${index} ${literal}`
    definition.cases.push(item)
    cases.push({ case_id: item.case_id, request_id: snapshot.run.request_id, status: 'succeeded', check: 'not_requested', snapshot, error_code: null })
  }
  return { schema_version: 1, kind: 'mirofish_local_prompt_suite_run', run_id: id(n), definition,
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null, cases }
}
function draft(n = 2, targets = [literal, '', ' \r\n\t ']) {
  const source = report(n, targets.length)
  return { schema_version: 1, kind: 'mirofish_prompt_example_draft', captured_at: capturedAt, source_report: source,
    targets: source.definition.cases.map((item, index) => ({ case_id: item.case_id, target_text: targets[index] })) }
}
function file(source) {
  const bytes = new TextEncoder().encode(typeof source === 'string' ? source : JSON.stringify(source))
  return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }
}
function pendingFile() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { size: 100, arrayBuffer: () => promise, resolve: source => resolve(new TextEncoder().encode(JSON.stringify(source)).buffer), reject }
}
const handler = (view, name, type = 'onClick') => view.byId(name).props[type]
async function invoke(action, value) { action({ target: { value }, preventDefault() {}, stopPropagation() {}, button: 0 }); await flush() }
async function accept(view, source = report()) { await view.file(file(source)); assert.ok(view.byId('examples-preview')); await view.click('examples-use') }
async function build(view) {
  await accept(view); await view.input('examples-row-0-target', 'Approved target'); await view.click('examples-row-0-approve'); await view.click('examples-build')
}
function retained(view) {
  assert.match(view.text(view.byId('examples-accepted')), /Run 1/)
  assert.equal(view.byId('examples-row-0-target').props.value, 'Approved target')
  assert.ok(view.byId('examples-row-0-remove-approval')); assert.ok(view.byId('examples-bundle'))
}
function noRequests(view) { for (const calls of Object.values(view.requests.calls)) assert.equal(calls.length, 0) }

for (const cacheHandlers of [true, false]) for (const locale of ['en', 'zh']) test(`draft preview restores literal targets only after use (${locale}, cache ${cacheHandlers})`, async () => {
  const view = await mountPromptExamplesView({ locale, cacheHandlers })
  try {
    assert.ok(view.byId('examples-draft-file')); assert.ok(view.byId('examples-export-draft').props.disabled)
    await build(view); await view.draftFile(file(draft())); retained(view)
    const preview = view.byId('examples-preview')
    assert.equal(preview.props['data-kind'], 'draft'); assert.match(view.text(preview), new RegExp(capturedAt))
    assert.match(view.text(preview), locale === 'en' ? /Curation draft preview/ : /整理草稿预览/)
    assert.match(view.text(preview), new RegExp(id(2))); assert.match(view.text(preview), /2026-10-03T12:59:59Z/)
    assert.deepEqual(JSON.parse(view.text(view.byId('examples-preview-source'))), draft().source_report)
    for (let index = 0; index < 3; index++) {
      assert.equal(view.text(view.byId(`examples-preview-target-${index}`)), draft().targets[index].target_text)
      assert.equal(view.text(view.byId(`examples-preview-system-${index}`)), draft().source_report.definition.cases[index].system_prompt)
      assert.equal(view.text(view.byId(`examples-preview-user-${index}`)), draft().source_report.definition.cases[index].user_prompt)
      assert.equal(view.text(view.byId(`examples-preview-reply-${index}`)), draft().source_report.cases[index].snapshot.run.response.content)
    }
    assert.equal(view.all(node => node.type === 'script').length, 0); assert.equal(view.all(node => node.props.innerHTML !== undefined).length, 0)
    assert.match(view.text(view.byId('examples-use')), locale === 'en' ? /Use this draft/ : /使用此整理草稿/)
    await view.click('examples-use')
    for (let index = 0; index < 3; index++) {
      assert.equal(view.byId(`examples-row-${index}-target`).props.value, draft().targets[index].target_text)
      assert.equal(view.byId(`examples-row-${index}-remove-approval`), undefined)
    }
    assert.equal(view.byId('examples-bundle'), undefined); assert.ok(view.byId('examples-build').props.disabled)
    assert.match(view.text(view.byId('examples-row-2-target-error')), locale === 'en' ? /Approval requires nonblank text.*Curation drafts can retain empty or whitespace-only targets/ : /批准导出要求非空白文本.*整理草稿可保留空文本或仅含空白的目标/)
    assert.equal(view.downloads.length, 0); assert.equal(view.byId('examples-preview'), undefined)
    assert.match(view.text(view.byId('examples-draft-privacy')), locale === 'en' ? /ALL source prompts and replies.*ALL target drafts.*unapproved.*empty/ : /所有来源提示词和回复.*所有目标草稿.*未批准.*空白/)
    assert.match(view.text(view.byId('examples-draft-privacy')), locale === 'en' ? /No automatic saving or browser storage.*approved again/ : /不会自动保存或使用浏览器存储.*重新批准/)
    assert.deepEqual(view.warnings, []); assert.doesNotMatch(view.text(), /promptExamples\./); noRequests(view)
  } finally { view.unmount() }
})

for (const cacheHandlers of [true, false]) test(`routing away retires draft reads and downloads and returning has no automatic restoration (cache ${cacheHandlers})`, async () => {
  const view = await mountPromptExamplesView({ cacheHandlers })
  try {
    await view.draftFile(file(draft())); await view.click('examples-use'); await view.click('examples-row-0-approve'); await view.click('examples-build')
    const oldDownload = handler(view, 'examples-export-draft'), slow = pendingFile()
    await view.draftFile(slow); await view.navigate('/'); await view.navigate('/prompt-examples')
    slow.resolve(draft(9)); await invoke(oldDownload)
    assert.equal(view.byId('examples-accepted'), undefined); assert.equal(view.byId('examples-preview'), undefined)
    assert.equal(view.byId('examples-bundle'), undefined); assert.equal(view.downloads.length, 0); assert.deepEqual(view.downloadSteps, [])
    assert.ok(view.byId('examples-export-draft').props.disabled); noRequests(view)
  } finally { view.unmount() }
})

for (const method of ['file', 'draftFile']) test(`${method} picker cancellation invalidates an outstanding read of the other kind`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); const slow = pendingFile()
    await view[method === 'file' ? 'draftFile' : 'file'](slow); await view[method](null)
    slow.resolve(method === 'file' ? draft() : report(2)); await flush()
    retained(view); assert.equal(view.byId('examples-preview'), undefined); assert.equal(view.byId('examples-import-error'), undefined)
  } finally { view.unmount() }
})

test('downloading during a replacement preview captures only the accepted work and preserves both selections', async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); await view.draftFile(file(draft(2))); await view.click('examples-export-draft')
    const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.source_report.run_id, id(1)); assert.equal(saved.targets[0].target_text, 'Approved target')
    retained(view); assert.match(view.text(view.byId('examples-preview')), /Run 2/)
    await view.click('examples-use'); assert.equal(view.byId('examples-row-0-target').props.value, literal)
    assert.equal(view.byId('examples-row-0-remove-approval'), undefined)
  } finally { view.unmount() }
})

test('approval changes retire an unconsumed draft action even when target text is unchanged', async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view); await view.input('examples-row-0-target', 'Target')
    const beforeApproval = handler(view, 'examples-export-draft'); await view.click('examples-row-0-approve'); await invoke(beforeApproval)
    assert.equal(view.downloads.length, 0)
    const beforeRemoval = handler(view, 'examples-export-draft'); await view.click('examples-row-0-remove-approval'); await invoke(beforeRemoval)
    assert.equal(view.downloads.length, 0); assert.deepEqual(view.downloadSteps, [])
    await view.click('examples-export-draft'); assert.equal(view.downloads.length, 1)
  } finally { view.unmount() }
})

test('draft download includes every source and target while reviewed exports remain selected only', async () => {
  let text
  const view = await mountPromptExamplesView()
  try {
    await build(view); await view.input('examples-row-2-target', ' \t\r\n ')
    await view.click('examples-build'); await view.click('examples-export-jsonl'); await view.click('examples-export-review')
    const reviewedJsonl = await view.downloads[0].blob.text(), review = await view.downloads[1].blob.text()
    assert.equal(reviewedJsonl.trimEnd().split('\n').length, 1); assert.doesNotMatch(review, /System 1|Reply 1|System 2|Reply 2/)
    await view.click('examples-export-draft'); assert.ok(view.byId('examples-bundle')); assert.ok(view.byId('examples-row-0-remove-approval'))
    const download = view.downloads[2]; text = await download.blob.text()
    const saved = JSON.parse(text)
    assert.equal(download.filename, 'prompt_example_curation.draft.json')
    assert.deepEqual(Object.keys(saved).sort(), ['schema_version','kind','captured_at','source_report','targets'].sort())
    assert.deepEqual(saved.source_report, report()); assert.deepEqual(saved.targets.map(row => row.target_text), ['Approved target', '', ' \t\r\n '])
    assert.deepEqual(saved.targets.map(row => Object.keys(row).sort()), Array.from({ length: 3 }, () => ['case_id','target_text']))
    assert.doesNotMatch(text, /reviewed_at|approved|selected|target_check/)
    assert.equal(view.revokedUrls.length, 3); assert.equal(view.removedAnchors.length, 3); noRequests(view)
  } finally { view.unmount() }
  const fresh = await mountPromptExamplesView()
  try {
    assert.equal(fresh.byId('examples-accepted'), undefined)
    await fresh.draftFile(file(text)); await fresh.click('examples-use')
    assert.ok(fresh.byId('examples-build').props.disabled); assert.equal(fresh.byId('examples-row-0-remove-approval'), undefined)
    await fresh.click('examples-row-0-approve'); await fresh.click('examples-build'); await fresh.click('examples-export-jsonl')
    assert.equal(JSON.parse(await fresh.downloads[0].blob.text()).messages.at(-1).content, 'Approved target')
    assert.equal(fresh.byId('examples-row-1-target').props.value, ''); assert.equal(fresh.byId('examples-row-2-target').props.value, ' \t\r\n ')
    noRequests(fresh)
  } finally { fresh.unmount() }
})

for (const cacheHandlers of [true, false]) test(`report and draft reads share cancellation and use ownership (cache ${cacheHandlers})`, async () => {
  const view = await mountPromptExamplesView({ cacheHandlers })
  try {
    await build(view)
    const slowReport = pendingFile(); await view.file(slowReport)
    await view.draftFile(file(draft(2))); const oldUse = handler(view, 'examples-use'), oldCancel = handler(view, 'examples-cancel')
    const oldDraftRead = handler(view, 'examples-draft-file', 'onChange'), oldReportRead = handler(view, 'examples-file', 'onChange')
    await view.file(file(report(3))); oldUse({}); oldCancel({})
    oldDraftRead({ target: { files: [file(draft(4))], value: 'stale' } }); oldReportRead({ target: { files: [file(report(5))], value: 'stale' } })
    slowReport.reject(new Error('Obsolete report read')); await flush()
    assert.match(view.text(view.byId('examples-preview')), /Run 3/); assert.equal(view.byId('examples-preview').props['data-kind'], 'report'); retained(view)
    const slowDraft = pendingFile(); await view.draftFile(slowDraft); await view.file(null); slowDraft.resolve(draft(9)); await flush()
    assert.equal(view.byId('examples-preview'), undefined); retained(view)
    await view.draftFile(file(draft())); await view.click('examples-cancel'); retained(view)
    const slowAfterDraft = pendingFile(); await view.draftFile(slowAfterDraft); await view.file(file(report(6))); await view.click('examples-use')
    slowAfterDraft.resolve(draft(9)); await flush()
    assert.match(view.text(view.byId('examples-accepted')), /Run 6/); assert.equal(view.byId('examples-row-0-target').props.value, ''); assert.equal(view.byId('examples-preview'), undefined)
    assert.equal(view.byId('examples-import-error'), undefined); noRequests(view)
  } finally { view.unmount() }
})

for (const failure of ['malformed','review format','approval metadata','invalid target','bad UTF-8','BOM','read failure','oversize before','oversize after','non-buffer']) test(`invalid draft ${failure} preserves current approvals and bundle`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); let input = file(draft()), reads = 0
    if (failure === 'malformed') input = file('{')
    if (failure === 'review format') input = file({ ...draft(), kind: 'mirofish_reviewed_prompt_examples' })
    if (failure === 'approval metadata') input = file({ ...draft(), approvals: [] })
    if (failure === 'invalid target') input = file(draft(2, ['\u0000']))
    if (failure === 'bad UTF-8') input = { size: 2, arrayBuffer: async () => Uint8Array.from([0xc0, 0xaf]).buffer }
    if (failure === 'BOM') input = file('\ufeff' + JSON.stringify(draft()))
    if (failure === 'read failure') input = { size: 10, arrayBuffer: async () => { throw new Error('PRIVATE DRAFT ERROR') } }
    if (failure.startsWith('oversize')) input = { size: failure === 'oversize before' ? 4194305 : 10, arrayBuffer: async () => { reads++; return new ArrayBuffer(4194305) } }
    if (failure === 'non-buffer') input = { size: 10, arrayBuffer: async () => new Uint8Array(10) }
    await view.draftFile(input); retained(view)
    assert.ok(view.byId('examples-import-error')); assert.equal(view.byId('examples-preview'), undefined)
    assert.equal(view.byId('examples-draft-export-error'), undefined); assert.equal(view.byId('examples-export-error'), undefined)
    assert.doesNotMatch(view.text(), /PRIVATE DRAFT ERROR/)
    if (failure === 'oversize before') assert.equal(reads, 0)
  } finally { view.unmount() }
})

test('draft files permit four MiB while report files retain their one MiB limit', async () => {
  const view = await mountPromptExamplesView()
  try {
    const text = JSON.stringify(draft()), padded = text + ' '.repeat(4194304 - new TextEncoder().encode(text).length)
    await view.draftFile(file(padded)); assert.ok(view.byId('examples-preview')); await view.click('examples-use')
    let reads = 0
    await view.file({ size: 1048577, arrayBuffer: async () => { reads++; return new ArrayBuffer(0) } })
    assert.equal(reads, 0); assert.ok(view.byId('examples-import-error')); assert.equal(view.byId('examples-row-0-target').props.value, literal)
  } finally { view.unmount() }
})

for (const cacheHandlers of [true, false]) test(`draft download retires on row ABA, source replacement, clear and unmount (cache ${cacheHandlers})`, async () => {
  const view = await mountPromptExamplesView({ cacheHandlers })
  try {
    await accept(view); await view.input('examples-row-0-target', 'A')
    const oldDownload = handler(view, 'examples-export-draft'), edit = handler(view, 'examples-row-0-target', 'onInput')
    edit({ target: { value: 'B' } }); oldDownload({}); await flush(); await view.input('examples-row-0-target', 'A'); await invoke(oldDownload)
    assert.equal(view.downloads.length, 0); assert.deepEqual(view.downloadSteps, [])
    const oldSource = handler(view, 'examples-export-draft'); await view.draftFile(file(draft())); await view.click('examples-use'); await invoke(oldSource)
    assert.equal(view.downloads.length, 0)
    const once = handler(view, 'examples-export-draft'); once({}); once({}); await flush(); assert.equal(view.downloads.length, 1)
    const beforeClear = handler(view, 'examples-export-draft'); await view.click('examples-clear'); await invoke(beforeClear); assert.equal(view.downloads.length, 1)
    await accept(view); const beforeUnmount = handler(view, 'examples-export-draft'); const pending = pendingFile(); await view.draftFile(pending)
    view.unmount(); await invoke(beforeUnmount); pending.resolve(draft()); await flush(); assert.equal(view.downloads.length, 1)
  } finally { if (view.byId('examples-file')) view.unmount() }
})

for (const value of ['', ' \r\n\t ']) test(`empty or whitespace target can be explicitly downloaded without approval: ${JSON.stringify(value)}`, async () => {
  const view = await mountPromptExamplesView()
  try {
    await accept(view); await view.input('examples-row-0-target', value); assert.ok(view.byId('examples-build').props.disabled)
    await view.click('examples-export-draft'); assert.equal(JSON.parse(await view.downloads[0].blob.text()).targets[0].target_text, value)
  } finally { view.unmount() }
})

for (const value of ['\u0000', '\ud800', 'x'.repeat(16385)]) test('invalid draft target refuses the entire export without losing work', async () => {
  const view = await mountPromptExamplesView()
  try {
    await build(view); await view.input('examples-row-1-target', value); await view.click('examples-build')
    await view.click('examples-export-draft')
    assert.ok(view.byId('examples-draft-export-error')); assert.ok(view.byId('examples-bundle')); assert.ok(view.byId('examples-row-0-remove-approval'))
    assert.equal(view.byId('examples-row-1-target').props.value, value); assert.equal(view.downloads.length, 0); assert.deepEqual(view.downloadSteps, [])
    await view.input('examples-row-1-target', ''); assert.equal(view.byId('examples-draft-export-error'), undefined)
    await view.click('examples-export-draft'); assert.equal(view.downloads.length, 1)
  } finally { view.unmount() }
})

test('draft preparation error is independent, private, retained on cancel and retryable on a fresh click', async () => {
  let failure = true
  const view = await mountPromptExamplesView({ draftExportError: () => failure, downloadError: 'click' })
  try {
    await build(view); await view.click('examples-export-jsonl'); await view.click('examples-export-draft'); await view.draftFile(file('{'))
    for (const name of ['examples-import-error', 'examples-export-error', 'examples-draft-export-error']) assert.ok(view.byId(name))
    assert.equal(view.byId('examples-build-error'), undefined); retained(view)
    assert.doesNotMatch(view.text(), /Private draft preparation failure|Private anchor failure/)
    await view.draftFile(file(draft())); await view.click('examples-cancel'); assert.ok(view.byId('examples-draft-export-error'))
    await view.draftFile(file(draft())); await view.click('examples-use'); assert.equal(view.byId('examples-draft-export-error'), undefined)
    await view.click('examples-export-draft'); assert.ok(view.byId('examples-draft-export-error')); await view.click('examples-clear'); assert.equal(view.byId('examples-draft-export-error'), undefined)
  } finally { view.unmount() }
  const retry = await mountPromptExamplesView({ draftExportError: () => failure })
  try {
    await accept(retry); const old = handler(retry, 'examples-export-draft'); await invoke(old); assert.ok(retry.byId('examples-draft-export-error'))
    failure = false; await invoke(old); assert.equal(retry.downloads.length, 0)
    await retry.click('examples-export-draft'); assert.equal(retry.downloads.length, 1); assert.equal(retry.byId('examples-draft-export-error'), undefined)
  } finally { retry.unmount() }
})

for (const stage of ['prepare','blob','url','anchor','append']) test(`draft source changes during ${stage} prevent subsequent allocation or download`, async () => {
  let edit
  const mutate = () => { edit({ target: { value: 'Changed during download' } }); return false }
  const view = await mountPromptExamplesView(stage === 'prepare' ? { draftExportError: mutate } : { downloadHooks: { [stage]: mutate } })
  try {
    await accept(view); edit = handler(view, 'examples-row-0-target', 'onInput'); await view.click('examples-export-draft')
    assert.equal(view.downloads.length, 0); assert.equal(view.byId('examples-row-0-target').props.value, 'Changed during download')
    const allocations = view.downloadSteps.filter(step => !['remove','revoke'].includes(step))
    assert.deepEqual(allocations, ['prepare','blob','url','anchor','append'].slice(1, ['prepare','blob','url','anchor','append'].indexOf(stage) + 1))
    assert.equal(view.revokedUrls.length, ['url','anchor','append'].includes(stage) ? 1 : 0)
    assert.equal(view.removedAnchors.length, ['anchor','append'].includes(stage) ? 1 : 0)
    assert.equal(view.byId('examples-draft-export-error'), undefined)
  } finally { view.unmount() }
})

for (const stage of ['blob','url','anchor','append','click','remove','revoke']) test(`draft ${stage} failure cleans resources, retains work and allows explicit retry`, async () => {
  let fail = true
  const view = await mountPromptExamplesView({ downloadHooks: { [stage]: () => { if (fail) throw new Error('PRIVATE DOWNLOAD FAILURE') } } })
  try {
    await build(view); await view.click('examples-export-draft'); retained(view)
    assert.ok(view.byId('examples-draft-export-error')); assert.equal(view.byId('examples-export-error'), undefined)
    assert.equal(view.downloads.length, ['remove','revoke'].includes(stage) ? 1 : 0)
    assert.match(view.text(view.byId('examples-draft-export-error')), /could not be completed.*Check your downloads before retrying.*a file may already have been saved/)
    assert.doesNotMatch(view.text(), /PRIVATE DOWNLOAD FAILURE/)
    assert.equal(view.revokedUrls.length, ['blob','url'].includes(stage) ? 0 : 1)
    assert.equal(view.removedAnchors.length, ['blob','url','anchor'].includes(stage) ? 0 : 1)
    fail = false; const prior = view.downloads.length; await view.click('examples-export-draft')
    assert.equal(view.downloads.length, prior + 1); assert.equal(view.byId('examples-draft-export-error'), undefined)
  } finally { view.unmount() }
})
