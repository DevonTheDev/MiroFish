<template>
  <div class="reports-page">
    <header class="app-header">
      <RouterLink to="/" class="brand">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink to="/report-files" data-testid="open-report-files">{{ t('savedReportFiles.entry') }}</RouterLink><RouterLink to="/">{{ t('savedReports.home') }}</RouterLink><LanguageSwitcher /></div>
    </header>
    <main>
      <div class="page-heading"><p class="eyebrow">{{ t('savedReports.eyebrow') }}</p><h1>{{ t('savedReports.title') }}</h1><p>{{ t('savedReports.scope') }}</p></div>
      <form class="panel" data-testid="report-library-form" @submit.prevent="applyFilters">
        <div class="filters">
          <div><label for="report-query">{{ t('savedReports.search') }}</label><input id="report-query" data-testid="search-phrase" type="text" :value="draft.q" @input="editDraft('q', $event.target.value)" :aria-describedby="'report-search-note'" /></div>
          <div><label for="report-status">{{ t('savedReports.status') }}</label><select id="report-status" data-testid="status" :value="draft.status" @change="editDraft('status', $event.target.value)"><option value="">{{ t('savedReports.allStatuses') }}</option><option v-for="status in statuses" :key="status" :value="status">{{ t(`savedReports.statuses.${status}`) }}</option></select></div>
          <div><label for="report-limit">{{ t('savedReports.pageSize') }}</label><select id="report-limit" data-testid="page-size" :value="draft.limit" @change="editDraft('limit', $event.target.value)"><option v-for="size in pageSizes" :key="size" :value="String(size)">{{ size }}</option></select></div>
        </div>
        <p id="report-search-note" class="note">{{ t('savedReports.searchNote') }}</p>
        <div class="actions"><button class="primary" type="submit" data-testid="apply">{{ t('savedReports.apply') }}</button><button type="button" data-testid="refresh" @click="refresh">{{ t('savedReports.refresh') }}</button></div>
      </form>
      <p v-if="dirty" class="notice" data-testid="draft-note">{{ t('savedReports.draftNote') }}</p>
      <p v-if="error" role="alert" class="notice error" data-testid="error">{{ t(`savedReports.errors.${error}`) }}</p>
      <p v-if="loading" role="status" data-testid="loading">{{ t('savedReports.loading') }}</p>
      <section v-if="result" data-testid="results" :aria-label="t('savedReports.resultsTitle')">
        <div class="page-summary"><h2>{{ t('savedReports.resultsTitle') }}</h2><p data-testid="matched-count">{{ t('savedReports.count', { matched: result.matched_count, shown: result.returned_count }) }}</p></div>
        <p class="note">{{ t('savedReports.observedAt') }}: {{ result.observed_at }}</p>
        <p class="note fingerprint">{{ t('savedReports.catalogueRevision') }}: {{ result.source_revision }}</p>
        <div v-if="result.unavailable_count" class="notice warning" data-testid="unavailable"><p>{{ t('savedReports.unavailable', { count: result.unavailable_count }) }}</p><ul><li v-for="reason in result.unavailable_reasons" :key="reason.code">{{ t(`savedReports.reasons.${reason.code}`, { count: reason.count }) }}</li></ul></div>
        <div class="report-grid">
          <article v-for="report in result.reports" :key="report.report_id" class="panel report-card" :data-testid="`report-row-${report.report_id}`">
            <div class="card-heading"><h3>{{ report.title || t('savedReports.untitled') }}</h3><span class="status">{{ t(`savedReports.statuses.${report.status}`) }}</span></div>
            <dl><dt>{{ t('savedReports.reportId') }}</dt><dd>{{ report.report_id }}</dd><dt>{{ t('savedReports.simulationId') }}</dt><dd>{{ report.simulation_id ?? '—' }}</dd><dt>{{ t('savedReports.createdAt') }}</dt><dd>{{ report.created_at ?? '—' }}</dd><dt>{{ t('savedReports.source') }}</dt><dd>{{ t(`savedReports.sources.${report.source}`) }}</dd></dl>
            <p class="note">{{ t('savedReports.summaryPreview') }}</p><p class="preview">{{ report.summary_preview || '—' }}</p>
            <p class="note">{{ t('savedReports.requirementPreview') }}</p><p class="preview">{{ report.requirement_preview || '—' }}</p>
            <button type="button" :data-testid="`open-${report.report_id}`" :disabled="loading || dirty" @click="openReport(report)">{{ t('savedReports.open') }}</button>
          </article>
        </div>
        <p v-if="!result.reports.length" class="notice" data-testid="empty-state">{{ t(`savedReports.${result.matched_count ? 'outOfRange' : 'noMatches'}`) }}</p>
      </section>
      <nav class="actions pagination" :aria-label="t('savedReports.pagination')"><button type="button" data-testid="first" :disabled="!canPrevious" @click="goPage(0)">{{ t('savedReports.first') }}</button><button type="button" data-testid="previous" :disabled="!canPrevious" @click="goPage(Math.max(0, result.offset - result.limit))">{{ t('savedReports.previous') }}</button><button type="button" data-testid="next" :disabled="!canNext" @click="goPage(result.offset + result.limit)">{{ t('savedReports.next') }}</button></nav>
      <section class="reader-section" :aria-label="t('savedReports.readerTitle')">
        <div class="reader-heading"><h2>{{ t('savedReports.readerTitle') }}</h2><div class="actions"><button type="button" data-testid="download" :disabled="!canDownload" :onClick="downloadActions.markdown">{{ t('savedReports.download') }}</button><button type="button" data-testid="download-observation" :disabled="!savedReport || detailLoading || dirty" :onClick="downloadActions.json">{{ t('savedReportFiles.download') }}</button><button v-if="selectedReportId" type="button" data-testid="close-reader" @click="closeReader">{{ t('savedReports.close') }}</button></div></div>
        <p class="note">{{ t('savedReports.readerNote') }}</p>
        <p v-if="downloadError" role="alert" class="notice error" data-testid="download-error">{{ t('savedReportFiles.downloadError') }}</p>
        <p v-if="detailLoading" role="status" data-testid="detail-loading">{{ t('savedReports.reading') }}</p>
        <p v-if="detailError" role="alert" class="notice error" data-testid="detail-error">{{ t(`savedReports.errors.${detailError}`) }}</p>
        <article v-if="savedReport" class="panel" data-testid="reader">
          <h3>{{ savedReport.title || t('savedReports.untitled') }}</h3>
          <dl><dt>{{ t('savedReports.reportId') }}</dt><dd>{{ savedReport.report_id }}</dd><dt>{{ t('savedReports.status') }}</dt><dd>{{ t(`savedReports.statuses.${savedReport.status}`) }}</dd><dt>{{ t('savedReports.capturedAt') }}</dt><dd>{{ savedReport.observed_at }}</dd><dt>{{ t('savedReports.metadataRevision') }}</dt><dd>{{ savedReport.metadata_revision }}</dd><dt>{{ t('savedReports.contentSource') }}</dt><dd>{{ savedReport.content_source ? t(`savedReports.contentSources.${savedReport.content_source.replace('.', '_')}`) : '—' }}</dd><dt>{{ t('savedReports.contentBytes') }}</dt><dd>{{ savedReport.content_bytes ?? '—' }}</dd><dt>{{ t('savedReports.contentRevision') }}</dt><dd>{{ savedReport.content_revision ?? '—' }}</dd></dl>
          <p v-if="!savedReport.content_available" role="status" class="notice warning" data-testid="content-error">{{ t(`savedReports.contentErrors.${savedReport.content_error}`) }}</p>
          <SavedReportReader :source="savedReport" :is-current="isCurrentComparisonSource" />
        </article>
        <p v-else-if="!detailLoading && !detailError" class="note">{{ t('savedReports.chooseReport') }}</p>
      </section>
      <SavedReportComparison :source="savedReport" :is-current="isCurrentComparisonSource" :is-active="isActiveComparison" />
    </main>
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import SavedReportComparison from '../components/SavedReportComparison.vue'
import SavedReportReader from '../components/SavedReportReader.vue'
import { getSavedReports, getSavedReport } from '../api/report'
import { validSavedReportSummary, validSavedReportObservation } from '../utils/savedReportObservation.js'
import { createSavedReportFile } from '../utils/savedReportFiles.js'

