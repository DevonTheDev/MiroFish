<template>
  <div class="activity-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink :to="recordsLocation">{{ t('savedActivityRounds.backRecords') }}</RouterLink><RouterLink to="/">{{ t('comparison.backHome') }}</RouterLink><LanguageSwitcher /></div>
    </header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('comparison.eyebrow') }}</p><h1>{{ t('savedActivityRounds.title') }}</h1><p class="simulation-id">{{ simulationId }}</p><p>{{ t('savedActivity.scope') }}</p><p>{{ t('savedActivityRounds.scope') }}</p></header>
      <form data-testid="rounds-form" class="panel" :aria-label="t('savedActivityRounds.filtersTitle')" @submit.prevent="applyFilters">
        <div class="filter-grid">
          <div><label for="rounds-platform">{{ t('savedActivity.platform') }}</label><select id="rounds-platform" data-testid="rounds-platform" :value="draft.platform" @change="editDraft('platform', $event.target.value)"><option value="">{{ t('savedActivity.allPlatforms') }}</option><option v-for="platform in platforms" :key="platform" :value="platform">{{ t(`comparison.platforms.${platform}`) }}</option></select></div>
          <div><label for="round-from">{{ t('savedActivityRounds.roundFrom') }}</label><input id="round-from" data-testid="round-from" inputmode="numeric" :value="draft.round_from" :placeholder="t('savedActivity.any')" @input="editDraft('round_from', $event.target.value)"></div>
          <div><label for="round-to">{{ t('savedActivityRounds.roundTo') }}</label><input id="round-to" data-testid="round-to" inputmode="numeric" :value="draft.round_to" :placeholder="t('savedActivity.any')" @input="editDraft('round_to', $event.target.value)"></div>
        </div>
        <p class="note">{{ t('savedActivityRounds.filterNote') }}</p>
        <div class="actions"><button type="submit" data-testid="rounds-apply" class="primary" @click.prevent="applyFilters">{{ t('savedActivity.apply') }}</button><button type="button" data-testid="rounds-refresh" @click="refresh">{{ t('savedActivity.refresh') }}</button><button type="button" data-testid="rounds-download" :disabled="!accepted" :onClick="downloadHandler(result)">{{ t('savedActivityRounds.download') }}</button></div>
      </form>
      <p class="note">{{ t('savedActivityRounds.orderNote') }} {{ t('savedActivity.attemptNote') }} {{ t('savedActivity.outcomeNote') }}</p>
      <p v-if="dirty" class="notice" role="status">{{ t('savedActivityRounds.draftNote') }}</p>
      <p v-if="loading" data-testid="rounds-loading" class="notice" role="status" aria-live="polite">{{ t('savedActivityRounds.loading') }}</p>
      <p v-if="error" data-testid="rounds-error" class="notice error" role="alert">{{ t(`savedActivityRounds.errors.${error}`) }}</p>
      <section v-if="accepted" data-testid="rounds-results" :aria-label="t('savedActivityRounds.resultsTitle')">
        <article class="panel" data-testid="rounds-context">
          <div class="summary-heading"><h2>{{ t('savedActivity.contextTitle') }}</h2><span data-testid="rounds-availability" class="availability" :class="result.availability">{{ availabilityLabel(result.availability) }}</span></div>
          <p>{{ t('comparison.savedStatus') }}: <strong>{{ statusLabel(result.context.status) }}</strong></p><p class="note">{{ t('savedActivity.statusNote') }}</p>
          <dl><template v-for="field in contextFields" :key="field"><dt>{{ t(`comparison.fields.${field}`) }}</dt><dd>{{ result.context[field] ?? '—' }}</dd></template></dl>
          <ul class="platforms"><li v-for="platform in platforms" :key="platform">{{ t(`comparison.platforms.${platform}`) }}: {{ availabilityLabel(result.platform_availability[platform]) }}</li></ul>
          <ul v-if="result.warnings.length" class="warnings" :aria-label="t('comparison.warningsTitle')"><li v-for="(warning, index) in result.warnings" :key="index">{{ warningLabel(warning) }}</li></ul>
          <p class="note">{{ t('savedActivity.observedAt', { time: result.observed_at }) }}</p>
        </article>
        <div class="page-summary"><p data-testid="rounds-matched-count">{{ t('savedActivity.matchedCount', { count: result.matched_count ?? '—' }) }}</p><p data-testid="rounds-round-count">{{ t('savedActivityRounds.roundCount', { count: result.round_count }) }}</p><p v-for="outcome in outcomes" :key="outcome" :data-testid="`rounds-outcome-${outcome}`">{{ t(`savedActivity.outcomes.${outcome}`) }}: {{ result.outcomes[outcome] ?? '—' }}</p></div>
        <p class="note">{{ t('savedActivityRounds.partialNote') }}</p>
        <div v-if="result.rounds.length" class="table-scroll panel" tabindex="0" :aria-label="t('savedActivityRounds.resultsTitle')">
          <table data-testid="rounds-table"><caption>{{ t('savedActivityRounds.tableCaption') }}</caption><thead><tr><th scope="col">{{ t('savedActivity.columns.round') }}</th><th scope="col">{{ t('savedActivityRounds.total') }}</th><th v-for="outcome in outcomes" :key="outcome" scope="col">{{ t(`savedActivity.outcomes.${outcome}`) }}</th></tr></thead>
            <tbody><tr v-for="row in pageRows" :key="row.round_num" :data-testid="`round-row-${row.round_num}`"><td class="round-number">{{ row.round_num }}<p v-if="!row.drilldown_supported" class="note">{{ t('savedActivityRounds.unsupportedRound') }}</p></td><td v-for="column in countColumns" :key="column"><button class="count-button" type="button" :data-testid="`round-${row.round_num}-${column}`" :disabled="!row.drilldown_supported || countFor(row, column) === 0" :aria-label="t('savedActivityRounds.openCount', { round: row.round_num, outcome: column === 'total' ? t('savedActivityRounds.total') : t(`savedActivity.outcomes.${column}`), count: countFor(row, column) })" :title="!row.drilldown_supported ? t('savedActivityRounds.unsupportedRound') : undefined" :onClick="drilldownHandler(result, row, column)">{{ countFor(row, column) }}</button></td></tr></tbody>
          </table>
        </div>
        <p v-else data-testid="rounds-empty" class="notice">{{ t(`savedActivity.${result.matched_count === null ? 'unavailable' : 'noMatches'}`) }}</p>
      </section>
      <nav class="actions pagination" :aria-label="t('savedActivityRounds.pagination')"><button type="button" data-testid="rounds-first" :disabled="!canPrevious" @click="goPage(0)">{{ t('savedActivity.first') }}</button><button type="button" data-testid="rounds-previous" :disabled="!canPrevious" @click="goPage(pageIndex - 1)">{{ t('savedActivity.previous') }}</button><button type="button" data-testid="rounds-next" :disabled="!canNext" @click="goPage(pageIndex + 1)">{{ t('savedActivity.next') }}</button><p v-if="accepted" data-testid="rounds-page-position" class="note">{{ t('savedActivityRounds.pagePosition', { page: pageIndex + 1, pages: Math.max(1, Math.ceil(result.round_count / pageSize)) }) }}</p></nav>
    </main>
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { getSavedActivityRounds } from '../api/simulation'

