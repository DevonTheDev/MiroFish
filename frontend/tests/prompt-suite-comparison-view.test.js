import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuiteComparison, trialSnapshot, trialRequest, flush } from './helpers/prompt-suite-comparison-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'
import { evaluatePromptSuiteCheck } from '../src/utils/promptSuites.js'

export const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
export function report(n = 1, options = {}) {
  const item = { case_id: id(100), ...trialRequest(), expected_text: null, ...options.item }
  const snapshot = acceptPromptTrialSnapshot({ success: true, data: trialSnapshot('succeeded') })
  snapshot.run.request_id = id(n + 20)
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, item[key]]))
  Object.assign(snapshot.run, options.run)
  if (options.reply !== undefined) snapshot.run.response.content = options.reply
  return { schema_version: 1, kind: 'mirofish_local_prompt_suite_run', run_id: id(n),
    definition: { schema_version: 1, kind: 'mirofish_local_prompt_suite', name: `Run ${n}`, cases: [item] },
    started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
    cases: [{ case_id: item.case_id, request_id: snapshot.run.request_id, status: 'succeeded',
      check: item.expected_text === null ? 'not_requested' : item.expected_text === snapshot.run.response.content ? 'matched' : 'mismatched', snapshot, error_code: null }] }
}
export function reportFile(source) {
  const bytes = new TextEncoder().encode(typeof source === 'string' ? source : JSON.stringify(source))
  return { name: 'report.json', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }
}
async function accept(view, side, source) {
  await view.file(side, reportFile(source)); assert.ok(view.byId(`comparison-${side}-preview`))
  await view.click(`comparison-${side}-use`)
}
async function compare(view, baseline = report(1), comparison = report(2)) {
  await accept(view, 'baseline', baseline); await accept(view, 'comparison', comparison); await view.click('comparison-run')
}
function noRequests(view) { for (const calls of Object.values(view.requests.calls)) assert.equal(calls.length, 0) }
for (const locale of ['en', 'zh']) test(`comparison is discoverable and imports/compares/downloads offline in ${locale}`, async () => {
  const view = await mountSuiteComparison({ locale })
  try {
    assert.ok(view.byId('comparison-baseline-file')); assert.ok(view.byId('comparison-run').props.disabled); noRequests(view)
    await view.file('baseline', reportFile(report(1))); assert.ok(view.byId('comparison-baseline-preview'))
    assert.equal(view.byId('comparison-baseline-accepted'), undefined); assert.ok(view.byId('comparison-run').props.disabled)
    await view.click('comparison-baseline-use'); await accept(view, 'comparison', report(2)); await view.click('comparison-run')
    assert.ok(view.byId('comparison-result')); assert.match(view.text(view.byId('comparison-row-0')), /Trial one/)
    await view.click('comparison-export-json'); await view.click('comparison-export-txt')
    const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.kind, 'mirofish_local_prompt_suite_comparison'); assert.equal(saved.baseline.run_id, id(1)); assert.equal(saved.comparison.run_id, id(2))
    assert.equal(saved.rows[0].paired_succeeded, true); assert.equal(saved.rows[0].request_duration_delta_ms, 0)
    assert.ok((await view.downloads[1].blob.text()).includes(id(100))); assert.equal(view.revokedUrls.length, 2); assert.equal(view.removedAnchors.length, 2)
    assert.deepEqual(view.warnings, []); noRequests(view)
    await view.navigate('/prompt-suites')
    const link = view.find(node => node.type === 'a' && node.props.href === '/prompt-suite-comparison'); assert.ok(link)
    await view.navigate('/prompt-suite-comparison'); assert.equal(view.byId('comparison-result'), undefined)
  } finally { view.unmount() }
})

function pendingFile() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { name: 'pending.json', size: 100, arrayBuffer: () => promise, resolve: source => resolve(new TextEncoder().encode(JSON.stringify(source)).buffer), reject }
}
const handler = (view, id) => view.byId(id).props.onClick
async function invoke(action) { action({ preventDefault() {}, stopPropagation() {}, button: 0 }); await flush() }

