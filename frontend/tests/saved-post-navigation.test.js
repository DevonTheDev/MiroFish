import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountSavedActivity, flush, ok } from './helpers/saved-activity-view-fixture.js'
import { detail, post, unavailable } from './helpers/saved-posts-view-fixture.js'
import { readSavedActivityFile } from '../src/utils/savedActivityFiles.js'

// Prepared source only. The released serial gate supplies the disposable JSON
// file emitted by the three backend scenario groups; no server or network runs.
// Fixed expansion: 20 named groups, 23 mounts, 40 activity reads, 11 detail API
// calls and 11 service.get calls. All other APIs, including the posts list, are 0.
// The first happy mount also downloads and reparses one unchanged v1 file.
assert.ok(process.env.MIRO_NAV_ENVELOPES, 'MIRO_NAV_ENVELOPES must name the emitted backend envelope file')
const pythonEnvelopes = JSON.parse(readFileSync(process.env.MIRO_NAV_ENVELOPES, 'utf8'))
assert.ok(Array.isArray(pythonEnvelopes))
assert.equal(pythonEnvelopes.length, 6, 'exactly six emitted successful Flask envelopes are required')

const revision = 'a'.repeat(64), newRevision = 'b'.repeat(64)
const event = () => ({ preventDefault() {}, stopPropagation() {} })
const query = h => ({ ...h.router.currentRoute.value.query })
const text = (h, id) => h.text(h.byId(id))
const buttonId = row => `referenced-post-${row.record_id}`
const baseFilters = () => ({ platform: null, agent_id: null, round_num: null, action_type: null, q: null, case_sensitive: false, outcome: null })
const action = (changes = {}) => ({ record_id: 'twitter:1', platform: 'twitter', round_num: '1', agent_id: '0', agent_name: 'Saved agent', timestamp: null, action_type: 'LIKE_POST', success: true, details_json: '{"action_type":"LIKE_POST","action_args":{"post_id":1}}', match_preview: null, referenced_post_id: '1', ...changes })
const activity = (changes = {}) => ({ simulation_id: 'sim_A', source_revision: revision, observed_at: '2026-10-17T12:00:00Z', context: { status: 'completed', created_at: null, updated_at: null, started_at: null, completed_at: null, requested_rounds: '20', last_saved_round: '1' }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'complete' }, warnings: [], filters: baseFilters(), order: 'source_record', offset: 0, limit: 50, returned_count: 1, matched_count: 1, has_more: false, actions: [action()], ...changes })
function activityPath(data = activity()) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(data.filters)) if (value !== null && value !== false) params.set(key, String(value))
  params.set('offset', String(data.offset)); params.set('limit', String(data.limit)); params.set('revision', data.source_revision)
  return `/simulation/${encodeURIComponent(data.simulation_id)}/activity?${params}`
}
async function accept(call, data) { assert.ok(call, 'missing allocated read'); call.resolve(ok(data)); await flush() }
async function acceptEnvelope(call, envelope) { assert.ok(call, 'missing allocated activity read'); call.resolve(envelope); await flush() }
async function refuse(call, code) { assert.ok(call, 'missing allocated read'); call.reject({ response: { data: { success: false, error_code: code, error: 'Safe refusal.' } } }); await flush() }

// This is the retained production wrapper extraction used by saved-posts.test.
// Only service.get is replaced. The view still calls the actual getSavedPost
// wrapper, so the captured ID must survive its encodeURIComponent URL seam.
const wrapperSource = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const wrapperFor = service => new Function('service', wrapperSource + '\nreturn { getSavedPost };')(service)
const names = ['getSavedActivity', 'getSavedPost', 'getSavedPosts', 'getSavedPostSearch', 'getSavedActivityRounds', 'getSavedActivityAgents', 'getSimulationHistory', 'getSavedActionsExport', 'getComparisonCandidates']
const registered = []

