<template>
  <div class="simulations-page">
    <header class="app-header">
      <RouterLink to="/" class="brand">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink to="/">{{ t('savedSimulations.home') }}</RouterLink><LanguageSwitcher /></div>
    </header>
    <main>
      <div class="page-heading">
        <p class="eyebrow">{{ t('comparison.eyebrow') }}</p>
        <h1>{{ t('savedSimulations.title') }}</h1>
        <p>{{ t('savedSimulations.scope') }}</p>
        <p class="note">{{ t('savedSimulations.orderNote') }}</p>
      </div>
      <section class="panel" :aria-label="t('savedSimulations.filters')">
        <form class="search-form" @submit.prevent="applySearch">
          <div class="search-field"><label for="simulations-query">{{ t('savedSimulations.search') }}</label><input id="simulations-query" data-testid="simulations-query" type="search" :value="draftQuery" @input="draftQuery = $event.target.value" aria-describedby="simulations-search-note" /></div>
          <button type="submit" data-testid="simulations-search" @click.prevent="applySearch">{{ t('savedSimulations.apply') }}</button>
        </form>
        <p id="simulations-search-note" class="note">{{ t('savedSimulations.searchNote') }}</p>
        <div class="filter-actions">
          <div class="status-field"><label for="simulations-status">{{ t('savedSimulations.status') }}</label><select id="simulations-status" data-testid="simulations-status" :value="selection.status" @change="changeStatus($event.target.value)"><option value="">{{ t('savedSimulations.allStatuses') }}</option><option v-for="status in statuses" :key="status" :value="status">{{ t(`comparison.statuses.${status}`) }}</option></select></div>
          <div class="order-field"><label for="simulations-order">{{ t('savedSimulations.order') }}</label><select id="simulations-order" data-testid="simulations-order" :value="selection.order" @change="changeOrder($event.target.value)" aria-describedby="simulations-order-note"><option value="">{{ t('savedSimulations.serverOrder') }}</option><option v-for="order in orders" :key="order" :value="order">{{ t(`savedSimulations.orders.${order}`) }}</option></select></div>
          <button type="button" data-testid="simulations-clear" @click="navigate('', '', 1, '')">{{ t('savedSimulations.clear') }}</button>
          <button type="button" data-testid="simulations-refresh" @click="loadCandidates">{{ t('savedSimulations.refresh') }}</button>
          <button type="button" data-testid="simulations-download" :disabled="!canDownload" :onClick="downloadAction" aria-describedby="simulations-download-note">{{ t('savedSimulations.download') }}</button>
        </div>
        <p id="simulations-order-note" class="note">{{ t('savedSimulations.sortNote') }}</p>
        <p id="simulations-download-note" class="note">{{ t('savedSimulations.downloadNote') }}</p>
        <p v-if="downloadError" role="alert" class="notice error" data-testid="simulations-download-error">{{ t('savedSimulations.downloadError') }}</p>
      </section>
      <p v-if="selection.malformed || (loaded && selection.page !== page)" class="notice" role="status" data-testid="simulations-url-notice">{{ t('savedSimulations.urlNotice') }}</p>
      <p v-if="loading" role="status" data-testid="simulations-loading">{{ t('savedSimulations.loading') }}</p>
      <div v-if="error" class="notice error" role="alert" data-testid="simulations-error"><p>{{ t('savedSimulations.error') }}</p><button type="button" data-testid="simulations-retry" @click="loadCandidates">{{ t('savedSimulations.retry') }}</button></div>
      <section v-if="loaded" :aria-label="t('savedSimulations.results')">
        <p class="counts" aria-live="polite" data-testid="simulations-counts">{{ t('savedSimulations.counts', { start, end, matched: filtered.length, total: candidates.length, skipped: skippedRecords }) }}</p>
        <p v-if="!filtered.length" class="panel" data-testid="simulations-empty">{{ t(candidates.length ? 'savedSimulations.noMatches' : 'savedSimulations.empty') }}</p>
        <div class="results">
          <article v-for="candidate in visible" :key="candidate.simulation_id" class="panel simulation-card" data-testid="simulation-row">
            <div class="row-heading"><h2>{{ candidate.simulation_id }}</h2><span class="status">{{ t(`comparison.statuses.${candidate.status}`) }}</span></div>
            <p class="scenario">{{ candidate.scenario || t('savedSimulations.noScenario') }}</p>
            <dl><dt>{{ t('savedSimulations.project') }}</dt><dd>{{ candidate.project_id || '—' }}</dd><dt>{{ t('savedSimulations.updated') }}</dt><dd>{{ formatDate(candidate.updated_at) }}</dd></dl>
            <div class="row-actions">
              <RouterLink :to="{ name: 'SavedActivity', params: { simulationId: candidate.simulation_id } }" :data-testid="`simulation-activity-${candidate.simulation_id}`">{{ t('savedSimulations.activity') }}</RouterLink>
              <RouterLink :to="{ name: 'SavedInterviews', params: { simulationId: candidate.simulation_id } }" :data-testid="`simulation-interviews-${candidate.simulation_id}`">{{ t('savedSimulations.interviews') }}</RouterLink>
              <RouterLink :to="{ name: 'SimulationComparison', query: { left: candidate.simulation_id } }" :data-testid="`simulation-compare-${candidate.simulation_id}`">{{ t('savedSimulations.compare') }}</RouterLink>
              <RouterLink :to="{ name: 'RunCaptures', query: { simulation: candidate.simulation_id } }" :data-testid="`simulation-captures-${candidate.simulation_id}`">{{ t('savedSimulations.captures') }}</RouterLink>
            </div>
          </article>
        </div>
        <nav class="pagination" :aria-label="t('savedSimulations.pagination')">
          <button type="button" data-testid="simulations-previous" :disabled="page <= 1" @click="navigate(selection.q, selection.status, page - 1)">{{ t('savedSimulations.previous') }}</button>
          <span data-testid="simulations-page">{{ t('savedSimulations.page', { page, pages }) }}</span>
          <button type="button" data-testid="simulations-next" :disabled="page >= pages" @click="navigate(selection.q, selection.status, page + 1)">{{ t('savedSimulations.next') }}</button>
        </nav>
      </section>
      <p class="note">{{ t('savedSimulations.limits') }}</p>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { getComparisonCandidates } from '../api/simulation'