for (const failure of ['malformed', 'duplicate root', 'escaped duplicate', 'nested duplicate', 'too deep', 'unsupported kind', 'invalid identity', 'bad UTF-8', 'BOM', 'read error', 'oversize before', 'oversize after', 'text-only file']) test(`bad ${failure} replacement preserves accepted reports and historical capture`, async () => {
  const view = await mountSuiteComparison()
  try {
    await compare(view); await view.click('comparison-export-json')
    const original = await view.downloads[0].blob.text()
    let file = reportFile(report(3)), reads = 0
    if (failure === 'malformed') file = reportFile('{')
    if (failure === 'duplicate root') file = reportFile(JSON.stringify(report(3)).replace('"schema_version":1', '"schema_version":1,"schema_version":1'))
    if (failure === 'escaped duplicate') file = reportFile(JSON.stringify(report(3)).replace('"run_id":', '"run_id":"'+id(3)+'","run_\\u0069d":'))
    if (failure === 'nested duplicate') file = reportFile(JSON.stringify(report(3)).replace('"model":"local-chat"', '"model":"local-chat","model":"different"'))
    if (failure === 'too deep') file = reportFile('['.repeat(13)+']'.repeat(13))
    if (failure === 'unsupported kind') file = reportFile({ ...report(3), kind: 'mirofish_local_prompt_suite_comparison' })
    if (failure === 'invalid identity') { const value = report(3); value.cases[0].request_id = id(999); file = reportFile(value) }
    if (failure === 'bad UTF-8') file = { size: 2, arrayBuffer: async () => Uint8Array.from([0xc0, 0xaf]).buffer }
    if (failure === 'BOM') file = reportFile('\ufeff'+JSON.stringify(report(3)))
    if (failure === 'read error') file = { size: 10, arrayBuffer: async () => { throw new Error('PRIVATE FILE ERROR') } }
    if (failure.startsWith('oversize')) file = { size: failure === 'oversize before' ? 1048577 : 10, arrayBuffer: async () => { reads++; return new ArrayBuffer(1048577) } }
    if (failure === 'text-only file') file = { size: 10, text: async () => JSON.stringify(report(3)) }
    await view.file('baseline', file)
    assert.ok(view.byId('comparison-baseline-error')); assert.ok(view.byId('comparison-baseline-retained'))
    assert.equal(view.byId('comparison-baseline-preview'), undefined)
    assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 1/); assert.ok(view.byId('comparison-result'))
    assert.doesNotMatch(view.text(), /PRIVATE FILE ERROR/)
    await view.click('comparison-export-json'); assert.equal(await view.downloads[1].blob.text(), original)
    if (failure === 'oversize before') assert.equal(reads, 0)
    if (failure === 'oversize after') assert.equal(reads, 1)
    noRequests(view)
  } finally { view.unmount() }
})

test('independent reads and preview generations reject old errors, old use and cancel handlers', async () => {
  const view = await mountSuiteComparison()
  try {
    const slow = pendingFile(); await view.file('baseline', slow)
    await view.file('comparison', reportFile(report(2))); await view.click('comparison-comparison-use')
    assert.match(view.text(view.byId('comparison-comparison-accepted')), /Run 2/)
    await view.file('baseline', reportFile(report(1)))
    const staleUse = handler(view, 'comparison-baseline-use'), staleCancel = handler(view, 'comparison-baseline-cancel')
    await view.file('baseline', reportFile(report(3)))
    await invoke(staleUse); await invoke(staleCancel)
    assert.equal(view.byId('comparison-baseline-accepted'), undefined); assert.match(view.text(view.byId('comparison-baseline-preview')), /Run 3/)
    slow.reject(new Error('PRIVATE STALE')); await flush()
    assert.equal(view.byId('comparison-baseline-error'), undefined)
    await view.click('comparison-baseline-use'); assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 3/)
    const cancelled = pendingFile(); await view.file('baseline', cancelled); await view.click('comparison-baseline-cancel')
    cancelled.resolve(report(4)); await flush(); assert.equal(view.byId('comparison-baseline-preview'), undefined)
    const selectionCancelled = pendingFile(); await view.file('baseline', selectionCancelled); await view.file('baseline', null)
    selectionCancelled.resolve(report(5)); await flush(); assert.equal(view.byId('comparison-baseline-preview'), undefined)
    assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 3/); noRequests(view)
  } finally { view.unmount() }
})

