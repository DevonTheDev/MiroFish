<template>
  <div class="interviews-page">
    <header class="app-header"><RouterLink class="brand" to="/">MIROFISH</RouterLink><div class="header-actions"><RouterLink to="/">{{ t('comparison.backHome') }}</RouterLink><LanguageSwitcher /></div></header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('comparison.eyebrow') }}</p><h1>{{ t(fileMode ? 'savedInterviewFiles.title' : 'savedInterviews.title') }}</h1><p v-if="!fileMode" class="simulation-id">{{ simulationId }}</p><p>{{ t(fileMode ? 'savedInterviewFiles.scope' : 'savedInterviews.scope') }}</p><p v-if="fileMode" class="note">{{ t('savedInterviewFiles.sessionNote') }}</p><RouterLink v-else to="/interview-files" data-testid="interviews-files-link">{{ t('savedInterviewFiles.entry') }}</RouterLink><p class="note">{{ t('savedInterviews.contextNote') }}</p></header>
      <form v-if="!fileMode" class="panel" data-testid="interviews-form" :aria-label="t('savedInterviews.filtersTitle')" :onSubmit="liveHandlers.apply">
        <div class="filter-grid">
          <div><label for="interviews-platform">{{ t('savedActivity.platform') }}</label><select id="interviews-platform" data-testid="interviews-platform" :value="draft.platform" :onChange="liveHandlers.platform"><option value="">{{ t('savedActivity.allPlatforms') }}</option><option v-for="platform in platforms" :key="platform" :value="platform">{{ t(`comparison.platforms.${platform}`) }}</option></select></div>
          <div><label for="interviews-agent-id">{{ t('savedActivity.agentId') }}</label><input id="interviews-agent-id" data-testid="interviews-agent-id" inputmode="numeric" :value="draft.agent_id" :placeholder="t('savedActivity.any')" aria-describedby="interviews-filter-note" :onInput="liveHandlers.agent"></div>
        </div>
        <p id="interviews-filter-note" class="note">{{ t('savedInterviews.filterNote') }}</p>
        <div class="actions"><button type="submit" class="primary" data-testid="interviews-apply" :onClick="liveHandlers.apply">{{ t('savedActivity.apply') }}</button><button type="button" data-testid="interviews-refresh" :onClick="liveHandlers.refresh">{{ t('savedActivity.refresh') }}</button><button type="button" data-testid="interviews-download" :disabled="!accepted" :onClick="downloadHandler(result)">{{ t('savedInterviews.download') }}</button></div>
      </form>
      <section v-else class="panel" aria-labelledby="interviews-file-heading">
        <h2 id="interviews-file-heading">{{ t('savedInterviewFiles.openTitle') }}</h2>
        <label for="interviews-file-input">{{ t('savedInterviewFiles.file') }}</label>
        <input id="interviews-file-input" data-testid="interviews-file-input" type="file" accept=".json,application/json" aria-describedby="interviews-file-hint" :onChange="fileHandlers.select">
        <p id="interviews-file-hint" class="note">{{ t('savedInterviewFiles.fileHint', { limit: fileLimitMiB }) }}</p>
        <p v-if="fileState.loading" data-testid="interviews-file-loading" role="status">{{ t('savedInterviewFiles.loading') }}</p>
        <p v-if="fileState.error" class="notice error" data-testid="interviews-file-error" role="alert">{{ t('savedInterviewFiles.invalid') }}</p>
        <div v-if="fileState.loading || fileState.preview || fileState.error" class="actions"><button type="button" data-testid="interviews-file-cancel" :onClick="fileHandlers.cancel">{{ t('savedInterviewFiles.cancel') }}</button></div>
        <section v-if="fileState.preview" data-testid="interviews-file-preview" class="file-preview" aria-labelledby="interviews-preview-heading">
          <h3 id="interviews-preview-heading">{{ t('savedInterviewFiles.preview') }}</h3>
          <p class="notice">{{ t('savedInterviewFiles.unverified') }}</p>
          <p class="literal">{{ t('savedInterviewFiles.filename') }}: {{ fileState.filename }}</p>
          <p class="simulation-id">{{ t('savedInterviewFiles.simulation') }}: {{ fileState.preview.simulation_id }}</p>
          <p>{{ recordedFilters(fileState.preview) }}</p><p>{{ t('savedInterviewFiles.observedAt', { time: fileState.preview.observed_at }) }}</p>
          <p>{{ t('savedInterviewFiles.recordCount', { count: fileState.preview.records.length }) }} · {{ t('savedInterviewFiles.availability', { status: t(`comparison.availability.${fileState.preview.availability}`) }) }}</p>
          <p>{{ t('savedInterviewFiles.limitsNote', { count: fileState.preview.limits.rows_per_platform, total: fileState.preview.limits.rows_total }) }}</p>
          <p v-for="platform in platforms" :key="platform">{{ t(`comparison.platforms.${platform}`) }}: {{ t(`savedInterviewFiles.statuses.${fileState.preview.sources[platform].status}`) }} · {{ t(`savedInterviewFiles.coverage.${fileState.preview.sources[platform].coverage}`) }} · {{ t('savedInterviewFiles.returned', { count: fileState.preview.sources[platform].returned_count }) }}</p>
          <div class="actions"><button type="button" class="primary" data-testid="interviews-file-open" :onClick="fileHandlers.open">{{ t('savedInterviewFiles.open') }}</button></div>
        </section>
        <div v-if="accepted" class="actions"><button type="button" data-testid="interviews-file-clear" :onClick="fileHandlers.clear">{{ t('savedInterviewFiles.clear') }}</button><button type="button" data-testid="interviews-download" :onClick="downloadHandler(result)">{{ t('savedInterviews.download') }}</button></div>
      </section>
      <p class="note">{{ t('savedInterviews.orderNote') }}</p><p class="note">{{ t('savedInterviews.downloadNote') }}</p>
      <p v-if="dirty" class="notice" role="status">{{ t('savedInterviews.draftNote') }}</p>
      <p v-if="loading" class="notice" data-testid="interviews-loading" role="status" aria-live="polite">{{ t('savedInterviews.loading') }}</p>
      <p v-if="error" class="notice error" data-testid="interviews-error" role="alert">{{ t(`savedInterviews.errors.${error}`) }}</p>
      <section v-if="accepted" data-testid="interviews-results" :aria-label="t('savedInterviews.resultsTitle')">
        <template v-if="fileMode"><p class="notice">{{ t('savedInterviewFiles.unverified') }}</p><p class="literal" data-testid="interviews-file-name">{{ t('savedInterviewFiles.filename') }}: {{ acceptedFile.filename }}</p><p class="simulation-id">{{ t('savedInterviewFiles.simulation') }}: {{ result.simulation_id }}</p><p>{{ recordedFilters(result) }}</p></template>
        <div class="summary-heading"><h2>{{ t(fileMode ? 'savedInterviewFiles.resultsTitle' : 'savedInterviews.resultsTitle') }}</h2><span class="availability" :class="result.availability" data-testid="interviews-availability">{{ fileMode ? t('savedInterviewFiles.availability', { status: t(`comparison.availability.${result.availability}`) }) : t(`comparison.availability.${result.availability}`) }}</span></div>
        <p class="note">{{ t(fileMode ? 'savedInterviewFiles.observedAt' : 'savedActivity.observedAt', { time: result.observed_at }) }}</p><p class="note">{{ t(fileMode ? 'savedInterviewFiles.limitsNote' : 'savedInterviews.limitsNote', { count: result.limits.rows_per_platform, total: result.limits.rows_total }) }}</p>
        <div class="actions" role="group" :aria-label="t('savedInterviews.reviewMode')">
          <button type="button" data-testid="interviews-records-mode" :aria-pressed="presentation.mode === 'records'" :onClick="modeHandler(result, presentation, 'records')">{{ t('savedInterviews.recordsMode') }}</button>
          <button type="button" data-testid="interviews-questions-mode" :aria-pressed="presentation.mode === 'questions'" :onClick="modeHandler(result, presentation, 'questions')">{{ t('savedInterviews.questionsMode') }}</button>
        </div>
        <section v-if="presentation.mode === 'questions'" class="panel question-review" :aria-label="t('savedInterviews.questionsMode')">
          <label for="interviews-question-select">{{ t('savedInterviews.selectQuestion') }}</label>
          <select id="interviews-question-select" data-testid="interviews-question-select" :value="presentation.key" :disabled="!questionIndex.groups.length" :onChange="questionHandler(result, presentation)">
            <option v-for="(group, index) in questionIndex.groups" :key="group.key" :value="group.key">{{ t('savedInterviews.questionOption', { number: index + 1, prompt: questionPreview(group.prompt), twitter: group.counts.twitter, reddit: group.counts.reddit }) }}</option>
          </select>
          <p class="note">{{ t('savedInterviews.questionNote') }}</p>
          <p v-if="questionIndex.ungroupedRecords.length" data-testid="interviews-question-ungrouped" class="notice">{{ t('savedInterviews.ungrouped', { count: questionIndex.ungroupedRecords.length }) }}</p>
          <template v-if="selectedQuestion"><h3>{{ t('savedInterviews.fullQuestion') }}</h3><pre data-testid="interviews-question-prompt">{{ selectedQuestion.prompt }}</pre><p v-if="selectedQuestion.prompt === ''" class="note">{{ t('savedInterviews.emptyQuestion') }}</p></template>
          <p v-else>{{ t('savedInterviews.noQuestions') }}</p>
        </section>
        <section v-for="platform in platforms" :key="platform" class="source-section" :data-testid="`interviews-source-${platform}`" :aria-label="t(`comparison.platforms.${platform}`)">
          <div class="panel source-summary"><h2>{{ t(`comparison.platforms.${platform}`) }}</h2><p>{{ t(`${fileMode ? 'savedInterviewFiles' : 'savedInterviews'}.statuses.${result.sources[platform].status}`) }} · {{ t(`${fileMode ? 'savedInterviewFiles' : 'savedInterviews'}.coverage.${result.sources[platform].coverage}`) }}</p><p>{{ t(fileMode ? 'savedInterviewFiles.returned' : 'savedInterviews.returned', { count: result.sources[platform].returned_count }) }}</p>
            <p v-if="result.sources[platform].has_more === true" class="notice">{{ t(fileMode ? 'savedInterviewFiles.moreAvailable' : 'savedInterviews.moreAvailable') }}</p><p v-else-if="result.sources[platform].has_more === null && result.sources[platform].status !== 'not_requested'" class="note">{{ t(fileMode ? 'savedInterviewFiles.unknownMore' : 'savedInterviews.unknownMore') }}</p>
            <p v-if="result.sources[platform].status === 'available' && result.sources[platform].returned_count === 0 && result.sources[platform].has_more === false">{{ t(fileMode ? 'savedInterviewFiles.empty' : 'savedInterviews.empty') }}</p>
            <ul v-if="result.sources[platform].warnings.length" class="warnings"><li v-for="warning in result.sources[platform].warnings" :key="warning">{{ t(`${fileMode ? 'savedInterviewFiles' : 'savedInterviews'}.warnings.${warning}`) }}</li></ul>
          </div>
          <p v-if="presentation.mode === 'questions' && selectedQuestion" :data-testid="`interviews-question-counts-${platform}`" class="note">{{ t('savedInterviews.questionCount', { count: selectedQuestion.counts[platform] }) }}</p>
          <article v-for="row in pageRows.filter(row => row.platform === platform)" :key="row.record_id" class="panel interview" :data-testid="`interview-row-${row.record_id}`">
            <h3>{{ row.agent_id === null ? t('savedInterviews.unknownAgent') : t('savedInterviews.agent', { id: row.agent_id }) }}</h3><p class="note record-id">{{ t('savedInterviews.row', { id: row.row_id }) }} · {{ row.timestamp === null ? t('savedInterviews.missingTimestamp') : row.timestamp === '' ? t('savedInterviews.emptyText') : row.timestamp }}</p>
            <template v-if="row.payload_kind === 'structured'"><h4>{{ t('savedInterviews.prompt') }}</h4><pre v-if="row.prompt !== null && row.prompt !== ''">{{ row.prompt }}</pre><p v-else class="note">{{ t(row.prompt === null ? 'savedInterviews.missingText' : 'savedInterviews.emptyText') }}</p><h4>{{ t('savedInterviews.response') }}</h4><pre v-if="row.response !== null && row.response !== ''">{{ row.response }}</pre><p v-else class="note">{{ t(row.response === null ? 'savedInterviews.missingText' : 'savedInterviews.emptyText') }}</p></template>
            <template v-else-if="row.payload_kind === 'raw'"><h4>{{ t('savedInterviews.rawPreview') }}</h4><pre v-if="row.raw_preview !== ''">{{ row.raw_preview }}</pre><p v-else class="note">{{ t('savedInterviews.emptyText') }}</p></template><p v-else>{{ t('savedInterviews.missingPayload') }}</p>
            <p v-if="row.truncated" class="notice">{{ t('savedInterviews.truncated') }}</p><ul v-if="row.warnings.length" class="warnings"><li v-for="warning in row.warnings" :key="warning">{{ t(`savedInterviews.warnings.${warning}`) }}</li></ul>
          </article>
        </section>
      </section>
      <nav class="actions pagination" :aria-label="t('savedInterviews.pagination')"><button type="button" data-testid="interviews-first" :disabled="!canPrevious" :onClick="pageHandler(result, presentation, 0)">{{ t('savedActivity.first') }}</button><button type="button" data-testid="interviews-previous" :disabled="!canPrevious" :onClick="pageHandler(result, presentation, pageIndex - 1)">{{ t('savedActivity.previous') }}</button><button type="button" data-testid="interviews-next" :disabled="!canNext" :onClick="pageHandler(result, presentation, pageIndex + 1)">{{ t('savedActivity.next') }}</button><p v-if="accepted" class="note">{{ t('savedInterviews.pagePosition', { page: pageIndex + 1, pages: pageCount }) }}</p></nav>
    </main>
  </div>