const { t, locale } = useI18n()
const route = useRoute(), router = useRouter()
const statuses = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', 'completed', 'stopped', 'failed', 'unknown']
const orders = ['updated-desc', 'updated-asc', 'id-asc']
const pageSize = 20
const candidates = ref([]), skippedRecords = ref(0), loaded = ref(false), loading = ref(false), error = ref(false)
const draftQuery = ref('')
const downloadRevision = ref(0), downloadError = ref(false), pendingNavigation = ref(null)
let request = null, disposed = false, downloadResource = null
const selection = computed(() => {
  const { q, status, order, page } = route.query
  const validQuery = q === undefined || typeof q === 'string'
  const validStatus = status === undefined || status === '' || (typeof status === 'string' && statuses.includes(status))
  const validOrder = order === undefined || order === '' || (typeof order === 'string' && orders.includes(order))
  const emptyPage = page === undefined || page === ''
  const validPage = emptyPage || (typeof page === 'string' && /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page)))
  return { q: validQuery ? q || '' : '', status: validStatus ? status || '' : '',
    order: validOrder ? order || '' : '',
    page: validPage && !emptyPage ? Number(page) : 1, malformed: !validQuery || !validStatus || !validOrder || !validPage }
})
const filtered = computed(() => {
  const needle = selection.value.q.toLowerCase()
  return candidates.value.filter(candidate => (!selection.value.status || candidate.status === selection.value.status) &&
    (!needle || [candidate.simulation_id, candidate.project_id, candidate.scenario].some(value => (value || '').toLowerCase().includes(needle))))
})
const ordered = computed(() => {
  const order = selection.value.order
  if (!order) return filtered.value
  if (order === 'id-asc') return [...filtered.value].sort((a, b) => a.simulation_id < b.simulation_id ? -1 : a.simulation_id > b.simulation_id ? 1 : 0)
  const direction = order === 'updated-asc' ? 1 : -1
  return filtered.value.map((candidate, index) => ({ candidate, index, time: savedUpdate(candidate.updated_at) }))
    .sort((a, b) => {
      if (!a.time || !b.time) return Number(!a.time) - Number(!b.time) || a.index - b.index
      return direction * (a.time.milliseconds - b.time.milliseconds || a.time.microseconds - b.time.microseconds) || a.index - b.index
    }).map(item => item.candidate)
})
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const page = computed(() => Math.min(selection.value.page, pages.value))
const start = computed(() => filtered.value.length ? (page.value - 1) * pageSize + 1 : 0)
const end = computed(() => Math.min(page.value * pageSize, filtered.value.length))
const visible = computed(() => ordered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

async function navigate(q, status, targetPage, order = selection.value.order) {
  if (disposed) return
  const navigation = Symbol()
  pendingNavigation.value = navigation
  retireDownload()
  draftQuery.value = q
  try {
    await router.push({ name: 'SavedSimulations', query: { ...(q ? { q } : {}), ...(status ? { status } : {}), ...(order ? { order } : {}), ...(targetPage > 1 ? { page: String(targetPage) } : {}) } })
  } finally {
    if (pendingNavigation.value === navigation) { pendingNavigation.value = null; retireDownload() }
  }
}
function applySearch() { navigate(draftQuery.value, selection.value.status, 1) }
function changeStatus(status) { navigate(selection.value.q, statuses.includes(status) ? status : '', 1) }
function changeOrder(order) { navigate(selection.value.q, selection.value.status, 1, orders.includes(order) ? order : '') }
function validCatalog(data) {
  if (!Array.isArray(data?.candidates) || !Number.isSafeInteger(data.skipped_records) || data.skipped_records < 0) return false
  const ids = new Set()
  return data.candidates.every(candidate => {
    if (!candidate || typeof candidate.simulation_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.simulation_id) || ids.has(candidate.simulation_id) ||
      typeof candidate.scenario !== 'string' || !statuses.includes(candidate.status) ||
      !['project_id', 'created_at', 'updated_at'].every(key => candidate[key] === null || typeof candidate[key] === 'string')) return false
    ids.add(candidate.simulation_id)
    return true
  })
}
async function loadCandidates() {
  if (disposed) return
  retireDownload()
  request?.controller.abort()
  const current = { controller: new AbortController() }
  request = current
  candidates.value = []; skippedRecords.value = 0; loaded.value = false; loading.value = true; error.value = false
  const owns = () => !disposed && request === current && !current.controller.signal.aborted
  try {
    const response = await getComparisonCandidates(current.controller.signal)
    if (!owns()) return
    if (!response?.success || !validCatalog(response.data)) throw new Error('Invalid catalog')
    candidates.value = response.data.candidates
    skippedRecords.value = response.data.skipped_records
    loaded.value = true
  } catch {
    if (owns()) error.value = true
  } finally {
    if (owns()) loading.value = false
  }
}
function releaseDownload(current = downloadResource) {
  if (!current) return
  if (downloadResource === current) downloadResource = null
  const link = current.link, url = current.url
  current.link = null; current.url = null
  try { link?.remove() } catch { /* Still release this attempt's URL. */ }
  try { if (url) URL.revokeObjectURL(url) } catch { /* Never disturb a newer owner. */ }
}
function retireDownload() {
  downloadRevision.value++
  downloadError.value = false
  releaseDownload()
}
const canDownload = computed(() => loaded.value && !loading.value && !error.value && !pendingNavigation.value && route.name === 'SavedSimulations')
const downloadAction = computed(() => {
  const revision = downloadRevision.value, source = candidates.value, path = route.fullPath
  const ready = canDownload.value, records = ordered.value
  const { q, status, order } = selection.value
  const counts = { total: source.length, matched: records.length, skipped: skippedRecords.value }
  const owns = () => ready && !disposed && canDownload.value && revision === downloadRevision.value &&
    source === candidates.value && router.currentRoute.value.name === 'SavedSimulations' && router.currentRoute.value.fullPath === path
  return () => {
    if (!owns()) return
    const previous = downloadResource, current = { url: null, link: null }
    downloadResource = current; releaseDownload(previous)
    const currentOwner = () => owns() && downloadResource === current
    try {
      if (!currentOwner()) return
      downloadError.value = false
      // Project only validated metadata, never future API fields or toJSON hooks.
      const body = JSON.stringify({ format: 'mirofish-saved-simulation-catalog', version: 1,
        selection: { q, status, order }, counts,
        records: records.map(({ simulation_id, project_id, scenario, status, created_at, updated_at }) =>
          ({ simulation_id, project_id, scenario, status, created_at, updated_at })) }, null, 2) + '\n'
      const blob = new Blob([body], { type: 'application/json;charset=utf-8' })
      if (!currentOwner()) return
      current.url = URL.createObjectURL(blob)
      if (!currentOwner()) return
      current.link = document.createElement('a')
      if (!currentOwner()) return
      current.link.href = current.url
      if (!currentOwner()) return
      current.link.download = 'mirofish-saved-simulation-catalog.json'
      if (!currentOwner()) return
      document.body.appendChild(current.link)
      if (!currentOwner()) return
      current.link.click()
      if (!currentOwner()) return
      const link = current.link; link.remove(); current.link = null
    } catch { if (currentOwner()) downloadError.value = true; releaseDownload(current) }
    finally { if (!currentOwner()) releaseDownload(current) }
  }
})
// Saved ISO dates or full timestamps only; not all Python fromisoformat variants.
// Unzoned values use UTC, matching the service. Keep microseconds separate so
// Python saves within one JavaScript millisecond still have an exact order.
function savedUpdate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(value || '')
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(value => Number(value || 0))
  const offsetHours = Number(match[9] || 0), offsetMinutes = Number(match[10] || 0)
  if (!year || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  const offset = (offsetHours * 60 + offsetMinutes) * (match[8] === '-' ? -1 : 1)
  return { milliseconds: date.getTime() - offset * 60000, microseconds: Number((match[7] || '').padEnd(6, '0')) }
}
function formatDate(value) {
  const time = savedUpdate(value)
  if (!time) return '—'
  return new Date(time.milliseconds + Math.floor(time.microseconds / 1000)).toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', { timeZoneName: 'short' })
}
watch(() => route.fullPath, () => { retireDownload(); draftQuery.value = selection.value.q }, { immediate: true, flush: 'sync' })
loadCandidates()
onBeforeUnmount(() => { disposed = true; request?.controller.abort(); request = null; retireDownload() })
</script>

