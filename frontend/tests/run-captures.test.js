import assert from 'node:assert/strict'
import test from 'node:test'
import { mountRunCaptures, deferredApi, flush, ok } from './helpers/run-captures-view-fixture.js'
import { LEFT, RIGHT, THIRD, revision, candidates, preview, capture, library, comparison } from './fixtures/run-captures-data.js'

const uuid = () => LEFT.slice(0, 8) + '-' + LEFT.slice(8, 12) + '-' + LEFT.slice(12, 16) + '-' + LEFT.slice(16, 20) + '-' + LEFT.slice(20)
async function setup(t, path = '/captures?simulation=sim_A', locale = 'en') {
  const d = deferredApi(), h = await mountRunCaptures({ api: d.api, initialPath: path, locale, crypto: { randomUUID: uuid } })
  t.after(() => h.unmount()); return { ...d, h }
}
async function readyPreview(h, calls) {
  await h.click('preview'); calls.previewRunCapture.at(-1).resolve(ok(preview())); await flush()
  await h.input('label', 'First attempt'); await h.input('note', 'Saved notes')
}
const missing = { response: { status: 404, data: { error_code: 'capture_not_found' } } }

test('opening the route loads candidates and page 20 without preview or mutation', async t => {
  const { h, calls } = await setup(t)
  assert.equal(calls.previewRunCapture.length, 0); assert.equal(calls.saveRunCapture.length, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.getRunCaptures[0].args[0])), { offset: 0, limit: 20 })
  calls.getComparisonCandidates[0].resolve(ok(candidates())); calls.getRunCaptures[0].resolve(ok(library([]))); await flush()
  assert.match(h.text(), /No captures yet/); assert.match(h.text(), /immutable aggregate/)
  assert.equal(h.byId('save').props.disabled, true); assert.equal(h.warnings.length, 0)
})

test('explicit preview then Save freezes exact revision and metadata with UUID32, no double POST', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls)
  await h.click('save'); await h.submit('capture-form')
  assert.equal(calls.saveRunCapture.length, 1)
  const [id, payload] = calls.saveRunCapture[0].args
  assert.equal(id, LEFT); assert.deepEqual(JSON.parse(JSON.stringify(payload)), { simulation_id: 'sim_A', source_revision: revision, label: 'First attempt', note: 'Saved notes' })
  assert.equal(h.router.currentRoute.value.query.pending, LEFT); assert.match(h.text(), new RegExp(LEFT))
  assert.equal(h.byId('label').props.disabled, true)
  calls.saveRunCapture[0].resolve(ok(capture(LEFT, 'sim_A', 3, 'First attempt', 'Saved notes'))); await flush()
  assert.ok(h.byId('saved-capture')); assert.equal(h.byId('save').props.disabled, true)
  assert.match(h.text(), /Capture saved/); assert.match(h.text(), /Saved run status/)
})

test('lost POST response reconciles via same ID and accepts only the frozen saved draft', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  calls.saveRunCapture[0].reject(new Error('Network Error')); await flush()
  assert.equal(calls.getRunCapture.at(-1).args[0], LEFT); assert.equal(calls.saveRunCapture.length, 1)
  calls.getRunCapture.at(-1).resolve(ok(capture(LEFT, 'sim_A', 3, 'First attempt', 'Saved notes'))); await flush()
  assert.ok(h.byId('saved-capture')); assert.equal(calls.saveRunCapture.length, 1)
})

test('reconciliation 404 requires explicit retry and reuses the original ID and payload', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  calls.saveRunCapture[0].reject(new Error('Network Error')); await flush(); calls.getRunCapture.at(-1).reject(missing); await flush()
  assert.equal(calls.saveRunCapture.length, 1); assert.ok(h.byId('retry-save')); assert.match(h.text(), /not confirmed/)
  await h.click('retry-save')
  assert.equal(calls.saveRunCapture.length, 2)
  assert.equal(calls.saveRunCapture[0].args[0], calls.saveRunCapture[1].args[0]); assert.deepEqual(calls.saveRunCapture[0].args[1], calls.saveRunCapture[1].args[1])
})

test('failed reconciliation never retries a mutation and keeps a recoverable capture ID', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  calls.saveRunCapture[0].reject(new Error('timeout')); await flush(); calls.getRunCapture.at(-1).reject(new Error('offline')); await flush()
  assert.equal(calls.saveRunCapture.length, 1); assert.equal(h.byId('retry-save').props.disabled, true)
  assert.equal(h.router.currentRoute.value.query.pending, LEFT); await h.click('check-save')
  assert.equal(calls.getRunCapture.length, 2)
})