test('unaccepted previews and canceled replacements preserve fixed comparison downloads', async () => {
  const view = await mountSuiteComparison()
  try {
    const source = report(1)
    await compare(view, source); await view.click('comparison-export-json')
    const original = await view.downloads[0].blob.text()
    source.definition.name = 'Mutated external input'; source.cases[0].snapshot.run.response.content = 'Mutated external reply'
    await view.file('baseline', reportFile(report(3)))
    assert.ok(view.byId('comparison-result')); await view.click('comparison-export-json')
    assert.equal(await view.downloads[1].blob.text(), original)
    await view.click('comparison-baseline-cancel'); await view.click('comparison-export-json')
    assert.equal(await view.downloads[2].blob.text(), original); assert.doesNotMatch(view.text(), /Mutated external/)
  } finally { view.unmount() }
})

for (const action of ['use', 'clear', 'swap', 'unmount']) test(`${action} retires pending reads and queued actions without replacing newer results`, async () => {
  const view = await mountSuiteComparison()
  try {
    await compare(view)
    const staleCompare = handler(view, 'comparison-run'), staleJson = handler(view, 'comparison-export-json'), staleTxt = handler(view, 'comparison-export-txt')
    await view.file('baseline', reportFile(report(3))); const staleUse = handler(view, 'comparison-baseline-use')
    const slow = pendingFile(); await view.file('comparison', slow)
    if (action === 'use') await view.click('comparison-baseline-use')
    if (action === 'clear') await view.click('comparison-baseline-clear')
    if (action === 'swap') await view.click('comparison-swap')
    if (action === 'unmount') view.unmount()
    await invoke(staleCompare); await invoke(staleJson); await invoke(staleTxt); await invoke(staleUse)
    assert.equal(view.downloads.length, 0); assert.equal(view.byId('comparison-result'), undefined)
    slow.resolve(report(4)); await flush()
    // Accepting one slot leaves the other slot's independent read alive; clear only affects its own slot.
    if (['swap', 'unmount'].includes(action)) assert.equal(view.byId('comparison-comparison-preview'), undefined)
    else assert.match(view.text(view.byId('comparison-comparison-preview')), /Run 4/)
    if (action === 'use') assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 3/)
    if (action === 'swap') { assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 2/); assert.match(view.text(view.byId('comparison-comparison-accepted')), /Run 1/) }
    noRequests(view)
  } finally { if (action !== 'unmount') view.unmount() }
})

test('clearing a reading slot invalidates its late read and preview action', async () => {
  const view = await mountSuiteComparison()
  try {
    await view.file('baseline', reportFile(report(1))); const staleUse = handler(view, 'comparison-baseline-use')
    const slow = pendingFile(); await view.file('baseline', slow); await view.click('comparison-baseline-clear')
    slow.resolve(report(2)); await invoke(staleUse)
    assert.equal(view.byId('comparison-baseline-preview'), undefined); assert.equal(view.byId('comparison-baseline-accepted'), undefined)
    assert.ok(view.byId('comparison-run').props.disabled)
  } finally { view.unmount() }
})

test('same run IDs are rejected, while same request IDs remain inspectable but ineligible', async () => {
  const view = await mountSuiteComparison()
  try {
    await accept(view, 'baseline', report(1)); await accept(view, 'comparison', report(1))
    assert.ok(view.byId('comparison-run').props.disabled); assert.ok(view.byId('comparison-same-run'))
    const second = report(2); second.cases[0].request_id = id(21); second.cases[0].snapshot.run.request_id = id(21)
    await accept(view, 'comparison', second); await view.click('comparison-run')
    assert.equal(view.byId('comparison-row-0').props['data-paired'], false); assert.ok(view.byId('comparison-row-0-request-id-overlap'))
    assert.equal(view.text(view.byId('comparison-row-0-delta')), 'Not comparable'); assert.equal(view.text(view.byId('comparison-row-0-reply-equal')), 'Not comparable')
    assert.equal(view.text(view.byId('comparison-row-0-comparison-reply')), 'Hello back')
  } finally { view.unmount() }
})

