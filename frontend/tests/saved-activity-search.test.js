import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedActivity, deferredApi, flush, ok } from './helpers/saved-activity-view-fixture.js'

const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64)
const defaults = { platform: null, agent_id: null, round_num: null, action_type: null, q: null, case_sensitive: false, outcome: null }
const row = (overrides = {}) => ({ record_id: 'twitter:1', platform: 'twitter', round_num: '0', agent_id: '900719925474099312345', agent_name: 'Saved agent', timestamp: null, action_type: 'POST', success: false, details_json: '{"result":{"text":"Straße <img src=x onerror=alert(1)>"}}', match_preview: null, ...overrides })
const activity = (overrides = {}) => ({ simulation_id: 'sim_A', source_revision: revision, observed_at: '2026-10-03T09:00:00Z', context: { status: 'completed', created_at: null, updated_at: null, started_at: null, completed_at: null, requested_rounds: '20', last_saved_round: '0' }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'unavailable' }, warnings: [], filters: { ...defaults }, order: 'source_record', offset: 0, limit: 50, returned_count: 1, matched_count: 1, has_more: false, actions: [row()], ...overrides })
async function setup(t, query = '', locale = 'en') {
  const d = deferredApi(), h = await mountSavedActivity({ api: d.api, initialPath: '/simulation/sim_A/activity' + (query ? '?' + query : ''), locale })
  t.after(() => h.unmount())
  return { ...d, h }
}
async function resolve(call, data = activity()) { assert.ok(call, 'a saved activity request must exist'); call.resolve(ok(data)); await flush() }
async function check(h, value) { h.byId('case-sensitive').props.onChange({ target: { checked: value } }); await flush() }
function dataFor(call, overrides = {}) {
  assert.ok(call, 'the valid search must issue a saved activity request')
  const params = call.args[1], filters = { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]])) }
  return activity({ filters, offset: params.offset, limit: params.limit, actions: [row({ success: filters.outcome === 'success' ? true : filters.outcome === 'unknown' ? null : false, match_preview: filters.q === null ? null : filters.q })], ...overrides })
}

// Dropping any search field from the selection tuple, interpreting previews as
// HTML, or deriving matching with JS lowercasing must break these real Vue tests.
test('bilingual phrase, case and saved outcome controls apply with exact filters and literal previews', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, '', locale)
    await resolve(calls.getSavedActivity[0])
    for (const id of ['search-phrase', 'case-sensitive', 'outcome']) {
      assert.ok(h.byId(id), `missing ${id}`)
      assert.ok(h.find(n => n.type === 'label' && n.props.for === h.byId(id).props.id))
    }
    assert.equal(h.byId('case-sensitive').props.type, 'checkbox')
    assert.equal(h.byId('case-sensitive').props.checked, false)
    await h.input('search-phrase', ' Straße <img> '); await check(h, true); await h.change('outcome', 'failed')
    await h.change('platform', 'twitter'); await h.input('agent-id', '900719925474099312345')
    await h.input('round-num', '0'); await h.input('action-type', 'POST'); await h.change('page-size', '1')
    await h.submit('activity-form')
    const call = calls.getSavedActivity.at(-1), params = call.args[1]
    assert.equal(params.q, ' Straße <img> '); assert.equal(params.case_sensitive, true); assert.equal(params.outcome, 'failed')
    assert.equal(params.agent_id, '900719925474099312345'); assert.equal(params.round_num, '0'); assert.equal(params.platform, 'twitter'); assert.equal(params.action_type, 'POST')
    const preview = '<script>saved()</script> Straße <img src=x onerror=alert(1)>'
    await resolve(call, dataFor(call, { actions: [row({ match_preview: preview })] }))
    assert.ok(h.byId('results')); assert.equal(h.text(h.byId('match-preview-twitter:1')), preview)
    assert.equal(h.all(n => ['img', 'script', 'iframe', 'mark'].includes(n.type)).length, 0)
    assert.doesNotMatch(h.text(), /savedActivity\.|comparison\./); assert.deepEqual(h.warnings, [])
    if (locale === 'en') {
      assert.match(h.text(), /arguments.*results.*names.*types.*timestamps/i)
      assert.match(h.text(), /saved.*flags.*not independently verified/i)
      assert.match(h.text(), /first matching.*240|240.*first matching/i)
    }
    await h.click('download')
    assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), { format_version: 1, ...dataFor(call, { actions: [row({ match_preview: preview })] }) })
  }
})

