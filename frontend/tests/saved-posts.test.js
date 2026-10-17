import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { setup, resolve, reject, list, detail, post, comment, page, unavailable, metadata, fullPage, catalog, path, maxId, event, flush } from './helpers/saved-posts-view-fixture.js'

// Source-only fixture preparation. Every setup binds exact deferred GET counts;
// 2 locale expansions are explicit below and route/response tables are finite.
const query = h => ({ ...h.router.currentRoute.value.query })
const text = (h, id) => h.text(h.byId(id))
const literal = '<img src="https://invalid.example/pixel" onerror="alert(1)">\n<script>alert(2)</script>\n[click](javascript:alert(3)) **literal**'

test('saved posts chooser performs no read until explicit platform selection', async t => {
  const { h, calls } = await setup(t, path, 'en', { list: 1 })
  assert.equal(h.router.currentRoute.value.name, 'SavedPosts')
  assert.equal(calls.getSavedPosts.length, 0); assert.ok(h.byId('posts-choose'))
  await h.change('posts-platform', 'reddit')
  assert.deepEqual(query(h), { platform: 'reddit' })
  assert.deepEqual({ ...calls.getSavedPosts[0].args[1] }, { platform: 'reddit', offset: 0, limit: 25 })
  await resolve(calls.getSavedPosts[0], list({ platform: 'reddit' }))
  assert.equal(h.all(n => n.props['data-testid'] === 'post-row').length, 1)
  assert.equal(h.byId('posts-twitter'), undefined)
})

test('saved simulations card enters the saved posts chooser through the real router', async t => {
  const { h, calls } = await setup(t, '/simulations', 'en', { catalog: 1 })
  await resolve(calls.getComparisonCandidates[0], catalog())
  assert.ok(h.byId('simulation-activity-sim_A')); assert.ok(h.byId('simulation-posts-sim_A'))
  await h.click('simulation-posts-sim_A')
  assert.equal(h.router.currentRoute.value.name, 'SavedPosts')
  assert.deepEqual(query(h), {})
  assert.equal(calls.getSavedPosts.length, 0)
})

test('opening and returning preserve list offset and detail uses its fresh exact post', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&offset=50', 'en', { list: 2, detail: 1 })
  await resolve(calls.getSavedPosts[0], list({ posts: page([post('7', { content: 'earlier list text' })], { offset: 50 }) }))
  await h.click('post-open-7')
  assert.deepEqual(query(h), { platform: 'twitter', offset: '50', post_id: '7' })
  assert.equal(h.byId('selected-post'), undefined)
  assert.doesNotMatch(h.text(), /earlier list text/)
  assert.deepEqual(calls.getSavedPost[0].args.slice(0, 2), ['sim_A', '7'])
  assert.deepEqual({ ...calls.getSavedPost[0].args[2] }, { platform: 'twitter', offset: 0, limit: 25 })
  await resolve(calls.getSavedPost[0], detail('7', { post: { state: 'available', reason: null, row: post('7', { content: 'fresh exact text' }) } }))
  assert.match(h.text(), /fresh exact text/)
  await h.click('posts-return')
  assert.deepEqual(query(h), { platform: 'twitter', offset: '50' })
  assert.equal(h.byId('selected-post'), undefined)
  await resolve(calls.getSavedPosts[1], list({ posts: page([post('7')], { offset: 50 }) }))
})