function mountedGroup(name, allocations, run) {
  registered.push({ name, allocations })
  test(name, async t => {
    let mounts = 0
    async function mount({ data = activity(), initialPath = activityPath(data), locale = 'en', viewUnmount = false } = {}) {
      const expected = allocations[mounts++]
      assert.ok(expected, `unallocated mount in ${name}`)
      const calls = Object.fromEntries([...names, 'serviceGet'].map(key => [key, []]))
      const deferred = (key, args) => new Promise((resolve, reject) => calls[key].push({ args, signal: args.at(-1), resolve, reject }))
      const api = Object.fromEntries(names.map(key => [key, (...args) => deferred(key, args)]))
      const wrapped = wrapperFor({ get: (...args) => new Promise((resolve, reject) => calls.serviceGet.push({ args, signal: args[1].signal, resolve, reject })) })
      api.getSavedPost = (...args) => { calls.getSavedPost.push({ args, signal: args[3] }); return wrapped.getSavedPost(...args) }
      const h = await mountSavedActivity({ api, initialPath, locale, viewPaths: ['views/SavedPostsView.vue'], viewUnmount })
      const unmount = h.unmount
      let unmounted = false
      h.unmount = () => { if (!unmounted) { unmounted = true; unmount() } }
      t.after(() => {
        h.unmount()
        assert.deepEqual(Object.fromEntries([...names, 'serviceGet'].map(key => [key, calls[key].length])), {
          getSavedActivity: expected.activity, getSavedPost: expected.post,
          getSavedPosts: 0, getSavedPostSearch: 0, getSavedActivityRounds: 0, getSavedActivityAgents: 0,
          getSimulationHistory: 0, getSavedActionsExport: 0, getComparisonCandidates: 0,
          serviceGet: expected.post,
        }, `${name}: exact source-accounted API/service.get allocation`)
        assert.equal(h.downloads.length, expected.download ?? 0, `${name}: exact page download allocation`)
        assert.deepEqual(h.warnings, [], `${name}: compiled Vue or locale warning`)
      })
      return { h, calls, data }
    }
    await run(mount)
    assert.equal(mounts, allocations.length, `${name}: exact mount allocation`)
  })
}

function checkDetailCall(h, calls, { simulationId = 'sim_A', platform, postId }, index = 0) {
  assert.equal(h.router.currentRoute.value.name, 'SavedPosts')
  assert.equal(h.router.currentRoute.value.params.simulationId, simulationId)
  assert.deepEqual(query(h), { platform, post_id: postId }, 'destination owns only explicit platform and exact post ID')
  const apiCall = calls.getSavedPost[index], transport = calls.serviceGet[index]
  assert.ok(apiCall); assert.ok(transport)
  assert.equal(apiCall.args.length, 4)
  assert.equal(apiCall.args[0], simulationId); assert.equal(apiCall.args[1], postId)
  assert.equal(typeof apiCall.args[1], 'string')
  assert.deepEqual({ ...apiCall.args[2] }, { platform, offset: 0, limit: 25 })
  assert.ok(apiCall.signal instanceof AbortSignal); assert.equal(apiCall.signal.aborted, false)
  assert.equal(transport.args[0], `/api/simulation/${encodeURIComponent(simulationId)}/saved-posts/${encodeURIComponent(postId)}`)
  assert.deepEqual({ ...transport.args[1].params }, { platform, offset: 0, limit: 25 })
  assert.equal(transport.args[1].signal, apiCall.signal)
  assert.equal(calls.getSavedPosts.length, 0)
}
function assertRetired(h, calls, path) {
  assert.equal(h.router.currentRoute.value.fullPath, path)
  assert.equal(calls.getSavedPost.length, 0)
  assert.equal(calls.serviceGet.length, 0)
  assert.equal(calls.getSavedPosts.length, 0)
}

