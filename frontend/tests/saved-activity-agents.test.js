import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { setup, resolve, overview, overviewRows, records, pair, revision, newRevision, flush, ok } from './helpers/saved-activity-agents-view-fixture.js'

const path = '/simulation/sim_A/activity/agents'
const event = () => ({ preventDefault() {}, stopPropagation() {} })
const visiblePairs = h => h.all(n => /^agent-row-/.test(n.props['data-testid'] ?? ''))

// Source-only preparation. The finite reviewed runner executes these mounted
// script/template/router checks only after coordinator release.
test('agent route accepts one observation and acknowledges its revision exactly once', async t => {
  const { h, calls } = await setup(t)
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityAgents')
  assert.equal(calls.getSavedActivityAgents.length, 1)
  await resolve(calls.getSavedActivityAgents[0])
  assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(calls.getSavedActivityAgents.length, 1); assert.equal(calls.getSavedActivity.length, 0)
  assert.ok(h.byId('agents-results')); assert.match(h.text(), /repeated attempts/i)
  assert.match(h.text(), /not an assessment/i); assert.match(h.text(), /Missing IDs.*inactivity/i)
  assert.equal(h.byId('agents-download'), undefined); assert.deepEqual(h.warnings, [])
})

test('agent wrapper allowlists only platform and revision and preserves cancellation', async () => {
  const source = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
  const calls = [], service = { get: (...args) => { calls.push(args); return Promise.resolve({ success: true }) } }
  const api = new Function('service', source + '\nreturn getSavedActivityAgents;')(service)
  const controller = new AbortController(), params = { platform: 'reddit', revision, agent_id: '7', round_from: '0', outcome: 'failed', offset: 50, q: 'omitted' }
  await api('literal?/id', params, controller.signal); await api('sim_A')
  assert.deepEqual(calls, [
    ['/api/simulation/literal%3F%2Fid/saved-action-agents', { params: { platform: 'reddit', revision }, signal: controller.signal }],
    ['/api/simulation/sim_A/saved-action-agents', { params: {}, signal: undefined }],
  ])
  assert.equal(params.q, 'omitted')
})

test('accepted records entry carries only simulation platform and revision', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?platform=twitter&agent_id=0&round_num=2&action_type=POST&q=saved&outcome=failed&offset=50&limit=25&revision=${revision}`)
  assert.equal(h.byId('activity-agents-entry'), undefined)
  const data = records({ filters: { ...records().filters, platform: 'twitter', agent_id: '0', round_num: '2', action_type: 'POST', q: 'saved', outcome: 'failed' }, offset: 50, limit: 25 })
  calls.getSavedActivity[0].resolve(ok(data)); await flush()
  assert.ok(h.byId('activity-rounds-entry')); assert.ok(h.byId('activity-agents-entry'))
  assert.match(h.text(), /filters do not carry over/i)
  await h.click('activity-agents-entry')
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityAgents')
  assert.deepEqual({ ...h.router.currentRoute.value.query }, { platform: 'twitter', revision })
  assert.deepEqual({ ...calls.getSavedActivityAgents[0].args[1] }, { platform: 'twitter', revision })
})

test('entry callbacks retire synchronously on edits and cannot act on replacement same-ID results', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?revision=${revision}`)
  await resolve(calls.getSavedActivity[0], records())
  const old = h.byId('activity-agents-entry').props.onClick
  h.byId('agent-id').props.onInput({ target: { value: '7' } })
  old(event()); await flush()
  assert.equal(calls.getSavedActivityAgents.length, 0); assert.equal(h.router.currentRoute.value.name, 'SavedActivity')
  await h.input('agent-id', ''); await h.click('apply'); await resolve(calls.getSavedActivity.at(-1), records())
  old(event()); await flush(); assert.equal(calls.getSavedActivityAgents.length, 0)
  await h.click('activity-agents-entry'); assert.equal(calls.getSavedActivityAgents.length, 1)
})