test('saved posts API wrappers preserve exact IDs supplied params and AbortSignal', async () => {
  const source = readFileSync(new URL('../src/api/simulation.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
  const calls = [], service = { get: (...args) => { calls.push(args); return Promise.resolve({ success: true }) } }
  const api = new Function('service', source + '\nreturn { getSavedPosts, getSavedPost };')(service)
  const controller = new AbortController(), params = { platform: 'reddit', offset: 25, limit: 25 }
  await api.getSavedPosts('literal?/id', params, controller.signal)
  await api.getSavedPost('sim_A', maxId, params, controller.signal)
  await api.getSavedPosts('sim_A')
  assert.deepEqual(calls, [
    ['/api/simulation/literal%3F%2Fid/saved-posts', { params: { platform: 'reddit', offset: 25, limit: 25 }, signal: controller.signal }],
    ['/api/simulation/sim_A/saved-posts/' + maxId, { params: { platform: 'reddit', offset: 25, limit: 25 }, signal: controller.signal }],
    ['/api/simulation/sim_A/saved-posts', { params: {}, signal: undefined }],
  ])
  assert.deepEqual(params, { platform: 'reddit', offset: 25, limit: 25 })
})

for (const locale of ['en', 'zh']) test(`saved text quote attribution nulls and hostile strings are literal in ${locale}`, async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', locale, { list: 1 })
  await resolve(calls.getSavedPosts[0], list({ posts: page([
    post('4', { user_id: '9007199254740993', content: literal, original_post_id: '0', quote_content: 'quote text owned by user', created_at: '9223372036854775807' }),
    post('3', { content: '', original_post_id: '0' }),
    post('2', { content: 'unusual saved content', quote_content: 'unusual saved quote' }),
    post('0', { user_id: null, content: null, quote_content: null, created_at: null }),
  ]) }))
  const rendered = h.text()
  assert.ok(rendered.includes(literal)); assert.match(rendered, /9007199254740993/); assert.match(rendered, /9223372036854775807/)
  for (const key of ['originalText', 'postText', 'contentField', 'quoteText', 'quoteField', 'notStored', 'emptyText', 'referenceNote', 'repostNote', 'postOrder', 'freshness']) assert.ok(rendered.includes(h.i18n.global.t('savedPosts.' + key)), key)
  const unusual = h.all(n => n.props['data-testid'] === 'post-row').find(n => h.text(n).includes('unusual saved content'))
  assert.ok(unusual)
  const unusualText = h.text(unusual)
  for (const key of ['contentField', 'quoteField']) assert.ok(unusualText.includes(h.i18n.global.t('savedPosts.' + key)), key)
  for (const key of ['originalText', 'quoteText']) assert.ok(!unusualText.includes(h.i18n.global.t('savedPosts.' + key)), key)
  assert.equal(h.all(n => ['img', 'script', 'iframe', 'video', 'audio'].includes(n.type)).length, 0)
  assert.equal(h.all(n => n.props.innerHTML !== undefined || String(n.props.href ?? '').startsWith('javascript:') || String(n.props.src ?? '').includes('invalid.example')).length, 0)
})

for (const locale of ['en', 'zh']) test(`Twitter exact flat comments and partial source coverage appear in ${locale}`, async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&post_id=0', locale, { detail: 1 })
  await resolve(calls.getSavedPost[0], detail('0', { metadata: metadata({ status: 'stopped', partial: true, warning: 'run_state_missing' }), comments: page([comment('9007199254740993', '0', { content: literal })]) }))
  assert.equal(h.all(n => n.props['data-testid'] === 'comment-row').length, 1)
  assert.ok(text(h, 'comment-content').includes(literal))
  for (const [id, key] of [['posts-twitter', 'twitterNote'], ['posts-partial', 'partial'], ['posts-warning', 'runStateMissing']]) assert.equal(text(h, id), h.i18n.global.t('savedPosts.' + key))
  assert.ok(h.text().includes(h.i18n.global.t('savedPosts.commentScope', { id: '0', platform: 'twitter' })))
  const messages = JSON.parse(readFileSync(new URL('../../locales/' + locale + '.json', import.meta.url), 'utf8')).savedPosts
  assert.equal(Object.keys(messages.reasons).length, 22)
  assert.ok(Object.values(messages.reasons).every(value => typeof value === 'string' && value.trim()))
})