</template>

<script setup>
import { computed, ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { getSavedInterviews } from '../api/savedInterviews'
import { buildSavedInterviewQuestions } from '../utils/savedInterviewQuestions'
import { validSavedInterviewObservation as validResponse, validSavedInterviewDecimal as validDecimal, savedInterviewExactKeys as exactKeys } from '../utils/savedInterviewObservation.js'
import { SAVED_INTERVIEW_FILE_MAX_BYTES, readSavedInterviewFile } from '../utils/savedInterviewFiles.js'

const { t } = useI18n(), route = useRoute(), router = useRouter()
const platforms = ['twitter', 'reddit'], filterKeys = ['platform', 'agent_id'], pageSize = 25
const errorCodes = ['invalid_selection', 'invalid_filters', 'unsafe_path', 'interviews_unavailable', 'response_too_large']
const result = shallowRef(null), loading = ref(false), error = ref(''), dirty = ref(false)
const presentation = shallowRef({ mode: 'records', key: null, page: 0 })
const draft = ref({ platform: '', agent_id: '' })
const fileMode = computed(() => route.name === 'SavedInterviewFiles')
const revision = shallowRef({}), acceptedFile = shallowRef(null)
const emptyPending = () => ({ preview: null, filename: '', loading: false, error: '' })
const fileState = shallowRef(emptyPending())
const fileLimitMiB = SAVED_INTERVIEW_FILE_MAX_BYTES / (1024 * 1024)
const simulationId = computed(() => typeof route.params.simulationId === 'string' ? route.params.simulationId : '')
let disposed = false, activeRequest = null, pendingNavigation = null, activeDownload = null, downloadGeneration = 0

function fail(code) { throw { selectionCode: code } }
function filters(values) {
  const selected = Object.fromEntries(filterKeys.map(key => [key, values[key] === undefined || values[key] === '' ? null : values[key]]))
  if (selected.platform !== null && !platforms.includes(selected.platform) || selected.agent_id !== null && !validDecimal(selected.agent_id)) fail('invalid_filters')
  return selected
}
function selection() {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(simulationId.value)) fail('invalid_selection')
  for (const [key, value] of Object.entries(route.query)) if (!filterKeys.includes(key) || typeof value !== 'string' || value === '') fail('invalid_filters')
  return { simulation_id: simulationId.value, filters: filters(route.query) }
}
function requestParams(selected) { return Object.fromEntries(filterKeys.filter(key => selected.filters[key] !== null).map(key => [key, selected.filters[key]])) }
function disposeDownload(attempt) {
  if (!attempt) return
  if (activeDownload === attempt) activeDownload = null
  const anchor = attempt.anchor, url = attempt.url
  attempt.anchor = null; attempt.url = null
  try { anchor?.remove() } catch { /* cleanup must not replace a read or navigation error */ }
  if (url) { try { URL.revokeObjectURL(url) } catch { /* best-effort cleanup of this attempt only */ } }
}
function revokeDownload() { downloadGeneration++; disposeDownload(activeDownload) }
function rotateSession() {
  const next = {}; revision.value = next; revokeDownload(); return next
}
function retire() {
  const retired = rotateSession()
  if (revision.value !== retired) return null
  acceptedFile.value = null; fileState.value = emptyPending()
  if (pendingNavigation) pendingNavigation.retired = true
  activeRequest?.controller.abort(); activeRequest = null
  result.value = null; loading.value = false; error.value = ''
  presentation.value = { mode: 'records', key: null, page: 0 }
  return retired
}
function owns(request) { return !!request && !disposed && !fileMode.value && request.revision === revision.value && activeRequest === request && !request.controller.signal.aborted && !dirty.value && route.fullPath === request.path }
const accepted = computed(() => !disposed && !!result.value && (fileMode.value ? acceptedFile.value?.data === result.value : !loading.value && !dirty.value && !!activeRequest && owns(activeRequest)))
function syncDraft() { draft.value = Object.fromEntries(filterKeys.map(key => [key, typeof route.query[key] === 'string' ? route.query[key] : ''])); dirty.value = false }
async function load() {
  if (!retire()) return
  if (disposed || fileMode.value || dirty.value) return
  let selected
  try { selected = selection() } catch (cause) { error.value = cause.selectionCode; return }
  const request = { selected, revision: revision.value, path: route.fullPath, controller: new AbortController() }
  activeRequest = request; loading.value = true
  try {
    const response = await getSavedInterviews(selected.simulation_id, requestParams(selected), request.controller.signal)
    if (!owns(request)) return
    if (!exactKeys(response, ['success', 'data']) || response.success !== true || !validResponse(response.data, selected)) throw new Error('Invalid saved interview observation')
    result.value = response.data
  } catch (cause) {
    if (!owns(request)) return
    result.value = null
    const code = cause?.response?.data?.error_code
    error.value = errorCodes.includes(code) ? code : 'generic'
  } finally { if (owns(request)) loading.value = false }
}
function editDraft(key, value) {
  if (disposed || fileMode.value) return
  dirty.value = true; if (!retire()) return
  draft.value = { ...draft.value, [key]: value }
}
async function navigateSelected(selected) {
  if (disposed || fileMode.value) return
  const target = { name: 'SavedInterviews', params: { simulationId: selected.simulation_id }, query: requestParams(selected) }
  if (!retire()) return
  dirty.value = false
  const navigation = { path: router.resolve(target).fullPath, retired: false }; pendingNavigation = navigation
  try {
    // A same-URL Apply also supersedes any older guarded navigation.
    await router.push(target)
    if (disposed || pendingNavigation !== navigation || navigation.retired) return
    pendingNavigation = null
    if (route.fullPath !== navigation.path) { error.value = 'generic'; return }
    syncDraft(); await load()
  } catch { if (!disposed && pendingNavigation === navigation && !navigation.retired) error.value = 'generic' }
  finally { if (pendingNavigation === navigation) pendingNavigation = null }
}
function applyFilters() {
  if (disposed || fileMode.value || !retire()) return
  try { return navigateSelected({ simulation_id: simulationId.value, filters: filters(draft.value) }) }
  catch (cause) { error.value = cause.selectionCode ?? 'invalid_filters' }
}
function refresh() {
  if (disposed || fileMode.value) return
  try { return navigateSelected(selection()) }
  catch (cause) { if (retire()) error.value = cause.selectionCode ?? 'invalid_selection' }
}
// Capture the rendered route revision as well as its mode. Hidden controls
// alone cannot retire callbacks held across A → file → A navigation.
const liveHandlers = computed(() => {
  const owned = revision.value, path = route.fullPath
  const current = () => !disposed && !fileMode.value && route.name === 'SavedInterviews' && revision.value === owned && route.fullPath === path
  return {
    apply: event => { event.preventDefault(); if (current()) return applyFilters() },
    refresh: () => { if (current()) return refresh() },
    platform: event => { if (current()) editDraft('platform', event.target.value) },
    agent: event => { if (current()) editDraft('agent_id', event.target.value) },
  }
})
function ownsFile(owned) { return !disposed && fileMode.value && revision.value === owned }
function updateFile(owned, changes) {
  if (!ownsFile(owned)) return null
  const next = rotateSession()
  // URL cleanup can synchronously retire this route/session. Never publish
  // the earlier callback's pending or accepted state after that retirement.
  if (!ownsFile(next)) return null
  error.value = ''; fileState.value = { ...fileState.value, ...changes }
  return next
}
async function selectFile(owned, event) {
  if (!ownsFile(owned)) return
  // Native FileList is live: capture it before resetting for same-file selection.
  const count = event.target.files?.length ?? 0, file = event.target.files?.[0]
  event.target.value = ''
  const reading = updateFile(owned, { ...emptyPending(), loading: count > 0 })
  if (!reading || !ownsFile(reading) || !count) return
  try {
    if (count !== 1 || typeof file?.name !== 'string' || !file.name || file.name.length > 1024 || [...file.name].length > 512 || new TextEncoder().encode(file.name).length > 2048) throw new Error('Invalid filename')
    const filename = file.name, preview = await readSavedInterviewFile(file)
    updateFile(reading, { ...emptyPending(), filename, preview })
  } catch { updateFile(reading, { ...emptyPending(), error: 'invalid' }) }
}
const fileHandlers = computed(() => {
  const owned = revision.value, pending = fileState.value
  return {
    select: event => selectFile(owned, event),
    cancel: () => updateFile(owned, emptyPending()),
    open: () => {
      if (!ownsFile(owned) || !pending.preview || fileState.value !== pending) return
      if (!updateFile(owned, emptyPending())) return
      acceptedFile.value = { filename: pending.filename, data: pending.preview }; result.value = pending.preview
      presentation.value = { mode: 'records', key: null, page: 0 }
    },
    clear: () => {
      if (!ownsFile(owned)) return
      if (!updateFile(owned, emptyPending())) return
      acceptedFile.value = null; result.value = null
      presentation.value = { mode: 'records', key: null, page: 0 }
    },
  }
})
function recordedFilters(data) {
  return t('savedInterviewFiles.filters', { platform: data.filters.platform === null ? t('savedActivity.allPlatforms') : t(`comparison.platforms.${data.filters.platform}`), agent: data.filters.agent_id === null ? t('savedActivity.any') : data.filters.agent_id })
}
const questionIndex = computed(() => accepted.value ? buildSavedInterviewQuestions(result.value) : { groups: [], ungroupedRecords: [] })
const selectedQuestion = computed(() => questionIndex.value.groups.find(group => group.key === presentation.value.key) ?? null)
const visibleRows = computed(() => !accepted.value ? [] : presentation.value.mode === 'questions' ? selectedQuestion.value?.records ?? [] : result.value.records)
const pageIndex = computed(() => presentation.value.page)
const pageCount = computed(() => Math.max(1, Math.ceil(visibleRows.value.length / pageSize)))
const pageRows = computed(() => visibleRows.value.slice(pageIndex.value * pageSize, (pageIndex.value + 1) * pageSize))
const canPrevious = computed(() => accepted.value && pageIndex.value > 0)
const canNext = computed(() => accepted.value && pageIndex.value + 1 < pageCount.value)
function questionPreview(prompt) {
  if (prompt === '') return t('savedInterviews.emptyQuestion')
  const characters = [...prompt]
  return characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '')
}
// A rendered handler owns the precise observation, request and presentation.
// Replacing the view even on local page/group changes retires retained handlers;
// an old group key must never address a newer observation's same-index group.
function observationOwner(saved) {
  const owned = revision.value, request = activeRequest, path = route.fullPath, local = fileMode.value
  return () => !disposed && revision.value === owned && route.fullPath === path && fileMode.value === local && !!saved && result.value === saved && accepted.value && (local || activeRequest === request && owns(request))
}
function viewOwner(saved, view) {
  const current = observationOwner(saved)
  return () => current() && presentation.value === view
}
function modeHandler(saved, view, mode) {
  const current = viewOwner(saved, view)
  return () => {
    if (!current() || !['records', 'questions'].includes(mode)) return
    presentation.value = { mode, key: mode === 'questions' ? questionIndex.value.groups[0]?.key ?? null : null, page: 0 }
  }
}
function questionHandler(saved, view) {
  const current = viewOwner(saved, view)
  return event => {
    if (!current() || view.mode !== 'questions') return
    const key = event.target.value
    if (questionIndex.value.groups.some(group => group.key === key)) presentation.value = { mode: 'questions', key, page: 0 }
  }
}
function pageHandler(saved, view, index) {
  const current = viewOwner(saved, view)
  return () => {
    if (current() && Number.isInteger(index) && index >= 0 && index < pageCount.value) presentation.value = { ...view, page: index }
  }
}
function downloadHandler(saved) {
  const ownsSaved = observationOwner(saved)
  return () => {
    if (!ownsSaved()) return
    const generation = downloadGeneration + 1
    revokeDownload()
    // Revoking the previous URL may start a newer attempt synchronously.
    if (downloadGeneration !== generation || !ownsSaved()) return
    const attempt = { url: null, anchor: null }
    activeDownload = attempt; error.value = ''
    const current = () => activeDownload === attempt && downloadGeneration === generation && ownsSaved()
    let finished = false
    try {
      const blob = new Blob([JSON.stringify(saved, null, 2) + '\n'], { type: 'application/json;charset=utf-8' })
      if (!current()) return
      attempt.url = URL.createObjectURL(blob)
      if (!current()) return
      attempt.anchor = document.createElement('a')
      if (!current()) return
      attempt.anchor.href = attempt.url; attempt.anchor.download = `${saved.simulation_id}-saved-interviews.json`
      document.body.appendChild(attempt.anchor)
      if (!current()) return
      attempt.anchor.click()
      if (!current()) return
      attempt.anchor.remove(); attempt.anchor = null; finished = true
    } catch {
      const report = current()
      disposeDownload(attempt)
      if (report && downloadGeneration === generation && ownsSaved()) error.value = 'download'
    } finally {
      if (!finished) disposeDownload(attempt)
    }
  }
}