test('deep linked phrase/case/outcome retain ownership through pages, history, Refresh and export', async t => {
  const { h, calls } = await setup(t, `q=${encodeURIComponent(' exact & 文 ')}&case_sensitive=true&outcome=unknown&limit=1&revision=${revision}`)
  assert.equal(calls.getSavedActivity.length, 1)
  assert.equal(h.byId('search-phrase').props.value, ' exact & 文 '); assert.equal(h.byId('case-sensitive').props.checked, true); assert.equal(h.byId('outcome').props.value, 'unknown')
  await resolve(calls.getSavedActivity[0], dataFor(calls.getSavedActivity[0], { matched_count: 3, has_more: true }))
  await h.click('next')
  assert.equal(calls.getSavedActivity.at(-1).args[1].offset, 1)
  await resolve(calls.getSavedActivity.at(-1), dataFor(calls.getSavedActivity.at(-1), { matched_count: 3, has_more: true }))
  await h.click('next'); await h.back(); await h.forward()
  assert.equal(calls.getSavedActivity.at(-1).args[1].offset, 2)
  for (const call of calls.getSavedActivity) {
    assert.equal(call.args[1].q, ' exact & 文 '); assert.equal(call.args[1].case_sensitive, true); assert.equal(call.args[1].outcome, 'unknown'); assert.equal(call.args[1].revision, revision)
  }
  await resolve(calls.getSavedActivity.at(-1), dataFor(calls.getSavedActivity.at(-1), { matched_count: 3 }))
  await h.click('download')
  assert.equal(JSON.parse(await h.downloads[0].blob.text()).filters.q, ' exact & 文 ')
  await h.click('refresh')
  const current = calls.getSavedActivity.at(-1)
  assert.equal(current.args[1].offset, 0); assert.equal(current.args[1].revision, undefined)
  assert.equal(current.args[1].q, ' exact & 文 '); assert.equal(current.args[1].case_sensitive, true); assert.equal(current.args[1].outcome, 'unknown')
  await resolve(current, dataFor(current, { source_revision: nextRevision }))
  assert.equal(h.router.currentRoute.value.query.revision, nextRevision)
})

test('blank controls clear phrase and outcome while preserving a checked case option without a phrase', async t => {
  const { h, calls } = await setup(t, 'q=old&case_sensitive=true&outcome=success')
  await resolve(calls.getSavedActivity[0], dataFor(calls.getSavedActivity[0]))
  await h.input('search-phrase', ''); await h.change('outcome', ''); await h.click('apply')
  const call = calls.getSavedActivity.at(-1)
  assert.equal(call.args[1].q, undefined); assert.equal(call.args[1].outcome, undefined); assert.equal(call.args[1].case_sensitive, true)
  await resolve(call, dataFor(call))
  assert.ok(h.byId('results')); assert.equal(h.byId('match-preview-twitter:1'), undefined)
  await check(h, false); await h.click('apply')
  assert.equal(calls.getSavedActivity.at(-1).args[1].case_sensitive, undefined)
  await resolve(calls.getSavedActivity.at(-1), dataFor(calls.getSavedActivity.at(-1)))
  assert.ok(h.byId('results')); assert.equal(h.byId('case-sensitive').props.checked, false)
})

for (const q of ['😀'.repeat(200), '\ufeff', 'STRASSE', 's', 'e\u0301', ' literal .* [a] ']) {
  test(`accepts literal Unicode phrase ${JSON.stringify(q.slice(0, 22))} without rematching a server preview`, async t => {
    const { h, calls } = await setup(t, 'q=' + encodeURIComponent(q) + '&case_sensitive=false')
    assert.equal(calls.getSavedActivity.length, 1)
    assert.equal(calls.getSavedActivity[0].args[1].q, q)
    // A 240-code-point excerpt need not include the full query after casefold
    // expansion. The backend owns matching; the view validates the envelope.
    await resolve(calls.getSavedActivity[0], dataFor(calls.getSavedActivity[0], { actions: [row({ match_preview: '😀'.repeat(239) + 'ß' })] }))
    assert.ok(h.byId('results')); assert.equal([...h.text(h.byId('match-preview-twitter:1'))].length, 240)
  })
}