for (const locale of ['en','zh']) test(`literal empty/Unicode replies, null and zero, changed inputs and mixed configurations render in ${locale}`, async () => {
  const view = await mountSuiteComparison({ locale })
  try {
    const first = report(1, { item: { expected_text: '' }, reply: '', run: { request_duration_ms: 0, elapsed_ms: 0 } })
    const literal = '<script>alert(1)</script>\r\n<think>Å\t🦙</think>\u202e'
    const second = report(2, { item: { expected_text: '' }, reply: literal, run: { request_duration_ms: null } })
    await compare(view, first, second)
    assert.equal(view.text(view.byId('comparison-row-0-baseline-reply')), ''); assert.equal(view.text(view.byId('comparison-row-0-comparison-reply')), literal)
    assert.equal(view.all(node => node.type === 'script').length, 0); assert.equal(view.text(view.byId('comparison-row-0-baseline-expected')), '')
    assert.equal(view.text(view.byId('comparison-row-0-baseline-request-duration')), '0'); assert.equal(view.text(view.byId('comparison-row-0-baseline-elapsed')), '0')
    assert.equal(view.text(view.byId('comparison-row-0-comparison-request-duration')), locale === 'en' ? 'Not reported' : '未报告')
    assert.equal(view.text(view.byId('comparison-row-0-delta')), locale === 'en' ? 'Not comparable' : '不可比较')
    assert.equal(view.text(view.byId('comparison-row-0-transition')), locale === 'en' ? 'Lost exact match' : '失去精确匹配')
    second.definition.cases[0].expected_text = null; second.cases[0].check = 'not_requested'
    const other = report(9, { item: { case_id: id(101), label: 'Other' }, run: { configuration: { model: 'other-local-model', reasoning_effort: 'low' } } })
    second.definition.cases.push(other.definition.cases[0]); second.cases.push(other.cases[0])
    await accept(view, 'comparison', second); await view.click('comparison-run')
    assert.ok(view.byId('comparison-row-0-changed-inputs')); assert.equal(view.byId('comparison-row-0').props['data-paired'], false)
    assert.ok(view.byId('comparison-comparison-mixed')); assert.equal(view.byId('comparison-row-1').props['data-membership'], 'added')
    assert.deepEqual(view.warnings, []); noRequests(view)
  } finally { view.unmount() }
})

for (const status of ['unknown', 'rejected', 'not_attempted', 'truncated', 'refused', 'succeeded']) test(`partial/reconciled report preserves ${status} and inapplicable observations`, async () => {
  const view = await mountSuiteComparison()
  try {
    const source = report(2); source.status = 'halted'; source.halt_code = 'runtime_failed'; source.cases[0].status = status
    if (status !== 'succeeded') source.cases[0].check = 'not_evaluated'
    if (['rejected','not_attempted'].includes(status)) source.cases[0].snapshot = null
    if (status === 'not_attempted') source.cases[0].request_id = null
    if (status === 'unknown') {
      source.cases[0].snapshot.run.state = 'running'; source.cases[0].snapshot.run.finished_at = null
      source.cases[0].snapshot.run.request_duration_ms = null; source.cases[0].snapshot.run.response = null
      source.cases[0].snapshot.run.cleanup = { state: 'pending', duration_ms: null }
    }
    if (status === 'truncated') { source.cases[0].snapshot.run.state = status; source.cases[0].snapshot.run.response.finish_reason = 'length' }
    if (status === 'refused') { source.cases[0].snapshot.run.state = status; source.cases[0].snapshot.run.response = { content: null, refusal: '<b>no</b>', finish_reason: 'content_filter', usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } } }
    await compare(view, report(1), source)
    assert.match(view.text(view.byId('comparison-comparison-configuration')), /Halted/)
    assert.equal(view.byId('comparison-row-0').props['data-paired'], status === 'succeeded')
    if (status === 'succeeded') assert.equal(view.text(view.byId('comparison-row-0-delta')), '0')
    else assert.equal(view.text(view.byId('comparison-row-0-delta')), 'Not comparable')
    if (['rejected','not_attempted'].includes(status)) assert.equal(view.text(view.byId('comparison-row-0-comparison-model')), 'Not reported')
    if (status === 'refused') assert.equal(view.text(view.byId('comparison-row-0-comparison-refusal')), '<b>no</b>')
  } finally { view.unmount() }
})

