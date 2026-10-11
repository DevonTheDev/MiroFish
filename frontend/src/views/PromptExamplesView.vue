<template>
  <div class="examples-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <nav :aria-label="t('promptExamples.navigation')">
        <RouterLink to="/">{{ t('promptExamples.home') }}</RouterLink>
        <RouterLink to="/prompt-suites">{{ t('promptSuites.navTitle') }}</RouterLink>
        <RouterLink to="/prompt-suite-comparison">{{ t('promptSuiteComparison.navTitle') }}</RouterLink>
        <LanguageSwitcher />
      </nav>
    </header>
    <main>
      <header><p class="eyebrow">{{ t('promptExamples.eyebrow') }}</p><h1>{{ t('promptExamples.title') }}</h1><p>{{ t('promptExamples.scope') }}</p></header>
      <aside class="notice"><p>{{ t('promptExamples.offline') }}</p><p>{{ t('promptExamples.limits') }}</p></aside>
      <section v-for="actions in [importActions]" :key="'import'" class="panel" aria-labelledby="examples-import-title">
        <h2 id="examples-import-title">{{ t('promptExamples.importTitle') }}</h2>
        <label for="examples-file">{{ t('promptExamples.chooseFile') }}</label>
        <input id="examples-file" data-testid="examples-file" type="file" accept="application/json,.json" @change="actions.read">
        <label for="examples-draft-file">{{ t('promptExamples.openDraft') }}</label>
        <input id="examples-draft-file" data-testid="examples-draft-file" type="file" accept="application/json,.json" @change="actions.readDraft">
        <p class="reading-note">{{ t('promptExamples.draftLimits') }}</p>
        <p v-if="importState.loading" role="status">{{ t(importState.kind === 'draft' ? 'promptExamples.readingDraft' : 'promptExamples.reading') }}</p>
        <p v-if="importState.error" class="notice error" data-testid="examples-import-error" role="alert">{{ t(importState.kind === 'draft' ? 'promptExamples.draftImportError' : 'promptExamples.importError') }}</p>
        <article v-if="source" data-testid="examples-accepted">
          <h3>{{ t('promptExamples.accepted') }}: {{ source.report.definition.name }}</h3>
          <dl><div><dt>{{ t('promptSuites.runId') }}</dt><dd>{{ source.report.run_id }}</dd></div><div><dt>{{ t('promptExamples.recordedRunStatus') }}</dt><dd>{{ t(`promptSuites.runStates.${source.report.status}`) }}</dd></div><div><dt>{{ t('promptTrials.startedAt') }}</dt><dd>{{ source.report.started_at }}</dd></div><div><dt>{{ t('promptTrials.finishedAt') }}</dt><dd>{{ value(source.report.finished_at) }}</dd></div></dl>
          <p v-if="source.report.stop_requested">{{ t('promptSuites.stopRequested') }}</p>
          <p v-if="source.report.halt_code">{{ t(`promptSuites.errors.${source.report.halt_code}`) }}</p>
          <p v-if="importState.retained" class="notice warning" data-testid="examples-retained">{{ t('promptExamples.retained') }}</p>
        </article>
        <p v-else>{{ t('promptExamples.empty') }}</p>
        <article v-if="importState.preview" class="preview" data-testid="examples-preview" :data-kind="importState.preview.kind">
          <h3>{{ t(importState.preview.kind === 'draft' ? 'promptExamples.draftPreview' : 'promptExamples.preview') }}: {{ importState.preview.report.definition.name }}</h3>
          <p>{{ t(importState.preview.kind === 'draft' ? 'promptExamples.draftPreviewNote' : 'promptExamples.previewNote') }}</p>
          <p v-if="importState.preview.kind === 'draft'">{{ t('promptExamples.captured') }} <time :datetime="importState.preview.capturedAt">{{ importState.preview.capturedAt }}</time></p>
          <p>{{ t('promptSuites.runId') }}: {{ importState.preview.report.run_id }}</p>
          <p>{{ t(`promptSuites.runStates.${importState.preview.report.status}`) }} · {{ t('promptExamples.caseCount', { count: importState.preview.report.cases.length }) }}</p>
          <template v-if="importState.preview.kind === 'draft'">
            <dl><div><dt>{{ t('promptTrials.startedAt') }}</dt><dd>{{ importState.preview.report.started_at }}</dd></div><div><dt>{{ t('promptTrials.finishedAt') }}</dt><dd>{{ value(importState.preview.report.finished_at) }}</dd></div></dl>
            <p v-if="importState.preview.report.stop_requested">{{ t('promptSuites.stopRequested') }}</p>
            <p v-if="importState.preview.report.halt_code">{{ t(`promptSuites.errors.${importState.preview.report.halt_code}`) }}</p>
          </template>
          <ol><li v-for="(item, index) in importState.preview.report.definition.cases" :key="item.case_id">
            {{ item.label }} · {{ t(`promptSuites.caseStates.${importState.preview.report.cases[index].status}`) }} · {{ t(`promptSuites.checkKinds.${checkKind(item)}`) }}
            <template v-if="item.required_fields?.some(rule => Object.hasOwn(rule, 'equals'))"><h4>{{ t('promptSuites.requiredFields') }}</h4><pre :data-testid="`examples-preview-required-fields-${index}`">{{ requiredFieldsText(item) }}</pre></template>
            <template v-if="importState.preview.kind === 'draft'">
              <p class="identifier">{{ t('promptExamples.caseId') }}: {{ item.case_id }}</p>
              <h4>{{ t('promptExamples.draftTarget') }}</h4><pre :data-testid="`examples-preview-target-${index}`">{{ importState.preview.targets[index].target_text }}</pre>
              <small v-if="importState.preview.targets[index].target_text === ''">{{ t('promptExamples.emptyDraftTarget') }}</small>
              <details><summary>{{ t('promptExamples.recordedDetails') }}</summary>
                <h5>{{ t('promptTrials.systemPrompt') }}</h5><pre :data-testid="`examples-preview-system-${index}`">{{ item.system_prompt }}</pre>
                <h5>{{ t('promptTrials.userPrompt') }}</h5><pre :data-testid="`examples-preview-user-${index}`">{{ item.user_prompt }}</pre>
                <h5>{{ t('promptExamples.recordedReply') }}</h5>
                <pre v-if="typeof importState.preview.report.cases[index].snapshot?.run?.response?.content === 'string'" :data-testid="`examples-preview-reply-${index}`">{{ importState.preview.report.cases[index].snapshot.run.response.content }}</pre><p v-else>{{ t('promptTrials.noContent') }}</p>
                <template v-if="typeof importState.preview.report.cases[index].snapshot?.run?.response?.refusal === 'string'"><h5>{{ t('promptExamples.recordedRefusal') }}</h5><pre>{{ importState.preview.report.cases[index].snapshot.run.response.refusal }}</pre></template>
              </details>
            </template>
          </li></ol>
          <details v-if="importState.preview.kind === 'draft'"><summary>{{ t('promptExamples.fullDraftSource') }}</summary><pre data-testid="examples-preview-source">{{ sourceReportText(importState.preview.report) }}</pre></details>
          <button type="button" data-testid="examples-use" @click="actions.use">{{ t(importState.preview.kind === 'draft' ? 'promptExamples.useDraft' : 'promptExamples.use') }}</button>
        </article>
        <div class="toolbar"><button v-if="importState.preview || importState.loading" type="button" data-testid="examples-cancel" @click="actions.cancel">{{ t('promptExamples.cancel') }}</button><button type="button" data-testid="examples-clear" :disabled="!source && !importState.preview && !importState.loading && !importState.error" @click="actions.clear">{{ t('promptExamples.clear') }}</button></div>
      </section>
      <section class="panel" aria-labelledby="examples-draft-title">
        <h2 id="examples-draft-title">{{ t('promptExamples.draftTitle') }}</h2>
        <p class="notice" data-testid="examples-draft-privacy">{{ t('promptExamples.draftPrivacy') }}</p>
        <div v-for="actions in [draftDownloadActions]" :key="'draft-download-actions'" class="toolbar"><button type="button" data-testid="examples-export-draft" :disabled="!source" @click="actions.download">{{ t('promptExamples.downloadDraft') }}</button></div>
        <p v-if="draftExportError" class="notice error" data-testid="examples-draft-export-error" role="alert">{{ t('promptExamples.draftExportError') }}</p>
      </section>
      <section v-if="source" class="review-section" aria-labelledby="examples-review-title">
        <h2 id="examples-review-title">{{ t('promptExamples.reviewTitle') }}</h2>
        <p class="notice" data-testid="examples-historical">{{ t('promptExamples.historical') }}</p>
        <p class="notice" data-testid="examples-repeated-input-notice">{{ t('promptExamples.repeatedInputs') }}</p>
        <article v-for="(entry, index) in rowViews" :key="entry.input.case_id" class="panel case-row" :data-testid="`examples-row-${index}`" :data-status="entry.row.status">
          <h3>{{ index + 1 }}. {{ entry.input.label }}</h3><p class="identifier">{{ t('promptExamples.caseId') }}: {{ entry.input.case_id }}</p>
          <div class="two-columns">
            <section class="historical-case">
              <h4>{{ t('promptExamples.recordedCase') }}</h4>
              <dl><div><dt>{{ t('promptExamples.recordedOutcome') }}</dt><dd :data-testid="`examples-row-${index}-status`">{{ t(`promptSuites.caseStates.${entry.row.status}`) }}</dd></div><div><dt>{{ t('promptExamples.recordedCheck') }}</dt><dd :data-testid="`examples-row-${index}-recorded-check`">{{ checkLabel(entry.input, entry.row.check) }}</dd></div></dl>
              <p v-if="failureText(entry.input, entry.row.status, entry.row.snapshot?.run?.response?.content)" class="reading-note" :data-testid="`examples-row-${index}-recorded-failure`">{{ failureText(entry.input, entry.row.status, entry.row.snapshot?.run?.response?.content) }}</p>
              <p v-if="entry.row.error_code" class="notice warning">{{ t(`promptSuites.errors.${entry.row.error_code}`) }}</p>
              <p v-if="entry.row.snapshot?.run?.error_code" class="notice warning">{{ t(`promptTrials.errors.${entry.row.snapshot.run.error_code}`) }}</p>
              <h5>{{ t('promptExamples.recordedReply') }}</h5>
              <template v-if="typeof entry.row.snapshot?.run?.response?.content === 'string'"><pre :data-testid="`examples-row-${index}-reply`">{{ entry.row.snapshot.run.response.content }}</pre><small v-if="entry.row.snapshot.run.response.content === ''">{{ t('promptTrials.emptyContent') }}</small></template><p v-else>{{ t('promptTrials.noContent') }}</p>
              <template v-if="typeof entry.row.snapshot?.run?.response?.refusal === 'string'"><h5>{{ t('promptExamples.recordedRefusal') }}</h5><pre :data-testid="`examples-row-${index}-refusal`">{{ entry.row.snapshot.run.response.refusal }}</pre></template>
              <details><summary>{{ t('promptExamples.recordedDetails') }}</summary>
                <h5>{{ t('promptTrials.systemPrompt') }}</h5><pre :data-testid="`examples-row-${index}-system-prompt`">{{ entry.input.system_prompt }}</pre>
                <h5>{{ t('promptTrials.userPrompt') }}</h5><pre :data-testid="`examples-row-${index}-user-prompt`">{{ entry.input.user_prompt }}</pre>
                <h5>{{ t('promptSuites.checkKind') }}</h5><p :data-testid="`examples-row-${index}-kind`">{{ t(`promptSuites.checkKinds.${checkKind(entry.input)}`) }}</p>
                <template v-if="checkKind(entry.input) === 'exact_text'"><h5>{{ t('promptSuites.expected') }}</h5><pre :data-testid="`examples-row-${index}-expected`">{{ entry.input.expected_text }}</pre><small v-if="entry.input.expected_text === ''">{{ t('promptSuites.emptyExpected') }}</small></template>
                <p v-if="checkKind(entry.input) === 'json_object'">{{ t('promptSuites.jsonObjectHint') }}</p>
                <template v-if="checkKind(entry.input) === 'json_fields'"><h5>{{ t('promptSuites.requiredFields') }}</h5><pre :data-testid="`examples-row-${index}-required-fields`">{{ requiredFieldsText(entry.input) }}</pre><p>{{ t('promptSuites.jsonFieldsHint') }}</p></template>
                <dl><div><dt>{{ t('promptTrials.temperature') }}</dt><dd>{{ entry.input.temperature }}</dd></div><div><dt>{{ t('promptTrials.maxOutputTokens') }}</dt><dd>{{ entry.input.max_output_tokens }}</dd></div><div><dt>{{ t('promptTrials.requestId') }}</dt><dd>{{ value(entry.row.request_id) }}</dd></div><div><dt>{{ t('promptTrials.capturedModel') }}</dt><dd :data-testid="`examples-row-${index}-model`">{{ value(entry.row.snapshot?.run?.configuration.model) }}</dd></div><div><dt>{{ t('promptTrials.reasoningEffort') }}</dt><dd>{{ entry.row.snapshot?.run ? entry.row.snapshot.run.configuration.reasoning_effort ?? t('promptTrials.serverDefault') : t('promptTrials.unknown') }}</dd></div><div><dt>{{ t('promptTrials.requestDuration') }}</dt><dd>{{ value(entry.row.snapshot?.run?.request_duration_ms) }}</dd></div><div><dt>{{ t('promptTrials.overallDuration') }}</dt><dd>{{ value(entry.row.snapshot?.run?.elapsed_ms) }}</dd></div><div><dt>{{ t('promptTrials.finishReason') }}</dt><dd>{{ value(entry.row.snapshot?.run?.response?.finish_reason) }}</dd></div></dl>
              </details>
            </section>
            <section class="target-case">
              <h4>{{ t('promptExamples.targetTitle') }}</h4>
              <label :for="`examples-row-${index}-target`">{{ t('promptExamples.targetLabel') }}</label>
              <textarea :id="`examples-row-${index}-target`" :data-testid="`examples-row-${index}-target`" :value="entry.target" rows="8" :aria-describedby="`examples-row-${index}-bounds`" @input="entry.edit"></textarea>
              <p :id="`examples-row-${index}-bounds`" class="reading-note">{{ t('promptExamples.targetBounds') }}</p>
              <p v-if="entry.target !== '' && !entry.valid" class="notice error" :data-testid="`examples-row-${index}-target-error`">{{ t('promptExamples.invalidTarget') }}</p>
              <p class="reading-note">{{ t('promptExamples.editNote') }}</p>
              <button v-if="entry.row.status === 'succeeded'" type="button" :data-testid="`examples-row-${index}-copy`" @click="entry.copy">{{ t('promptExamples.copy') }}</button>
              <dl><div><dt>{{ t('promptExamples.targetCheck') }}</dt><dd :data-testid="`examples-row-${index}-target-check`">{{ entry.valid ? checkLabel(entry.input, entry.targetCheck) : t('promptExamples.targetNotChecked') }}</dd></div><div><dt>{{ t('promptExamples.replyEqual') }}</dt><dd :data-testid="`examples-row-${index}-reply-equal`" :data-equal="entry.replyEqual">{{ booleanValue(entry.replyEqual) }}</dd></div></dl>
              <p v-if="entry.valid && failureText(entry.input, 'succeeded', entry.target)" class="reading-note" :data-testid="`examples-row-${index}-target-failure`">{{ failureText(entry.input, 'succeeded', entry.target) }}</p>
              <p class="reading-note">{{ t('promptExamples.checkNote') }}</p>
              <p v-if="entry.approval" class="notice approved" :data-testid="`examples-row-${index}-approved`">{{ t('promptExamples.approved') }} <time :datetime="entry.approvalReport.reviewed_at">{{ entry.approvalReport.reviewed_at }}</time></p>
              <p v-else :data-testid="`examples-row-${index}-unapproved`">{{ t('promptExamples.unapproved') }}</p>
              <div class="toolbar"><button type="button" :data-testid="`examples-row-${index}-approve`" :disabled="!entry.valid || !!entry.approval" @click="entry.approve">{{ t('promptExamples.approve') }}</button><button v-if="entry.approval" type="button" :data-testid="`examples-row-${index}-remove-approval`" @click="entry.removeApproval">{{ t('promptExamples.removeApproval') }}</button></div>
              <p v-if="entry.error" class="notice error" role="alert">{{ t('promptExamples.approvalError') }}</p>
            </section>
          </div>
        </article>
      </section>
      <section class="panel" aria-labelledby="examples-export-title">
        <h2 id="examples-export-title">{{ t('promptExamples.exportTitle') }}</h2>
        <p data-testid="examples-selected-count" aria-live="polite">{{ t('promptExamples.selectedCount', { count: approvedCount }) }}</p>
        <p>{{ t('promptExamples.selectionNote') }}</p>
        <div v-for="actions in [buildActions]" :key="'build-actions'" class="toolbar"><button class="primary" type="button" data-testid="examples-build" :disabled="approvedCount === 0 || !!bundle" @click="actions.build">{{ t('promptExamples.build') }}</button></div>
        <p v-if="buildError" class="notice error" data-testid="examples-build-error" role="alert">{{ t('promptExamples.buildError') }}</p>
        <p v-if="exportError" class="notice error" data-testid="examples-export-error" role="alert">{{ t('promptExamples.exportError') }}</p>
        <article v-if="bundle" data-testid="examples-bundle">
          <h3>{{ t('promptExamples.bundleTitle') }}</h3><p>{{ t('promptExamples.captured') }} <time :datetime="bundle.exports.captured_at">{{ bundle.exports.captured_at }}</time></p>
          <p>{{ t('promptExamples.bundleNote') }}</p>
          <div v-for="actions in [downloadActions]" :key="'download-actions'" class="toolbar"><button type="button" data-testid="examples-export-jsonl" @click="actions.jsonl">{{ t('promptExamples.downloadJsonl') }}</button><button type="button" data-testid="examples-export-review" @click="actions.review">{{ t('promptExamples.downloadReview') }}</button></div>
          <p class="reading-note">{{ t('promptExamples.privacy') }}</p>
        </article>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, shallowRef, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { parsePromptSuiteReport, getPromptSuiteCheck, evaluatePromptSuiteCheck, formatPromptSuiteRequiredFields, getPromptSuiteCheckFailure, PROMPT_SUITE_REPORT_MAX_BYTES } from '../utils/promptSuites.js'