const happyCases = [
  { name: 'twitter LIKE_POST successful zero', platform: 'twitter', type: 'LIKE_POST', outcome: true, id: '0', locale: 'en' },
  { name: 'reddit LIKE_POST failed exact lower adjacent integer', platform: 'reddit', type: 'LIKE_POST', outcome: false, id: '9007199254740992', locale: 'zh' },
  { name: 'twitter DISLIKE_POST unknown exact upper adjacent integer', platform: 'twitter', type: 'DISLIKE_POST', outcome: null, id: '9007199254740993', locale: 'en' },
  { name: 'reddit DISLIKE_POST successful signed64 maximum', platform: 'reddit', type: 'DISLIKE_POST', outcome: true, id: '9223372036854775807', locale: 'zh' },
  { name: 'twitter CREATE_COMMENT failed exact decimal string', platform: 'twitter', type: 'CREATE_COMMENT', outcome: false, id: '9007199254740993', locale: 'en' },
  { name: 'reddit CREATE_COMMENT unknown maximum decimal string', platform: 'reddit', type: 'CREATE_COMMENT', outcome: null, id: '9223372036854775807', locale: 'zh' },
]
for (const [index, expected] of happyCases.entries()) {
  mountedGroup(`serialized source route: ${expected.name}`, [{ activity: 1, post: 1, download: index === 0 ? 1 : 0 }], async mount => {
    // The complete successful Flask envelope is passed through unchanged.
    const envelope = pythonEnvelopes[index]
    assert.equal(envelope.success, true); assert.equal(envelope.data.simulation_id, 'sim_A')
    assert.equal(envelope.data.limit, 50); assert.equal(envelope.data.actions.length, 1)
    const row = envelope.data.actions[0]
    assert.equal(row.platform, expected.platform); assert.equal(row.action_type, expected.type)
    assert.equal(row.success, expected.outcome); assert.equal(row.referenced_post_id, expected.id)
    assert.equal(typeof row.referenced_post_id, 'string')
    const { h, calls } = await mount({ data: envelope.data, locale: expected.locale })
    await acceptEnvelope(calls.getSavedActivity[0], envelope)
    assert.ok(h.byId('results')); assert.equal(h.byId('error'), undefined)
    const control = h.byId(buttonId(row))
    assert.ok(control); assert.equal(control.type, 'button'); assert.equal(control.props.type, 'button')
    assert.equal(h.text(control), expected.locale === 'en' ? 'Open referenced saved post' : '打开引用的已保存帖子')
    let details = control.parent
    while (details && details.type !== 'details') details = details.parent
    assert.ok(details, 'the navigation control belongs to the existing action details')
    if (index === 0) {
      await h.click('download'); assert.equal(h.downloads.length, 1)
      const downloaded = JSON.parse(await h.downloads[0].blob.text())
      const rows = envelope.data.actions.map(({ referenced_post_id: _projection, ...saved }) => saved)
      assert.deepEqual(downloaded, { format_version: 1, ...envelope.data, actions: rows })
      assert.equal(Object.hasOwn(downloaded.actions[0], 'referenced_post_id'), false)
      assert.equal(Object.hasOwn(row, 'referenced_post_id'), true)
      assert.equal(row.referenced_post_id, expected.id)
      assert.deepEqual(await readSavedActivityFile(h.downloads[0].blob), downloaded)
    }
    await h.click(buttonId(row))
    checkDetailCall(h, calls, { platform: expected.platform, postId: expected.id })
    const content = `fresh saved destination ${expected.name}`
    await accept(calls.serviceGet[0], detail(expected.id, { platform: expected.platform, post: { state: 'available', reason: null, row: post(expected.id, { content }) } }))
    assert.ok(h.byId('selected-post')); assert.ok(text(h, 'selected-post').includes(content))
    const committed = h.router.currentRoute.value.fullPath
    await flush()
    assert.equal(h.router.currentRoute.value.fullPath, committed, 'completed entry stays committed after the source view unmounts')
    h.unmount()
  })
}

mountedGroup('destination preserves an explicitly missing referenced post', [{ activity: 1, post: 1 }], async mount => {
  const { h, calls, data } = await mount()
  await accept(calls.getSavedActivity[0], data); await h.click(buttonId(data.actions[0]))
  checkDetailCall(h, calls, { platform: 'twitter', postId: '1' })
  await accept(calls.serviceGet[0], detail('1', { post: { state: 'missing', reason: 'post_missing', row: null }, comments: unavailable('post_unavailable') }))
  assert.equal(h.byId('selected-post'), undefined)
  assert.ok(text(h, 'posts-coverage').includes(h.i18n.global.t('savedPosts.states.missing')))
  assert.ok(text(h, 'posts-coverage').includes(h.i18n.global.t('savedPosts.reasons.post_missing')))
  assert.ok(text(h, 'comments-coverage').includes(h.i18n.global.t('savedPosts.states.unavailable')))
})

