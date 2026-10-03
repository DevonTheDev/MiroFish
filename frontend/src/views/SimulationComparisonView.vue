<template>
  <div class="comparison-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink to="/">{{ t('comparison.backHome') }}</RouterLink><LanguageSwitcher /></div>
    </header>
    <main>
      <header class="page-heading">
        <p class="eyebrow">{{ t('comparison.eyebrow') }}</p>
        <h1>{{ t('comparison.title') }}</h1>
        <p>{{ t('comparison.scope') }}</p>
      </header>
      <section class="selection-panel" :aria-label="t('comparison.selectionTitle')">
        <div class="selection-grid">
          <div v-for="side in sides" :key="side" class="selection-field">
            <label :for="`${side}-simulation`">{{ t(`comparison.${side}`) }}</label>
            <select :id="`${side}-simulation`" :data-testid="`${side}-select`" :value="selection[side]"
              :aria-describedby="`${side}-selection-note`" @change="selectSimulation(side, $event.target.value)">
              <option value="">{{ t('comparison.chooseSimulation') }}</option>
              <option v-if="selection[side] && !hasCandidate(selection[side])" :value="selection[side]">{{ selection[side] }}</option>
              <option v-for="candidate in candidates" :key="candidate.simulation_id" :value="candidate.simulation_id">
                {{ candidateLabel(candidate) }}
              </option>
            </select>
            <p :id="`${side}-selection-note`" class="selection-note">
              {{ missingSelection(side) ? t('comparison.missingSelection', { id: selection[side] }) : t('comparison.choiceScope') }}
            </p>
          </div>
        </div>
        <div class="selection-actions">
          <button type="button" data-testid="compare" class="primary" :disabled="!validPair" @click="loadComparison">{{ t('comparison.compare') }}</button>
          <button type="button" data-testid="swap" :disabled="!validPair" @click="swap">{{ t('comparison.swap') }}</button>
          <button type="button" data-testid="refresh" @click="refresh">{{ t('comparison.refresh') }}</button>
          <span v-if="candidatesLoading" role="status">{{ t('comparison.loadingCandidates') }}</span>
        </div>
        <p v-if="candidateError" class="notice error" role="alert">{{ t('comparison.errors.candidates') }}</p>
        <p v-else-if="candidatesLoaded && !candidates.length" class="notice">{{ t('comparison.noCandidates') }}</p>
        <p v-if="skippedRecords > 0" class="notice">{{ t('comparison.skippedRecords', { count: skippedRecords }) }}</p>
        <p v-if="selectionIssue" class="notice" role="status">{{ t(`comparison.${selectionIssue}`) }}</p>
      </section>
      <p class="reading-note">{{ t('comparison.interpretation') }} {{ t('comparison.unavailableNote') }}</p>
      <p v-if="comparisonLoading" class="notice" role="status" aria-live="polite">{{ t('comparison.loadingComparison') }}</p>
      <p v-if="comparisonError" class="notice error" role="alert">{{ t(`comparison.errors.${comparisonError}`) }}</p>
      <section v-if="result" data-testid="results" :aria-label="t('comparison.resultTitle')">
        <div class="summaries">
          <article v-for="side in sides" :key="side" class="summary-card" :data-testid="`${side}-summary`">
            <div class="summary-heading"><h2>{{ t(`comparison.${side}`) }}</h2><span class="availability" :class="result[side].availability">{{ availabilityLabel(result[side].availability) }}</span></div>
            <p class="simulation-id">{{ result[side].simulation_id }}</p>
            <p class="saved-status" :class="{ interrupted: ['failed', 'stopped'].includes(result[side].status) }">
              {{ t('comparison.savedStatus') }}: <strong>{{ statusLabel(result[side].status) }}</strong>
            </p>
            <h3>{{ t('comparison.scenario') }}</h3>
            <p class="scenario">{{ result[side].scenario || t('comparison.notSaved') }}</p>
            <dl>
              <template v-for="field in contextFields" :key="field"><dt>{{ t(`comparison.fields.${field}`) }}</dt><dd>{{ contextValue(result[side], field) }}</dd></template>
            </dl>
            <p class="context-note">{{ t('comparison.modelNote') }}</p>
            <ul v-if="result[side].warnings?.length" class="warnings" :aria-label="t('comparison.warningsTitle')">
              <li v-for="(warning, index) in result[side].warnings" :key="index">{{ warningLabel(warning) }}</li>
            </ul>
          </article>
        </div>
        <section class="metrics-section">
          <h2>{{ t('comparison.recordedActivity') }}</h2>
          <p>{{ t('comparison.differenceNote') }}</p>
          <div class="table-scroll" tabindex="0" :aria-label="t('comparison.recordedActivity')">
            <table>
              <caption>{{ t('comparison.metricsCaption') }}</caption>
              <thead><tr><th scope="col">{{ t('comparison.metric') }}</th><th scope="col">{{ t('comparison.left') }}</th><th scope="col">{{ t('comparison.right') }}</th><th scope="col">{{ t('comparison.difference') }}</th></tr></thead>
              <tbody>
                <tr v-for="metric in globalMetrics" :key="metric" :data-testid="`metric-${metric}`">
                  <th scope="row">{{ t(`comparison.metrics.${metric}`) }}</th>
                  <td>{{ count(result.left.metrics?.[metric]) }}</td><td>{{ count(result.right.metrics?.[metric]) }}</td><td>{{ difference(result.differences?.[metric]) }}</td>
                </tr>
                <template v-for="platform in platforms" :key="platform">
                  <tr class="platform-row"><th scope="row">{{ t(`comparison.platforms.${platform}`) }}</th><td v-for="side in sides" :key="side">{{ availabilityLabel(result[side].metrics?.platforms?.[platform]?.availability) }}</td><td>—</td></tr>
                  <tr v-for="metric in platformMetrics" :key="metric" :data-testid="`metric-${platform}-${metric}`">
                    <th scope="row">{{ t(`comparison.platforms.${platform}`) }} · {{ t(`comparison.metrics.${metric}`) }}</th>
                    <td>{{ count(result.left.metrics?.platforms?.[platform]?.[metric]) }}</td><td>{{ count(result.right.metrics?.platforms?.[platform]?.[metric]) }}</td><td>{{ difference(result.differences?.platforms?.[platform]?.[metric]) }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="context-note">{{ t('comparison.agentNote') }}</p>
        </section>
        <section class="metrics-section">
          <h2>{{ t('comparison.actionTypes') }}</h2>
          <div v-if="result.differences?.action_types?.length" class="table-scroll" tabindex="0" :aria-label="t('comparison.actionTypes')">
            <table>
              <caption>{{ t('comparison.actionTypesCaption') }}</caption>
              <thead><tr><th scope="col">{{ t('comparison.actionType') }}</th><th scope="col">{{ t('comparison.left') }}</th><th scope="col">{{ t('comparison.right') }}</th><th scope="col">{{ t('comparison.difference') }}</th></tr></thead>
              <tbody><tr v-for="row in result.differences.action_types" :key="row.action_type"><th scope="row">{{ row.action_type }}</th><td>{{ count(row.left) }}</td><td>{{ count(row.right) }}</td><td>{{ difference(row.difference) }}</td></tr></tbody>
            </table>
          </div>
          <p v-else>{{ t('comparison.noActionTypes') }}</p>
        </section>
        <p class="generated-at">{{ t('comparison.generatedAt', { date: formatDate(result.generated_at) }) }}</p>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { getComparisonCandidates, compareSavedSimulations } from '../api/simulation'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const sides = ['left', 'right']
const platforms = ['twitter', 'reddit']
const globalMetrics = ['recorded_actions', 'rounds_with_actions']
const platformMetrics = ['recorded_actions', 'active_agents']
const contextFields = ['configured_model', 'configured_agents', 'requested_rounds', 'last_saved_round', 'created_at', 'updated_at', 'started_at', 'completed_at']
const statusCodes = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', 'completed', 'stopped', 'failed']
const warningCodes = ['config_unavailable', 'run_state_unavailable', 'run_not_terminal', 'partial_run', 'platform_log_missing', 'platform_not_configured', 'invalid_records', 'source_unreadable', 'source_too_large', 'no_action_logs']
const errorCodes = ['invalid_selection', 'unsafe_path', 'simulation_not_found', 'simulation_unreadable', 'simulation_active', 'sources_changed']
const selection = computed(() => ({ left: typeof route.query.left === 'string' ? route.query.left : '', right: typeof route.query.right === 'string' ? route.query.right : '' }))
const malformedSelection = computed(() => sides.some(side => route.query[side] !== undefined && typeof route.query[side] !== 'string'))
const validPair = computed(() => !malformedSelection.value && !!selection.value.left && !!selection.value.right && selection.value.left !== selection.value.right)
const selectionIssue = computed(() => malformedSelection.value ? 'invalidSelection' : !selection.value.left || !selection.value.right ? 'choosePair' : selection.value.left === selection.value.right ? 'duplicateSelection' : '')
const candidates = ref([])
const candidatesLoading = ref(false)
const candidatesLoaded = ref(false)
const candidateError = ref(false)
const skippedRecords = ref(0)
const result = ref(null)
const comparisonLoading = ref(false)
const comparisonError = ref('')
let disposed = false
let candidateRequest = null
let comparisonRequest = null

function retireComparison() {
  comparisonRequest?.controller.abort()
  comparisonRequest = null
  result.value = null
  comparisonError.value = ''
  comparisonLoading.value = false
}
async function loadCandidates() {
  candidateRequest?.controller.abort()
  const request = { controller: new AbortController() }
  candidateRequest = request
  candidatesLoading.value = true
  candidateError.value = false
  const current = () => !disposed && candidateRequest === request && !request.controller.signal.aborted
  try {
    const response = await getComparisonCandidates(request.controller.signal)
    if (!current()) return
    if (!response?.success || !Array.isArray(response.data?.candidates)) throw new Error('Invalid candidate response')
    candidates.value = response.data.candidates
    skippedRecords.value = response.data.skipped_records ?? 0
    candidatesLoaded.value = true
  } catch {
    if (current()) candidateError.value = true
  } finally {
    if (current()) candidatesLoading.value = false
  }
}
async function loadComparison() {
  retireComparison()
  if (disposed || !validPair.value) return
  const request = { ...selection.value, controller: new AbortController() }
  comparisonRequest = request
  comparisonLoading.value = true
  const current = () => !disposed && comparisonRequest === request && !request.controller.signal.aborted &&
    selection.value.left === request.left && selection.value.right === request.right
  try {
    const response = await compareSavedSimulations(request.left, request.right, request.controller.signal)
    if (!current()) return
    if (!response?.success) throw { response: { data: response } }
    if (response.data?.left?.simulation_id !== request.left || response.data?.right?.simulation_id !== request.right) throw new Error('Mismatched comparison response')
    result.value = response.data
  } catch (error) {
    if (!current()) return
    const code = error?.response?.data?.error_code
    comparisonError.value = errorCodes.includes(code) ? code : 'generic'
  } finally {
    if (current()) comparisonLoading.value = false
  }
}
function selectSimulation(side, id) {
  if (selection.value[side] === id) return
  // Invalidate before asynchronous router navigation can resolve: labels and
  // values never retain observations owned by a previous selection.
  retireComparison()
  const query = { ...route.query, [side]: id || undefined }
  return router.push({ name: 'SimulationComparison', query })
}
function swap() {
  if (!validPair.value) return
  retireComparison()
  return router.push({ name: 'SimulationComparison', query: { ...route.query, left: selection.value.right, right: selection.value.left } })
}
function refresh() { loadCandidates(); loadComparison() }
function hasCandidate(id) { return candidates.value.some(candidate => candidate.simulation_id === id) }
function missingSelection(side) { return candidatesLoaded.value && !candidateError.value && !!selection.value[side] && !hasCandidate(selection.value[side]) }
function statusLabel(status) { return t(`comparison.statuses.${statusCodes.includes(status) ? status : 'unknown'}`) }
function availabilityLabel(value) { return t(`comparison.availability.${['complete', 'partial', 'unavailable'].includes(value) ? value : 'unavailable'}`) }
function count(value) { return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—' }
function difference(value) { return typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value}` : '—' }
function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', { timeZoneName: 'short' })
}
function candidateLabel(candidate) {
  return `${candidate.simulation_id} · ${candidate.scenario || t('comparison.notSaved')} · ${statusLabel(candidate.status)} · ${formatDate(candidate.updated_at || candidate.created_at)}`
}
function contextValue(summary, field) {
  if (field.endsWith('_at')) return formatDate(summary[field])
  if (field === 'configured_model') return summary[field] || '—'
  return count(summary[field])
}
function warningLabel(warning) {
  const code = warningCodes.includes(warning.code) ? warning.code : 'generic'
  const message = t(`comparison.warnings.${code}`, { count: count(warning.count) })
  return platforms.includes(warning.platform) ? `${t(`comparison.platforms.${warning.platform}`)}: ${message}` : message
}
watch(() => [route.query.left, route.query.right], loadComparison, { immediate: true, flush: 'sync' })
loadCandidates()
onBeforeUnmount(() => {
  disposed = true
  candidateRequest?.controller.abort()
  candidateRequest = null
  retireComparison()
})
</script>

<style scoped>
.comparison-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; color: #18181b; text-decoration: none; }
.header-actions { display: flex; align-items: center; gap: 24px; font-size: 14px; }
a { color: #394555; }
main { max-width: 1180px; margin: 0 auto; padding: 42px 24px 60px; }
.page-heading { max-width: 880px; margin-bottom: 28px; }
.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; font-weight: 700; color: #6b7280; }
h1 { font-size: clamp(26px, 4vw, 36px); line-height: 1.2; margin: 12px 0; }
h2 { font-size: 19px; margin: 0; } h3 { font-size: 13px; color: #68707c; margin: 20px 0 6px; }
p { line-height: 1.6; } .page-heading > p:last-child, .reading-note { color: #59616d; font-size: 14px; }
.selection-panel, .summary-card, .metrics-section { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 24px; }
.selection-grid, .summaries { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.selection-field label { display: block; font-size: 14px; font-weight: 700; margin-bottom: 10px; }
select { width: 100%; min-height: 44px; border: 1px solid #c8cfd9; background: #fff; color: #262c35; border-radius: 7px; padding: 10px; font: inherit; font-size: 14px; }
.selection-note, .context-note { color: #69717d; font-size: 12px; margin: 10px 0 0; overflow-wrap: anywhere; }
.selection-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 20px; }
button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 18px; font: inherit; font-size: 14px; min-height: 44px; }
button.primary { background: #222b38; color: #fff; border-color: #222b38; } button:disabled { opacity: .45; cursor: not-allowed; }
button:hover:enabled { background: #edf1f6; } button.primary:hover:enabled { background: #3b495e; }
button:focus-visible, select:focus-visible, a:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.notice { background: #f0f3f7; border-radius: 8px; padding: 14px 16px; font-size: 14px; }
.notice.error { background: #fff0ed; color: #9a3527; }
.reading-note { margin: 22px 0; }
.summary-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.availability { border-radius: 20px; padding: 5px 10px; background: #eff2f5; font-size: 12px; font-weight: 600; }
.availability.partial { background: #fff3d9; color: #805518; }.availability.unavailable { color: #656c76; }
.simulation-id { font-family: monospace; overflow-wrap: anywhere; color: #5f6b7a; font-size: 12px; }
.saved-status { padding: 10px 12px; background: #eff3f6; border-radius: 6px; font-size: 13px; }
.saved-status.interrupted { color: #8a4121; background: #fff0e5; border-left: 3px solid #c07243; }
.scenario { font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 18px; }
dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; font-size: 13px; margin-bottom: 0; } dt { color: #68707c; } dd { margin: 0; overflow-wrap: anywhere; }
.warnings { padding: 14px 14px 14px 30px; background: #fff8e9; border-radius: 7px; font-size: 12px; line-height: 1.7; color: #7b5a21; }
.metrics-section { margin-top: 24px; }.metrics-section > p { color: #667180; font-size: 13px; }
.table-scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14px; text-align: right; table-layout: fixed; min-width: 560px; }
caption { text-align: left; color: #68707c; padding: 8px 0 16px; font-size: 12px; }
th, td { border-bottom: 1px solid #e6e9ee; padding: 14px 10px; overflow-wrap: anywhere; } th:first-child { width: 40%; text-align: left; } th { font-weight: 600; } thead { color: #68707c; font-size: 12px; } td { font-variant-numeric: tabular-nums; }
.platform-row { background: #f8f9fb; color: #68707c; font-size: 12px; }
.generated-at { text-align: right; font-size: 12px; color: #737b86; margin-top: 18px; }
@media (max-width: 720px) { .app-header { padding: 14px 20px; flex-wrap: wrap; }.header-actions { gap: 16px; }main { padding: 28px 16px; }.selection-grid, .summaries { grid-template-columns: 1fr; gap: 18px; }.selection-panel, .summary-card, .metrics-section { padding: 18px; } }
</style>
