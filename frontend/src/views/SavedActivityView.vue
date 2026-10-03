<template>
  <div class="activity-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink to="/">{{ t('comparison.backHome') }}</RouterLink><LanguageSwitcher /></div>
    </header>
    <main>
      <header class="page-heading">
        <p class="eyebrow">{{ t('comparison.eyebrow') }}</p>
        <h1>{{ t('savedActivity.title') }}</h1>
        <p class="simulation-id">{{ simulationId }}</p>
        <p>{{ t('savedActivity.scope') }}</p>
      </header>
      <form data-testid="activity-form" class="panel" :aria-label="t('savedActivity.filtersTitle')" @submit.prevent="applyFilters">
        <div class="filter-grid">
          <div><label for="activity-platform">{{ t('savedActivity.platform') }}</label>
            <select id="activity-platform" data-testid="platform" :value="draft.platform" @change="editDraft('platform', $event.target.value)">
              <option value="">{{ t('savedActivity.allPlatforms') }}</option><option v-for="platform in platforms" :key="platform" :value="platform">{{ t(`comparison.platforms.${platform}`) }}</option>
            </select>
          </div>
          <div><label for="activity-agent">{{ t('savedActivity.agentId') }}</label><input id="activity-agent" data-testid="agent-id" inputmode="numeric" :value="draft.agent_id" :placeholder="t('savedActivity.any')" @input="editDraft('agent_id', $event.target.value)"></div>
          <div><label for="activity-round">{{ t('savedActivity.round') }}</label><input id="activity-round" data-testid="round-num" inputmode="numeric" :value="draft.round_num" :placeholder="t('savedActivity.any')" @input="editDraft('round_num', $event.target.value)"></div>
          <div><label for="activity-type">{{ t('savedActivity.actionType') }}</label><input id="activity-type" data-testid="action-type" :value="draft.action_type" :placeholder="t('savedActivity.any')" @input="editDraft('action_type', $event.target.value)"></div>
          <div><label for="activity-page-size">{{ t('savedActivity.pageSize') }}</label>
            <select id="activity-page-size" data-testid="page-size" :value="draft.limit" @change="editDraft('limit', $event.target.value)">
              <option v-if="!pageSizes.includes(Number(draft.limit))" :value="draft.limit">{{ draft.limit }}</option><option v-for="size in pageSizes" :key="size" :value="String(size)">{{ size }}</option>
            </select>
          </div>
        </div>
        <p class="note">{{ t('savedActivity.filterNote') }}</p>
        <div class="actions">
          <button type="submit" data-testid="apply" class="primary" @click.prevent="applyFilters">{{ t('savedActivity.apply') }}</button>
          <button type="button" data-testid="refresh" @click="refresh">{{ t('savedActivity.refresh') }}</button>
          <button type="button" data-testid="download" :disabled="!result || dirty || loading" @click="downloadPage">{{ t('savedActivity.download') }}</button>
        </div>
      </form>
      <p class="note">{{ t('savedActivity.orderNote') }} {{ t('savedActivity.attemptNote') }}</p>
      <p v-if="dirty" class="notice" role="status">{{ t('savedActivity.draftNote') }}</p>
      <p v-if="loading" data-testid="loading" class="notice" role="status" aria-live="polite">{{ t('savedActivity.loading') }}</p>
      <p v-if="error" data-testid="error" class="notice error" role="alert">{{ t(`savedActivity.errors.${error}`) }}</p>
      <section v-if="result" data-testid="results" :aria-label="t('savedActivity.resultsTitle')">
        <article class="panel" data-testid="saved-context">
          <div class="summary-heading"><h2>{{ t('savedActivity.contextTitle') }}</h2><span data-testid="availability" class="availability" :class="result.availability">{{ availabilityLabel(result.availability) }}</span></div>
          <p>{{ t('comparison.savedStatus') }}: <strong>{{ statusLabel(result.context.status) }}</strong></p>
          <p class="note">{{ t('savedActivity.statusNote') }}</p>
          <dl><template v-for="field in contextFields" :key="field"><dt>{{ t(`comparison.fields.${field}`) }}</dt><dd>{{ result.context[field] ?? '—' }}</dd></template></dl>
          <ul class="platforms"><li v-for="platform in platforms" :key="platform">{{ t(`comparison.platforms.${platform}`) }}: {{ availabilityLabel(result.platform_availability[platform]) }}</li></ul>
          <ul v-if="result.warnings.length" class="warnings" :aria-label="t('comparison.warningsTitle')"><li v-for="(warning, index) in result.warnings" :key="index">{{ warningLabel(warning) }}</li></ul>
          <p class="note">{{ t('savedActivity.observedAt', { time: result.observed_at }) }}</p>
        </article>
        <div class="page-summary">
          <p data-testid="matched-count">{{ t('savedActivity.matchedCount', { count: result.matched_count ?? '—' }) }}</p>
          <p data-testid="page-position">{{ t('savedActivity.pagePosition', { offset: result.offset, count: result.returned_count }) }}</p>
        </div>
        <p class="note">{{ t('savedActivity.partialNote') }}</p>
        <div v-if="result.actions.length" class="table-scroll panel" tabindex="0" :aria-label="t('savedActivity.resultsTitle')">
          <table data-testid="activity-table">
            <caption>{{ t('savedActivity.tableCaption') }}</caption>
            <thead><tr><th v-for="field in columns" :key="field" scope="col">{{ t(`savedActivity.columns.${field}`) }}</th></tr></thead>
            <tbody><tr v-for="action in result.actions" :key="action.record_id" :data-testid="`action-row-${action.record_id}`">
              <td>{{ t(`comparison.platforms.${action.platform}`) }}</td><td>{{ action.round_num }}</td>
              <td><span>{{ action.agent_id }}</span><span v-if="action.agent_name !== null" class="agent-name">{{ action.agent_name }}</span></td>
              <td>{{ action.action_type }}</td><td>{{ action.timestamp ?? '—' }}</td><td>{{ t(`savedActivity.outcomes.${action.success === true ? 'success' : action.success === false ? 'failed' : 'unknown'}`) }}</td>
              <td><details><summary>{{ t('savedActivity.details') }}</summary><p class="record-id">{{ action.record_id }}</p><pre>{{ action.details_json }}</pre></details></td>
            </tr></tbody>
          </table>
        </div>
        <p v-else data-testid="empty-state" class="notice">{{ t(`savedActivity.${result.matched_count === null ? 'unavailable' : result.matched_count === 0 ? 'noMatches' : 'outOfRange'}`) }}</p>
      </section>
      <nav class="actions pagination" :aria-label="t('savedActivity.pagination')">
        <button type="button" data-testid="first" :disabled="!canPrevious" @click="goPage(0)">{{ t('savedActivity.first') }}</button>
        <button type="button" data-testid="previous" :disabled="!canPrevious" @click="goPage(Math.max(0, result.offset - result.limit))">{{ t('savedActivity.previous') }}</button>
        <button type="button" data-testid="next" :disabled="!canNext" @click="goPage(result.offset + result.limit)">{{ t('savedActivity.next') }}</button>
      </nav>
    </main>
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { getSavedActivity } from '../api/simulation'

