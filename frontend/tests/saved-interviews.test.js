import assert from 'node:assert/strict'
import test from 'node:test'
import { setup, mountSavedInterviews, deferredApi, resolve, observation, record, source, flush, ok } from './helpers/saved-interviews-view-fixture.js'

const path = '/simulation/sim_A/interviews'
const event = () => ({ preventDefault() {}, stopPropagation() {} })

// Removing the route, source separation, literal rendering or request ownership
// must break these tests of actual compiled Vue script/template/router behavior.
test('direct route reads only saved interviews and preserves separate platform answers in saved row order', async t => {
  const { h, calls } = await setup(t)
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviews')
  assert.equal(calls.getSavedInterviews.length, 1); assert.equal(calls.getSimulationHistory.length, 0)
  const data = observation({ records: [record('twitter', '9', { agent_id: '9223372036854775807', prompt: '<script>alert(1)</script>', response: '<img src=x onerror=alert(2)>' }), record('twitter', '-2'), record('reddit', '8')] })
  await resolve(calls.getSavedInterviews[0], data)
  assert.ok(h.byId('interviews-results')); assert.ok(h.text().includes('9223372036854775807'))
  assert.ok(h.text().includes(data.records[0].prompt)); assert.ok(h.text().includes(data.records[0].response)); assert.ok(h.text().includes('reddit saved reply'))
  assert.deepEqual(h.all(n => String(n.props['data-testid'] ?? '').startsWith('interview-row-')).map(n => n.props['data-testid']), ['interview-row-twitter:9', 'interview-row-twitter:-2', 'interview-row-reddit:8'])
  assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type) || n.props.innerHTML).length, 0)
  assert.match(h.text(), /current.*databases/i); assert.match(h.text(), /restart/i); assert.match(h.text(), /prior context/i)
  assert.deepEqual(h.warnings, [])
})

test('History selected simulation opens Saved interviews without a report or graph', async t => {
  const { h, calls } = await setup(t, '/')
  calls.getSimulationHistory[0].resolve(ok([{ simulation_id: 'sim_A', simulation_requirement: 'Saved scenario' }])); await flush()
  h.find(n => n.type === 'div' && String(n.props.class).split(' ').includes('project-card')).props.onClick(); await flush()
  await h.click('history-saved-interviews')
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviews'); assert.equal(calls.getSavedInterviews.length, 1)
  assert.equal(calls.getSavedInterviews[0].args[0], 'sim_A')
})

for (const locale of ['en', 'zh']) test(`filters, labels and full observation download work in ${locale}`, async t => {
  const { h, calls } = await setup(t, path, locale)
  await h.change('interviews-platform', 'reddit'); await h.input('interviews-agent-id', '9223372036854775807'); await h.submit('interviews-form')
  assert.equal(calls.getSavedInterviews[0].signal.aborted, true)
  assert.deepEqual({ ...calls.getSavedInterviews[1].args[1] }, { platform: 'reddit', agent_id: '9223372036854775807' })
  const data = observation({ filters: { platform: 'reddit', agent_id: '9223372036854775807' }, records: [record('reddit', '0', { agent_id: '9223372036854775807' })] })
  await resolve(calls.getSavedInterviews[1], data); await h.click('interviews-download')
  assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.match(h.downloads[0].filename, /sim_A.*interviews.*json$/)
  assert.equal(calls.getSavedInterviews.length, 2); assert.doesNotMatch(h.text(), /savedInterviews\.|comparison\./)
  for (const id of ['interviews-platform', 'interviews-agent-id']) assert.ok(h.find(n => n.type === 'label' && n.props.for === h.byId(id).props.id))
  assert.deepEqual(h.warnings, [])
})

