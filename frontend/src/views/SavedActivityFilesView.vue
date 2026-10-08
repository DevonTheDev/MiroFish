<template>
  <div class="activity-files-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <div class="header-actions">
        <RouterLink to="/">{{ t('comparison.backHome') }}</RouterLink>
        <label class="language-choice">{{ t('savedActivityFiles.language') }}
          <select data-testid="file-language" :value="locale" @change="setLanguage($event.target.value)"><option value="en">English</option><option value="zh">中文</option></select>
        </label>
      </div>
    </header>
    <main>
      <header class="page-heading">
        <p class="eyebrow">{{ t('savedActivityFiles.eyebrow') }}</p>
        <h1>{{ t('savedActivityFiles.title') }}</h1>
        <p>{{ t('savedActivityFiles.scope') }}</p>
        <p class="note">{{ t('savedActivityFiles.sessionNote') }}</p>
      </header>
      <template v-for="view in views" key="session">
        <section class="panel" aria-labelledby="activity-file-heading">
          <h2 id="activity-file-heading">{{ t('savedActivityFiles.choose') }}</h2>
          <label for="activity-file">{{ t('savedActivityFiles.file') }}</label>
          <input id="activity-file" data-testid="activity-file" type="file" accept=".json,application/json" aria-describedby="activity-file-hint" @change="view.select" />
          <p id="activity-file-hint" class="note">{{ t('savedActivityFiles.fileHint', { limit: fileLimitMiB }) }}</p>
          <p v-if="view.loading" data-testid="file-loading" role="status">{{ t('savedActivityFiles.loading') }}</p>
          <p v-if="view.error" data-testid="file-error" class="notice error" role="alert">{{ t(`savedActivityFiles.errors.${view.error}`) }}</p>
          <div class="actions">
            <button v-if="view.loading || view.preview || view.error" type="button" data-testid="cancel-file" @click="view.cancel">{{ t('savedActivityFiles.cancel') }}</button>
            <button type="button" data-testid="clear-file" :disabled="!view.accepted && !view.loading && !view.preview && !view.error" @click="view.clear">{{ t('savedActivityFiles.clear') }}</button>
          </div>
        </section>
        <section v-for="entry in view.evidence" :key="entry.kind" class="panel evidence" :data-testid="entry.kind === 'preview' ? 'file-preview' : 'accepted-file'" :aria-labelledby="`${entry.kind}-heading`">
          <div class="section-heading">
            <h2 :id="`${entry.kind}-heading`">{{ t(`savedActivityFiles.${entry.kind}`) }}</h2>
            <button v-if="entry.kind === 'accepted'" type="button" data-testid="download-file" @click="view.download">{{ t('savedActivityFiles.download') }}</button>
          </div>
          <p class="provenance">{{ t('savedActivityFiles.historical') }}</p>
          <p class="notice">{{ t('savedActivityFiles.unverified') }}</p>
          <p class="notice">{{ t('savedActivityFiles.onePage') }}</p>
          <p class="note">{{ t('savedActivityFiles.filename') }}: <span class="literal" :data-testid="`${entry.kind}-filename`">{{ entry.filename }}</span></p>
          <dl class="metadata">
            <dt>{{ t('savedActivityFiles.simulation') }}</dt><dd :data-testid="`${entry.kind}-simulation`">{{ entry.page.simulation_id }}</dd>
            <dt>{{ t('savedActivityFiles.observed') }}</dt><dd :data-testid="`${entry.kind}-observed`">{{ entry.page.observed_at }}</dd>
            <dt>{{ t('savedActivityFiles.revision') }}</dt><dd :data-testid="`${entry.kind}-revision`">{{ entry.page.source_revision }}</dd>
            <dt>{{ t('savedActivityFiles.coverage') }}</dt><dd :data-testid="`${entry.kind}-availability`">{{ t(`comparison.availability.${entry.page.availability}`) }}</dd>
            <template v-for="platform in platforms" :key="platform"><dt>{{ t(`comparison.platforms.${platform}`) }}</dt><dd>{{ t(`comparison.availability.${entry.page.platform_availability[platform]}`) }}</dd></template>
            <dt>{{ t('savedActivityFiles.returned') }}</dt><dd :data-testid="`${entry.kind}-returned`">{{ entry.page.returned_count }}</dd>
            <dt>{{ t('savedActivityFiles.matched') }}</dt><dd :data-testid="`${entry.kind}-matched`">{{ entry.page.matched_count ?? t('savedActivityFiles.unknown') }}</dd>
            <dt>{{ t('savedActivityFiles.offset') }}</dt><dd :data-testid="`${entry.kind}-offset`">{{ entry.page.offset }}</dd>
            <dt>{{ t('savedActivityFiles.limit') }}</dt><dd :data-testid="`${entry.kind}-limit`">{{ entry.page.limit }}</dd>
            <dt>{{ t('savedActivityFiles.hasMore') }}</dt><dd :data-testid="`${entry.kind}-has-more`">{{ t(`savedActivityFiles.${entry.page.has_more ? 'yes' : 'no'}`) }}</dd>
          </dl>
          <p class="note">{{ t('savedActivityFiles.coverageNote') }}</p>
          <h3>{{ t('savedActivityFiles.filters') }}</h3>
          <dl class="metadata" :data-testid="`${entry.kind}-filters`">
            <template v-for="filter in filterFields" :key="filter.key"><dt>{{ t(`savedActivity.${filter.label}`) }}</dt><dd class="literal">{{ filterValue(entry.page.filters, filter.key) }}</dd></template>
          </dl>
          <p class="note">{{ t('savedActivityFiles.filterNote') }}</p>
          <h3>{{ t('savedActivityFiles.context') }}</h3>
          <dl class="metadata" :data-testid="`${entry.kind}-context`">
            <dt>{{ t('comparison.savedStatus') }}</dt><dd class="literal">{{ entry.page.context.status ?? t('savedActivityFiles.unknown') }}</dd>
            <template v-for="field in contextFields" :key="field"><dt>{{ t(`comparison.fields.${field}`) }}</dt><dd class="literal">{{ entry.page.context[field] ?? t('savedActivityFiles.unknown') }}</dd></template>
          </dl>
          <h3>{{ t('savedActivityFiles.warnings') }}</h3>
          <div :data-testid="`${entry.kind}-warnings`"><ul v-if="entry.page.warnings.length" class="warnings"><li v-for="(warning, index) in entry.page.warnings" :key="index"><span>{{ warningLabel(warning) }}</span><code class="literal">{{ JSON.stringify(warning) }}</code></li></ul><p v-else class="note">{{ t('savedActivityFiles.noWarnings') }}</p></div>
          <template v-if="entry.kind === 'preview'">
            <p class="note">{{ t('savedActivityFiles.replaceNote') }}</p>
            <button type="button" class="primary" data-testid="open-file" @click="view.open">{{ t('savedActivityFiles.open') }}</button>
          </template>
          <template v-else>
            <h3>{{ t('savedActivity.resultsTitle') }}</h3>
            <p class="note">{{ t('savedActivity.orderNote') }} {{ t('savedActivity.attemptNote') }} {{ t('savedActivity.outcomeNote') }}</p>
            <div v-if="entry.page.actions.length" class="table-scroll" tabindex="0" :aria-label="t('savedActivity.resultsTitle')">
              <table data-testid="activity-file-table">
                <caption>{{ t('savedActivityFiles.tableCaption') }}</caption>
                <thead><tr><th v-for="field in columns" :key="field" scope="col">{{ t(`savedActivity.columns.${field}`) }}</th></tr></thead>
                <tbody><tr v-for="action in entry.page.actions" :key="action.record_id" :data-testid="`action-row-${action.record_id}`">
                  <td>{{ t(`comparison.platforms.${action.platform}`) }}</td><td>{{ action.round_num }}</td>
                  <td><span>{{ action.agent_id }}</span><span v-if="action.agent_name !== null" class="agent-name literal">{{ action.agent_name }}</span></td>
                  <td class="literal">{{ action.action_type }}</td><td class="literal">{{ action.timestamp ?? t('savedActivityFiles.unknown') }}</td>
                  <td>{{ t(`savedActivity.outcomes.${action.success === true ? 'success' : action.success === false ? 'failed' : 'unknown'}`) }}</td>
                  <td><template v-if="action.match_preview !== null"><p class="note">{{ t('savedActivity.matchPreview') }}</p><pre :data-testid="`match-preview-${action.record_id}`">{{ action.match_preview }}</pre></template><details><summary>{{ t('savedActivity.details') }}</summary><p class="record-id">{{ action.record_id }}</p><pre :data-testid="`details-${action.record_id}`">{{ action.details_json }}</pre></details></td>
                </tr></tbody>
              </table>
            </div>
            <p v-else data-testid="empty-state" class="notice">{{ t(`savedActivityFiles.${entry.page.matched_count === null ? 'unavailable' : entry.page.matched_count === 0 ? 'noMatches' : 'outOfRange'}`) }}</p>
          </template>
        </section>
        <p v-if="!view.accepted" class="note">{{ t('savedActivityFiles.empty') }}</p>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { SAVED_ACTIVITY_FILE_MAX_BYTES, readSavedActivityFile } from '../utils/savedActivityFiles.js'