test('draft edit cancels a guarded agent entry before it can leave records', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?revision=${revision}`)
  await resolve(calls.getSavedActivity[0], records())
  let release
  h.router.beforeEach(to => to.name === 'SavedActivityAgents' ? new Promise(resolve => { release = resolve }) : true)
  await h.click('activity-agents-entry'); assert.ok(release)
  await h.input('agent-id', '7'); release(true); await flush()
  assert.equal(h.router.currentRoute.value.name, 'SavedActivity'); assert.equal(h.byId('agent-id').props.value, '7')
  assert.equal(calls.getSavedActivityAgents.length, 0); assert.equal(h.byId('activity-agents-entry'), undefined)
})

test('unmount cancels a guarded entry but a completed entry remains on the agent route', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?revision=${revision}`)
  await resolve(calls.getSavedActivity[0], records())
  let release
  h.router.beforeEach(to => to.name === 'SavedActivityAgents' ? new Promise(resolve => { release = resolve }) : true)
  await h.click('activity-agents-entry'); h.unmount(); release(true); await flush()
  assert.notEqual(h.router.currentRoute.value.name, 'SavedActivityAgents'); assert.equal(calls.getSavedActivityAgents.length, 0)
  const second = await setup(t, `/simulation/sim_A/activity?revision=${revision}`)
  await resolve(second.calls.getSavedActivity[0], records()); await second.h.click('activity-agents-entry')
  assert.equal(second.h.router.currentRoute.value.name, 'SavedActivityAgents'); assert.equal(second.calls.getSavedActivityAgents.length, 1)
})

test('25-row local pages keep totals revision and requests fixed and bound both ends', async t => {
  const { h, calls } = await setup(t), data = overviewRows(Array.from({ length: 51 }, (_, i) => pair(String(i))))
  await resolve(calls.getSavedActivityAgents[0], data)
  const summary = h.text(h.byId('agents-matched-count'))
  assert.equal(visiblePairs(h).length, 25); assert.equal(h.byId('agents-first').props.disabled, true)
  await h.click('agents-next'); assert.ok(h.byId('agent-row-twitter-25')); assert.equal(visiblePairs(h).length, 25)
  await h.click('agents-next'); assert.ok(h.byId('agent-row-twitter-50')); assert.equal(visiblePairs(h).length, 1)
  assert.equal(h.byId('agents-next').props.disabled, true)
  h.byId('agents-next').props.onClick(event()); await flush(); assert.ok(h.byId('agent-row-twitter-50'))
  await h.click('agents-previous'); await h.click('agents-first')
  assert.ok(h.byId('agent-row-twitter-0')); assert.equal(h.text(h.byId('agents-matched-count')), summary)
  assert.equal(calls.getSavedActivityAgents.length, 1); assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(h.router.currentRoute.value.query.page, undefined)
})

test('old page and count callbacks cannot revive through page zero to one to zero', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivityAgents[0], overviewRows(Array.from({ length: 26 }, (_, i) => pair(String(i)))))
  const next = h.byId('agents-next').props.onClick, count = h.byId('agent-twitter-0-total').props.onClick
  await h.click('agents-next'); count(event()); await flush(); assert.equal(calls.getSavedActivity.length, 0)
  await h.click('agents-first'); next(event()); count(event()); await flush()
  assert.ok(h.byId('agent-row-twitter-0')); assert.equal(calls.getSavedActivity.length, 0)
})

test('fixed failure total platform exact-ID order preserves adjacent large IDs and zero', async t => {
  const { h, calls } = await setup(t)
  const rows = [pair('8', 'reddit', { count: 4, outcomes: { success: 0, failed: 4, unknown: 0 } }), pair('9', 'reddit', { count: 5, outcomes: { success: 3, failed: 2, unknown: 0 } }), pair('0'), pair('9007199254740992'), pair('9007199254740993'), pair('0', 'reddit')]
  await resolve(calls.getSavedActivityAgents[0], overviewRows(rows))
  assert.deepEqual(visiblePairs(h).map(n => n.props['data-testid']), rows.map(row => `agent-row-${row.platform}-${row.agent_id}`))
  assert.ok(h.text().includes('9007199254740992')); assert.ok(h.text().includes('9007199254740993'))
})