test('empty out-of-range and unavailable coverage have different page controls', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 3 })
  await resolve(calls.getSavedPosts[0], list({ posts: page([]) }))
  assert.equal(text(h, 'posts-coverage'), h.i18n.global.t('savedPosts.states.empty'))
  assert.equal(h.byId('posts-next').props.disabled, true)
  await h.navigate(path + '?platform=twitter&offset=25')
  await resolve(calls.getSavedPosts[1], list({ posts: page([], { offset: 25 }) }))
  assert.equal(text(h, 'posts-coverage'), h.i18n.global.t('savedPosts.states.out_of_range'))
  assert.equal(h.byId('posts-previous').props.disabled, false)
  await h.click('posts-refresh')
  await resolve(calls.getSavedPosts[2], list({ database: { state: 'unavailable', reason: 'unsupported_journal' }, posts: unavailable('unsupported_journal') }))
  assert.ok(text(h, 'posts-coverage').includes(h.i18n.global.t('savedPosts.states.unavailable')))
  assert.ok(text(h, 'posts-database').includes(h.i18n.global.t('savedPosts.reasons.unsupported_journal')))
  assert.equal(h.byId('posts-next').props.disabled, true); assert.equal(h.byId('posts-previous').props.disabled, true)
  assert.match(h.text(), /unknown/)
})

test('maximum list offset with further rows explains the bound and disables next', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&offset=500000', 'en', { list: 1 })
  await resolve(calls.getSavedPosts[0], list({ posts: fullPage(500000) }))
  assert.equal(h.byId('posts-next').props.disabled, true)
  assert.equal(h.byId('posts-previous').props.disabled, false)
  assert.equal(text(h, 'posts-bound'), h.i18n.global.t('savedPosts.browseBound'))
})

test('maximum comment offset with further rows explains the bound and disables next', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&post_id=1&comment_offset=500000', 'en', { detail: 1 })
  const comments = page(Array.from({ length: 25 }, (_, i) => comment(String(500000 + i), '1')), { offset: 500000, has_more: true })
  await resolve(calls.getSavedPost[0], detail('1', { comments }))
  assert.equal(h.byId('comments-next').props.disabled, true)
  assert.equal(text(h, 'comments-bound'), h.i18n.global.t('savedPosts.browseBound'))
})

test('duplicate unknown malformed and unowned route fields are rejected before reads', async t => {
  const invalidQueries = [
    'platform=twitter&platform=reddit', 'platform=', 'platform=Twitter', 'offset=0',
    'platform=twitter&offset=00', 'platform=twitter&offset=-1', 'platform=twitter&offset=500001',
    'platform=twitter&limit=25', 'platform=twitter&revision=old', 'platform=twitter&comment_offset=0',
    'platform=twitter&post_id=00', 'platform=twitter&post_id=-1', 'platform=twitter&post_id=9223372036854775808',
    'platform=twitter&post_id=1&comment_offset=1.0', 'platform=twitter&post_id=1&post_id=1',
  ]
  for (const suffix of invalidQueries) {
    const { h } = await setup(t, path + '?' + suffix, 'en', {})
    assert.ok(h.byId('posts-error'), suffix); assert.equal(h.byId('post-row'), undefined)
    h.unmount()
  }
})

test('maximum and above-safe-integer IDs remain strings through selection and detail API', async t => {
  const { h, calls } = await setup(t, path + '?platform=reddit', 'en', { list: 1, detail: 1 })
  await resolve(calls.getSavedPosts[0], list({ platform: 'reddit', posts: page([post(maxId), post('9007199254740993'), post('0')]) }))
  await h.click('post-open-' + maxId)
  assert.equal(h.router.currentRoute.value.query.post_id, maxId)
  assert.equal(calls.getSavedPost[0].args[1], maxId)
  await resolve(calls.getSavedPost[0], detail(maxId, { platform: 'reddit' }))
  assert.ok(text(h, 'selected-post').includes(maxId))
})