const { t, locale } = useI18n(), route = useRoute()
const fileLimitMiB = SAVED_ACTIVITY_FILE_MAX_BYTES / (1024 * 1024)
const platforms = ['twitter', 'reddit']
const contextFields = ['created_at', 'updated_at', 'started_at', 'completed_at', 'requested_rounds', 'last_saved_round']
const columns = ['platform', 'round', 'agent', 'actionType', 'timestamp', 'outcome', 'details']
const filterFields = [{ key: 'platform', label: 'platform' }, { key: 'agent_id', label: 'agentId' }, { key: 'round_num', label: 'round' }, { key: 'action_type', label: 'actionType' }, { key: 'q', label: 'phrase' }, { key: 'case_sensitive', label: 'caseSensitive' }, { key: 'outcome', label: 'outcome' }]
const emptyPending = { loading: false, preview: null, filename: '', error: null }
const state = shallowRef({ accepted: null, ...emptyPending })
let disposed = false, downloadUrl = null
function owns(owned) { return !disposed && state.value === owned }
function revokeDownload() { if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null } }
function update(owned, changes) {
  if (!owns(owned)) return null
  revokeDownload()
  state.value = { ...owned, ...changes }
  return state.value
}
async function selectFile(owned, event) {
  if (!owns(owned)) return
  // Native picker resets may clear the live FileList. Save both values first.
  const count = event.target.files?.length ?? 0, file = event.target.files?.[0]
  event.target.value = ''
  const reading = update(owned, { ...emptyPending, loading: count > 0 })
  if (!count) return
  try {
    if (count !== 1 || typeof file?.name !== 'string' || file.name.length > 1024 || [...file.name].length > 512 || new TextEncoder().encode(file.name).length > 2048) throw new Error('Invalid file')
    const filename = file.name, preview = await readSavedActivityFile(file)
    update(reading, { loading: false, filename, preview })
  } catch { update(reading, { ...emptyPending, error: 'invalid' }) }
}
function openFile(owned) {
  if (!owns(owned) || !owned.preview) return
  update(owned, { ...emptyPending, accepted: { page: owned.preview, filename: owned.filename } })
}
function download(owned) {
  if (!owns(owned) || !owned.accepted) return
  revokeDownload()
  let link
  try {
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(owned.accepted.page, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }))
    link = document.createElement('a'); link.href = downloadUrl; link.download = 'mirofish-saved-activity-page.json'
    document.body.appendChild(link); link.click()
  } catch { update(owned, { ...emptyPending, error: 'download' }) }
  finally { link?.remove() }
}
// Each rendered handler owns its exact immutable state revision. Old controls
// and late reads cannot adopt, clear or export a newer page, even after unmount.
const views = computed(() => {
  const owned = state.value
  const evidence = []
  if (owned.preview) evidence.push({ kind: 'preview', page: owned.preview, filename: owned.filename })
  if (owned.accepted) evidence.push({ kind: 'accepted', ...owned.accepted })
  return [{ ...owned, evidence,
    select: event => selectFile(owned, event), open: () => openFile(owned),
    cancel: () => update(owned, emptyPending), clear: () => update(owned, { accepted: null, ...emptyPending }),
    download: () => download(owned),
  }]
})
function filterValue(filters, key) {
  if (filters[key] === null) return t('savedActivity.any')
  if (key === 'case_sensitive') return t(`savedActivityFiles.${filters[key] ? 'yes' : 'no'}`)
  if (key === 'platform') return t(`comparison.platforms.${filters[key]}`)
  if (key === 'outcome') return t(`savedActivity.outcomes.${filters[key]}`)
  return filters[key]
}
function warningLabel(warning) {
  const platform = warning.platform ? t(`comparison.platforms.${warning.platform}`) : ''
  return t(`comparison.warnings.${warning.code}`, { platform, count: warning.count ?? '' })
}
function setLanguage(value) { if (!disposed && ['en', 'zh'].includes(value)) locale.value = value }
watch(() => route.fullPath, () => { update(state.value, { accepted: null, ...emptyPending }) }, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true; revokeDownload(); state.value = { accepted: null, ...emptyPending } })
</script>