test('a recovery URL reads the pending ID and never reconstructs or automatically retries the POST', async t => {
  const { h, calls } = await setup(t, `/captures?pending=${LEFT}`)
  assert.equal(calls.saveRunCapture.length, 0); assert.match(h.text(), /recover/i)
  await h.click('recover-capture'); assert.equal(h.router.currentRoute.value.query.capture, LEFT)
  assert.equal(calls.getRunCapture.at(-1).args[0], LEFT)
})

test('simulation A to B to A retires old previews even when abort is ignored', async t => {
  const { h, calls } = await setup(t); await h.click('preview')
  await h.change('simulation-select', 'sim_B'); await h.change('simulation-select', 'sim_A'); await h.click('preview')
  assert.equal(calls.previewRunCapture[0].signal.aborted, true)
  calls.previewRunCapture[1].resolve(ok(preview('sim_A', 30))); await flush(); calls.previewRunCapture[0].resolve(ok(preview('sim_A', 999))); await flush()
  assert.match(h.text(h.byId('preview-observation')), /30/); assert.doesNotMatch(h.text(h.byId('preview-observation')), /999/)
})

test('same simulation can be compared by distinct capture IDs, showing context, completeness and right-minus-left', async t => {
  const { h, calls } = await setup(t, `/captures?left=${LEFT}&right=${RIGHT}`)
  calls.compareRunCaptures[0].resolve(ok(comparison())); await flush()
  assert.ok(h.byId('comparison')); assert.match(h.text(h.byId('metric-recorded_actions')), /3.*5.*\+2/)
  assert.match(h.text(), /right minus left/); assert.match(h.text(), /saved-model/); assert.match(h.text(), /which model actually ran/)
  assert.match(h.text(), /Captured at/); assert.match(h.text(), /Last saved update/)
  assert.equal(h.warnings.length, 0)
})

test('comparison A to B to A and detail replacement reject stale and mismatched responses', async t => {
  const { h, calls } = await setup(t, `/captures?left=${LEFT}&right=${RIGHT}&capture=${LEFT}`)
  await h.navigate(`/captures?left=${LEFT}&right=${THIRD}&capture=${RIGHT}`)
  await h.navigate(`/captures?left=${LEFT}&right=${RIGHT}&capture=${LEFT}`)
  assert.equal(calls.compareRunCaptures[0].signal.aborted, true); assert.equal(calls.getRunCapture[0].signal.aborted, true)
  calls.compareRunCaptures[2].resolve(ok(comparison())); calls.getRunCapture[2].resolve(ok(capture())); await flush()
  calls.compareRunCaptures[0].resolve(ok(comparison(capture(LEFT, 'sim_A', 999)))); calls.getRunCapture[0].reject(new Error('secret')); await flush()
  assert.doesNotMatch(h.text(), /999|secret/)
  await h.click('compare'); calls.compareRunCaptures.at(-1).resolve(ok(comparison(capture(RIGHT), capture(LEFT)))); await flush()
  assert.equal(h.byId('comparison'), undefined); assert.equal(h.byId('download-comparison').props.disabled, true)
})

test('paging retires visible rows and ignores old pages; selections persist across pages', async t => {
  const { h, calls } = await setup(t, `/captures?left=${LEFT}`)
  calls.getRunCaptures[0].resolve(ok(library(Array.from({ length: 20 }, (_, i) => capture(i.toString(16).padStart(32, '0'), 'sim_A', 3, `Capture ${i}`)), 0, 21))); await flush()
  await h.click('next'); assert.equal(h.byId('capture-row-' + '0'.repeat(32)), undefined)
  assert.equal(h.router.currentRoute.value.query.offset, '20'); assert.equal(h.router.currentRoute.value.query.left, LEFT)
  calls.getRunCaptures[1].resolve(ok(library([capture(THIRD)], 20, 21))); await flush()
  await h.click('choose-right-' + THIRD); assert.equal(h.router.currentRoute.value.query.right, THIRD)
  await h.click('previous'); assert.equal(h.router.currentRoute.value.query.offset, undefined)
})

