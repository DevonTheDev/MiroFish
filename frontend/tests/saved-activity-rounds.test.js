import assert from 'node:assert/strict'
import test from 'node:test'
import { setup, resolve, overview, overviewRows, round, revision, newRevision, flush, ok } from './helpers/saved-activity-rounds-view-fixture.js'

const path = '/simulation/sim_A/activity/rounds'

test('actual route reads one overview, acknowledges its revision once and renders observed totals', async t => {
  const { h, calls } = await setup(t)
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityRounds')
  assert.equal(calls.getSavedActivityRounds.length, 1)
  await resolve(calls.getSavedActivityRounds[0])
  assert.equal(h.router.currentRoute.value.query.revision, revision)
  assert.equal(calls.getSavedActivityRounds.length, 1); assert.equal(calls.getSavedActivity.length, 0)
  assert.ok(h.byId('rounds-results')); assert.match(h.text(), /all saved attempts/i)
  assert.match(h.text(h.byId('rounds-matched-count')), /3/); assert.match(h.text(), /saved.*success/i)
  assert.deepEqual(h.warnings, [])
})

test('accepted saved record entry carries only platform and revision and disappears on edits', async t => {
  const { h, calls } = await setup(t, `/simulation/sim_A/activity?platform=twitter&agent_id=0&outcome=failed&q=saved&revision=${revision}`)
  assert.equal(Boolean(h.byId('activity-rounds-entry')), false)
  const data = { simulation_id: 'sim_A', source_revision: revision, observed_at: 'now', context: overview().context, availability: 'complete', platform_availability: overview().platform_availability, warnings: [], filters: { platform: 'twitter', agent_id: '0', round_num: null, action_type: null, q: 'saved', case_sensitive: false, outcome: 'failed' }, order: 'source_record', offset: 0, limit: 50, returned_count: 0, matched_count: 0, has_more: false, actions: [] }
  calls.getSavedActivity[0].resolve(ok(data)); await flush()
  assert.ok(h.byId('activity-rounds-entry')); assert.match(h.text(h.byId('activity-rounds-entry')), /all rounds.*platform/i)
  await h.click('activity-rounds-entry')
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityRounds')
  assert.deepEqual({ ...h.router.currentRoute.value.query }, { platform: 'twitter', revision })
  await h.navigate(`/simulation/sim_A/activity?revision=${revision}`)
  calls.getSavedActivity.at(-1).resolve(ok({ ...data, filters: { ...data.filters, platform: null, agent_id: null, q: null, outcome: null } })); await flush()
  await h.input('round-num', '1'); assert.equal(Boolean(h.byId('activity-rounds-entry')), false)
})

test('25-row local pages preserve the accepted observation and export all exact rows', async t => {
  const { h, calls } = await setup(t)
  const data = overviewRows(Array.from({ length: 51 }, (_, i) => round(String(i))))
  await resolve(calls.getSavedActivityRounds[0], data)
  assert.equal(h.all(n => /^round-row-/.test(n.props['data-testid'] ?? '')).length, 25)
  await h.click('rounds-next'); assert.ok(h.byId('round-row-25')); assert.equal(Boolean(h.byId('round-row-0')), false)
  await h.click('rounds-next'); assert.ok(h.byId('round-row-50')); assert.equal(h.byId('rounds-next').props.disabled, true)
  await h.click('rounds-previous'); await h.click('rounds-first'); assert.ok(h.byId('round-row-0'))
  assert.equal(calls.getSavedActivityRounds.length, 1); assert.equal(h.router.currentRoute.value.query.page, undefined)
  await h.click('rounds-download'); assert.equal(h.downloads.length, 1)
  assert.equal(await h.downloads[0].blob.text(), JSON.stringify({ format_version: 1, ...data }, null, 2) + '\n')
  assert.match(h.downloads[0].filename, /sim_A.*rounds.*json$/); assert.match(h.text(), /all.*rows/i)
  await h.input('round-from', '2'); assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
  assert.equal(h.byId('rounds-download').props.disabled, true); assert.equal(Boolean(h.byId('rounds-results')), false)
})