test('missing fields, explicitly empty fields and malformed raw previews remain distinct literal text', async t => {
  const { h, calls } = await setup(t)
  const rows = [record('twitter', '3', { prompt: '', response: null, warnings: ['missing_response'] }), record('twitter', '2', { prompt: null, response: null, payload_kind: 'raw', raw_preview: '<img src=x>{bad', warnings: ['invalid_json'] }), record('twitter', '1', { agent_id: null, timestamp: null, prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['invalid_agent_id', 'missing_timestamp', 'missing_payload'] })]
  await resolve(calls.getSavedInterviews[0], observation({ records: rows }))
  assert.match(h.text(), /empty saved text/i); assert.match(h.text(), /not saved/i); assert.match(h.text(), /raw payload preview/i)
  assert.ok(h.text().includes('<img src=x>{bad')); assert.equal(h.all(n => n.type === 'img').length, 0)
  assert.match(h.text(h.byId('interview-row-twitter:1')), /unknown agent/i)
  assert.match(h.text(h.byId('interviews-availability')), /partial/i)
})

for (const [status, warning] of [['missing', 'source_missing'], ['unreadable', 'source_unreadable'], ['too_large', 'database_too_large'], ['query_limited', 'query_limited']]) test(`${status} source stays distinct from the healthy empty source`, async t => {
  const { h, calls } = await setup(t)
  const data = observation({ records: [], sources: { twitter: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }), reddit: source() } })
  await resolve(calls.getSavedInterviews[0], data)
  assert.match(h.text(h.byId('interviews-source-reddit')), /no matching saved interviews/i)
  assert.doesNotMatch(h.text(h.byId('interviews-source-twitter')), /no matching saved interviews/i)
  assert.match(h.text(h.byId('interviews-availability')), /partial/i)
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
})

test('both unavailable sources never become a successful empty result', async t => {
  const { h, calls } = await setup(t)
  const unavailable = source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] })
  await resolve(calls.getSavedInterviews[0], observation({ records: [], sources: { twitter: unavailable, reddit: unavailable } }))
  assert.match(h.text(h.byId('interviews-availability')), /unavailable/i)
  assert.doesNotMatch(h.text(), /no matching saved interviews/i)
})

test('bounded local pages export every accepted row and expose row and payload truncation', async t => {
  const { h, calls } = await setup(t)
  const rows = Array.from({ length: 51 }, (_, i) => record('twitter', String(51-i)))
  rows[0] = record('twitter', '51', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'bounded', payload_bytes: 17000, truncated: true, warnings: ['payload_truncated'] })
  const data = observation({ records: rows, sources: { twitter: source({ returned_count: 51, has_more: true, coverage: 'partial', warnings: ['response_limit', 'record_warnings'] }), reddit: source() } })
  await resolve(calls.getSavedInterviews[0], data)
  assert.equal(h.all(n => String(n.props['data-testid'] ?? '').startsWith('interview-row-')).length, 25)
  assert.match(h.text(), /more.*matching.*rows/i); assert.match(h.text(), /truncated/i)
  await h.click('interviews-next'); assert.ok(h.byId('interview-row-twitter:26'))
  await h.click('interviews-next'); assert.ok(h.byId('interview-row-twitter:1')); assert.equal(h.byId('interviews-next').props.disabled, true)
  await h.click('interviews-first'); assert.ok(h.byId('interview-row-twitter:51'))
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.equal(calls.getSavedInterviews.length, 1); assert.equal(h.router.currentRoute.value.query.page, undefined)
})

test('draft edits retire pending requests, accepted export URLs and captured old download callbacks', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0]); await h.click('interviews-download')
  const download = h.byId('interviews-download').props.onClick
  await h.input('interviews-agent-id', '0')
  assert.equal(calls.getSavedInterviews[0].signal.aborted, true); assert.equal(Boolean(h.byId('interviews-results')), false)
  download(event()); assert.equal(h.downloads.length, 1); assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
  await h.click('interviews-apply'); await resolve(calls.getSavedInterviews[1], observation({ filters: { platform: null, agent_id: '0' } }))
  download(event()); assert.equal(h.downloads.length, 1)
  await h.click('interviews-download'); assert.equal(h.downloads.length, 2)
})

test('A to B to A rejects older success, failure and finally despite ignored cancellation', async t => {
  const { h, calls } = await setup(t)
  await h.navigate('/simulation/sim_B/interviews'); await h.navigate(path)
  assert.equal(calls.getSavedInterviews.length, 3); assert.equal(calls.getSavedInterviews[0].signal.aborted, true)
  calls.getSavedInterviews[0].reject(new Error('PRIVATE_STALE'))
  await resolve(calls.getSavedInterviews[1], observation({ simulation_id: 'sim_B' }))
  assert.ok(h.byId('interviews-loading')); assert.equal(Boolean(h.byId('interviews-results')), false)
  await resolve(calls.getSavedInterviews[2]); assert.ok(h.byId('interviews-results')); assert.doesNotMatch(h.text(), /PRIVATE_STALE/)
})