mountedGroup('destination preserves an unavailable selected platform database', [{ activity: 1, post: 1 }], async mount => {
  const data = activity({ actions: [action({ platform: 'reddit', record_id: 'reddit:1' })] })
  const { h, calls } = await mount({ data })
  await accept(calls.getSavedActivity[0], data); await h.click(buttonId(data.actions[0]))
  checkDetailCall(h, calls, { platform: 'reddit', postId: '1' })
  await accept(calls.serviceGet[0], detail('1', { platform: 'reddit', database: { state: 'unavailable', reason: 'database_missing' }, post: { state: 'unavailable', reason: 'database_missing', row: null }, comments: unavailable('post_unavailable') }))
  assert.equal(h.byId('selected-post'), undefined)
  assert.ok(text(h, 'posts-database').includes(h.i18n.global.t('savedPosts.reasons.database_missing')))
  assert.ok(text(h, 'posts-coverage').includes(h.i18n.global.t('savedPosts.states.unavailable')))
})

mountedGroup('stale owner: a draft edit synchronously retires the captured post handler', [{ activity: 1, post: 0 }], async mount => {
  const { h, calls, data } = await mount()
  await accept(calls.getSavedActivity[0], data)
  const old = h.byId(buttonId(data.actions[0])).props.onClick, path = h.router.currentRoute.value.fullPath
  h.byId('agent-id').props.onInput({ target: { value: '2' } })
  old(event()); await flush()
  assertRetired(h, calls, path); assert.equal(h.byId('results'), undefined)
  assert.equal(calls.getSavedActivity[0].signal.aborted, true)
})

mountedGroup('stale owner: same-URL refresh and same-record replacement never revive a captured handler', [{ activity: 2, post: 0 }], async mount => {
  const { h, calls, data } = await mount()
  await accept(calls.getSavedActivity[0], data)
  const old = h.byId(buttonId(data.actions[0])).props.onClick, acceptedPath = h.router.currentRoute.value.fullPath
  await h.click('refresh'); old(event()); await flush()
  assert.ok(h.byId('loading')); assert.equal(calls.getSavedPost.length, 0)
  const replacement = activity({ actions: [action({ referenced_post_id: '2', details_json: '{"fresh":"same record replacement"}' })] })
  await accept(calls.getSavedActivity[1], replacement)
  assert.equal(h.router.currentRoute.value.fullPath, acceptedPath)
  old(event()); await flush()
  assertRetired(h, calls, acceptedPath); assert.match(h.text(), /same record replacement/)
  assert.ok(h.byId(buttonId(replacement.actions[0])))
})

mountedGroup('stale owner: removed replaced and mutated accepted rows cannot reuse a captured handler', [{ activity: 1, post: 0 }], async mount => {
  const { h, calls, data } = await mount()
  await accept(calls.getSavedActivity[0], data)
  const row = data.actions[0], old = h.byId(buttonId(row)).props.onClick, path = h.router.currentRoute.value.fullPath
  const mutations = [
    () => { data.actions.splice(0, 1); return () => data.actions.push(row) },
    () => { data.actions[0] = { ...row }; return () => { data.actions[0] = row } },
    ...[['platform', 'reddit'], ['referenced_post_id', '2'], ['action_type', 'DISLIKE_POST'], ['record_id', 'twitter:2']].map(([key, value]) => () => { const previous = row[key]; row[key] = value; return () => { row[key] = previous } }),
    ...[['simulation_id', 'sim_B'], ['source_revision', newRevision]].map(([key, value]) => () => { const previous = data[key]; data[key] = value; return () => { data[key] = previous } }),
  ]
  assert.equal(mutations.length, 8, 'fixed in-place owner mutations, with no extra mount or read')
  for (const mutate of mutations) {
    const restore = mutate()
    old(event()); await flush(); assertRetired(h, calls, path)
    restore()
  }
})

mountedGroup('stale owner: run A to B to A cannot revive a captured same-ID handler', [{ activity: 3, post: 0 }], async mount => {
  const { h, calls, data } = await mount()
  await accept(calls.getSavedActivity[0], data)
  const old = h.byId(buttonId(data.actions[0])).props.onClick, originalPath = h.router.currentRoute.value.fullPath
  const second = activity({ simulation_id: 'sim_B' })
  await h.navigate(activityPath(second)); await accept(calls.getSavedActivity[1], second)
  old(event()); await flush(); assertRetired(h, calls, activityPath(second))
  await h.navigate(originalPath); old(event()); await flush()
  assert.ok(h.byId('loading')); assert.equal(calls.getSavedPost.length, 0)
  await accept(calls.getSavedActivity[2], activity({ actions: [action({ details_json: '{"current":"new run A observation"}' })] }))
  old(event()); await flush(); assertRetired(h, calls, originalPath)
  assert.match(h.text(), /new run A observation/); assert.equal(h.byId('error'), undefined)
})