for (const downloadError of [true, 'click']) test(`download failure ${downloadError} keeps the capture and cleans created resources`, async () => {
  const view = await mountSuiteComparison({ downloadError })
  try {
    await compare(view); await view.click('comparison-export-json'); await view.click('comparison-export-txt')
    assert.ok(view.byId('comparison-export-error')); assert.ok(view.byId('comparison-result')); assert.equal(view.downloads.length, 0)
    assert.equal(view.revokedUrls.length, downloadError === true ? 0 : 2); assert.equal(view.removedAnchors.length, downloadError === true ? 0 : 2)
    assert.doesNotMatch(view.text(), /Private URL failure|Private anchor failure/); noRequests(view)
  } finally { view.unmount() }
})

test('case membership and relative order use exact identities and preserve comparison order', async () => {
  const view = await mountSuiteComparison()
  try {
    const left = report(1), right = report(2)
    const add = (target, n, caseId, label) => {
      const row = report(n, { item: { case_id: id(caseId), label } })
      target.definition.cases.push(row.definition.cases[0]); target.cases.push(row.cases[0])
    }
    add(left, 3, 101, 'Shared second'); add(left, 4, 102, 'Removed only')
    add(right, 5, 101, 'Renamed shared second'); add(right, 6, 103, 'Added only')
    right.definition.cases = [right.definition.cases[1], right.definition.cases[2], right.definition.cases[0]]
    right.cases = [right.cases[1], right.cases[2], right.cases[0]]
    await compare(view, left, right)
    assert.ok(view.byId('comparison-order-changed')); assert.ok(view.byId('comparison-name-changed'))
    assert.deepEqual([0,1,2,3].map(index => view.byId(`comparison-row-${index}`).props['data-case-id']), [id(101), id(103), id(100), id(102)])
    assert.deepEqual([0,1,2,3].map(index => view.byId(`comparison-row-${index}`).props['data-membership']), ['shared','added','shared','removed'])
    assert.match(view.text(view.byId('comparison-row-0')), /Position: baseline 2 → comparison 1/)
    assert.match(view.text(view.byId('comparison-row-0')), /case label changed/)
    assert.equal(view.byId('comparison-row-0').props['data-paired'], true)
    assert.match(view.text(view.byId('comparison-row-3')), /Position: baseline 3 → comparison Absent/)
  } finally { view.unmount() }
})

test('queued downloads cannot export a newer capture and queued swap cannot exchange newer slots', async () => {
  const view = await mountSuiteComparison()
  try {
    await compare(view); const oldJson = handler(view, 'comparison-export-json'), oldTxt = handler(view, 'comparison-export-txt'), oldSwap = handler(view, 'comparison-swap')
    await accept(view, 'baseline', report(3)); await view.click('comparison-run')
    await invoke(oldJson); await invoke(oldTxt); await invoke(oldSwap)
    assert.equal(view.downloads.length, 0); assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 3/)
    await view.click('comparison-export-json'); const saved = JSON.parse(await view.downloads[0].blob.text()); assert.equal(saved.baseline.run_id, id(3))
  } finally { view.unmount() }
})