for (const outcome of ['total', 'success', 'failed', 'unknown']) test(`agent ${outcome} count opens exact pair and same revision through the real records route`, async t => {
  const id = '9007199254740993', { h, calls } = await setup(t)
  await resolve(calls.getSavedActivityAgents[0], overviewRows([pair(id), pair(id, 'reddit')]))
  await h.click(`agent-reddit-${id}-${outcome}`)
  assert.equal(h.router.currentRoute.value.name, 'SavedActivity')
  assert.deepEqual({ ...h.router.currentRoute.value.query }, { platform: 'reddit', agent_id: id, ...(outcome === 'total' ? {} : { outcome }), offset: '0', limit: '50', revision })
  assert.equal(calls.getSavedActivity.length, 1); assert.equal(calls.getSavedActivity[0].args[1].agent_id, id)
})

test('64-digit IDs drill exactly and 65-digit IDs stay visible with all counts disabled', async t => {
  const id64 = '9'.repeat(64), id65 = '1' + '0'.repeat(64), { h, calls } = await setup(t)
  await resolve(calls.getSavedActivityAgents[0], overviewRows([pair(id64), pair(id65)]))
  assert.ok(h.text().includes(id65)); assert.match(h.text(), /64-digit limit/)
  for (const column of ['total', 'success', 'failed', 'unknown']) {
    const button = h.byId(`agent-twitter-${id65}-${column}`)
    assert.equal(button.props.disabled, true); button.props.onClick(event())
  }
  await flush(); assert.equal(calls.getSavedActivity.length, 0)
  await h.click(`agent-twitter-${id64}-total`); assert.equal(calls.getSavedActivity[0].args[1].agent_id, id64)
})

test('zero counts and rows removed from the accepted result cannot drill', async t => {
  const { h, calls } = await setup(t), row = pair('0', 'twitter', { count: 1, outcomes: { success: 1, failed: 0, unknown: 0 } }), data = overviewRows([row])
  await resolve(calls.getSavedActivityAgents[0], data)
  assert.equal(h.byId('agent-twitter-0-failed').props.disabled, true)
  h.byId('agent-twitter-0-failed').props.onClick(event()); await flush(); assert.equal(calls.getSavedActivity.length, 0)
  const old = h.byId('agent-twitter-0-total').props.onClick
  data.agents.splice(0, 1); old(event()); await flush(); assert.equal(calls.getSavedActivity.length, 0)
})

test('retired count and page closures cannot use a refreshed replacement observation', async t => {
  const { h, calls } = await setup(t)
  const data = overviewRows(Array.from({ length: 26 }, (_, i) => pair(String(i))))
  await resolve(calls.getSavedActivityAgents[0], data)
  const count = h.byId('agent-twitter-0-total').props.onClick, next = h.byId('agents-next').props.onClick
  await h.click('agents-refresh'); count(event()); next(event()); await flush()
  await resolve(calls.getSavedActivityAgents[1], overviewRows(data.agents, { source_revision: newRevision }))
  count(event()); next(event()); await flush()
  assert.equal(calls.getSavedActivity.length, 0); assert.ok(h.byId('agent-row-twitter-0'))
  assert.equal(h.router.currentRoute.value.query.revision, newRevision)
})

test('draft edit cancels guarded count navigation and Apply preserves the accepted revision', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  let release
  h.router.beforeEach(to => to.name === 'SavedActivity' ? new Promise(resolve => { release = resolve }) : true)
  await h.click('agent-twitter-0-failed'); assert.ok(release)
  await h.change('agents-platform', 'reddit'); release(true); await flush()
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityAgents'); assert.equal(h.byId('agents-platform').props.value, 'reddit')
  assert.equal(calls.getSavedActivity.length, 0); assert.equal(h.byId('agents-results'), undefined)
  await h.click('agents-apply'); assert.deepEqual({ ...calls.getSavedActivityAgents[1].args[1] }, { platform: 'reddit', revision })
})