for (const outcome of ['total', 'success', 'failed', 'unknown']) test(`${outcome} positive count opens exact saved records at accepted revision`, async t => {
  const huge = '900719925474099312345'
  const { h, calls } = await setup(t, `${path}?platform=reddit&round_from=0000&revision=${revision}`)
  const data = overviewRows([round('0'), round(huge)], { filters: { platform: 'reddit', round_from: '0', round_to: null } })
  await resolve(calls.getSavedActivityRounds[0], data)
  await h.click(`round-${huge}-${outcome}`)
  assert.equal(h.router.currentRoute.value.name, 'SavedActivity')
  assert.deepEqual({ ...h.router.currentRoute.value.query }, { platform: 'reddit', round_num: huge, ...(outcome === 'total' ? {} : { outcome }), offset: '0', limit: '50', revision })
  assert.equal(calls.getSavedActivity.length, 1); assert.equal(calls.getSavedActivity[0].args[1].round_num, huge)
})

test('stored rounds above 64 digits stay literal/exportable with disabled explained drilldown and zero outcome controls', async t => {
  const huge = '1' + '0'.repeat(64), { h, calls } = await setup(t)
  const data = overviewRows([round('0', { count: 1, outcomes: { success: 0, failed: 1, unknown: 0 } }), round(huge)])
  await resolve(calls.getSavedActivityRounds[0], data)
  assert.ok(h.text().includes(huge)); assert.match(h.text(), /64.*digits/i)
  for (const outcome of ['total', 'success', 'failed', 'unknown']) assert.equal(h.byId(`round-${huge}-${outcome}`).props.disabled, true)
  assert.equal(h.byId('round-0-success').props.disabled, true)
  await h.click('rounds-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify({ format_version: 1, ...data }, null, 2) + '\n')
})

test('stale click/export closures cannot act on an edited or newer accepted result', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivityRounds[0])
  const drill = h.byId('round-0-total').props.onClick, download = h.byId('rounds-download').props.onClick
  await h.input('round-from', '1')
  drill(); download(); await flush()
  assert.equal(h.downloads.length, 0); assert.equal(calls.getSavedActivity.length, 0)
  await h.click('rounds-apply'); await resolve(calls.getSavedActivityRounds[1], overviewRows([round('1')], { filters: { platform: null, round_from: '1', round_to: null } }))
  drill(); download(); await flush()
  assert.equal(h.downloads.length, 0); assert.equal(calls.getSavedActivity.length, 0); assert.ok(h.byId('round-row-1'))
})

test('inclusive bounds preserve canonical strings and bilingual controls are labelled', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, path, locale)
    await resolve(calls.getSavedActivityRounds[0], overview({ context: { ...overview().context, created_at: '<img src=x onerror=evil()>' } }))
    await h.change('rounds-platform', 'twitter'); await h.input('round-from', '000900719925474099312345'); await h.input('round-to', '900719925474099312346')
    await h.submit('rounds-form')
    assert.deepEqual({ ...calls.getSavedActivityRounds[1].args[1] }, { platform: 'twitter', round_from: '900719925474099312345', round_to: '900719925474099312346', revision })
    await resolve(calls.getSavedActivityRounds[1], overviewRows([round('900719925474099312345')], { filters: { platform: 'twitter', round_from: '900719925474099312345', round_to: '900719925474099312346' } }))
    for (const id of ['rounds-platform', 'round-from', 'round-to']) assert.ok(h.find(n => n.type === 'label' && n.props.for === h.byId(id).props.id))
    assert.equal(h.all(n => n.type === 'th' && n.props.scope === 'col').length, 5)
    assert.match(h.byId('round-900719925474099312345-failed').props['aria-label'], /900719925474099312345/)
    assert.doesNotMatch(h.text(), /savedActivityRounds\.|comparison\.|savedActivity\./)
    assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0); assert.deepEqual(h.warnings, [])
  }
})

