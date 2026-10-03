import assert from 'node:assert/strict'
import test from 'node:test'
import { mountComparison, deferredApi, flush, ok } from './helpers/comparison-view-fixture.js'

const candidates = ids => ({ candidates: ids.map(id => ({ simulation_id: id, scenario: `Scenario ${id}`, status: 'completed', updated_at: '2026-10-01T10:00:00Z' })), skipped_records: 0 })
const summary = (id, recorded = 3) => ({ simulation_id: id, scenario: `Scenario ${id}`, configured_model: 'saved-model', configured_agents: 10,
  status: 'completed', requested_rounds: 20, last_saved_round: 8, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T11:00:00Z',
  availability: 'complete', warnings: [], metrics: { recorded_actions: recorded, rounds_with_actions: 2,
    platforms: { twitter: { availability: 'complete', recorded_actions: recorded, active_agents: 2 }, reddit: { availability: 'unavailable', recorded_actions: null, active_agents: null } },
    action_types: [{ action_type: 'POST', count: recorded }] } })
export const comparison = (left = 'A', right = 'B', l = 3, r = 5) => ({ left: summary(left, l), right: summary(right, r), generated_at: '2026-10-01T12:00:00Z',
  differences: { recorded_actions: r - l, rounds_with_actions: 0, platforms: { twitter: { recorded_actions: r - l, active_agents: 0 }, reddit: { recorded_actions: null, active_agents: null } },
    action_types: [{ action_type: 'POST', left: l, right: r, difference: r - l }] } })
async function setup(t, path = '/compare?left=A&right=B', locale) {
  const d = deferredApi(), h = await mountComparison({ api: d.api, initialPath: path, locale }); t.after(() => h.unmount())
  return { ...d, h }
}

test('route-owned choices render factual saved counts, context, and right-minus-left differences', async t => {
  const { h, calls } = await setup(t)
  calls.getComparisonCandidates[0].resolve(ok(candidates(['A', 'B']))); calls.compareSavedSimulations[0].resolve(ok(comparison())); await flush()
  assert.equal(h.byId('left-select').props.value, 'A'); assert.equal(h.byId('right-select').props.value, 'B')
  assert.match(h.text(), /latest saved run/i); assert.match(h.text(), /right minus left/i)
  assert.match(h.text(h.byId('metric-recorded_actions')), /3.*5.*\+2/)
  assert.match(h.text(), /saved-model/); assert.match(h.text(), /Requested rounds/); assert.match(h.text(), /Last saved round/)
  assert.equal(h.warnings.length, 0)
})

test('A to B to A route navigation owns replies by request identity even when abort is ignored', async t => {
  const { h, calls } = await setup(t)
  await h.navigate('/compare?left=A&right=C'); await h.navigate('/compare?left=A&right=B')
  assert.equal(calls.compareSavedSimulations.length, 3)
  assert.equal(calls.compareSavedSimulations[0].signal.aborted, true)
  assert.equal(calls.compareSavedSimulations[1].signal.aborted, true)
  calls.compareSavedSimulations[2].resolve(ok(comparison('A', 'B', 30, 50))); await flush()
  calls.compareSavedSimulations[0].resolve(ok(comparison('A', 'B', 3, 5))); calls.compareSavedSimulations[1].reject(new Error('secret stale failure')); await flush()
  assert.match(h.text(h.byId('metric-recorded_actions')), /30.*50.*\+20/)
  assert.doesNotMatch(h.text(), /secret stale failure/)
})