test('A to B to A late success cannot replace the newest result', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 3 })
  await h.change('posts-platform', 'reddit')
  await h.change('posts-platform', 'twitter')
  assert.equal(calls.getSavedPosts[0].signal.aborted, true)
  await resolve(calls.getSavedPosts[2], list({ posts: page([post('1', { content: 'newest A' })]) }))
  await resolve(calls.getSavedPosts[0], list({ posts: page([post('1', { content: 'retired first A' })]) }))
  await resolve(calls.getSavedPosts[1], list({ platform: 'reddit', posts: page([post('1', { content: 'retired B' })]) }))
  assert.match(h.text(), /newest A/); assert.doesNotMatch(h.text(), /retired/)
  assert.equal(h.byId('posts-error'), undefined); assert.equal(h.byId('posts-loading'), undefined)
})

test('A to B to A stale rejection and finally cannot clear current loading or error', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 3 })
  await h.change('posts-platform', 'reddit'); await h.change('posts-platform', 'twitter')
  await reject(calls.getSavedPosts[0], 'sources_changed')
  assert.ok(h.byId('posts-loading')); assert.equal(h.byId('posts-error'), undefined)
  await reject(calls.getSavedPosts[2], 'database_busy')
  const currentError = text(h, 'posts-error')
  await reject(calls.getSavedPosts[1], 'sources_changed')
  assert.equal(text(h, 'posts-error'), currentError); assert.equal(h.byId('posts-loading'), undefined)
})

test('same-URL Refresh retires ignored abort and accepts only the replacement observation', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 2 })
  await h.click('posts-refresh')
  assert.equal(calls.getSavedPosts[0].signal.aborted, true)
  await resolve(calls.getSavedPosts[0], list({ posts: page([post('1', { content: 'old ignored abort' })]) }))
  assert.ok(h.byId('posts-loading')); assert.equal(h.byId('post-row'), undefined)
  await resolve(calls.getSavedPosts[1], list({ posts: page([post('1', { content: 'fresh replacement' })]) }))
  assert.match(h.text(), /fresh replacement/); assert.doesNotMatch(h.text(), /old ignored/)
})

test('retired detail clears immediately when a different exact platform request begins', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&post_id=1', 'en', { detail: 2 })
  await resolve(calls.getSavedPost[0], detail('1', { post: { state: 'available', reason: null, row: post('1', { content: 'retired detail' }) } }))
  const oldReturn = h.byId('posts-return').props.onClick
  const pending = h.router.push(path + '?platform=reddit&post_id=1')
  await flush()
  assert.equal(h.byId('selected-post'), undefined); assert.doesNotMatch(h.text(), /retired detail/)
  oldReturn(event()); await pending; await flush()
  assert.deepEqual(query(h), { platform: 'reddit', post_id: '1' })
  await resolve(calls.getSavedPost[1], detail('1', { platform: 'reddit' }))
})

test('captured row and page handlers cannot act on a replacement same-ID result', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&offset=25', 'en', { list: 2 })
  await resolve(calls.getSavedPosts[0], list({ posts: fullPage(25) }))
  const oldOpen = h.byId('post-open-999975').props.onClick
  const oldNext = h.byId('posts-next').props.onClick, oldPrevious = h.byId('posts-previous').props.onClick
  h.byId('posts-refresh').props.onClick(event())
  oldOpen(event()); oldNext(event()); oldPrevious(event()); await flush()
  assert.deepEqual(query(h), { platform: 'twitter' })
  await resolve(calls.getSavedPosts[1], list({ posts: page(fullPage(25).rows, { has_more: true }) }))
  oldOpen(event()); oldNext(event()); oldPrevious(event()); await flush()
  assert.deepEqual(query(h), { platform: 'twitter' }); assert.equal(calls.getSavedPost.length, 0)
})

test('captured same-ID post callback stays retired after platform A to B to A', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 3 })
  await resolve(calls.getSavedPosts[0], list())
  const oldOpen = h.byId('post-open-1').props.onClick
  await h.change('posts-platform', 'reddit'); await resolve(calls.getSavedPosts[1], list({ platform: 'reddit' }))
  oldOpen(event()); await flush(); assert.equal(query(h).post_id, undefined)
  await h.change('posts-platform', 'twitter'); await resolve(calls.getSavedPosts[2], list())
  oldOpen(event()); await flush(); assert.equal(query(h).post_id, undefined)
})