for (const query of ['platform=', 'platform=other', 'round_from=-1', 'round_to=1e3', 'round_from=2&round_to=1', 'round_from=900719925474099312346&round_to=900719925474099312345', 'round_from=1&round_from=2', 'unknown=x', 'revision=bad', `round_to=${'1'.repeat(65)}`]) test(`invalid URL ${query} never reads storage`, async t => {
  const { h, calls } = await setup(t, `${path}?${query}`)
  assert.equal(calls.getSavedActivityRounds.length, 0); assert.ok(h.byId('rounds-error'))
})

for (const [name, change] of [
  ['ID', { simulation_id: 'other' }], ['revision', { source_revision: newRevision }], ['filter', { filters: { platform: 'reddit', round_from: null, round_to: null } }],
  ['order', { order: 'lexical' }], ['total', { matched_count: 4 }], ['round count', { round_count: 2 }], ['outcome total', { outcomes: { success: 2, failed: 1, unknown: 0 } }],
  ['noncanonical decimal', { rounds: [round('00')] }], ['numeric decimal', { rounds: [round(0)] }], ['zero row', { rounds: [round('0', { count: 0 })] }],
  ['row outcomes', { rounds: [round('0', { outcomes: { success: 1, failed: 0, unknown: 1 } })] }], ['boolean flag', { rounds: [round('0', { drilldown_supported: 'true' })] }],
  ['unsupported short flag', { rounds: [round('0', { drilldown_supported: false })] }], ['extra context', { context: { ...overview().context, private_path: 'hidden' } }],
  ['bad context decimal', { context: { ...overview().context, last_saved_round: 1 } }], ['missing platform', { platform_availability: { twitter: 'complete' } }],
  ['bad warning', { warnings: ['private path'] }], ['unavailable counts', { availability: 'unavailable' }], ['negative', { matched_count: -1 }],
  ['fraction', { rounds: [round('0', { count: 3.5 })] }], ['unsafe count', { matched_count: Number.MAX_SAFE_INTEGER + 1 }],
]) test(`rejects malformed ${name} response without exposing/exporting it`, async t => {
  const { h, calls } = await setup(t, `${path}?revision=${revision}`)
  await resolve(calls.getSavedActivityRounds[0], overview(change))
  assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error')); assert.equal(h.byId('rounds-download').props.disabled, true)
})
for (const [name, rows] of [['duplicate', [round('0'), round('0')]], ['lexical', [round('10'), round('2')]], ['over limit', Array.from({ length: 1001 }, (_, i) => round(String(i)))], ['oversize', [round('1'.repeat(1024 * 1024), { drilldown_supported: false })]]]) test(`rejects ${name} overview`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedActivityRounds[0], overviewRows(rows))
  assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error'))
})

test('rounds are sorted numerically as strings and max 1000 rows is admitted', async t => {
  const { h, calls } = await setup(t)
  const rows = Array.from({ length: 1000 }, (_, i) => round(String(i)))
  await resolve(calls.getSavedActivityRounds[0], overviewRows(rows)); assert.ok(h.byId('rounds-results'))
  assert.ok(h.byId('round-row-2')); assert.ok(h.byId('round-row-10'))
})

test('unavailable is distinct from observed zero and partial warnings are literal in both locales', async t => {
  for (const locale of ['en', 'zh']) for (const unavailable of [true, false]) {
    const { h, calls } = await setup(t, path, locale)
    const data = overviewRows([], unavailable ? { availability: 'unavailable', matched_count: null, outcomes: { success: null, failed: null, unknown: null } } : { availability: 'partial', warnings: [{ code: 'invalid_records', platform: 'twitter', count: 2 }] })
    await resolve(calls.getSavedActivityRounds[0], data)
    assert.ok(h.byId('rounds-results')); assert.ok(h.byId('rounds-empty'))
    assert.match(h.text(h.byId('rounds-matched-count')), unavailable ? /—/ : /0/)
    assert.doesNotMatch(h.text(), /savedActivityRounds\.|comparison\./); assert.deepEqual(h.warnings, [])
  }
})

