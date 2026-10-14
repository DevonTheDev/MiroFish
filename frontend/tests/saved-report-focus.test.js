import assert from 'node:assert/strict'
import test from 'node:test'
import { mountReportLibrary, deferredApi, flush, ok } from './helpers/report-library-view-fixture.js'
import { mountReportFiles, syntheticReport, acceptFile } from './helpers/saved-report-files-view-fixture.js'

const revision = 'a'.repeat(64), metadataRevision = 'b'.repeat(64)
const summary = (id = 'report_A') => ({ report_id: id, simulation_id: 'sim_saved', title: `Saved ${id}`, summary_preview: '', requirement_preview: '', status: 'completed', created_at: null, completed_at: null, source: 'modern', metadata_revision: metadataRevision })
const catalogue = () => ({ source_revision: revision, observed_at: '2026-10-14T12:00:00Z', filters: { q: null, status: null }, offset: 0, limit: 20, matched_count: 2, returned_count: 2, has_more: false, unavailable_count: 0, unavailable_reasons: [], reports: [summary(), summary('report_B')] })
const detail = (id = 'report_A') => ({ ...summary(id), observed_at: '2026-10-14T12:00:00Z', content_source: 'full_report.md', content_revision: 'c'.repeat(64), content_bytes: 5, markdown_content: '# Hi\n', content_available: true, content_error: null })
const counts = (calls, lists, details) => { assert.equal(calls.getSavedReports.length, lists); assert.equal(calls.getSavedReport.length, details) }
const noHandoff = h => { assert.equal(h.focusCalls.length, 0); assert.equal(h.scrollCalls.length, 0) }
function oneHandoff(h) {
  const heading = h.byId('reader-heading')
  assert.equal(h.focusCalls.length, 1); assert.equal(h.scrollCalls.length, 1)
  assert.equal(h.focusCalls[0].node, heading); assert.equal(h.scrollCalls[0].node, heading)
  assert.equal(h.document.activeElement, heading)
  assert.deepEqual({ ...h.focusCalls[0].options }, { preventScroll: true })
  assert.deepEqual({ ...h.scrollCalls[0].options }, { behavior: 'instant', block: 'start' })
}
async function setup(t, options = {}) {
  const d = deferredApi(), h = await mountReportLibrary({ api: d.api, ...options })
  t.after(() => h.unmount())
  d.calls.getSavedReports[0].resolve(ok(catalogue())); await flush()
  return { h, calls: d.calls }
}
function holdOpen(h) {
  let release
  const remove = h.router.beforeEach(to => to.query.report_id === 'report_A' ? new Promise(resolve => { release = resolve }) : true)
  return { stop: remove, release: value => { assert.ok(release); remove(); release(value) } }
}

for (const locale of ['en', 'zh']) test(`catalogue Open focuses the persistent reader heading once before detail settles (${locale})`, async t => {
  const { h, calls } = await setup(t, { locale })
  const heading = h.byId('reader-heading')
  assert.equal(heading.type, 'h2'); assert.equal(heading.props.tabindex, '-1')
  assert.equal(h.text(heading), locale === 'en' ? 'Saved Markdown reader' : '已保存 Markdown 阅读器')
  noHandoff(h)
  h.document.focus(h.byId('open-report_A'))
  await h.click('open-report_A')
  oneHandoff(h); assert.equal(h.byId('reader-heading'), heading)
  assert.ok(h.byId('detail-loading')); assert.equal(h.byId('reader'), undefined)
  counts(calls, 1, 1)
  assert.equal(calls.getSavedReport[0].args[0], 'report_A')
  assert.equal(calls.getSavedReport[0].args[1].revision, metadataRevision)
  assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(h.router.currentRoute.value.query.metadata_revision, metadataRevision)
  await flush(); oneHandoff(h); assert.deepEqual(h.warnings, [])
})

for (const outcome of ['success', 'error']) test(`late detail ${outcome} never takes focus again`, async t => {
  const { h, calls } = await setup(t)
  await h.click('open-report_A'); oneHandoff(h)
  const other = h.byId('search-phrase'); h.document.focus(other)
  if (outcome === 'success') calls.getSavedReport[0].resolve(ok(detail()))
  else calls.getSavedReport[0].reject({ response: { data: { error_code: 'report_not_found' } } })
  await flush()
  assert.ok(h.byId(outcome === 'success' ? 'reader' : 'detail-error'))
  assert.equal(h.document.activeElement, other); assert.equal(h.focusCalls.length, 1); assert.equal(h.scrollCalls.length, 1)
  counts(calls, 1, 1)
})

