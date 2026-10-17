<template>
  <div class="posts-page">
    <header class="app-header"><RouterLink to="/" class="brand">MIROFISH</RouterLink><div class="header-actions"><RouterLink to="/simulations">{{ t('savedPosts.savedSimulations') }}</RouterLink><LanguageSwitcher /></div></header>
    <main>
      <div class="page-heading"><h1>{{ t('savedPosts.title') }}</h1><p>{{ t('savedPosts.scope') }}</p><p class="identity">{{ simulationId }}</p></div>
      <section class="panel controls" :aria-label="t('savedPosts.platform')">
        <label for="posts-platform">{{ t('savedPosts.platform') }}</label>
        <select id="posts-platform" data-testid="posts-platform" :value="selected?.platform || ''" @change="changePlatform($event.target.value)"><option value="">{{ t('savedPosts.choosePlatform') }}</option><option value="twitter">Twitter</option><option value="reddit">Reddit</option></select>
        <button type="button" data-testid="posts-refresh" :disabled="!selected?.platform" @click="refresh">{{ t('savedPosts.refresh') }}</button>
        <button v-if="selected?.post_id" type="button" data-testid="posts-return" :onClick="returnAction">{{ t('savedPosts.return') }}</button>
      </section>
      <form v-if="!selected?.post_id" class="panel search-form" data-testid="posts-search-form" @submit.prevent="applyAction">
        <label for="posts-search-phrase">{{ t('savedPosts.search.phrase') }}</label>
        <input id="posts-search-phrase" data-testid="posts-search-phrase" type="text" :value="draft.q" @input="editDraft('q', $event.target.value)" :aria-describedby="'posts-search-hint'">
        <label for="posts-search-kind">{{ t('savedPosts.search.kind') }}</label>
        <select id="posts-search-kind" data-testid="posts-search-kind" :value="draft.kind" @change="editDraft('kind', $event.target.value)"><option value="posts">{{ t('savedPosts.search.posts') }}</option><option value="comments">{{ t('savedPosts.search.comments') }}</option></select>
        <div class="case-control"><input id="posts-match-case" data-testid="posts-match-case" type="checkbox" :checked="draft.case_sensitive" @change="editDraft('case_sensitive', $event.target.checked)"><label for="posts-match-case">{{ t('savedPosts.search.matchCase') }}</label></div>
        <p id="posts-search-hint" class="note">{{ t('savedPosts.search.hint') }}</p>
        <div class="search-actions"><button type="button" data-testid="posts-apply" :disabled="!selected?.platform" :onClick="applyAction">{{ t('savedPosts.search.apply') }}</button><button type="button" data-testid="posts-clear" :disabled="!selected?.platform" :onClick="clearAction">{{ t('savedPosts.search.clear') }}</button></div>
        <p v-if="dirty" class="notice" data-testid="posts-dirty">{{ t('savedPosts.search.dirty') }}</p>
      </form>
      <p v-if="!selected?.platform && !error" data-testid="posts-choose">{{ t('savedPosts.chooseNote') }}</p>
      <p v-if="selected?.platform === 'twitter'" class="notice" data-testid="posts-twitter">{{ t('savedPosts.twitterNote') }}</p>
      <p v-if="loading" role="status" data-testid="posts-loading">{{ t('savedPosts.loading') }}</p>
      <p v-if="error" role="alert" class="notice error" data-testid="posts-error">{{ t(`savedPosts.errors.${error}`) }}</p>
      <template v-if="accepted">
        <section class="panel observation">
          <p data-testid="posts-observed">{{ t('savedPosts.observed', { time: result.observed_at }) }}</p>
          <p data-testid="posts-metadata">{{ t('savedPosts.metadata') }}: {{ t(`savedPosts.states.${result.metadata.state}`) }}<template v-if="result.metadata.status"> · {{ t(`comparison.statuses.${result.metadata.status}`) }}</template><template v-if="result.metadata.reason"> · {{ reasonLabel(result.metadata.reason) }}</template></p>
          <p v-if="result.metadata.partial" class="notice" data-testid="posts-partial">{{ t('savedPosts.partial') }}</p>
          <p v-if="result.metadata.warning" class="notice" data-testid="posts-warning">{{ t('savedPosts.runStateMissing') }}</p>
          <p data-testid="posts-database">{{ t('savedPosts.database') }}: {{ t(`savedPosts.states.${result.database.state}`) }}<template v-if="result.database.reason"> · {{ reasonLabel(result.database.reason) }}</template></p>
          <p class="note">{{ t('savedPosts.freshness') }}</p>
        </section>
        <section v-if="result.search" class="panel search-summary" data-testid="search-results">
          <h2>{{ t('savedPosts.search.results') }}</h2>
          <p data-testid="search-scope" class="saved-text">{{ t('savedPosts.search.scope', { kind: t(`savedPosts.search.${result.search.kind}`), platform: result.platform, phrase: result.search.q, casing: t(result.search.case_sensitive ? 'savedPosts.search.caseExact' : 'savedPosts.search.caseFold') }) }}</p>
          <p data-testid="search-coverage">{{ searchCoverageLabel(result.results) }}</p>
          <p data-testid="search-counts">{{ t('savedPosts.search.counts', { matched: result.results.matched_count === null ? t('savedPosts.unknown') : result.results.matched_count, count: result.results.count === null ? t('savedPosts.unknown') : result.results.count, offset: result.results.offset }) }}</p>
          <p class="note">{{ t('savedPosts.search.coverage') }}</p>
        </section>
        <section v-if="!result.search || result.search.kind === 'posts'" class="panel records">
          <h2>{{ t(selected.post_id ? 'savedPosts.selectedPost' : result.search ? 'savedPosts.search.posts' : 'savedPosts.latest') }}</h2>
          <p class="note">{{ t(result.search ? 'savedPosts.search.postOrder' : 'savedPosts.postOrder') }}</p>
          <p v-if="!result.search" data-testid="posts-coverage">{{ coverageLabel(result.posts || result.post) }}</p>
          <article v-for="row in shownPosts" :key="row.post_id" :data-testid="selected.post_id ? 'selected-post' : 'post-row'" class="stored-post">
            <dl><dt>{{ t('savedPosts.postId') }}</dt><dd>{{ row.post_id }}</dd><dt>{{ t('savedPosts.userId') }}</dt><dd>{{ display(row.user_id) }}</dd><dt>{{ t('savedPosts.createdAt') }}</dt><dd class="saved-text">{{ display(row.created_at) }}</dd><dt>{{ t('savedPosts.originalPostId') }}</dt><dd>{{ display(row.original_post_id) }}</dd></dl>
            <h3>{{ contentLabel(row) }}</h3><p class="saved-text" data-testid="post-content">{{ display(row.content) }}</p>
            <h3>{{ t(row.original_post_id !== null && row.quote_content !== null && row.quote_content !== '' ? 'savedPosts.quoteText' : 'savedPosts.quoteField') }}</h3><p class="saved-text" data-testid="post-quote">{{ display(row.quote_content) }}</p>
            <p v-if="row.original_post_id !== null" class="note" data-testid="post-reference-note">{{ t('savedPosts.referenceNote') }}</p>
            <p v-if="row.original_post_id !== null && (row.quote_content === null || row.quote_content === '')" class="note" data-testid="post-repost-note">{{ t('savedPosts.repostNote') }}</p>
            <button v-if="!selected.post_id" type="button" :data-testid="`post-open-${row.post_id}`" :onClick="postHandler(result, row)">{{ t('savedPosts.open') }}</button>
          </article>
          <nav v-if="result.posts" class="pagination" :aria-label="t('savedPosts.postPages')"><button type="button" data-testid="posts-previous" :disabled="!pageControls.previous" :onClick="pageControls.previous">{{ t('savedPosts.previous') }}</button><span>{{ t('savedPosts.offset', { offset: result.posts.offset, count: result.posts.count === null ? t('savedPosts.unknown') : result.posts.count }) }}</span><button type="button" data-testid="posts-next" :disabled="!pageControls.next" :onClick="pageControls.next">{{ t('savedPosts.next') }}</button></nav>
          <p v-if="result.posts?.has_more && result.posts.offset + pageSize > maxOffset" class="notice" data-testid="posts-bound">{{ t('savedPosts.browseBound') }}</p>
        </section>
        <section v-if="result.search?.kind === 'comments'" class="panel comments">
          <h2>{{ t('savedPosts.search.comments') }}</h2><p class="note">{{ t('savedPosts.commentOrder') }}</p>
          <article v-for="row in result.results.rows" :key="row.comment_id" class="stored-comment" data-testid="comment-row"><dl><dt>{{ t('savedPosts.commentId') }}</dt><dd>{{ row.comment_id }}</dd><dt>{{ t('savedPosts.postId') }}</dt><dd>{{ row.post_id }}</dd><dt>{{ t('savedPosts.userId') }}</dt><dd>{{ display(row.user_id) }}</dd><dt>{{ t('savedPosts.createdAt') }}</dt><dd class="saved-text">{{ display(row.created_at) }}</dd></dl><p class="saved-text" data-testid="comment-content">{{ display(row.content) }}</p><button type="button" :data-testid="`comment-open-${row.comment_id}`" :onClick="postHandler(result, row)">{{ t('savedPosts.search.openReferenced') }}</button></article>
          <p class="note">{{ t('savedPosts.search.parentNote') }}</p>
        </section>
        <nav v-if="result.search" class="pagination" :aria-label="t('savedPosts.search.pages')"><button type="button" data-testid="search-previous" :disabled="!pageControls.previous" :onClick="pageControls.previous">{{ t('savedPosts.previous') }}</button><button type="button" data-testid="search-next" :disabled="!pageControls.next" :onClick="pageControls.next">{{ t('savedPosts.next') }}</button></nav>
        <section v-if="result.comments" class="panel comments">
          <h2>{{ t('savedPosts.comments') }}</h2><p>{{ t('savedPosts.commentScope', { id: result.post_id, platform: result.platform }) }}</p><p class="note">{{ t('savedPosts.commentOrder') }}</p>
          <p data-testid="comments-coverage">{{ coverageLabel(result.comments) }}</p>
          <article v-for="row in result.comments.rows" :key="row.comment_id" class="stored-comment" data-testid="comment-row"><dl><dt>{{ t('savedPosts.commentId') }}</dt><dd>{{ row.comment_id }}</dd><dt>{{ t('savedPosts.userId') }}</dt><dd>{{ display(row.user_id) }}</dd><dt>{{ t('savedPosts.createdAt') }}</dt><dd class="saved-text">{{ display(row.created_at) }}</dd></dl><p class="saved-text" data-testid="comment-content">{{ display(row.content) }}</p></article>
          <nav class="pagination" :aria-label="t('savedPosts.commentPages')"><button type="button" data-testid="comments-previous" :disabled="!pageControls.previous" :onClick="pageControls.previous">{{ t('savedPosts.previous') }}</button><span>{{ t('savedPosts.offset', { offset: result.comments.offset, count: result.comments.count === null ? t('savedPosts.unknown') : result.comments.count }) }}</span><button type="button" data-testid="comments-next" :disabled="!pageControls.next" :onClick="pageControls.next">{{ t('savedPosts.next') }}</button></nav>
          <p v-if="result.comments.has_more && result.comments.offset + pageSize > maxOffset" class="notice" data-testid="comments-bound">{{ t('savedPosts.browseBound') }}</p>
        </section>
      </template>
      <p class="note">{{ t('savedPosts.limits') }}</p>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { getSavedPosts, getSavedPost, getSavedPostSearch } from '../api/simulation'