test('Refresh supersedes a guarded count navigation and observes without old revision', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  let release
  h.router.beforeEach(to => to.name === 'SavedActivity' ? new Promise(resolve => { release = resolve }) : true)
  await h.click('agent-twitter-0-total'); await h.click('agents-refresh')
  release(true); await flush()
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityAgents'); assert.equal(calls.getSavedActivity.length, 0)
  assert.equal(calls.getSavedActivityAgents[1].args[1].revision, undefined)
})

test('A to B to A late successes errors and count callbacks cannot replace current work', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  const old = h.byId('agent-twitter-0-total').props.onClick
  await h.navigate('/simulation/sim_B/activity/agents'); await h.navigate(path)
  assert.equal(calls.getSavedActivityAgents[0].signal.aborted, true)
  calls.getSavedActivityAgents[1].reject(new Error('PRIVATE_STALE')); await flush()
  assert.ok(h.byId('agents-loading')); assert.equal(h.byId('agents-error'), undefined)
  await resolve(calls.getSavedActivityAgents[2]); old(event()); await flush()
  assert.ok(h.byId('agents-results')); assert.equal(calls.getSavedActivity.length, 0); assert.doesNotMatch(h.text(), /PRIVATE_STALE/)
})

test('ignored abort after draft edit cannot render and late old success cannot clear a newer loader', async t => {
  const { h, calls } = await setup(t)
  await h.change('agents-platform', 'twitter'); assert.equal(calls.getSavedActivityAgents[0].signal.aborted, true)
  await h.click('agents-apply'); await resolve(calls.getSavedActivityAgents[0])
  assert.ok(h.byId('agents-loading')); assert.equal(h.byId('agents-results'), undefined)
  await resolve(calls.getSavedActivityAgents[1], overview({ filters: { platform: 'twitter' } }))
  assert.ok(h.byId('agents-results'))
})

test('Back and Forward restore applied platform revision and retire the unapplied draft', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  await h.change('agents-platform', 'twitter'); await h.click('agents-apply'); await h.change('agents-platform', 'reddit')
  await h.back(); assert.equal(h.byId('agents-platform').props.value, ''); assert.equal(calls.getSavedActivityAgents.length, 3)
  await h.forward(); assert.equal(h.byId('agents-platform').props.value, 'twitter'); assert.equal(calls.getSavedActivityAgents.length, 4)
  assert.equal(calls.getSavedActivityAgents[3].args[1].revision, revision)
})

test('unmount retires pending reads and guarded count navigation', async t => {
  const first = await setup(t), request = first.calls.getSavedActivityAgents[0]
  first.h.unmount(); assert.equal(request.signal.aborted, true); await resolve(request)
  assert.equal(first.h.root.children.length, 0)
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  let release
  h.router.beforeEach(to => to.name === 'SavedActivity' ? new Promise(resolve => { release = resolve }) : true)
  const old = h.byId('agent-twitter-0-total').props.onClick
  await h.click('agent-twitter-0-total'); h.unmount(); release(true); old(event()); await flush()
  assert.notEqual(h.router.currentRoute.value.name, 'SavedActivity'); assert.equal(calls.getSavedActivity.length, 0)
})