test('same-route Open consumes one new intent without duplicating the changed-route handoff', async t => {
  const deferredScrolls = [], { h, calls } = await setup(t, { deferredScrolls })
  await h.click('open-report_A')
  assert.equal(deferredScrolls.length, 1); deferredScrolls.shift()(); oneHandoff(h)
  const path = h.router.currentRoute.value.fullPath
  await h.click('open-report_A')
  assert.equal(h.router.currentRoute.value.fullPath, path)
  assert.equal(deferredScrolls.length, 1); deferredScrolls.shift()()
  assert.equal(h.focusCalls.length, 2); assert.equal(h.scrollCalls.length, 2)
  assert.ok(calls.getSavedReport[0].signal.aborted); counts(calls, 1, 2)
  calls.getSavedReport[0].resolve(ok(detail())); calls.getSavedReport[1].resolve(ok(detail())); await flush()
  assert.equal(deferredScrolls.length, 0); assert.equal(h.focusCalls.length, 2)
})

test('cancelled Open navigation never focuses or starts a detail request', async t => {
  const { h, calls } = await setup(t), held = holdOpen(h)
  await h.click('open-report_A'); noHandoff(h); counts(calls, 1, 0)
  held.release(false); await flush()
  noHandoff(h); counts(calls, 1, 0); assert.equal(h.router.currentRoute.value.fullPath, '/reports')
})

test('newer Open supersedes an earlier pending navigation and alone owns the handoff', async t => {
  const { h, calls } = await setup(t), held = holdOpen(h)
  await h.click('open-report_A'); await h.click('open-report_B')
  oneHandoff(h); counts(calls, 1, 1); assert.equal(calls.getSavedReport[0].args[0], 'report_B')
  held.release(true); await flush()
  oneHandoff(h); counts(calls, 1, 1); assert.equal(h.router.currentRoute.value.query.report_id, 'report_B')
})

test('passive navigation to the exact pending Open target cannot borrow its canceled focus intent', async t => {
  const { h, calls } = await setup(t), held = holdOpen(h)
  await h.click('open-report_A'); noHandoff(h); counts(calls, 1, 0)
  held.stop()
  const target = h.router.resolve({ name: 'SavedReports', query: { offset: 0, limit: 20, revision, report_id: 'report_A', metadata_revision: metadataRevision } }).fullPath
  await h.navigate(target); noHandoff(h); counts(calls, 1, 1)
  calls.getSavedReport[0].resolve(ok(detail())); await flush(); noHandoff(h)
  held.release(true); await flush()
  noHandoff(h); counts(calls, 1, 1); assert.equal(h.router.currentRoute.value.fullPath, target)
})

test('newer selection retires a committed but queued handoff and ignored late responses', async t => {
  const deferredScrolls = [], { h, calls } = await setup(t, { deferredScrolls })
  await h.click('open-report_A'); await h.click('open-report_B')
  assert.equal(deferredScrolls.length, 2); counts(calls, 1, 2)
  deferredScrolls.shift()(); noHandoff(h)
  deferredScrolls.shift()(); oneHandoff(h)
  calls.getSavedReport[0].resolve(ok(detail()))
  calls.getSavedReport[1].reject({ response: { data: { error_code: 'metadata_unavailable' } } }); await flush()
  oneHandoff(h); counts(calls, 1, 2); assert.ok(h.byId('detail-error')); assert.equal(h.byId('reader'), undefined)
})

for (const stage of ['navigation', 'render']) for (const returnToOrigin of [false, true]) test(`intervening focus wins during ${stage}, including return to origin: ${returnToOrigin}`, async t => {
  const deferredScrolls = [], { h, calls } = await setup(t, { deferredScrolls })
  const origin = h.byId('open-report_A'), other = h.byId('search-phrase')
  h.document.focus(origin)
  const held = stage === 'navigation' ? holdOpen(h) : null
  await h.click('open-report_A')
  h.document.focus(other)
  if (returnToOrigin) h.document.focus(origin)
  held?.release(true); await flush()
  assert.equal(deferredScrolls.length, 1); deferredScrolls.shift()()
  noHandoff(h); assert.equal(h.document.activeElement, returnToOrigin ? origin : other); counts(calls, 1, 1)
  calls.getSavedReport[0].resolve(ok(detail())); await flush(); noHandoff(h)
})