test('newer refresh owns the response and uses applied filters while discarding an unsubmitted draft', async t => {
  const { h, calls } = await setup(t, `${path}?platform=twitter&agent_id=0`)
  await h.input('interviews-agent-id', '1'); await h.click('interviews-refresh'); await h.click('interviews-refresh')
  assert.equal(calls.getSavedInterviews.length, 3)
  assert.deepEqual({ ...calls.getSavedInterviews[2].args[1] }, { platform: 'twitter', agent_id: '0' })
  const data = observation({ filters: { platform: 'twitter', agent_id: '0' }, records: [record('twitter')] })
  await resolve(calls.getSavedInterviews[1], data); assert.ok(h.byId('interviews-loading'))
  await resolve(calls.getSavedInterviews[2], data); assert.ok(h.byId('interviews-results')); assert.equal(h.byId('interviews-agent-id').props.value, '0')
})

for (const control of ['interviews-apply', 'interviews-refresh']) test(`edit during delayed ${control} navigation remains retired until Apply`, async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0])
  let release, delayed = false
  if (control === 'interviews-apply') {
    h.router.beforeEach(() => { if (!delayed) { delayed = true; return new Promise(resolve => { release = resolve }) } return true })
    await h.input('interviews-agent-id', '1')
  }
  // A same-route Refresh has no guards; delay its actual push instead.
  let originalPush
  if (control === 'interviews-refresh') { originalPush = h.router.push; h.router.push = target => new Promise(resolve => { release = () => originalPush(target).then(resolve) }) }
  await h.click(control); assert.ok(release); await h.input('interviews-agent-id', '2'); release(true); await flush()
  assert.equal(h.byId('interviews-agent-id').props.value, '2'); assert.equal(Boolean(h.byId('interviews-results')), false)
  if (originalPush) h.router.push = originalPush
  await h.click('interviews-apply'); assert.equal(calls.getSavedInterviews.at(-1).args[1].agent_id, '2')
})

test('same-URL Apply supersedes a guarded navigation', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0])
  let release
  h.router.beforeEach(to => to.query.agent_id === '1' ? new Promise(resolve => { release = resolve }) : true)
  await h.input('interviews-agent-id', '1'); await h.click('interviews-apply')
  await h.input('interviews-agent-id', ''); await h.click('interviews-apply'); assert.equal(calls.getSavedInterviews.length, 2)
  release(true); await flush(); assert.equal(h.router.currentRoute.value.query.agent_id, undefined); assert.ok(h.byId('interviews-loading'))
  await resolve(calls.getSavedInterviews[1]); assert.ok(h.byId('interviews-results'))
})

test('Back, Forward, route-only query changes and unmount retire previous observations', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0]); await h.click('interviews-download')
  const download = h.byId('interviews-download').props.onClick
  await h.navigate(`${path}?agent_id=0`); await h.input('interviews-agent-id', 'draft')
  await h.back(); assert.equal(h.byId('interviews-agent-id').props.value, '')
  await h.forward(); assert.equal(h.byId('interviews-agent-id').props.value, '0'); assert.equal(calls.getSavedInterviews.length, 4)
  h.unmount(); assert.equal(calls.getSavedInterviews[3].signal.aborted, true)
  await resolve(calls.getSavedInterviews[3], observation({ filters: { platform: null, agent_id: '0' } })); download(event())
  assert.equal(h.root.children.length, 0); assert.equal(h.downloads.length, 1); assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
})

