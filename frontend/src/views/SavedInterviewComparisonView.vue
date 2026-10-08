<template>
  <div class="comparison-page" :lang="locale">
    <header class="app-header"><RouterLink class="brand" to="/">MIROFISH</RouterLink><div class="header-actions"><RouterLink to="/interview-files" data-testid="interview-compare-reader-link">{{ t('savedInterviewFiles.entry') }}</RouterLink><label class="language-choice">{{ t('savedInterviewComparison.language') }}<select data-testid="interview-compare-language" :value="locale" :onChange="languageHandler"><option value="en">English</option><option value="zh">中文</option></select></label></div></header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('comparison.eyebrow') }}</p><h1>{{ t('savedInterviewComparison.title') }}</h1><p>{{ t('savedInterviewComparison.scope') }}</p><p class="note">{{ t('savedInterviewComparison.sessionNote') }}</p><p class="note">{{ t('savedInterviewComparison.identityNote') }}</p></header>
      <section class="panel" aria-labelledby="compare-file-heading">
        <h2 id="compare-file-heading">{{ t('savedInterviewFiles.openTitle') }}</h2><label for="compare-file-input">{{ t('savedInterviewFiles.file') }}</label>
        <input id="compare-file-input" data-testid="interview-compare-file-input" type="file" accept=".json,application/json" aria-describedby="compare-file-hint" :onChange="fileHandlers.select">
        <p id="compare-file-hint" class="note">{{ t('savedInterviewComparison.fileHint', { limit: fileLimitMiB }) }}</p>
        <p v-if="pending.loading" data-testid="interview-compare-loading" role="status">{{ t('savedInterviewFiles.loading') }}</p><p v-if="pending.error" data-testid="interview-compare-error" class="notice error" role="alert">{{ t('savedInterviewComparison.invalid') }}</p>
        <div v-if="pending.loading || pending.preview || pending.error" class="actions"><button type="button" data-testid="interview-compare-cancel" :onClick="fileHandlers.cancel">{{ t('savedInterviewFiles.cancel') }}</button></div>
        <section v-if="pending.preview" data-testid="interview-compare-preview" class="preview" aria-labelledby="compare-preview-heading">
          <h3 id="compare-preview-heading">{{ t('savedInterviewFiles.preview') }}</h3><p class="notice">{{ t('savedInterviewFiles.unverified') }}</p>
          <p class="literal">{{ t('savedInterviewFiles.filename') }}: {{ pending.filename }}</p><p class="literal">{{ t('savedInterviewFiles.simulation') }}: {{ pending.preview.simulation_id }}</p><p>{{ recordedFilters(pending.preview) }}</p><p>{{ t('savedInterviewFiles.observedAt', { time: pending.preview.observed_at }) }}</p>
          <p>{{ t('savedInterviewFiles.recordCount', { count: pending.preview.records.length }) }} · {{ t('savedInterviewFiles.availability', { status: t(`comparison.availability.${pending.preview.availability}`) }) }}</p><p class="note">{{ t('savedInterviewFiles.limitsNote', { count: pending.preview.limits.rows_per_platform, total: pending.preview.limits.rows_total }) }}</p>
          <p v-for="platform in platforms" :key="platform">{{ t(`comparison.platforms.${platform}`) }}: {{ t(`savedInterviewFiles.statuses.${pending.preview.sources[platform].status}`) }} · {{ t(`savedInterviewFiles.coverage.${pending.preview.sources[platform].coverage}`) }} · {{ t('savedInterviewFiles.returned', { count: pending.preview.sources[platform].returned_count }) }}</p>
          <div class="actions"><button v-for="side in sides" :key="side" type="button" class="primary" :data-testid="`interview-compare-accept-${side}`" :onClick="fileHandlers[side]">{{ t(pair[side] ? 'savedInterviewComparison.replaceSide' : 'savedInterviewComparison.acceptSide', { side: t(`savedInterviewComparison.${side}`) }) }}</button></div>
        </section>
        <div class="actions"><button type="button" data-testid="interview-compare-swap" :disabled="!pair.left && !pair.right" :onClick="pairHandlers.swap">{{ t('savedInterviewComparison.swap') }}</button><button type="button" data-testid="interview-compare-clear-both" :disabled="!pair.left && !pair.right && !pending.preview && !pending.loading && !pending.error" :onClick="pairHandlers.clear">{{ t('savedInterviewComparison.clearBoth') }}</button></div>
      </section>
      <p v-if="downloadError" data-testid="interview-compare-download-error" class="notice error" role="alert">{{ t('savedInterviews.errors.download') }}</p>
      <section v-if="pair.left || pair.right" class="panel question-review" aria-labelledby="compare-question-heading">
        <h2 id="compare-question-heading">{{ t('savedInterviewComparison.questions') }}</h2><label for="compare-question-select">{{ t('savedInterviews.selectQuestion') }}</label>
        <select id="compare-question-select" data-testid="interview-compare-question-select" :value="presentation.key" :disabled="!comparison.groups.length" :onChange="questionHandler(pair, presentation)"><option v-for="(group, index) in comparison.groups" :key="group.key" :value="group.key">{{ t('savedInterviewComparison.questionOption', { number: index + 1, prompt: questionPreview(group.prompt) }) }}</option></select>
        <p class="note">{{ t('savedInterviewComparison.questionNote') }}</p><p data-testid="interview-compare-order-note" class="note">{{ t('savedInterviews.orderNote') }}</p><template v-if="selectedQuestion"><h3>{{ t('savedInterviews.fullQuestion') }}</h3><pre data-testid="interview-compare-prompt">{{ selectedQuestion.prompt }}</pre><p v-if="selectedQuestion.prompt === ''" class="note">{{ t('savedInterviews.emptyQuestion') }}</p></template><p v-else>{{ t('savedInterviewComparison.noQuestions') }}</p>
      </section>
      <div class="side-grid">
        <section v-for="side in sides" :key="side" class="side-column" :data-testid="pair[side] ? `interview-compare-${side}-side` : undefined" :aria-label="t(`savedInterviewComparison.${side}`)">
          <template v-if="pair[side]">
            <div class="panel">
              <h2>{{ t(`savedInterviewComparison.${side}`) }}</h2><p class="notice">{{ t('savedInterviewFiles.unverified') }}</p><p class="literal">{{ t('savedInterviewFiles.filename') }}: {{ pair[side].filename }}</p><p class="literal">{{ t('savedInterviewFiles.simulation') }}: {{ pair[side].data.simulation_id }}</p><p>{{ recordedFilters(pair[side].data) }}</p><p>{{ t('savedInterviewFiles.observedAt', { time: pair[side].data.observed_at }) }}</p>
              <p>{{ t('savedInterviewFiles.availability', { status: t(`comparison.availability.${pair[side].data.availability}`) }) }}</p><p class="note">{{ t('savedInterviewFiles.limitsNote', { count: pair[side].data.limits.rows_per_platform, total: pair[side].data.limits.rows_total }) }}</p><p>{{ t('savedInterviewFiles.recordCount', { count: pair[side].data.records.length }) }}</p>
              <section v-for="platform in platforms" :key="platform" class="source-summary" :data-testid="`interview-compare-${side}-source-${platform}`">
                <h3>{{ t(`comparison.platforms.${platform}`) }}</h3><p>{{ t(`savedInterviewFiles.statuses.${pair[side].data.sources[platform].status}`) }} · {{ t(`savedInterviewFiles.coverage.${pair[side].data.sources[platform].coverage}`) }}</p><p>{{ t('savedInterviewFiles.returned', { count: pair[side].data.sources[platform].returned_count }) }}</p>
                <p :data-testid="`interview-compare-${side}-more-${platform}`">{{ t('savedInterviewComparison.hasMore', { value: t(pair[side].data.sources[platform].has_more === null ? 'savedInterviewComparison.unknown' : pair[side].data.sources[platform].has_more ? 'savedInterviewComparison.yes' : 'savedInterviewComparison.no') }) }}</p>
                <p v-if="pair[side].data.sources[platform].has_more === true" class="note">{{ t('savedInterviewFiles.moreAvailable') }}</p><p v-else-if="pair[side].data.sources[platform].has_more === null && pair[side].data.sources[platform].status !== 'not_requested'" class="note">{{ t('savedInterviewFiles.unknownMore') }}</p><p v-if="pair[side].data.sources[platform].status === 'available' && pair[side].data.sources[platform].returned_count === 0 && pair[side].data.sources[platform].has_more === false">{{ t('savedInterviewFiles.empty') }}</p>
                <ul v-if="pair[side].data.sources[platform].warnings.length" class="warnings"><li v-for="warning in pair[side].data.sources[platform].warnings" :key="warning"><span class="literal">{{ warning }}</span>: {{ t(`savedInterviewFiles.warnings.${warning}`) }}</li></ul>
              </section>
              <details :data-testid="`interview-compare-${side}-ungrouped`"><summary>{{ t('savedInterviewComparison.ungrouped', { count: comparison.ungroupedRecords[side].length }) }}</summary><p class="note">{{ t('savedInterviewComparison.ungroupedNote') }}</p><ul class="ungrouped-list"><li v-for="row in comparison.ungroupedRecords[side]" :key="row.record_id"><span class="literal">{{ row.record_id }}</span> · {{ t(`savedInterviewComparison.reasons.${ungroupedReason(row)}`) }}<ul v-if="row.warnings.length"><li v-for="warning in row.warnings" :key="warning"><span class="literal">{{ warning }}</span>: {{ t(`savedInterviews.warnings.${warning}`) }}</li></ul></li></ul></details>
              <div class="actions"><button type="button" :data-testid="`interview-compare-${side}-download`" :onClick="downloadHandler(pair, presentation, side)">{{ t('savedInterviews.download') }}</button><button type="button" :data-testid="`interview-compare-${side}-clear`" :onClick="clearHandler(pair, side)">{{ t('savedInterviewComparison.clearSide', { side: t(`savedInterviewComparison.${side}`) }) }}</button></div><p class="note">{{ t('savedInterviewComparison.downloadNote') }}</p>
            </div>
            <div class="panel replies">
              <h3>{{ t('savedInterviewComparison.replies') }}</h3><p v-if="selectedQuestion" :data-testid="`interview-compare-${side}-counts`">{{ t('savedInterviewComparison.counts', { twitter: selectedQuestion[side].counts.twitter, reddit: selectedQuestion[side].counts.reddit }) }}</p><p v-if="selectedQuestion && !selectedQuestion[side].records.length" :data-testid="`interview-compare-${side}-absent`" class="notice">{{ t('savedInterviewComparison.absent') }}</p>
              <label :for="`compare-${side}-search`">{{ t('savedInterviews.search') }}</label><input :id="`compare-${side}-search`" :data-testid="`interview-compare-${side}-search`" type="search" :value="presentation[side].query" :aria-describedby="`compare-${side}-search-note compare-${side}-search-count`" :onInput="searchHandler(pair, presentation, side)"><p :id="`compare-${side}-search-note`" class="note">{{ t('savedInterviews.searchNote') }}</p>
              <div class="actions"><button type="button" :data-testid="`interview-compare-${side}-search-clear`" :disabled="presentation[side].query === ''" :onClick="searchHandler(pair, presentation, side, true)">{{ t('savedInterviews.clearSearch') }}</button></div><p :id="`compare-${side}-search-count`" :data-testid="`interview-compare-${side}-search-count`" role="status" aria-live="polite" aria-atomic="true">{{ t('savedInterviews.searchCount', { count: sideRows[side].matching.length, total: selectedQuestion?.[side].records.length ?? 0 }) }}</p><p v-if="presentation[side].query !== '' && !sideRows[side].matching.length" class="notice">{{ t('savedInterviews.searchEmpty') }}</p>
              <article v-for="row in sideRows[side].page" :key="row.record_id" class="interview" :data-testid="`interview-compare-row-${side}-${row.record_id}`">
                <h4>{{ t(`comparison.platforms.${row.platform}`) }} · {{ row.agent_id === null ? t('savedInterviews.unknownAgent') : t('savedInterviews.agent', { id: row.agent_id }) }}</h4><p class="note literal">{{ row.record_id }} · {{ t('savedInterviews.row', { id: row.row_id }) }} · {{ row.timestamp === null ? t('savedInterviews.missingTimestamp') : row.timestamp === '' ? t('savedInterviews.emptyText') : row.timestamp }}</p>
                <h4>{{ t('savedInterviews.prompt') }}</h4><pre v-if="row.prompt !== ''">{{ row.prompt }}</pre><p v-else class="note">{{ t('savedInterviews.emptyText') }}</p><h4>{{ t('savedInterviews.response') }}</h4><pre v-if="row.response !== null && row.response !== ''">{{ row.response }}</pre><p v-else class="note">{{ t(row.response === null ? 'savedInterviews.missingText' : 'savedInterviews.emptyText') }}</p><p v-if="row.truncated" class="notice">{{ t('savedInterviews.truncated') }}</p><ul v-if="row.warnings.length" class="warnings"><li v-for="warning in row.warnings" :key="warning"><span class="literal">{{ warning }}</span>: {{ t(`savedInterviews.warnings.${warning}`) }}</li></ul>
              </article>
              <nav class="actions" :aria-label="t('savedInterviews.pagination')"><button type="button" :data-testid="`interview-compare-${side}-first`" :disabled="presentation[side].page === 0" :onClick="pageHandler(pair, presentation, side, 0)">{{ t('savedActivity.first') }}</button><button type="button" :data-testid="`interview-compare-${side}-previous`" :disabled="presentation[side].page === 0" :onClick="pageHandler(pair, presentation, side, presentation[side].page - 1)">{{ t('savedActivity.previous') }}</button><button type="button" :data-testid="`interview-compare-${side}-next`" :disabled="presentation[side].page + 1 >= sideRows[side].pages" :onClick="pageHandler(pair, presentation, side, presentation[side].page + 1)">{{ t('savedActivity.next') }}</button></nav><p class="note">{{ t('savedInterviews.pagePosition', { page: presentation[side].page + 1, pages: sideRows[side].pages }) }}</p>
            </div>
          </template><p v-else class="panel note">{{ t('savedInterviewComparison.emptySide', { side: t(`savedInterviewComparison.${side}`) }) }}</p>
        </section>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { SAVED_INTERVIEW_FILE_MAX_BYTES, readSavedInterviewFile } from '../utils/savedInterviewFiles.js'