test('navigating away retires both read promises and old page actions', async () => {
  const view = await mountSuiteComparison()
  try {
    await compare(view); const oldCompare = handler(view, 'comparison-run'), oldDownload = handler(view, 'comparison-export-json')
    const baseline = pendingFile(), comparison = pendingFile()
    await view.file('baseline', baseline); await view.file('comparison', comparison)
    await view.navigate('/'); await view.navigate('/prompt-suite-comparison')
    baseline.resolve(report(8)); comparison.reject(new Error('PRIVATE AFTER NAVIGATION'))
    await invoke(oldCompare); await invoke(oldDownload)
    assert.equal(view.byId('comparison-result'), undefined); assert.equal(view.byId('comparison-baseline-preview'), undefined)
    assert.equal(view.byId('comparison-comparison-error'), undefined); assert.equal(view.downloads.length, 0); noRequests(view)
  } finally { view.unmount() }
})

test('import byte bound accepts exactly 1 MiB without silently normalizing report data', async () => {
  const view = await mountSuiteComparison()
  try {
    const source = JSON.stringify(report(1)), content = source + ' '.repeat(1048576 - new TextEncoder().encode(source).length)
    await view.file('baseline', reportFile(content)); assert.ok(view.byId('comparison-baseline-preview'))
    await view.click('comparison-baseline-use'); assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 1/)
  } finally { view.unmount() }
})

test('a request ID reused under another case is visibly excluded from paired findings', async () => {
  const view = await mountSuiteComparison()
  try {
    const baseline = report(1), comparison = report(2)
    const other = report(3, { item: { case_id: id(101), label: 'Different case' } })
    other.cases[0].request_id = baseline.cases[0].request_id; other.cases[0].snapshot.run.request_id = baseline.cases[0].request_id
    comparison.definition.cases.push(other.definition.cases[0]); comparison.cases.push(other.cases[0])
    await compare(view, baseline, comparison)
    assert.ok(view.byId('comparison-row-0-request-id-overlap'))
    assert.equal(view.byId('comparison-row-0').props['data-paired'], false)
    assert.equal(view.text(view.byId('comparison-row-0-delta')), 'Not comparable')
    await view.click('comparison-export-json'); const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.rows[0].request_id_overlap, true); assert.equal(saved.summary.overlapping_request_pairs, 1)
  } finally { view.unmount() }
})

test('export preparation failure retains the valid comparison and disables unavailable downloads', async () => {
  const view = await mountSuiteComparison({ comparisonExportError: true })
  try {
    await compare(view)
    assert.ok(view.byId('comparison-result')); assert.ok(view.byId('comparison-export-error'))
    assert.ok(view.byId('comparison-export-json').props.disabled); assert.ok(view.byId('comparison-export-txt').props.disabled)
    assert.equal(view.text(view.byId('comparison-row-0-comparison-reply')), 'Hello back')
    assert.doesNotMatch(view.text(), /Private export preparation failure/); noRequests(view)
  } finally { view.unmount() }
})

function withVersion2(source, kind = 'json_object') {
  source.schema_version = 2; source.definition.schema_version = 2
  for (const item of source.definition.cases) { item.check_kind = kind; if (kind !== 'exact_text') item.expected_text = null }
  source.cases.forEach((section, index) => { section.check = evaluatePromptSuiteCheck(source.definition.cases[index], section.status, section.snapshot?.run.response?.content) })
  return source
}

