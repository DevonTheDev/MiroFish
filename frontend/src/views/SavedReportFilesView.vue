<template>
  <div class="reports-page">
    <header class="app-header">
      <RouterLink to="/" class="brand">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink to="/">{{ t('savedReports.home') }}</RouterLink><RouterLink to="/reports">{{ t('savedReports.navTitle') }}</RouterLink><label class="language-choice">{{ t('savedReportFiles.language') }}<select data-testid="file-language" :value="locale" @change="setLanguage($event.target.value)"><option value="en">English</option><option value="zh">中文</option></select></label></div>
    </header>
    <main>
      <div class="page-heading"><p class="eyebrow">{{ t('savedReportFiles.eyebrow') }}</p><h1>{{ t('savedReportFiles.title') }}</h1><p>{{ t('savedReportFiles.scope') }}</p><p class="note">{{ t('savedReportFiles.session') }}</p></div>
      <template v-for="view in views" :key="'file-state'">
        <section class="panel" :aria-label="t('savedReportFiles.choose')">
          <label for="report-file">{{ t('savedReportFiles.choose') }}</label><input id="report-file" data-testid="report-file" type="file" accept="application/json,.json" :onChange="view.select" aria-describedby="report-file-note" />
          <p id="report-file-note" class="note">{{ t('savedReportFiles.fileNote', { bytes: fileLimit }) }}</p>
          <div class="actions"><button v-if="view.loading || view.preview" type="button" data-testid="cancel-file" :onClick="view.cancel">{{ t('savedReportFiles.cancel') }}</button><button type="button" data-testid="clear-file" :disabled="!view.accepted && !view.preview && !view.loading && !view.error" :onClick="view.clear">{{ t('savedReportFiles.clear') }}</button></div>
          <p class="note">{{ t('savedReportFiles.clearNote') }}</p>
          <p v-if="view.loading" role="status" data-testid="file-loading">{{ t('savedReportFiles.loading') }}</p>
          <p v-if="view.error" role="alert" class="notice error" data-testid="file-error">{{ t('savedReportFiles.invalid') }}</p>
          <p v-if="downloadError" role="alert" class="notice error" data-testid="download-error">{{ t('savedReportFiles.downloadError') }}</p>
        </section>
        <article v-for="entry in view.evidence" :key="entry.kind" class="panel evidence" :data-testid="entry.kind === 'preview' ? 'file-preview' : 'accepted-file'">
          <div class="reader-heading"><h2>{{ t(`savedReportFiles.${entry.kind}`) }}</h2><button v-if="entry.kind === 'preview'" class="primary" type="button" data-testid="open-file" :onClick="view.open">{{ t('savedReportFiles.open') }}</button></div>
          <p class="notice">{{ t('savedReportFiles.provenance') }}</p>
          <dl>
            <dt>{{ t('savedReportFiles.filename') }}</dt><dd class="literal" :data-testid="`${entry.kind}-filename`">{{ entry.filename }}</dd>
            <template v-for="field in fields" :key="field.key"><dt>{{ t(field.label) }}</dt><dd class="literal" :data-testid="`${entry.kind}-${field.key.replaceAll('_', '-')}`">{{ entry.observation[field.key] ?? '—' }}</dd></template>
          </dl>
          <p v-if="!entry.observation.content_available" role="status" class="notice" :data-testid="`${entry.kind}-content-error`">{{ t(`savedReports.contentErrors.${entry.observation.content_error}`) }}</p>
          <template v-if="entry.kind === 'accepted'">
            <div class="actions"><button type="button" data-testid="download-file" :onClick="view.downloadJson">{{ t('savedReportFiles.download') }}</button><button type="button" data-testid="download-markdown" :disabled="!entry.observation.content_available" :onClick="view.downloadMarkdown">{{ t('savedReports.download') }}</button></div>
            <SavedReportReader :source="entry.observation" :is-current="isCurrentSource" />
          </template>
        </article>
        <p v-if="!view.accepted" class="note">{{ t('savedReportFiles.empty') }}</p>
      </template>
      <SavedReportComparison :key="session.key" :is-active="isActiveSession" :source="state.accepted?.observation ?? null" :is-current="isCurrentSource" />
    </main>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SavedReportReader from '../components/SavedReportReader.vue'
import SavedReportComparison from '../components/SavedReportComparison.vue'
import { SAVED_REPORT_FILE_MAX_BYTES, createSavedReportFile, readSavedReportFile } from '../utils/savedReportFiles.js'