const { t } = useI18n(), route = useRoute(), router = useRouter()
const pageSize = 25, maxOffset = 500000, maxId = '9223372036854775807'
const result = ref(null), selected = ref(null), loading = ref(false), error = ref('')
const draft = ref({ q: '', kind: 'posts', case_sensitive: false }), dirty = ref(false), actionEpoch = ref(0)
const simulationId = computed(() => typeof route.params.simulationId === 'string' ? route.params.simulationId : '')
const reasons = ['state_missing', 'state_unreadable', 'run_state_unreadable', 'metadata_status_unknown', 'simulation_active', 'simulation_not_terminal', 'database_missing', 'source_unreadable', 'source_too_large', 'unsupported_journal', 'unsupported_source', 'table_missing', 'unsupported_schema', 'invalid_row', 'query_budget', 'database_busy', 'database_unreadable', 'response_too_large', 'post_missing', 'post_unavailable', 'metadata_unavailable']
const errors = ['invalid_selection', 'invalid_filters', 'invalid_pagination', 'unsafe_path', 'sources_changed', 'response_too_large', 'posts_unavailable', 'generic']
const statuses = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', 'completed', 'stopped', 'failed']
let generation = 0, disposed = false, activeRequest = null, navigation = null
const exactId = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})(?![\s\S])/.test(value) && (value.length < maxId.length || value <= maxId)
const compareIds = (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
function fail() { throw { selectionCode: 'invalid_selection' } }
function validPhrase(value) {
  // This exact whitespace set matches the saved reader; FEFF is literal text.
  return typeof value === 'string' && value.length > 0 && value.length <= 400 && [...value].length <= 200 && !/[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u.test(value) && !/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]+$/u.test(value)
}
function parseRoute() {
  const id = simulationId.value
  if (!/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) fail()
  const query = route.query
  if (Object.entries(query).some(([key, value]) => !['platform', 'offset', 'post_id', 'comment_offset', 'q', 'kind', 'case_sensitive'].includes(key) || typeof value !== 'string' || !value)) fail()
  if (query.platform === undefined && Object.keys(query).length) fail()
  if (query.platform !== undefined && !['twitter', 'reddit'].includes(query.platform)) fail()
  if (query.post_id !== undefined && !exactId(query.post_id) || query.comment_offset !== undefined && query.post_id === undefined) fail()
  if (query.q === undefined ? query.kind !== undefined || query.case_sensitive !== undefined : !validPhrase(query.q) || !['posts', 'comments'].includes(query.kind)) fail()
  if (query.case_sensitive !== undefined && !['true', 'false'].includes(query.case_sensitive)) fail()
  const offset = key => {
    if (query[key] === undefined) return 0
    if (!/^(0|[1-9][0-9]{0,5})(?![\s\S])/.test(query[key]) || Number(query[key]) > maxOffset) fail()
    return Number(query[key])
  }
  return { simulation_id: id, platform: query.platform ?? null, offset: offset('offset'), post_id: query.post_id ?? null, comment_offset: offset('comment_offset'), q: query.q ?? null, kind: query.kind ?? null, case_sensitive: query.case_sensitive === 'true' }
}
function targetFor(value) {
  return { name: 'SavedPosts', params: { simulationId: value.simulation_id }, query: value.platform ? { platform: value.platform, ...(value.q !== null ? { q: value.q, kind: value.kind, ...(value.case_sensitive ? { case_sensitive: 'true' } : {}) } : {}), ...(value.offset ? { offset: String(value.offset) } : {}), ...(value.post_id !== null ? { post_id: value.post_id, ...(value.comment_offset ? { comment_offset: String(value.comment_offset) } : {}) } : {}) } : {} }
}
function retire() {
  generation++; actionEpoch.value++
  if (navigation) navigation.retired = true
  activeRequest?.controller.abort(); activeRequest = null
  result.value = null; loading.value = false; error.value = ''
}
function owns(request) {
  return !disposed && !dirty.value && activeRequest === request && generation === request.generation && !request.controller.signal.aborted && route.name === 'SavedPosts' && route.fullPath === request.path
}
const accepted = computed(() => !!result.value && !loading.value && !!activeRequest && owns(activeRequest))
function ownsResult(saved, request, epoch) { return result.value === saved && accepted.value && activeRequest === request && generation === epoch && owns(request) }
function validResponse(data, value) {
  const searching = value.post_id === null && value.q !== null
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
  const optionalText = value => value === null || typeof value === 'string' && (!searching || !/\p{Cs}/u.test(value))
  const optionalId = value => value === null || exactId(value)
  const reason = value => value === null || reasons.includes(value) || searching && value === 'search_limit'
  const row = (value, comment = false) => {
    const fields = comment ? ['comment_id', 'post_id', 'user_id', 'content', 'created_at'] : ['post_id', 'user_id', 'original_post_id', 'content', 'quote_content', 'created_at']
    return keys(value, fields) && exactId(value.post_id) && optionalId(value.user_id) && optionalText(value.content) && optionalText(value.created_at) && (comment ? exactId(value.comment_id) && (searching || value.post_id === data.post_id) : optionalId(value.original_post_id) && optionalText(value.quote_content))
  }
  const page = (value, offset, comment = false) => {
    if (!keys(value, ['state', 'reason', 'offset', 'limit', 'count', 'has_more', 'rows', ...(searching ? ['matched_count'] : [])]) || value.offset !== offset || value.limit !== pageSize || !reason(value.reason) || !Array.isArray(value.rows)) return false
    if (value.state === 'unavailable') return value.reason !== null && value.count === null && value.has_more === null && value.rows.length === 0 && (!searching || value.matched_count === null)
    if (!['available', 'empty', 'out_of_range'].includes(value.state) || value.reason !== null || !Number.isSafeInteger(value.count) || value.count !== value.rows.length || value.count > pageSize || typeof value.has_more !== 'boolean') return false
    if (value.state !== (value.count ? 'available' : offset ? 'out_of_range' : 'empty') || value.has_more && value.count !== pageSize) return false
    if (searching && (!Number.isSafeInteger(value.matched_count) || value.matched_count < 0 || value.matched_count > 50000 || value.count !== Math.min(pageSize, Math.max(0, value.matched_count - offset)) || value.has_more !== (offset + value.count < value.matched_count))) return false
    let previous = null
    for (const item of value.rows) {
      if (!row(item, comment)) return false
      const id = comment ? item.comment_id : item.post_id
      if (previous !== null && (comment ? compareIds(previous, id) >= 0 : compareIds(previous, id) <= 0)) return false
      previous = id
    }
    return true
  }
  const fields = searching ? ['simulation_id', 'platform', 'observed_at', 'metadata', 'database', 'search', 'results'] : ['simulation_id', 'platform', 'post_id', 'observed_at', 'metadata', 'database', 'posts', 'post', 'comments']
  if (!keys(data, fields) || data.simulation_id !== value.simulation_id || data.platform !== value.platform || !searching && data.post_id !== value.post_id || typeof data.observed_at !== 'string' || searching && /\p{Cs}/u.test(data.observed_at)) return false
  const meta = data.metadata, db = data.database
  if (!keys(meta, ['state', 'reason', 'status', 'partial', 'warning']) || !['available', 'unavailable'].includes(meta.state) || !reason(meta.reason) || !(meta.status === null || statuses.includes(meta.status)) || typeof meta.partial !== 'boolean' || ![null, 'run_state_missing'].includes(meta.warning)) return false
  if (meta.partial !== ['stopped', 'failed'].includes(meta.status) || (meta.state === 'available' ? meta.reason !== null || !['completed', 'stopped', 'failed'].includes(meta.status) : meta.reason === null)) return false
  if (!keys(db, ['state', 'reason']) || !['available', 'unavailable'].includes(db.state) || !reason(db.reason) || (db.state === 'available' ? db.reason !== null || meta.state !== 'available' : db.reason === null)) return false
  // The reader's exact ASCII-JSON budget also bounds accepted decoded responses.
  if (JSON.stringify({ success: true, data }).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).length > 2097152) return false
  if (searching) return keys(data.search, ['kind', 'q', 'case_sensitive']) && data.search.kind === value.kind && data.search.q === value.q && data.search.case_sensitive === value.case_sensitive && page(data.results, value.offset, value.kind === 'comments') && (db.state === 'available' || data.results.state === 'unavailable')
  if (value.post_id === null) return data.post === null && data.comments === null && page(data.posts, value.offset) && (db.state === 'available' || data.posts.state === 'unavailable')
  if (data.posts !== null || !keys(data.post, ['state', 'reason', 'row']) || !reason(data.post.reason) || !page(data.comments, value.comment_offset, true)) return false
  if (data.post.state === 'available') return db.state === 'available' && data.post.reason === null && row(data.post.row) && data.post.row.post_id === value.post_id
  return ['missing', 'unavailable'].includes(data.post.state) && data.post.row === null && data.post.reason !== null && (data.post.state !== 'missing' || db.state === 'available' && data.post.reason === 'post_missing') && data.comments.state === 'unavailable'
}
async function load() {
  retire(); selected.value = null
  if (disposed || dirty.value || route.name !== 'SavedPosts') return
  let value
  try { value = parseRoute(); selected.value = value } catch { error.value = 'invalid_selection'; return }
  if (value.platform === null) return
  const request = { selected: value, generation, path: route.fullPath, controller: new AbortController() }
  activeRequest = request; loading.value = true
  const params = { platform: value.platform, offset: value.post_id === null ? value.offset : value.comment_offset, limit: pageSize }
  try {
    const response = value.post_id !== null ? await getSavedPost(value.simulation_id, value.post_id, params, request.controller.signal) : value.q !== null ? await getSavedPostSearch(value.simulation_id, { ...params, q: value.q, kind: value.kind, case_sensitive: value.case_sensitive }, request.controller.signal) : await getSavedPosts(value.simulation_id, params, request.controller.signal)
    if (!owns(request)) return
    if (!response || response.success !== true || Object.keys(response).length !== 2 || !Object.hasOwn(response, 'data')) throw { response: { data: response } }
    if (!validResponse(response.data, value)) throw new Error('Invalid saved post response')
    result.value = response.data
  } catch (cause) {
    if (!owns(request)) return
    result.value = null
    const code = cause?.response?.data?.error_code
    error.value = errors.includes(code) ? code : 'generic'
  } finally { if (owns(request)) loading.value = false }
}
async function navigate(value) {
  if (disposed || route.name !== 'SavedPosts') return
  retire(); syncDraft(value)
  const target = targetFor(value), intent = { path: router.resolve(target).fullPath, retired: false }
  navigation = intent
  try {
    // Calling push for equal URLs cancels an older guarded intent as well.
    await router.push(target)
    if (disposed || navigation !== intent || intent.retired) return
    navigation = null
    if (route.fullPath !== intent.path) { error.value = 'generic'; return }
    // A committed route watcher already loaded; an equal URL needs one read.
    if (!activeRequest) await load()
  } catch { if (!disposed && navigation === intent && !intent.retired) error.value = 'generic' }
  finally { if (navigation === intent) navigation = null }
}
function changePlatform(platform) {
  if (!['', 'twitter', 'reddit'].includes(platform)) return
  return navigate({ simulation_id: simulationId.value, platform: platform || null, offset: 0, post_id: null, comment_offset: 0, q: null, kind: null, case_sensitive: false })
}
function syncDraft(value) {
  draft.value = { q: value.q ?? '', kind: value.kind ?? 'posts', case_sensitive: value.case_sensitive === true }
  dirty.value = false
}
function editDraft(key, value) {
  if (disposed || selected.value?.post_id) return
  dirty.value = true; retire()
  draft.value = { ...draft.value, [key]: value }
}
const applyAction = computed(() => {
  const snapshot = draft.value, epoch = actionEpoch.value
  return () => {
    if (disposed || actionEpoch.value !== epoch || draft.value !== snapshot || !selected.value?.platform || selected.value.post_id) return
    retire()
    if (snapshot.q !== '' && (!validPhrase(snapshot.q) || !['posts', 'comments'].includes(snapshot.kind) || typeof snapshot.case_sensitive !== 'boolean')) { error.value = 'invalid_search'; return }
    return navigate({ ...selected.value, q: snapshot.q === '' ? null : snapshot.q, kind: snapshot.q === '' ? null : snapshot.kind, case_sensitive: snapshot.q !== '' && snapshot.case_sensitive, offset: 0, post_id: null, comment_offset: 0 })
  }
})
const clearAction = computed(() => {
  const epoch = actionEpoch.value
  return () => {
    if (disposed || actionEpoch.value !== epoch || !selected.value?.platform || selected.value.post_id) return
    return navigate({ ...selected.value, q: null, kind: null, case_sensitive: false, offset: 0, post_id: null, comment_offset: 0 })
  }
})
function refresh() {
  let value
  try { value = parseRoute() } catch { retire(); error.value = 'invalid_selection'; return }
  return navigate({ ...value, offset: 0, comment_offset: 0 })
}
const returnAction = computed(() => {
  const value = selected.value, epoch = generation
  return () => { if (!disposed && value && selected.value === value && generation === epoch) return navigate({ ...value, post_id: null, comment_offset: 0 }) }
})
function postHandler(saved, row) {
  const request = activeRequest, epoch = generation, postId = row.post_id, commentId = row.comment_id
  return () => {
    if (!ownsResult(saved, request, epoch) || !(saved.posts || saved.results)?.rows.includes(row) || row.post_id !== postId || row.comment_id !== commentId || !exactId(postId)) return
    return navigate({ ...request.selected, post_id: postId, comment_offset: 0 })
  }
}
const pageControls = computed(() => {
  const saved = result.value, request = activeRequest, epoch = generation
  if (!accepted.value) return { previous: null, next: null }
  const page = saved.results || saved.posts || saved.comments
  if (!page || page.state === 'unavailable') return { previous: null, next: null }
  const handler = offset => () => {
    if (!ownsResult(saved, request, epoch) || (saved.results || saved.posts || saved.comments) !== page) return
    return navigate({ ...request.selected, [request.selected.post_id === null ? 'offset' : 'comment_offset']: offset })
  }
  return { previous: page.offset > 0 ? handler(Math.max(0, page.offset - pageSize)) : null, next: page.has_more && page.offset + pageSize <= maxOffset ? handler(page.offset + pageSize) : null }
})
const shownPosts = computed(() => result.value?.search?.kind === 'posts' ? result.value.results.rows : result.value?.posts?.rows || (result.value?.post?.row ? [result.value.post.row] : []))
function display(value) { return value === null ? t('savedPosts.notStored') : value === '' ? t('savedPosts.emptyText') : value }
function reasonLabel(reason) { return t(`savedPosts.reasons.${reason}`) }
function coverageLabel(component) { return t(`savedPosts.states.${component.state}`) + (component.reason ? ': ' + reasonLabel(component.reason) : '') }
function searchCoverageLabel(component) { return t(`savedPosts.search.states.${component.state}`) + (component.reason ? ': ' + (component.reason === 'invalid_row' ? t('savedPosts.search.invalidRow') : reasonLabel(component.reason)) : '') }
function contentLabel(row) { return t(row.original_post_id === null && row.quote_content === null ? 'savedPosts.postText' : row.original_post_id !== null && row.quote_content !== null && row.quote_content !== '' ? 'savedPosts.originalText' : 'savedPosts.contentField') }
watch(() => route.fullPath, () => {
  const intent = navigation
  navigation = null
  if (intent?.path === route.fullPath && intent.retired) {
    // A guarded Apply may commit after another draft edit. Preserve the edit,
    // retire its old result and make no read until an explicit newer action.
    retire()
    try { selected.value = parseRoute() } catch { selected.value = null }
    return
  }
  retire()
  syncDraft({ q: typeof route.query.q === 'string' ? route.query.q : '', kind: typeof route.query.kind === 'string' ? route.query.kind : 'posts', case_sensitive: route.query.case_sensitive === 'true' })
  void load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; navigation = null; retire() })