for (const suffix of ['?agent_id=00', '?agent_id=-1', '?agent_id=9223372036854775808', '?agent_id=1&agent_id=2', '?agent_id=', '?platform=mastodon', '?platform=twitter&platform=reddit', '?q=anything', '?limit=100', '?revision=x', '?agent_id=%20']) test(`invalid URL ${suffix} makes no read or export`, async t => {
  const { h, calls } = await setup(t, path + suffix)
  assert.equal(calls.getSavedInterviews.length, 0); assert.ok(h.byId('interviews-error')); assert.equal(h.byId('interviews-download').props.disabled, true)
  await h.click('interviews-refresh'); assert.equal(calls.getSavedInterviews.length, 0)
})

test('current transport failure displays a safe message and Refresh retries', async t => {
  const { h, calls } = await setup(t)
  calls.getSavedInterviews[0].reject({ response: { data: { error_code: 'unsafe_path', error: '/private/path/secrets' } } }); await flush()
  assert.match(h.text(), /safely read/i); assert.doesNotMatch(h.text(), /private\/path/)
  await h.click('interviews-refresh'); assert.equal(calls.getSavedInterviews.length, 2)
  await resolve(calls.getSavedInterviews[1]); assert.ok(h.byId('interviews-results'))
})

for (const step of ['blob', 'url', 'element', 'append', 'click']) test(`download ${step} failure keeps accepted rows and allows retry without a storage read`, async t => {
  const d = deferredApi(), hooks = { [step]: () => { throw new Error('PRIVATE_DOWNLOAD_ERROR') } }
  const h = await mountSavedInterviews({ api: d.api, downloadHooks: hooks }); t.after(() => h.unmount())
  await resolve(d.calls.getSavedInterviews[0]); await h.click('interviews-download')
  assert.ok(h.byId('interviews-results')); assert.equal(h.byId('interviews-download').props.disabled, false)
  assert.match(h.text(), /download could not be completed/i); assert.match(h.text(), /check your downloads before retrying; a file may already have been saved/i); assert.match(h.text(), /accepted observation is retained/i); assert.doesNotMatch(h.text(), /PRIVATE_DOWNLOAD_ERROR/)
  assert.equal(h.downloads.length, 0); assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.equal(h.revokedUrls.length, ['element', 'append', 'click'].includes(step) ? 1 : 0)
  delete hooks[step]; await h.click('interviews-download')
  assert.equal(h.downloads.length, 1); assert.equal(Boolean(h.byId('interviews-error')), false)
  assert.equal(await h.downloads[0].blob.text(), JSON.stringify(observation(), null, 2) + '\n')
  assert.equal(d.calls.getSavedInterviews.length, 1); assert.equal(h.anchors.some(anchor => anchor.attached), false)
})

test('download failure during route retirement cannot mark the replacement observation or use its URL', async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, downloadHooks: hooks }); t.after(() => h.unmount())
  await resolve(d.calls.getSavedInterviews[0]); const stale = h.byId('interviews-download').props.onClick
  let navigation
  hooks.click = () => { navigation = h.navigate('/simulation/sim_B/interviews'); throw new Error('PRIVATE_OLD_DOWNLOAD') }
  await h.click('interviews-download'); await navigation; delete hooks.click
  await resolve(d.calls.getSavedInterviews[1], observation({ simulation_id: 'sim_B' })); await h.click('interviews-download')
  stale(event()); await flush()
  assert.equal(h.downloads.length, 1); assert.equal(h.revokedUrls.includes(h.downloads[0].url), false)
  assert.equal(Boolean(h.byId('interviews-error')), false); assert.ok(h.byId('interviews-results')); assert.ok(h.text().includes('sim_B'))
  assert.equal(h.anchors.some(anchor => anchor.attached), false); assert.equal(d.calls.getSavedInterviews.length, 2)
})

test('failed older download cleanup cannot revoke a reentrant replacement download', async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, downloadHooks: hooks }); t.after(() => h.unmount())
  await resolve(d.calls.getSavedInterviews[0])
  hooks.click = () => { delete hooks.click; h.byId('interviews-download').props.onClick(event()); throw new Error('PRIVATE_REPLACED_DOWNLOAD') }
  await h.click('interviews-download')
  assert.equal(h.downloads.length, 1); assert.equal(h.revokedUrls.includes(h.downloads[0].url), false)
  assert.equal(Boolean(h.byId('interviews-error')), false); assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.equal(d.calls.getSavedInterviews.length, 1)
})
