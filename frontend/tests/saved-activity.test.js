import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedActivity, deferredApi, flush, ok } from './helpers/saved-activity-view-fixture.js'

const revision = 'a'.repeat(64), newRevision = 'b'.repeat(64)
const row = (id = 'twitter:1', overrides = {}) => ({ record_id: id, platform: 'twitter', round_num: '0', agent_id: '900719925474099312345', agent_name: 'Saved agent', timestamp: null, action_type: 'POST', success: false, details_json: '{"agent_id":900719925474099312345,"text":"<img src=x onerror=alert(1)>","success":false}', ...overrides })
export const activity = (overrides = {}) => ({ simulation_id: 'sim_A', source_revision: revision, observed_at: '2026-10-03T09:00:00Z', context: { status: 'completed', created_at: '2026-10-01T09:00:00Z', updated_at: null, started_at: null, completed_at: null, requested_rounds: '20', last_saved_round: '0' }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'unavailable' }, warnings: [], filters: { platform: null, agent_id: null, round_num: null, action_type: null }, order: 'source_record', offset: 0, limit: 50, returned_count: 1, matched_count: 1, has_more: false, actions: [row()], ...overrides })
async function setup(t, initialPath = '/simulation/sim_A/activity', locale = 'en') {
  const d = deferredApi(), h = await mountSavedActivity({ api: d.api, initialPath, locale }); t.after(() => h.unmount())
  return { ...d, h }
}
async function resolve(call, data = activity()) { call.resolve(ok(data)); await flush() }

// Removing request identity, full-tuple matching, synchronous retirement, or URL
// acknowledgement must break these mounted script/template/router regressions.
test('fresh saved page acknowledges revision exactly once and renders literal saved records', async t => {
  const { h, calls } = await setup(t)
  assert.equal(calls.getSavedActivity.length, 1)
  assert.equal(calls.getSavedActivity[0].args[0], 'sim_A')
  await resolve(calls.getSavedActivity[0])
  assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(calls.getSavedActivity.length, 1)
  assert.ok(h.byId('results')); assert.match(h.text(), /latest saved run/i)
  assert.match(h.text(), /Saved run status.*Completed/); assert.match(h.text(), /source.*file order/i)
  assert.ok(h.text().includes('900719925474099312345'))
  assert.ok(h.text().includes(activity().actions[0].details_json))
  assert.match(h.text(), /Failed/); assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0)
  assert.deepEqual(h.warnings, [])
})

test('draft edits synchronously retire pending work and old export even if abort is ignored', async t => {
  const { h, calls } = await setup(t)
  const first = calls.getSavedActivity[0]
  h.byId('agent-id').props.onInput({ target: { value: '0' } })
  assert.equal(first.signal.aborted, true)
  await resolve(first)
  assert.equal(Boolean(h.byId('results')), false); assert.equal(h.byId('download').props.disabled, true)
  await h.click('apply')
  assert.equal(h.router.currentRoute.value.query.agent_id, '0')
  assert.equal(calls.getSavedActivity.length, 2)
  await resolve(calls.getSavedActivity[1], activity({ filters: { ...activity().filters, agent_id: '0' }, actions: [row('twitter:1', { agent_id: '0' })] }))
  assert.ok(h.byId('results'))
  h.byId('round-num').props.onInput({ target: { value: '0000' } })
  await flush(); assert.equal(Boolean(h.byId('results')), false)
  await h.submit('activity-form')
  assert.equal(h.router.currentRoute.value.query.round_num, '0')
  assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(calls.getSavedActivity.at(-1).args[1].revision, revision)
})

