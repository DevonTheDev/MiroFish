<template>
  <div class="captures-page">
    <header class="app-header"><RouterLink class="brand" to="/">MIROFISH</RouterLink><div class="header-actions"><RouterLink to="/">{{ t('comparison.backHome') }}</RouterLink><LanguageSwitcher /></div></header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('runCaptures.eyebrow') }}</p><h1>{{ t('runCaptures.title') }}</h1><p>{{ t('runCaptures.scope') }}</p></header>
      <p v-if="routeError" class="notice error" role="alert">{{ t('runCaptures.errors.invalid_selection') }}</p>
      <section v-if="recoveryRequired || recoveryLoading || recoveryError" class="notice" data-testid="storage-recovery" aria-live="polite">
        <h2>{{ t('runCaptures.recoveryTitle') }}</h2><p>{{ errorText('capture_recovery_required') }}</p><p class="note">{{ t('runCaptures.storeRecoveryNote') }}</p>
        <p v-if="recoveryLoading" role="status">{{ t('runCaptures.recoveringStore') }}</p><p v-if="recoveryError" class="error-text" role="alert">{{ t('runCaptures.recoveryUnconfirmed') }} {{ errorText(recoveryError) }}</p>
        <div class="actions"><button type="button" data-testid="recover-store" :disabled="recoveryLoading" @click="recoverStore">{{ t('runCaptures.recoverStore') }}</button><button type="button" data-testid="recheck-store" :disabled="recoveryLoading" @click="refreshStorageReads">{{ t('runCaptures.recheckStore') }}</button></div>
      </section>
      <section class="panel" :aria-label="t('runCaptures.newCapture')">
        <h2>{{ t('runCaptures.newCapture') }}</h2><p class="note">{{ t('runCaptures.previewNote') }}</p>
        <label for="capture-simulation">{{ t('runCaptures.simulation') }}</label>
        <select id="capture-simulation" data-testid="simulation-select" :value="selected.simulation" :disabled="!!attempt" @change="selectSimulation($event.target.value)">
          <option value="">{{ t('comparison.chooseSimulation') }}</option><option v-if="selected.simulation && !candidates.some(item => item.simulation_id === selected.simulation)" :value="selected.simulation">{{ selected.simulation }}</option>
          <option v-for="candidate in candidates" :key="candidate.simulation_id" :value="candidate.simulation_id">{{ candidateLabel(candidate) }}</option>
        </select>
        <div class="actions"><button type="button" data-testid="preview" :disabled="routeError || !selected.simulation || previewLoading || !!attempt" @click="loadPreview">{{ t('runCaptures.preview') }}</button><button type="button" data-testid="refresh-candidates" :disabled="candidatesLoading" @click="loadCandidates">{{ t('runCaptures.refreshCandidates') }}</button></div>
        <p v-if="candidatesLoading" role="status">{{ t('comparison.loadingCandidates') }}</p><p v-if="candidateError" class="notice error" role="alert">{{ t('comparison.errors.candidates') }}</p><p v-else-if="candidatesLoaded && !candidates.length" class="note">{{ t('runCaptures.noCandidates') }}</p><p v-if="skippedRecords" class="note">{{ t('comparison.skippedRecords', { count: skippedRecords }) }}</p>
        <p v-if="previewLoading" role="status">{{ t('runCaptures.previewLoading') }}</p><p v-if="previewError" class="notice error" role="alert">{{ errorText(previewError) }}</p>
        <div v-if="preview" class="observation-preview" data-testid="preview-observation"><h3>{{ t('runCaptures.previewTitle') }}</h3><RunCaptureObservation :observation="preview" /></div>
        <form data-testid="capture-form" @submit.prevent="saveCapture">
          <div class="draft-grid"><div><label for="capture-label">{{ t('runCaptures.label') }}</label><input id="capture-label" data-testid="label" :value="label" :disabled="!!attempt" @input="editDraft('label', $event.target.value)" :aria-describedby="'capture-text-note'" /></div><div><label for="capture-note">{{ t('runCaptures.note') }}</label><textarea id="capture-note" data-testid="note" :value="note" :disabled="!!attempt" @input="editDraft('note', $event.target.value)" :aria-describedby="'capture-text-note'" rows="3"></textarea></div></div>
          <p id="capture-text-note" class="note">{{ t('runCaptures.textLimits') }}</p><p v-if="textInvalid" class="notice error">{{ errorText('invalid_capture_text') }}</p>
          <div class="actions"><button type="submit" class="primary" data-testid="save" :disabled="!canSave">{{ t('runCaptures.save') }}</button></div>
        </form>
        <section v-if="attempt" class="notice" data-testid="save-attempt" aria-live="polite"><h3>{{ t('runCaptures.attemptTitle') }}</h3><p class="literal">{{ attempt.payload.label }} · {{ attempt.payload.simulation_id }}</p><p class="identity">{{ t('runCaptures.captureId') }}: {{ attempt.id }}</p><p>{{ t(`runCaptures.saveStates.${attempt.state}`) }}</p><p v-if="attempt.error" class="error-text">{{ errorText(attempt.error) }}</p><div v-if="attempt.state === 'uncertain'" class="actions"><button type="button" data-testid="check-save" @click="reconcileAttempt(attempt)">{{ t('runCaptures.checkSave') }}</button><button type="button" data-testid="retry-save" :disabled="!attempt.retryAllowed" @click="retrySave">{{ t('runCaptures.retrySave') }}</button></div><p class="note">{{ t('runCaptures.recoveryNote') }}</p></section>
        <p v-if="saveError" class="notice error" role="alert">{{ errorText(saveError) }}</p>
        <section v-if="savedCapture" class="saved-result" data-testid="saved-capture"><h3>{{ t('runCaptures.saved') }}</h3><p class="note">{{ t('runCaptures.savedNote') }}</p><RunCaptureObservation :observation="savedCapture.observation" :capture="savedCapture" :show-metrics="false" /><div class="actions"><button type="button" data-testid="view-saved" @click="selectCapture(savedCapture.capture_id)">{{ t('runCaptures.view') }}</button><button type="button" data-testid="new-preview" :disabled="!!attempt" @click="loadPreview">{{ t('runCaptures.previewAgain') }}</button></div></section>
      </section>
      <section v-for="(id, index) in recoveryIds" :key="id" class="notice" data-testid="recovery"><p>{{ t('runCaptures.recover') }}</p><p class="identity">{{ id }}</p><button type="button" :data-testid="index === 0 ? 'recover-capture' : `recover-capture-${id}`" @click="selectCapture(id)">{{ t('runCaptures.checkSavedId') }}</button></section>
      <p class="reading-note">{{ t('comparison.interpretation') }} {{ t('comparison.unavailableNote') }}</p>
      <section class="library" :aria-label="t('runCaptures.library')">
        <div class="section-heading"><h2>{{ t('runCaptures.library') }}</h2><button type="button" data-testid="refresh-library" @click="loadLibrary">{{ t('runCaptures.refreshLibrary') }}</button></div>
        <p v-if="listLoading" role="status">{{ t('runCaptures.loadingLibrary') }}</p><p v-if="listError" class="notice error" role="alert">{{ errorText(listError) }}</p>
        <template v-if="catalogue"><p class="note">{{ t('runCaptures.libraryCount', { shown: catalogue.captures.length, total: catalogue.total }) }}</p><div class="capture-grid"><article v-for="record in catalogue.captures" :key="record.capture_id" class="panel capture-card" :data-testid="`capture-row-${record.capture_id}`"><h3>{{ record.label }}</h3><p class="identity">{{ record.capture_id }}</p><dl><dt>{{ t('runCaptures.simulation') }}</dt><dd>{{ record.simulation_id }}</dd><dt>{{ t('runCaptures.capturedAt') }}</dt><dd>{{ record.captured_at }}</dd><dt>{{ t('comparison.savedStatus') }}</dt><dd>{{ statusLabel(record.status) }}</dd></dl><p class="note">{{ availabilityLabel(record.availability) }}</p><div class="actions"><button type="button" :data-testid="`view-${record.capture_id}`" @click="selectCapture(record.capture_id)">{{ t('runCaptures.view') }}</button><button type="button" :data-testid="`choose-left-${record.capture_id}`" @click="selectSide('left', record.capture_id)">{{ t('runCaptures.chooseLeft') }}</button><button type="button" :data-testid="`choose-right-${record.capture_id}`" @click="selectSide('right', record.capture_id)">{{ t('runCaptures.chooseRight') }}</button></div></article></div><p v-if="!catalogue.captures.length" class="notice" data-testid="empty-library">{{ t(catalogue.total ? 'runCaptures.emptyPage' : 'runCaptures.emptyLibrary') }}</p></template>
        <nav class="actions pagination" :aria-label="t('runCaptures.pagination')"><button type="button" data-testid="first" :disabled="!catalogue || !selected.offset || listLoading" @click="goPage(0)">{{ t('runCaptures.first') }}</button><button type="button" data-testid="previous" :disabled="!catalogue || !selected.offset || listLoading" @click="goPage(Math.max(0, selected.offset - 20))">{{ t('runCaptures.previous') }}</button><button type="button" data-testid="next" :disabled="!catalogue?.has_more || listLoading" @click="goPage(selected.offset + 20)">{{ t('runCaptures.next') }}</button></nav>
      </section>
      <section class="reader" :aria-label="t('runCaptures.detailTitle')"><div class="section-heading"><h2>{{ t('runCaptures.detailTitle') }}</h2><div class="actions"><button type="button" data-testid="download-capture" :disabled="!detail" @click="downloadCapture">{{ t('runCaptures.downloadCapture') }}</button><button v-if="selected.capture" type="button" data-testid="close-capture" @click="selectCapture('')">{{ t('runCaptures.close') }}</button></div></div><p v-if="detailLoading" role="status">{{ t('runCaptures.loadingDetail') }}</p><p v-if="detailError" class="notice error" role="alert">{{ errorText(detailError) }}</p><div v-if="detail" class="panel" data-testid="capture-detail"><RunCaptureObservation :observation="detail.observation" :capture="detail" /></div><p v-else-if="!detailLoading && !detailError" class="note">{{ t('runCaptures.chooseDetail') }}</p></section>
      <section class="compare" :aria-label="t('runCaptures.compareTitle')"><h2>{{ t('runCaptures.compareTitle') }}</h2><p class="note">{{ t('runCaptures.compareNote') }}</p><div class="selection-grid"><div v-for="side in sides" :key="side"><label :for="`${side}-capture`">{{ t(`runCaptures.${side}`) }}</label><select :id="`${side}-capture`" :data-testid="`${side}-select`" :value="selected[side]" @change="selectSide(side, $event.target.value)"><option value="">{{ t('runCaptures.chooseCapture') }}</option><option v-if="selected[side] && !catalogue?.captures.some(record => record.capture_id === selected[side])" :value="selected[side]">{{ selected[side] }}</option><option v-for="record in catalogue?.captures || []" :key="record.capture_id" :value="record.capture_id">{{ record.label }} · {{ record.capture_id }}</option></select></div></div><div class="actions"><button type="button" data-testid="compare" :disabled="!validPair" @click="loadComparison">{{ t('comparison.compare') }}</button><button type="button" data-testid="swap" :disabled="!validPair" @click="swap">{{ t('comparison.swap') }}</button><button type="button" data-testid="download-comparison" :disabled="!comparison" @click="downloadComparison">{{ t('runCaptures.downloadComparison') }}</button></div><p v-if="selected.left && selected.left === selected.right" class="notice">{{ t('runCaptures.duplicateSelection') }}</p><p v-if="comparisonLoading" role="status">{{ t('runCaptures.loadingComparison') }}</p><p v-if="comparisonError" class="notice error" role="alert">{{ errorText(comparisonError) }}</p>
        <div v-if="comparison" data-testid="comparison"><div class="selection-grid summaries"><section v-for="side in sides" :key="side" class="panel"><h3>{{ t(`runCaptures.${side}`) }}</h3><RunCaptureObservation :observation="comparison[side].observation" :capture="comparison[side]" :show-metrics="false" /></section></div><section class="panel metrics"><h3>{{ t('comparison.recordedActivity') }}</h3><p class="note">{{ t('comparison.differenceNote') }}</p><div class="table-scroll" tabindex="0" :aria-label="t('comparison.recordedActivity')"><table><caption>{{ t('runCaptures.metricsCaption') }}</caption><thead><tr><th scope="col">{{ t('comparison.metric') }}</th><th scope="col">{{ t('runCaptures.left') }}</th><th scope="col">{{ t('runCaptures.right') }}</th><th scope="col">{{ t('comparison.difference') }}</th></tr></thead><tbody><tr v-for="metric in globalMetrics" :key="metric" :data-testid="`metric-${metric}`"><th scope="row">{{ t(`comparison.metrics.${metric}`) }}</th><td v-for="side in sides" :key="side">{{ count(comparison[side].observation.summary.metrics[metric]) }}</td><td>{{ difference(comparison.differences[metric]) }}</td></tr><template v-for="platform in platforms" :key="platform"><tr class="platform-row"><th scope="row">{{ t(`comparison.platforms.${platform}`) }}</th><td v-for="side in sides" :key="side">{{ availabilityLabel(comparison[side].observation.summary.metrics.platforms[platform].availability) }}</td><td>—</td></tr><tr v-for="metric in platformMetrics" :key="metric" :data-testid="`metric-${platform}-${metric}`"><th scope="row">{{ t(`comparison.platforms.${platform}`) }} · {{ t(`comparison.metrics.${metric}`) }}</th><td v-for="side in sides" :key="side">{{ count(comparison[side].observation.summary.metrics.platforms[platform][metric]) }}</td><td>{{ difference(comparison.differences.platforms[platform][metric]) }}</td></tr></template></tbody></table></div><p class="note">{{ t('comparison.agentNote') }}</p></section><section class="panel metrics"><h3>{{ t('comparison.actionTypes') }}</h3><div v-if="comparison.differences.action_types.length" class="table-scroll" tabindex="0" :aria-label="t('comparison.actionTypes')"><table><caption>{{ t('comparison.actionTypesCaption') }}</caption><thead><tr><th scope="col">{{ t('comparison.actionType') }}</th><th scope="col">{{ t('runCaptures.left') }}</th><th scope="col">{{ t('runCaptures.right') }}</th><th scope="col">{{ t('comparison.difference') }}</th></tr></thead><tbody><tr v-for="row in comparison.differences.action_types" :key="row.action_type"><th scope="row">{{ row.action_type }}</th><td>{{ count(row.left) }}</td><td>{{ count(row.right) }}</td><td>{{ difference(row.difference) }}</td></tr></tbody></table></div><p v-else class="note">{{ t('comparison.noActionTypes') }}</p></section><p class="note">{{ t('runCaptures.comparedAt') }}: {{ comparison.generated_at }}</p></div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import RunCaptureObservation from '../components/RunCaptureObservation.vue'
