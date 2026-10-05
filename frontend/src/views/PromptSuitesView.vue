<template>
  <div class="suites-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <nav class="header-actions" :aria-label="t('promptSuites.navigation')">
        <RouterLink to="/">{{ t('runtime.backHome') }}</RouterLink>
        <RouterLink to="/runtime">{{ t('runtime.navTitle') }}</RouterLink>
        <RouterLink to="/prompt-trials">{{ t('promptTrials.navTitle') }}</RouterLink>
        <RouterLink to="/prompt-suite-comparison">{{ t('promptSuiteComparison.navTitle') }}</RouterLink>
        <RouterLink to="/prompt-examples">{{ t('promptExamples.navTitle') }}</RouterLink>
        <LanguageSwitcher />
      </nav>
    </header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('promptSuites.eyebrow') }}</p><h1>{{ t('promptSuites.title') }}</h1><p>{{ t('promptSuites.scope') }}</p></header>
      <aside class="scope-note"><p>{{ t('promptSuites.boundaries') }}</p><p>{{ t('promptSuites.retention') }}</p></aside>
      <section class="toolbar" :aria-label="t('promptSuites.readiness')">
        <button type="button" data-testid="suite-refresh" :disabled="state.busy" @click="runner.refresh()">{{ t('promptSuites.refresh') }}</button>
        <span v-if="state.busy" role="status">{{ t(`promptSuites.phases.${state.phase}`) }}</span>
        <span v-if="state.latest">{{ t('promptTrials.observedAt') }} <time :datetime="state.latest.observed_at">{{ formatDate(state.latest.observed_at) }}</time></span>
      </section>
      <p v-if="state.latest_stale" class="notice warning" data-testid="suite-stale" role="status">{{ t('promptSuites.stale') }}</p>
      <p v-if="state.error_code" class="notice error" data-testid="suite-error" role="alert">{{ t(`promptSuites.${state.phase === 'paused' ? 'resumeErrors' : 'errors'}.${state.error_code}`) }}</p>
      <p v-if="state.latest && !state.latest.available" class="notice warning" data-testid="suite-unavailable">{{ t(`promptTrials.unavailable.${state.latest.unavailable_code}`) }}</p>
      <p v-if="state.latest?.run?.state === 'running' && !state.busy" class="notice warning">{{ t('promptSuites.backendBusy') }}</p>
      <p v-if="exportError" class="notice error" data-testid="suite-export-error" role="alert">{{ t('promptSuites.exportError') }}</p>

      <section class="panel" aria-labelledby="suite-files-title">
        <h2 id="suite-files-title">{{ t('promptSuites.filesTitle') }}</h2>
        <p>{{ t('promptSuites.filesNote') }}</p>
        <p>{{ t('promptSuites.runImportNote') }}</p>
        <div class="toolbar"><label class="file-label" for="suite-import-file">{{ t('promptSuites.import') }}<input id="suite-import-file" data-testid="suite-import-file" type="file" accept="application/json,.json" @change="readImport"></label><label class="file-label" for="suite-run-import-file">{{ t('promptSuites.importRun') }}<input id="suite-run-import-file" data-testid="suite-run-import-file" type="file" accept="application/json,.json" @change="readRunImport"></label><button type="button" data-testid="suite-export-definition" :disabled="!acceptedDraft" @click="downloadDefinition">{{ t('promptSuites.exportDefinition') }}</button><button type="button" data-testid="suite-export-selection" :disabled="!acceptedSelection" @click="downloadSelection">{{ t('promptSuites.exportSelection') }}</button></div>
        <template v-for="importView in importViews" :key="importView.token">
          <p v-if="importView.loading" role="status">{{ t('promptSuites.importLoading') }}</p>
          <p v-if="importView.error" class="notice error" data-testid="suite-import-error" role="alert">{{ t('promptSuites.importError') }}</p>
          <article v-if="importView.preview" class="import-preview" data-testid="suite-import-preview">
            <h3>{{ t('promptSuites.previewTitle') }}: {{ importView.preview.definition.name }}</h3>
            <template v-if="importView.preview.provenance">
              <p>{{ t('promptSuites.runPreviewNote') }}</p>
              <dl class="result-grid" data-testid="suite-import-provenance"><div><dt>{{ t('promptSuites.runId') }}</dt><dd>{{ importView.preview.provenance.run_id }}</dd></div><div><dt>{{ t('promptSuites.historicalStatus') }}</dt><dd>{{ t(`promptSuites.runStates.${importView.preview.provenance.status}`) }}</dd></div><div><dt>{{ t('promptTrials.startedAt') }}</dt><dd><time :datetime="importView.preview.provenance.started_at">{{ importView.preview.provenance.started_at }}</time></dd></div><div><dt>{{ t('promptTrials.finishedAt') }}</dt><dd><time v-if="importView.preview.provenance.finished_at" :datetime="importView.preview.provenance.finished_at">{{ importView.preview.provenance.finished_at }}</time><span v-else>{{ t('promptTrials.unknown') }}</span></dd></div><div><dt>{{ t('promptSuites.summary.attempted') }}</dt><dd>{{ importView.preview.provenance.attempted }}</dd></div><div><dt>{{ t('promptSuites.summary.total') }}</dt><dd>{{ importView.preview.provenance.total }}</dd></div></dl>
              <p data-testid="suite-import-selection-count" role="status">{{ t('promptSuites.selectionCount', { selected: importView.selectedCount, total: importView.cases.length }) }}</p>
              <div class="toolbar"><button type="button" data-testid="suite-import-select-all" @click="importView.selectAll">{{ t('promptSuites.selectAllCaptured') }}</button><button type="button" data-testid="suite-import-select-attention" @click="importView.selectAttention">{{ t('promptSuites.selectAttention') }}</button></div>
              <p class="reading-note">{{ t('promptSuites.attentionNote') }}</p>
              <p v-if="importView.selectedCount === 0" class="notice warning" data-testid="suite-import-selection-empty" role="status">{{ t('promptSuites.capturedSelectionEmpty') }}</p>
            </template>
            <p v-else>{{ t('promptSuites.previewNote', { count: importView.preview.definition.cases.length }) }}</p>
            <ol><li v-for="(item, index) in importView.cases" :key="item.case_id">
              <strong>{{ item.label }}</strong>
              <template v-if="item.recorded">
                <label class="check-control"><input type="checkbox" :data-testid="`suite-import-case-${index}-included`" :checked="item.included" @change="item.include">{{ t('promptSuites.includeCapturedCase') }}</label>
                <dl class="result-grid"><div><dt>{{ t('promptSuites.recordedOutcome') }}</dt><dd :data-testid="`suite-import-case-${index}-status`">{{ t(`promptSuites.caseStates.${item.recorded.status}`) }}</dd></div><div><dt>{{ t('promptSuites.recordedCheck') }}</dt><dd :data-testid="`suite-import-case-${index}-check`">{{ checkLabel(item, item.recorded.check) }}</dd></div></dl>
              </template>
              <dl class="result-grid"><div><dt>{{ t('promptTrials.temperature') }}</dt><dd>{{ item.temperature }}</dd></div><div><dt>{{ t('promptTrials.maxOutputTokens') }}</dt><dd>{{ item.max_output_tokens }}</dd></div></dl><details><summary>{{ t('promptSuites.reviewCase') }}</summary><h4>{{ t('promptTrials.systemPrompt') }}</h4><pre>{{ item.system_prompt }}</pre><h4>{{ t('promptTrials.userPrompt') }}</h4><pre>{{ item.user_prompt }}</pre><h4>{{ t('promptSuites.checkKind') }}</h4><p>{{ t(`promptSuites.checkKinds.${checkKind(item)}`) }}</p><p v-if="checkKind(item) === 'json_object'" class="reading-note">{{ t('promptSuites.jsonObjectHint') }}</p><template v-if="checkKind(item) === 'json_fields'"><h4>{{ t('promptSuites.requiredFields') }}</h4><pre :data-testid="`suite-import-case-${index}-required-fields`">{{ requiredFieldsText(item) }}</pre><p class="reading-note">{{ t('promptSuites.jsonFieldsHint') }}</p></template><template v-if="checkKind(item) === 'exact_text'"><h4>{{ t('promptSuites.expected') }}</h4><pre>{{ item.expected_text }}</pre><small v-if="item.expected_text === ''">{{ t('promptSuites.emptyExpected') }}</small></template></details>
            </li></ol>
            <div class="toolbar"><button type="button" class="primary" data-testid="suite-import-use" :disabled="importView.selectedCount === 0" @click="importView.use">{{ t(importView.preview.provenance ? importView.selectedCount === importView.cases.length ? 'promptSuites.useCapturedCases' : 'promptSuites.useSelectedCapturedCases' : 'promptSuites.useImport') }}</button><button type="button" data-testid="suite-import-cancel" @click="importView.cancel">{{ t('promptSuites.cancelImport') }}</button></div>
          </article>
          <button v-else-if="importView.loading" type="button" data-testid="suite-import-cancel" @click="importView.cancel">{{ t('promptSuites.cancelImport') }}</button>
        </template>
      </section>

      <form class="panel" data-testid="suite-form" novalidate @submit.prevent="start">
        <div class="panel-heading"><h2>{{ t('promptSuites.editorTitle') }}</h2><span>{{ draft.cases.length }}/5</span></div>
        <p data-testid="suite-selection-count" role="status">{{ t('promptSuites.selectionCount', { selected: selectedCases.length, total: draft.cases.length }) }}</p>
        <p class="reading-note">{{ t('promptSuites.selectionNote') }}</p>
        <div class="field"><label for="suite-name">{{ t('promptSuites.name') }}</label><input id="suite-name" data-testid="suite-name" :value="draft.name" required @input="draft.name = $event.target.value"><small>{{ t('promptSuites.nameHint') }}</small></div>
        <p v-if="duplicateError" class="notice error" data-testid="suite-duplicate-error" role="alert">{{ t('promptSuites.duplicateError') }}</p>
        <fieldset v-for="({ item, included, include, remove, duplicate, moveUp, moveDown }, index) in caseViews" :key="item.case_id" class="case-editor" :data-case-id="item.case_id">
          <legend>{{ t('promptSuites.caseNumber', { number: index + 1 }) }}</legend>
          <label class="check-control"><input type="checkbox" :data-testid="`suite-case-${index}-included`" :checked="included" @change="include">{{ t('promptSuites.includeCase') }}</label>
          <div class="field"><label :for="`suite-label-${item.case_id}`">{{ t('promptTrials.label') }}</label><input :id="`suite-label-${item.case_id}`" :data-testid="`suite-case-${index}-label`" :value="item.label" required @input="item.label = $event.target.value"><small>{{ t('promptTrials.labelHint') }}</small></div>
          <div class="field"><label :for="`suite-system-${item.case_id}`">{{ t('promptTrials.systemPrompt') }}</label><textarea :id="`suite-system-${item.case_id}`" :data-testid="`suite-case-${index}-system_prompt`" rows="2" :value="item.system_prompt" @input="item.system_prompt = $event.target.value" /><small>{{ t('promptTrials.systemHint') }}</small></div>
          <div class="field"><label :for="`suite-user-${item.case_id}`">{{ t('promptTrials.userPrompt') }}</label><textarea :id="`suite-user-${item.case_id}`" :data-testid="`suite-case-${index}-user_prompt`" rows="3" :value="item.user_prompt" required @input="item.user_prompt = $event.target.value" /><small>{{ t('promptTrials.userHint') }}</small></div>
          <div class="settings-grid">
            <div class="field"><label :for="`suite-temperature-${item.case_id}`">{{ t('promptTrials.temperature') }}</label><input :id="`suite-temperature-${item.case_id}`" :data-testid="`suite-case-${index}-temperature`" type="number" min="0" max="1" step="any" required :value="item.temperature" @input="item.temperature = numeric($event.target.value)"></div>
            <div class="field"><label :for="`suite-output-${item.case_id}`">{{ t('promptTrials.maxOutputTokens') }}</label><input :id="`suite-output-${item.case_id}`" :data-testid="`suite-case-${index}-max_output_tokens`" type="number" min="1" max="512" step="1" required :value="item.max_output_tokens" @input="item.max_output_tokens = numeric($event.target.value)"><small>{{ t('promptTrials.outputHint', { cap: state.latest?.limits.max_output_tokens ?? t('promptTrials.unknown') }) }}</small></div>
          </div>
          <label class="check-control"><input type="checkbox" :data-testid="`suite-case-${index}-check_enabled`" :checked="checkKind(item) !== 'none'" @change="setCheckEnabled(item, $event.target.checked)">{{ t('promptSuites.enableCheck') }}</label>
          <div v-if="checkKind(item) !== 'none'" class="field"><label :for="`suite-check-kind-${item.case_id}`">{{ t('promptSuites.checkKind') }}</label><select :id="`suite-check-kind-${item.case_id}`" :data-testid="`suite-case-${index}-check_kind`" :value="checkKind(item)" @change="setCheckKind(item, $event.target.value)"><option value="exact_text">{{ t('promptSuites.checkKinds.exact_text') }}</option><option value="json_object">{{ t('promptSuites.checkKinds.json_object') }}</option><option value="json_fields">{{ t('promptSuites.checkKinds.json_fields') }}</option></select></div>
          <div v-if="checkKind(item) === 'exact_text'" class="field"><label :for="`suite-expected-${item.case_id}`">{{ t('promptSuites.expected') }}</label><textarea :id="`suite-expected-${item.case_id}`" :data-testid="`suite-case-${index}-expected_text`" rows="2" :value="item.expected_text" @input="setExpectedText(item, $event.target.value)" /><small>{{ t('promptSuites.expectedHint') }}</small></div>
          <p v-if="checkKind(item) === 'json_object'" class="reading-note">{{ t('promptSuites.jsonObjectHint') }}</p>
          <section v-for="fieldsView in requiredFieldViews(item)" :key="'required-fields'" class="required-fields" :aria-label="t('promptSuites.requiredFields')">
            <h4>{{ t('promptSuites.requiredFields') }} <small>{{ fieldsView.fields.length }}/10</small></h4>
            <p class="reading-note">{{ t('promptSuites.requiredFieldsHint') }}</p>
            <div v-for="(fieldView, ruleIndex) in fieldsView.rules" :key="ruleIndex" class="required-field-row">
              <div class="field"><label :for="`suite-field-name-${item.case_id}-${ruleIndex}`">{{ t('promptSuites.fieldName', { number: ruleIndex + 1 }) }}</label><input :id="`suite-field-name-${item.case_id}-${ruleIndex}`" :data-testid="`suite-case-${index}-required-field-${ruleIndex}-name`" :value="fieldView.rule.name" maxlength="160" required @input="fieldView.name"></div>
              <div class="field"><label :for="`suite-field-type-${item.case_id}-${ruleIndex}`">{{ t('promptSuites.fieldType') }}</label><select :id="`suite-field-type-${item.case_id}-${ruleIndex}`" :data-testid="`suite-case-${index}-required-field-${ruleIndex}-type`" :value="fieldView.rule.type" required @change="fieldView.type"><option value="">{{ t('promptSuites.chooseFieldType') }}</option><option v-for="type in fieldTypes" :key="type" :value="type">{{ t(`promptSuites.fieldTypes.${type}`) }}</option></select></div>
              <button type="button" :data-testid="`suite-case-${index}-required-field-${ruleIndex}-remove`" :disabled="fieldsView.fields.length <= 1" @click="fieldView.remove">{{ t('promptSuites.removeField') }}</button>
            </div>
            <button type="button" :data-testid="`suite-case-${index}-add-required-field`" :disabled="fieldsView.fields.length >= 10" @click="fieldsView.add">{{ t('promptSuites.addField') }}</button>
            <p class="reading-note">{{ t('promptSuites.jsonFieldsHint') }}</p>
          </section>
          <div class="toolbar">
            <button type="button" :data-testid="`suite-case-${index}-duplicate`" :disabled="draft.cases.length >= 5" @click="duplicate">{{ t('promptSuites.duplicateCase') }}</button>
            <button type="button" :data-testid="`suite-case-${index}-move-up`" :disabled="index === 0" @click="moveUp">{{ t('promptSuites.moveUp') }}</button>
            <button type="button" :data-testid="`suite-case-${index}-move-down`" :disabled="index === draft.cases.length - 1" @click="moveDown">{{ t('promptSuites.moveDown') }}</button>
            <button type="button" :data-testid="`suite-case-${index}-remove`" :disabled="draft.cases.length === 1" @click="remove">{{ t('promptSuites.removeCase') }}</button>
          </div>
        </fieldset>
        <div class="toolbar"><button type="button" data-testid="suite-add-case" :disabled="draft.cases.length === 5" @click="addCase">{{ t('promptSuites.addCase') }}</button></div>
        <p v-if="!acceptedDraft" class="reading-note" data-testid="suite-validation">{{ t('promptSuites.validation') }}</p>
        <p v-if="!acceptedSelection" class="reading-note" data-testid="suite-selection-validation">{{ t(selectedCases.length === 0 ? 'promptSuites.selectionEmpty' : 'promptSuites.selectionInvalid') }}</p>
        <p v-if="capExceeded" class="notice warning" data-testid="suite-cap-warning">{{ t('promptSuites.capExceeded', { cap: state.latest.limits.max_output_tokens }) }}</p>
        <div class="toolbar"><button class="primary" type="submit" data-testid="suite-run" :disabled="!canRun">{{ t('promptSuites.run') }}</button><template v-for="controls in schedulingControls" :key="controls.runId"><button type="button" data-testid="suite-pause" :disabled="!state.can_pause" @click="controls.pause">{{ t('promptSuites.pause') }}</button><button type="button" data-testid="suite-resume" :disabled="!state.can_resume" @click="controls.resume">{{ t('promptSuites.resume') }}</button></template><button type="button" data-testid="suite-stop" :disabled="!canStop" @click="runner.stop()">{{ t('promptSuites.stop') }}</button></div>
        <p v-if="state.pause_requested" class="notice" data-testid="suite-scheduling-state" :data-phase="state.phase === 'paused' ? 'paused' : 'pause_pending'" role="status">{{ t(state.phase === 'paused' ? 'promptSuites.pausedNote' : 'promptSuites.pausePending') }}</p>
        <p class="reading-note">{{ t('promptSuites.runNote') }}</p><p class="reading-note">{{ t('promptSuites.pauseNote') }}</p><p class="reading-note">{{ t('promptSuites.stopNote') }}</p>
      </form>

      <section class="panel" aria-labelledby="suite-results-title">
        <div class="panel-heading"><h2 id="suite-results-title">{{ t('promptSuites.resultsTitle') }}</h2><button type="button" data-testid="suite-export-run" :disabled="!state.report" @click="downloadRun">{{ t('promptSuites.exportRun') }}</button></div>
        <p class="reading-note">{{ t('promptSuites.capturedNote') }}</p><p class="reading-note">{{ t('promptSuites.pauseSessionNote') }}</p>
        <p v-if="!state.report">{{ t('promptSuites.noRun') }}</p>
        <div v-else data-testid="suite-run-report" :data-status="state.report.status">
          <h3>{{ state.report.definition.name }}</h3>
          <p><span class="badge" data-testid="suite-run-status">{{ t(state.phase === 'paused' ? 'promptSuites.phases.paused' : `promptSuites.runStates.${state.report.status}`) }}</span> <span v-if="state.report.stop_requested">{{ t('promptSuites.stopRequested') }}</span></p>
          <p v-if="state.report.halt_code" class="notice warning">{{ t(`promptSuites.errors.${state.report.halt_code}`) }}</p>
          <p v-if="canReconcile" class="notice warning">{{ t('promptSuites.reconcileNote') }}</p>
          <button v-if="canReconcile" type="button" data-testid="suite-reconcile" @click="runner.reconcile()">{{ t('promptSuites.reconcile') }}</button>
          <dl class="result-grid"><div><dt>{{ t('promptSuites.runId') }}</dt><dd>{{ state.report.run_id }}</dd></div><div><dt>{{ t('promptTrials.startedAt') }}</dt><dd>{{ formatDate(state.report.started_at) }}</dd></div><div><dt>{{ t('promptTrials.finishedAt') }}</dt><dd>{{ formatDate(state.report.finished_at) }}</dd></div></dl>
          <dl class="summary-grid" data-testid="suite-summary"><div v-for="key in summaryFields" :key="key"><dt>{{ t(`promptSuites.${state.report.schema_version >= 2 ? 'checkSummary' : 'summary'}.${key}`) }}</dt><dd>{{ summary[key] }}</dd></div></dl>
          <p class="reading-note">{{ t(state.report.schema_version >= 2 ? 'promptSuites.formatCheckNote' : 'promptSuites.checkNote') }}</p>
          <article v-for="(result, index) in state.report.cases" :key="result.case_id" class="case-result" :data-testid="`suite-result-${index}`" :data-status="result.status" :data-check="result.check">
            <h3>{{ index + 1 }}. {{ state.report.definition.cases[index].label }}</h3>
            <div class="toolbar"><span class="badge" :data-testid="`suite-result-${index}-status`">{{ t(`promptSuites.caseStates.${result.status}`) }}</span><span class="badge" :data-testid="`suite-result-${index}-check`">{{ checkLabel(state.report.definition.cases[index], result.check) }}</span></div>
            <p v-if="result.error_code" class="notice warning">{{ t(`promptSuites.errors.${result.error_code}`) }}</p>
            <details><summary>{{ t('promptSuites.capturedCase') }}</summary><h4>{{ t('promptTrials.systemPrompt') }}</h4><pre>{{ state.report.definition.cases[index].system_prompt }}</pre><h4>{{ t('promptTrials.userPrompt') }}</h4><pre>{{ state.report.definition.cases[index].user_prompt }}</pre><h4>{{ t('promptSuites.checkKind') }}</h4><p :data-testid="`suite-result-${index}-kind`">{{ t(`promptSuites.checkKinds.${checkKind(state.report.definition.cases[index])}`) }}</p><p v-if="checkKind(state.report.definition.cases[index]) === 'json_object'" class="reading-note">{{ t('promptSuites.jsonObjectHint') }}</p><template v-if="checkKind(state.report.definition.cases[index]) === 'json_fields'"><h4>{{ t('promptSuites.requiredFields') }}</h4><pre :data-testid="`suite-result-${index}-required-fields`">{{ requiredFieldsText(state.report.definition.cases[index]) }}</pre><p class="reading-note">{{ t('promptSuites.jsonFieldsHint') }}</p></template><template v-if="checkKind(state.report.definition.cases[index]) === 'exact_text'"><h4>{{ t('promptSuites.expected') }}</h4><pre>{{ state.report.definition.cases[index].expected_text }}</pre><small v-if="state.report.definition.cases[index].expected_text === ''">{{ t('promptSuites.emptyExpected') }}</small></template></details>
            <template v-if="result.snapshot">
              <dl class="result-grid"><div><dt>{{ t('promptTrials.requestId') }}</dt><dd>{{ result.request_id }}</dd></div><div><dt>{{ t('promptTrials.capturedModel') }}</dt><dd :data-testid="`suite-result-${index}-model`">{{ result.snapshot.run.configuration.model }}</dd></div><div><dt>{{ t('promptTrials.reasoningEffort') }}</dt><dd>{{ result.snapshot.run.configuration.reasoning_effort ?? t('promptTrials.serverDefault') }}</dd></div><div><dt>{{ t('promptTrials.temperature') }}</dt><dd>{{ result.snapshot.run.request.temperature }}</dd></div><div><dt>{{ t('promptTrials.maxOutputTokens') }}</dt><dd>{{ result.snapshot.run.request.max_output_tokens }}</dd></div><div><dt>{{ t('promptTrials.finishReason') }}</dt><dd>{{ value(result.snapshot.run.response?.finish_reason) }}</dd></div><div><dt>{{ t('promptTrials.requestDuration') }}</dt><dd>{{ value(result.snapshot.run.request_duration_ms) }}</dd></div><div><dt>{{ t('promptTrials.overallDuration') }}</dt><dd>{{ result.snapshot.run.elapsed_ms }}</dd></div><div><dt>{{ t('promptTrials.promptTokens') }}</dt><dd>{{ value(result.snapshot.run.response?.usage.prompt_tokens) }}</dd></div><div><dt>{{ t('promptTrials.completionTokens') }}</dt><dd>{{ value(result.snapshot.run.response?.usage.completion_tokens) }}</dd></div><div><dt>{{ t('promptTrials.totalTokens') }}</dt><dd>{{ value(result.snapshot.run.response?.usage.total_tokens) }}</dd></div><div><dt>{{ t('promptTrials.cleanup') }}</dt><dd>{{ t(`promptTrials.cleanupStates.${result.snapshot.run.cleanup.state}`) }}</dd></div></dl>
              <p v-if="result.snapshot.run.error_code" class="notice error">{{ t(`promptTrials.errors.${result.snapshot.run.error_code}`) }}</p>
              <h4>{{ t('promptTrials.reply') }}</h4>
              <template v-if="typeof result.snapshot.run.response?.content === 'string'"><pre :data-testid="`suite-result-${index}-reply`">{{ result.snapshot.run.response.content }}</pre><small v-if="result.snapshot.run.response.content === ''">{{ t('promptTrials.emptyContent') }}</small></template>
              <p v-else>{{ t('promptTrials.noContent') }}</p>
              <template v-if="typeof result.snapshot.run.response?.refusal === 'string'"><h4>{{ t('promptTrials.refusal') }}</h4><pre :data-testid="`suite-result-${index}-refusal`">{{ result.snapshot.run.response.refusal }}</pre></template>
            </template>
          </article>
        </div>
        <p class="reading-note">{{ t('promptSuites.privacy') }}</p>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { acceptPromptSuiteDefinition, parsePromptSuiteDefinition, parsePromptSuiteReport, exportPromptSuiteDefinition, exportPromptSuiteReport, summarizePromptSuiteReport, getPromptSuiteCheck, PROMPT_SUITE_MAX_BYTES, PROMPT_SUITE_REPORT_MAX_BYTES } from '../utils/promptSuites.js'