mountedGroup('stale owner: a new admitted platform cannot reuse the prior platform handler', [{ activity: 2, post: 0 }], async mount => {
  const data = activity({ filters: { ...baseFilters(), platform: 'twitter' } })
  const { h, calls } = await mount({ data }); await accept(calls.getSavedActivity[0], data)
  const old = h.byId(buttonId(data.actions[0])).props.onClick
  const replacement = activity({ filters: { ...baseFilters(), platform: 'reddit' }, actions: [action({ platform: 'reddit', record_id: 'reddit:1' })] })
  await h.navigate(activityPath(replacement)); await accept(calls.getSavedActivity[1], replacement)
  old(event()); await flush(); assertRetired(h, calls, activityPath(replacement))
  assert.ok(h.byId(buttonId(replacement.actions[0])))
})

mountedGroup('stale owner: unmount permanently retires a captured post handler', [{ activity: 1, post: 0 }], async mount => {
  const { h, calls, data } = await mount({ viewUnmount: true }); await accept(calls.getSavedActivity[0], data)
  const old = h.byId(buttonId(data.actions[0])).props.onClick, path = h.router.currentRoute.value.fullPath
  await h.unmountView(); old(event()); await flush()
  assertRetired(h, calls, path); assert.equal(h.root.children.filter(node => node.type !== '#comment').length, 0)
  assert.equal(calls.getSavedActivity[0].signal.aborted, true)
})

mountedGroup('guarded entry: repeated captured clicks dispatch one navigation and one exact detail read', [{ activity: 1, post: 1 }], async mount => {
  const { h, calls, data } = await mount(); await accept(calls.getSavedActivity[0], data)
  let release, guards = 0
  h.router.beforeEach(to => to.name === 'SavedPosts' ? (guards++, new Promise(resolve => { release = resolve })) : true)
  const old = h.byId(buttonId(data.actions[0])).props.onClick
  old(event()); old(event()); await flush()
  assert.equal(guards, 1); assert.ok(release); assert.equal(calls.getSavedPost.length, 0)
  release(true); await flush()
  checkDetailCall(h, calls, { platform: 'twitter', postId: '1' })
  await accept(calls.serviceGet[0], detail())
  old(event()); await flush()
  assert.equal(guards, 1); assert.equal(calls.getSavedPost.length, 1); assert.ok(h.byId('selected-post'))
})

mountedGroup('guarded entry: draft editing cancels the pending post intent before guard completion', [{ activity: 1, post: 0 }], async mount => {
  const { h, calls, data } = await mount(); await accept(calls.getSavedActivity[0], data)
  const path = h.router.currentRoute.value.fullPath, old = h.byId(buttonId(data.actions[0])).props.onClick
  let release
  h.router.beforeEach(to => to.name === 'SavedPosts' ? new Promise(resolve => { release = resolve }) : true)
  old(event()); await flush(); assert.ok(release)
  await h.input('agent-id', '2'); release(true); await flush(); old(event()); await flush()
  assertRetired(h, calls, path); assert.equal(h.byId('results'), undefined); assert.equal(h.byId('error'), undefined)
})

mountedGroup('guarded entry: Apply and Refresh each supersede a pending navigation with their newer observation', [{ activity: 2, post: 0 }, { activity: 2, post: 0 }], async mount => {
  for (const control of ['apply', 'refresh']) {
    const { h, calls, data } = await mount(); await accept(calls.getSavedActivity[0], data)
    const old = h.byId(buttonId(data.actions[0])).props.onClick
    let release
    h.router.beforeEach(to => to.name === 'SavedPosts' ? new Promise(resolve => { release = resolve }) : true)
    old(event()); await flush(); assert.ok(release)
    await h.click(control)
    assert.equal(calls.getSavedActivity[1].args[1].revision, control === 'apply' ? revision : undefined)
    const replacement = activity({ source_revision: control === 'apply' ? revision : newRevision, actions: [action({ details_json: JSON.stringify({ latest: `${control} result` }) })] })
    await accept(calls.getSavedActivity[1], replacement)
    const path = h.router.currentRoute.value.fullPath
    release(true); await flush(); old(event()); await flush()
    assertRetired(h, calls, path); assert.equal(h.router.currentRoute.value.name, 'SavedActivity')
    assert.ok(h.text().includes(`${control} result`)); assert.equal(h.byId('error'), undefined)
    h.unmount()
  }
})