import { capturePromptExampleSource, approvePromptExampleTarget, buildPromptExamples, exportPromptExamples,
  capturePromptExampleDraft, parsePromptExampleDraft, exportPromptExampleDraft, PROMPT_EXAMPLES_DRAFT_MAX_BYTES } from '../utils/promptExamples.js'

const { t } = useI18n()
const emptyImport = () => ({ preview: null, loading: false, error: false, retained: false, kind: 'report' })
const importState = shallowRef(emptyImport()), source = shallowRef(null), rows = shallowRef([]), bundle = shallowRef(null)
const buildError = ref(false), exportError = ref(false), downloadRevision = ref(0), buildRevision = ref(0)
const draftExportError = ref(false), draftDownloadRevision = ref(0)
let retired = false, fileGeneration = 0
function activeFile(token) { return !retired && fileGeneration === token }
function invalidateBundle() { bundle.value = null; buildError.value = false; exportError.value = false }
function updateImport(change) { importState.value = { ...importState.value, ...change } }
async function readFile(event, token, kind = 'report') {
  if (!activeFile(token)) return
  const file = event.target.files?.[0], reading = ++fileGeneration
  event.target.value = ''
  updateImport({ preview: null, loading: !!file, error: false, retained: !!source.value, kind })
  if (!file) return
  try {
    const maxBytes = kind === 'draft' ? PROMPT_EXAMPLES_DRAFT_MAX_BYTES : PROMPT_SUITE_REPORT_MAX_BYTES
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes || typeof file.arrayBuffer !== 'function') throw new Error('Invalid file')
    const bytes = await file.arrayBuffer()
    if (!activeFile(reading)) return
    if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength > maxBytes) throw new Error('Invalid bytes')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const draft = kind === 'draft' ? parsePromptExampleDraft(text).toReport() : null
    const capture = capturePromptExampleSource(draft ? draft.source_report : parsePromptSuiteReport(text))
    if (activeFile(reading)) updateImport({ preview: { kind, capture, report: capture.toReport(), token: reading,
      ...(draft ? { targets: draft.targets, capturedAt: draft.captured_at } : {}) }, loading: false })
  } catch { if (activeFile(reading)) updateImport({ loading: false, error: true }) }
}
const importActions = computed(() => {
  const state = importState.value, token = fileGeneration, preview = state.preview
  return {
    read: event => readFile(event, token),
    readDraft: event => readFile(event, token, 'draft'),
    use: () => {
      if (!preview || !activeFile(token) || importState.value.preview !== preview) return
      fileGeneration++
      source.value = { capture: preview.capture, report: preview.report }
      rows.value = preview.report.definition.cases.map((input, index) => ({ input, row: preview.report.cases[index], target: preview.kind === 'draft' ? preview.targets[index].target_text : '', approval: null, error: false }))
      importState.value = emptyImport(); draftExportError.value = false; invalidateBundle()
    },
    cancel: () => {
      if (!activeFile(token)) return
      fileGeneration++; importState.value = { ...emptyImport(), retained: !!source.value }
    },
    clear: () => {
      if (!activeFile(token)) return
      fileGeneration++; importState.value = emptyImport(); source.value = null; rows.value = []; draftExportError.value = false; invalidateBundle()
    },
  }
})
function validTarget(target) {
  return typeof target === 'string' && target.length <= 32768 && target.trim().length > 0 && Array.from(target).length <= 16384 &&
    new TextEncoder().encode(target).length <= 65536 && !/[\p{Cc}\p{Cs}]/u.test(target.replace(/[\r\n\t]/g, ''))
}
function rowIsCurrent(ownedSource, ownedRow, index) { return !retired && source.value === ownedSource && rows.value[index] === ownedRow }
function replaceRow(index, replacement) { rows.value = rows.value.map((row, position) => position === index ? replacement : row); invalidateBundle() }
const rowViews = computed(() => {
  const ownedSource = source.value
  return rows.value.map((row, index) => {
    const valid = validTarget(row.target), current = () => rowIsCurrent(ownedSource, row, index)
    const setTarget = target => { if (current()) { replaceRow(index, { ...row, target, approval: null, error: false }); draftExportError.value = false } }
    return { ...row, valid, approvalReport: row.approval?.toReport(),
      targetCheck: valid ? evaluatePromptSuiteCheck(row.input, 'succeeded', row.target) : null,
      replyEqual: row.row.status === 'succeeded' ? row.target === row.row.snapshot.run.response.content : null,
      edit: event => setTarget(event.target.value),
      copy: () => { if (row.row.status === 'succeeded') setTarget(row.row.snapshot.run.response.content) },
      approve: () => {
        if (!current() || !valid || row.approval) return
        try { replaceRow(index, { ...row, approval: approvePromptExampleTarget(ownedSource.capture, row.input.case_id, row.target), error: false }) }
        catch { if (current()) replaceRow(index, { ...row, error: true }) }
      },
      removeApproval: () => { if (current() && row.approval) replaceRow(index, { ...row, approval: null, error: false }) },
    }
  })
})
const approvedCount = computed(() => rows.value.filter(row => row.approval).length)
// Render-local aliases preserve the ownership of each event even with Vue's
// production handler cache. Object identity also rejects edit-away-and-back ABA.
const buildActions = computed(() => {
  const ownedSource = source.value, ownedRows = rows.value
  void buildRevision.value
  let used = false
  return { build: () => {
    if (retired || used || !ownedSource || source.value !== ownedSource || rows.value !== ownedRows || !ownedRows.some(row => row.approval) || bundle.value) return
    used = true
    try {
      const capture = buildPromptExamples(ownedSource.capture, ownedRows.flatMap(row => row.approval ? [row.approval] : []))
      const exports = exportPromptExamples(capture)
      bundle.value = { capture, exports }; buildError.value = false; exportError.value = false
    } catch { buildError.value = true; buildRevision.value++ }
  } }
})
function download(owned, format) {
  if (retired || !owned || bundle.value !== owned) return
  let url = null, anchor = null
  try {
    url = URL.createObjectURL(new Blob([format === 'jsonl' ? owned.exports.jsonl_text : owned.exports.review_json_text], { type: format === 'jsonl' ? 'application/x-ndjson;charset=utf-8' : 'application/json;charset=utf-8' }))
    if (retired || bundle.value !== owned) return
    anchor = document.createElement('a'); anchor.href = url
    anchor.download = format === 'jsonl' ? 'reviewed_prompt_examples.jsonl' : 'reviewed_prompt_examples.review.json'
    document.body.appendChild(anchor); anchor.click(); exportError.value = false
  } catch { if (!retired && bundle.value === owned) exportError.value = true }
  finally { try { anchor?.remove() } finally { if (url !== null) URL.revokeObjectURL(url) } }
}
const downloadActions = computed(() => {
  const owned = bundle.value
  // A fresh rendered action permits an explicit retry; an already queued
  // double-click cannot download again or dereference a replacement bundle.
  void downloadRevision.value
  const once = format => { let used = false; return () => { if (used) return; used = true; download(owned, format); downloadRevision.value++ } }
  return { jsonl: once('jsonl'), review: once('review') }
})
function downloadDraft(ownedSource, ownedRows, current) {
  if (!current()) return
  let url = null, anchor = null
  const failed = () => { if (current()) draftExportError.value = true }
  try {
    const capture = capturePromptExampleDraft(ownedSource.capture, ownedRows.map(row => ({ case_id: row.input.case_id, target_text: row.target })))
    const exported = exportPromptExampleDraft(capture)
    if (!current()) return
    const blob = new Blob([exported.draft_json_text], { type: 'application/json;charset=utf-8' })
    if (!current()) return
    url = URL.createObjectURL(blob)
    if (!current()) return
    anchor = document.createElement('a')
    if (!current()) return
    anchor.href = url; anchor.download = 'prompt_example_curation.draft.json'
    document.body.appendChild(anchor)
    if (!current()) return
    anchor.click()
    if (current()) draftExportError.value = false
  } catch { failed() }
  finally {
    try { anchor?.remove() } catch { failed() }
    try { if (url !== null) URL.revokeObjectURL(url) } catch { failed() }
  }
}
const draftDownloadActions = computed(() => {
  const ownedSource = source.value, ownedRows = rows.value, revision = draftDownloadRevision.value
  const current = () => !retired && !!ownedSource && source.value === ownedSource && rows.value === ownedRows && draftDownloadRevision.value === revision
  let used = false
  return { download: () => {
    if (used || !current()) return
    used = true
    downloadDraft(ownedSource, ownedRows, current)
    draftDownloadRevision.value++
  } }
})
function sourceReportText(report) { return JSON.stringify(report, null, 2) }
function checkKind(input) { return getPromptSuiteCheck(input).kind }
function requiredFieldsText(input) { return formatPromptSuiteRequiredFields(input) }
function failureText(input, status, content) {
  const failure = getPromptSuiteCheckFailure(input, status, content)
  if (!failure) return ''
  const params = { ...failure.params }
  if (params.expectedType) params.expectedType = t(`promptSuites.fieldTypes.${params.expectedType}`)
  if (params.actualType) params.actualType = t(`promptSuites.fieldTypes.${params.actualType}`)
  return t(`promptSuites.fieldFailures.${failure.code}`, params)
}

