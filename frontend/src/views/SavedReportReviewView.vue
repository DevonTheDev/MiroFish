<template>
  <div class="review-page">
    <header><RouterLink to="/">MIROFISH</RouterLink><nav><RouterLink to="/reports">{{ t('savedReports.navTitle') }}</RouterLink><RouterLink to="/report-files">{{ t('savedReportFiles.title') }}</RouterLink><label>{{ t('savedReportFiles.language') }}<select data-testid="review-language" :value="locale" @change="setLanguage($event.target.value)"><option value="en">English</option><option value="zh">中文</option></select></label></nav></header>
    <main>
      <h1>{{ t('savedReportReview.title') }}</h1>
      <p class="notice">{{ t('savedReportReview.memoryNotice') }}</p>
      <p>{{ t('savedReportReview.portability') }}</p>
      <template v-for="a in rendered" :key="'workspace'">
        <section v-if="a.candidate" class="panel" data-testid="review-candidate">
          <h2>{{ t('savedReportReview.candidate') }}</h2>
          <p class="literal">{{ a.candidate.source.title }}</p><p class="literal">{{ a.candidate.source.report_id }}</p>
          <p>{{ t(a.workspace ? 'savedReportReview.replaceNotice' : 'savedReportReview.openNotice') }}</p>
          <div class="actions"><button type="button" :data-testid="a.workspace ? 'review-replace' : 'review-open'" :onClick="a.acceptCandidate">{{ t(a.workspace ? (hasAuthored(a.workspace) ? 'savedReportReview.discardReplace' : 'savedReportReview.replace') : 'savedReportReview.open') }}</button><button type="button" data-testid="review-cancel-candidate" :onClick="a.cancelCandidate">{{ t('savedReportReview.cancel') }}</button></div>
        </section>
        <p v-if="!a.workspace" data-testid="review-empty" class="notice">{{ t('savedReportReview.empty') }}</p>
        <template v-if="a.workspace">
          <section class="panel">
            <h2>{{ a.workspace.source.title }}</h2>
            <p class="notice">{{ t('savedReportReview.provenance') }}</p>
            <dl><dt>{{ t('savedReports.reportId') }}</dt><dd data-testid="review-report-id">{{ a.workspace.source.report_id }}</dd><dt>{{ t('savedReports.simulationId') }}</dt><dd>{{ displayReviewMetadata(a.workspace.source.simulation_id ?? '—') }}</dd><dt>{{ t('savedReports.capturedAt') }}</dt><dd>{{ displayReviewMetadata(a.workspace.source.observed_at) }}</dd><dt>{{ t('savedReportReview.digest') }}</dt><dd>{{ a.workspace.binding.text_sha256 }}</dd><dt>{{ t('savedReports.contentBytes') }}</dt><dd>{{ a.workspace.binding.text_bytes }}</dd></dl>
            <div class="actions"><button type="button" data-testid="review-export-source" :disabled="!!a.workspace.draft" :onClick="a.exportSource">{{ t('savedReportReview.exportSource') }}</button><button type="button" data-testid="review-export" :disabled="!!a.workspace.draft" :onClick="a.exportNotes">{{ t('savedReportReview.export') }}</button><button type="button" data-testid="review-clear" :onClick="a.askClear">{{ t('savedReportReview.clear') }}</button></div>
            <p v-if="reviewStore.state.value.feedback" role="status" data-testid="review-export-status">{{ t(`savedReportReview.${reviewStore.state.value.feedback}`) }}</p>
            <div v-if="a.clearChoice" class="notice" data-testid="review-clear-choice"><p>{{ t(hasAuthored(a.workspace) ? 'savedReportReview.clearWarning' : 'savedReportReview.clearNotice') }}</p><div class="actions"><button type="button" data-testid="review-confirm-clear" :onClick="a.confirmClear">{{ t(hasAuthored(a.workspace) ? 'savedReportReview.discardClear' : 'savedReportReview.clear') }}</button><button type="button" data-testid="review-cancel-clear" :onClick="a.cancelClear">{{ t('savedReportReview.cancel') }}</button></div></div>
          </section>
          <section class="panel" :aria-label="t('savedReportReview.notes')">
            <h2>{{ t('savedReportReview.notes') }}</h2><p>{{ t('savedReportReview.limits') }}</p>
            <button type="button" data-testid="review-add" :disabled="!!a.workspace.draft || a.workspace.notes.length >= 32" :onClick="a.add">{{ t('savedReportReview.add') }}</button>
            <p v-if="!a.workspace.notes.length">{{ t('savedReportReview.noNotes') }}</p>
            <article v-for="(note, index) in a.workspace.notes" :key="note.id" class="note-card">
              <h3>{{ anchorLabel(note.heading_start, a.workspace.headings) }}</h3><pre class="note-text" :data-testid="`review-note-${index}`">{{ note.text }}</pre>
              <div class="actions"><button type="button" :data-testid="`review-edit-${index}`" :disabled="!!a.workspace.draft" :onClick="() => a.edit(note.id)">{{ t('savedReportReview.edit') }}</button><button type="button" :data-testid="`review-remove-${index}`" :disabled="!!a.workspace.draft" :onClick="() => a.remove(note.id)">{{ t('savedReportReview.remove') }}</button><button v-if="note.heading_start !== null" type="button" :data-testid="`review-show-${index}`" :onClick="() => a.showSection(note.id, reader)">{{ t('savedReportReview.showSection') }}</button></div>
            </article>
            <div v-if="a.workspace.draft" class="editor">
              <label for="review-note-heading">{{ t('savedReportReview.anchor') }}</label><select id="review-note-heading" data-testid="review-note-heading" :value="a.workspace.draft.heading_start === null ? '' : String(a.workspace.draft.heading_start)" :onChange="event => a.anchor(event.target.value)"><option value="">{{ t('savedReportReview.general') }}</option><option v-for="heading in a.workspace.headings" :key="heading.lineStart" :value="String(heading.lineStart)">{{ anchorLabel(heading.lineStart, a.workspace.headings) }}</option></select>
              <label for="review-note-text">{{ t('savedReportReview.noteText') }}</label><textarea id="review-note-text" data-testid="review-note-text" rows="6" :value="a.workspace.draft.text" :aria-invalid="String(!!a.workspace.draftError)" aria-describedby="review-draft-help" :onInput="event => inputDraft(a, event)" />
              <p id="review-draft-help">{{ t('savedReportReview.draftNotice') }}</p><p v-if="a.workspace.draftError" role="alert" data-testid="review-draft-error">{{ t(`savedReportReview.${a.workspace.draftError}`) }}</p>
              <div class="actions"><button type="button" data-testid="review-save-note" :onClick="a.save">{{ t(a.workspace.draft.noteId === null ? 'savedReportReview.add' : 'savedReportReview.save') }}</button><button type="button" data-testid="review-discard-draft" :onClick="a.discardDraft">{{ t(draftChanged(a.workspace.draft) ? 'savedReportReview.discardDraft' : 'savedReportReview.cancel') }}</button></div>
            </div>
          </section>
          <section class="panel">
            <h2>{{ t('savedReportReview.import') }}</h2><label for="review-notes-file">{{ t('savedReportReview.chooseNotes') }}</label><input id="review-notes-file" data-testid="review-notes-file" type="file" accept="application/json,.json" :onChange="a.select" /><p>{{ t('savedReportReview.fileNotice') }}</p>
            <p v-if="a.importing?.loading" role="status">{{ t('savedReportReview.reading') }}</p><p v-if="a.importing?.error" role="alert" data-testid="review-import-error">{{ t('savedReportReview.importFailed') }}</p>
            <div v-if="a.importing?.preview" class="notice" data-testid="review-import-preview"><p class="literal">{{ a.importing.filename }}</p><p>{{ t('savedReportReview.preview', { id: a.workspace.source.report_id, count: a.importing.preview.notes.length }) }}</p><button type="button" data-testid="review-open-notes" :disabled="!!a.workspace.draft" :onClick="a.openImport">{{ t(a.workspace.notes.length ? 'savedReportReview.discardOpenNotes' : 'savedReportReview.openNotes') }}</button></div>
            <button v-if="a.importing" type="button" data-testid="review-cancel-import" :onClick="a.cancelImport">{{ t('savedReportReview.cancel') }}</button>
            <p v-if="a.workspace.draft" class="notice">{{ t('savedReportReview.draftNotice') }}</p>
          </section>
          <section class="panel"><h2>{{ t('savedReportReview.capturedReport') }}</h2><SavedReportReader :ref="rememberReader" :source="a.workspace.source" :is-current="a.isCurrentSource" /></section>
        </template>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, shallowRef, onBeforeUnmount } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SavedReportReader from '../components/SavedReportReader.vue'