import { getComparisonCandidates } from '../api/simulation'
import { previewRunCapture, saveRunCapture, getRunCaptures, getRunCapture, compareRunCaptures, recoverRunCaptureStore } from '../api/runCaptures'

const { t } = useI18n(), route = useRoute(), router = useRouter()
const sides = ['left', 'right'], platforms = ['twitter', 'reddit'], globalMetrics = ['recorded_actions', 'rounds_with_actions'], platformMetrics = ['recorded_actions', 'active_agents']
const terminalStatuses = ['completed', 'stopped', 'failed'], availabilityCodes = ['complete', 'partial', 'unavailable']
const statusCodes = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', ...terminalStatuses]
const errorCodes = ['invalid_capture_id', 'invalid_simulation_id', 'invalid_source_revision', 'invalid_capture_text', 'invalid_pagination', 'invalid_selection', 'simulation_active', 'run_not_terminal', 'simulation_not_found', 'simulation_unreadable', 'unsafe_path', 'sources_changed', 'capture_too_large', 'capture_not_found', 'capture_conflict', 'capture_limit_reached', 'unsafe_capture_path', 'capture_storage_invalid', 'capture_storage_busy', 'capture_storage_full', 'capture_storage_unavailable', 'invalid_request', 'capture_unavailable', 'capture_recovery_required']
const capturePattern = /^[a-f0-9]{32}$/, revisionPattern = /^[a-f0-9]{64}$/, simulationPattern = /^[A-Za-z0-9_-]{1,128}$/
const emptySelection = () => ({ simulation: '', left: '', right: '', capture: '', pending: '', offset: 0 })
const selected = ref(emptySelection()), routeError = ref(false)
const candidates = ref([]), candidatesLoading = ref(false), candidatesLoaded = ref(false), candidateError = ref(false), skippedRecords = ref(0)
const preview = ref(null), previewLoading = ref(false), previewError = ref(''), label = ref(''), note = ref('')
const catalogue = ref(null), listLoading = ref(false), listError = ref(''), detail = ref(null), detailLoading = ref(false), detailError = ref('')
const comparison = ref(null), comparisonLoading = ref(false), comparisonError = ref('')
const attempt = ref(null), savedCapture = ref(null), saveError = ref(''), retiredCaptureIds = ref([])
const recoveryIds = computed(() => [...new Set([selected.value.pending, ...retiredCaptureIds.value].filter(id => id && id !== attempt.value?.id && id !== savedCapture.value?.capture_id))])
let disposed = false, candidateRequest = null, previewRequest = null, listRequest = null, detailRequest = null, comparisonRequest = null, mutationRequest = null, reconciliationRequest = null
const recoveryLoading = ref(false), recoveryError = ref('')
const recoveryRequired = computed(() => [listError.value, detailError.value, comparisonError.value, previewError.value, saveError.value, attempt.value?.error].includes('capture_recovery_required'))
let recoveryRequest = null, observedRoutePath = null
let downloadUrl = null, pendingNavigation = null
const clone = value => JSON.parse(JSON.stringify(value))
const bounded = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max
const optionalCount = value => value === null || bounded(value)
const signedCount = value => value === null || Number.isSafeInteger(value)
const text = value => typeof value === 'string'
function validText(value, max, required = false, multiline = false) {
  return text(value) && [...value].length <= max && (!required || !!value.trim()) && !(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) && !(multiline ? /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u : /[\u0000-\u001F\u007F-\u009F]/u).test(value)
}
function validSummary(summary) {
  if (!summary || !simulationPattern.test(summary.simulation_id) || !terminalStatuses.includes(summary.status) || !availabilityCodes.includes(summary.availability) || !text(summary.scenario) || !Array.isArray(summary.warnings)) return false
  if (!['configured_model', 'configured_agents', 'requested_rounds', 'last_saved_round', 'created_at', 'updated_at', 'started_at', 'completed_at'].every(key => summary[key] === null || text(summary[key]))) return false
  if (!summary.warnings.every(warning => warning && text(warning.code) && (warning.count === undefined || bounded(warning.count)))) return false
  const metrics = summary.metrics
  return !!metrics && globalMetrics.every(key => optionalCount(metrics[key])) && platforms.every(platform => { const item = metrics.platforms?.[platform]; return !!item && availabilityCodes.includes(item.availability) && platformMetrics.every(key => optionalCount(item[key])) }) && Array.isArray(metrics.action_types) && metrics.action_types.every(row => row && text(row.action_type) && bounded(row.count)) && new Set(metrics.action_types.map(row => row.action_type)).size === metrics.action_types.length
}
function validPreview(value, simulation = null) { return !!value && value.schema_version === 1 && revisionPattern.test(value.source_revision) && text(value.observed_at) && validSummary(value.summary) && (!simulation || value.summary.simulation_id === simulation) }
function validCapture(value, id = null) { return !!value && value.schema_version === 1 && capturePattern.test(value.capture_id) && (!id || value.capture_id === id) && validText(value.label, 120, true) && validText(value.note, 2000, false, true) && text(value.captured_at) && validPreview(value.observation) }
function matchesAttempt(value, pending) { return validCapture(value, pending.id) && value.label === pending.payload.label && value.note === pending.payload.note && value.observation.summary.simulation_id === pending.payload.simulation_id && value.observation.source_revision === pending.payload.source_revision }
function validCatalogue(value, offset) {
  return !!value && value.offset === offset && value.limit === 20 && bounded(value.total, 500) && Array.isArray(value.captures) && value.captures.length <= 20 && value.captures.length <= Math.max(0, value.total - offset) && value.has_more === (offset + value.captures.length < value.total) && value.captures.every(item => item && capturePattern.test(item.capture_id) && simulationPattern.test(item.simulation_id) && validText(item.label, 120, true) && text(item.captured_at) && terminalStatuses.includes(item.status) && availabilityCodes.includes(item.availability)) && new Set(value.captures.map(item => item.capture_id)).size === value.captures.length
}
function validComparison(value, left, right) {
  const differences = value?.differences
  return value?.schema_version === 1 && validCapture(value.left, left) && validCapture(value.right, right) && text(value.generated_at) && !!differences && globalMetrics.every(key => signedCount(differences[key])) && platforms.every(platform => platformMetrics.every(key => signedCount(differences.platforms?.[platform]?.[key]))) && Array.isArray(differences.action_types) && differences.action_types.every(row => row && text(row.action_type) && optionalCount(row.left) && optionalCount(row.right) && signedCount(row.difference)) && new Set(differences.action_types.map(row => row.action_type)).size === differences.action_types.length
}
function parseSelection() {
  const value = emptySelection()
  for (const [key, item] of Object.entries(route.query)) {
    if (!Object.hasOwn(value, key) || typeof item !== 'string' || !item) throw new Error('Invalid selection')
    if (key === 'offset') { if (!/^\d{1,3}$/.test(item) || !bounded(Number(item), 500)) throw new Error('Invalid offset'); value.offset = Number(item) }
    else { if (!(key === 'simulation' ? simulationPattern : capturePattern).test(item)) throw new Error('Invalid ID'); value[key] = item }
  }
  return value
}
function revokeDownload() { if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null }
function retirePreview() { previewRequest?.controller.abort(); previewRequest = null; preview.value = null; previewLoading.value = false; previewError.value = ''; revokeDownload() }
function retireList() { listRequest?.controller.abort(); listRequest = null; catalogue.value = null; listLoading.value = false; listError.value = '' }
function retireDetail() { detailRequest?.controller.abort(); detailRequest = null; detail.value = null; detailLoading.value = false; detailError.value = ''; revokeDownload() }
function retireComparison() { comparisonRequest?.controller.abort(); comparisonRequest = null; comparison.value = null; comparisonLoading.value = false; comparisonError.value = ''; revokeDownload() }
function owns(request, active) { return !disposed && request === active && !request.controller.signal.aborted }
function errorCode(cause) { const code = cause?.response?.data?.error_code; return errorCodes.includes(code) ? code : 'generic' }
function errorText(code) { return t(`runCaptures.errors.${errorCodes.includes(code) || code === 'crypto_unavailable' ? code : 'generic'}`) }
function dataFrom(response) { if (!response?.success) throw { response: { data: response } }; return response.data }
async function loadCandidates() {
  candidateRequest?.controller.abort(); const request = { controller: new AbortController() }; candidateRequest = request; candidatesLoading.value = true; candidateError.value = false
  try { const data = dataFrom(await getComparisonCandidates(request.controller.signal)); if (!owns(request, candidateRequest)) return; if (!Array.isArray(data?.candidates)) throw new Error('Invalid candidates'); candidates.value = data.candidates; candidatesLoaded.value = true; skippedRecords.value = bounded(data.skipped_records) ? data.skipped_records : 0 }
  catch { if (owns(request, candidateRequest)) candidateError.value = true }
  finally { if (owns(request, candidateRequest)) candidatesLoading.value = false }
}
async function loadPreview() {
  if (disposed || routeError.value || !selected.value.simulation || attempt.value) return
  retirePreview(); saveError.value = ''; const request = { simulation: selected.value.simulation, controller: new AbortController() }; previewRequest = request; previewLoading.value = true
  try { const data = dataFrom(await previewRunCapture(request.simulation, request.controller.signal)); if (!owns(request, previewRequest)) return; if (!validPreview(data, request.simulation)) throw new Error('Invalid preview'); preview.value = clone(data) }
  catch (cause) { if (owns(request, previewRequest)) previewError.value = errorCode(cause) }
  finally { if (owns(request, previewRequest)) previewLoading.value = false }
}
async function loadLibrary() {
  retireList(); if (disposed || routeError.value) return
  const request = { offset: selected.value.offset, controller: new AbortController() }; listRequest = request; listLoading.value = true
  try { const data = dataFrom(await getRunCaptures({ offset: request.offset, limit: 20 }, request.controller.signal)); if (!owns(request, listRequest)) return; if (!validCatalogue(data, request.offset)) throw new Error('Invalid library'); catalogue.value = clone(data) }
  catch (cause) { if (owns(request, listRequest)) listError.value = errorCode(cause) }
  finally { if (owns(request, listRequest)) listLoading.value = false }
}
async function loadDetail() {
  retireDetail(); if (disposed || routeError.value || !selected.value.capture) return
  const request = { id: selected.value.capture, controller: new AbortController() }; detailRequest = request; detailLoading.value = true
  try { const data = dataFrom(await getRunCapture(request.id, request.controller.signal)); if (!owns(request, detailRequest)) return; if (!validCapture(data, request.id)) throw new Error('Invalid capture'); detail.value = clone(data) }
  catch (cause) { if (owns(request, detailRequest)) detailError.value = errorCode(cause) }
  finally { if (owns(request, detailRequest)) detailLoading.value = false }
}
const validPair = computed(() => !routeError.value && !!selected.value.left && !!selected.value.right && selected.value.left !== selected.value.right)
async function loadComparison() {
  retireComparison(); if (disposed || !validPair.value) return
  const request = { left: selected.value.left, right: selected.value.right, controller: new AbortController() }; comparisonRequest = request; comparisonLoading.value = true
  try { const data = dataFrom(await compareRunCaptures(request.left, request.right, request.controller.signal)); if (!owns(request, comparisonRequest)) return; if (!validComparison(data, request.left, request.right)) throw new Error('Invalid comparison'); comparison.value = clone(data) }
  catch (cause) { if (owns(request, comparisonRequest)) comparisonError.value = errorCode(cause) }
  finally { if (owns(request, comparisonRequest)) comparisonLoading.value = false }
}
function retireRecovery() { recoveryRequest?.controller.abort(); recoveryRequest = null; recoveryLoading.value = false; recoveryError.value = '' }
function refreshStorageReads() {
  if (disposed || routeError.value) return
  const retryPreview = previewError.value === 'capture_recovery_required'
  recoveryError.value = ''; loadLibrary(); loadDetail(); loadComparison()
  if (attempt.value && ['uncertain', 'checking'].includes(attempt.value.state)) {
    reconciliationRequest?.controller.abort(); reconciliationRequest = null
    reconcileAttempt(attempt.value)
  } else if (retryPreview) loadPreview()
}
async function recoverStore() {
  if (disposed || routeError.value || recoveryRequest || (!recoveryRequired.value && !recoveryError.value)) return
  const request = { path: route.fullPath, controller: new AbortController() }; recoveryRequest = request; recoveryLoading.value = true; recoveryError.value = ''
  try {
    const data = dataFrom(await recoverRunCaptureStore(request.controller.signal))
    if (!owns(request, recoveryRequest) || request.path !== route.fullPath) return
    if (!data || typeof data.recovered !== 'boolean' || Object.keys(data).length !== 1) throw new Error('Invalid recovery response')
    // Only this accepted explicit action refreshes the reads for this route.
    recoveryRequest = null; recoveryLoading.value = false; refreshStorageReads()
  } catch (cause) { if (owns(request, recoveryRequest)) recoveryError.value = errorCode(cause) }
  finally { if (recoveryRequest === request) { recoveryRequest = null; recoveryLoading.value = false } }
}
function retireAttempt() {
  if (attempt.value) retiredCaptureIds.value = [...new Set([...retiredCaptureIds.value, attempt.value.id])]
  mutationRequest?.controller.abort(); reconciliationRequest?.controller.abort(); mutationRequest = null; reconciliationRequest = null; attempt.value = null; savedCapture.value = null
}
function reconcileRoute() {
  let value
  try { value = parseSelection() } catch { retireAttempt(); routeError.value = true; selected.value = emptySelection(); retirePreview(); retireList(); retireDetail(); retireComparison(); return }
  routeError.value = false; const previous = selected.value; selected.value = value
  if (previous.simulation !== value.simulation) { retireAttempt(); retirePreview(); label.value = ''; note.value = ''; saveError.value = '' }
  if (previous.offset !== value.offset || !listRequest) loadLibrary()
  if (previous.capture !== value.capture || (!!value.capture && !detailRequest)) loadDetail()
  if (previous.left !== value.left || previous.right !== value.right || (validPair.value && !comparisonRequest)) loadComparison()
}
async function navigate(changes, replace = false) {
  if (disposed) return false
  if (Object.hasOwn(changes, 'simulation')) retirePreview()
  if (Object.hasOwn(changes, 'offset')) retireList()
  if (Object.hasOwn(changes, 'capture')) retireDetail()
  if (Object.hasOwn(changes, 'left') || Object.hasOwn(changes, 'right')) retireComparison()
  const query = { ...route.query, ...changes }; for (const key of Object.keys(query)) if (query[key] === '' || query[key] === undefined || (key === 'offset' && query[key] === 0)) delete query[key]
  const target = { name: 'RunCaptures', query }, navigation = { path: router.resolve(target).fullPath }; pendingNavigation = navigation
  try { await router[replace ? 'replace' : 'push'](target); if (disposed || pendingNavigation !== navigation) return false; if (route.fullPath !== navigation.path) return false; reconcileRoute(); return true }
  catch { if (!disposed && pendingNavigation === navigation) routeError.value = true; return false }
  finally { if (pendingNavigation === navigation) pendingNavigation = null }
}
function selectSimulation(value) { if (attempt.value) return; return navigate({ simulation: value }) }
function selectCapture(value) { return navigate({ capture: value }) }
function selectSide(side, value) { return navigate({ [side]: value }) }
function swap() { if (validPair.value) return navigate({ left: selected.value.right, right: selected.value.left }) }
function goPage(offset) { if (catalogue.value && bounded(offset, 500)) return navigate({ offset }) }
function editDraft(field, value) { if (attempt.value) return; if (field === 'label') label.value = value; else note.value = value; saveError.value = ''; revokeDownload() }
const textInvalid = computed(() => (!!label.value && !validText(label.value, 120, true)) || !validText(note.value, 2000, false, true))
const canSave = computed(() => !disposed && !routeError.value && !!preview.value && preview.value.summary.simulation_id === selected.value.simulation && !previewLoading.value && !attempt.value && validText(label.value, 120, true) && validText(note.value, 2000, false, true))
function newCaptureId() {
  const id = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
  if (!capturePattern.test(id ?? '')) throw new Error('Secure capture ID unavailable')
  return id
}
async function saveCapture() {
  if (!canSave.value) return
  let id; try { id = newCaptureId() } catch { saveError.value = 'crypto_unavailable'; return }
  const payload = Object.freeze({ simulation_id: preview.value.summary.simulation_id, source_revision: preview.value.source_revision, label: label.value, note: note.value })
  attempt.value = { id, payload, state: 'saving', error: '', retryAllowed: false }; savedCapture.value = null
  const pending = attempt.value
  // Persist only the recovery ID in the URL; notes remain in this mounted form.
  if (!await navigate({ pending: id }, true)) { if (!disposed && attempt.value === pending) { attempt.value = null; saveError.value = 'generic' }; return }
  await postAttempt(pending)
}
function ownsAttempt(pending) { return !disposed && attempt.value === pending }
function acceptCapture(pending, data) {
  if (!ownsAttempt(pending)) return
  savedCapture.value = clone(data); attempt.value = null; mutationRequest = null; reconciliationRequest = null; retirePreview(); saveError.value = ''; loadLibrary()
}
async function postAttempt(pending) {
  if (!ownsAttempt(pending) || mutationRequest || reconciliationRequest) return
  pending.state = 'saving'; pending.error = ''; pending.retryAllowed = false
  const request = { controller: new AbortController() }; mutationRequest = request
  try {
    const data = dataFrom(await saveRunCapture(pending.id, pending.payload, request.controller.signal))
    if (!ownsAttempt(pending) || !owns(request, mutationRequest)) return
    if (!matchesAttempt(data, pending)) throw new Error('Mismatched capture')
    acceptCapture(pending, data)
  } catch (cause) {
    if (!ownsAttempt(pending) || !owns(request, mutationRequest)) return
    mutationRequest = null
    const status = cause?.response?.status
    // A fixed 4xx rejection is definitive; an ambiguous transport/5xx response
    // might have committed. Lookup must settle before offering an explicit retry.
    if (status >= 400 && status < 500 && errorCodes.includes(cause?.response?.data?.error_code) && errorCode(cause) !== 'capture_conflict') {
      saveError.value = errorCode(cause); attempt.value = null; retirePreview(); return
    }
    pending.error = errorCode(cause); await reconcileAttempt(pending)
  } finally { if (mutationRequest === request) mutationRequest = null }
}
async function reconcileAttempt(pending) {
  if (!ownsAttempt(pending) || mutationRequest || reconciliationRequest) return
  pending.state = 'checking'; pending.retryAllowed = false; pending.error = ''
  const request = { controller: new AbortController() }; reconciliationRequest = request
  try {
    const data = dataFrom(await getRunCapture(pending.id, request.controller.signal))
    if (!ownsAttempt(pending) || !owns(request, reconciliationRequest)) return
    if (!matchesAttempt(data, pending)) { pending.state = 'uncertain'; pending.error = 'capture_conflict'; return }
    acceptCapture(pending, data)
  } catch (cause) {
    if (!ownsAttempt(pending) || !owns(request, reconciliationRequest)) return
    pending.state = 'uncertain'; pending.retryAllowed = cause?.response?.status === 404 && errorCode(cause) === 'capture_not_found'; pending.error = pending.retryAllowed ? '' : errorCode(cause)
  } finally { if (reconciliationRequest === request) reconciliationRequest = null }
}
function retrySave() { const pending = attempt.value; if (pending?.state === 'uncertain' && pending.retryAllowed) return postAttempt(pending) }
function downloadJson(value, filename) { revokeDownload(); downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json;charset=utf-8' })); const link = document.createElement('a'); link.href = downloadUrl; link.download = filename; document.body.appendChild(link); link.click(); link.remove() }
function downloadCapture() { if (detail.value && detailRequest && owns(detailRequest, detailRequest)) downloadJson(detail.value, 'mirofish-run-capture.json') }
function downloadComparison() { if (comparison.value && comparisonRequest && owns(comparisonRequest, comparisonRequest)) downloadJson(comparison.value, 'mirofish-run-capture-comparison.json') }
function statusLabel(value) { return t(`comparison.statuses.${statusCodes.includes(value) ? value : 'unknown'}`) }
function availabilityLabel(value) { return t(`comparison.availability.${availabilityCodes.includes(value) ? value : 'unavailable'}`) }
function candidateLabel(value) { return `${value.simulation_id} · ${value.scenario || t('comparison.notSaved')} · ${t('comparison.savedStatus')}: ${statusLabel(value.status)} · ${value.updated_at || value.created_at || '—'}` }
function count(value) { return bounded(value) ? String(value) : '—' }
function difference(value) { return Number.isSafeInteger(value) ? `${value > 0 ? '+' : ''}${value}` : '—' }
watch(() => route.fullPath, () => {
  if (observedRoutePath !== null && observedRoutePath !== route.fullPath) retireRecovery()
  observedRoutePath = route.fullPath; reconcileRoute()
}, { immediate: true, flush: 'sync' })
loadCandidates()
onBeforeUnmount(() => { disposed = true; retireRecovery(); candidateRequest?.controller.abort(); mutationRequest?.controller.abort(); reconciliationRequest?.controller.abort(); candidateRequest = null; mutationRequest = null; reconciliationRequest = null; pendingNavigation = null; retirePreview(); retireList(); retireDetail(); retireComparison() })
</script>

<style scoped>
.captures-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions { display: flex; align-items: center; gap: 24px; font-size: 14px; }a { color: #394555; }main { max-width: 1180px; margin: auto; padding: 38px 24px 60px; }.page-heading { max-width: 880px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 21px; margin: 0 0 14px; }h3 { font-size: 17px; overflow-wrap: anywhere; }p { line-height: 1.6; }.page-heading > p:last-child, .reading-note { color: #59616d; font-size: 14px; }.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 24px; }.draft-grid, .selection-grid, .capture-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }.draft-grid { margin-top: 24px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select, textarea { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 7px; padding: 10px; font: inherit; font-size: 14px; background: #fff; color: #202329; }textarea { resize: vertical; }.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled, input:disabled, textarea:disabled, select:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }.note { color: #68707c; font-size: 12px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.notice.error { background: #fff0ed; color: #9a3527; }.error-text { color: #9a3527; }.observation-preview, .saved-result { margin-top: 24px; border-top: 1px solid #e1e5eb; padding-top: 20px; }.saved-result { border-left: 3px solid #448367; padding-left: 18px; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; }.identity { font: 12px monospace; overflow-wrap: anywhere; color: #68707c; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }.section-heading .actions { margin-top: 0; }.library, .reader, .compare { margin-top: 38px; }.capture-card h3 { margin: 0; }dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }.pagination { margin-top: 22px; }.summaries, .metrics { margin-top: 24px; }.table-scroll { overflow-x: auto; }table { border-collapse: collapse; width: 100%; font-size: 14px; text-align: right; table-layout: fixed; min-width: 560px; }caption { text-align: left; color: #68707c; padding: 8px 0 16px; font-size: 12px; }th, td { border-bottom: 1px solid #e6e9ee; padding: 14px 10px; overflow-wrap: anywhere; }th:first-child { width: 40%; text-align: left; }th { font-weight: 600; }thead { color: #68707c; font-size: 12px; }td { font-variant-numeric: tabular-nums; }.platform-row { background: #f8f9fb; color: #68707c; font-size: 12px; }
@media (max-width: 720px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 26px 16px; }.draft-grid, .selection-grid, .capture-grid { grid-template-columns: 1fr; gap: 18px; }.panel { padding: 18px; }.section-heading { flex-direction: column; align-items: flex-start; } }
</style>