test('source change is explicit, Refresh uses applied URL bounds and drops revision', async t => {
  const { h, calls } = await setup(t, `${path}?platform=reddit&round_from=7&revision=${revision}`)
  calls.getSavedActivityRounds[0].reject({ response: { status: 409, data: { error_code: 'sources_changed', error: '/private/path' } } }); await flush()
  assert.match(h.text(), /changed.*Refresh/i); assert.doesNotMatch(h.text(), /private\/path/)
  await h.input('round-from', '99'); await h.click('rounds-refresh')
  assert.deepEqual({ ...calls.getSavedActivityRounds[1].args[1] }, { platform: 'reddit', round_from: '7' })
  await resolve(calls.getSavedActivityRounds[1], overviewRows([round('7')], { source_revision: newRevision, filters: { platform: 'reddit', round_from: '7', round_to: null } }))
  assert.equal(h.router.currentRoute.value.query.revision, newRevision); assert.equal(calls.getSavedActivityRounds.length, 2)
})

test('A to B to A retires old success/rejection/finally even if cancellation is ignored', async t => {
  const { h, calls } = await setup(t)
  await h.navigate('/simulation/sim_B/activity/rounds'); await h.navigate(path)
  assert.equal(calls.getSavedActivityRounds.length, 3); assert.equal(calls.getSavedActivityRounds[0].signal.aborted, true)
  calls.getSavedActivityRounds[0].reject(new Error('PRIVATE_STALE')); await resolve(calls.getSavedActivityRounds[1], overview({ simulation_id: 'sim_B' }))
  assert.ok(h.byId('rounds-loading')); assert.equal(Boolean(h.byId('rounds-results')), false)
  await resolve(calls.getSavedActivityRounds[2]); assert.ok(h.byId('rounds-results')); assert.doesNotMatch(h.text(), /PRIVATE_STALE/)
})

test('edit during delayed acknowledgement keeps draft retired and retains revision for Apply', async t => {
  const { h, calls } = await setup(t)
  let release
  h.router.beforeEach(to => to.query.revision ? new Promise(resolve => { release = resolve }) : true)
  calls.getSavedActivityRounds[0].resolve(ok(overview())); await flush(); assert.ok(release)
  await h.input('round-from', '1'); release(true); await flush()
  assert.equal(h.byId('round-from').props.value, '1'); assert.equal(Boolean(h.byId('rounds-results')), false); assert.equal(calls.getSavedActivityRounds.length, 1)
  h.router.beforeEach(() => true)
  // The next target already has revision, so release its separate guard.
  await h.click('rounds-apply'); release(true); await flush()
  assert.equal(calls.getSavedActivityRounds[1].args[1].revision, revision)
})

test('old acknowledgement cannot replace a different simulation load', async t => {
  const { h, calls } = await setup(t)
  let release
  h.router.beforeEach(to => to.params.simulationId === 'sim_A' && to.query.revision ? new Promise(resolve => { release = resolve }) : true)
  calls.getSavedActivityRounds[0].resolve(ok(overview())); await flush()
  await h.navigate('/simulation/sim_B/activity/rounds?platform=reddit'); release(true); await flush()
  assert.equal(h.router.currentRoute.value.params.simulationId, 'sim_B'); assert.equal(h.byId('rounds-platform').props.value, 'reddit')
  assert.ok(h.byId('rounds-loading')); assert.equal(calls.getSavedActivityRounds.length, 2)
})

for (const control of ['rounds-apply', 'rounds-refresh']) test(`edit during delayed ${control} navigation remains retired until new Apply`, async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0])
  let release, delayed = false
  h.router.beforeEach(() => { if (!delayed) { delayed = true; return new Promise(resolve => { release = resolve }) } return true })
  if (control === 'rounds-apply') await h.input('round-from', '1')
  await h.click(control); assert.ok(release); await h.input('round-from', '2'); release(true); await flush()
  assert.equal(h.byId('round-from').props.value, '2'); assert.equal(Boolean(h.byId('rounds-results')), false); assert.equal(calls.getSavedActivityRounds.length, 1)
  await h.click('rounds-apply'); assert.equal(calls.getSavedActivityRounds[1].args[1].round_from, '2')
})