test('detail and comparison downloads contain the exact accepted objects with fixed names and revoked URLs', async t => {
  const { h, calls } = await setup(t, `/captures?capture=${LEFT}&left=${LEFT}&right=${RIGHT}`)
  const c = capture(), pair = comparison(); calls.getRunCapture[0].resolve(ok(c)); calls.compareRunCaptures[0].resolve(ok(pair)); await flush()
  await h.click('download-capture'); await h.click('download-comparison')
  assert.equal(h.downloads[0].filename, 'mirofish-run-capture.json'); assert.equal(h.downloads[1].filename, 'mirofish-run-capture-comparison.json')
  assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), c); assert.deepEqual(JSON.parse(await h.downloads[1].blob.text()), pair)
  assert.ok(h.revokedUrls.includes(h.downloads[0].url)); h.unmount(); assert.ok(h.revokedUrls.includes(h.downloads[1].url))
})

test('partial counts, known zero, unavailable differences and hostile text remain literal in both languages', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, `/captures?left=${LEFT}&right=${RIGHT}`, locale)
    const data = comparison(); data.left.label = '<img src=x onerror=alert(1)>'; data.left.note = '<script>bad()</script>'; data.left.observation.summary.scenario = '[click](javascript:bad())'
    data.left.observation.summary.availability = 'partial'; data.left.observation.summary.status = 'stopped'; data.left.observation.summary.warnings = [{ code: 'invalid_records', count: 2, platform: 'twitter' }]
    data.left.observation.summary.metrics.recorded_actions = 0; data.differences.recorded_actions = null; data.differences.action_types = [{ action_type: '<iframe>', left: null, right: 5, difference: null }]
    calls.compareRunCaptures[0].resolve(ok(data)); await flush()
    assert.match(h.text(h.byId('metric-recorded_actions')), /0.*5.*—/); assert.ok(h.text().includes('<img src=x onerror=alert(1)>'))
    assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0); assert.doesNotMatch(h.text(), /runCaptures\.|comparison\./); assert.equal(h.warnings.length, 0)
  }
})

test('invalid or duplicate IDs never issue comparison requests and safe errors omit server text', async t => {
  const { h, calls } = await setup(t, `/captures?left=${LEFT}&right=${LEFT}`)
  assert.equal(calls.compareRunCaptures.length, 0); assert.match(h.text(), /different capture IDs/)
  await h.navigate('/captures?left=bad&right=also-bad'); assert.equal(calls.compareRunCaptures.length, 0); assert.match(h.text(), /invalid/i)
  await h.navigate('/captures?simulation=sim_A'); await h.click('preview'); calls.previewRunCapture.at(-1).reject({ response: { data: { error_code: 'sources_changed', error: '/secret/token' } } }); await flush()
  assert.match(h.text(), /changed/); assert.doesNotMatch(h.text(), /secret|token/)
})

test('unmount aborts all reads and in-flight save transport; late completion is ignored', async t => {
  const { h, calls } = await setup(t, `/captures?simulation=sim_A&left=${LEFT}&right=${RIGHT}&capture=${LEFT}`)
  await readyPreview(h, calls); await h.click('save'); h.unmount()
  for (const name of ['getComparisonCandidates', 'getRunCaptures', 'compareRunCaptures', 'getRunCapture', 'saveRunCapture']) assert.equal(calls[name][0].signal.aborted, true)
  calls.saveRunCapture[0].resolve(ok(capture())); await flush(); assert.equal(h.root.children.length, 0); assert.equal(calls.getRunCapture.length, 1)
})

test('History library and selected-simulation entries navigate using the real router', async t => {
  const { h, calls } = await setup(t, '/')
  calls.getSimulationHistory[0].resolve(ok([{ simulation_id: 'sim_A', simulation_requirement: 'Saved scenario', project_id: 'P' }])); await flush()
  const card = h.find(n => n.type === 'div' && String(n.props.class).split(' ').includes('project-card')); card.props.onClick(); await flush()
  await h.click('history-captures-selected'); assert.equal(h.router.currentRoute.value.path, '/captures'); assert.equal(h.router.currentRoute.value.query.simulation, 'sim_A')
  await h.navigate('/'); await h.click('history-captures'); assert.equal(h.router.currentRoute.value.fullPath, '/captures')
})

test('route-level simulation change retires an in-flight save, preserves its ID for recovery, and permits a new draft', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  await h.navigate('/captures?simulation=sim_B')
  assert.equal(calls.saveRunCapture[0].signal.aborted, true); assert.equal(h.byId('label').props.disabled, false)
  assert.equal(h.byId('save-attempt'), undefined); assert.match(h.text(), new RegExp(LEFT))
  await h.click('preview'); calls.previewRunCapture.at(-1).resolve(ok(preview('sim_B', 8))); await flush()
  calls.saveRunCapture[0].resolve(ok(capture(LEFT, 'sim_A', 3, 'First attempt', 'Saved notes'))); await flush()
  assert.equal(h.byId('saved-capture'), undefined); assert.match(h.text(h.byId('preview-observation')), /sim_B/)
})