import { createPromptSuiteRunner } from '../utils/promptSuiteRunner.js'

const { t, locale } = useI18n()
let retired = false, importGeneration = 0
const draft = ref({ schema_version: 1, kind: 'mirofish_local_prompt_suite', name: '', cases: [newCase(1)] })
// Only excluded objects are retained, at most the five cases in the draft.
// New and duplicated objects start included without adding selection metadata.
const excludedCases = shallowRef([])
// Preview selection is separate from both its immutable owner and draft selection.
const excludedImportCases = shallowRef([])
const emptyImport = token => ({ token, preview: null, loading: false, error: false })
const importState = shallowRef(emptyImport(importGeneration)), exportError = ref(false), duplicateError = ref(false)
const state = ref(null)
const runner = createPromptSuiteRunner({ onChange: next => { if (!retired) state.value = next } })
state.value = runner.getState()
const acceptedDraft = computed(() => { try { return acceptPromptSuiteDefinition(draft.value) } catch { return null } })
const selectedCases = computed(() => draft.value.cases.filter(item => !excludedCases.value.includes(item)))
const acceptedSelection = computed(() => { try { return acceptPromptSuiteDefinition({ ...draft.value, cases: selectedCases.value }) } catch { return null } })
const capExceeded = computed(() => state.value.latest?.limits.max_output_tokens != null && selectedCases.value.some(item => item.max_output_tokens > state.value.latest.limits.max_output_tokens))
const canRun = computed(() => !retired && !state.value.busy && !state.value.latest_stale && state.value.latest?.available === true && state.value.latest?.run?.state !== 'running' && acceptedSelection.value !== null && !capExceeded.value)
const canStop = computed(() => !retired && (state.value.phase === 'checking' || (state.value.report?.status === 'running' && !state.value.report.stop_requested)))
const canReconcile = computed(() => !retired && !state.value.busy && state.value.report?.cases.some(item => item.status === 'unknown'))
// Render-local aliases prevent Vue's cached event wrappers from resolving the
// latest handler when a retained callback from an older run eventually fires.
const schedulingControls = computed(() => {
  const runId = state.value.report?.run_id
  return [{ runId, pause: () => runner.pause(runId), resume: () => runner.resume(runId) }]
})
const summaryFields = ['total', 'attempted', 'succeeded', 'evaluated', 'matched', 'mismatched', 'not_requested', 'not_evaluated']
const summary = computed(() => state.value.report ? summarizePromptSuiteReport(state.value.report) : null)
const fieldTypes = ['string', 'number', 'boolean', 'object', 'array', 'null']
function newCase(number, version = 1) { return { case_id: crypto.randomUUID(), label: t('promptSuites.caseNumber', { number }), system_prompt: '', user_prompt: '', temperature: 0.2, max_output_tokens: 128, expected_text: null, ...(version >= 2 ? { check_kind: 'none' } : {}), ...(version >= 3 ? { required_fields: null } : {}) } }
function checkKind(item) { return getPromptSuiteCheck(item).kind }
function checkLabel(item, state) {
  const kind = checkKind(item)
  return t(`promptSuites.${kind === 'json_fields' ? 'jsonFieldsChecks' : kind === 'json_object' ? 'jsonChecks' : 'checks'}.${state}`)
}
function requiredFieldsText(item) { return item.required_fields.map(rule => `${JSON.stringify(rule.name)}: ${rule.type}`).join('\n') }
function ownsCase(item) { return !retired && draft.value.cases.includes(item) }
function setCheckEnabled(item, enabled) {
  if (!ownsCase(item) || enabled === (checkKind(item) !== 'none')) return
  item.expected_text = enabled ? '' : null
  if (draft.value.schema_version >= 2) item.check_kind = enabled ? 'exact_text' : 'none'
  if (draft.value.schema_version >= 3) item.required_fields = null
}
function setCheckKind(item, kind) {
  if (!ownsCase(item) || checkKind(item) === 'none' || checkKind(item) === kind || !['exact_text', 'json_object', 'json_fields'].includes(kind)) return
  if (kind !== 'exact_text' && draft.value.schema_version === 1) {
    for (const current of draft.value.cases) current.check_kind = checkKind(current)
    draft.value.schema_version = 2
  }
  if (kind === 'json_fields' && draft.value.schema_version < 3) {
    for (const current of draft.value.cases) current.required_fields = null
    draft.value.schema_version = 3
  }
  item.expected_text = kind === 'exact_text' ? item.expected_text ?? '' : null
  if (draft.value.schema_version >= 2) item.check_kind = kind
  if (draft.value.schema_version >= 3) item.required_fields = kind === 'json_fields' ? [{ name: '', type: '' }] : null
}
function setExpectedText(item, value) { if (ownsCase(item) && checkKind(item) === 'exact_text') item.expected_text = value }
function ownsRequiredFields(item, fields) { return ownsCase(item) && checkKind(item) === 'json_fields' && item.required_fields === fields }
function ownsRequiredField(item, fields, rule) { return ownsRequiredFields(item, fields) && fields.includes(rule) }
// Each rendered action owns its case, list and rule. Replacing a list during a
// mode change retires its old actions even if the same case becomes JSON again.
function requiredFieldViews(item) {
  if (checkKind(item) !== 'json_fields') return []
  const fields = item.required_fields
  return [{
    fields,
    add() { if (ownsRequiredFields(item, fields) && fields.length < 10) fields.push({ name: '', type: '' }) },
    rules: fields.map(rule => ({
      rule,
      name(event) { if (ownsRequiredField(item, fields, rule)) rule.name = event.target.value },
      type(event) { if (ownsRequiredField(item, fields, rule)) rule.type = event.target.value },
      remove() { if (ownsRequiredField(item, fields, rule) && fields.length > 1) fields.splice(fields.indexOf(rule), 1) },
    })),
  }]
}
function numeric(input) { return input === '' ? '' : Number(input) }
function addCase() { if (!retired && draft.value.cases.length < 5) draft.value.cases.push(newCase(draft.value.cases.length + 1, draft.value.schema_version)) }
function ownsDraftCase(owned, item) { return !retired && draft.value === owned && owned.cases.includes(item) }
function setIncluded(owned, item, included) {
  if (!ownsDraftCase(owned, item)) return
  if (included) excludedCases.value = excludedCases.value.filter(current => current !== item)
  else if (!excludedCases.value.includes(item)) excludedCases.value = [...excludedCases.value, item]
}
function removeCase(owned, item) {
  if (!ownsDraftCase(owned, item) || owned.cases.length <= 1) return
  owned.cases.splice(owned.cases.indexOf(item), 1)
  excludedCases.value = excludedCases.value.filter(current => current !== item)
}
function duplicateCase(owned, item) {
  if (!ownsDraftCase(owned, item) || owned.cases.length >= 5) return
  try {
    const case_id = crypto.randomUUID()
    if (typeof case_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(case_id) || owned.cases.some(current => current.case_id === case_id)) throw new Error('Invalid case identity')
    const copy = { ...item, case_id, ...(Array.isArray(item.required_fields) ? { required_fields: item.required_fields.map(rule => ({ ...rule })) } : {}) }
    owned.cases.splice(owned.cases.indexOf(item) + 1, 0, copy)
    duplicateError.value = false
  } catch { duplicateError.value = true }
}
function moveCase(owned, item, direction) {
  if (!ownsDraftCase(owned, item)) return
  const index = owned.cases.indexOf(item), target = index + direction
  if (target < 0 || target >= owned.cases.length) return
  owned.cases.splice(index, 1)
  owned.cases.splice(target, 0, item)
}
// Render-local aliases retain exact draft/case ownership across imports, even
// when replacement cases reuse IDs and Vue caches event wrappers.
const caseViews = computed(() => {
  const owned = draft.value
  return owned.cases.map(item => ({ item, included: !excludedCases.value.includes(item),
    include: event => setIncluded(owned, item, event.target.checked), remove: () => removeCase(owned, item),
    duplicate: () => duplicateCase(owned, item), moveUp: () => moveCase(owned, item, -1), moveDown: () => moveCase(owned, item, 1) }))
})
function start() { if (canRun.value) runner.start(acceptedSelection.value) }
function ownsImport(owned) { return !retired && importGeneration === owned.token && importState.value === owned }
async function readImportFile(event, fromRun) {
  if (retired) return
  const file = event.target.files?.[0]
  const token = ++importGeneration
  event.target.value = ''
  const owned = { ...emptyImport(token), loading: !!file }
  importState.value = owned
  excludedImportCases.value = []
  if (!file) return
  try {
    let definition, provenance = null, recorded = null
    if (fromRun) {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROMPT_SUITE_REPORT_MAX_BYTES || typeof file.arrayBuffer !== 'function') throw new Error('Invalid run file')
      const bytes = await file.arrayBuffer()
      if (!ownsImport(owned)) return
      if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength > PROMPT_SUITE_REPORT_MAX_BYTES) throw new Error('Invalid bytes')
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      const report = parsePromptSuiteReport(content)
      definition = acceptPromptSuiteDefinition(report.definition)
      recorded = report.cases.map(({ status, check }) => ({ status, check }))
      provenance = { run_id: report.run_id, status: report.status, started_at: report.started_at, finished_at: report.finished_at,
        total: report.cases.length, attempted: report.cases.filter(item => item.status !== 'not_attempted').length }
    } else {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROMPT_SUITE_MAX_BYTES || typeof file.text !== 'function') throw new Error('Invalid suite file')
      const content = await file.text()
      if (!ownsImport(owned)) return
      if (typeof content !== 'string' || new TextEncoder().encode(content).length > PROMPT_SUITE_MAX_BYTES) throw new Error('Oversize suite file')
      definition = parsePromptSuiteDefinition(content)
    }
    if (ownsImport(owned)) importState.value = { ...owned, loading: false, preview: { definition, provenance, recorded } }
  } catch { if (ownsImport(owned)) importState.value = { ...owned, loading: false, error: true } }
}
function readImport(event) { return readImportFile(event, false) }
function readRunImport(event) { return readImportFile(event, true) }
function cancelImport(owned) {
  if (!retired && owned.token === importGeneration) { importState.value = emptyImport(++importGeneration); excludedImportCases.value = [] }
}
function setImportIncluded(owned, item, included) {
  if (!ownsImport(owned) || !owned.preview?.recorded || !owned.preview.definition.cases.includes(item)) return
  if (included) excludedImportCases.value = excludedImportCases.value.filter(current => current !== item)
  else if (!excludedImportCases.value.includes(item)) excludedImportCases.value = [...excludedImportCases.value, item]
}
function selectImportCases(owned, attention) {
  if (!ownsImport(owned) || !owned.preview?.recorded) return
  excludedImportCases.value = attention ? owned.preview.definition.cases.filter((_item, index) => {
    const row = owned.preview.recorded[index]
    return !(row.status !== 'succeeded' || row.check === 'mismatched')
  }) : []
}
function useImport(owned, excluded) {
  if (!ownsImport(owned) || !owned.preview || excludedImportCases.value !== excluded) return
  const definition = owned.preview.definition, cases = definition.cases.filter(item => !excluded.includes(item))
  if (cases.length === 0) return
  try { draft.value = acceptPromptSuiteDefinition({ ...definition, cases }); excludedCases.value = []; duplicateError.value = false; cancelImport(owned) }
  catch { if (ownsImport(owned)) importState.value = { ...owned, error: true } }
}
// Checkbox/shortcut callbacks own the exact preview, while Apply also owns its
// rendered selection revision. Neither case IDs nor returning to an old subset
// can reactivate a stale Apply callback.
const importViews = computed(() => {
  const owned = importState.value, excluded = excludedImportCases.value
  const cases = (owned.preview?.definition.cases ?? []).map((item, index) => ({ ...item,
    recorded: owned.preview.recorded?.[index], included: !excluded.includes(item),
    include: event => setImportIncluded(owned, item, event.target.checked) }))
  return [{ ...owned, cases, selectedCount: cases.filter(item => item.included).length,
    use: () => useImport(owned, excluded), cancel: () => cancelImport(owned),
    selectAll: () => selectImportCases(owned, false), selectAttention: () => selectImportCases(owned, true) }]
})
function download(content, filename) {
  if (retired) return
  let url = null, anchor = null
  try {
    url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    if (retired) return
    anchor = document.createElement('a'); anchor.href = url; anchor.download = filename
    document.body.appendChild(anchor); anchor.click(); exportError.value = false
  } catch { if (!retired) exportError.value = true }
  finally { anchor?.remove(); if (url !== null) URL.revokeObjectURL(url) }
}
function downloadDefinition() {
  if (retired || !acceptedDraft.value) return
  try { download(exportPromptSuiteDefinition(acceptedDraft.value), 'local_prompt_suite.json') } catch { exportError.value = true }
}
function downloadSelection() {
  if (retired || !acceptedSelection.value) return
  try { download(exportPromptSuiteDefinition(acceptedSelection.value), 'local_prompt_suite_selection.json') } catch { exportError.value = true }
}
function downloadRun() {
  if (retired || !state.value.report) return
  try { download(exportPromptSuiteReport(state.value.report), `local_prompt_suite_run_${state.value.report.run_id}.json`) } catch { exportError.value = true }
}
function value(input) { return input == null ? t('promptTrials.unknown') : String(input) }
function formatDate(input) { return input === null ? t('promptTrials.unknown') : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(input)) }
onMounted(() => runner.refresh())
onBeforeUnmount(() => { retired = true; importGeneration++; excludedCases.value = []; excludedImportCases.value = []; runner.dispose() })
</script>