for (const locale of ['en', 'zh']) test(`JSON comparison displays format checks and neutral totals without mutating v2 exports in ${locale}`, async () => {
  const view = await mountSuiteComparison({ locale })
  try {
    const left = withVersion2(report(1, { reply: '{"a":1,"a":2}' }))
    const right = withVersion2(report(2, { reply: ' {"a":2} ' }))
    await view.file('baseline', reportFile(left))
    assert.match(view.text(view.byId('comparison-baseline-preview')), locale === 'en' ? /JSON object/ : /JSON 对象/)
    await view.click('comparison-baseline-use'); await accept(view, 'comparison', right); await view.click('comparison-run')
    assert.equal(view.text(view.byId('comparison-row-0-transition')), locale === 'en' ? 'JSON format check now passes' : 'JSON 格式检查转为通过')
    assert.match(view.text(view.byId('comparison-row-0-baseline-status')), locale === 'en' ? /JSON object format failed/ : /JSON 对象格式未通过/)
    assert.match(view.text(view.byId('comparison-row-0-comparison-status')), locale === 'en' ? /JSON object format passed/ : /JSON 对象格式通过/)
    assert.match(view.text(view.byId('comparison-summary')), locale === 'en' ? /Pairs with a check.*Checks now passing/s : /启用检查的配对.*转为通过的检查/s)
    assert.equal(view.byId('comparison-row-0-baseline-expected'), undefined)
    assert.match(view.text(view.byId('comparison-row-0-baseline-kind')), locale === 'en' ? /JSON object/ : /JSON 对象/)
    await view.click('comparison-export-json')
    const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.schema_version, 2); assert.equal(saved.rows[0].check_transition, 'gained_match')
    assert.equal(Object.hasOwn(saved.rows[0], 'exact_transition'), false)
    assert.equal(Object.hasOwn(saved.rows[0], 'transition'), false)
    assert.equal(saved.rows[0].input_changes.check_kind, false)
    assert.equal(saved.baseline.cases[0].check, 'mismatched'); assert.equal(saved.comparison.cases[0].check, 'matched')
    const staleDownload = handler(view, 'comparison-export-json')
    await accept(view, 'baseline', withVersion2(report(3, { reply: '{}' })))
    await invoke(staleDownload); assert.equal(view.downloads.length, 1)
    noRequests(view); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) test(`mixed v1/v2 exact checks stay comparable and changed kinds are explained in ${locale}`, async () => {
  const view = await mountSuiteComparison({ locale })
  try {
    const left = report(1, { item: { expected_text: '{}' }, reply: '{}' })
    const right = withVersion2(report(2, { item: { expected_text: '{}' }, reply: '{}' }), 'exact_text')
    await compare(view, left, right)
    assert.equal(view.byId('comparison-row-0').props['data-paired'], true)
    assert.equal(view.text(view.byId('comparison-row-0-transition')), locale === 'en' ? 'Retained exact match' : '保持精确匹配')
    assert.equal(view.text(view.byId('comparison-row-0-comparison-expected')), '{}')
    await view.click('comparison-export-json')
    const saved = JSON.parse(await view.downloads[0].blob.text())
    assert.equal(saved.schema_version, 2); assert.equal(saved.baseline.schema_version, 1)
    assert.equal(Object.hasOwn(saved.baseline.definition.cases[0], 'check_kind'), false)
    assert.equal(saved.rows[0].check_transition, 'retained_match'); assert.equal(saved.rows[0].input_changes.check_kind, false)
    await accept(view, 'comparison', withVersion2(report(3, { reply: '{}' }))); await view.click('comparison-run')
    assert.equal(view.byId('comparison-row-0').props['data-paired'], false)
    assert.match(view.text(view.byId('comparison-row-0-changed-inputs')), locale === 'en' ? /Check kind/ : /检查类型/)
    assert.equal(view.text(view.byId('comparison-row-0-transition')), locale === 'en' ? 'Not comparable' : '不可比较')
    noRequests(view); assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

test('forged v2 check outcomes are rejected while accepted reports and fixed downloads remain intact', async () => {
  const view = await mountSuiteComparison()
  try {
    await compare(view, withVersion2(report(1, { reply: '{}' })), withVersion2(report(2, { reply: '{}' })))
    await view.click('comparison-export-json')
    const original = await view.downloads[0].blob.text()
    const forged = withVersion2(report(3, { reply: '{"a":1,"a":2}' }))
    forged.cases[0].check = 'matched'
    await view.file('baseline', reportFile(forged))
    assert.ok(view.byId('comparison-baseline-error')); assert.ok(view.byId('comparison-baseline-retained'))
    assert.equal(view.byId('comparison-baseline-preview'), undefined)
    assert.match(view.text(view.byId('comparison-baseline-accepted')), /Run 1/)
    assert.ok(view.byId('comparison-result'))
    await view.click('comparison-export-json')
    assert.equal(await view.downloads[1].blob.text(), original)
    noRequests(view)
  } finally { view.unmount() }
})