test('malformed-route change retires reconciliation and a late failure cannot affect a later draft', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  calls.saveRunCapture[0].reject(new Error('Network Error')); await flush(); const check = calls.getRunCapture.at(-1)
  await h.navigate('/captures?simulation=sim_B&unexpected=true')
  assert.equal(check.signal.aborted, true); assert.equal(h.byId('save-attempt'), undefined)
  await h.navigate('/captures?simulation=sim_B'); await h.click('preview'); calls.previewRunCapture.at(-1).resolve(ok(preview('sim_B'))); await h.input('label', 'New draft')
  check.reject(missing); await flush(); assert.equal(h.byId('retry-save'), undefined); assert.equal(h.byId('save').props.disabled, false)
})

test('query-only library and comparison navigation preserves the simulation-owned save attempt', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  await h.navigate(`/captures?simulation=sim_A&pending=${LEFT}&left=${LEFT}&right=${RIGHT}&capture=${RIGHT}`)
  assert.equal(calls.saveRunCapture[0].signal.aborted, false); assert.ok(h.byId('save-attempt'))
  calls.saveRunCapture[0].resolve(ok(capture(LEFT, 'sim_A', 3, 'First attempt', 'Saved notes'))); await flush(); assert.ok(h.byId('saved-capture'))
})

test('a mismatched successful Save body is reconciled but never attributed to this draft', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  calls.saveRunCapture[0].resolve(ok(capture(LEFT, 'sim_A', 3, 'Wrong label', 'Saved notes'))); await flush()
  assert.equal(h.byId('saved-capture'), undefined); assert.equal(calls.getRunCapture.length, 1)
  calls.getRunCapture[0].resolve(ok(capture(LEFT, 'sim_A', 3, 'Wrong label', 'Saved notes'))); await flush()
  assert.equal(h.byId('saved-capture'), undefined); assert.equal(h.byId('retry-save').props.disabled, true); assert.match(h.text(), /different submitted data/)
})

test('changing route while pending-ID navigation is awaiting a guard cannot dispatch the old POST', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls)
  let release
  h.router.beforeEach(to => to.query.pending && !h.router.currentRoute.value.query.pending ? new Promise(resolve => { release = resolve }) : true)
  await h.click('save'); assert.equal(calls.saveRunCapture.length, 0)
  await h.navigate('/captures?simulation=sim_B'); release(true); await flush()
  assert.equal(calls.saveRunCapture.length, 0); assert.equal(h.byId('save-attempt'), undefined); assert.equal(h.byId('label').props.disabled, false)
})

test('capture text limits count Unicode codepoints, preserve spelling and reject control characters before POST', async t => {
  const { h, calls } = await setup(t); await h.click('preview'); calls.previewRunCapture[0].resolve(ok(preview())); await flush()
  await h.input('label', '😀'.repeat(120)); assert.equal(h.byId('save').props.disabled, false)
  await h.input('label', '😀'.repeat(121)); assert.equal(h.byId('save').props.disabled, true)
  await h.input('label', '  '); assert.equal(h.byId('save').props.disabled, true)
  await h.input('label', '  Keep spelling  '); await h.input('note', 'line\n\ttab'); assert.equal(h.byId('save').props.disabled, false)
  await h.input('note', 'bad\u0000note'); assert.equal(h.byId('save').props.disabled, true)
  await h.input('note', 'x'.repeat(2001)); assert.equal(h.byId('save').props.disabled, true)
  await h.input('note', '😀'.repeat(2000)); assert.equal(h.byId('save').props.disabled, false)
  await h.click('save'); assert.equal(calls.saveRunCapture[0].args[1].label, '  Keep spelling  '); assert.equal([...calls.saveRunCapture[0].args[1].note].length, 2000)
})

test('definitive source-change rejection requires a new preview and performs no recovery POST or GET', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save')
  calls.saveRunCapture[0].reject({ response: { status: 409, data: { error_code: 'sources_changed', error: '/secret/path' } } }); await flush()
  assert.equal(h.byId('save').props.disabled, true); assert.equal(h.byId('preview-observation'), undefined); assert.equal(h.byId('save-attempt'), undefined)
  assert.equal(calls.getRunCapture.length, 0); assert.equal(calls.saveRunCapture.length, 1); assert.doesNotMatch(h.text(), /secret\/path/)
  await h.click('preview'); assert.equal(calls.previewRunCapture.length, 2)
})