import { buildSavedInterviewComparison } from '../utils/savedInterviewComparison.js'
import { filterSavedInterviewRecords } from '../utils/savedInterviewSearch.js'

const { t, locale } = useI18n(), route = useRoute(), sides = ['left', 'right'], platforms = ['twitter', 'reddit'], pageSize = 25
const emptyPending = () => ({ preview: null, filename: '', loading: false, error: '' })
const emptyPair = () => ({ left: null, right: null })
const emptyView = key => ({ key, left: { query: '', page: 0 }, right: { query: '', page: 0 } })
const revision = shallowRef({}), pending = shallowRef(emptyPending()), pair = shallowRef(emptyPair()), presentation = shallowRef(emptyView(null)), downloadError = ref(false)
const fileLimitMiB = SAVED_INTERVIEW_FILE_MAX_BYTES / (1024 * 1024)
let disposed = false, activeDownload = null, downloadGeneration = 0
function current(owned) { return !disposed && route.name === 'SavedInterviewComparison' && revision.value === owned }
const languageHandler = computed(() => {
  const owned = revision.value
  return event => { if (!current(owned)) return; const value = event.target.value; if (current(owned) && ['en', 'zh'].includes(value)) locale.value = value }
})
function disposeDownload(attempt) {
  if (!attempt) return
  if (activeDownload === attempt) activeDownload = null
  const anchor = attempt.anchor, url = attempt.url; attempt.anchor = null; attempt.url = null
  try { anchor?.remove() } catch { /* clean only this attempt */ }
  if (url) { try { URL.revokeObjectURL(url) } catch { /* cleanup cannot replace state */ } }
}
function revokeDownload() { downloadGeneration++; disposeDownload(activeDownload) }
function rotate() { const next = {}; revision.value = next; revokeDownload(); return next }
function transition(owned) {
  if (!current(owned)) return null
  const next = rotate()
  if (!current(next)) return null
  downloadError.value = false; return next
}
function updatePending(owned, changes) { const next = transition(owned); if (!next) return null; pending.value = changes; return next }
async function selectFile(owned, event) {
  if (!current(owned)) return
  const count = event.target.files?.length ?? 0, file = event.target.files?.[0]; event.target.value = ''
  const reading = updatePending(owned, { ...emptyPending(), loading: count > 0 })
  if (!reading || !count) return
  try {
    if (count !== 1 || typeof file?.name !== 'string' || !file.name || file.name.length > 1024 || [...file.name].length > 512 || new TextEncoder().encode(file.name).length > 2048) throw new Error('Invalid filename')
    const filename = file.name, preview = await readSavedInterviewFile(file)
    updatePending(reading, { ...emptyPending(), filename, preview })
  } catch { updatePending(reading, { ...emptyPending(), error: 'invalid' }) }
}
const comparison = computed(() => buildSavedInterviewComparison(pair.value.left?.data ?? null, pair.value.right?.data ?? null))
const selectedQuestion = computed(() => comparison.value.groups.find(group => group.key === presentation.value.key) ?? null)
function resetView() { presentation.value = emptyView(comparison.value.groups[0]?.key ?? null) }
function acceptFile(owned, preview, side) {
  if (!current(owned) || pending.value !== preview || !preview.preview || !transition(owned)) return
  pending.value = emptyPending(); pair.value = { ...pair.value, [side]: Object.freeze({ filename: preview.filename, data: preview.preview }) }; resetView()
}
const fileHandlers = computed(() => {
  const owned = revision.value, preview = pending.value
  return { select: event => selectFile(owned, event), cancel: () => updatePending(owned, emptyPending()), left: () => acceptFile(owned, preview, 'left'), right: () => acceptFile(owned, preview, 'right') }
})
function pairOwner(saved) { const owned = revision.value; return () => current(owned) && pair.value === saved }
function viewOwner(saved, view) { const owns = pairOwner(saved); return () => owns() && presentation.value === view }
function replacePair(owns, next) {
  if (!owns() || !transition(revision.value)) return
  pending.value = emptyPending(); pair.value = next; resetView()
}
const pairHandlers = computed(() => {
  const saved = pair.value, owns = pairOwner(saved)
  return { swap: () => replacePair(owns, { left: saved.right, right: saved.left }), clear: () => replacePair(owns, emptyPair()) }
})
function clearHandler(saved, side) { const owns = pairOwner(saved); return () => replacePair(owns, { ...saved, [side]: null }) }
function updateView(owns, next) {
  if (!owns()) return
  const owned = revision.value; presentation.value = next; revokeDownload()
  if (current(owned) && presentation.value === next) downloadError.value = false
}
function questionHandler(saved, view) {
  const owns = viewOwner(saved, view)
  return event => { if (!owns()) return; const key = event.target.value; if (owns() && comparison.value.groups.some(group => group.key === key)) updateView(owns, emptyView(key)) }
}
function searchHandler(saved, view, side, clear = false) {
  const owns = viewOwner(saved, view)
  return event => { if (!owns()) return; const query = clear ? '' : event.target.value; if (typeof query === 'string' && owns()) updateView(owns, { ...view, [side]: { query, page: 0 } }) }
}
const sideRows = computed(() => Object.fromEntries(sides.map(side => {
  const matching = filterSavedInterviewRecords(selectedQuestion.value?.[side].records ?? [], presentation.value[side].query), page = presentation.value[side].page
  return [side, { matching, pages: Math.max(1, Math.ceil(matching.length / pageSize)), page: matching.slice(page * pageSize, (page + 1) * pageSize) }]
})))
function pageHandler(saved, view, side, page) {
  const owns = viewOwner(saved, view)
  return () => { if (owns() && Number.isInteger(page) && page >= 0 && page < sideRows.value[side].pages) updateView(owns, { ...view, [side]: { ...view[side], page } }) }
}
function downloadHandler(saved, view, side) {
  const owns = viewOwner(saved, view), data = saved[side]?.data
  return () => {
    if (!data || !owns()) return
    const generation = downloadGeneration + 1; revokeDownload()
    if (downloadGeneration !== generation || !owns()) return
    const attempt = { url: null, anchor: null }; activeDownload = attempt; downloadError.value = false
    const ownsAttempt = () => activeDownload === attempt && downloadGeneration === generation && owns()
    let finished = false
    try {
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json;charset=utf-8' })
      if (!ownsAttempt()) return
      attempt.url = URL.createObjectURL(blob)
      if (!ownsAttempt()) return
      attempt.anchor = document.createElement('a')
      if (!ownsAttempt()) return
      attempt.anchor.href = attempt.url; attempt.anchor.download = `${data.simulation_id}-saved-interviews.json`
      document.body.appendChild(attempt.anchor)
      if (!ownsAttempt()) return
      attempt.anchor.click()
      if (!ownsAttempt()) return
      attempt.anchor.remove(); attempt.anchor = null; finished = true
    } catch {
      const report = ownsAttempt(); disposeDownload(attempt)
      if (report && downloadGeneration === generation && owns()) downloadError.value = true
    } finally { if (!finished) disposeDownload(attempt) }
  }
}
function recordedFilters(data) { return t('savedInterviewFiles.filters', { platform: data.filters.platform === null ? t('savedActivity.allPlatforms') : t(`comparison.platforms.${data.filters.platform}`), agent: data.filters.agent_id === null ? t('savedActivity.any') : data.filters.agent_id }) }
function questionPreview(prompt) { const characters = [...prompt]; return prompt === '' ? t('savedInterviews.emptyQuestion') : characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '') }
function ungroupedReason(row) { return row.warnings.includes('payload_truncated') ? 'incomplete' : row.payload_kind === 'raw' ? 'raw' : 'missing' }
function retire() {
  const retired = rotate()
  if (revision.value !== retired) return
  pending.value = emptyPending(); pair.value = emptyPair(); presentation.value = emptyView(null); downloadError.value = false
}
watch(() => route.fullPath, retire, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; retire() })
</script>