for (const action of ['close-reader', 'refresh', 'draft', 'departure', 'unmount']) test(`observed ${action} retires a queued Open handoff`, async t => {
  const deferredScrolls = [], { h, calls } = await setup(t, { deferredScrolls })
  await h.click('open-report_A'); assert.equal(deferredScrolls.length, 1)
  if (action === 'draft') h.byId('search-phrase').props.onInput({ target: { value: 'new draft' } })
  else if (action === 'departure') await h.navigate('/')
  else if (action === 'unmount') h.unmount()
  else h.byId(action).props.onClick()
  deferredScrolls.shift()(); noHandoff(h)
  assert.ok(calls.getSavedReport[0].signal.aborted)
  calls.getSavedReport[0].resolve(ok(detail())); await flush(); noHandoff(h)
  // Vue Router resets its route before app unmount, so the existing sync watcher
  // starts one final catalogue read before disposal aborts it.
  counts(calls, ['refresh', 'departure', 'unmount'].includes(action) ? 2 : 1, 1)
})

for (const action of ['close-reader', 'refresh']) test(`observed ${action} supersedes pending Open before commit`, async t => {
  const { h, calls } = await setup(t, { initialPath: '/reports?report_id=report_B' }), held = holdOpen(h)
  await h.click('open-report_A'); noHandoff(h)
  await h.click(action)
  held.release(true); await flush(); noHandoff(h)
  counts(calls, action === 'refresh' ? 2 : 1, 1)
  assert.equal(h.router.currentRoute.value.query.report_id, undefined)
})

test('direct URL, Back, Forward and Refresh do not create a catalogue Open intent', async t => {
  const { h, calls } = await setup(t, { initialPath: '/reports?report_id=report_A' })
  noHandoff(h)
  calls.getSavedReport[0].resolve(ok(detail())); await flush(); noHandoff(h)
  await h.navigate('/reports?report_id=report_B'); noHandoff(h)
  await h.back(); noHandoff(h); assert.equal(h.router.currentRoute.value.query.report_id, 'report_A')
  await h.forward(); noHandoff(h); assert.equal(h.router.currentRoute.value.query.report_id, 'report_B')
  counts(calls, 1, 4)
  await h.click('refresh'); noHandoff(h); counts(calls, 2, 4)
})

test('opening an imported observation stays local and does not focus or scroll the catalogue reader', async t => {
  const h = await mountReportFiles(); t.after(() => h.unmount())
  await acceptFile(h, syntheticReport())
  assert.ok(h.byId('accepted-file')); noHandoff(h)
  counts(h.requests.calls, 0, 0); assert.deepEqual(h.networkCalls, []); assert.deepEqual(h.storageWrites, [])
})

for (const action of ['focus elsewhere', 'close']) test(`synchronous heading focus callback that chooses ${action} suppresses stale scrolling`, async t => {
  const { h, calls } = await setup(t)
  const other = h.byId('search-phrase')
  let closeCompletion
  h.byId('reader-heading').onFocus = () => {
    if (action === 'close') closeCompletion = h.byId('close-reader').props.onClick()
    else h.document.focus(other)
  }
  await h.click('open-report_A')
  assert.equal(h.focusCalls.length, 1); assert.equal(h.scrollCalls.length, 0); counts(calls, 1, 1)
  if (action === 'focus elsewhere') assert.equal(h.document.activeElement, other)
  else {
    assert.ok(closeCompletion); assert.ok(calls.getSavedReport[0].signal.aborted)
    await closeCompletion; await flush()
    assert.equal(h.router.currentRoute.value.query.report_id, undefined)
    assert.equal(h.scrollCalls.length, 0); counts(calls, 1, 1)
  }
})

test('the focus observer has no passive UI effects and is removed when the view unmounts', async t => {
  const { h, calls } = await setup(t)
  assert.equal(h.documentListeners.get('focusin').size, 1)
  h.document.focus(h.byId('search-phrase')); h.document.focus(h.byId('refresh')); await flush()
  noHandoff(h); counts(calls, 1, 0)
  h.unmount(); assert.equal(h.documentListeners.get('focusin').size, 0)
  h.document.focus({ type: 'outside' }); noHandoff(h)
})