const { t } = useI18n()
const route = useRoute(), router = useRouter()
const statuses = ['pending', 'planning', 'generating', 'completed', 'failed']
const queryKeys = ['q', 'status', 'offset', 'limit', 'revision', 'report_id', 'metadata_revision']
const errorCodes = ['invalid_query', 'invalid_report_id', 'report_not_found', 'metadata_unavailable', 'sources_changed', 'catalogue_too_large', 'response_too_large', 'library_unavailable']
const reasonCodes = ['metadata_unreadable', 'metadata_too_large', 'identity_mismatch', 'unsafe_path']
const revisionPattern = /^[a-f0-9]{64}$/, idPattern = /^[A-Za-z0-9_-]{1,128}$/
const result = ref(null), savedReport = ref(null), loading = ref(false), detailLoading = ref(false)
const downloadError = ref(false)
const error = ref(''), detailError = ref(''), dirty = ref(false), selectedReportId = ref(null)
const draft = ref({ q: '', status: '', limit: '20' })
const pageSizes = computed(() => [...new Set([1, 10, 20, 50, Number(draft.value.limit)].filter(value => Number.isInteger(value) && value >= 1 && value <= 50))].sort((a, b) => a - b))
let disposed = false, activeList = null, activeDetail = null, currentListKey = null, currentDetailKey = null
let pendingNavigation = null, downloadResource = null