<style scoped>
.comparison-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions, .language-choice { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; font-size: 14px; }a { color: #394555; }
main { max-width: 1180px; margin: 0 auto; padding: 36px 24px 60px; }.page-heading { max-width: 940px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 19px; }h3 { font-size: 17px; }h4 { font-size: 14px; }p { line-height: 1.6; }h2, h3, h4, p, li, summary, a { overflow-wrap: anywhere; }.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; min-width: 0; }.side-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-top: 24px; }.side-column { min-width: 0; }.question-review, .replies { margin-top: 20px; }.preview, .source-summary, .interview { border-top: 1px solid #e1e5eb; margin-top: 20px; padding-top: 16px; }
label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 8px; }input, select { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; background: #fff; color: #202329; min-width: 0; }.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; max-width: 100%; overflow-wrap: anywhere; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 13px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.notice.error { background: #fff0ed; color: #9a3527; }.warnings { background: #fff3d9; color: #805518; padding: 14px 14px 14px 32px; font-size: 13px; border-radius: 7px; line-height: 1.7; }pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.65 monospace; max-height: 420px; overflow-y: auto; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; }details { margin-top: 20px; }summary { cursor: pointer; min-height: 44px; line-height: 1.6; }.language-choice { margin: 0; }.language-choice select { width: auto; }.ungrouped-list { font-size: 13px; line-height: 1.7; }
@media (max-width: 800px) { .side-grid { grid-template-columns: 1fr; } }@media (max-width: 540px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; }main { padding: 24px 14px; }.panel { padding: 16px; } }
</style>