test('delayed revision acknowledgement cannot revive an edited result or replace a new simulation', async t => {
  const { h, calls } = await setup(t)
  let release
  h.router.beforeEach(to => to.params.simulationId === 'sim_A' && to.query.revision ? new Promise(resolve => { release = resolve }) : true)
  calls.getSavedActivityAgents[0].resolve(ok(overview())); await flush(); assert.ok(release)
  await h.change('agents-platform', 'reddit'); release(true); await flush()
  assert.equal(h.byId('agents-platform').props.value, 'reddit'); assert.equal(h.byId('agents-results'), undefined); assert.equal(calls.getSavedActivityAgents.length, 1)
  const second = await setup(t); let releaseSecond
  second.h.router.beforeEach(to => to.params.simulationId === 'sim_A' && to.query.revision ? new Promise(resolve => { releaseSecond = resolve }) : true)
  second.calls.getSavedActivityAgents[0].resolve(ok(overview())); await flush()
  await second.h.navigate('/simulation/sim_B/activity/agents?platform=reddit'); releaseSecond(true); await flush()
  assert.equal(second.h.router.currentRoute.value.params.simulationId, 'sim_B'); assert.equal(second.calls.getSavedActivityAgents.length, 2)
})

test('refused acknowledgement rejects the result and stale rejected navigation stays silent', async t => {
  const { h, calls } = await setup(t)
  h.router.beforeEach(to => !to.query.revision); await resolve(calls.getSavedActivityAgents[0])
  assert.equal(h.byId('agents-results'), undefined); assert.ok(h.byId('agents-error'))
  const second = await setup(t); let reject
  second.h.router.replace = () => new Promise((_resolve, fail) => { reject = fail })
  second.calls.getSavedActivityAgents[0].resolve(ok(overview())); await flush()
  await second.h.change('agents-platform', 'reddit'); reject(new Error('PRIVATE_OLD_ACK')); await flush()
  assert.equal(second.h.byId('agents-results'), undefined); assert.equal(second.h.byId('agents-error'), undefined)
})

test('empty complete partial and unavailable observations remain visibly distinct in both locales', async t => {
  for (const locale of ['en', 'zh']) for (const availability of ['complete', 'partial', 'unavailable']) {
    const { h, calls } = await setup(t, path, locale), unavailable = availability === 'unavailable'
    await resolve(calls.getSavedActivityAgents[0], overviewRows([], { availability, matched_count: unavailable ? null : 0, outcomes: { success: unavailable ? null : 0, failed: unavailable ? null : 0, unknown: unavailable ? null : 0 }, platform_availability: { twitter: availability, reddit: 'unavailable' }, warnings: availability === 'complete' ? [] : [{ code: 'source_unreadable', platform: 'reddit' }] }))
    assert.ok(h.byId('agents-empty')); assert.equal(visiblePairs(h).length, 0)
    if (locale === 'en') assert.match(h.text(h.byId('agents-empty')), unavailable ? /unavailable.*unknown/ : availability === 'partial' ? /No admitted attempts.*partial/ : /No recorded action attempts/)
    assert.equal(Boolean(h.byId('agents-partial')), availability === 'partial')
    assert.doesNotMatch(h.text(), /savedActivityAgents\.|comparison\.|savedActivity\./); assert.deepEqual(h.warnings, [])
  }
})

test('partial nonempty counts and stopped status remain independent and labels are bilingual', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, path, locale), literal = '<img src=x onerror=evil()>'
    await resolve(calls.getSavedActivityAgents[0], overview({ availability: 'partial', platform_availability: { twitter: 'partial', reddit: 'unavailable' }, warnings: [{ code: 'partial_run' }, { code: 'invalid_records', platform: 'twitter', count: 1 }, { code: 'future_warning' }], context: { ...overview().context, status: 'stopped', created_at: literal } }))
    assert.ok(h.byId('agents-partial')); assert.ok(h.text().includes(literal)); assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0)
    assert.equal(h.all(n => n.type === 'th' && n.props.scope === 'col').length, 6)
    assert.ok(h.find(n => n.type === 'label' && n.props.for === h.byId('agents-platform').props.id))
    assert.match(h.byId('agent-twitter-0-failed').props['aria-label'], /0/)
    assert.doesNotMatch(h.text(), /savedActivityAgents\.|comparison\.|savedActivity\./); assert.deepEqual(h.warnings, [])
  }
})

