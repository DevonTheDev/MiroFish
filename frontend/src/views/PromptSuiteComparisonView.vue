<template>
  <div class="comparison-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <nav :aria-label="t('promptSuiteComparison.navigation')"><RouterLink to="/prompt-suites">{{ t('promptSuites.navTitle') }}</RouterLink><RouterLink to="/prompt-examples">{{ t('promptExamples.navTitle') }}</RouterLink><LanguageSwitcher /></nav>
    </header>
    <main>
      <header><p class="eyebrow">{{ t('promptSuites.eyebrow') }}</p><h1>{{ t('promptSuiteComparison.title') }}</h1><p>{{ t('promptSuiteComparison.scope') }}</p></header>
      <aside class="notice"><p>{{ t('promptSuiteComparison.offline') }}</p><p>{{ t('promptSuiteComparison.limits') }}</p></aside>
      <div class="two-columns">
        <section v-for="slot in slotViews" :key="slot.side" class="panel" :aria-labelledby="`comparison-${slot.side}-title`">
          <h2 :id="`comparison-${slot.side}-title`">{{ t(`promptSuiteComparison.${slot.side}`) }}</h2>
          <label :for="`comparison-${slot.side}-file`">{{ t('promptSuiteComparison.chooseFile') }}</label>
          <input :id="`comparison-${slot.side}-file`" :data-testid="`comparison-${slot.side}-file`" type="file" accept="application/json,.json" @change="slot.read">
          <p v-if="slot.loading" role="status">{{ t('promptSuiteComparison.reading') }}</p>
          <p v-if="slot.error" :data-testid="`comparison-${slot.side}-error`" class="notice error" role="alert">{{ t('promptSuiteComparison.importError') }}</p>
          <article v-if="slot.accepted" :data-testid="`comparison-${slot.side}-accepted`">
            <h3>{{ t('promptSuiteComparison.accepted') }}: {{ slot.accepted.report.definition.name }}</h3>
            <p class="identifier">{{ t('promptSuites.runId') }}: {{ slot.accepted.report.run_id }}</p>
            <p>{{ t(`promptSuites.runStates.${slot.accepted.report.status}`) }} · {{ t('promptSuiteComparison.caseCount', { count: slot.accepted.report.cases.length }) }}</p>
            <p v-if="slot.retained" :data-testid="`comparison-${slot.side}-retained`" class="notice warning">{{ t('promptSuiteComparison.retained') }}</p>
          </article>
          <p v-else>{{ t('promptSuiteComparison.emptySlot') }}</p>
          <article v-if="slot.preview" class="preview" :data-testid="`comparison-${slot.side}-preview`">
            <h3>{{ t('promptSuiteComparison.preview') }}: {{ slot.preview.report.definition.name }}</h3>
            <p>{{ t('promptSuiteComparison.previewNote') }}</p>
            <dl><div><dt>{{ t('promptSuites.runId') }}</dt><dd>{{ slot.preview.report.run_id }}</dd></div><div><dt>{{ t('promptSuiteComparison.reportStatus') }}</dt><dd>{{ t(`promptSuites.runStates.${slot.preview.report.status}`) }}</dd></div><div><dt>{{ t('promptTrials.startedAt') }}</dt><dd>{{ slot.preview.report.started_at }}</dd></div><div><dt>{{ t('promptTrials.finishedAt') }}</dt><dd>{{ value(slot.preview.report.finished_at) }}</dd></div></dl>
            <ol><li v-for="(item, index) in slot.preview.report.definition.cases" :key="item.case_id">{{ item.label }} · {{ t(`promptSuites.caseStates.${slot.preview.report.cases[index].status}`) }} · {{ t(`promptSuites.checkKinds.${checkKind(item)}`) }}<template v-if="checkKind(item) === 'json_fields'"><h4>{{ t('promptSuites.requiredFields') }}</h4><pre :data-testid="`comparison-${slot.side}-preview-case-${index}-required-fields`">{{ requiredFieldsText(item) }}</pre><p class="reading-note">{{ t('promptSuites.jsonFieldsHint') }}</p></template></li></ol>
            <button type="button" :data-testid="`comparison-${slot.side}-use`" @click="slot.use">{{ t('promptSuiteComparison.use') }}</button>
          </article>
          <div class="toolbar"><button v-if="slot.preview || slot.loading" type="button" :data-testid="`comparison-${slot.side}-cancel`" @click="slot.cancel">{{ t('promptSuiteComparison.discard') }}</button><button type="button" :data-testid="`comparison-${slot.side}-clear`" :disabled="!slot.accepted && !slot.preview && !slot.loading && !slot.error" @click="slot.clear">{{ t('promptSuiteComparison.clear') }}</button></div>
        </section>
      </div>
      <div v-for="actions in [pairActions]" :key="'pair-actions'" class="toolbar comparison-actions"><button class="primary" type="button" data-testid="comparison-run" :disabled="!canCompare" @click="actions.compare">{{ t('promptSuiteComparison.compare') }}</button><button type="button" data-testid="comparison-swap" :disabled="!canSwap" @click="actions.swap">{{ t('promptSuiteComparison.swap') }}</button></div>
      <p v-if="sameRun" class="notice warning" data-testid="comparison-same-run">{{ t('promptSuiteComparison.sameRun') }}</p>
      <p v-if="compareError" class="notice error" data-testid="comparison-error" role="alert">{{ t('promptSuiteComparison.compareError') }}</p>
      <p v-if="exportError" class="notice error" data-testid="comparison-export-error" role="alert">{{ t('promptSuiteComparison.exportError') }}</p>
      <section v-if="result" class="panel" data-testid="comparison-result" aria-labelledby="comparison-result-title">
        <h2 id="comparison-result-title">{{ t('promptSuiteComparison.result') }}</h2>
        <p>{{ t('promptSuiteComparison.captured') }} <time :datetime="result.report.captured_at">{{ result.report.captured_at }}</time></p>
        <p class="notice" data-testid="comparison-historical">{{ t('promptSuiteComparison.historical') }}</p>
        <p>{{ t('promptSuiteComparison.baseline') }}: {{ result.report.baseline.definition.name }} · {{ result.report.baseline.run_id }}</p>
        <p>{{ t('promptSuiteComparison.comparison') }}: {{ result.report.comparison.definition.name }} · {{ result.report.comparison.run_id }}</p>
        <div v-for="actions in [downloadActions]" :key="'download-actions'" class="toolbar"><button type="button" data-testid="comparison-export-json" :disabled="!result.exports" @click="actions.json">{{ t('promptSuiteComparison.downloadJson') }}</button><button type="button" data-testid="comparison-export-txt" :disabled="!result.exports" @click="actions.txt">{{ t('promptSuiteComparison.downloadText') }}</button></div>
        <p class="reading-note">{{ t('promptSuiteComparison.privacy') }}</p>
        <div class="two-columns reports">
          <article v-for="side in sides" :key="side" :data-testid="`comparison-${side}-configuration`">
            <h3>{{ t(`promptSuiteComparison.${side}`) }}</h3>
            <p>{{ t('promptSuiteComparison.reportStatus') }}: {{ t(`promptSuites.runStates.${result.report[side].status}`) }}</p>
            <p v-if="result.report[side].stop_requested">{{ t('promptSuites.stopRequested') }}</p>
            <p v-if="result.report[side].halt_code">{{ t(`promptSuites.errors.${result.report[side].halt_code}`) }}</p>
            <dl><div><dt>{{ t('promptTrials.startedAt') }}</dt><dd>{{ result.report[side].started_at }}</dd></div><div><dt>{{ t('promptTrials.finishedAt') }}</dt><dd>{{ value(result.report[side].finished_at) }}</dd></div></dl>
            <h4>{{ t('promptSuiteComparison.configurations') }}</h4>
            <ul><li v-for="(configuration, index) in result.report.configuration_summary[side].observed" :key="index">{{ configuration.model }} · {{ configuration.reasoning_effort ?? t('promptTrials.serverDefault') }}</li></ul>
            <p>{{ t('promptSuiteComparison.missingConfigurations', { count: result.report.configuration_summary[side].missing_cases }) }}</p>
            <p v-if="result.report.configuration_summary[side].mixed" class="notice warning" :data-testid="`comparison-${side}-mixed`">{{ t('promptSuiteComparison.mixed') }}</p>
          </article>
        </div>
        <p class="reading-note">{{ t('promptSuiteComparison.configurationNote') }}</p>
        <p v-if="result.report.definition_changes.name" data-testid="comparison-name-changed">{{ t('promptSuiteComparison.nameChanged') }}</p>
        <p v-if="result.report.definition_changes.relative_order" class="notice warning" data-testid="comparison-order-changed">{{ t('promptSuiteComparison.orderChanged') }}</p>
        <dl class="summary-grid" data-testid="comparison-summary"><div v-for="key in summaryFields" :key="key"><dt>{{ t(`promptSuiteComparison.${result.report.schema_version >= 2 ? 'checkSummary' : 'summary'}.${key}`) }}</dt><dd>{{ result.report.summary[key] }}</dd></div></dl>
        <p>{{ t(result.report.schema_version >= 2 ? 'promptSuiteComparison.checkFindingsNote' : 'promptSuiteComparison.findingsNote') }}</p><p>{{ t('promptSuiteComparison.timingNote') }}</p>
        <article v-for="(row, index) in result.rows" :key="row.case_id" class="case-row" :data-testid="`comparison-row-${index}`" :data-case-id="row.case_id" :data-membership="row.membership" :data-paired="row.paired_succeeded">
          <h3>{{ row.comparison?.item.label ?? row.baseline.item.label }}</h3><p class="identifier">{{ t('promptSuiteComparison.caseId') }}: {{ row.case_id }}</p>
          <p>{{ t(`promptSuiteComparison.membership.${row.membership}`) }} · {{ t('promptSuiteComparison.positions', { baseline: position(row.baseline_position), comparison: position(row.comparison_position) }) }}</p>
          <p v-if="row.label_changed">{{ t('promptSuiteComparison.labelChanged') }}</p>
          <p v-if="row.same_inputs === false" class="notice warning" :data-testid="`comparison-row-${index}-changed-inputs`">{{ t('promptSuiteComparison.inputsChanged') }}: {{ changedInputs(row).join(', ') }}</p>
          <p v-if="row.request_id_overlap" class="notice warning" :data-testid="`comparison-row-${index}-request-id-overlap`">{{ t('promptSuiteComparison.requestIdOverlap') }}</p>
          <dl class="findings-grid"><div><dt>{{ t('promptSuiteComparison.eligible') }}</dt><dd>{{ booleanValue(row.paired_succeeded) }}</dd></div><div><dt>{{ t(result.report.schema_version >= 2 ? 'promptSuiteComparison.checkTransition' : 'promptSuiteComparison.exactTransition') }}</dt><dd :data-testid="`comparison-row-${index}-transition`">{{ transitionLabel(row) }}</dd></div><div><dt>{{ t('promptSuiteComparison.replyEqual') }}</dt><dd :data-testid="`comparison-row-${index}-reply-equal`">{{ booleanValue(row.reply_equal) }}</dd></div><div><dt>{{ t('promptSuiteComparison.delta') }}</dt><dd :data-testid="`comparison-row-${index}-delta`">{{ row.request_duration_delta_ms === null ? t('promptSuiteComparison.notComparable') : signed(row.request_duration_delta_ms) }}</dd></div></dl>
          <div class="two-columns">
            <section v-for="side in sides" :key="side" class="case-side" :aria-label="t(`promptSuiteComparison.${side}`)">
              <h4>{{ t(`promptSuiteComparison.${side}`) }}</h4>
              <p v-if="!row[side]">{{ t('promptSuiteComparison.absentCase') }}</p>
              <template v-else>
                <p>{{ row[side].item.label }}</p><p :data-testid="`comparison-row-${index}-${side}-status`">{{ t(`promptSuites.caseStates.${row[side].section.status}`) }} · {{ checkLabel(row[side].item, row[side].section.check) }}</p>
                <p v-if="row[side].section.error_code" class="notice warning">{{ t(`promptSuites.errors.${row[side].section.error_code}`) }}</p>
                <dl><div><dt>{{ t('promptTrials.requestId') }}</dt><dd>{{ value(row[side].section.request_id) }}</dd></div><div><dt>{{ t('promptTrials.temperature') }}</dt><dd>{{ row[side].item.temperature }}</dd></div><div><dt>{{ t('promptTrials.maxOutputTokens') }}</dt><dd>{{ row[side].item.max_output_tokens }}</dd></div><div><dt>{{ t('promptTrials.capturedModel') }}</dt><dd :data-testid="`comparison-row-${index}-${side}-model`">{{ value(row[side].section.snapshot?.run?.configuration.model) }}</dd></div><div><dt>{{ t('promptTrials.reasoningEffort') }}</dt><dd>{{ row[side].section.snapshot?.run ? row[side].section.snapshot.run.configuration.reasoning_effort ?? t('promptTrials.serverDefault') : t('promptTrials.unknown') }}</dd></div><div><dt>{{ t('promptTrials.requestDuration') }}</dt><dd :data-testid="`comparison-row-${index}-${side}-request-duration`">{{ value(row[side].section.snapshot?.run?.request_duration_ms) }}</dd></div><div><dt>{{ t('promptTrials.overallDuration') }}</dt><dd :data-testid="`comparison-row-${index}-${side}-elapsed`">{{ value(row[side].section.snapshot?.run?.elapsed_ms) }}</dd></div><div><dt>{{ t('promptTrials.finishReason') }}</dt><dd>{{ value(row[side].section.snapshot?.run?.response?.finish_reason) }}</dd></div></dl>
                <p v-if="row[side].section.snapshot?.run?.error_code" class="notice error">{{ t(`promptTrials.errors.${row[side].section.snapshot.run.error_code}`) }}</p>
                <h5>{{ t('promptTrials.reply') }}</h5><template v-if="typeof row[side].section.snapshot?.run?.response?.content === 'string'"><pre :data-testid="`comparison-row-${index}-${side}-reply`">{{ row[side].section.snapshot.run.response.content }}</pre><small v-if="row[side].section.snapshot.run.response.content === ''">{{ t('promptTrials.emptyContent') }}</small></template><p v-else>{{ t('promptTrials.noContent') }}</p>
                <template v-if="typeof row[side].section.snapshot?.run?.response?.refusal === 'string'"><h5>{{ t('promptTrials.refusal') }}</h5><pre :data-testid="`comparison-row-${index}-${side}-refusal`">{{ row[side].section.snapshot.run.response.refusal }}</pre></template>
                <details><summary>{{ t('promptSuites.capturedCase') }}</summary><h5>{{ t('promptTrials.systemPrompt') }}</h5><pre :data-testid="`comparison-row-${index}-${side}-system-prompt`">{{ row[side].item.system_prompt }}</pre><h5>{{ t('promptTrials.userPrompt') }}</h5><pre :data-testid="`comparison-row-${index}-${side}-user-prompt`">{{ row[side].item.user_prompt }}</pre><h5>{{ t('promptSuites.checkKind') }}</h5><p :data-testid="`comparison-row-${index}-${side}-kind`">{{ t(`promptSuites.checkKinds.${checkKind(row[side].item)}`) }}</p><p v-if="checkKind(row[side].item) === 'json_object'" class="reading-note">{{ t('promptSuites.jsonObjectHint') }}</p><template v-if="checkKind(row[side].item) === 'json_fields'"><h5>{{ t('promptSuites.requiredFields') }}</h5><pre :data-testid="`comparison-row-${index}-${side}-required-fields`">{{ requiredFieldsText(row[side].item) }}</pre><p class="reading-note">{{ t('promptSuites.jsonFieldsHint') }}</p></template><template v-if="checkKind(row[side].item) === 'exact_text'"><h5>{{ t('promptSuites.expected') }}</h5><pre :data-testid="`comparison-row-${index}-${side}-expected`">{{ row[side].item.expected_text }}</pre><small v-if="row[side].item.expected_text === ''">{{ t('promptSuites.emptyExpected') }}</small></template></details>
              </template>
            </section>
          </div>
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
import { parsePromptSuiteReport, getPromptSuiteCheck, PROMPT_SUITE_REPORT_MAX_BYTES } from '../utils/promptSuites.js'
import { comparePromptSuiteReports, exportPromptSuiteComparison } from '../utils/promptSuiteComparison.js'