<style scoped>
.suites-page { min-height: 100vh; background: #f7f8fa; color: #1c2535; font-family: Inter, system-ui, sans-serif; }
.app-header { min-height: 72px; padding: 16px 5%; display: flex; justify-content: space-between; align-items: center; gap: 24px; background: white; border-bottom: 1px solid #e2e6ec; }
.brand { font-weight: 800; letter-spacing: .1em; color: #15213b; text-decoration: none; }
.header-actions, .toolbar, .panel-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.header-actions a { color: #435879; text-decoration: none; }
main { width: min(1100px, 92%); margin: 0 auto; padding: 36px 0 72px; }
.page-heading { margin-bottom: 24px; }.page-heading h1 { margin: 8px 0 12px; font-size: clamp(26px, 4vw, 38px); }
.eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: #547395; }
p { line-height: 1.65; }.scope-note { border-left: 4px solid #6287b0; background: #edf3f9; padding: 8px 20px; margin-bottom: 24px; }.scope-note p { margin: 8px 0; }
.panel { background: #fff; border: 1px solid #dce2eb; border-radius: 10px; padding: 24px; margin-top: 24px; }.panel h2 { font-size: 20px; margin: 0 0 16px; }.panel-heading { justify-content: space-between; margin-bottom: 16px; }.panel-heading h2 { margin: 0; }
.field { display: flex; flex-direction: column; gap: 7px; margin-bottom: 18px; }.field label, legend { font-weight: 600; }input:not([type=checkbox]), textarea, select { box-sizing: border-box; width: 100%; background: #fff; border: 1px solid #b9c4d4; border-radius: 5px; padding: 10px; font: inherit; color: inherit; }textarea { resize: vertical; }small, .reading-note { color: #52647d; font-size: 13px; }.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
button { padding: 9px 14px; font: inherit; font-weight: 600; font-size: 14px; background: #fff; color: #294c78; border: 1px solid #aabbd0; border-radius: 5px; cursor: pointer; }button.primary { background: #255b93; color: white; border-color: #255b93; }button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid #92bdf3; outline-offset: 3px; }
.case-editor { min-width: 0; border: 1px solid #dce2eb; border-radius: 7px; padding: 18px; margin: 24px 0; }.case-editor legend { padding: 0 8px; }.check-control { display: flex; align-items: center; gap: 9px; margin: 0 0 16px; }.file-label { display: flex; flex-direction: column; gap: 8px; }.file-label input { max-width: 380px; }.notice { padding: 12px 15px; border-radius: 5px; background: #eef3fa; }.warning { background: #fff6e6; color: #76520c; }.error { background: #fff0ef; color: #9e2e27; }.badge { font-size: 13px; font-weight: 600; background: #edf2f8; border-radius: 5px; padding: 6px 9px; }.case-result { border-top: 1px solid #dce2eb; margin-top: 26px; padding-top: 12px; }.import-preview { margin-top: 20px; padding: 18px; border: 1px solid #b4c8e3; border-radius: 7px; }.import-preview li { margin: 18px 0; }
.result-grid, .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 20px 0; }dt { font-size: 12px; color: #52647d; }dd { margin: 5px 0 0; overflow-wrap: anywhere; } .summary-grid { background: #f4f7fb; border-radius: 7px; padding: 16px; }.summary-grid dd { font-size: 22px; font-weight: 700; }pre { white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.4em; background: #f4f6f9; border: 1px solid #e3e8ef; border-radius: 5px; padding: 14px; font-size: 13px; line-height: 1.6; }summary { cursor: pointer; margin-top: 18px; color: #355d88; }h4 { margin: 20px 0 8px; }
.required-fields { border: 1px solid #dce2eb; border-radius: 6px; padding: 16px; margin: 16px 0; }.required-fields h4 { margin-top: 0; }.required-field-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto; align-items: end; gap: 12px; margin-bottom: 14px; }.required-field-row .field { margin-bottom: 0; }
@media (max-width: 650px) { .required-field-row { grid-template-columns: 1fr; }.required-field-row button { justify-self: start; } .app-header { align-items: flex-start; flex-direction: column; gap: 12px; }.header-actions { gap: 10px; font-size: 13px; }.panel { padding: 16px; }.settings-grid { grid-template-columns: 1fr; gap: 0; }.case-editor { padding: 12px; }.toolbar { align-items: flex-start; }.result-grid, .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