test('newer platform intent wins over a delayed post navigation guard', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 2 })
  await resolve(calls.getSavedPosts[0], list())
  let release
  h.router.beforeEach(to => to.name === 'SavedPosts' && to.query.post_id ? new Promise(resolve => { release = resolve }) : true)
  await h.click('post-open-1'); assert.ok(release)
  await h.change('posts-platform', 'reddit')
  await resolve(calls.getSavedPosts[1], list({ platform: 'reddit' }))
  release(true); await flush()
  assert.deepEqual(query(h), { platform: 'reddit' }); assert.equal(h.byId('posts-error'), undefined)
})

test('equal-URL Refresh supersedes a delayed post intent without stale correction', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 2 })
  await resolve(calls.getSavedPosts[0], list())
  let release
  h.router.beforeEach(to => to.query.post_id ? new Promise(resolve => { release = resolve }) : true)
  await h.click('post-open-1'); assert.ok(release)
  await h.click('posts-refresh')
  await resolve(calls.getSavedPosts[1], list({ posts: page([post('1', { content: 'new equal URL result' })]) }))
  release(true); await flush()
  assert.deepEqual(query(h), { platform: 'twitter' }); assert.match(h.text(), /new equal URL result/)
})

test('repeated captured next intent is retired synchronously before guard settlement', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 2 })
  await resolve(calls.getSavedPosts[0], list({ posts: fullPage() }))
  let release, guards = 0
  h.router.beforeEach(to => to.query.offset === '25' ? (guards++, new Promise(resolve => { release = resolve })) : true)
  const next = h.byId('posts-next').props.onClick
  next(event()); next(event()); await flush()
  assert.equal(guards, 1)
  release(true); await flush()
  assert.deepEqual(query(h), { platform: 'twitter', offset: '25' })
  await resolve(calls.getSavedPosts[1], list({ posts: fullPage(25) }))
  next(event()); await flush(); assert.equal(guards, 1)
})

test('rejected navigation is recoverable and old handlers cannot correct the route', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 2 })
  await resolve(calls.getSavedPosts[0], list())
  const oldOpen = h.byId('post-open-1').props.onClick
  const remove = h.router.beforeEach(to => to.query.post_id ? false : true)
  await h.click('post-open-1')
  assert.deepEqual(query(h), { platform: 'twitter' }); assert.ok(h.byId('posts-error'))
  remove(); await h.click('posts-refresh'); await resolve(calls.getSavedPosts[1], list())
  oldOpen(event()); await flush()
  assert.deepEqual(query(h), { platform: 'twitter' }); assert.equal(h.byId('posts-error'), undefined)
})

test('unmount retires pending requests without changing a newer outside route', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 1 })
  await h.navigate('/reports')
  const outside = h.router.currentRoute.value.fullPath
  assert.equal(calls.getSavedPosts[0].signal.aborted, true)
  await resolve(calls.getSavedPosts[0], list())
  assert.equal(h.router.currentRoute.value.fullPath, outside)
})

test('unmount of a delayed owned navigation preserves the newer outside navigation', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 1 })
  await resolve(calls.getSavedPosts[0], list())
  let release
  h.router.beforeEach(to => to.query.post_id ? new Promise(resolve => { release = resolve }) : true)
  await h.click('post-open-1'); assert.ok(release)
  await h.navigate('/reports')
  const outside = h.router.currentRoute.value.fullPath
  release(true); await flush()
  assert.equal(h.router.currentRoute.value.fullPath, outside)
})

