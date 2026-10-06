<template>
  <div class="capture-files-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <div class="header-actions">
        <RouterLink to="/captures">{{ t('runCaptures.title') }}</RouterLink>
        <label class="language-choice">{{ t('runCaptureFiles.language') }}
          <select data-testid="file-language" :value="locale" @change="setLanguage($event.target.value)"><option value="en">English</option><option value="zh">中文</option></select>
        </label>
      </div>
    </header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('runCaptureFiles.eyebrow') }}</p><h1>{{ t('runCaptureFiles.title') }}</h1><p>{{ t('runCaptureFiles.scope') }}</p><p class="note">{{ t('runCaptureFiles.sessionNote') }}</p></header>
      <template v-for="view in views" key="session">
        <section class="panel" aria-labelledby="capture-file-heading">
          <h2 id="capture-file-heading">{{ t('runCaptureFiles.openTitle') }}</h2>
          <label for="capture-file">{{ t('runCaptureFiles.file') }}</label>
          <input id="capture-file" data-testid="capture-file" type="file" accept=".json,application/json" aria-describedby="capture-file-hint" @change="view.select" />
          <p id="capture-file-hint" class="note">{{ t('runCaptureFiles.fileHint', { limit: fileLimitMiB }) }}</p>
          <p v-if="view.loading" data-testid="file-loading" role="status">{{ t('runCaptureFiles.loading') }}</p>
          <p v-if="view.error" data-testid="file-error" class="notice error" role="alert">{{ t(`runCaptureFiles.errors.${view.error}`) }}</p>
          <div v-if="view.loading || view.preview || view.error" class="actions"><button type="button" data-testid="cancel-file" @click="view.cancel">{{ t('runCaptureFiles.cancel') }}</button></div>
          <section v-if="view.preview" data-testid="file-preview" class="preview" aria-labelledby="capture-preview-heading">
            <h3 id="capture-preview-heading">{{ t('runCaptureFiles.preview') }}</h3>
            <p class="notice">{{ t('runCaptureFiles.unverified') }}</p>
            <p class="note">{{ t('runCaptureFiles.filename') }}: <span class="literal" data-testid="preview-filename">{{ view.filename }}</span></p>
            <p v-if="view.preview.kind === 'comparison'" data-testid="historical-comparison-time" class="note">{{ t('runCaptureFiles.historicalComparedAt') }}: {{ view.preview.generated_at }}</p>
            <div class="capture-grid" :class="{ single: view.preview.captures.length === 1 }">
              <article v-for="(capture, index) in view.preview.captures" :key="capture.capture_id" class="capture-card" :data-testid="`preview-capture-${index}`">
                <p class="provenance">{{ t('runCaptureFiles.historical') }}</p>
                <p v-if="view.preview.kind === 'comparison'">{{ t(`runCaptures.${sides[index]}`) }}</p>
                <p class="settings-label">{{ t('runCaptureFiles.savedSettings') }}</p>
                <RunCaptureObservation :capture="capture" :observation="capture.observation" />
                <dl><dt>{{ t('runCaptureFiles.sourceRevision') }}</dt><dd>{{ capture.observation.source_revision }}</dd></dl>
              </article>
            </div>
            <div class="actions">
              <template v-if="view.preview.kind === 'capture'"><button type="button" class="primary" data-testid="use-left" @click="view.useLeft">{{ t('runCaptures.chooseLeft') }}</button><button type="button" class="primary" data-testid="use-right" @click="view.useRight">{{ t('runCaptures.chooseRight') }}</button></template>
              <button v-else type="button" class="primary" data-testid="use-both" @click="view.useBoth">{{ t('runCaptureFiles.useBoth') }}</button>
            </div>
            <p class="note">{{ t(view.preview.kind === 'comparison' ? 'runCaptureFiles.replaceBoth' : 'runCaptureFiles.replaceSide') }}</p>
          </section>
        </section>
        <section class="accepted" aria-labelledby="accepted-heading">
          <div class="section-heading"><h2 id="accepted-heading">{{ t('runCaptureFiles.acceptedTitle') }}</h2><div class="actions"><button type="button" data-testid="swap-files" :disabled="!view.canCompare" @click="view.swap">{{ t('comparison.swap') }}</button><button type="button" data-testid="clear-files" :disabled="!view.hasFiles && !view.loading && !view.preview" @click="view.clearAll">{{ t('runCaptureFiles.clearAll') }}</button></div></div>
          <div class="capture-grid">
            <section v-for="side in sides" :key="side" class="panel" :data-testid="`accepted-${side}`">
              <h3>{{ t(`runCaptures.${side}`) }}</h3>
              <template v-if="view.slots[side]">
                <p class="provenance">{{ t('runCaptureFiles.historical') }}</p>
                <p class="note">{{ t('runCaptureFiles.filename') }}: <span class="literal" :data-testid="`filename-${side}`">{{ view.slots[side].filename }}</span></p>
                <p class="notice">{{ t('runCaptureFiles.unverified') }}</p>
                <p class="settings-label">{{ t('runCaptureFiles.savedSettings') }}</p>
                <RunCaptureObservation :capture="view.slots[side].capture" :observation="view.slots[side].capture.observation" />
                <dl><dt>{{ t('runCaptureFiles.sourceRevision') }}</dt><dd>{{ view.slots[side].capture.observation.source_revision }}</dd></dl>
                <div class="actions"><button type="button" :data-testid="`download-${side}`" @click="view.downloadSide[side]">{{ t('runCaptures.downloadCapture') }}</button><button type="button" :data-testid="`clear-${side}`" @click="view.clearSide[side]">{{ t('runCaptureFiles.clearSide') }}</button></div>
              </template>
              <p v-else class="note">{{ t('runCaptureFiles.emptySide') }}</p>
            </section>
          </div>
        </section>
        <section class="comparison" aria-labelledby="file-comparison-heading">
          <h2 id="file-comparison-heading">{{ t('runCaptures.compareTitle') }}</h2>
          <p class="note">{{ t('runCaptures.duplicateSelection') }}</p>
          <p class="reading-note">{{ t('comparison.interpretation') }} {{ t('comparison.unavailableNote') }}</p>
          <div class="actions"><button type="button" class="primary" data-testid="compare-files" :disabled="!view.canCompare" @click="view.compare">{{ t('comparison.compare') }}</button><button type="button" data-testid="download-file-comparison" :disabled="!view.comparison" @click="view.downloadComparison">{{ t('runCaptures.downloadComparison') }}</button></div>
          <section v-if="view.comparison" data-testid="file-comparison" class="panel metrics">
            <p class="provenance">{{ t('runCaptureFiles.computedHere') }}</p><p data-testid="local-comparison-time" class="note">{{ t('runCaptures.comparedAt') }}: {{ view.comparison.generated_at }}</p>
            <h3>{{ t('comparison.recordedActivity') }}</h3><p class="note">{{ t('comparison.differenceNote') }}</p>
            <div class="table-scroll" tabindex="0" :aria-label="t('comparison.recordedActivity')"><table><caption>{{ t('runCaptures.metricsCaption') }}</caption><thead><tr><th scope="col">{{ t('comparison.metric') }}</th><th scope="col">{{ t('runCaptures.left') }}</th><th scope="col">{{ t('runCaptures.right') }}</th><th scope="col">{{ t('comparison.difference') }}</th></tr></thead><tbody>
              <tr v-for="metric in globalMetrics" :key="metric" :data-testid="`file-metric-${metric}`"><th scope="row">{{ t(`comparison.metrics.${metric}`) }}</th><td v-for="side in sides" :key="side">{{ count(view.comparison[side].observation.summary.metrics[metric]) }}</td><td>{{ difference(view.comparison.differences[metric]) }}</td></tr>
              <template v-for="platform in platforms" :key="platform"><tr class="platform-row"><th scope="row">{{ t(`comparison.platforms.${platform}`) }}</th><td v-for="side in sides" :key="side">{{ t(`comparison.availability.${view.comparison[side].observation.summary.metrics.platforms[platform].availability}`) }}</td><td>—</td></tr><tr v-for="metric in platformMetrics" :key="metric" :data-testid="`file-metric-${platform}-${metric}`"><th scope="row">{{ t(`comparison.platforms.${platform}`) }} · {{ t(`comparison.metrics.${metric}`) }}</th><td v-for="side in sides" :key="side">{{ count(view.comparison[side].observation.summary.metrics.platforms[platform][metric]) }}</td><td>{{ difference(view.comparison.differences.platforms[platform][metric]) }}</td></tr></template>
            </tbody></table></div><p class="note">{{ t('comparison.agentNote') }}</p>
            <h3>{{ t('comparison.actionTypes') }}</h3>
            <div v-if="view.comparison.differences.action_types.length" class="table-scroll" tabindex="0" :aria-label="t('comparison.actionTypes')"><table><caption>{{ t('comparison.actionTypesCaption') }}</caption><thead><tr><th scope="col">{{ t('comparison.actionType') }}</th><th scope="col">{{ t('runCaptures.left') }}</th><th scope="col">{{ t('runCaptures.right') }}</th><th scope="col">{{ t('comparison.difference') }}</th></tr></thead><tbody><tr v-for="row in view.comparison.differences.action_types" :key="row.action_type" data-testid="file-action-row"><th scope="row">{{ row.action_type }}</th><td>{{ count(row.left) }}</td><td>{{ count(row.right) }}</td><td>{{ difference(row.difference) }}</td></tr></tbody></table></div><p v-else class="note">{{ t('comparison.noActionTypes') }}</p>
          </section>
        </section>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import RunCaptureObservation from '../components/RunCaptureObservation.vue'