test('pages, Back and Forward retain observed revision and complete URL-owned filters', async t => {
  const { h, calls } = await setup(t, '/simulation/sim_A/activity?limit=1&agent_id=0000')
  await resolve(calls.getSavedActivity[0], activity({ filters: { ...activity().filters, agent_id: '0' }, limit: 1, matched_count: 3, has_more: true, actions: [row('twitter:1', { agent_id: '0' })] }))
  await h.click('next')
  assert.equal(h.router.currentRoute.value.query.offset, '1'); assert.equal(h.router.currentRoute.value.query.revision, revision)
  await resolve(calls.getSavedActivity[1], activity({ filters: { ...activity().filters, agent_id: '0' }, offset: 1, limit: 1, matched_count: 3, has_more: true, actions: [row('twitter:2', { agent_id: '0' })] }))
  await h.click('next'); assert.equal(h.router.currentRoute.value.query.offset, '2')
  await h.back(); assert.equal(h.router.currentRoute.value.query.offset, '1')
  await h.forward(); assert.equal(h.router.currentRoute.value.query.offset, '2')
  await resolve(calls.getSavedActivity.at(-1), activity({ filters: { ...activity().filters, agent_id: '0' }, offset: 2, limit: 1, matched_count: 3, has_more: false, actions: [row('reddit:1', { platform: 'reddit', agent_id: '0' })] }))
  await h.click('first'); assert.equal(h.router.currentRoute.value.query.offset, '0')
  assert.equal(calls.getSavedActivity.at(-1).args[1].revision, revision)
})

test('A to B to A and late success, rejection, finally cannot affect newer request', async t => {
  const { h, calls } = await setup(t)
  await h.navigate('/simulation/sim_B/activity'); await h.navigate('/simulation/sim_A/activity')
  assert.equal(calls.getSavedActivity.length, 3)
  assert.equal(calls.getSavedActivity[0].signal.aborted, true)
  calls.getSavedActivity[0].reject(new Error('PRIVATE_STALE_ERROR'))
  await resolve(calls.getSavedActivity[1], activity({ simulation_id: 'sim_B' }))
  assert.ok(h.byId('loading')); assert.equal(Boolean(h.byId('results')), false)
  await resolve(calls.getSavedActivity[2], activity({ actions: [row('twitter:3', { agent_name: 'Current observation' })] }))
  assert.match(h.text(), /Current observation/); assert.doesNotMatch(h.text(), /PRIVATE_STALE_ERROR/)
})

for (const [name, changes] of [
  ['simulation', { simulation_id: 'sim_other' }], ['revision', { source_revision: newRevision }],
  ['filters', { filters: { ...activity().filters, platform: 'reddit' } }], ['offset', { offset: 1 }],
  ['limit', { limit: 10 }], ['order', { order: 'timestamp' }], ['string ID', { actions: [row('twitter:1', { agent_id: 1 })] }],
]) test(`rejects a current response with incorrect ${name}`, async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?revision=${revision}`)
  await resolve(calls.getSavedActivity[0], activity(changes))
  assert.equal(Boolean(h.byId('results')), false); assert.ok(h.byId('error')); assert.equal(h.byId('download').props.disabled, true)
})

for (const query of ['offset=1', 'offset=-1', 'offset=500001', 'limit=0', 'limit=101', 'revision=bad', 'platform=other', 'agent_id=-1', 'round_num=1e3', 'agent_id=1&agent_id=2', 'unknown=x', `agent_id=${'1'.repeat(65)}`, 'action_type=%0A']) {
  test(`invalid URL ${query} cannot issue a request`, async t => {
    const { h, calls } = await setup(t, '/simulation/sim_A/activity?' + query)
    assert.equal(calls.getSavedActivity.length, 0); assert.ok(h.byId('error'))
  })
}

test('sources changed is safe and explicit Refresh resets page and revision', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?offset=50&revision=${revision}`)
  calls.getSavedActivity[0].reject({ response: { status: 409, data: { error_code: 'sources_changed', error: '/private/path secret' } } }); await flush()
  assert.match(h.text(), /changed.*Refresh/i); assert.doesNotMatch(h.text(), /private\/path|secret/)
  await h.click('refresh')
  assert.equal(h.router.currentRoute.value.query.offset, '0'); assert.equal(h.router.currentRoute.value.query.revision, undefined)
  assert.equal(calls.getSavedActivity[1].args[1].revision, undefined)
  await resolve(calls.getSavedActivity[1], activity({ source_revision: newRevision }))
  assert.equal(h.router.currentRoute.value.query.revision, newRevision); assert.equal(calls.getSavedActivity.length, 2)
})