for (const query of [
  'q=', 'q', 'q=%20%20', 'q=%E3%80%80', 'q=%00', 'q=%0A', 'q=%7F', 'q=%C2%85', 'q=%E2%80%A8', 'q=%E2%80%A9', `q=${encodeURIComponent('😀'.repeat(201))}`,
  'q=a&q=b', 'case_sensitive=', 'case_sensitive', 'case_sensitive=1', 'case_sensitive=True', 'case_sensitive=FALSE', 'case_sensitive=false&case_sensitive=true',
  'outcome=', 'outcome', 'outcome=any', 'outcome=true', 'outcome=Success', 'outcome=failed&outcome=unknown',
]) test(`rejects malformed search URL ${query.slice(0, 64)}`, async t => {
  const { h, calls } = await setup(t, query)
  assert.equal(calls.getSavedActivity.length, 0); assert.ok(h.byId('error')); assert.equal(h.byId('download').props.disabled, true)
})

for (const value of [' '.repeat(2), '\u0085', 'bad\u2028line', '😀'.repeat(201)]) test(`invalid draft phrase ${JSON.stringify(value.slice(0, 12))} retires data without a request`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivity[0]); await h.input('search-phrase', value); await h.click('apply')
  assert.equal(calls.getSavedActivity.length, 1); assert.ok(h.byId('error')); assert.equal(h.byId('results'), undefined)
})

for (const [name, changes] of [
  ['q echo', { filters: { ...defaults, q: 'other', outcome: 'failed' } }],
  ['case echo', { filters: { ...defaults, q: 'text', case_sensitive: true, outcome: 'failed' } }],
  ['outcome echo', { filters: { ...defaults, q: 'text', outcome: 'unknown' } }],
  ['missing search echo', { filters: { platform: null, agent_id: null, round_num: null, action_type: null } }],
  ['extra echo', { filters: { ...defaults, q: 'text', outcome: 'failed', extra: true } }],
  ['missing preview', { actions: [row({ match_preview: undefined })] }],
  ['null preview', { actions: [row()] }],
  ['numeric preview', { actions: [row({ match_preview: 1 })] }],
  ['empty preview', { actions: [row({ match_preview: '' })] }],
  ['oversize Unicode preview', { actions: [row({ match_preview: '😀'.repeat(241) })] }],
  ['success inconsistent with failed filter', { actions: [row({ success: true, match_preview: 'text' })] }],
  ['unknown inconsistent with failed filter', { actions: [row({ success: null, match_preview: 'text' })] }],
]) test(`rejects invalid derived response ${name}`, async t => {
  const { h, calls } = await setup(t, 'q=text&outcome=failed')
  await resolve(calls.getSavedActivity[0], activity({ filters: { ...defaults, q: 'text', outcome: 'failed' }, ...changes }))
  assert.equal(h.byId('results'), undefined); assert.ok(h.byId('error')); assert.equal(h.byId('download').props.disabled, true)
})

for (const [query, success, preview] of [['', false, 'unexpected'], ['', false, undefined], ['outcome=success', false, null], ['outcome=unknown', true, null]]) test(`rejects absent-query preview/outcome mismatch ${query}:${String(preview)}`, async t => {
  const { h, calls } = await setup(t, query)
  await resolve(calls.getSavedActivity[0], dataFor(calls.getSavedActivity[0], { actions: [row({ success, match_preview: preview })] }))
  assert.equal(h.byId('results'), undefined); assert.ok(h.byId('error'))
})

for (const control of ['search-phrase', 'case-sensitive', 'outcome']) test(`${control} retires requests and download URLs synchronously even when abort is ignored`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivity[0]); await h.click('download')
  const target = h.byId(control)
  const event = control === 'case-sensitive' ? { target: { checked: true } } : { target: { value: control === 'outcome' ? 'failed' : 'text' } }
  ;(target.props.onInput ?? target.props.onChange)(event)
  assert.equal(calls.getSavedActivity[0].signal.aborted, true)
  assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
  await flush(); assert.equal(h.byId('results'), undefined); assert.equal(h.byId('download').props.disabled, true)
  await h.click('apply')
  const pending = calls.getSavedActivity.at(-1)
  ;(h.byId(control).props.onInput ?? h.byId(control).props.onChange)(event)
  assert.equal(pending.signal.aborted, true)
  await resolve(pending, dataFor(pending))
  assert.equal(h.byId('results'), undefined); assert.equal(h.byId('loading'), undefined)
})