import { RUN_CAPTURE_FILE_MAX_BYTES, readRunCaptureFile, compareRunCaptureFiles } from '../utils/runCaptureFiles.js'

const { t, locale } = useI18n(), route = useRoute()
const sides = ['left', 'right'], platforms = ['twitter', 'reddit']
const globalMetrics = ['recorded_actions', 'rounds_with_actions'], platformMetrics = ['recorded_actions', 'active_agents']
const fileLimitMiB = RUN_CAPTURE_FILE_MAX_BYTES / (1024 * 1024)
const emptyPending = { loading: false, preview: null, filename: '', error: null }
const state = shallowRef({ token: 0, slots: { left: null, right: null }, comparison: null, ...emptyPending })
let disposed = false, downloadUrl = null
function owns(owned) { return !disposed && state.value === owned }
function revokeDownload() { if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null } }
function update(owned, changes) {
  if (!owns(owned)) return null
  revokeDownload()
  state.value = { ...owned, ...changes, token: owned.token + 1 }
  return state.value
}
function validPair(owned) { return !!owned.slots.left && !!owned.slots.right && owned.slots.left.capture.capture_id !== owned.slots.right.capture.capture_id }
async function selectFile(owned, event) {
  if (!owns(owned)) return
  // Resetting a native picker may clear its live FileList. Save these first.
  const fileCount = event.target.files?.length ?? 0, file = event.target.files?.[0]
  event.target.value = ''
  const reading = update(owned, { ...emptyPending, loading: fileCount > 0 })
  if (!fileCount) return
  try {
    if (fileCount !== 1 || typeof file?.name !== 'string' || file.name.length > 1024 || [...file.name].length > 512 || new TextEncoder().encode(file.name).length > 2048) throw new Error('Invalid file')
    const filename = file.name
    const preview = await readRunCaptureFile(file)
    update(reading, { loading: false, filename, preview })
  } catch { update(reading, { ...emptyPending, error: 'invalid' }) }
}
function useCapture(owned, side) {
  if (!owns(owned) || owned.preview?.kind !== 'capture') return
  const capture = owned.preview.captures[0], other = side === 'left' ? 'right' : 'left'
  if (owned.slots[other]?.capture.capture_id === capture.capture_id) { update(owned, { error: 'duplicate' }); return }
  update(owned, { ...emptyPending, slots: { ...owned.slots, [side]: { capture, filename: owned.filename } }, comparison: null })
}
function useBoth(owned) {
  if (!owns(owned) || owned.preview?.kind !== 'comparison') return
  const [left, right] = owned.preview.captures
  if (left.capture_id === right.capture_id) { update(owned, { error: 'duplicate' }); return }
  update(owned, { ...emptyPending, slots: { left: { capture: left, filename: owned.filename }, right: { capture: right, filename: owned.filename } }, comparison: null })
}
function clearSide(owned, side) { if (owns(owned)) update(owned, { ...emptyPending, slots: { ...owned.slots, [side]: null }, comparison: null }) }
function swap(owned) { if (owns(owned) && validPair(owned)) update(owned, { ...emptyPending, slots: { left: owned.slots.right, right: owned.slots.left }, comparison: null }) }
function compare(owned) {
  if (!owns(owned) || !validPair(owned)) return
  try { update(owned, { ...emptyPending, comparison: compareRunCaptureFiles(owned.slots.left.capture, owned.slots.right.capture) }) }
  catch { update(owned, { ...emptyPending, comparison: null, error: 'invalid' }) }
}
function download(owned, value, filename) {
  if (!owns(owned) || !value) return
  revokeDownload()
  let link
  try {
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }))
    link = document.createElement('a'); link.href = downloadUrl; link.download = filename
    document.body.appendChild(link); link.click()
  } catch { update(owned, { ...emptyPending, error: 'download' }) }
  finally { link?.remove() }
}
// Every rendered handler captures its exact revision. A stale read, preview,
// control or download can never act on a later pair, including after unmount.
const views = computed(() => {
  const owned = state.value
  return [{ ...owned, canCompare: validPair(owned), hasFiles: !!owned.slots.left || !!owned.slots.right,
    select: event => selectFile(owned, event), cancel: () => update(owned, emptyPending),
    useLeft: () => useCapture(owned, 'left'), useRight: () => useCapture(owned, 'right'), useBoth: () => useBoth(owned),
    clearAll: () => update(owned, { ...emptyPending, slots: { left: null, right: null }, comparison: null }),
    swap: () => swap(owned), compare: () => compare(owned),
    clearSide: Object.fromEntries(sides.map(side => [side, () => clearSide(owned, side)])),
    downloadSide: Object.fromEntries(sides.map(side => [side, () => download(owned, owned.slots[side]?.capture, 'mirofish-run-capture.json')])),
    downloadComparison: () => { if (validPair(owned)) download(owned, owned.comparison, 'mirofish-run-capture-comparison.json') },
  }]
})
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—' }
function difference(value) { return Number.isSafeInteger(value) ? `${value > 0 ? '+' : ''}${value}` : '—' }
function setLanguage(value) { if (!disposed && ['en', 'zh'].includes(value)) locale.value = value }
watch(() => route.fullPath, () => { update(state.value, { ...emptyPending, slots: { left: null, right: null }, comparison: null }) }, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true; revokeDownload(); state.value = { token: state.value.token + 1, slots: { left: null, right: null }, comparison: null, ...emptyPending } })
</script>

