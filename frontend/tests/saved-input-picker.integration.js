import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { build, settle } from './helpers/parent-route-fixture.js'
import { row, envelope, adapter } from './helpers/project-input-candidates-data.js'
import { clearPendingUpload, getPendingUpload, setPendingUpload } from '../src/store/pendingUpload.js'

const homeView = 'views/Home.vue', pickerView = 'components/SavedInputPicker.vue'
const byId = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const rowButton = (h, id) => h.find(node => node.props?.['data-project-id'] === id)
const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
const state = h => h.state(pickerView)
const request = h => h.calls('getProjectInputCandidates').at(-1)
const recipeRequest = h => h.calls('getProjectInputRecipe').at(-1)
const data = value => adapter().validateProjectInputCandidates(value)
const payload = source => new TextEncoder().encode(JSON.stringify({ format: 'mirofish-project-input-recipe', version: 1,
  source_kind: 'saved_extracted_text', source_text: source, simulation_requirement: 'Scenario', source_project_name: 'Failed project', captured_at: '2026-10-17T12:00:00.000Z' })).buffer
async function setup(t, options = {}) {
  clearPendingUpload()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  const h = build({ historyRoute: true, graphRoute: true, disableTransitions: true, locale: 'en', assertNoWarnings: true, ...options })
  t.after(() => { try { h.close() } finally {
    clearPendingUpload()
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else delete globalThis.document
  } })
  await h.mount('/'); return h
}
async function open(h) {
  const completion = byId(h, 'saved-input-open').props.onClick()
  await settle(); return { completion, pending: request(h) }
}
async function listed(h, value = envelope([row('A'), row('B')])) {
  const opening = await open(h); opening.pending.resolve(data(value)); await opening.completion; await settle(); return opening
}
async function select(h, id = 'A') { rowButton(h, id).props.onClick(); await settle() }
const snapshot = h => ({ files: [...h.state(homeView).files], scenario: h.state(homeView).formData.simulationRequirement,
  source: h.state(homeView).sourceText, pending: getPendingUpload() })
function assertUnchanged(h, previous) {
  assert.deepEqual([...h.state(homeView).files], previous.files)
  assert.equal(h.state(homeView).formData.simulationRequirement, previous.scenario)
  assert.equal(h.state(homeView).sourceText, previous.source)
  assert.equal(getPendingUpload().submissionId, previous.pending.submissionId)
  assert.equal(getPendingUpload().isPending, previous.pending.isPending)
}

for (const locale of ['en', 'zh']) test(`${locale}: explicit opening, literal metadata, selection and download leave draft and execution untouched`, async t => {
  const h = await setup(t, { locale })
  assert.equal(h.calls('getProjectInputCandidates').length, 0); assert.equal(byId(h, 'saved-input-detail'), undefined)
  h.state(homeView).formData.simulationRequirement = 'Current draft'
  h.state(homeView).sourceText = 'Unadded source'
  setPendingUpload([new File(['accepted'], 'accepted.txt')], 'Accepted scenario')
  const before = snapshot(h), pushes = h.pushes.length
  await listed(h, envelope([row('A', { name: '<script>literal</script>', scenario_excerpt: '<b>scenario</b>', name_truncated: true, scenario_truncated: true })]))
  assert.ok(text(rowButton(h, 'A')).includes('<script>literal</script>'))
  await select(h); assert.equal(text(byId(h, 'saved-input-scenario')), '<b>scenario</b>')
  const download = byId(h, 'download-input-recipe').props.onClick()
  assert.equal(recipeRequest(h).args[0], 'A'); recipeRequest(h).resolve(payload('Exact 😀\r\n')); await download; await settle()
  assert.equal(h.downloads.length, 1); assert.equal(h.pushes.length, pushes); assertUnchanged(h, before)
  for (const name of ['getProject', 'generateOntology', 'buildGraph', 'createSimulation', 'resumeGraph']) assert.equal(h.calls(name).length, 0, name)
})

for (const partial of [false, true]) test(`${partial ? 'partial' : 'healthy'} empty scan has its own visible outcome`, async t => {
  const h = await setup(t)
  await listed(h, envelope([], partial ? { partial: true, examined_entries: 1, skipped: { unsafe: 0, missing: 1, too_large: 0, invalid: 0, changed: 0, unreadable: 0 } } : {}))
  assert.ok(byId(h, partial ? 'saved-input-partial' : 'saved-input-empty'))
  assert.equal(byId(h, partial ? 'saved-input-empty' : 'saved-input-partial'), undefined)
  assert.equal(byId(h, 'saved-input-error'), undefined)
})