test('changing a select clears old results and writes URL; Swap, Refresh, Back and Forward retain ownership', async t => {
  const { h, calls } = await setup(t)
  calls.compareSavedSimulations[0].resolve(ok(comparison())); await flush()
  await h.change('right-select', 'C')
  assert.equal(h.router.currentRoute.value.query.right, 'C'); assert.equal(h.byId('results'), undefined)
  await h.click('swap'); assert.equal(h.router.currentRoute.value.query.left, 'C'); assert.equal(h.router.currentRoute.value.query.right, 'A')
  const old = calls.compareSavedSimulations.at(-1)
  await h.click('refresh'); assert.equal(old.signal.aborted, true)
  calls.compareSavedSimulations.at(-1).resolve(ok(comparison('C', 'A', 9, 2))); await flush()
  assert.match(h.text(h.byId('metric-recorded_actions')), /9.*2.*-7/)
  old.resolve(ok(comparison('C', 'A', 999, 999))); await flush()
  assert.doesNotMatch(h.text(), /999/)
  await h.back(); assert.equal(h.router.currentRoute.value.query.left, 'A'); assert.equal(h.router.currentRoute.value.query.right, 'C')
  await h.forward(); assert.equal(h.router.currentRoute.value.query.left, 'C')
})

test('candidates never replace missing route IDs and stale refresh replies cannot overwrite choices', async t => {
  const { h, calls } = await setup(t, '/compare?left=missing&right=B')
  await h.click('refresh')
  calls.getComparisonCandidates[1].resolve(ok(candidates(['B', 'C']))); await flush()
  calls.getComparisonCandidates[0].resolve(ok(candidates(['missing', 'B']))); await flush()
  assert.equal(h.byId('left-select').props.value, 'missing')
  assert.match(h.text(), /missing.*not in the saved list/i)
  assert.equal(calls.getComparisonCandidates[0].signal.aborted, true)
  assert.equal(h.byId('left-select').children.filter(n => n.type === 'option').some(n => n.props.value === 'C'), true)
})

test('empty and duplicate selections never issue a comparison request', async t => {
  const { h, calls } = await setup(t, '/compare')
  calls.getComparisonCandidates[0].resolve(ok(candidates([]))); await flush()
  assert.match(h.text(), /No saved simulations/); assert.equal(calls.compareSavedSimulations.length, 0)
  await h.navigate('/compare?left=A&right=A')
  assert.match(h.text(), /two different/); assert.equal(h.byId('compare').props.disabled, true)
  assert.equal(calls.compareSavedSimulations.length, 0)
})

test('partial observations show known counts, unavailable differences as dash, status and translated warnings', async t => {
  const { h, calls } = await setup(t)
  const data = comparison(); data.left.status = 'stopped'; data.left.availability = 'partial'
  data.left.warnings = [{ code: 'invalid_records', platform: 'twitter', count: 2 }, { code: 'unknown_secret_warning' }]
  data.differences.recorded_actions = null; data.differences.action_types[0].difference = null
  calls.compareSavedSimulations[0].resolve(ok(data)); await flush()
  assert.match(h.text(), /Stopped/); assert.match(h.text(), /Partial/); assert.match(h.text(), /2 invalid/)
  assert.match(h.text(h.byId('metric-recorded_actions')), /3.*5.*—/)
  assert.doesNotMatch(h.text(), /unknown_secret_warning/)
  assert.match(h.text(), /unavailable.*zero/i)
})

test('retryable server errors use safe code mapping and Compare retries without altering the URL', async t => {
  const { h, calls } = await setup(t)
  calls.compareSavedSimulations[0].reject({ response: { status: 409, data: { error_code: 'sources_changed', error: '/private/secret token' } } }); await flush()
  assert.match(h.text(), /changed.*try again/i); assert.doesNotMatch(h.text(), /private|secret|token/)
  await h.click('compare'); assert.equal(calls.compareSavedSimulations.length, 2)
  assert.equal(h.router.currentRoute.value.fullPath, '/compare?left=A&right=B')
  calls.compareSavedSimulations[1].resolve(ok(comparison())); await flush(); assert.ok(h.byId('results'))
})