test('platform switch and detail Refresh reset the prescribed route fields', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&offset=50&post_id=1&comment_offset=25', 'en', { list: 1, detail: 2 })
  await resolve(calls.getSavedPost[0], detail('1', { comments: page([], { offset: 25 }) }))
  await h.click('posts-refresh')
  assert.deepEqual(query(h), { platform: 'twitter', post_id: '1' })
  assert.deepEqual({ ...calls.getSavedPost[1].args[2] }, { platform: 'twitter', offset: 0, limit: 25 })
  await resolve(calls.getSavedPost[1], detail('1'))
  await h.change('posts-platform', 'reddit')
  assert.deepEqual(query(h), { platform: 'reddit' })
  await resolve(calls.getSavedPosts[0], list({ platform: 'reddit' }))
})

test('Back and Forward restore URL-owned list detail and comment offsets', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&offset=50', 'en', { list: 2, detail: 2 })
  await resolve(calls.getSavedPosts[0], list({ posts: page([post('1')], { offset: 50 }) }))
  await h.navigate(path + '?platform=twitter&offset=50&post_id=1&comment_offset=25')
  await resolve(calls.getSavedPost[0], detail('1', { comments: page([], { offset: 25 }) }))
  await h.back()
  assert.deepEqual(query(h), { platform: 'twitter', offset: '50' })
  await resolve(calls.getSavedPosts[1], list({ posts: page([post('1')], { offset: 50 }) }))
  await h.forward()
  assert.deepEqual(query(h), { platform: 'twitter', offset: '50', post_id: '1', comment_offset: '25' })
  await resolve(calls.getSavedPost[1], detail('1', { comments: page([], { offset: 25 }) }))
})

test('invalid response identity shape order IDs and count invariants are refused', async t => {
  const mutations = [
    ['wrong_simulation', d => { d.simulation_id = 'sim_B' }],
    ['wrong_platform', d => { d.platform = 'reddit' }],
    ['wrong_mode', d => { d.post_id = '1' }],
    ['unknown_top_field', d => { d.source_revision = 'unowned' }],
    ['numeric_id', d => { d.posts.rows[0].post_id = 1 }],
    ['noncanonical_id', d => { d.posts.rows[0].post_id = '00' }],
    ['out_of_range_id', d => { d.posts.rows[0].post_id = '9223372036854775808' }],
    ['missing_quote_field', d => { delete d.posts.rows[0].quote_content }],
    ['wrong_count', d => { d.posts.count = 0 }],
    ['unknown_has_more', d => { d.posts.has_more = null }],
    ['unavailable_with_rows', d => { d.posts.state = 'unavailable'; d.posts.reason = 'invalid_row' }],
    ['wrong_limit', d => { d.posts.limit = 100 }],
    ['wrong_offset', d => { d.posts.offset = 25 }],
    ['duplicate_id', d => { d.posts.rows.push(post('1')); d.posts.count++ }],
    ['ascending_posts', d => { d.posts = page([post('1'), post('2')]) }],
    ['invalid_metadata', d => { d.metadata.partial = true }],
  ]
  for (const [name, mutate] of mutations) {
    const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 1 })
    const data = list(); mutate(data)
    await resolve(calls.getSavedPosts[0], data)
    assert.ok(h.byId('posts-error'), name); assert.equal(h.byId('post-row'), undefined, name)
    h.unmount()
  }
})

test('detail refuses another post relationship and preserves valid post with unavailable comments', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&post_id=1', 'en', { detail: 2 })
  await resolve(calls.getSavedPost[0], detail('1', { comments: page([comment('1', '2')]) }))
  assert.ok(h.byId('posts-error')); assert.equal(h.byId('selected-post'), undefined)
  await h.click('posts-refresh')
  await resolve(calls.getSavedPost[1], detail('1', { comments: unavailable('unsupported_schema') }))
  assert.ok(h.byId('selected-post')); assert.equal(h.byId('comment-row'), undefined)
  assert.ok(text(h, 'comments-coverage').includes(h.i18n.global.t('savedPosts.reasons.unsupported_schema')))
  assert.equal(h.byId('comments-next').props.disabled, true)
})