const { t } = useI18n()
const route = useRoute(), router = useRouter()
const platforms = ['twitter', 'reddit'], pageSizes = [1, 10, 25, 50, 100]
const filterKeys = ['platform', 'agent_id', 'round_num', 'action_type']
const queryKeys = [...filterKeys, 'offset', 'limit', 'revision']
const contextFields = ['requested_rounds', 'last_saved_round', 'created_at', 'updated_at', 'started_at', 'completed_at']
const columns = ['platform', 'round', 'agent', 'actionType', 'timestamp', 'outcome', 'details']
const statuses = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', 'completed', 'stopped', 'failed']
const warningCodes = ['config_unavailable', 'run_state_unavailable', 'run_not_terminal', 'partial_run', 'platform_log_missing', 'platform_not_configured', 'invalid_records', 'source_unreadable', 'source_too_large', 'no_action_logs']
const errorCodes = ['invalid_selection', 'invalid_filters', 'invalid_pagination', 'invalid_revision', 'revision_required', 'unsafe_path', 'simulation_not_found', 'simulation_unreadable', 'simulation_active', 'sources_changed', 'response_too_large']
const revisionPattern = /^[a-f0-9]{64}$/
const result = ref(null), loading = ref(false), error = ref(''), dirty = ref(false)
const draft = ref({ platform: '', agent_id: '', round_num: '', action_type: '', limit: '50' })
const simulationId = computed(() => typeof route.params.simulationId === 'string' ? route.params.simulationId : '')
let disposed = false, activeRequest = null, acknowledgement = null, pendingNavigation = null, observedRevision = null, downloadUrl = null