test('hostile labels remain literal text and bilingual translations cover the rendered view', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, '/compare?left=A&right=B', locale)
    const data = comparison(); data.left.scenario = '<img src=x onerror=alert(1)>'; data.left.configured_model = '<script>secret()</script>'
    data.differences.action_types[0].action_type = '<iframe src=x>'
    calls.compareSavedSimulations[0].resolve(ok(data)); await flush()
    assert.ok(h.text().includes('<img src=x onerror=alert(1)>'))
    assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0)
    assert.doesNotMatch(h.text(), /comparison\./)
  }
})

test('unmount aborts both sources and ignores later completion', async t => {
  const { h, calls } = await setup(t)
  h.unmount()
  assert.equal(calls.getComparisonCandidates[0].signal.aborted, true)
  assert.equal(calls.compareSavedSimulations[0].signal.aborted, true)
  calls.getComparisonCandidates[0].resolve(ok(candidates(['A', 'B']))); calls.compareSavedSimulations[0].resolve(ok(comparison())); await flush()
  assert.equal(h.root.children.length, 0)
})

test('actual history heading and selected-history modal buttons navigate to comparison', async t => {
  const { h, calls } = await setup(t, '/')
  calls.getSimulationHistory[0].resolve(ok([{ simulation_id: 'sim_saved', simulation_requirement: 'A saved scenario', project_id: 'P' }])); await flush()
  const card = h.find(n => n.type === 'div' && String(n.props.class).split(' ').includes('project-card'))
  assert.ok(card); card.props.onClick(); await flush()
  await h.click('history-compare-selected')
  assert.equal(h.router.currentRoute.value.path, '/compare'); assert.equal(h.router.currentRoute.value.query.left, 'sim_saved')
  await h.navigate('/'); await h.click('history-compare')
  assert.equal(h.router.currentRoute.value.fullPath, '/compare')
})

test('a complete empty log is zero while an absent partial action type stays unavailable', async t => {
  const { h, calls } = await setup(t)
  const data = comparison('A', 'B', 0, 4)
  data.left.status = 'failed'; data.left.availability = 'partial'; data.left.metrics.recorded_actions = null
  data.left.metrics.platforms.twitter = { availability: 'complete', recorded_actions: 0, active_agents: 0 }
  data.differences.recorded_actions = null
  data.differences.platforms.twitter.recorded_actions = 4
  data.differences.action_types = [{ action_type: 'ONLY_RIGHT', left: null, right: 4, difference: null }]
  calls.compareSavedSimulations[0].resolve(ok(data)); await flush()
  assert.match(h.text(h.byId('metric-recorded_actions')), /—.*4.*—/)
  assert.match(h.text(h.byId('metric-twitter-recorded_actions')), /0.*4.*\+4/)
  const row = h.find(n => n.type === 'tr' && h.text(n).includes('ONLY_RIGHT'))
  assert.match(h.text(row), /ONLY_RIGHT.*—.*4.*—/)
  assert.match(h.text(h.byId('left-summary')), /Saved run status:.*Failed/)
})

test('candidate read failures do not hide a valid URL comparison and refresh can recover the list', async t => {
  const { h, calls } = await setup(t)
  calls.getComparisonCandidates[0].reject(new Error('/secret/candidate/path'))
  calls.compareSavedSimulations[0].resolve(ok(comparison())); await flush()
  assert.ok(h.byId('results')); assert.match(h.text(), /list could not be loaded/)
  assert.doesNotMatch(h.text(), /secret\/candidate/)
  await h.click('refresh')
  calls.getComparisonCandidates[1].resolve(ok({ ...candidates(['A', 'B']), skipped_records: 2 })); await flush()
  assert.match(h.text(), /2 unreadable/); assert.doesNotMatch(h.text(), /list could not be loaded/)
})

test('repeated URL selection parameters are invalid and never reach the API', async t => {
  const { h, calls } = await setup(t, '/compare?left=A&left=B&right=C')
  assert.equal(calls.compareSavedSimulations.length, 0)
  assert.match(h.text(), /invalid selection/); assert.equal(h.byId('compare').props.disabled, true)
  await h.change('left-select', 'A')
  assert.equal(h.router.currentRoute.value.query.left, 'A'); assert.equal(calls.compareSavedSimulations.length, 1)
})