test('whole-request failure is never rendered as normal empty and Retry opens a fresh request', async t => {
  const h = await setup(t), opening = await open(h)
  opening.pending.reject(new Error('/private/project.json secret')); await opening.completion; await settle()
  assert.ok(byId(h, 'saved-input-error')); assert.equal(byId(h, 'saved-input-empty'), undefined)
  assert.doesNotMatch(text(byId(h, 'saved-input-error')), /private|secret/)
  byId(h, 'saved-input-retry').props.onClick(); assert.equal(h.calls('getProjectInputCandidates').length, 2)
})

test('Refresh immediately clears old row and download authority, including before render', async t => {
  const h = await setup(t); await listed(h); await select(h)
  const oldRow = rowButton(h, 'A').props.onClick, oldDownload = byId(h, 'download-input-recipe').props.onClick
  const download = oldDownload(), downloadRequest = recipeRequest(h)
  const refresh = byId(h, 'saved-input-refresh').props.onClick
  refresh(); oldRow(); oldDownload()
  assert.equal(state(h).selected, null); assert.equal(state(h).downloadSelection().project_id, null)
  assert.ok(state(h).downloadSelection(), 'truthy mismatch must prevent absent-selection rearming')
  assert.equal(h.calls('getProjectInputRecipe').length, 1); assert.equal(downloadRequest.signal.aborted, true)
  downloadRequest.resolve(payload('stale source')); await download; await settle(); assert.equal(h.downloads.length, 0)
  request(h).reject(new Error('refresh failed')); await settle()
  assert.ok(byId(h, 'saved-input-error')); assert.equal(rowButton(h, 'A'), undefined); assert.equal(byId(h, 'download-input-recipe'), undefined)
})

test('same-ID fresh observation and A→B→A selection do not revive old action closures', async t => {
  const h = await setup(t); await listed(h); await select(h)
  const oldDownload = byId(h, 'download-input-recipe').props.onClick, oldRow = rowButton(h, 'A').props.onClick
  await select(h, 'B'); await select(h, 'A'); oldDownload(); assert.equal(h.calls('getProjectInputRecipe').length, 0)
  byId(h, 'saved-input-refresh').props.onClick(); request(h).resolve(data(envelope([row('A', { name: 'New observation' })]))); await settle()
  oldRow(); assert.equal(state(h).selected, null)
  await select(h); oldDownload(); assert.equal(h.calls('getProjectInputRecipe').length, 0)
  byId(h, 'download-input-recipe').props.onClick(); assert.equal(h.calls('getProjectInputRecipe').length, 1)
})

for (const settlement of ['resolve', 'reject']) test(`Close/reopen ignores late ${settlement} and cannot clear newer busy state`, async t => {
  const h = await setup(t), first = await open(h), oldClose = byId(h, 'saved-input-close').props.onClick
  oldClose(); await settle(); const second = await open(h); oldClose()
  assert.equal(first.pending.signal.aborted, true)
  first.pending[settlement](settlement === 'resolve' ? data(envelope([row('old')])) : new Error('old failure'))
  await first.completion; await settle(); assert.equal(state(h).busy, true); assert.equal(state(h).failed, false)
  second.pending.resolve(data(envelope([row('new')]))); await second.completion; await settle()
  assert.ok(rowButton(h, 'new')); assert.equal(rowButton(h, 'old'), undefined)
})

for (const change of ['route', 'same-path-object', 'unmount']) test(`${change} retires retained actions and pending list/recipe callbacks`, async t => {
  const h = await setup(t); await listed(h); await select(h)
  const old = byId(h, 'download-input-recipe').props.onClick, completion = old(), pending = recipeRequest(h)
  const oldRow = rowButton(h, 'A').props.onClick, refresh = byId(h, 'saved-input-refresh').props.onClick
  if (change === 'route') await h.navigate('/runtime')
  if (change === 'same-path-object') h.router.currentRoute.value = { ...h.router.currentRoute.value }
  if (change === 'unmount') h.close()
  old(); oldRow(); refresh(); pending.resolve(payload('obsolete')); await completion; await settle()
  assert.equal(h.calls('getProjectInputRecipe').length, 1); assert.equal(h.downloads.length, 0); assert.equal(pending.signal.aborted, true)
  assert.equal(h.calls('getProjectInputCandidates').length, 1)
  if (change === 'same-path-object') { assert.equal(state(h).opened, false); assert.equal(state(h).selected, null) }
})