const { t } = useI18n()
const route = useRoute(), router = useRouter()
const platforms = ['twitter', 'reddit'], outcomes = ['success', 'failed', 'unknown'], countColumns = ['total', ...outcomes]
const filterKeys = ['platform', 'round_from', 'round_to'], queryKeys = [...filterKeys, 'revision']
const contextFields = ['requested_rounds', 'last_saved_round', 'created_at', 'updated_at', 'started_at', 'completed_at']
const statuses = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', 'completed', 'stopped', 'failed']
const warningCodes = ['config_unavailable', 'run_state_unavailable', 'run_not_terminal', 'partial_run', 'platform_log_missing', 'platform_not_configured', 'invalid_records', 'source_unreadable', 'source_too_large', 'no_action_logs']
const errorCodes = ['invalid_selection', 'invalid_filters', 'invalid_revision', 'unsafe_path', 'simulation_not_found', 'simulation_unreadable', 'simulation_active', 'sources_changed', 'too_many_rounds', 'response_too_large']
const revisionPattern = /^[a-f0-9]{64}$/, pageSize = 25, maxRounds = 1000, maxAttempts = 500000
const result = ref(null), loading = ref(false), error = ref(''), dirty = ref(false), pageIndex = ref(0)
const draft = ref({ platform: '', round_from: '', round_to: '' })
const simulationId = computed(() => typeof route.params.simulationId === 'string' ? route.params.simulationId : '')
let disposed = false, activeRequest = null, acknowledgement = null, pendingNavigation = null, observedRevision = null, downloadUrl = null

