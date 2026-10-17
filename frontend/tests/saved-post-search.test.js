import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountSavedActivity, flush, ok } from './helpers/saved-activity-view-fixture.js'
import { list, detail, post, comment, page, unavailable, metadata, path, maxId, event } from './helpers/saved-posts-view-fixture.js'

// SOURCE PREPARATION ONLY. The separately released serial gate may execute this
// fixed allocation: 12 groups, 18 real Vue/router mounts, 72 read-wrapper calls
// and exactly 72 corresponding deferred service.get calls. No live GETs, writes,
// downloads, browser sessions, timers, generated cases or dependency acquisition.
const pageSize = 25, responseLimit = 2097152
const query = h => ({ ...h.router.currentRoute.value.query })
const text = (h, id) => { const node = h.byId(id); assert.ok(node, `missing ${id}`); return h.text(node) }
const asciiBytes = data => JSON.stringify(ok(data)).replace(/[\u007f-\uffff]/g, value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0')).length
const clone = value => JSON.parse(JSON.stringify(value))
const names = ['getSavedPosts', 'getSavedPost', 'getSavedPostSearch', 'getSavedActivity', 'getSavedActivityRounds', 'getSavedActivityAgents', 'getSimulationHistory', 'getSavedActionsExport', 'getComparisonCandidates']
const wrappers = ['getSavedPosts', 'getSavedPost', 'getSavedPostSearch']
const registered = []

// Use the existing saved-post-navigation extraction seam: evaluate the actual
// API module with only service.get replaced, rather than mocking its wrappers.
const wrapperSource = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const wrapperFor = service => new Function('service', wrapperSource + '\nreturn { getSavedPosts, getSavedPost, getSavedPostSearch };')(service)

function searchPath({ platform = 'twitter', q = 'text', kind = 'posts', sensitive = false, offset = 0, postId, commentOffset = 0 } = {}) {
  const params = new URLSearchParams({ platform, q, kind })
  if (sensitive) params.set('case_sensitive', 'true')
  if (offset) params.set('offset', String(offset))
  if (postId !== undefined) params.set('post_id', postId)
  if (commentOffset) params.set('comment_offset', String(commentOffset))
  return path + '?' + params
}
function searchData(call, changes = {}) {
  assert.ok(call, 'missing allocated search read')
  const params = call.args[1], rows = changes.rows ?? [params.kind === 'comments' ? comment() : post()]
  const matched = changes.matched ?? params.offset + rows.length
  const results = { state: rows.length ? 'available' : params.offset ? 'out_of_range' : 'empty', reason: null,
    offset: params.offset, limit: params.limit, count: rows.length, matched_count: matched,
    has_more: params.offset + rows.length < matched, rows, ...(changes.results ?? {}) }
  return { simulation_id: call.args[0], platform: params.platform, observed_at: '2026-10-17T12:00:00+00:00',
    metadata: changes.metadata ?? metadata(), database: changes.database ?? { state: 'available', reason: null },
    search: { kind: params.kind, q: params.q, case_sensitive: params.case_sensitive ?? false }, results }
}
const fullRows = (offset = 0) => Array.from({ length: pageSize }, (_, index) => post(String(1000000 - offset - index)))
async function accept(call, data) { assert.ok(call, 'missing allocated read'); call.resolve(ok(data)); await flush() }
async function acceptSearch(call, changes = {}) { await accept(call, searchData(call, changes)) }
async function refuse(call, code = 'sources_changed') {
  assert.ok(call, 'missing allocated read')
  call.reject({ response: { data: { success: false, error_code: code, error: 'PRIVATE_ERROR_MUST_NOT_RENDER' } } }); await flush()
}
async function setCase(h, checked) { h.byId('posts-match-case').props.onChange({ target: { checked } }); await flush() }
function assertNoRows(h) { assert.equal(h.byId('search-results'), undefined); assert.equal(h.byId('selected-post'), undefined) }
function assertSearchCall(call, expected = {}) {
  assert.ok(call); assert.equal(call.args.length, 3); assert.equal(call.args[0], 'sim_A')
  const actual = { ...call.args[1] }
  assert.deepEqual(actual, { platform: 'twitter', kind: 'posts', q: 'text', case_sensitive: false, offset: 0, limit: pageSize, ...expected })
}
function assertDetailCall(call, postId, platform = 'twitter', offset = 0) {
  assert.ok(call); assert.equal(call.args.length, 4)
  assert.equal(call.args[0], 'sim_A'); assert.equal(call.args[1], postId); assert.equal(typeof call.args[1], 'string')
  assert.deepEqual({ ...call.args[2] }, { platform, offset, limit: pageSize }, 'detail must not receive search/return-context fields')
}
function mountedGroup(name, allocations, run) {
  registered.push({ name, allocations })
  test(name, async t => {
    let mounted = 0
    async function mount({ initialPath = searchPath(), locale = 'en', viewUnmount = false } = {}) {
      const expected = allocations[mounted++]
      assert.ok(expected, `unallocated mount in ${name}`)
      const calls = Object.fromEntries([...names, 'serviceGet'].map(key => [key, []]))
      const api = Object.fromEntries(names.map(key => [key, (...args) => new Promise((resolve, reject) => calls[key].push({ args, signal: args.at(-1), resolve, reject }))]))
      const wrapped = wrapperFor({ get: (...args) => new Promise((resolve, reject) => calls.serviceGet.push({ args, signal: args[1].signal, resolve, reject })) })
      for (const key of wrappers) api[key] = (...args) => {
        const call = { args, signal: args.at(-1) }, before = calls.serviceGet.length
        calls[key].push(call)
        const response = wrapped[key](...args)
        assert.equal(calls.serviceGet.length, before + 1, 'each actual wrapper issues exactly one deferred service.get')
        const transport = calls.serviceGet.at(-1), params = args[key === 'getSavedPost' ? 2 : 1]
        Object.assign(call, { resolve: transport.resolve, reject: transport.reject, transport })
        const suffix = key === 'getSavedPostSearch' ? 'saved-post-search' : key === 'getSavedPost' ? 'saved-posts/' + encodeURIComponent(args[1]) : 'saved-posts'
        assert.equal(transport.args[0], `/api/simulation/${encodeURIComponent(args[0])}/${suffix}`)
        assert.deepEqual(Object.keys(transport.args[1]).sort(), ['params', 'signal'])
        assert.deepEqual({ ...transport.args[1].params }, { ...params })
        assert.ok(call.signal instanceof AbortSignal); assert.equal(call.signal.aborted, false)
        assert.equal(transport.args[1].signal, call.signal)
        return response
      }
      const h = await mountSavedActivity({ api, initialPath, locale, viewUnmount, viewPaths: ['views/SavedPostsView.vue'] })
      const original = h.unmount
      let unmounted = false
      h.unmount = () => { if (!unmounted) { unmounted = true; original() } }
      t.after(() => {
        h.unmount()
        assert.deepEqual(Object.fromEntries(names.map(key => [key, calls[key].length])), {
          getSavedPosts: expected.list ?? 0, getSavedPost: expected.detail ?? 0, getSavedPostSearch: expected.search ?? 0,
          getSavedActivity: 0, getSavedActivityRounds: 0, getSavedActivityAgents: 0, getSimulationHistory: 0, getSavedActionsExport: 0, getComparisonCandidates: 0,
        }, `${name}: exact read-wrapper allocation`)
        assert.equal(calls.serviceGet.length, (expected.list ?? 0) + (expected.detail ?? 0) + (expected.search ?? 0), `${name}: exact deferred service.get allocation`)
        assert.equal(h.downloads.length, 0); assert.deepEqual(h.warnings, [], `${name}: compiled Vue/localization warnings`)
      })
      return { h, calls }
    }
    await run(mount)
    assert.equal(mounted, allocations.length, `${name}: exact mount allocation`)
  })
}

mountedGroup('root apply empty clear counts and bounded phrase/route admission', [{ list: 3, search: 4 }, {}], async mount => {
  const { h, calls } = await mount({ initialPath: path })
  assert.equal(calls.serviceGet.length, 0); assert.ok(h.byId('posts-choose'))
  await h.change('posts-platform', 'twitter'); await accept(calls.getSavedPosts[0], list())
  assert.equal(h.byId('posts-search-kind').props.value, 'posts')
  assert.equal(h.byId('posts-match-case').props.checked, false)
  assert.equal(h.byId('posts-search-phrase').props.maxlength, undefined, 'UTF-16 maxlength must not reject valid 200-scalar phrases')
  const phrase = ' exact & 文 .* [x] '
  await h.input('posts-search-phrase', phrase); await h.submit('posts-search-form')
  assertSearchCall(calls.getSavedPostSearch[0], { q: phrase })
  await acceptSearch(calls.getSavedPostSearch[0], { rows: [], matched: 0 })
  assert.match(text(h, 'search-counts'), /0/); assert.ok(text(h, 'search-coverage').includes(h.i18n.global.t('savedPosts.search.states.empty')))
  assert.ok(h.byId('search-next').props.disabled); assert.ok(h.byId('search-previous').props.disabled)
  await h.input('posts-search-phrase', ''); await h.click('posts-apply')
  assert.deepEqual(query(h), { platform: 'twitter' }); await accept(calls.getSavedPosts[1], list())
  assert.deepEqual({ ...calls.getSavedPosts[1].args[1] }, { platform: 'twitter', offset: 0, limit: pageSize })
  await h.input('posts-search-phrase', 'text'); await h.click('posts-apply'); await acceptSearch(calls.getSavedPostSearch[1])
  await h.click('posts-clear'); await accept(calls.getSavedPosts[2], list())
  assert.deepEqual(query(h), { platform: 'twitter' }); assert.equal(h.byId('posts-search-phrase').props.value, '')
  const invalidDrafts = [' ', '\u00a0\u1680\u2000\u200a\u202f\u205f\u3000', '\t', '\u001c', 'bad\u0000text', '\u007f', '\u0085', '\u2028', '\u2029', '\ud800', '\udfff', '😀'.repeat(201)]
  assert.equal(invalidDrafts.length, 12)
  for (const value of invalidDrafts) {
    await h.input('posts-search-phrase', value); await h.click('posts-apply')
    assert.equal(calls.serviceGet.length, 5); assert.ok(h.byId('posts-error')); assertNoRows(h)
  }
  for (const value of ['😀'.repeat(200), '\ufeff']) {
    await h.input('posts-search-phrase', value); await h.click('posts-apply')
    const call = calls.getSavedPostSearch.at(-1); assert.equal(call.args[1].q, value)
    await acceptSearch(call); assert.ok(h.byId('search-results')); assert.equal(h.byId('posts-error'), undefined)
  }
  assert.equal([...calls.getSavedPostSearch[2].args[1].q].length, 200)
  h.unmount()

  const invalidRoutes = [
    'q=text', 'platform=twitter&kind=posts', 'platform=twitter&case_sensitive=false',
    'platform=twitter&q=text', 'platform=twitter&q=&kind=posts', 'platform=twitter&q&kind=posts',
    'platform=twitter&q=%20%20&kind=posts', 'platform=twitter&q=%E3%80%80&kind=posts',
    'platform=twitter&q=%00&kind=posts', 'platform=twitter&q=%7F&kind=posts', 'platform=twitter&q=%C2%85&kind=posts',
    'platform=twitter&q=%E2%80%A8&kind=posts', 'platform=twitter&q=%E2%80%A9&kind=posts',
    `platform=twitter&q=${encodeURIComponent('😀'.repeat(201))}&kind=posts`,
    'platform=twitter&q=a&q=b&kind=posts', 'platform=twitter&q=text&kind=posts&kind=comments',
    'platform=twitter&q=text&kind=', 'platform=twitter&q=text&kind=Posts', 'platform=twitter&q=text&kind=all',
    'platform=twitter&q=text&kind=posts&case_sensitive=', 'platform=twitter&q=text&kind=posts&case_sensitive',
    'platform=twitter&q=text&kind=posts&case_sensitive=1', 'platform=twitter&q=text&kind=posts&case_sensitive=True',
    'platform=twitter&q=text&kind=posts&case_sensitive=false&case_sensitive=true',
    'platform=twitter&q=text&kind=posts&offset=01', 'platform=twitter&q=text&kind=posts&offset=500001',
    'platform=twitter&q=text&kind=posts&comment_offset=25', 'platform=twitter&q=text&kind=posts&limit=25',
    'platform=other&q=text&kind=posts', 'platform=twitter&platform=reddit&q=text&kind=posts',
    'platform=twitter&q=text&kind=comments&post_id=9223372036854775808', 'platform=twitter&q=text&kind=posts&unknown=x',
  ]
  assert.equal(invalidRoutes.length, 32)
  const invalid = await mount({ initialPath: path + '?' + invalidRoutes[0] })
  for (const [index, selection] of invalidRoutes.entries()) {
    if (index) await invalid.h.navigate(path + '?' + selection)
    assert.equal(invalid.calls.serviceGet.length, 0, selection); assert.ok(invalid.h.byId('posts-error'), selection)
    assertNoRows(invalid.h)
  }
})

mountedGroup('both locales and kinds render complete literal fields with scoped counts and attribution', [{ search: 2 }, { search: 2 }], async mount => {
  const literal = '<img src="https://invalid.example/pixel" onerror="alert(1)">\n<script>alert(2)</script>\n[click](javascript:alert(3)) **literal**'
  for (const locale of ['en', 'zh']) {
    const { h, calls } = await mount({ locale, initialPath: searchPath({ q: 'STRASSE' }) })
    for (const id of ['posts-search-phrase', 'posts-search-kind', 'posts-match-case']) {
      const input = h.byId(id); assert.ok(input)
      assert.ok(h.find(node => node.type === 'label' && node.props.for === input.props.id), `${locale}: explicit label for ${id}`)
    }
    const rows = [post(maxId, { content: literal, original_post_id: '0', quote_content: 'Straße: complete owned quote', created_at: maxId }), post('0', { content: null, quote_content: 'Straße', user_id: null, created_at: null })]
    await acceptSearch(calls.getSavedPostSearch[0], { rows, matched: 2, metadata: metadata({ status: 'stopped', partial: true, warning: 'run_state_missing' }) })
    assert.ok(text(h, 'post-row').includes(literal)); assert.ok(h.text().includes('Straße: complete owned quote'))
    assert.ok(h.byId('posts-partial')); assert.ok(h.byId('posts-warning')); assert.ok(h.byId('posts-observed'))
    assert.ok(h.byId('post-reference-note')); assert.ok(h.byId('post-open-' + maxId)); assert.match(text(h, 'search-counts'), /2/)
    assert.ok(text(h, 'search-scope').length > 12)
    await h.change('posts-search-kind', 'comments'); await setCase(h, true); await h.click('posts-apply')
    assertSearchCall(calls.getSavedPostSearch[1], { q: 'STRASSE', kind: 'comments', case_sensitive: true })
    const comments = [comment('9007199254740992', maxId, { content: literal }), comment('9007199254740993', '0', { content: 'not a frontend STRASSE match', user_id: null })]
    await acceptSearch(calls.getSavedPostSearch[1], { rows: comments, matched: 2 })
    assert.ok(text(h, 'comment-row').includes(literal)); assert.ok(text(h, 'comment-row').includes(maxId))
    assert.ok(h.byId('comment-open-9007199254740992')); assert.ok(h.byId('comment-open-9007199254740993'))
    assert.equal(text(h, 'comment-open-9007199254740992'), locale === 'en' ? 'Open referenced saved post' : '打开引用的已保存帖子')
    assert.equal(h.all(node => ['img', 'script', 'iframe', 'mark'].includes(node.type)).length, 0)
    assert.doesNotMatch(h.text(), /savedPosts\.|comparison\./)
    if (locale === 'en') { assert.match(text(h, 'search-scope'), /comment/i); assert.match(text(h, 'posts-twitter'), /comment/i) }
    h.unmount()
  }
})

mountedGroup('strict complete envelope echo count exact-ID order and ASCII byte admission', [{ search: 23 }], async mount => {
  const { h, calls } = await mount()
  const mutations = [
    ['phrase echo', data => { data.search.q = 'other' }],
    ['kind echo', data => { data.search.kind = 'comments' }],
    ['case echo', data => { data.search.case_sensitive = true }],
    ['extra root field', data => { data.extra = true }],
    ['missing search field', data => { delete data.search.case_sensitive }],
    ['extra results field', data => { data.results.extra = true }],
    ['extra projected row field', data => { data.results.rows[0].extra = true }],
    ['returned count mismatch', data => { data.results.count = 0 }],
    ['negative matching count', data => { data.results.matched_count = -1 }],
    ['matching count exceeds complete-table bound', data => { data.results.matched_count = 50001 }],
    ['exact page-count equation', data => { data.results.matched_count = 2; data.results.has_more = true }],
    ['exact has-more equation', data => { data.results.rows = fullRows(); data.results.count = 25; data.results.matched_count = 26; data.results.has_more = false }],
    ['state equation', data => { data.results.state = 'empty' }],
    ['unsafe numeric ID', data => { data.results.rows[0].post_id = 9007199254740992 }],
    ['noncanonical final-newline ID', data => { data.results.rows[0].post_id = '1\n' }],
    ['ID above signed64', data => { data.results.rows[0].post_id = '9223372036854775808' }],
    ['duplicate exact IDs', data => { data.results.rows = [post('2'), post('2')]; data.results.count = data.results.matched_count = 2 }],
    ['wrong saved-ID order', data => { data.results.rows = [post('1'), post('2')]; data.results.count = data.results.matched_count = 2 }],
    ['malformed comment parent', data => { data.search.kind = 'comments'; data.results.rows = [comment('1', '01')] }, 'comments'],
    ['refusal cannot retain staged count', data => { data.results = { ...data.results, state: 'unavailable', reason: 'search_limit', rows: [], count: null, matched_count: 1, has_more: null } }],
    ['simulation identity', data => { data.simulation_id = 'sim_B' }],
  ]
  assert.equal(mutations.length, 21)
  for (const [index, [label, mutate, kind = 'posts']] of mutations.entries()) {
    if (index) {
      if (h.router.currentRoute.value.query.kind !== kind) await h.navigate(searchPath({ kind }))
      else await h.click('posts-refresh')
    }
    const call = calls.getSavedPostSearch[index], data = searchData(call); mutate(data)
    await accept(call, data)
    assertNoRows(h); assert.ok(h.byId('posts-error'), label); assert.equal(h.byId('posts-loading'), undefined, label)
    assert.equal(h.byId('search-counts'), undefined, label)
  }
  await h.click('posts-refresh')
  const exact = searchData(calls.getSavedPostSearch[21], { rows: [post('1', { content: '' })] })
  const remaining = responseLimit - asciiBytes(exact)
  assert.ok(remaining > 0)
  exact.results.rows[0].content = '\u007f'.repeat(Math.floor(remaining / 6)) + 'x'.repeat(remaining % 6)
  assert.equal(asciiBytes(exact), responseLimit, 'count the entire success envelope and every escaped field')
  assert.ok(JSON.stringify(ok(exact)).length < responseLimit, 'decoded string length is not the ASCII serialization bound')
  await accept(calls.getSavedPostSearch[21], exact)
  assert.ok(h.byId('search-results')); assert.equal(h.byId('posts-error'), undefined)
  await h.click('posts-refresh')
  const above = clone(exact); above.results.rows[0].content += 'x'
  assert.equal(asciiBytes(above), responseLimit + 1)
  await accept(calls.getSavedPostSearch[22], above)
  assertNoRows(h); assert.ok(h.byId('posts-error')); assert.equal(h.byId('search-counts'), undefined)
})

mountedGroup('post and cross-parent comment entry preserve exact return context but detail has no search params', [{ search: 2, detail: 1 }, { search: 2, detail: 1 }], async mount => {
  for (const kind of ['posts', 'comments']) {
    const { h, calls } = await mount({ initialPath: searchPath({ platform: 'reddit', q: ' exact & 文 ', kind, sensitive: true, offset: 25 }) })
    const row = kind === 'posts' ? post(maxId) : comment('9007199254740993', maxId)
    await acceptSearch(calls.getSavedPostSearch[0], { rows: [row], matched: 26 })
    const committed = query(h), button = (kind === 'posts' ? 'post-open-' : 'comment-open-') + (kind === 'posts' ? row.post_id : row.comment_id)
    await h.click(button)
    assert.deepEqual(query(h), { ...committed, post_id: maxId })
    assert.equal(h.byId('posts-search-form'), undefined); assertDetailCall(calls.getSavedPost[0], maxId, 'reddit')
    await accept(calls.getSavedPost[0], detail(maxId, { platform: 'reddit', comments: page([comment('1', maxId, { content: 'ordinary unfiltered first comment page' })]) }))
    assert.ok(text(h, 'selected-post').includes(maxId)); assert.match(h.text(), /ordinary unfiltered first comment page/)
    await h.click('posts-return')
    assert.deepEqual(query(h), committed); assert.equal(h.byId('selected-post'), undefined)
    assertSearchCall(calls.getSavedPostSearch[1], { platform: 'reddit', q: ' exact & 文 ', kind, case_sensitive: true, offset: 25 })
    await acceptSearch(calls.getSavedPostSearch[1], { rows: [], matched: 1 })
    assert.ok(text(h, 'search-coverage').includes(h.i18n.global.t('savedPosts.search.states.out_of_range')))
    assert.match(text(h, 'search-counts'), /1/); assert.match(text(h, 'search-counts'), /0/)
    assert.equal(h.byId('search-previous').props.disabled, false); assert.equal(h.byId('search-next').props.disabled, true)
    h.unmount()
  }
})

mountedGroup('missing comment parent source refusal and search refusal retain honest coverage without counts', [{ search: 2, detail: 2 }], async mount => {
  const { h, calls } = await mount({ initialPath: searchPath({ kind: 'comments' }) })
  await acceptSearch(calls.getSavedPostSearch[0], { rows: [comment('1', maxId)] })
  await h.click('comment-open-1'); assertDetailCall(calls.getSavedPost[0], maxId)
  await accept(calls.getSavedPost[0], detail(maxId, { post: { state: 'missing', reason: 'post_missing', row: null }, comments: unavailable('post_unavailable') }))
  assert.equal(h.byId('selected-post'), undefined); assert.ok(text(h, 'posts-coverage').includes(h.i18n.global.t('savedPosts.reasons.post_missing')))
  await h.click('posts-refresh')
  await accept(calls.getSavedPost[1], detail(maxId, { database: { state: 'unavailable', reason: 'database_missing' }, post: { state: 'unavailable', reason: 'database_missing', row: null }, comments: unavailable('post_unavailable') }))
  assert.ok(text(h, 'posts-database').includes(h.i18n.global.t('savedPosts.reasons.database_missing')))
  await h.click('posts-return')
  await acceptSearch(calls.getSavedPostSearch[1], { rows: [], results: { state: 'unavailable', reason: 'search_limit', count: null, matched_count: null, has_more: null } })
  assert.ok(text(h, 'search-coverage').includes(h.i18n.global.t('savedPosts.reasons.search_limit')))
  assert.equal(h.all(node => ['post-row', 'comment-row'].includes(node.props['data-testid'])).length, 0)
  assert.equal(h.byId('posts-error'), undefined); assert.ok(h.byId('search-next').props.disabled)
  assert.equal(text(h, 'search-counts'), h.i18n.global.t('savedPosts.search.counts', { matched: h.i18n.global.t('savedPosts.unknown'), count: h.i18n.global.t('savedPosts.unknown'), offset: 0 }), 'refused counts remain unknown even when the requested offset is zero')
})

mountedGroup('all three dirty controls synchronously abort and retire handlers while Refresh restores committed values', [{ search: 4 }], async mount => {
  const { h, calls } = await mount({ initialPath: searchPath({ q: 'committed', sensitive: true, offset: 25 }) })
  await acceptSearch(calls.getSavedPostSearch[0], { rows: fullRows(), matched: 51 })
  const oldRow = h.byId('post-open-1000000').props.onClick, oldNext = h.byId('search-next').props.onClick
  const edits = [
    ['posts-search-phrase', { target: { value: 'unapplied' } }, 'onInput'],
    ['posts-search-kind', { target: { value: 'comments' } }, 'onChange'],
    ['posts-match-case', { target: { checked: false } }, 'onChange'],
  ]
  for (const [index, [id, change, eventName]] of edits.entries()) {
    const old = calls.getSavedPostSearch[index], committed = h.router.currentRoute.value.fullPath
    h.byId(id).props[eventName](change)
    assert.equal(old.signal.aborted, true, `${id}: abort is synchronous`)
    oldRow(event()); oldNext(event()); await flush()
    assert.equal(calls.serviceGet.length, index + 1); assert.equal(h.router.currentRoute.value.fullPath, committed)
    assertNoRows(h); assert.ok(h.byId('posts-dirty')); assert.equal(h.byId('posts-loading'), undefined)
    // The kind/case edits retire unresolved reads. Both late fulfillment and
    // rejection/finally must leave the dirty draft retired, even if abort is ignored.
    if (index === 1) await acceptSearch(old, { rows: [post('1', { content: 'DIRTY_RETIRED_SUCCESS' })] })
    if (index === 2) await refuse(old)
    assertNoRows(h); assert.equal(h.byId('posts-error'), undefined); assert.equal(h.byId('posts-loading'), undefined)
    await h.click('posts-refresh')
    assert.equal(h.byId('posts-search-phrase').props.value, 'committed')
    assert.equal(h.byId('posts-search-kind').props.value, 'posts'); assert.equal(h.byId('posts-match-case').props.checked, true)
    assertSearchCall(calls.getSavedPostSearch[index + 1], { q: 'committed', case_sensitive: true })
    assert.equal(query(h).offset, undefined, 'Refresh resets the committed matching-result offset')
    assert.equal(h.byId('posts-dirty'), undefined)
  }
  await acceptSearch(calls.getSavedPostSearch[3], { rows: fullRows(), matched: 26 })
  assert.ok(h.byId('search-results')); assert.doesNotMatch(h.text(), /DIRTY_RETIRED_SUCCESS|PRIVATE_ERROR_MUST_NOT_RENDER/)
})

mountedGroup('A to B to A ignores stale success rejection and finally with the full search selection identity', [{ search: 3 }], async mount => {
  const a = searchPath({ q: 'alpha', sensitive: true }), b = searchPath({ q: 'beta', kind: 'comments' }) + '&case_sensitive=false'
  const { h, calls } = await mount({ initialPath: a })
  await h.navigate(b); await h.navigate(a)
  assert.equal(calls.getSavedPostSearch.length, 3)
  assert.equal(calls.getSavedPostSearch[0].signal.aborted, true); assert.equal(calls.getSavedPostSearch[1].signal.aborted, true)
  await acceptSearch(calls.getSavedPostSearch[0], { rows: [post('1', { content: 'STALE_FIRST_SUCCESS' })] })
  assert.ok(h.byId('posts-loading')); assertNoRows(h)
  await refuse(calls.getSavedPostSearch[1]); assert.ok(h.byId('posts-loading')); assertNoRows(h); assert.equal(h.byId('posts-error'), undefined)
  assertSearchCall(calls.getSavedPostSearch[2], { q: 'alpha', case_sensitive: true })
  await acceptSearch(calls.getSavedPostSearch[2], { rows: [post('1', { content: 'CURRENT_THIRD_SUCCESS' })] })
  assert.match(text(h, 'post-row'), /CURRENT_THIRD_SUCCESS/); assert.doesNotMatch(h.text(), /STALE_FIRST_SUCCESS|PRIVATE_ERROR_MUST_NOT_RENDER/)
  assert.equal(h.byId('posts-loading'), undefined); assert.equal(h.byId('posts-error'), undefined)
})

mountedGroup('captured row and page callbacks never revive after dirty edits same-ID replacement or pagination', [{ search: 3 }], async mount => {
  const { h, calls } = await mount(); await acceptSearch(calls.getSavedPostSearch[0], { rows: fullRows(), matched: 50000 })
  assert.match(text(h, 'search-counts'), /50000/, 'the inclusive matching-row ceiling is admissible')
  const oldRow = h.byId('post-open-1000000').props.onClick, oldNext = h.byId('search-next').props.onClick
  await h.input('posts-search-phrase', 'dirty'); oldRow(event()); oldNext(event()); await flush()
  assert.equal(calls.serviceGet.length, 1)
  await h.click('posts-refresh')
  oldRow(event()); oldNext(event()); await flush(); assert.equal(calls.serviceGet.length, 2); assert.ok(h.byId('posts-loading'))
  const replacement = fullRows(); replacement[0].content = 'same-ID fresh row object'
  await acceptSearch(calls.getSavedPostSearch[1], { rows: replacement, matched: 51 })
  oldRow(event()); oldNext(event()); await flush(); assert.equal(calls.serviceGet.length, 2)
  const next = h.byId('search-next').props.onClick, row = h.byId('post-open-1000000').props.onClick
  next(event()); next(event()); row(event()); await flush()
  assert.equal(calls.serviceGet.length, 3); assert.equal(calls.getSavedPost.length, 0)
  assertSearchCall(calls.getSavedPostSearch[2], { offset: 25 })
  await acceptSearch(calls.getSavedPostSearch[2], { rows: fullRows(25), matched: 51 })
  const current = h.router.currentRoute.value.fullPath
  oldRow(event()); oldNext(event()); next(event()); row(event()); await flush()
  assert.equal(calls.serviceGet.length, 3); assert.equal(h.router.currentRoute.value.fullPath, current)
  assert.match(text(h, 'search-counts'), /51/); assert.match(text(h, 'search-counts'), /25/)
})

mountedGroup('repeated guarded Apply/open retire once and edits or same-URL Apply/Refresh own guard completion', [{ search: 2, detail: 1 }, { search: 3 }], async mount => {
  const first = await mount(); await acceptSearch(first.calls.getSavedPostSearch[0])
  let releaseApply, releaseOpen, applyGuards = 0, openGuards = 0
  first.h.router.beforeEach(to => {
    if (to.query.q === 'pending') { applyGuards++; return new Promise(resolve => { releaseApply = resolve }) }
    if (to.query.post_id) { openGuards++; return new Promise(resolve => { releaseOpen = resolve }) }
    return true
  })
  await first.h.input('posts-search-phrase', 'pending')
  const oldApply = first.h.byId('posts-apply').props.onClick
  oldApply(event()); oldApply(event()); await flush()
  assert.equal(applyGuards, 1); assert.ok(releaseApply); assert.equal(first.calls.serviceGet.length, 1)
  await first.h.input('posts-search-phrase', 'newer draft'); await first.h.change('posts-search-kind', 'comments'); await setCase(first.h, true)
  releaseApply(true); await flush(); oldApply(event()); await flush()
  assert.equal(first.calls.serviceGet.length, 1, 'retired guarded route commit must not trigger the generic route watcher read')
  assert.equal(first.h.byId('posts-search-phrase').props.value, 'newer draft')
  assert.equal(first.h.byId('posts-search-kind').props.value, 'comments'); assert.equal(first.h.byId('posts-match-case').props.checked, true)
  assert.ok(first.h.byId('posts-dirty')); assertNoRows(first.h)
  await first.h.click('posts-apply')
  assertSearchCall(first.calls.getSavedPostSearch[1], { q: 'newer draft', kind: 'comments', case_sensitive: true })
  await acceptSearch(first.calls.getSavedPostSearch[1], { rows: [comment('1', maxId)] })
  const oldOpen = first.h.byId('comment-open-1').props.onClick
  oldOpen(event()); oldOpen(event()); await flush(); assert.equal(openGuards, 1)
  releaseOpen(true); await flush(); assertDetailCall(first.calls.getSavedPost[0], maxId)
  await accept(first.calls.getSavedPost[0], detail(maxId)); oldOpen(event()); await flush()
  assert.equal(first.calls.getSavedPost.length, 1); first.h.unmount()

  const second = await mount(); await acceptSearch(second.calls.getSavedPostSearch[0])
  const releases = []
  second.h.router.beforeEach(to => to.query.q === 'pending' || to.query.post_id ? new Promise(resolve => { releases.push(resolve) }) : true)
  await second.h.input('posts-search-phrase', 'pending'); await second.h.click('posts-apply'); assert.equal(releases.length, 1)
  await second.h.click('posts-refresh')
  assert.equal(second.calls.getSavedPostSearch.length, 2); assert.equal(second.h.byId('posts-search-phrase').props.value, 'text')
  await acceptSearch(second.calls.getSavedPostSearch[1]); releases[0](true); await flush()
  assert.deepEqual(query(second.h), { platform: 'twitter', q: 'text', kind: 'posts' }); assert.equal(second.calls.serviceGet.length, 2)
  await second.h.click('post-open-1'); assert.equal(releases.length, 2)
  await second.h.click('posts-apply'); assert.equal(second.calls.getSavedPostSearch.length, 3)
  await acceptSearch(second.calls.getSavedPostSearch[2], { rows: [post('1', { content: 'CURRENT_SAME_URL_APPLY' })] })
  releases[1](true); await flush()
  assert.equal(second.calls.getSavedPost.length, 0); assert.match(text(second.h, 'post-row'), /CURRENT_SAME_URL_APPLY/)
  assert.deepEqual(query(second.h), { platform: 'twitter', q: 'text', kind: 'posts' })
})

mountedGroup('newer platform and outside navigation supersede guarded search result opens', [{ search: 1, list: 1 }], async mount => {
  const { h, calls } = await mount({ initialPath: searchPath({ q: 'old', sensitive: true, offset: 25 }) })
  await acceptSearch(calls.getSavedPostSearch[0], { rows: [post('1')], matched: 26 })
  const releases = []
  h.router.beforeEach(to => to.name === 'SavedPosts' && to.query.post_id ? new Promise(resolve => { releases.push(resolve) }) : true)
  await h.click('post-open-1'); assert.equal(releases.length, 1)
  await h.change('posts-platform', 'reddit')
  assert.deepEqual(query(h), { platform: 'reddit' }); assert.equal(h.byId('posts-search-phrase').props.value, '')
  assert.equal(h.byId('posts-search-kind').props.value, 'posts'); assert.equal(h.byId('posts-match-case').props.checked, false)
  releases[0](true); await flush(); assert.equal(calls.getSavedPost.length, 0)
  await accept(calls.getSavedPosts[0], list({ platform: 'reddit' }))
  await h.click('post-open-1'); assert.equal(releases.length, 2)
  await h.navigate('/report/outside'); releases[1](true); await flush()
  assert.equal(h.router.currentRoute.value.name, 'Report'); assert.equal(h.router.currentRoute.value.params.reportId, 'outside')
  assert.equal(calls.getSavedPost.length, 0); assert.equal(calls.serviceGet.length, 2)
})

mountedGroup('Back and Forward restore committed search context drafts offsets and fresh exact detail', [{ search: 2, detail: 2 }], async mount => {
  const { h, calls } = await mount({ initialPath: searchPath({ platform: 'reddit', q: ' preserved 文 ', kind: 'comments', sensitive: true, offset: 25 }) })
  await acceptSearch(calls.getSavedPostSearch[0], { rows: [comment('9007199254740993', maxId)], matched: 26 })
  const acceptedPath = h.router.currentRoute.value.fullPath, acceptedQuery = query(h)
  await h.click('comment-open-9007199254740993'); assertDetailCall(calls.getSavedPost[0], maxId, 'reddit')
  await accept(calls.getSavedPost[0], detail(maxId, { platform: 'reddit' }))
  const selectedPath = h.router.currentRoute.value.fullPath
  await h.back(); assert.equal(h.router.currentRoute.value.fullPath, acceptedPath); assert.deepEqual(query(h), acceptedQuery)
  assert.equal(h.byId('posts-search-phrase').props.value, ' preserved 文 '); assert.equal(h.byId('posts-search-kind').props.value, 'comments'); assert.equal(h.byId('posts-match-case').props.checked, true)
  assertSearchCall(calls.getSavedPostSearch[1], { platform: 'reddit', q: ' preserved 文 ', kind: 'comments', case_sensitive: true, offset: 25 })
  await acceptSearch(calls.getSavedPostSearch[1], { rows: [comment('9007199254740993', maxId)], matched: 26 })
  await h.input('posts-search-phrase', 'discard this dirty draft'); await setCase(h, false)
  await h.forward(); assert.equal(h.router.currentRoute.value.fullPath, selectedPath); assert.equal(h.byId('posts-search-form'), undefined)
  assertDetailCall(calls.getSavedPost[1], maxId, 'reddit')
  assert.notEqual(calls.getSavedPost[0].signal, calls.getSavedPost[1].signal)
  await accept(calls.getSavedPost[1], detail(maxId, { platform: 'reddit', post: { state: 'available', reason: null, row: post(maxId, { content: 'fresh Forward detail' }) } }))
  assert.match(text(h, 'selected-post'), /fresh Forward detail/); assert.equal(query(h).q, ' preserved 文 ')
})

mountedGroup('unmount never corrects routes and current or stale rejected guards remain explicitly recoverable', [{ search: 1 }, { search: 2 }, { search: 3 }], async mount => {
  const first = await mount({ viewUnmount: true }); await acceptSearch(first.calls.getSavedPostSearch[0])
  let releaseApply, releaseOutside
  first.h.router.beforeEach(to => {
    if (to.query.q === 'pending') return new Promise(resolve => { releaseApply = resolve })
    if (to.name === 'Report') return new Promise(resolve => { releaseOutside = resolve })
    return true
  })
  await first.h.input('posts-search-phrase', 'pending'); await first.h.click('posts-apply'); assert.ok(releaseApply)
  const navigationCalls = [], push = first.h.router.push, replace = first.h.router.replace
  first.h.router.push = (...args) => { navigationCalls.push(['push', ...args]); return push(...args) }
  first.h.router.replace = (...args) => { navigationCalls.push(['replace', ...args]); return replace(...args) }
  const outside = first.h.router.push('/report/outside'); await flush(); assert.ok(releaseOutside)
  await first.h.unmountView(); assert.equal(first.calls.getSavedPostSearch[0].signal.aborted, true)
  assert.equal(navigationCalls.length, 1, 'the unmount hook itself cannot correct a route while newer outside navigation is guarded')
  releaseApply(true); await flush()
  assert.equal(navigationCalls.length, 1, 'unmounted work must not issue corrective push/replace that cancels the newer outside guard')
  releaseOutside(true); await outside; await flush()
  assert.equal(first.h.router.currentRoute.value.name, 'Report'); assert.equal(first.calls.serviceGet.length, 1)
  assert.equal(first.h.root.children.filter(node => node.type !== '#comment').length, 0); first.h.unmount()

  const second = await mount(); await acceptSearch(second.calls.getSavedPostSearch[0])
  const committed = second.h.router.currentRoute.value.fullPath
  const remove = second.h.router.beforeEach(to => to.query.q === 'refused' ? false : true)
  await second.h.input('posts-search-phrase', 'refused'); const oldApply = second.h.byId('posts-apply').props.onClick
  oldApply(event()); await flush()
  assert.equal(second.h.router.currentRoute.value.fullPath, committed); assert.ok(second.h.byId('posts-error')); assertNoRows(second.h)
  oldApply(event()); await flush(); assert.equal(second.calls.serviceGet.length, 1)
  remove(); await second.h.click('posts-refresh'); await acceptSearch(second.calls.getSavedPostSearch[1])
  oldApply(event()); await flush(); assert.equal(second.calls.serviceGet.length, 2); assert.ok(second.h.byId('search-results')); second.h.unmount()

  const third = await mount(); await acceptSearch(third.calls.getSavedPostSearch[0])
  let rejectGuard
  third.h.router.onError(() => {})
  third.h.router.beforeEach(to => to.query.q === 'retired' ? new Promise((_resolve, reject) => { rejectGuard = reject }) : true)
  await third.h.input('posts-search-phrase', 'retired'); await third.h.click('posts-apply'); assert.ok(rejectGuard)
  await third.h.click('posts-refresh'); await refuse(third.calls.getSavedPostSearch[1])
  const currentError = text(third.h, 'posts-error'), currentPath = third.h.router.currentRoute.value.fullPath
  rejectGuard(new Error('PRIVATE_RETIRED_GUARD_ERROR')); await flush()
  assert.equal(text(third.h, 'posts-error'), currentError); assert.equal(third.h.router.currentRoute.value.fullPath, currentPath)
  assert.equal(third.h.byId('posts-loading'), undefined); assertNoRows(third.h)
  assert.doesNotMatch(third.h.text(), /PRIVATE_RETIRED_GUARD_ERROR|PRIVATE_ERROR_MUST_NOT_RENDER/)
  await third.h.click('posts-apply'); await acceptSearch(third.calls.getSavedPostSearch[2])
  assert.ok(third.h.byId('search-results')); assert.equal(third.h.byId('posts-error'), undefined)
})

// Registration checks are assertions, not extra tests or unbudgeted mounts.
assert.equal(registered.length, 12)
assert.equal(new Set(registered.map(group => group.name)).size, 12)
assert.deepEqual(registered.map(group => group.allocations), [
  [{ list: 3, search: 4 }, {}], [{ search: 2 }, { search: 2 }], [{ search: 23 }],
  [{ search: 2, detail: 1 }, { search: 2, detail: 1 }], [{ search: 2, detail: 2 }], [{ search: 4 }],
  [{ search: 3 }], [{ search: 3 }], [{ search: 2, detail: 1 }, { search: 3 }], [{ search: 1, list: 1 }],
  [{ search: 2, detail: 2 }], [{ search: 1 }, { search: 2 }, { search: 3 }],
])
const allocations = registered.flatMap(group => group.allocations)
assert.equal(allocations.length, 18)
assert.equal(allocations.reduce((sum, item) => sum + (item.list ?? 0), 0), 4)
assert.equal(allocations.reduce((sum, item) => sum + (item.detail ?? 0), 0), 7)
assert.equal(allocations.reduce((sum, item) => sum + (item.search ?? 0), 0), 61)
assert.equal(allocations.reduce((sum, item) => sum + (item.list ?? 0) + (item.detail ?? 0) + (item.search ?? 0), 0), 72)