mountedGroup('guarded entry: unmount refused current navigation and rejected old navigation retain ownership', [{ activity: 1, post: 0 }, { activity: 2, post: 0 }, { activity: 3, post: 0 }], async mount => {
  // (a) Explicit unmount supersedes an uncommitted guard, then ignores completion.
  const first = await mount({ viewUnmount: true }); await accept(first.calls.getSavedActivity[0], first.data)
  const firstPath = first.h.router.currentRoute.value.fullPath
  let release
  first.h.router.beforeEach(to => to.name === 'SavedPosts' ? new Promise(resolve => { release = resolve }) : true)
  await first.h.click(buttonId(first.data.actions[0])); assert.ok(release)
  await first.h.unmountView(); release(true); await flush()
  assertRetired(first.h, first.calls, firstPath); assert.equal(first.h.root.children.filter(node => node.type !== '#comment').length, 0)

  // (b) false resolves push with a failure; current owner shows the generic error.
  const second = await mount(); await accept(second.calls.getSavedActivity[0], second.data)
  const secondPath = second.h.router.currentRoute.value.fullPath, refused = second.h.byId(buttonId(second.data.actions[0])).props.onClick
  const remove = second.h.router.beforeEach(to => to.name === 'SavedPosts' ? false : true)
  refused(event()); await flush()
  assertRetired(second.h, second.calls, secondPath)
  assert.equal(text(second.h, 'error'), second.h.i18n.global.t('savedActivity.errors.generic'))
  assert.equal(second.h.byId('results'), undefined)
  refused(event()); await flush(); assertRetired(second.h, second.calls, secondPath)
  remove(); await second.h.click('refresh')
  await accept(second.calls.getSavedActivity[1], activity({ source_revision: newRevision }))
  assert.ok(second.h.byId('results')); assert.equal(second.h.byId('error'), undefined)
  refused(event()); await flush(); assert.equal(second.calls.getSavedPost.length, 0)
  second.h.unmount()

  // (c) A rejected old push settles once after a newer result and once after a
  // newer read error. Neither catch/finally may erase the replacement owner.
  const third = await mount(); await accept(third.calls.getSavedActivity[0], third.data)
  const rejections = []
  third.h.router.onError(() => {})
  third.h.router.beforeEach(to => to.name === 'SavedPosts' ? new Promise((_resolve, reject) => { rejections.push(reject) }) : true)
  await third.h.click(buttonId(third.data.actions[0])); assert.equal(rejections.length, 1)
  await third.h.click('refresh')
  const fresh = activity({ source_revision: newRevision, actions: [action({ details_json: '{"current":"newer accepted result"}' })] })
  await accept(third.calls.getSavedActivity[1], fresh)
  const freshPath = third.h.router.currentRoute.value.fullPath
  rejections[0](new Error('retired first guard')); await flush()
  assertRetired(third.h, third.calls, freshPath); assert.match(third.h.text(), /newer accepted result/)
  assert.equal(third.h.byId('error'), undefined); assert.equal(third.h.byId('loading'), undefined)
  await third.h.click(buttonId(fresh.actions[0])); assert.equal(rejections.length, 2)
  await third.h.click('refresh'); assert.ok(third.h.byId('loading'))
  await refuse(third.calls.getSavedActivity[2], 'sources_changed')
  const currentError = text(third.h, 'error'), currentPath = third.h.router.currentRoute.value.fullPath
  assert.equal(currentError, third.h.i18n.global.t('savedActivity.errors.sources_changed'))
  rejections[1](new Error('retired second guard')); await flush()
  assertRetired(third.h, third.calls, currentPath)
  assert.equal(text(third.h, 'error'), currentError); assert.equal(third.h.byId('loading'), undefined)
})