test('matched null, true zero and out-of-range pages have distinct states', async t => {
  for (const [data, expected] of [
    [activity({ availability: 'unavailable', matched_count: null, returned_count: 0, actions: [] }), /unavailable/i],
    [activity({ matched_count: 0, returned_count: 0, actions: [] }), /No matching recorded attempts/],
    [activity({ offset: 50, matched_count: 1, returned_count: 0, actions: [] }), /beyond the matching/],
  ]) {
    const { h, calls } = await setup(t, `/simulation/sim_A/activity?offset=${data.offset}&revision=${revision}`)
    await resolve(calls.getSavedActivity[0], data)
    assert.match(h.text(h.byId('empty-state')), expected)
    assert.match(h.text(h.byId('matched-count')), data.matched_count === null ? /—/ : new RegExp(String(data.matched_count)))
  }
})

test('page export preserves exact accepted data and payload bytes; edits revoke and disable it', async t => {
  const { h, calls } = await setup(t)
  const data = activity({ availability: 'partial', warnings: [{ code: 'invalid_records', platform: 'twitter', count: 2 }], actions: [row('twitter:1', { success: null })] })
  await resolve(calls.getSavedActivity[0], data)
  await h.click('download'); assert.equal(h.downloads.length, 1)
  const download = h.downloads[0]
  assert.match(download.filename, /sim_A.*page.*json$/)
  assert.equal(await download.blob.text(), JSON.stringify({ format_version: 1, ...data }, null, 2) + '\n')
  assert.match(h.text(), /Unknown/); assert.match(h.text(), /2 invalid/); assert.match(h.text(), /this page/i)
  await h.input('action-type', 'POST')
  assert.deepEqual(h.revokedUrls, [download.url]); assert.equal(h.byId('download').props.disabled, true)
})

test('all filters apply exactly, preserve huge decimal IDs, and remain accessible in both locales', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, '/simulation/sim_A/activity', locale)
    await resolve(calls.getSavedActivity[0])
    await h.change('platform', 'twitter'); await h.input('agent-id', '900719925474099312345')
    await h.input('round-num', '0'); await h.input('action-type', '<script>saved()</script>'); await h.change('page-size', '1')
    await h.click('apply')
    const params = calls.getSavedActivity.at(-1).args[1]
    assert.equal(params.agent_id, '900719925474099312345'); assert.equal(params.action_type, '<script>saved()</script>')
    assert.equal(params.round_num, '0'); assert.equal(params.platform, 'twitter'); assert.equal(params.limit, 1)
    await resolve(calls.getSavedActivity.at(-1), activity({ limit: 1, filters: { platform: 'twitter', agent_id: params.agent_id, round_num: '0', action_type: params.action_type }, actions: [row('twitter:1', { action_type: params.action_type })] }))
    assert.ok(h.byId('results')); assert.doesNotMatch(h.text(), /savedActivity\.|comparison\./)
    for (const id of ['platform', 'agent-id', 'round-num', 'action-type', 'page-size']) {
      assert.ok(h.find(n => n.type === 'label' && n.props.for === h.byId(id).props.id))
    }
    assert.ok(h.all(n => n.type === 'th' && n.props.scope === 'col').length >= 7)
    assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0)
    assert.deepEqual(h.warnings, [])
  }
})

test('selected History entry opens the saved-only route and unmount retires observers', async t => {
  const { h, calls } = await setup(t, '/')
  calls.getSimulationHistory[0].resolve(ok([{ simulation_id: 'sim_A', simulation_requirement: 'A saved scenario', project_id: 'P' }])); await flush()
  h.find(n => n.type === 'div' && String(n.props.class).split(' ').includes('project-card')).props.onClick(); await flush()
  await h.click('history-saved-activity')
  assert.equal(h.router.currentRoute.value.name, 'SavedActivity'); assert.equal(h.router.currentRoute.value.params.simulationId, 'sim_A')
  assert.equal(calls.getSavedActivity.length, 1)
  h.unmount(); assert.equal(calls.getSavedActivity[0].signal.aborted, true)
  await resolve(calls.getSavedActivity[0]); assert.equal(h.root.children.length, 0)
})