test('late success, rejection and finally cannot clear the newer request loading state', async t => {
  const { h, calls } = await setup(t)
  await h.click('refresh')
  calls.compareSavedSimulations[0].reject(new Error('retired failure'))
  calls.getComparisonCandidates[0].resolve(ok(candidates(['old']))); await flush()
  assert.match(h.text(), /Reading the selected/); assert.match(h.text(), /Loading saved simulations/)
  assert.doesNotMatch(h.text(), /retired failure/)
  calls.compareSavedSimulations[1].resolve(ok(comparison())); calls.getComparisonCandidates[1].resolve(ok(candidates(['A', 'B']))); await flush()
  assert.doesNotMatch(h.text(), /Reading the selected|Loading saved simulations/)
})

test('replies for the wrong pair are rejected even when they belong to the current request', async t => {
  const { h, calls } = await setup(t)
  calls.compareSavedSimulations[0].resolve(ok(comparison('C', 'D'))); await flush()
  assert.equal(h.byId('results'), undefined); assert.match(h.text(), /could not be loaded/)
})

for (const [code, expected] of [
  ['invalid_selection', /different, valid simulation IDs/],
  ['unsafe_path', /cannot be safely read/],
  ['simulation_not_found', /no longer exists/],
  ['simulation_unreadable', /record could not be read/],
  ['simulation_active', /marked active/],
  ['unknown_private_code', /comparison could not be loaded/],
]) test(`server error ${code} has a safe, actionable presentation`, async t => {
  const { h, calls } = await setup(t)
  calls.compareSavedSimulations[0].reject({ response: { data: { error_code: code, error: 'SECRET_BACKEND_DETAIL' } } }); await flush()
  assert.match(h.text(), expected); assert.doesNotMatch(h.text(), /SECRET_BACKEND_DETAIL|unknown_private_code/)
})

test('selection controls are labeled, result tables have headers, and navigation clears pending observers', async t => {
  const { h, calls } = await setup(t)
  for (const side of ['left', 'right']) {
    const select = h.byId(`${side}-select`)
    assert.ok(h.find(n => n.type === 'label' && n.props.for === select.props.id))
    assert.ok(h.find(n => n.props.id === select.props['aria-describedby']))
  }
  calls.compareSavedSimulations[0].resolve(ok(comparison())); await flush()
  assert.equal(h.all(n => n.type === 'caption').length, 2)
  assert.ok(h.all(n => n.type === 'th' && n.props.scope === 'col').length >= 8)
  await h.click('refresh'); await h.navigate('/')
  assert.equal(calls.compareSavedSimulations.at(-1).signal.aborted, true)
  assert.equal(calls.getComparisonCandidates.at(-1).signal.aborted, true)
})

for (const [locale, idle] of [['en', 'Idle'], ['zh', '空闲']]) {
  test(`saved idle status stays explicit in ${locale} choices and summaries`, async t => {
    const { h, calls } = await setup(t, '/compare?left=A&right=B', locale)
    const list = candidates(['A', 'B']); list.candidates[0].status = 'idle'
    const data = comparison(); data.left.status = 'idle'; data.left.availability = 'unavailable'
    data.left.metrics.recorded_actions = null; data.differences.recorded_actions = null
    data.left.warnings = [{ code: 'run_not_terminal' }]
    calls.getComparisonCandidates[0].resolve(ok(list)); calls.compareSavedSimulations[0].resolve(ok(data)); await flush()
    assert.ok(h.text(h.byId('left-select')).includes(idle))
    assert.ok(h.text(h.byId('left-summary')).includes(idle))
    assert.match(h.text(h.byId('metric-recorded_actions')), /—.*5.*—/)
  })
}