</script>

<style scoped>
.posts-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: white; border-bottom: 1px solid #e5e7eb; }.brand { font-weight: 800; letter-spacing: 2px; text-decoration: none; }.header-actions { display: flex; align-items: center; gap: 22px; }a { color: #394555; }
main { max-width: 1040px; margin: auto; padding: 32px 24px 60px; }h1 { font-size: clamp(26px, 4vw, 36px); }h2 { font-size: 22px; }h3 { font-size: 15px; margin-bottom: 8px; }p { line-height: 1.65; }.identity, dd { overflow-wrap: anywhere; }.identity { font-family: monospace; }
.panel { background: white; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; margin: 20px 0; }.controls { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }label { font-weight: 600; }button, select { font: inherit; min-height: 44px; padding: 10px 14px; border: 1px solid #bfc8d4; border-radius: 7px; color: #28323f; background: white; }button { cursor: pointer; }button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 13px; }.notice { background: #fff3d9; padding: 12px 16px; border-radius: 8px; }.error { background: #fff0ed; color: #9a3527; }.stored-post, .stored-comment { border-top: 1px solid #e1e5eb; padding: 18px 0; }.saved-text { white-space: pre-wrap; overflow-wrap: anywhere; }dl { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(0, 3fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; }.pagination { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 14px; margin-top: 24px; }
.search-form label { display: block; margin: 12px 0 8px; }.search-form input[type="text"], .search-form select { box-sizing: border-box; width: 100%; font: inherit; min-height: 44px; border: 1px solid #bfc8d4; border-radius: 7px; padding: 10px 14px; }.search-actions, .case-control { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }.case-control input { width: 20px; height: 20px; }.case-control label { margin: 12px 0; }input:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
@media (max-width: 540px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 22px 14px; }.panel { padding: 16px; }dl { grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); } }
</style>