test('same-URL Apply supersedes a guarded navigation and stale rejection cannot clear accepted work', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0])
  let release
  h.router.beforeEach(to => to.query.round_from === '1' ? new Promise(resolve => { release = resolve }) : true)
  await h.input('round-from', '1'); await h.click('rounds-apply')
  await h.input('round-from', ''); await h.click('rounds-apply'); assert.equal(calls.getSavedActivityRounds.length, 2)
  release(true); await flush(); assert.equal(h.router.currentRoute.value.query.round_from, undefined); assert.ok(h.byId('rounds-loading'))
  await resolve(calls.getSavedActivityRounds[1]); assert.ok(h.byId('rounds-results'))
  let rejectOld; const push = h.router.push
  h.router.push = target => target.query.round_from === '3' ? new Promise((_resolve, reject) => { rejectOld = reject }) : push(target)
  await h.input('round-from', '3'); await h.click('rounds-apply'); await h.input('round-from', '4'); await h.click('rounds-apply')
  await resolve(calls.getSavedActivityRounds[2], overviewRows([round('4')], { filters: { platform: null, round_from: '4', round_to: null } }))
  rejectOld(new Error('PRIVATE_OLD_NAV')); await flush(); assert.ok(h.byId('rounds-results')); assert.equal(Boolean(h.byId('rounds-error')), false)
  h.router.push = push
})

test('refused or rejected acknowledgement keeps export disabled; stale rejection stays silent', async t => {
  const { h, calls } = await setup(t)
  h.router.beforeEach(to => !to.query.revision); await resolve(calls.getSavedActivityRounds[0])
  assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error')); assert.equal(h.byId('rounds-download').props.disabled, true)
  const second = await setup(t)
  let reject; second.h.router.replace = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise })
  second.calls.getSavedActivityRounds[0].resolve(ok(overview())); await flush()
  await second.h.input('round-to', '7'); reject(new Error('PRIVATE_OLD_ACK')); await flush()
  assert.equal(Boolean(second.h.byId('rounds-error')), false); assert.equal(Boolean(second.h.byId('rounds-results')), false)
})

test('Back and Forward restore URL selection and unmount retires requests and download URLs', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0]); await h.click('rounds-download')
  await h.input('round-from', '1'); await h.click('rounds-apply'); await h.input('round-from', 'unapplied')
  await h.back(); assert.equal(h.byId('round-from').props.value, ''); assert.equal(calls.getSavedActivityRounds.length, 3)
  await h.forward(); assert.equal(h.byId('round-from').props.value, '1'); assert.equal(calls.getSavedActivityRounds.length, 4)
  h.unmount(); assert.equal(calls.getSavedActivityRounds[3].signal.aborted, true)
  await resolve(calls.getSavedActivityRounds[3]); assert.equal(h.root.children.length, 0); assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
})

for (const success of [1, 'true']) test(`rejects success ${JSON.stringify(success)} instead of exact boolean true`, async t => {
  const { h, calls } = await setup(t)
  calls.getSavedActivityRounds[0].resolve({ success, data: overview() }); await flush()
  assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error'))
})
test('rejects undocumented outer-envelope fields', async t => {
  const { h, calls } = await setup(t)
  calls.getSavedActivityRounds[0].resolve({ success: true, data: overview(), hidden: 'not an aggregate' }); await flush()
  assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error'))
})
for (const [name, changes] of [
  ['extra data', { payload: { text: 'hidden' } }], ['extra row', { rounds: [round('0', { payload: 'hidden' })] }],
  ['extra outcome', { outcomes: { success: 1, failed: 1, unknown: 1, other: 0 } }], ['missing outcome', { outcomes: { success: 1, failed: 2 } }],
  ['extra row outcome', { rounds: [round('0', { outcomes: { success: 1, failed: 1, unknown: 1, other: 0 } })] }],
  ['missing row outcome', { rounds: [round('0', { outcomes: { success: 1, failed: 2 } })] }],
]) test(`rejects ${name} keys from aggregate export`, async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0], overview(changes))
  assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error'))
})
test('missing documented data and row keys are rejected', async t => {
  for (const missing of ['observed_at', 'drilldown_supported']) {
    const { h, calls } = await setup(t), data = overview()
    if (missing === 'observed_at') delete data.observed_at
    else delete data.rounds[0].drilldown_supported
    await resolve(calls.getSavedActivityRounds[0], data)
    assert.equal(Boolean(h.byId('rounds-results')), false); assert.ok(h.byId('rounds-error'))
  }
})
test('retained accepted export and drill callbacks stay retired through same-ID A to B to A', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0])
  const download = h.byId('rounds-download').props.onClick, drill = h.byId('round-0-total').props.onClick
  await h.navigate('/simulation/sim_B/activity/rounds'); await h.navigate(path)
  await resolve(calls.getSavedActivityRounds[2])
  download(); drill(); await flush()
  assert.equal(h.downloads.length, 0); assert.equal(calls.getSavedActivity.length, 0); assert.ok(h.byId('rounds-results'))
})