test('an acknowledgement delayed by a router guard cannot revive a retired draft request', async t => {
  const { h, calls } = await setup(t)
  let release, entered = false
  h.router.beforeEach(to => {
    if (to.query.revision && !entered) {
      entered = true
      return new Promise(resolve => { release = resolve })
    }
  })
  calls.getSavedActivity[0].resolve(ok(activity())); await flush()
  assert.equal(entered, true); assert.equal(h.router.currentRoute.value.query.revision, undefined)
  await h.input('agent-id', '0')
  assert.equal(calls.getSavedActivity[0].signal.aborted, true)
  release(true); await flush()
  assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(h.byId('agent-id').props.value, '0')
  assert.equal(Boolean(h.byId('results')), false); assert.equal(h.byId('download').props.disabled, true)
  assert.equal(calls.getSavedActivity.length, 1)
  await h.click('apply')
  assert.equal(calls.getSavedActivity.length, 2)
  assert.equal(calls.getSavedActivity[1].args[1].agent_id, '0')
  assert.equal(calls.getSavedActivity[1].args[1].revision, revision)
})

test('a superseded acknowledgement cannot overwrite another simulation or its pending load', async t => {
  const { h, calls } = await setup(t)
  let release
  h.router.beforeEach(to => to.params.simulationId === 'sim_A' && to.query.revision ? new Promise(resolve => { release = resolve }) : true)
  calls.getSavedActivity[0].resolve(ok(activity())); await flush()
  assert.ok(release)
  await h.navigate('/simulation/sim_B/activity?platform=reddit')
  release(true); await flush()
  assert.equal(h.router.currentRoute.value.params.simulationId, 'sim_B')
  assert.equal(h.router.currentRoute.value.query.revision, undefined)
  assert.equal(h.byId('platform').props.value, 'reddit'); assert.ok(h.byId('loading'))
  assert.equal(Boolean(h.byId('results')), false); assert.equal(calls.getSavedActivity.length, 2)
  await resolve(calls.getSavedActivity[1], activity({ simulation_id: 'sim_B', source_revision: newRevision, filters: { ...activity().filters, platform: 'reddit' }, actions: [row('reddit:1', { platform: 'reddit' })] }))
  assert.ok(h.byId('results')); assert.equal(h.router.currentRoute.value.query.revision, newRevision)
})

test('rejecting an old acknowledgement cannot surface an error after a draft edit', async t => {
  const { h, calls } = await setup(t)
  let reject
  const original = h.router.replace
  h.router.replace = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise })
  calls.getSavedActivity[0].resolve(ok(activity())); await flush()
  await h.input('round-num', '7')
  reject(new Error('PRIVATE_OLD_ACK')); await flush()
  assert.equal(h.byId('error'), undefined); assert.equal(h.byId('loading'), undefined)
  assert.equal(Boolean(h.byId('results')), false); assert.equal(h.byId('round-num').props.value, '7')
  assert.equal(calls.getSavedActivity.length, 1)
  h.router.replace = original
})

test('a refused revision acknowledgement cannot expose a page absent from its URL', async t => {
  const { h, calls } = await setup(t)
  h.router.beforeEach(to => !to.query.revision)
  await resolve(calls.getSavedActivity[0])
  assert.equal(h.router.currentRoute.value.query.revision, undefined)
  assert.equal(Boolean(h.byId('results')), false)
  assert.equal(h.byId('download').props.disabled, true)
  assert.ok(h.byId('error')); assert.equal(calls.getSavedActivity.length, 1)
})


for (const control of ['apply', 'next', 'refresh']) test(`a delayed ${control} navigation preserves a newer unapplied draft`, async t => {
  const { h, calls } = await setup(t, '/simulation/sim_A/activity?limit=1')
  await resolve(calls.getSavedActivity[0], activity({ limit: 1, matched_count: 3, has_more: true }))
  let release, delayed = false
  h.router.beforeEach(() => {
    if (!delayed) { delayed = true; return new Promise(resolve => { release = resolve }) }
    return true
  })
  if (control === 'apply') await h.input('agent-id', '0')
  await h.click(control)
  assert.ok(release)
  await h.input('agent-id', '1')
  release(true); await flush()
  assert.equal(h.byId('agent-id').props.value, '1')
  assert.equal(calls.getSavedActivity.length, 1)
  assert.equal(Boolean(h.byId('results')), false); assert.equal(h.byId('download').props.disabled, true)
  await h.click('apply')
  assert.equal(calls.getSavedActivity.length, 2)
  assert.equal(calls.getSavedActivity[1].args[1].agent_id, '1')
  assert.equal(calls.getSavedActivity[1].args[1].offset, 0)
})