const { t, locale } = useI18n(), route = useRoute()
const fileLimit = SAVED_REPORT_FILE_MAX_BYTES
const fields = [
  ['report_id', 'reportId'], ['simulation_id', 'simulationId'], ['title', 'title'],
  ['summary_preview', 'summaryPreview'], ['requirement_preview', 'requirementPreview'],
  ['status', 'status'], ['created_at', 'createdAt'], ['completed_at', 'completedAt'],
  ['source', 'source'], ['observed_at', 'capturedAt'], ['metadata_revision', 'metadataRevision'],
  ['content_source', 'contentSource'], ['content_bytes', 'contentBytes'], ['content_revision', 'contentRevision'],
].map(([key, label]) => ({ key, label: key === 'title' ? 'savedReportFiles.reportTitle' : `savedReports.${label}` }))
const emptyPending = { loading: false, preview: null, filename: '', error: false }
const state = shallowRef({ accepted: null, ...emptyPending }), downloadError = shallowRef(false), session = shallowRef({ key: 0, path: route.fullPath })
let disposed = false, resource = null
const isActiveSession = computed(() => {
  const owned = session.value
  return () => !disposed && session.value === owned && route.fullPath === owned.path
})
function owns(owned) { return !disposed && state.value === owned }
function isCurrentSource(source) { return !disposed && source === state.value.accepted?.observation }
// Clear references before calling host methods: a reentrant export owns separate
// resources, even when an earlier URL/anchor operation returns or throws later.
function release(current) {
  if (!current) return
  if (resource === current) resource = null
  const link = current.link, url = current.url
  current.link = null; current.url = null
  try { link?.remove() } catch { /* Still release this operation's URL. */ }
  try { if (url) URL.revokeObjectURL(url) } catch { /* Never disturb a newer owner. */ }
}
function update(owned, changes) {
  if (!owns(owned)) return null
  const next = { ...owned, ...changes }
  state.value = next; downloadError.value = false
  const previous = resource; release(previous)
  return next
}
async function selectFile(owned, event) {
  if (!owns(owned)) return
  // Resetting a native input can empty its live FileList immediately.
  const count = event.target.files?.length ?? 0, file = event.target.files?.[0]
  event.target.value = ''
  const reading = update(owned, { ...emptyPending, loading: count > 0 })
  if (!count || !owns(reading)) return
  try {
    if (count !== 1 || typeof file?.name !== 'string' || file.name.length > 1024 || [...file.name].length > 512 || new TextEncoder().encode(file.name).length > 2048) throw new Error('Invalid file')
    const filename = file.name, preview = await readSavedReportFile(file)
    update(reading, { loading: false, filename, preview })
  } catch { update(reading, { ...emptyPending, error: true }) }
}
function openFile(owned) {
  if (!owns(owned) || !owned.preview) return
  update(owned, { ...emptyPending, accepted: Object.freeze({ observation: owned.preview, filename: owned.filename }) })
}
function download(owned, markdown) {
  if (!owns(owned) || !owned.accepted || (markdown && !owned.accepted.observation.content_available)) return
  const saved = owned.accepted.observation, previous = resource, current = { url: null, link: null }
  resource = current; release(previous)
  const currentOwner = () => owns(owned) && resource === current && isCurrentSource(saved)
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
  } catch { if (currentOwner()) downloadError.value = true; release(current) }
  finally { if (!currentOwner()) release(current) }
}
// Choosing a replacement owns only file state. The accepted source and reader
// retain their identity while reads, previews, search and language changes occur.
const views = computed(() => {
  const owned = state.value, evidence = []
  if (owned.preview) evidence.push({ kind: 'preview', observation: owned.preview, filename: owned.filename })
  if (owned.accepted) evidence.push({ kind: 'accepted', ...owned.accepted })
  return [{ ...owned, evidence, select: event => selectFile(owned, event), open: () => openFile(owned),
    cancel: () => update(owned, emptyPending), clear: () => update(owned, { accepted: null, ...emptyPending }),
    downloadJson: () => download(owned, false), downloadMarkdown: () => download(owned, true) }]
})
function setLanguage(value) { if (!disposed && ['en', 'zh'].includes(value)) locale.value = value }
watch(() => route.fullPath, () => { session.value = { key: session.value.key + 1, path: route.fullPath }; update(state.value, { accepted: null, ...emptyPending }) }, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true; state.value = { accepted: null, ...emptyPending }; release(resource) })
</script>

<style scoped>
.reports-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions, .language-choice { display: flex; align-items: center; gap: 16px; font-size: 14px; }a { color: #394555; }
main { max-width: 1120px; margin: auto; padding: 36px 24px 60px; }.page-heading { max-width: 880px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 20px; }p { line-height: 1.6; }
.panel { min-width: 0; background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 22px; }.evidence { margin-top: 26px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; max-width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; background: #fff; color: #202329; }input { width: 100%; }.language-choice { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 13px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; }.error { background: #fff0ed; color: #9a3527; }.reader-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 3fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 700px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; flex-wrap: wrap; }main { padding: 24px 14px; }.panel { padding: 16px; }.reader-heading { align-items: flex-start; flex-direction: column; }dl { grid-template-columns: minmax(0, 1fr); gap: 6px; }dd { margin-bottom: 10px; } }
</style>