<style scoped>
.simulations-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { color: #18181b; font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }
.header-actions, .row-actions, .filter-actions, .pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; }
a { color: #394555; } main { max-width: 1040px; margin: 0 auto; padding: 40px 24px 60px; }
.page-heading { margin-bottom: 28px; } .eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; font-weight: 700; color: #68707c; }
h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; } h2 { font-size: 17px; margin: 0; overflow-wrap: anywhere; }
p { line-height: 1.6; } .note { font-size: 13px; color: #59616d; }
.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 24px; }
.search-form { display: flex; align-items: end; gap: 12px; } .search-field { flex: 1; min-width: 0; } label { display: block; font-size: 14px; margin-bottom: 8px; }
input, select, button { font: inherit; border: 1px solid #ccd2db; border-radius: 6px; padding: 10px 12px; background: #fff; color: #202329; } input { width: 100%; box-sizing: border-box; }
button { cursor: pointer; } button:disabled { opacity: .45; cursor: default; } button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid #405fbd; outline-offset: 3px; }
.filter-actions { align-items: end; } .status-field, .order-field { min-width: 180px; max-width: 100%; } select { width: 100%; }
.notice { padding: 16px; background: #fff7e8; border: 1px solid #e8cd9b; border-radius: 8px; } .error { background: #fff1f2; border-color: #edc5ca; }
.results { display: grid; gap: 16px; } .counts { color: #59616d; } .row-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
.status { background: #eef1f5; padding: 4px 10px; border-radius: 20px; font-size: 12px; white-space: nowrap; }
.scenario { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14rem; overflow-y: auto; } dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 14px; font-size: 13px; } dt { color: #68707c; } dd { margin: 0; overflow-wrap: anywhere; }
.row-actions { margin-top: 20px; font-size: 14px; } .pagination { justify-content: center; margin: 24px 0; font-size: 14px; }
@media (max-width: 600px) { .app-header { padding: 16px; } main { padding: 28px 16px; } .panel { padding: 18px; } .search-form { align-items: stretch; flex-direction: column; } .row-heading { flex-direction: column; gap: 8px; } dl { grid-template-columns: 1fr; gap: 4px; } dd { margin-bottom: 8px; } }
</style>