function invalid() { throw { selectionCode: 'invalid_query' } }
function pageNumber(value, fallback, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[0-9]{1,64}$/.test(value)) invalid()
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) invalid()
  return number
}
function filters(values) {
  // Match Python's whitespace trim, preserving U+FEFF as literal query text.
  const q = values.q === undefined ? null : values.q.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '') || null
  if (q !== null && [...q].length > 200) invalid()
  const status = values.status === undefined ? null : values.status
  if (status !== null && !statuses.includes(status)) invalid()
  return { q, status }
}
function selection() {
  for (const [key, value] of Object.entries(route.query)) if (!queryKeys.includes(key) || typeof value !== 'string' || (value === '' && key !== 'q')) invalid()
  const selected = { filters: filters(route.query), offset: pageNumber(route.query.offset, 0, 0, 2000), limit: pageNumber(route.query.limit, 20, 1, 50), revision: route.query.revision ?? null, report_id: route.query.report_id ?? null, metadata_revision: route.query.metadata_revision ?? null }
  if (selected.revision !== null && !revisionPattern.test(selected.revision)) invalid()
  if (selected.offset > 0 && !selected.revision) invalid()
  if (selected.report_id !== null && !idPattern.test(selected.report_id)) invalid()
  if (selected.metadata_revision !== null && (!selected.report_id || !revisionPattern.test(selected.metadata_revision))) invalid()
  return selected
}
function listParams(selected) {
  return { ...(selected.filters.q !== null ? { q: selected.filters.q } : {}), ...(selected.filters.status !== null ? { status: selected.filters.status } : {}), offset: selected.offset, limit: selected.limit, ...(selected.revision ? { revision: selected.revision } : {}) }
}
function listKey(selected) { return JSON.stringify(listParams(selected)) }
function detailKey(selected) { return JSON.stringify([selected.report_id, selected.metadata_revision]) }
function queryFor(selected) { return { ...listParams(selected), ...(selected.report_id ? { report_id: selected.report_id } : {}), ...(selected.metadata_revision ? { metadata_revision: selected.metadata_revision } : {}) } }
function revokeDownload(current = downloadResource) {
  if (!current) return
  if (downloadResource === current) downloadResource = null
  const link = current.link, url = current.url
  current.link = null; current.url = null
  try { link?.remove() } catch { /* Still release this operation's URL. */ }
  try { if (url) URL.revokeObjectURL(url) } catch { /* Never disturb a newer owner. */ }
}
function retireList() { activeList?.controller.abort(); activeList = null; result.value = null; loading.value = false; error.value = '' }
function retireDetail() { activeDetail?.controller.abort(); activeDetail = null; savedReport.value = null; detailLoading.value = false; detailError.value = ''; downloadError.value = false; revokeDownload() }
function retireAll() { if (pendingNavigation) pendingNavigation.retired = true; retireList(); retireDetail() }
function ownsList(request) { return !disposed && !dirty.value && activeList === request && !request.controller.signal.aborted }
function ownsDetail(request) { return !disposed && !dirty.value && activeDetail === request && !request.controller.signal.aborted }
function errorCode(cause) { const code = cause?.response?.data?.error_code; return errorCodes.includes(code) ? code : 'generic' }
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max
function validCatalogue(data, selected) {
  if (!data || typeof data.source_revision !== 'string' || !revisionPattern.test(data.source_revision) || (selected.revision && data.source_revision !== selected.revision) || typeof data.observed_at !== 'string' || data.offset !== selected.offset || data.limit !== selected.limit) return false
  if (!data.filters || Object.keys(data.filters).length !== 2 || data.filters.q !== selected.filters.q || data.filters.status !== selected.filters.status) return false
  if (!Array.isArray(data.reports) || !bounded(data.matched_count, 2000) || !bounded(data.returned_count, selected.limit) || data.returned_count !== data.reports.length || data.returned_count > Math.max(0, data.matched_count - data.offset) || data.has_more !== (data.offset + data.returned_count < data.matched_count)) return false
  if (!bounded(data.unavailable_count, 2000) || !Array.isArray(data.unavailable_reasons) || data.unavailable_reasons.some(reason => !reasonCodes.includes(reason?.code) || !bounded(reason.count, 2000) || !reason.count) || new Set(data.unavailable_reasons.map(reason => reason.code)).size !== data.unavailable_reasons.length || data.unavailable_reasons.reduce((sum, reason) => sum + reason.count, 0) !== data.unavailable_count) return false
  const ids = new Set()
  return data.reports.every(report => { if (!validSavedReportSummary(report) || ids.has(report.report_id) || (selected.filters.status && report.status !== selected.filters.status)) return false; ids.add(report.report_id); return true })
}
async function loadList(selected) {
  retireList()
  const request = { selected, controller: new AbortController() }; activeList = request; loading.value = true
  try {
    const response = await getSavedReports(listParams(selected), request.controller.signal)
    if (!ownsList(request)) return
    if (!response?.success) throw { response: { data: response } }
    if (!validCatalogue(response.data, selected)) throw new Error('Invalid saved report catalogue')
    result.value = JSON.parse(JSON.stringify(response.data))
    // A read never navigates: a late response must not cancel a newer router
    // navigation. Explicit page/open actions pin the accepted catalogue hash.
  } catch (cause) { if (ownsList(request)) { result.value = null; error.value = errorCode(cause) } }
  finally { if (ownsList(request)) loading.value = false }
}
async function loadDetail(selected) {
  retireDetail()
  if (!selected.report_id) return
  const request = { selected, controller: new AbortController() }; activeDetail = request; detailLoading.value = true
  try {
    const response = await getSavedReport(selected.report_id, selected.metadata_revision ? { revision: selected.metadata_revision } : {}, request.controller.signal)
    if (!ownsDetail(request)) return
    if (!response?.success) throw { response: { data: response } }
    if (!validSavedReportObservation(response.data, selected)) throw new Error('Invalid saved report content')
    savedReport.value = JSON.parse(JSON.stringify(response.data))
  } catch (cause) { if (ownsDetail(request)) { savedReport.value = null; detailError.value = errorCode(cause) } }
  finally { if (ownsDetail(request)) detailLoading.value = false }
}
function reconcile(force = false) {
  let selected
  try { selected = selection() } catch { retireAll(); currentListKey = null; currentDetailKey = null; selectedReportId.value = null; dirty.value = false; error.value = 'invalid_query'; return }
  const nextListKey = listKey(selected), nextDetailKey = detailKey(selected)
  const pinsAcceptedCatalogue = result.value && activeList && selected.revision === result.value.source_revision && listKey({ ...selected, revision: null }) === listKey({ ...activeList.selected, revision: null })
  const listChanged = force || (currentListKey !== nextListKey && !pinsAcceptedCatalogue) || !activeList
  const detailChanged = force || listChanged || currentDetailKey !== nextDetailKey || (!!selected.report_id && !activeDetail)
  draft.value = { q: selected.filters.q ?? '', status: selected.filters.status ?? '', limit: String(selected.limit) }; dirty.value = false
  currentListKey = nextListKey; currentDetailKey = nextDetailKey; selectedReportId.value = selected.report_id
  if (listChanged) loadList(selected)
  if (detailChanged) loadDetail(selected)
}
function editDraft(key, value) { dirty.value = true; retireAll(); draft.value = { ...draft.value, [key]: value } }
async function navigateSelected(selected, { keepList = false } = {}) {
  const target = { name: 'SavedReports', query: queryFor(selected) }
  if (keepList) retireDetail(); else retireAll()
  dirty.value = false
  const navigation = { path: router.resolve(target).fullPath, retired: false }; pendingNavigation = navigation
  try {
    await router.push(target)
    if (disposed || pendingNavigation !== navigation || navigation.retired) return
    pendingNavigation = null
    if (route.fullPath !== navigation.path) { error.value = 'generic'; return }
    reconcile(!keepList)
  } catch { if (!disposed && pendingNavigation === navigation && !navigation.retired) error.value = 'generic' }
  finally { if (pendingNavigation === navigation) pendingNavigation = null }
}
function applyFilters() {
  retireAll()
  try { return navigateSelected({ filters: filters({ q: draft.value.q, ...(draft.value.status ? { status: draft.value.status } : {}) }), offset: 0, limit: pageNumber(draft.value.limit, 20, 1, 50), revision: null, report_id: null, metadata_revision: null }) }
  catch { error.value = 'invalid_query' }
}
function refresh() {
  // Refresh always starts a fresh catalogue and clears the saved selection.
  return applyFilters()
}
const canPrevious = computed(() => !!result.value && !dirty.value && !loading.value && result.value.offset > 0)
const canNext = computed(() => !!result.value && !dirty.value && !loading.value && result.value.has_more && result.value.offset + result.value.limit <= 2000)
function goPage(offset) {
  if (!result.value || dirty.value || loading.value) return
  return navigateSelected({ filters: result.value.filters, offset, limit: result.value.limit, revision: result.value.source_revision, report_id: null, metadata_revision: null })
}
function openReport(report) {
  if (!result.value || dirty.value || loading.value || !activeList || !ownsList(activeList)) return
  return navigateSelected({ filters: result.value.filters, offset: result.value.offset, limit: result.value.limit, revision: result.value.source_revision, report_id: report.report_id, metadata_revision: report.metadata_revision }, { keepList: true })
}
function closeReader() {
  if (dirty.value) { retireDetail(); selectedReportId.value = null; return }
  try { return navigateSelected({ ...selection(), report_id: null, metadata_revision: null }, { keepList: true }) } catch { retireDetail() }
}
function isCurrentComparisonSource(source) { return source === savedReport.value && !!activeDetail && ownsDetail(activeDetail) && !detailLoading.value }
function isActiveComparison() { return !disposed && route.name === 'SavedReports' }
const canDownload = computed(() => !!savedReport.value?.content_available && !dirty.value && !detailLoading.value)
function downloadReport(saved, request, markdown) {
  const owns = () => saved && savedReport.value === saved && activeDetail === request && ownsDetail(request) && !detailLoading.value
  if (!owns() || (markdown && !saved.content_available)) return
  const previous = downloadResource, current = { url: null, link: null }
  downloadResource = current; revokeDownload(previous)
  const currentOwner = () => owns() && downloadResource === current
  try {
    if (!currentOwner()) return
    downloadError.value = false
    const body = markdown ? saved.markdown_content : createSavedReportFile(saved)
    current.url = URL.createObjectURL(new Blob([body], { type: markdown ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8' }))
    if (!currentOwner()) return
    current.link = document.createElement('a')
    if (!currentOwner()) return
    current.link.href = current.url; current.link.download = markdown ? `${saved.report_id}.md` : `${saved.report_id}.observation.json`
    document.body.appendChild(current.link)
    if (!currentOwner()) return
    current.link.click()
    if (!currentOwner()) return
    const link = current.link; current.link = null; link.remove()
  } catch { if (currentOwner()) downloadError.value = true; revokeDownload(current) }
  finally { if (!currentOwner()) revokeDownload(current) }
}
const downloadActions = computed(() => {
  const saved = savedReport.value, request = activeDetail
  return { markdown: () => downloadReport(saved, request, true), json: () => downloadReport(saved, request, false) }
})
watch(() => route.fullPath, () => {
  const navigation = pendingNavigation; pendingNavigation = null
  if (navigation?.path === route.fullPath && navigation.retired) return
  reconcile()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; retireAll(); pendingNavigation = null })
</script>

<style scoped>
.reports-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions { display: flex; align-items: center; gap: 24px; font-size: 14px; }a { color: #394555; }
main { max-width: 1120px; margin: auto; padding: 36px 24px 60px; }.page-heading { max-width: 850px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 20px; }h3 { font-size: 18px; margin: 0; overflow-wrap: anywhere; }p { line-height: 1.6; }
.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; }.filters { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 1fr) minmax(0, .7fr); gap: 18px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; background: #fff; color: #202329; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, pre:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 13px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.error { background: #fff0ed; color: #9a3527; }.warning { background: #fff3d9; color: #805518; }.page-summary, .reader-heading, .card-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.report-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }.status { background: #eff2f5; border-radius: 20px; padding: 5px 10px; font-size: 12px; white-space: nowrap; }
dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 3fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }.preview { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }.fingerprint { overflow-wrap: anywhere; }.pagination { margin: 24px 0; }.reader-section { margin-top: 40px; }pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 13px/1.65 monospace; max-height: 720px; overflow-y: auto; tab-size: 4; }
@media (max-width: 700px) { .report-grid, .filters { grid-template-columns: 1fr; }.app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 24px 14px; }.panel { padding: 16px; }.reader-heading, .page-summary { align-items: flex-start; flex-direction: column; } }
</style>