mountedGroup('Back and Forward restore exact activity filters revision and a fresh selected detail read', [{ activity: 2, post: 2 }], async mount => {
  const filters = { platform: 'reddit', agent_id: '0', round_num: '1', action_type: 'CREATE_COMMENT', q: 'reference', case_sensitive: true, outcome: 'unknown' }
  const row = action({ record_id: 'reddit:2', platform: 'reddit', action_type: 'CREATE_COMMENT', success: null, referenced_post_id: '9007199254740993', match_preview: 'reference' })
  const data = activity({ filters, offset: 1, limit: 1, matched_count: 2, actions: [row] })
  const { h, calls } = await mount({ data }); await accept(calls.getSavedActivity[0], data)
  const acceptedPath = h.router.currentRoute.value.fullPath, acceptedQuery = query(h)
  await h.click(buttonId(row)); checkDetailCall(h, calls, { platform: 'reddit', postId: row.referenced_post_id })
  await accept(calls.serviceGet[0], detail(row.referenced_post_id, { platform: 'reddit' }))
  const selectedPath = h.router.currentRoute.value.fullPath
  await h.back()
  assert.equal(h.router.currentRoute.value.fullPath, acceptedPath)
  assert.deepEqual(query(h), acceptedQuery)
  assert.deepEqual({ ...calls.getSavedActivity[1].args[1] }, { ...filters, offset: 1, limit: 1, revision })
  await accept(calls.getSavedActivity[1], data)
  assert.ok(h.byId(buttonId(row))); assert.equal(calls.getSavedPost.length, 1)
  await h.forward()
  assert.equal(h.router.currentRoute.value.fullPath, selectedPath)
  checkDetailCall(h, calls, { platform: 'reddit', postId: row.referenced_post_id }, 1)
  assert.notEqual(calls.getSavedPost[0].signal, calls.getSavedPost[1].signal)
  const content = 'fresh detail after Forward'
  await accept(calls.serviceGet[1], detail(row.referenced_post_id, { platform: 'reddit', post: { state: 'available', reason: null, row: post(row.referenced_post_id, { content }) } }))
  assert.ok(text(h, 'selected-post').includes(content))
})

mountedGroup('projection admission: six invalid envelopes then valid null and supported string use exactly eight reads', [{ activity: 8, post: 0 }], async mount => {
  const { h, calls } = await mount()
  const cases = [
    ['missing field', row => { delete row.referenced_post_id }, false],
    ['unsafe numeric value', row => { row.referenced_post_id = 9007199254740992 }, false],
    ['boolean', row => { row.referenced_post_id = true }, false],
    ['noncanonical final-newline string', row => { row.referenced_post_id = '1\n' }, false],
    ['above signed64', row => { row.referenced_post_id = '9223372036854775808' }, false],
    ['unsupported action', row => { row.action_type = 'CREATE_POST' }, false],
    ['valid null', row => { row.referenced_post_id = null }, true],
    ['valid supported string', row => { row.referenced_post_id = '9223372036854775807' }, true],
  ]
  assert.equal(cases.length, 8)
  for (const [index, [name, mutate, accepted]] of cases.entries()) {
    if (index) await h.click('refresh')
    const data = activity(); mutate(data.actions[0])
    await accept(calls.getSavedActivity[index], data)
    assert.equal(Boolean(h.byId('results')), accepted, name)
    assert.equal(Boolean(h.byId('error')), !accepted, name)
    assert.equal(Boolean(h.byId(buttonId(data.actions[0]))), index === 7, name)
    assert.equal(calls.getSavedPost.length, 0, name); assert.equal(calls.serviceGet.length, 0, name)
  }
})

// Registration and allocation assertions are not additional test groups.
assert.equal(registered.length, 20)
assert.equal(new Set(registered.map(group => group.name)).size, 20)
assert.equal(registered.flatMap(group => group.allocations).length, 23)
assert.equal(registered.flatMap(group => group.allocations).reduce((sum, item) => sum + item.activity, 0), 40)
assert.equal(registered.flatMap(group => group.allocations).reduce((sum, item) => sum + item.post, 0), 11)
assert.equal(registered.flatMap(group => group.allocations).reduce((sum, item) => sum + (item.download ?? 0), 0), 1)