const { t } = useI18n()
const sides = ['baseline', 'comparison']
const emptySlot = () => ({ accepted: null, preview: null, loading: false, error: false, retained: false })
const slots = shallowRef({ baseline: emptySlot(), comparison: emptySlot() })
const generations = { baseline: 0, comparison: 0 }
let retired = false, pairGeneration = 0
const result = shallowRef(null), compareError = ref(false), exportError = ref(false)
const summaryFields = ['baseline_cases', 'comparison_cases', 'added', 'removed', 'shared', 'same_inputs', 'paired_succeeded', 'evaluated_pairs', 'gained_matches', 'lost_matches', 'retained_matches', 'retained_mismatches', 'overlapping_request_pairs']
const inputLabels = { system_prompt: 'promptTrials.systemPrompt', user_prompt: 'promptTrials.userPrompt', temperature: 'promptTrials.temperature', max_output_tokens: 'promptTrials.maxOutputTokens', expected_text: 'promptSuites.expected', check_kind: 'promptSuites.checkKind', required_fields: 'promptSuites.requiredFields' }
function setSlot(side, change) { slots.value = { ...slots.value, [side]: { ...slots.value[side], ...change } } }
function invalidateResult() { pairGeneration++; result.value = null; compareError.value = false; exportError.value = false }
function active(side, token) { return !retired && generations[side] === token }
async function readFile(side, event) {
  if (retired) return
  const file = event.target.files?.[0], token = ++generations[side]
  event.target.value = ''
  setSlot(side, { preview: null, loading: !!file, error: false, retained: !!slots.value[side].accepted })
  if (!file) return
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROMPT_SUITE_REPORT_MAX_BYTES || typeof file.arrayBuffer !== 'function') throw new Error('Invalid file')
    const bytes = await file.arrayBuffer()
    if (!active(side, token)) return
    if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength > PROMPT_SUITE_REPORT_MAX_BYTES) throw new Error('Invalid bytes')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const report = parsePromptSuiteReport(text)
    if (active(side, token)) setSlot(side, { preview: { report, token }, loading: false })
  } catch { if (active(side, token)) setSlot(side, { error: true, loading: false }) }
}
function discard(side, token) {
  if (!active(side, token)) return
  generations[side]++
  setSlot(side, { preview: null, loading: false, error: false, retained: !!slots.value[side].accepted })
}
function usePreview(side, preview) {
  if (!preview || !active(side, preview.token) || slots.value[side].preview !== preview) return
  generations[side]++
  setSlot(side, { ...emptySlot(), accepted: { report: preview.report } })
  invalidateResult()
}
function clearSlot(side, token) {
  if (!active(side, token)) return
  generations[side]++; setSlot(side, emptySlot()); invalidateResult()
}
const slotViews = computed(() => sides.map(side => {
  const slot = slots.value[side], token = generations[side], preview = slot.preview
  return { side, ...slot, read: event => readFile(side, event), use: () => usePreview(side, preview), cancel: () => discard(side, token), clear: () => clearSlot(side, token) }
}))
const sameRun = computed(() => !!slots.value.baseline.accepted && !!slots.value.comparison.accepted && slots.value.baseline.accepted.report.run_id === slots.value.comparison.accepted.report.run_id)
const canCompare = computed(() => !!slots.value.baseline.accepted && !!slots.value.comparison.accepted && !sameRun.value)
const canSwap = computed(() => sides.some(side => slots.value[side].accepted || slots.value[side].preview || slots.value[side].loading))
const swapAction = computed(() => {
  const owned = slots.value
  return () => {
    if (retired || slots.value !== owned) return
    generations.baseline++; generations.comparison++
    slots.value = { baseline: { ...emptySlot(), accepted: owned.comparison.accepted }, comparison: { ...emptySlot(), accepted: owned.baseline.accepted } }
    invalidateResult()
  }
})
const compareAction = computed(() => {
  const baseline = slots.value.baseline.accepted, comparison = slots.value.comparison.accepted, token = pairGeneration
  return () => {
    if (retired || token !== pairGeneration || !baseline || !comparison || slots.value.baseline.accepted !== baseline || slots.value.comparison.accepted !== comparison || baseline.report.run_id === comparison.report.run_id) return
    try {
      const capture = comparePromptSuiteReports(baseline.report, comparison.report), report = capture.toReport()
      const rows = report.rows.map(row => ({ ...row, transition: report.schema_version >= 2 ? row.check_transition : row.exact_transition, ...Object.fromEntries(sides.map(side => {
        const index = report[side].definition.cases.findIndex(item => item.case_id === row.case_id)
        return [side, index === -1 ? null : { item: report[side].definition.cases[index], section: report[side].cases[index] }]
      })) }))
      let exports = null
      try { exports = exportPromptSuiteComparison(capture); exportError.value = false } catch { exportError.value = true }
      result.value = { capture, report, rows, exports }; compareError.value = false
    } catch { compareError.value = true }
  }
})
// Render-local aliases prevent Vue from caching wrappers that dereference newer actions.
const pairActions = computed(() => ({ compare: compareAction.value, swap: swapAction.value }))
function download(owned, format) {
  if (retired || !owned?.exports || result.value !== owned) return
  let url = null, anchor = null
  try {
    url = URL.createObjectURL(new Blob([format === 'json' ? owned.exports.json_text : owned.exports.text], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }))
    if (retired || result.value !== owned) return
    anchor = document.createElement('a'); anchor.href = url; anchor.download = `local_prompt_suite_comparison.${format}`
    document.body.appendChild(anchor); anchor.click(); exportError.value = false
  } catch { if (!retired && result.value === owned) exportError.value = true }
  finally { try { anchor?.remove() } finally { if (url !== null) URL.revokeObjectURL(url) } }
}
const downloadActions = computed(() => { const owned = result.value; return { json: () => download(owned, 'json'), txt: () => download(owned, 'txt') } })
function checkKind(item) { return getPromptSuiteCheck(item).kind }
function requiredFieldsText(item) { return item.required_fields.map(rule => `${JSON.stringify(rule.name)}: ${rule.type}`).join('\n') }
function checkLabel(item, state) {
  const kind = checkKind(item)
  return t(`promptSuites.${kind === 'json_fields' ? 'jsonFieldsChecks' : kind === 'json_object' ? 'jsonChecks' : 'checks'}.${state}`)
}
function transitionLabel(row) {
  if (row.transition === null) return t('promptSuiteComparison.notComparable')
  const kind = checkKind(row.comparison.item)
  const labels = kind === 'json_fields' ? 'jsonFieldsTransitions' : kind === 'json_object' ? 'jsonTransitions' : 'transitions'
  return t(`promptSuiteComparison.${labels}.${row.transition}`)
}
function value(input) { return input == null ? t('promptTrials.unknown') : String(input) }
function position(input) { return input === null ? t('promptSuiteComparison.absent') : String(input) }
function booleanValue(input) { return input === null ? t('promptSuiteComparison.notComparable') : t(input ? 'promptSuiteComparison.yes' : 'promptSuiteComparison.no') }
function signed(input) { return input > 0 ? `+${input}` : String(input) }
function changedInputs(row) { return Object.keys(inputLabels).filter(key => row.input_changes?.[key]).map(key => t(inputLabels[key])) }
onBeforeUnmount(() => { retired = true; generations.baseline++; generations.comparison++; pairGeneration++; result.value = null })
</script>