test('rejected pending navigation leaves committed Home authority valid', async t => {
  const h = await setup(t); await listed(h); await select(h)
  const route = h.router.currentRoute.value, download = byId(h, 'download-input-recipe').props.onClick
  const remove = h.router.beforeEach(to => to.path === '/runtime' ? false : undefined)
  await h.navigate('/runtime'); remove(); assert.equal(h.router.currentRoute.value, route)
  const completion = download(); recipeRequest(h).resolve(payload('still selected')); await completion
  assert.equal(h.downloads.length, 1)
})

test('Home unavailable→available before render permanently retires generations and stale download props', async t => {
  const h = await setup(t); await listed(h); await select(h)
  const picker = state(h), oldOpen = h.child(pickerView).setupState.controls.open
  const oldRow = rowButton(h, 'A').props.onClick, oldRefresh = byId(h, 'saved-input-refresh').props.onClick
  const oldDownload = byId(h, 'download-input-recipe').props.onClick, completion = oldDownload(), pending = recipeRequest(h)
  h.state(homeView).loading = true
  assert.equal(picker.opened, false); assert.equal(picker.selected, null); assert.ok(picker.downloadSelection())
  assert.equal(picker.downloadSelection().project_id, null)
  oldOpen?.(); oldRow(); oldRefresh(); oldDownload(); pending.resolve(payload('after Start'))
  h.state(homeView).loading = false
  oldRow(); oldRefresh(); oldDownload()
  assert.equal(picker.opened, false); assert.equal(picker.selected, null)
  await completion; await settle(); assert.equal(h.downloads.length, 0); assert.equal(h.objectUrls.size, 0)
  assert.equal(h.calls('getProjectInputRecipe').length, 1); assert.equal(h.calls('getProjectInputCandidates').length, 1)
  const fresh = await open(h); assert.equal(h.calls('getProjectInputCandidates').length, 2)
  fresh.pending.resolve(data(envelope([]))); await fresh.completion
})

test('Start retires list before render and ordinary failed handoff leaves reopening explicit', async t => {
  const h = await setup(t), opening = await open(h), oldPicker = state(h)
  const oldClose = byId(h, 'saved-input-close').props.onClick, oldRefresh = byId(h, 'saved-input-refresh').props.onClick
  const accepted = new File(['source'], 'source.txt')
  h.state(homeView).files = [accepted]; h.state(homeView).formData.simulationRequirement = 'Scenario'
  const remove = h.router.beforeEach(to => to.name === 'Process' ? false : undefined)
  const started = h.state(homeView).startSimulation()
  assert.equal(h.state(homeView).loading, true); assert.equal(oldPicker.opened, false); assert.equal(opening.pending.signal.aborted, true)
  oldClose(); oldRefresh(); opening.pending.resolve(data(envelope([row('late')]))); await opening.completion
  await started; remove(); await settle()
  assert.equal(h.router.currentRoute.value.name, 'Home'); assert.equal(h.state(homeView).loading, false)
  assert.equal(state(h).opened, false); assert.equal(rowButton(h, 'late'), undefined)
  assert.equal(getPendingUpload().files[0], accepted); assert.equal(h.calls('generateOntology').length, 0)
})

test('retained closed opener and deferred focus cannot outlive Home availability or reopening', async t => {
  const h = await setup(t), opener = byId(h, 'saved-input-open'), oldOpen = opener.props.onClick
  h.state(homeView).loading = true; oldOpen(); h.state(homeView).loading = false; oldOpen()
  assert.equal(h.calls('getProjectInputCandidates').length, 0)
  await settle(); const first = await open(h)
  assert.equal(byId(h, 'saved-input-open').props['aria-expanded'], true)
  const heading = h.find(node => node.props?.id === 'saved-input-heading')
  assert.equal(heading.ownerDocument.activeElement, heading)
  byId(h, 'saved-input-close').props.onClick()
  const second = state(h).controls.open() // Deliberately reopen before the host render tick.
  await settle()
  const newHeading = h.find(node => node.props?.id === 'saved-input-heading')
  assert.equal(newHeading.ownerDocument.activeElement, newHeading)
  assert.notEqual(newHeading.ownerDocument.activeElement, opener)
  first.pending.resolve(data(envelope([]))); request(h).resolve(data(envelope([])))
  await first.completion; await second
})