function fail(code) { throw { selectionCode: code } }
function decimal(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,64}$/.test(value)) fail('invalid_filters')
  return value.replace(/^0+(?=\d)/, '')
}
// Canonical decimal ordering never rounds source or filter IDs through Number.
function compareDecimal(left, right) { return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0) }
function filters(values) {
  const selected = Object.fromEntries(filterKeys.map(key => [key, values[key] === undefined || values[key] === '' ? null : values[key]]))
  if (selected.platform !== null && !platforms.includes(selected.platform)) fail('invalid_filters')
  for (const key of ['round_from', 'round_to']) if (selected[key] !== null) selected[key] = decimal(selected[key])
  if (selected.round_from !== null && selected.round_to !== null && compareDecimal(selected.round_from, selected.round_to) > 0) fail('invalid_filters')
  return selected
}
function selection() {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(simulationId.value)) fail('invalid_selection')
  for (const [key, value] of Object.entries(route.query)) if (!queryKeys.includes(key) || typeof value !== 'string' || value === '') fail('invalid_selection')
  const selected = { simulation_id: simulationId.value, filters: filters(route.query), revision: route.query.revision ?? null }
  if (selected.revision !== null && !revisionPattern.test(selected.revision)) fail('invalid_revision')
  return selected
}
function requestParams(selected) { return { ...Object.fromEntries(filterKeys.filter(key => selected.filters[key] !== null).map(key => [key, selected.filters[key]])), ...(selected.revision ? { revision: selected.revision } : {}) } }
function revokeDownload() { if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null }
function retire() {
  if (pendingNavigation) pendingNavigation.retired = true
  activeRequest?.controller.abort(); activeRequest = null
  revokeDownload(); result.value = null; loading.value = false; error.value = ''; pageIndex.value = 0
}
function owns(request) { return !disposed && activeRequest === request && !request.controller.signal.aborted && !dirty.value && route.fullPath === request.path }
const accepted = computed(() => !!result.value && !dirty.value && !loading.value && !!activeRequest && owns(activeRequest))
function syncDraft() {
  draft.value = Object.fromEntries(filterKeys.map(key => [key, typeof route.query[key] === 'string' ? route.query[key] : '']))
  dirty.value = false
  observedRevision = typeof route.query.revision === 'string' && revisionPattern.test(route.query.revision) ? route.query.revision : null
}
function validResponse(data, selected) {
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
  const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
  const bounded = (value, max = maxAttempts) => Number.isSafeInteger(value) && value >= 0 && value <= max
  const exactInteger = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
  const optionalText = value => value === null || typeof value === 'string'
  const availabilities = ['complete', 'partial', 'unavailable']
  if (!keys(data, ['simulation_id', 'source_revision', 'observed_at', 'context', 'availability', 'platform_availability', 'warnings', 'filters', 'order', 'matched_count', 'round_count', 'outcomes', 'rounds'])) return false
  if (data.simulation_id !== selected.simulation_id || typeof data.source_revision !== 'string' || !revisionPattern.test(data.source_revision) || (selected.revision && data.source_revision !== selected.revision) || data.order !== 'round_ascending' || typeof data.observed_at !== 'string') return false
  if (!keys(data.filters, filterKeys) || filterKeys.some(key => data.filters[key] !== selected.filters[key])) return false
  if (!availabilities.includes(data.availability) || !keys(data.platform_availability, platforms) || platforms.some(platform => !availabilities.includes(data.platform_availability[platform]))) return false
  if (!keys(data.context, ['status', ...contextFields]) || !optionalText(data.context.status) || contextFields.some(key => key.endsWith('_at') ? !optionalText(data.context[key]) : data.context[key] !== null && !exactInteger(data.context[key]))) return false
  if (!Array.isArray(data.warnings) || !data.warnings.every(warning => object(warning) && typeof warning.code === 'string' && Object.keys(warning).every(key => ['code', 'platform', 'count'].includes(key)) && (warning.platform === undefined || platforms.includes(warning.platform)) && (warning.count === undefined || bounded(warning.count)))) return false
  if (!Array.isArray(data.rounds) || !bounded(data.round_count, maxRounds) || data.round_count !== data.rounds.length || !keys(data.outcomes, outcomes)) return false
  // Match the service's ASCII JSON response budget, including Unicode escapes.
  if (JSON.stringify({ success: true, data }).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).length > 1024 * 1024) return false
  if (data.availability === 'unavailable') return data.matched_count === null && data.round_count === 0 && outcomes.every(key => data.outcomes[key] === null)
  if (!bounded(data.matched_count) || !outcomes.every(key => bounded(data.outcomes[key]))) return false
  const totals = { success: 0, failed: 0, unknown: 0 }
  let count = 0, previous = null
  for (const row of data.rounds) {
    if (!keys(row, ['round_num', 'count', 'outcomes', 'drilldown_supported']) || !exactInteger(row.round_num) || !bounded(row.count) || row.count === 0 || !keys(row.outcomes, outcomes) || !outcomes.every(key => bounded(row.outcomes[key])) || typeof row.drilldown_supported !== 'boolean' || row.drilldown_supported !== (row.round_num.length <= 64)) return false
    if (previous !== null && compareDecimal(previous, row.round_num) >= 0 || selected.filters.round_from !== null && compareDecimal(row.round_num, selected.filters.round_from) < 0 || selected.filters.round_to !== null && compareDecimal(row.round_num, selected.filters.round_to) > 0) return false
    previous = row.round_num
    if (outcomes.reduce((sum, key) => sum + row.outcomes[key], 0) !== row.count) return false
    count += row.count
    for (const key of outcomes) totals[key] += row.outcomes[key]
  }
  return count === data.matched_count && outcomes.every(key => totals[key] === data.outcomes[key])
}
async function load() {
  retire()
  if (disposed || dirty.value) return
  let selected
  try { selected = selection() } catch (cause) { error.value = cause.selectionCode; return }
  const request = { selected, path: route.fullPath, controller: new AbortController() }
  activeRequest = request; loading.value = true
  try {
    const response = await getSavedActivityRounds(selected.simulation_id, requestParams(selected), request.controller.signal)
    if (!owns(request)) return
    if (!response || response.success !== true || Object.keys(response).length !== 2 || !Object.hasOwn(response, 'data')) throw { response: { data: response } }
    if (!validResponse(response.data, selected)) throw new Error('Invalid saved round overview response')
    result.value = response.data; observedRevision = response.data.source_revision
    if (!selected.revision) {
      const target = { name: 'SavedActivityRounds', params: { simulationId: selected.simulation_id }, query: { ...route.query, revision: observedRevision } }
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
  } finally { if (owns(request)) loading.value = false }
}
function cancelPendingDrill() {
  if (pendingNavigation?.kind !== 'drilldown') return
  pendingNavigation.retired = true; pendingNavigation = null
  // A same-URL replace cancels the router's older guarded record navigation.
  // It keeps the unapplied draft on this view without starting another read.
  void router.replace(route.fullPath).catch(() => {})
}
function editDraft(key, value) {
  dirty.value = true; cancelPendingDrill(); retire()
  draft.value = { ...draft.value, [key]: value }
}
async function navigateSelected(selected) {
  const target = { name: 'SavedActivityRounds', params: { simulationId: selected.simulation_id }, query: requestParams(selected) }
  retire(); dirty.value = false; acknowledgement = null
  const navigation = { path: router.resolve(target).fullPath, retired: false }
  pendingNavigation = navigation
  try {
    // Push even when the URL is equal so a prior guarded navigation is canceled.
    await router.push(target)
    if (disposed || pendingNavigation !== navigation || navigation.retired) return
    pendingNavigation = null
    if (route.fullPath !== navigation.path) { error.value = 'generic'; return }
    syncDraft(); await load()
  } catch { if (!disposed && pendingNavigation === navigation && !navigation.retired) error.value = 'generic' }
  finally { if (pendingNavigation === navigation) pendingNavigation = null }
}
function applyFilters() {
  retire()
  try { return navigateSelected({ simulation_id: simulationId.value, filters: filters(draft.value), revision: observedRevision }) }
  catch (cause) { error.value = cause.selectionCode ?? 'invalid_filters' }
}
function refresh() {
  let selected
  try { selected = selection() } catch {
    // Repair a bad revision only; unsupported URL fields remain rejected.
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(simulationId.value) || Object.entries(route.query).some(([key, value]) => !queryKeys.includes(key) || typeof value !== 'string' || value === '')) fail('invalid_selection')
      selected = { simulation_id: simulationId.value, filters: filters(route.query) }
    } catch (cause) { retire(); error.value = cause.selectionCode ?? 'invalid_selection'; return }
  }
  observedRevision = null
  return navigateSelected({ ...selected, revision: null })
}
const pageRows = computed(() => result.value?.rounds.slice(pageIndex.value * pageSize, (pageIndex.value + 1) * pageSize) ?? [])
const canPrevious = computed(() => accepted.value && pageIndex.value > 0)
const canNext = computed(() => accepted.value && (pageIndex.value + 1) * pageSize < result.value.round_count)
function goPage(index) { if (accepted.value && Number.isInteger(index) && index >= 0 && index < Math.max(1, Math.ceil(result.value.round_count / pageSize))) pageIndex.value = index }
function countFor(row, column) { return column === 'total' ? row.count : row.outcomes[column] }
function ownsResult(saved, request) { return !!saved && result.value === saved && accepted.value && activeRequest === request && owns(request) }
function drilldownHandler(saved, row, column) {
  const request = activeRequest
  return async () => {
    if (!ownsResult(saved, request) || !saved.rounds.includes(row) || !row.drilldown_supported || !countColumns.includes(column) || countFor(row, column) <= 0) return
    const query = { ...(saved.filters.platform ? { platform: saved.filters.platform } : {}), round_num: row.round_num, ...(column === 'total' ? {} : { outcome: column }), offset: 0, limit: 50, revision: saved.source_revision }
    // Drilldown leaves this page, so retire its exports and pending observation.
    retire(); acknowledgement = null
    const target = { name: 'SavedActivity', params: { simulationId: saved.simulation_id }, query }
    const navigation = { path: router.resolve(target).fullPath, kind: 'drilldown', retired: false }
    pendingNavigation = navigation
    try {
      await router.push(target)
      if (!disposed && pendingNavigation === navigation && !navigation.retired && route.fullPath !== navigation.path) error.value = 'generic'
    } catch {
      if (!disposed && pendingNavigation === navigation && !navigation.retired) error.value = 'generic'
    } finally { if (pendingNavigation === navigation) pendingNavigation = null }
  }
}
function downloadHandler(saved) {
  const request = activeRequest
  return () => {
    if (!ownsResult(saved, request)) return
    revokeDownload()
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify({ format_version: 1, ...saved }, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = downloadUrl; link.download = `${saved.simulation_id}-saved-activity-rounds.json`
    document.body.appendChild(link); link.click(); link.remove()
  }
}
const recordsLocation = computed(() => ({ name: 'SavedActivity', params: { simulationId: simulationId.value }, query: { ...(platforms.includes(route.query.platform) ? { platform: route.query.platform } : {}), ...(typeof route.query.revision === 'string' && revisionPattern.test(route.query.revision) ? { revision: route.query.revision } : {}) } }))
function availabilityLabel(value) { return t(`comparison.availability.${value}`) }
function statusLabel(value) { return t(`comparison.statuses.${statuses.includes(value) ? value : 'unknown'}`) }
function warningLabel(warning) {
  const code = warningCodes.includes(warning.code) ? warning.code : 'generic'
  const message = t(`comparison.warnings.${code}`, { count: Number.isSafeInteger(warning.count) ? warning.count : '—' })
  return platforms.includes(warning.platform) ? `${t(`comparison.platforms.${warning.platform}`)}: ${message}` : message
}
watch(() => route.fullPath, () => {
  if (acknowledgement?.path === route.fullPath) {
    const ack = acknowledgement; acknowledgement = null
    if (activeRequest === ack.request && !dirty.value && !ack.request.controller.signal.aborted) { ack.request.path = route.fullPath; ack.request.selected.revision = observedRevision }
    return
  }
  acknowledgement = null
  const navigation = pendingNavigation; pendingNavigation = null
  if (navigation?.path === route.fullPath && navigation.retired) return
  retire(); syncDraft(); load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; acknowledgement = null; cancelPendingDrill(); retire(); pendingNavigation = null })
</script>

<style scoped>
.activity-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; font-size: 14px; }a { color: #394555; }
main { max-width: 1260px; margin: 0 auto; padding: 36px 24px 60px; }.page-heading { max-width: 920px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 19px; margin: 0; }p { line-height: 1.6; }.simulation-id, .round-number { font-family: monospace; overflow-wrap: anywhere; }
.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; }.filter-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; background: #fff; color: #202329; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 18px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }.count-button { min-width: 60px; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }.note { color: #68707c; font-size: 13px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.notice.error { background: #fff0ed; color: #9a3527; }.summary-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }.availability { border-radius: 20px; padding: 5px 10px; background: #eff2f5; font-size: 12px; }.availability.partial, .warnings { background: #fff3d9; color: #805518; }
dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }.platforms { display: flex; flex-wrap: wrap; gap: 16px; padding: 0; list-style: none; font-size: 13px; }.warnings { padding: 14px 14px 14px 32px; font-size: 13px; border-radius: 7px; line-height: 1.7; }.page-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
.table-scroll { overflow-x: auto; padding: 16px; }table { border-collapse: collapse; width: 100%; min-width: 640px; text-align: left; font-size: 13px; }caption { text-align: left; color: #68707c; padding: 8px 0 16px; }th, td { padding: 12px 10px; border-bottom: 1px solid #e6e9ee; vertical-align: top; overflow-wrap: anywhere; }th { font-weight: 600; color: #68707c; }.round-number { max-width: 300px; }.pagination { margin-top: 24px; }
@media (max-width: 900px) { .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }@media (max-width: 540px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 24px 14px; }.filter-grid { grid-template-columns: 1fr; }.panel { padding: 16px; }.summary-heading { align-items: flex-start; flex-direction: column; } }
</style>