test('malformed catalogue, detail and preview data never enables dependent actions', async t => {
  const { h, calls } = await setup(t, `/captures?simulation=sim_A&capture=${LEFT}`)
  calls.getRunCaptures[0].resolve(ok(library([capture(), capture()], 0, 2))); calls.getRunCapture[0].resolve(ok(capture(RIGHT))); await h.click('preview')
  calls.previewRunCapture[0].resolve(ok(preview('sim_B'))); await flush()
  assert.equal(h.byId('capture-row-' + LEFT), undefined); assert.equal(h.byId('download-capture').props.disabled, true); assert.equal(h.byId('preview-observation'), undefined); assert.equal(h.byId('save').props.disabled, true)
})

test('secure UUID generation failure keeps the preview and never sends a mutation', async t => {
  const d = deferredApi(), h = await mountRunCaptures({ api: d.api, initialPath: '/captures?simulation=sim_A', crypto: {} }); t.after(() => h.unmount())
  await readyPreview(h, d.calls); await h.click('save'); assert.equal(d.calls.saveRunCapture.length, 0); assert.ok(h.byId('preview-observation')); assert.match(h.text(), /Secure capture ID generation/)
})

test('fully unavailable saved observations show dashes, fallback status notices and no fabricated zero', async t => {
  const { h, calls } = await setup(t, `/captures?capture=${LEFT}`)
  const data = capture(); data.observation.summary.status = 'failed'; data.observation.summary.availability = 'unavailable'; data.observation.summary.warnings = [{ code: 'run_state_unavailable' }, { code: 'no_action_logs' }, { code: '/private/unknown-warning' }]
  data.observation.summary.metrics = { recorded_actions: null, rounds_with_actions: null, platforms: { twitter: { availability: 'unavailable', recorded_actions: null, active_agents: null }, reddit: { availability: 'unavailable', recorded_actions: null, active_agents: null } }, action_types: [] }
  calls.getRunCapture[0].resolve(ok(data)); await flush()
  const text = h.text(h.byId('capture-detail')); assert.match(text, /Failed/); assert.match(text, /Unavailable observations/); assert.match(text, /status uses the saved simulation state/); assert.doesNotMatch(text, /private|unknown-warning/)
  assert.equal(h.byId('download-capture').props.disabled, false)
})

const recoveryRequired = { response: { status: 503, data: { error_code: 'capture_recovery_required', error: '/private/journal' } } }

test('passive storage recovery error shows one explicit action without any POST', async t => {
  const { h, calls } = await setup(t)
  assert.equal(h.byId('recover-store'), undefined)
  calls.getRunCaptures[0].reject(recoveryRequired); await flush()
  assert.ok(h.byId('recover-store')); assert.equal(calls.recoverRunCaptureStore.length, 0); assert.equal(calls.saveRunCapture.length, 0)
  assert.match(h.text(), /SQLite rollback recovery/); assert.doesNotMatch(h.text(), /private\/journal/)
})

test('explicit recovery is single-flight and refreshes current read streams only after accepted success', async t => {
  const { h, calls } = await setup(t, `/captures?simulation=sim_A&capture=${LEFT}&left=${LEFT}&right=${RIGHT}`)
  calls.getRunCaptures[0].reject(recoveryRequired); calls.getRunCapture[0].reject(recoveryRequired); calls.compareRunCaptures[0].reject(recoveryRequired); await flush()
  assert.equal(h.all(node => node.props['data-testid'] === 'recover-store').length, 1)
  await h.click('recover-store'); const button = h.byId('recover-store'); button.props.onClick(); await flush()
  assert.equal(calls.recoverRunCaptureStore.length, 1); assert.equal(button.props.disabled, true)
  assert.equal(calls.getRunCaptures.length, 1)
  calls.recoverRunCaptureStore[0].resolve(ok({ recovered: true })); await flush()
  assert.equal(calls.getRunCaptures.length, 2); assert.equal(calls.getRunCapture.length, 2); assert.equal(calls.compareRunCaptures.length, 2); assert.equal(calls.previewRunCapture.length, 0); assert.equal(calls.saveRunCapture.length, 0)
})