test('invalid repeated empty unknown and record-filter URL fields never issue an overview read', async t => {
  const queries = ['platform=', 'platform=other', 'platform=twitter&platform=reddit', 'revision=', 'revision=bad', `revision=${revision}&revision=${revision}`, 'agent_id=0', 'round_from=0', 'round_num=0', 'q=word', 'outcome=failed', 'offset=0', 'limit=25', 'unknown=x']
  for (const query of queries) {
    const { h, calls } = await setup(t, `${path}?${query}`)
    assert.equal(calls.getSavedActivityAgents.length, 0, query); assert.ok(h.byId('agents-error'), query)
  }
})

test('strict response identity keys types counts platform coverage and exact IDs reject malformed observations', async t => {
  const cases = [
    { simulation_id: 'other' }, { source_revision: newRevision }, { filters: { platform: 'reddit' } }, { filters: { platform: null, q: null } }, { order: 'most_attempts' },
    { matched_count: 4 }, { pair_count: 2 }, { outcomes: { success: 2, failed: 1, unknown: 0 } }, { matched_count: -1 }, { matched_count: 500001 }, { matched_count: 3.1 },
    { agents: [pair('00')] }, { agents: [pair(0)] }, { agents: [pair('-1')] }, { agents: [pair('0', 'other')] }, { agents: [pair('0', 'twitter', { count: 0 })] },
    { agents: [pair('0', 'twitter', { outcomes: { success: 0, failed: 1, unknown: 1 } })] }, { agents: [pair('0', 'twitter', { drilldown_supported: false })] },
    { agents: [pair('1'.repeat(65), 'twitter', { drilldown_supported: true })] }, { agents: [pair('0', 'twitter', { private_profile: 'ignored?' })] },
    { private_data: 'unexpected' }, { outcomes: { success: 1, failed: 1, unknown: 1, other: 0 } }, { context: { ...overview().context, requested_rounds: 20 } },
    { platform_availability: { twitter: 'unavailable', reddit: 'complete' } }, { warnings: [{ code: 'invalid_records', path: 'private' }] }, { availability: 'unavailable' },
  ]
  for (const changes of cases) {
    const { h, calls } = await setup(t, `${path}?revision=${revision}`)
    await resolve(calls.getSavedActivityAgents[0], overview(changes))
    assert.equal(h.byId('agents-results'), undefined, JSON.stringify(changes)); assert.ok(h.byId('agents-error'))
  }
})

test('selected platform must agree with response scope coverage and every row', async t => {
  for (const changes of [ { agents: [pair('0', 'reddit')] }, { availability: 'partial' }, { filters: { platform: null } } ]) {
    const { h, calls } = await setup(t, `${path}?platform=twitter&revision=${revision}`)
    await resolve(calls.getSavedActivityAgents[0], overview({ filters: { platform: 'twitter' }, ...changes }))
    assert.equal(h.byId('agents-results'), undefined); assert.ok(h.byId('agents-error'))
  }
})

test('duplicates all four order tie breakers and both refusal caps are validated', async t => {
  const rows = [
    [pair('0'), pair('0')], [pair('2'), pair('1')], [pair('9007199254740993'), pair('9007199254740992')],
    [pair('0', 'reddit'), pair('0')],
    [pair('0'), pair('1', 'twitter', { count: 4, outcomes: { success: 2, failed: 1, unknown: 1 } })],
    [pair('0'), pair('1', 'twitter', { count: 3, outcomes: { success: 0, failed: 2, unknown: 1 } })],
    Array.from({ length: 1001 }, (_, i) => pair(String(i))), [pair('1'.repeat(1024 * 1024))],
  ]
  for (const agents of rows) {
    const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0], overviewRows(agents))
    assert.equal(h.byId('agents-results'), undefined); assert.ok(h.byId('agents-error'))
  }
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0], overviewRows(Array.from({ length: 1000 }, (_, i) => pair(String(i)))))
  assert.ok(h.byId('agents-results')); assert.equal(visiblePairs(h).length, 25)
})