import { reviewStore } from '../store/savedReportReview.js'
import { displayReviewMetadata } from '../utils/savedReportReviewNotes.js'

const { t, locale } = useI18n(), reader = shallowRef(null), view = reviewStore.enterView()
const rendered = computed(() => [reviewStore.actions(view)])
function rememberReader(instance) { reader.value = instance }
const hasAuthored = workspace => workspace.notes.length > 0 || !!workspace.draft?.text.length
const draftChanged = draft => !draft.original ? draft.text !== '' : draft.text !== draft.original.text || draft.heading_start !== draft.original.heading_start
function inputDraft(actions, event) {
  const retained = actions.input(event.target.value)
  if (typeof retained === 'string') event.target.value = retained
}
function anchorLabel(offset, headings) {
  if (offset === null) return t('savedReportReview.general')
  const heading = headings.find(item => item.lineStart === offset)
  if (!heading) return ''
  const number = value => new Intl.NumberFormat(locale.value).format(value)
  return t('savedReportHeadings.entry', { level: number(heading.level), line: number(heading.line), title: heading.label })
}
function setLanguage(value) { if (reviewStore.actions(view).isCurrent() && ['en', 'zh'].includes(value)) locale.value = value }
onBeforeUnmount(() => reviewStore.leaveView(view))
</script>