function checkLabel(input, check) {
  const kind = checkKind(input)
  return t(`promptSuites.${kind === 'json_fields' ? 'jsonFieldsChecks' : kind === 'json_object' ? 'jsonChecks' : 'checks'}.${check}`)
}
function value(input) { return input == null ? t('promptTrials.unknown') : String(input) }
function booleanValue(input) { return input === null ? t('promptExamples.notApplicable') : t(input ? 'promptExamples.yes' : 'promptExamples.no') }
onBeforeUnmount(() => { retired = true; fileGeneration++; source.value = null; rows.value = []; bundle.value = null })
</script>

<style scoped>
.examples-page { min-height: 100vh; background: #f7f8fa; color: #1c2535; font-family: Inter, system-ui, sans-serif; }
.app-header { min-height: 72px; padding: 16px 5%; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: white; border-bottom: 1px solid #e2e6ec; }
.brand { font-weight: 800; letter-spacing: .1em; color: #15213b; text-decoration: none; }nav, .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }nav a { color: #435879; }
main { width: min(1180px, 92%); margin: 0 auto; padding: 36px 0 72px; }h1 { margin: 8px 0 12px; font-size: clamp(26px, 4vw, 38px); }h2 { font-size: 22px; }h3 { font-size: 19px; }h4 { font-size: 16px; }h5 { margin: 20px 0 8px; font-size: 14px; }.eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: #547395; }
p { line-height: 1.65; overflow-wrap: anywhere; }.two-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }.panel { min-width: 0; background: white; border: 1px solid #dce2eb; border-radius: 10px; padding: 24px; margin-top: 24px; }.panel h2 { margin-top: 0; }.preview { margin: 18px 0; padding: 16px; border: 1px solid #a4bfdf; border-radius: 6px; }.preview li { overflow-wrap: anywhere; margin: 8px 0; }.review-section { margin-top: 36px; }.historical-case, .target-case { min-width: 0; }.target-case { padding-left: 24px; border-left: 1px solid #dce2eb; }
label { display: block; font-weight: 600; margin: 16px 0 8px; }input { max-width: 100%; font: inherit; }textarea { box-sizing: border-box; width: 100%; resize: vertical; min-height: 160px; padding: 12px; border: 1px solid #aabbd0; border-radius: 5px; font: 14px/1.6 ui-monospace, monospace; unicode-bidi: plaintext; }button { padding: 9px 14px; font: inherit; font-weight: 600; font-size: 14px; background: white; color: #294c78; border: 1px solid #aabbd0; border-radius: 5px; cursor: pointer; }.primary { background: #255b93; color: white; border-color: #255b93; }button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 3px solid #92bdf3; outline-offset: 3px; }
.notice { padding: 12px 16px; background: #edf3f9; border-radius: 6px; }.warning { background: #fff6e6; color: #76520c; }.error { background: #fff0ef; color: #9e2e27; }.approved { background: #edf6f1; color: #285d43; }small, .reading-note, dt { color: #52647d; font-size: 13px; }.identifier { font-family: ui-monospace, monospace; font-size: 13px; }
dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }dd { margin: 5px 0 0; overflow-wrap: anywhere; }pre { white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.4em; background: #f4f6f9; border: 1px solid #e3e8ef; border-radius: 5px; padding: 14px; font-size: 13px; line-height: 1.6; unicode-bidi: plaintext; }summary { cursor: pointer; margin-top: 18px; color: #355d88; }
@media (max-width: 760px) { .two-columns { grid-template-columns: 1fr; gap: 20px; }.app-header { align-items: flex-start; flex-direction: column; gap: 12px; }.panel { padding: 16px; }.target-case { padding: 18px 0 0; border-left: 0; border-top: 1px solid #dce2eb; } }
@media (max-width: 380px) { dl { grid-template-columns: 1fr; } }
</style>