watch(() => route.fullPath, () => {
  const navigation = pendingNavigation; pendingNavigation = null
  if (navigation?.path === route.fullPath && navigation.retired) return
  if (!retire()) return
  syncDraft(); if (!fileMode.value) load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; retire(); pendingNavigation = null })
</script>

<style scoped>
.interviews-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions { display: flex; align-items: center; gap: 24px; font-size: 14px; }a { color: #394555; }
main { max-width: 1060px; margin: 0 auto; padding: 36px 24px 60px; }.page-heading { max-width: 900px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 19px; margin: 0; }h3 { font-size: 17px; margin: 0; overflow-wrap: anywhere; }h4 { font-size: 14px; margin-bottom: 10px; }p { line-height: 1.6; }.simulation-id, .record-id { font-family: monospace; overflow-wrap: anywhere; }
.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; }.filter-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; background: #fff; color: #202329; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 13px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.notice.error { background: #fff0ed; color: #9a3527; }.summary-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 28px; }.availability { border-radius: 20px; padding: 5px 10px; background: #eff2f5; font-size: 12px; }.availability.partial, .warnings { background: #fff3d9; color: #805518; }.source-section { margin-top: 24px; }.source-summary { border-left: 4px solid #b6c5d8; }.interview { margin-top: 14px; }.warnings { padding: 14px 14px 14px 32px; font-size: 13px; border-radius: 7px; line-height: 1.7; }pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.65 monospace; max-height: 420px; overflow-y: auto; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; }.file-preview { border-top: 1px solid #e1e5eb; margin-top: 22px; padding-top: 22px; }.pagination { margin-top: 24px; }.question-review { margin-top: 18px; }button[aria-pressed="true"] { background: #e0e9f5; border-color: #5b7a9f; }
@media (max-width: 540px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 24px 14px; }.filter-grid { grid-template-columns: 1fr; }.panel { padding: 16px; }.summary-heading { align-items: flex-start; flex-direction: column; } }
</style>
