<template>
  <section class="comparison" data-testid="report-comparison" :aria-label="t('savedReportComparison.title')">
    <div class="heading"><h2>{{ t('savedReportComparison.title') }}</h2><div class="actions">
      <button type="button" data-testid="comparison-swap" :disabled="!pair.left || !pair.right" :onClick="pairActions.swap">{{ t('savedReportComparison.swap') }}</button>
      <button type="button" data-testid="comparison-clear" :disabled="!pair.left && !pair.right" :onClick="pairActions.clear">{{ t('savedReportComparison.clear') }}</button>
    </div></div>
    <p class="note">{{ t('savedReportComparison.scope') }}</p>
    <p class="note">{{ t('savedReportComparison.instructions') }}</p>
    <p v-if="downloadError" role="alert" class="notice" data-testid="comparison-download-error">{{ t('savedReportComparison.downloadError') }}</p>
    <div class="panes">
      <article v-for="slot in slots" :key="slot.side" class="pane" :data-testid="`comparison-${slot.side}`">
        <div class="heading"><h3>{{ t(`savedReportComparison.${slot.side}`) }}</h3><button type="button" :data-testid="`capture-${slot.side}`" :disabled="!source" @click="slot.capture">{{ t(`savedReportComparison.${slot.saved ? 'replace' : 'capture'}`) }}</button></div>
        <template v-if="slot.saved">
          <h4>{{ slot.saved.title || t('savedReports.untitled') }}</h4>
          <dl>
            <dt>{{ t('savedReports.reportId') }}</dt><dd>{{ slot.saved.report_id }}</dd>
            <dt>{{ t('savedReports.status') }}</dt><dd>{{ t(`savedReports.statuses.${slot.saved.status}`) }}</dd>
            <dt>{{ t('savedReports.capturedAt') }}</dt><dd>{{ slot.saved.observed_at }}</dd>
            <dt>{{ t('savedReports.source') }}</dt><dd>{{ t(`savedReports.sources.${slot.saved.source}`) }}</dd>
            <dt>{{ t('savedReports.metadataRevision') }}</dt><dd>{{ slot.saved.metadata_revision }}</dd>
            <dt>{{ t('savedReports.contentSource') }}</dt><dd>{{ slot.saved.content_source ? t(`savedReports.contentSources.${slot.saved.content_source.replace('.', '_')}`) : t('savedReportComparison.unknown') }}</dd>
            <dt>{{ t('savedReports.contentBytes') }}</dt><dd>{{ slot.saved.content_bytes ?? t('savedReportComparison.unknown') }}</dd>
            <dt>{{ t('savedReports.contentRevision') }}</dt><dd>{{ slot.saved.content_revision ?? t('savedReportComparison.unknown') }}</dd>
          </dl>
          <div class="actions"><button type="button" :data-testid="`comparison-${slot.side}-download`" :disabled="!slot.saved.content_available" @click="slot.download">{{ t('savedReportComparison.download') }}</button><button type="button" :data-testid="`comparison-${slot.side}-download-json`" @click="slot.downloadJson">{{ t('savedReportComparison.downloadJson') }}</button><button type="button" :data-testid="`comparison-${slot.side}-clear`" @click="slot.clear">{{ t('savedReportComparison.clearSide') }}</button></div>
          <p v-if="!slot.saved.content_available" class="notice" :data-testid="`comparison-${slot.side}-unavailable`">{{ t(`savedReports.contentErrors.${slot.saved.content_error}`) }}</p>
          <template v-else>
            <p v-if="slot.preview.truncated" class="notice" :data-testid="`comparison-${slot.side}-truncated`">{{ t('savedReportComparison.truncated') }}</p>
            <p v-if="slot.saved.markdown_content === ''" class="note">{{ t('savedReports.emptyContent') }}</p>
            <pre tabindex="0" :aria-label="t('savedReportComparison.textLabel', { side: t(`savedReportComparison.${slot.side}`) })" :data-testid="`comparison-${slot.side}-text`">{{ slot.preview.text }}</pre>
          </template>
        </template>
        <p v-else class="note">{{ t('savedReportComparison.emptySlot') }}</p>
      </article>
    </div>
    <template v-if="pair.left && pair.right">
      <p role="status" class="notice" data-testid="comparison-status" :data-status="comparison.status">{{ t(`savedReportComparison.results.${comparison.status}`, { added: comparison.added, removed: comparison.removed }) }}<span v-if="comparison.reason"> {{ t(`savedReportComparison.limits.${comparison.reason}`) }}</span></p>
      <div v-if="comparison.status === 'different'" class="changes" data-testid="comparison-diff" tabindex="0" :aria-label="t('savedReportComparison.changes')">
        <p class="note">{{ t('savedReportComparison.lineNote') }}</p>
        <div v-for="(row, index) in comparison.rows" :key="index" class="change" :class="row.kind" :data-kind="row.kind">
          <span class="line-number">{{ row.leftLine ?? '—' }} / {{ row.rightLine ?? '—' }}</span><span class="kind">{{ t(`savedReportComparison.kinds.${row.kind}`) }}</span><pre>{{ row.text }}</pre><span class="ending">{{ row.text === '' ? t('savedReportComparison.blank') + ' · ' : '' }}{{ t(`savedReportComparison.endings.${row.ending}`) }}</span>
        </div>
      </div>
    </template>
    <p v-else class="note">{{ t('savedReportComparison.needPair') }}</p>
  </section>
</template>