<style scoped>
.comparison-page { min-height: 100vh; background: #f7f8fa; color: #1c2535; font-family: Inter, system-ui, sans-serif; }
.app-header { min-height: 72px; padding: 16px 5%; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: white; border-bottom: 1px solid #e2e6ec; }
.brand { font-weight: 800; letter-spacing: .1em; color: #15213b; text-decoration: none; }nav, .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }nav a { color: #435879; }
main { width: min(1180px, 92%); margin: 0 auto; padding: 36px 0 72px; }h1 { margin: 8px 0 12px; font-size: clamp(26px, 4vw, 38px); }h2 { font-size: 22px; }h3 { font-size: 19px; }h4 { font-size: 16px; }h5 { margin: 20px 0 8px; font-size: 14px; }.eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: #547395; }
p { line-height: 1.65; overflow-wrap: anywhere; }.two-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }.panel { min-width: 0; background: white; border: 1px solid #dce2eb; border-radius: 10px; padding: 24px; margin-top: 24px; }.panel h2 { margin-top: 0; }.preview { margin: 18px 0; padding: 16px; border: 1px solid #a4bfdf; border-radius: 6px; }.preview li { overflow-wrap: anywhere; margin: 8px 0; }
label { display: block; font-weight: 600; margin: 16px 0 8px; }input { max-width: 100%; font: inherit; }button { padding: 9px 14px; font: inherit; font-weight: 600; font-size: 14px; background: white; color: #294c78; border: 1px solid #aabbd0; border-radius: 5px; cursor: pointer; }.primary { background: #255b93; color: white; border-color: #255b93; }button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid #92bdf3; outline-offset: 3px; }.comparison-actions { margin-top: 24px; }
.notice { padding: 12px 16px; background: #edf3f9; border-radius: 6px; }.warning { background: #fff6e6; color: #76520c; }.error { background: #fff0ef; color: #9e2e27; }small, .reading-note, dt { color: #52647d; font-size: 13px; }.identifier { font-family: ui-monospace, monospace; font-size: 13px; }
dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }dd { margin: 5px 0 0; overflow-wrap: anywhere; }.summary-grid, .findings-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); padding: 16px; background: #f4f7fb; border-radius: 7px; }.summary-grid dd { font-size: 22px; font-weight: 700; }.case-row { border-top: 1px solid #dce2eb; padding-top: 18px; margin-top: 30px; }.case-side { min-width: 0; }.case-side h4 { border-bottom: 1px solid #e2e6ec; padding-bottom: 10px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.4em; background: #f4f6f9; border: 1px solid #e3e8ef; border-radius: 5px; padding: 14px; font-size: 13px; line-height: 1.6; unicode-bidi: plaintext; }summary { cursor: pointer; margin-top: 18px; color: #355d88; }
@media (max-width: 760px) { .two-columns { grid-template-columns: 1fr; gap: 12px; }.app-header { align-items: flex-start; flex-direction: column; gap: 12px; }.panel { padding: 16px; }.case-side + .case-side { border-top: 1px dashed #c7d0de; }.summary-grid, .findings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 380px) { dl, .summary-grid, .findings-grid { grid-template-columns: 1fr; } }
</style>