<style scoped>
.review-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }header { padding: 18px 30px; background: #fff; border-bottom: 1px solid #e1e5eb; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 18px; }header > a { font-weight: 800; letter-spacing: 2px; text-decoration: none; }nav, nav label, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }a { color: #394555; }main { max-width: 1120px; margin: auto; padding: 30px 24px 60px; }h1 { font-size: clamp(26px, 4vw, 36px); }h2 { font-size: 22px; }h3 { font-size: 16px; }p { line-height: 1.6; }.panel { margin-top: 24px; padding: 22px; border: 1px solid #e1e5eb; border-radius: 12px; background: #fff; min-width: 0; }.notice { padding: 14px; border-radius: 8px; background: #edf1f6; }dl { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(0, 3fr); gap: 10px; }dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }dt { color: #68707c; }.literal, .note-text { white-space: pre-wrap; overflow-wrap: anywhere; }.note-card, .editor { margin-top: 18px; padding: 16px; border: 1px solid #d7dde5; border-radius: 8px; }.note-text { font: inherit; }label { display: block; margin: 10px 0; font-weight: 600; }button, select, input, textarea { box-sizing: border-box; max-width: 100%; min-height: 44px; padding: 10px 14px; border: 1px solid #c8cfd9; border-radius: 7px; background: #fff; color: #28323f; font: inherit; }button { cursor: pointer; }button:disabled { opacity: .5; cursor: not-allowed; }textarea { width: 100%; resize: vertical; }button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }[role=alert] { color: #9a3527; }@media (max-width: 700px) { main { padding: 24px 14px; }.panel { padding: 16px; }dl { grid-template-columns: minmax(0, 1fr); }dd { margin-bottom: 10px; } }
</style>