<script setup>
import { computed, shallowRef, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { compareCapturedText, previewCapturedText } from '../utils/savedReportComparison.js'
import { createSavedReportFile } from '../utils/savedReportFiles.js'

const props = defineProps({ source: { type: Object, default: null }, isCurrent: { type: Function, required: true }, isActive: { type: Function, default: null } })
const { t } = useI18n()
const pair = shallowRef(Object.freeze({ left: null, right: null }))
const downloadError = shallowRef(false)
let disposed = false
const downloads = new Map()
function revoke(side, current = downloads.get(side)) {
  if (!current) return
  if (downloads.get(side) === current) downloads.delete(side)
  const timer = current.timer, link = current.link, url = current.url
  current.timer = null; current.link = null; current.url = null
  if (timer !== null) clearTimeout(timer)
  try { link?.remove() } catch { /* Still release this download's URL. */ }
  try { if (url) URL.revokeObjectURL(url) } catch { /* A newer owner stays independent. */ }
}
function owns(snapshot) { return !disposed && pair.value === snapshot && (!props.isActive || props.isActive()) }
function replace(snapshot, next) {
  if (!owns(snapshot)) return
  const previous = [...downloads.entries()]
  pair.value = Object.freeze(next); downloadError.value = false
  previous.forEach(([side, current]) => revoke(side, current))
}
function capture(snapshot, source, side) {
  // isCurrent also checks the parent synchronously, before Vue propagates a
  // retired reader's null prop. ID equality alone cannot protect A → B → A.
  if (!owns(snapshot) || !source || !props.isCurrent(source)) return
  replace(snapshot, { ...snapshot, [side]: Object.freeze({ ...source }) })
}
function download(snapshot, side, markdown) {
  const saved = snapshot[side]
  if (!owns(snapshot) || !saved || (markdown && !saved.content_available)) return
  const previous = downloads.get(side) ?? null, current = { url: null, link: null, timer: null }
  downloads.set(side, current); revoke(side, previous)
  const currentOwner = () => owns(snapshot) && downloads.get(side) === current
  try {
    if (!currentOwner()) return
    downloadError.value = false
    const body = markdown ? saved.markdown_content : createSavedReportFile(saved)
    current.url = URL.createObjectURL(new Blob([body], { type: markdown ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8' }))
    if (!currentOwner()) return
    current.link = document.createElement('a')
    if (!currentOwner()) return
    current.link.href = current.url
    current.link.download = markdown ? `${saved.report_id}-${side}-${saved.content_revision.slice(0, 12)}.md`
      : `${saved.report_id}-${side}-${saved.metadata_revision.slice(0, 12)}-${saved.content_revision?.slice(0, 12) ?? 'unavailable'}.observation.json`
    document.body.appendChild(current.link)
    if (!currentOwner()) return
    current.link.click()
    if (!currentOwner()) return
    const link = current.link; current.link = null; link.remove()
    if (!currentOwner()) return
    current.timer = setTimeout(() => { if (downloads.get(side) === current) revoke(side, current) }, 1000)
  } catch { if (currentOwner()) downloadError.value = true; revoke(side, current) }
  finally { if (!currentOwner()) revoke(side, current) }
}
// Bind handlers to exactly the pair and reader that produced this render.
// A retired DOM callback must never operate on a replacement with the same ID.
const slots = computed(() => {
  const snapshot = pair.value, source = props.source
  return ['left', 'right'].map(side => {
    const saved = snapshot[side]
    return { side, saved, preview: saved?.content_available ? previewCapturedText(saved.markdown_content) : null,
      capture: () => capture(snapshot, source, side), clear: () => replace(snapshot, { ...snapshot, [side]: null }),
      download: () => download(snapshot, side, true), downloadJson: () => download(snapshot, side, false) }
  })
})
const pairActions = computed(() => {
  const snapshot = pair.value
  return { swap: () => { if (snapshot.left && snapshot.right) replace(snapshot, { left: snapshot.right, right: snapshot.left }) },
    clear: () => replace(snapshot, { left: null, right: null }) }
})
const comparison = computed(() => compareCapturedText(pair.value.left?.markdown_content, pair.value.right?.markdown_content))
onBeforeUnmount(() => { disposed = true; revoke('left'); revoke('right'); pair.value = Object.freeze({ left: null, right: null }) })
</script>

<style scoped>
.comparison { margin-top: 40px; }h2 { font-size: 20px; }h3 { font-size: 18px; }h4 { font-size: 16px; overflow-wrap: anywhere; }.heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }.actions { display: flex; flex-wrap: wrap; gap: 10px; }.panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }.pane { min-width: 0; padding: 20px; background: white; border: 1px solid #e1e5eb; border-radius: 12px; }
.note { color: #68707c; font-size: 13px; line-height: 1.6; }.notice { background: #edf1f6; padding: 14px; border-radius: 8px; line-height: 1.6; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 14px; font: inherit; font-size: 14px; min-height: 44px; }button:disabled { opacity: .45; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button:focus-visible, pre:focus-visible, .changes:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
dl { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); gap: 9px; font-size: 12px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 13px/1.65 monospace; max-height: 440px; overflow: auto; tab-size: 4; }.changes { max-height: 600px; overflow: auto; border: 1px solid #d7dde5; padding: 12px; background: #fff; }.change { display: grid; grid-template-columns: 6em 5em minmax(0, 1fr); gap: 8px; padding: 7px; border-bottom: 1px solid #e5e7eb; }.change pre { margin: 0; }.line-number, .kind, .ending { font-size: 12px; }.ending { grid-column: 3; color: #535e6e; }.added { background: #e6f4ec; }.removed { background: #fff0ed; }
@media (max-width: 700px) { .panes { grid-template-columns: 1fr; }.pane { padding: 14px; }.change { grid-template-columns: 5em minmax(0, 1fr); }.change pre, .ending { grid-column: 1 / -1; } }
</style>