test('a draft edit cancels a guarded drilldown and retains the new draft on the overview route', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0])
  let release
  h.router.beforeEach(to => to.name === 'SavedActivity' ? new Promise(resolve => { release = resolve }) : true)
  await h.click('round-0-failed'); assert.ok(release)
  await h.input('round-from', '1'); release(true); await flush()
  assert.equal(h.router.currentRoute.value.name, 'SavedActivityRounds'); assert.equal(h.byId('round-from').props.value, '1')
  assert.equal(calls.getSavedActivity.length, 0); assert.equal(Boolean(h.byId('rounds-results')), false)
  await h.click('rounds-apply'); assert.equal(calls.getSavedActivityRounds[1].args[1].round_from, '1'); assert.equal(calls.getSavedActivityRounds[1].args[1].revision, revision)
})

test('saved metadata is literal, unknown warning codes use safe fallback, and unmount revokes the accepted export', async t => {
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await setup(t, path, locale)
    const literal = '<img src=x onerror=evil()>'
    await resolve(calls.getSavedActivityRounds[0], overview({ context: { ...overview().context, created_at: literal }, warnings: [{ code: literal, platform: 'twitter' }] }))
    assert.ok(h.text().includes(literal)); assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type)).length, 0)
    assert.doesNotMatch(h.text(), /savedActivityRounds\.|comparison\./); assert.deepEqual(h.warnings, [])
    await h.click('rounds-download'); const stale = h.byId('rounds-download').props.onClick
    h.unmount(); assert.deepEqual(h.revokedUrls, [h.downloads[0].url]); stale()
    assert.equal(h.downloads.length, 1); assert.equal(calls.getSavedActivityRounds[0].signal.aborted, true)
  }
})
test('unmount cancels a pending guarded drill instead of allowing it to depart later', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedActivityRounds[0])
  let release
  h.router.beforeEach(to => to.name === 'SavedActivity' ? new Promise(resolve => { release = resolve }) : true)
  await h.click('round-0-total'); h.unmount(); release(true); await flush()
  // Vue Router resets its current route when the last app unmounts.
  assert.notEqual(h.router.currentRoute.value.name, 'SavedActivity'); assert.equal(calls.getSavedActivity.length, 0)
})
test('same-URL Refresh cancels an older guarded Apply and ignores its old observation', async t => {
  const { h, calls } = await setup(t)
  let release
  h.router.beforeEach(to => to.query.round_from === '1' ? new Promise(resolve => { release = resolve }) : true)
  await h.input('round-from', '1'); await h.click('rounds-apply'); await h.click('rounds-refresh')
  assert.equal(calls.getSavedActivityRounds.length, 2)
  release(true); await resolve(calls.getSavedActivityRounds[0]); await flush()
  assert.equal(h.router.currentRoute.value.query.round_from, undefined); assert.ok(h.byId('rounds-loading'))
  await resolve(calls.getSavedActivityRounds[1]); assert.ok(h.byId('rounds-results'))
})