test('outer envelope and missing exact response or row keys are refused', async t => {
  for (const response of [{ success: 1, data: overview() }, { success: 'true', data: overview() }, { success: true, data: overview(), extra: true }]) {
    const { h, calls } = await setup(t); calls.getSavedActivityAgents[0].resolve(response); await flush()
    assert.equal(h.byId('agents-results'), undefined); assert.ok(h.byId('agents-error'))
  }
  for (const missing of ['observed_at', 'drilldown_supported', 'unknown']) {
    const { h, calls } = await setup(t), data = overview()
    if (missing === 'observed_at') delete data.observed_at
    else if (missing === 'unknown') delete data.agents[0].outcomes.unknown
    else delete data.agents[0].drilldown_supported
    await resolve(calls.getSavedActivityAgents[0], data); assert.equal(h.byId('agents-results'), undefined); assert.ok(h.byId('agents-error'))
  }
})

test('overview cap errors give bounded recovery and sources changed requires explicit Refresh', async t => {
  for (const code of ['too_many_agent_pairs', 'response_too_large', 'sources_changed']) {
    const { h, calls } = await setup(t, `${path}?platform=twitter&revision=${revision}`)
    calls.getSavedActivityAgents[0].reject({ response: { data: { error_code: code, error: 'PRIVATE_PATH' } } }); await flush()
    assert.ok(h.byId('agents-error')); assert.doesNotMatch(h.text(), /PRIVATE_PATH/)
    if (code !== 'sources_changed') assert.match(h.text(), /single platform may still exceed/i)
    await h.click('agents-refresh'); assert.deepEqual({ ...calls.getSavedActivityAgents[1].args[1] }, { platform: 'twitter' })
  }
})

test('a successful overview does not waive existing detail response-size refusal or refresh semantics', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  await h.click('agent-twitter-0-total')
  calls.getSavedActivity[0].reject({ response: { data: { error_code: 'response_too_large' } } }); await flush()
  assert.ok(h.byId('error')); assert.equal(h.byId('results'), undefined)
  assert.equal(calls.getSavedActivity.length, 1); assert.equal(h.router.currentRoute.value.query.revision, revision)
  await h.click('refresh'); assert.equal(calls.getSavedActivity[1].args[1].revision, undefined)
})

for (const control of ['agents-apply', 'agents-refresh']) test(`draft edits during delayed ${control} preserve the latest draft until Apply`, async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  let release, delayed = false
  h.router.beforeEach(() => { if (!delayed) { delayed = true; return new Promise(resolve => { release = resolve }) } return true })
  if (control === 'agents-apply') await h.change('agents-platform', 'twitter')
  await h.click(control); assert.ok(release); await h.change('agents-platform', 'reddit'); release(true); await flush()
  assert.equal(h.byId('agents-platform').props.value, 'reddit'); assert.equal(h.byId('agents-results'), undefined); assert.equal(calls.getSavedActivityAgents.length, 1)
  await h.click('agents-apply'); assert.equal(calls.getSavedActivityAgents[1].args[1].platform, 'reddit')
})

test('same-URL Apply supersedes older guarded navigation without stale response or page revival', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityAgents[0])
  let release
  h.router.beforeEach(to => to.query.platform === 'twitter' ? new Promise(resolve => { release = resolve }) : true)
  await h.change('agents-platform', 'twitter'); await h.click('agents-apply')
  await h.change('agents-platform', ''); await h.click('agents-apply')
  release(true); await flush()
  assert.equal(h.router.currentRoute.value.query.platform, undefined); assert.equal(calls.getSavedActivityAgents.length, 2)
  await resolve(calls.getSavedActivityAgents[1]); assert.ok(h.byId('agents-results')); assert.equal(h.byId('agents-error'), undefined)
})