<style scoped>
.activity-files-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions, .language-choice { display: flex; align-items: center; gap: 16px; font-size: 14px; }a { color: #394555; }
main { max-width: 1180px; margin: auto; padding: 38px 24px 60px; }.page-heading { max-width: 880px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 21px; margin: 0 0 14px; }h3 { font-size: 17px; margin-top: 26px; }p { line-height: 1.6; }.page-heading > p { color: #59616d; font-size: 14px; }
.panel { min-width: 0; background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 24px; }.evidence { margin-top: 26px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; max-width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 7px; padding: 10px; font: inherit; font-size: 14px; background: #fff; color: #202329; }input { width: 100%; }.language-choice { margin: 0; }.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 12px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; font-size: 13px; }.notice.error { background: #fff0ed; color: #9a3527; }.literal, pre { white-space: pre-wrap; overflow-wrap: anywhere; }.provenance { color: #496557; font-size: 13px; font-weight: 600; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.metadata { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }.warnings { font-size: 13px; padding-left: 20px; }.warnings li { margin-bottom: 12px; }.warnings code { display: block; margin-top: 5px; color: #68707c; }.table-scroll { overflow-x: auto; }table { border-collapse: collapse; width: 100%; min-width: 880px; table-layout: fixed; font-size: 13px; text-align: left; }caption { text-align: left; color: #68707c; padding: 8px 0 16px; font-size: 12px; }th, td { border-bottom: 1px solid #e6e9ee; padding: 14px 10px; overflow-wrap: anywhere; vertical-align: top; }th:last-child { width: 30%; }thead { color: #68707c; font-size: 12px; }.agent-name { display: block; margin-top: 6px; color: #68707c; }summary { cursor: pointer; padding: 6px 0; }pre { font-size: 12px; }.record-id { color: #68707c; font-size: 12px; }
@media (max-width: 720px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; flex-wrap: wrap; }main { padding: 26px 16px; }.panel { padding: 18px; }.section-heading { flex-direction: column; align-items: flex-start; }.metadata { grid-template-columns: minmax(0, 1fr); gap: 6px; }dd { margin-bottom: 10px; } }
</style>