test('search tuple A to B to A rejects old success, rejection and finally while history restores all controls', async t => {
  const a = `q=alpha&case_sensitive=true&outcome=failed&revision=${revision}`
  const b = `q=beta&case_sensitive=false&outcome=unknown&revision=${revision}`
  const { h, calls } = await setup(t, a)
  await h.navigate('/simulation/sim_A/activity?' + b); await h.navigate('/simulation/sim_A/activity?' + a)
  assert.equal(calls.getSavedActivity.length, 3)
  calls.getSavedActivity[0].reject(new Error('STALE_SEARCH_ERROR'))
  await resolve(calls.getSavedActivity[1], dataFor(calls.getSavedActivity[1])); assert.ok(h.byId('loading')); assert.equal(h.byId('results'), undefined)
  await resolve(calls.getSavedActivity[2], dataFor(calls.getSavedActivity[2])); assert.ok(h.byId('results'))
  await h.input('search-phrase', 'unapplied'); await check(h, false); await h.change('outcome', 'success')
  await h.back()
  assert.equal(h.byId('search-phrase').props.value, 'beta'); assert.equal(h.byId('case-sensitive').props.checked, false); assert.equal(h.byId('outcome').props.value, 'unknown')
  await h.forward()
  assert.equal(h.byId('search-phrase').props.value, 'alpha'); assert.equal(h.byId('case-sensitive').props.checked, true); assert.equal(h.byId('outcome').props.value, 'failed')
  assert.doesNotMatch(h.text(), /STALE_SEARCH_ERROR/)
})

for (const control of ['apply', 'next', 'refresh']) test(`delayed ${control} cannot overwrite newer phrase/case/outcome drafts`, async t => {
  const { h, calls } = await setup(t, 'q=old&limit=1')
  await resolve(calls.getSavedActivity[0], dataFor(calls.getSavedActivity[0], { matched_count: 3, has_more: true }))
  let release, delayed = false
  h.router.beforeEach(() => { if (!delayed) { delayed = true; return new Promise(resolve => { release = resolve }) } return true })
  if (control === 'apply') await h.input('search-phrase', 'pending')
  await h.click(control); assert.ok(release)
  await h.input('search-phrase', 'new draft'); await check(h, true); await h.change('outcome', 'unknown')
  release(true); await flush()
  assert.equal(calls.getSavedActivity.length, 1); assert.equal(h.byId('results'), undefined)
  assert.equal(h.byId('search-phrase').props.value, 'new draft'); assert.equal(h.byId('case-sensitive').props.checked, true); assert.equal(h.byId('outcome').props.value, 'unknown')
  await h.click('apply')
  assert.equal(calls.getSavedActivity.length, 2)
  const params = calls.getSavedActivity[1].args[1]
  assert.equal(params.q, 'new draft'); assert.equal(params.case_sensitive, true); assert.equal(params.outcome, 'unknown'); assert.equal(params.offset, 0)
})

test('delayed revision acknowledgement cannot revive a request retired by search controls', async t => {
  const { h, calls } = await setup(t, 'q=old')
  let release
  h.router.beforeEach(to => to.query.revision ? new Promise(resolve => { release = resolve }) : true)
  assert.ok(calls.getSavedActivity[0], 'the phrase selection must issue a request')
  calls.getSavedActivity[0].resolve(ok(dataFor(calls.getSavedActivity[0]))); await flush(); assert.ok(release)
  await h.input('search-phrase', 'new'); await check(h, true); await h.change('outcome', 'success')
  release(true); await flush()
  assert.equal(calls.getSavedActivity.length, 1); assert.equal(h.byId('results'), undefined)
  assert.equal(h.byId('search-phrase').props.value, 'new'); assert.equal(h.byId('case-sensitive').props.checked, true); assert.equal(h.byId('outcome').props.value, 'success')
})