test('sources-changed conflict requires explicit Refresh and does not poll or reuse revisions', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&offset=25', 'en', { list: 2 })
  await reject(calls.getSavedPosts[0], 'sources_changed')
  assert.equal(text(h, 'posts-error'), h.i18n.global.t('savedPosts.errors.sources_changed'))
  await flush(); assert.equal(calls.getSavedPosts.length, 1)
  await h.click('posts-refresh')
  assert.deepEqual(query(h), { platform: 'twitter' })
  await resolve(calls.getSavedPosts[1], list())
  assert.equal(h.byId('posts-error'), undefined)
  assert.deepEqual({ ...calls.getSavedPosts[1].args[1] }, { platform: 'twitter', offset: 0, limit: 25 })
})

test('captured comment page handlers remain retired after same-post Refresh', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&post_id=1&comment_offset=25', 'en', { detail: 2 })
  const rows = Array.from({ length: 25 }, (_, i) => comment(String(25 + i), '1'))
  await resolve(calls.getSavedPost[0], detail('1', { comments: page(rows, { offset: 25, has_more: true }) }))
  const oldNext = h.byId('comments-next').props.onClick, oldPrevious = h.byId('comments-previous').props.onClick
  h.byId('posts-refresh').props.onClick(event())
  oldNext(event()); oldPrevious(event()); await flush()
  assert.deepEqual(query(h), { platform: 'twitter', post_id: '1' })
  await resolve(calls.getSavedPost[1], detail('1', { comments: page(rows, { has_more: true }) }))
  oldNext(event()); oldPrevious(event()); await flush()
  assert.deepEqual(query(h), { platform: 'twitter', post_id: '1' })
})

test('retired guard rejection cannot overwrite a newer platform result or navigate back', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter', 'en', { list: 2 })
  await resolve(calls.getSavedPosts[0], list())
  let rejectGuard
  h.router.onError(() => {})
  h.router.beforeEach(to => to.query.post_id ? new Promise((_resolve, reject) => { rejectGuard = reject }) : true)
  await h.click('post-open-1'); assert.ok(rejectGuard)
  await h.change('posts-platform', 'reddit')
  await resolve(calls.getSavedPosts[1], list({ platform: 'reddit', posts: page([post('1', { content: 'newer platform result' })]) }))
  rejectGuard(new Error('retired guard')); await flush()
  assert.deepEqual(query(h), { platform: 'reddit' })
  assert.match(h.text(), /newer platform result/); assert.equal(h.byId('posts-error'), undefined)
})

test('missing selected post differs from empty comments and unavailable database', async t => {
  const { h, calls } = await setup(t, path + '?platform=twitter&post_id=1', 'en', { detail: 3 })
  await resolve(calls.getSavedPost[0], detail('1', { comments: page([]) }))
  assert.ok(h.byId('selected-post'))
  assert.equal(text(h, 'comments-coverage'), h.i18n.global.t('savedPosts.states.empty'))
  await h.click('posts-refresh')
  await resolve(calls.getSavedPost[1], detail('1', { post: { state: 'missing', reason: 'post_missing', row: null }, comments: unavailable('post_unavailable') }))
  assert.equal(h.byId('selected-post'), undefined)
  assert.ok(text(h, 'posts-coverage').includes(h.i18n.global.t('savedPosts.states.missing')))
  assert.ok(text(h, 'comments-coverage').includes(h.i18n.global.t('savedPosts.states.unavailable')))
  await h.click('posts-refresh')
  await resolve(calls.getSavedPost[2], detail('1', { database: { state: 'unavailable', reason: 'database_missing' }, post: { state: 'unavailable', reason: 'database_missing', row: null }, comments: unavailable('post_unavailable') }))
  assert.ok(text(h, 'posts-database').includes(h.i18n.global.t('savedPosts.reasons.database_missing')))
  assert.equal(h.byId('selected-post'), undefined)
})