test('a second Apply owns navigation completion over the first Apply', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivity[0])
  let release
  h.router.beforeEach(to => to.query.agent_id === '0' ? new Promise(resolve => { release = resolve }) : true)
  await h.input('agent-id', '0'); await h.click('apply')
  await h.input('agent-id', '1'); await h.click('apply')
  assert.equal(h.router.currentRoute.value.query.agent_id, '1')
  release(true); await flush()
  assert.equal(h.byId('agent-id').props.value, '1')
  assert.equal(h.router.currentRoute.value.query.agent_id, '1')
  assert.equal(calls.getSavedActivity.length, 2); assert.ok(h.byId('loading'))
  await resolve(calls.getSavedActivity[1], activity({ filters: { ...activity().filters, agent_id: '1' }, actions: [row('twitter:2', { agent_id: '1' })] }))
  assert.ok(h.byId('results')); assert.equal(h.byId('download').props.disabled, false)
})

test('same-URL Apply supersedes an earlier guarded navigation and remains current when it settles', async t => {
  const { h, calls } = await setup(t, '/simulation/sim_A/activity?offset=0&limit=50')
  await resolve(calls.getSavedActivity[0])
  let release
  h.router.beforeEach(to => to.query.agent_id === '0' ? new Promise(resolve => { release = resolve }) : true)
  await h.input('agent-id', '0'); await h.click('apply')
  await h.input('agent-id', ''); await h.click('apply')
  assert.equal(calls.getSavedActivity.length, 2)
  release(true); await flush()
  assert.equal(h.router.currentRoute.value.query.agent_id, undefined)
  assert.equal(h.byId('agent-id').props.value, '')
  assert.ok(h.byId('loading')); assert.equal(calls.getSavedActivity.length, 2)
  await resolve(calls.getSavedActivity[1]); assert.ok(h.byId('results'))
})

test('a retired Apply rejection cannot clear the newer Apply result or export', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivity[0])
  let rejectOld
  const push = h.router.push
  h.router.push = target => target.query.agent_id === '0' ? new Promise((_resolve, reject) => { rejectOld = reject }) : push(target)
  await h.input('agent-id', '0'); await h.click('apply')
  await h.input('agent-id', '1'); await h.click('apply')
  await resolve(calls.getSavedActivity[1], activity({ filters: { ...activity().filters, agent_id: '1' }, actions: [row('twitter:2', { agent_id: '1' })] }))
  rejectOld(new Error('PRIVATE_OLD_NAVIGATION')); await flush()
  assert.ok(h.byId('results')); assert.equal(h.byId('download').props.disabled, false)
  assert.equal(h.byId('error'), undefined); assert.doesNotMatch(h.text(), /PRIVATE_OLD_NAVIGATION/)
  h.router.push = push
})

test('external Back and Forward replace unapplied drafts with their URL-owned selections', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivity[0])
  await h.input('agent-id', '0'); await h.click('apply')
  await h.input('agent-id', 'unapplied')
  await h.back()
  assert.equal(h.byId('agent-id').props.value, '')
  assert.equal(calls.getSavedActivity.length, 3)
  assert.equal(calls.getSavedActivity[2].args[1].agent_id, undefined)
  await h.forward()
  assert.equal(h.byId('agent-id').props.value, '0')
  assert.equal(calls.getSavedActivity.length, 4)
  assert.equal(calls.getSavedActivity[3].args[1].agent_id, '0')
})

test('leading-zero pagination within the backend decimal bounds is normalized by the actual router view', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?limit=${'0'.repeat(63)}1&offset=${'0'.repeat(64)}`)
  assert.equal(calls.getSavedActivity.length, 1)
  assert.equal(calls.getSavedActivity[0].args[1].limit, 1)
  assert.equal(calls.getSavedActivity[0].args[1].offset, 0)
  assert.equal(h.byId('page-size').props.value, '1')
  await resolve(calls.getSavedActivity[0], activity({ limit: 1 }))
  assert.ok(h.byId('results')); assert.equal(calls.getSavedActivity.length, 1)
  assert.equal(h.router.currentRoute.value.query.revision, revision)
})