<style scoped>
.capture-files-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }.header-actions, .language-choice { display: flex; align-items: center; gap: 16px; font-size: 14px; }a { color: #394555; }
main { max-width: 1180px; margin: auto; padding: 38px 24px 60px; }.page-heading { max-width: 880px; margin-bottom: 26px; }.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #68707c; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 12px 0; }h2 { font-size: 21px; margin: 0 0 14px; }h3 { font-size: 17px; overflow-wrap: anywhere; }p { line-height: 1.6; }.page-heading > p, .reading-note { color: #59616d; font-size: 14px; }
.panel { min-width: 0; background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 24px; }.capture-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }.capture-grid.single { grid-template-columns: minmax(0, 1fr); }.capture-card { min-width: 0; border-top: 1px solid #e1e5eb; margin-top: 16px; padding-top: 12px; }label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }input, select { box-sizing: border-box; max-width: 100%; min-height: 44px; border: 1px solid #c8cfd9; border-radius: 7px; padding: 10px; font: inherit; font-size: 14px; background: #fff; color: #202329; }input { width: 100%; }.language-choice { margin: 0; }.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }button { cursor: pointer; border: 1px solid #c8cfd9; background: #fff; color: #28323f; border-radius: 7px; padding: 10px 16px; font: inherit; font-size: 14px; min-height: 44px; }button.primary { background: #222b38; color: #fff; }button:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #edf1f6; }button.primary:hover:enabled { background: #3b495e; }button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.note { color: #68707c; font-size: 12px; }.notice { background: #edf1f6; border-radius: 8px; padding: 14px 16px; font-size: 13px; }.notice.error { background: #fff0ed; color: #9a3527; }.preview { margin-top: 24px; border-top: 1px solid #e1e5eb; padding-top: 20px; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; }.provenance { color: #496557; font-size: 13px; font-weight: 600; }.settings-label { font-size: 13px; font-weight: 600; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }.section-heading .actions { margin-top: 0; }.accepted, .comparison { margin-top: 38px; }dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 10px; font-size: 13px; }dt { color: #68707c; }dd { margin: 0; overflow-wrap: anywhere; }.metrics { margin-top: 24px; }.table-scroll { overflow-x: auto; }table { border-collapse: collapse; width: 100%; font-size: 14px; text-align: right; table-layout: fixed; min-width: 560px; }caption { text-align: left; color: #68707c; padding: 8px 0 16px; font-size: 12px; }th, td { border-bottom: 1px solid #e6e9ee; padding: 14px 10px; overflow-wrap: anywhere; }th:first-child { width: 40%; text-align: left; }th { font-weight: 600; }thead { color: #68707c; font-size: 12px; }td { font-variant-numeric: tabular-nums; }.platform-row { background: #f8f9fb; color: #68707c; font-size: 12px; }
@media (max-width: 720px) { .app-header { padding: 14px 18px; flex-wrap: wrap; }.header-actions { gap: 14px; flex-wrap: wrap; }main { padding: 26px 16px; }.capture-grid { grid-template-columns: 1fr; gap: 18px; }.panel { padding: 18px; }.section-heading { flex-direction: column; align-items: flex-start; } }
</style>