test('ordinary Close returns focus and committed route change cancels deferred Close focus', async t => {
  const h = await setup(t); await listed(h)
  byId(h, 'saved-input-close').props.onClick(); await settle()
  const opener = byId(h, 'saved-input-open'); assert.equal(opener.ownerDocument.activeElement, opener)
  await listed(h); byId(h, 'saved-input-close').props.onClick()
  h.router.currentRoute.value = { ...h.router.currentRoute.value }
  opener.ownerDocument.activeElement = null
  await settle(); assert.equal(opener.ownerDocument.activeElement, null)
})

test('actual failed pre-simulation discovery feeds existing download and explicit local adoption', async t => {
  const directory = process.env.MIROFISH_CANDIDATE_FIXTURE_DIR
  assert.ok(directory, 'runner must provide the actual backend discovery/download fixture directory')
  const read = name => {
    const bytes = readFileSync(`${directory}/${name}.json`)
    const expected = readFileSync(`${directory}/${name}.sha256`, 'utf8').split(' ')[0]
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected); return bytes
  }
  const candidates = data(JSON.parse(read('backend-input-candidates').toString('utf8')))
  const bytes = read('backend-input-recipe'), recipe = JSON.parse(bytes.toString('utf8'))
  const failed = candidates.items.find(item => item.status === 'failed'); assert.ok(failed)
  const h = await setup(t), opening = await open(h), before = snapshot(h)
  opening.pending.resolve(candidates); await opening.completion; await settle(); await select(h, failed.project_id)
  const downloading = byId(h, 'download-input-recipe').props.onClick(); assert.equal(recipeRequest(h).args[0], failed.project_id)
  recipeRequest(h).resolve(bytes); await downloading; await settle()
  assert.equal(h.downloads.length, 1); assertUnchanged(h, before)
  const target = { files: [new File([await h.downloads[0].blob.arrayBuffer()], 'recipe.json')], value: 'chosen' }
  await byId(h, 'input-recipe-file').props.onChange({ target }); await settle()
  byId(h, 'use-input-recipe').props.onClick(); await settle()
  assert.deepEqual(Buffer.from(await h.state(homeView).files[0].arrayBuffer()), Buffer.from(recipe.source_text))
  assert.equal(h.state(homeView).formData.simulationRequirement, recipe.simulation_requirement)
  assert.equal(getPendingUpload().isPending, false); assert.equal(h.calls('generateOntology').length, 0); assert.equal(h.calls('buildGraph').length, 0)
})

test('partial/change, null metadata and unzoned date explanations remain visible', async t => {
  const h = await setup(t)
  await listed(h, envelope([row('A', { name: null, scenario_excerpt: null, status: 'unknown' })], { partial: true, directory_changed: true }))
  assert.ok(byId(h, 'saved-input-partial')); assert.ok(byId(h, 'saved-input-directory-changed'))
  assert.match(text(rowButton(h, 'A')), /Unnamed project/); assert.match(text(rowButton(h, 'A')), /time zone not recorded/)
  await select(h); assert.equal(text(byId(h, 'saved-input-scenario')), 'Scenario unavailable')
  assert.match(text(byId(h, 'saved-input-picker')), /Unsafe or unsupported entries skipped/)
})

test('incomplete metadata candidate remains selectable while existing download action reports its failure', async t => {
  const h = await setup(t); await listed(h, envelope([row('A', { scenario_excerpt: null })])); await select(h)
  const completion = byId(h, 'download-input-recipe').props.onClick()
  recipeRequest(h).reject(Object.assign(new Error('private incomplete detail'), { status: 409 }))
  await completion; await settle()
  assert.ok(rowButton(h, 'A')); assert.ok(byId(h, 'input-recipe-download-error'))
  assert.equal(h.downloads.length, 0); assert.equal(h.objectUrls.size, 0); assert.equal(h.calls('getProject').length, 0)
})

test('Home retirement during object-URL allocation cleans the retired download without an anchor', async t => {
  const h = await setup(t); await listed(h); await select(h)
  const completion = byId(h, 'download-input-recipe').props.onClick()
  let allocations = 0
  h.downloadHooks.createObjectURL = () => { allocations++; h.state(homeView).loading = true }
  recipeRequest(h).resolve(payload('retired during allocation')); await completion; await settle()
  assert.equal(allocations, 1, 'the recipe passed validation and reached URL allocation')
  assert.equal(h.state(homeView).loading, true); assert.equal(byId(h, 'saved-input-picker'), undefined)
  assert.equal(h.downloads.length, 0); assert.equal(h.objectUrls.size, 0); assert.equal(h.anchors.length, 0)
})