function fail(code) { throw { selectionCode: code } }
function decimal(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,64}$/.test(value)) fail('invalid_filters')
  return value.replace(/^0+(?=\d)/, '')
}
function filters(values) {
  const selected = Object.fromEntries(filterKeys.map(key => [key, values[key] === undefined || values[key] === '' ? null : values[key]]))
  if (selected.platform !== null && !platforms.includes(selected.platform)) fail('invalid_filters')
  for (const key of ['agent_id', 'round_num']) if (selected[key] !== null) selected[key] = decimal(selected[key])
  if (selected.action_type !== null && (typeof selected.action_type !== 'string' || !selected.action_type.trim() || [...selected.action_type].length > 256 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(selected.action_type))) fail('invalid_filters')
  return selected
}
function pageNumber(value, fallback, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[0-9]{1,64}$/.test(value)) fail('invalid_pagination')
  const number = Number(value)
  if (number < min || number > max) fail('invalid_pagination')
  return number
}
function selection() {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(simulationId.value)) fail('invalid_selection')
  for (const [key, value] of Object.entries(route.query)) {
    if (!queryKeys.includes(key) || typeof value !== 'string' || value === '') fail('invalid_selection')
  }
  const selected = { simulation_id: simulationId.value, filters: filters(route.query), offset: pageNumber(route.query.offset, 0, 0, 500000), limit: pageNumber(route.query.limit, 50, 1, 100), revision: route.query.revision ?? null }
  if (selected.revision !== null && !revisionPattern.test(selected.revision)) fail('invalid_revision')
  if (selected.offset > 0 && !selected.revision) fail('revision_required')
  return selected
}
function requestParams(selected) {
  return { ...Object.fromEntries(filterKeys.filter(key => selected.filters[key] !== null).map(key => [key, selected.filters[key]])), offset: selected.offset, limit: selected.limit, ...(selected.revision ? { revision: selected.revision } : {}) }
}
function revokeDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = null
}
function retire() {
  if (pendingNavigation) pendingNavigation.retired = true
  activeRequest?.controller.abort()
  activeRequest = null
  revokeDownload()
  result.value = null; loading.value = false; error.value = ''
}
function owns(request) {
  return !disposed && activeRequest === request && !request.controller.signal.aborted && !dirty.value && route.fullPath === request.path
}
function syncDraft() {
  draft.value = Object.fromEntries([...filterKeys, 'limit'].map(key => [key, typeof route.query[key] === 'string' ? route.query[key] : key === 'limit' ? '50' : '']))
  // Select option values are canonical decimals, including for zero-padded URLs.
  try { draft.value.limit = String(pageNumber(route.query.limit, 50, 1, 100)) } catch { /* load reports invalid pagination */ }
  dirty.value = false
  observedRevision = typeof route.query.revision === 'string' && revisionPattern.test(route.query.revision) ? route.query.revision : null
}
function validResponse(data, selected) {
  const bounded = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max
  const exactInteger = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
  const optionalText = value => value === null || typeof value === 'string'
  const availabilities = ['complete', 'partial', 'unavailable']
  if (!data || data.simulation_id !== selected.simulation_id || typeof data.source_revision !== 'string' || !revisionPattern.test(data.source_revision) || (selected.revision && data.source_revision !== selected.revision) || data.offset !== selected.offset || data.limit !== selected.limit || data.order !== 'source_record') return false
  if (!data.filters || Object.keys(data.filters).length !== filterKeys.length || filterKeys.some(key => data.filters[key] !== selected.filters[key])) return false
  if (!availabilities.includes(data.availability) || !data.platform_availability || platforms.some(platform => !availabilities.includes(data.platform_availability[platform])) || !Array.isArray(data.warnings) || !data.context || typeof data.observed_at !== 'string') return false
  if (!optionalText(data.context.status) || contextFields.some(key => key.endsWith('_at') ? !optionalText(data.context[key]) : data.context[key] !== null && !exactInteger(data.context[key]))) return false
  if (!Array.isArray(data.actions) || !bounded(data.returned_count, selected.limit) || data.returned_count !== data.actions.length || (data.matched_count !== null && !bounded(data.matched_count, 500000)) || typeof data.has_more !== 'boolean') return false
  if ((data.availability === 'unavailable') !== (data.matched_count === null) || data.has_more !== (data.matched_count !== null && data.offset + data.returned_count < data.matched_count) || data.returned_count > Math.max(0, (data.matched_count ?? 0) - data.offset)) return false
  const ids = new Set()
  return data.actions.every(action => {
    if (!action || typeof action.record_id !== 'string' || !action.record_id || ids.has(action.record_id)) return false
    ids.add(action.record_id)
    return platforms.includes(action.platform) && exactInteger(action.round_num) && exactInteger(action.agent_id) && optionalText(action.agent_name) && optionalText(action.timestamp) && typeof action.action_type === 'string' && (action.success === true || action.success === false || action.success === null) && typeof action.details_json === 'string' && filterKeys.every(key => selected.filters[key] === null || action[key] === selected.filters[key])
  })
}
async function load() {
  retire()
  if (disposed || dirty.value) return
  let selected
  try { selected = selection() } catch (cause) { error.value = cause.selectionCode; return }
  const request = { selected, path: route.fullPath, controller: new AbortController() }
  activeRequest = request; loading.value = true
  try {
    const response = await getSavedActivity(selected.simulation_id, requestParams(selected), request.controller.signal)
    if (!owns(request)) return
    if (!response?.success) throw { response: { data: response } }
    if (!validResponse(response.data, selected)) throw new Error('Invalid saved activity response')
    result.value = response.data; observedRevision = response.data.source_revision
    if (!selected.revision) {
      const target = { name: 'SavedActivity', params: { simulationId: selected.simulation_id }, query: { ...route.query, revision: observedRevision } }
      const ack = { request, path: router.resolve(target).fullPath }
      acknowledgement = ack
      await router.replace(target)
      if (acknowledgement === ack) acknowledgement = null
      if (owns(request) && route.fullPath !== ack.path) throw new Error('Revision navigation was not accepted')
    }
  } catch (cause) {
    if (acknowledgement?.request === request) acknowledgement = null
    if (!owns(request)) return
    result.value = null
    const code = cause?.response?.data?.error_code
    error.value = errorCodes.includes(code) ? code : 'generic'
  } finally {
    if (owns(request)) loading.value = false
  }
}
function editDraft(key, value) {
  dirty.value = true
  retire()
  draft.value = { ...draft.value, [key]: value }
}
async function navigateSelected(selected) {
  const target = { name: 'SavedActivity', params: { simulationId: selected.simulation_id }, query: requestParams(selected) }
  retire(); dirty.value = false; acknowledgement = null
  const navigation = { path: router.resolve(target).fullPath, retired: false }
  pendingNavigation = navigation
  try {
    // Even same-URL Apply cancels an older pending navigation. The watcher
    // starts changed-URL reads; this continuation handles a same-URL retry.
    await router.push(target)
    if (disposed || pendingNavigation !== navigation || navigation.retired) return
    pendingNavigation = null
    if (route.fullPath !== navigation.path) { error.value = 'generic'; return }
    syncDraft(); await load()
  } catch {
    if (!disposed && pendingNavigation === navigation && !navigation.retired) error.value = 'generic'
  } finally {
    if (pendingNavigation === navigation) pendingNavigation = null
  }
}
function applyFilters() {
  retire()
  try {
    const selected = { simulation_id: simulationId.value, filters: filters(draft.value), offset: 0, limit: pageNumber(draft.value.limit, 50, 1, 100), revision: observedRevision }
    return navigateSelected(selected)
  } catch (cause) { error.value = cause.selectionCode ?? 'invalid_filters' }
}
function refresh() {
  let selected
  try { selected = selection() } catch {
    // A malformed page/revision can be recovered without weakening filter checks.
    try { selected = { simulation_id: simulationId.value, filters: filters(route.query), limit: pageNumber(route.query.limit, 50, 1, 100) } }
    catch (cause) { retire(); error.value = cause.selectionCode ?? 'invalid_selection'; return }
  }
  observedRevision = null
  return navigateSelected({ ...selected, offset: 0, revision: null })
}
const canPrevious = computed(() => !!result.value && !dirty.value && !loading.value && result.value.offset > 0)
const canNext = computed(() => !!result.value && !dirty.value && !loading.value && result.value.has_more && result.value.offset + result.value.limit <= 500000)
function goPage(offset) {
  if (!result.value || dirty.value || loading.value) return
  return navigateSelected({ simulation_id: result.value.simulation_id, filters: result.value.filters, offset, limit: result.value.limit, revision: result.value.source_revision })
}
function downloadPage() {
  if (!result.value || dirty.value || loading.value || !activeRequest || !owns(activeRequest)) return
  revokeDownload()
  const saved = result.value
  downloadUrl = URL.createObjectURL(new Blob([JSON.stringify({ format_version: 1, ...saved }, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = downloadUrl; link.download = `${saved.simulation_id}-saved-activity-page-${saved.offset}.json`
  document.body.appendChild(link); link.click(); link.remove()
}
function availabilityLabel(value) { return t(`comparison.availability.${value}`) }
function statusLabel(value) { return t(`comparison.statuses.${statuses.includes(value) ? value : 'unknown'}`) }
function warningLabel(warning) {
  const code = warningCodes.includes(warning?.code) ? warning.code : 'generic'
  const message = t(`comparison.warnings.${code}`, { count: Number.isSafeInteger(warning?.count) ? warning.count : '—' })
  return platforms.includes(warning?.platform) ? `${t(`comparison.platforms.${warning.platform}`)}: ${message}` : message
}
watch(() => route.fullPath, () => {
  if (acknowledgement?.path === route.fullPath) {
    const ack = acknowledgement
    acknowledgement = null
    // A revision acknowledgement never starts another read or resurrects a
    // request retired by an input event while router.replace was pending.
    if (activeRequest === ack.request && !dirty.value && !ack.request.controller.signal.aborted) {
      ack.request.path = route.fullPath
      ack.request.selected.revision = observedRevision
    }
    return
  }
  acknowledgement = null
  const navigation = pendingNavigation
  pendingNavigation = null
  // An internal Apply/page/Refresh may finish after the user edits a draft.
  // Keep that draft retired until another Apply. External navigation continues
  // to restore the URL's applied selection through the normal path below.
  if (navigation?.path === route.fullPath && navigation.retired) return
  retire(); syncDraft(); load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; acknowledgement = null; retire(); pendingNavigation = null })
</script>

<style scoped>
.activity-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions { display: flex; align-items: center; gap: 24px; font-size: 14px; }a { color: #394555; }
main { max-width: 1260px; margin: 0 auto; padding: 36px 24px 60px; }.page-heading { max-width: 920px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 19px; margin: 0; }p { line-height: 1.6; }.simulation-id { font-family: monospace; overflow-wrap: anywhere; }
.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; }.filter-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1.5fr .7fr; gap: 16px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; background: #fff; color: #202329; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }.note { color: #68707c; font-size: 13px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.notice.error { background: #fff0ed; color: #9a3527; }.summary-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }.availability { border-radius: 20px; padding: 5px 10px; background: #eff2f5; font-size: 12px; }.availability.partial, .warnings { background: #fff3d9; color: #805518; }
dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }.platforms { display: flex; flex-wrap: wrap; gap: 16px; padding: 0; list-style: none; font-size: 13px; }.warnings { padding: 14px 14px 14px 32px; font-size: 13px; border-radius: 7px; line-height: 1.7; }.page-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
.table-scroll { overflow-x: auto; padding: 16px; }table { border-collapse: collapse; width: 100%; min-width: 850px; text-align: left; font-size: 13px; }caption { text-align: left; color: #68707c; padding: 8px 0 16px; }th, td { padding: 12px 10px; border-bottom: 1px solid #e6e9ee; vertical-align: top; overflow-wrap: anywhere; }th { font-weight: 600; color: #68707c; }td { max-width: 260px; }.agent-name { display: block; color: #68707c; font-size: 12px; margin-top: 6px; }summary { cursor: pointer; }.record-id { color: #68707c; font-size: 12px; }pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 monospace; min-width: 200px; max-height: 420px; overflow-y: auto; }.pagination { margin-top: 24px; }
@media (max-width: 900px) { .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }@media (max-width: 540px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 24px 14px; }.filter-grid { grid-template-columns: 1fr; }.panel { padding: 16px; }.summary-heading { align-items: flex-start; flex-direction: column; } }
</style>