test('lost recovery response never retries automatically and allows explicit read checks and recovery retry', async t => {
  const { h, calls } = await setup(t); calls.getRunCaptures[0].reject(recoveryRequired); await flush(); await h.click('recover-store')
  calls.recoverRunCaptureStore[0].reject(new Error('Network Error')); await flush()
  assert.equal(calls.recoverRunCaptureStore.length, 1); assert.equal(calls.getRunCaptures.length, 1); assert.equal(h.byId('recover-store').props.disabled, false)
  await h.click('recheck-store'); assert.equal(calls.getRunCaptures.length, 2); assert.equal(calls.recoverRunCaptureStore.length, 1)
  calls.getRunCaptures[1].reject(recoveryRequired); await flush(); await h.click('recover-store'); assert.equal(calls.recoverRunCaptureStore.length, 2)
  calls.recoverRunCaptureStore[1].resolve(ok({ recovered: false })); await flush(); assert.equal(calls.getRunCaptures.length, 3)
})

test('route change retires pending store recovery and its late success cannot refresh the new page', async t => {
  const { h, calls } = await setup(t); calls.getRunCaptures[0].reject(recoveryRequired); await flush(); await h.click('recover-store')
  await h.navigate(`/captures?simulation=sim_A&capture=${LEFT}`)
  assert.equal(calls.recoverRunCaptureStore[0].signal.aborted, true)
  const counts = [calls.getRunCaptures.length, calls.getRunCapture.length]
  calls.recoverRunCaptureStore[0].resolve(ok({ recovered: true })); await flush()
  assert.deepEqual([calls.getRunCaptures.length, calls.getRunCapture.length], counts)
})

test('unmount retires store recovery and malformed success remains an explicit retry state', async t => {
  const { h, calls } = await setup(t); calls.getRunCaptures[0].reject(recoveryRequired); await flush(); await h.click('recover-store')
  calls.recoverRunCaptureStore[0].resolve(ok({ recovered: 'yes' })); await flush()
  assert.equal(calls.getRunCaptures.length, 1); assert.ok(h.byId('recover-store')); await h.click('recover-store'); h.unmount()
  assert.equal(calls.recoverRunCaptureStore[1].signal.aborted, true); calls.recoverRunCaptureStore[1].resolve(ok({ recovered: true })); await flush(); assert.equal(calls.getRunCaptures.length, 1)
})

test('successful explicit store recovery reconciles an uncertain save without repeating the save POST', async t => {
  const { h, calls } = await setup(t); await readyPreview(h, calls); await h.click('save'); calls.saveRunCapture[0].reject(new Error('Network Error')); await flush()
  calls.getRunCapture[0].reject(recoveryRequired); await flush(); await h.click('recover-store'); calls.recoverRunCaptureStore[0].resolve(ok({ recovered: true })); await flush()
  assert.equal(calls.getRunCapture.length, 2); assert.equal(calls.saveRunCapture.length, 1)
  calls.getRunCapture[1].resolve(ok(capture(LEFT, 'sim_A', 3, 'First attempt', 'Saved notes'))); await flush(); assert.ok(h.byId('saved-capture'))
})

test('accepted recovery retires pre-recovery reads and lookup so late 503s cannot overwrite refreshed state', async t => {
  const { h, calls } = await setup(t, `/captures?simulation=sim_A&capture=${RIGHT}&left=${LEFT}&right=${RIGHT}`)
  await readyPreview(h, calls); await h.click('save'); calls.saveRunCapture[0].reject(new Error('Network Error')); await flush()
  const oldDetail = calls.getRunCapture[0], oldLookup = calls.getRunCapture[1], oldComparison = calls.compareRunCaptures[0]
  calls.getRunCaptures[0].reject(recoveryRequired); await flush(); await h.click('recover-store'); calls.recoverRunCaptureStore[0].resolve(ok({ recovered: true })); await flush()
  assert.equal(calls.getRunCapture.length, 4); assert.equal(oldDetail.signal.aborted, true); assert.equal(oldLookup.signal.aborted, true); assert.equal(oldComparison.signal.aborted, true)
  calls.getRunCaptures[1].resolve(ok(library([capture()]))); calls.getRunCapture[2].resolve(ok(capture(RIGHT))); calls.compareRunCaptures[1].resolve(ok(comparison())); calls.getRunCapture[3].reject(missing); await flush()
  oldDetail.reject(recoveryRequired); oldLookup.reject(recoveryRequired); oldComparison.reject(recoveryRequired); await flush()
  assert.ok(h.byId('comparison')); assert.ok(h.byId('capture-detail')); assert.equal(h.byId('recover-store'), undefined); assert.equal(h.byId('retry-save').props.disabled, false); assert.equal(calls.saveRunCapture.length, 1)
})
