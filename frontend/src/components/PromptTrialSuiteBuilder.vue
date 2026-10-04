<template>
  <section class="suite-builder" data-testid="trial-suite-builder" aria-labelledby="trial-suite-title">
    <h2 id="trial-suite-title">{{ t('promptTrialSuite.title') }}</h2>
    <p class="reading-note">{{ t('promptTrialSuite.scope') }}</p>
    <p class="reading-note">{{ t('promptTrialSuite.offline') }}</p>
    <div class="field">
      <label for="trial-suite-name">{{ t('promptTrialSuite.name') }}</label>
      <input id="trial-suite-name" data-testid="trial-suite-name" :value="name" :aria-invalid="name !== '' && !validName" aria-describedby="trial-suite-name-hint" @input="setName($event.target.value)">
      <small id="trial-suite-name-hint">{{ t('promptTrialSuite.nameHint') }}</small>
    </div>
    <fieldset>
      <legend>{{ t('promptTrialSuite.selection', { count: orderedSelection.length }) }}</legend>
      <p class="reading-note">{{ t('promptTrialSuite.selectionHint') }}</p>
      <p v-if="!pins.length" class="reading-note">{{ t('promptTrialSuite.noPins') }}</p>
      <label v-for="view in pinViews" :key="view.token" class="suite-pin">
        <input type="checkbox" :data-testid="`trial-suite-select-${view.saved.run.request_id}`" :checked="selected.includes(view.saved)" :disabled="selected.length >= 5 && !selected.includes(view.saved)" @change="view.select($event.target.checked)">
        <span>{{ view.saved.run.request.label }}<small>{{ view.saved.run.request_id }}</small><small v-if="importedOrigins.has(view.saved.run.request_id)">{{ t('promptTrials.importedHistorical') }} · {{ importedOrigins.get(view.saved.run.request_id).filename }}</small></span>
      </label>
    </fieldset>
    <template v-for="view in draftViews" :key="view.token">
      <button type="button" class="primary" data-testid="trial-suite-build" :disabled="!canBuild" @click="view.build">{{ t('promptTrialSuite.build') }}</button>
    </template>
    <p v-if="error" class="notice error" data-testid="trial-suite-error" role="alert">{{ t(`promptTrialSuite.errors.${error}`) }}</p>
    <template v-for="view in captureViews" :key="view.token">
      <div class="captured-preview" data-testid="trial-suite-preview">
        <h3>{{ t('promptTrialSuite.preview') }}</h3>
        <p class="literal suite-name">{{ view.result.definition.name }}</p>
        <p class="notice">{{ t('promptTrialSuite.capturedNote') }}</p>
        <p class="reading-note">{{ t('promptTrialSuite.checksNote') }}</p>
        <ol>
          <li v-for="(item, index) in view.result.definition.cases" :key="item.case_id" :data-testid="`trial-suite-case-${index}`">
            <h4 class="literal">{{ item.label }}</h4>
            <dl class="case-settings">
              <div><dt>{{ t('promptTrialSuite.caseId') }}</dt><dd>{{ item.case_id }}</dd></div>
              <div><dt>{{ t('promptTrials.temperature') }}</dt><dd>{{ item.temperature }}</dd></div>
              <div><dt>{{ t('promptTrials.maxOutputTokens') }}</dt><dd>{{ item.max_output_tokens }}</dd></div>
            </dl>
            <h4>{{ t('promptTrials.systemPrompt') }}</h4><pre>{{ item.system_prompt }}</pre>
            <h4>{{ t('promptTrials.userPrompt') }}</h4><pre>{{ item.user_prompt }}</pre>
            <p class="reading-note">{{ t('promptTrialSuite.noExpectation') }}</p>
          </li>
        </ol>
        <h4>{{ t('promptTrialSuite.jsonPreview') }}</h4>
        <pre class="json-preview" data-testid="trial-suite-json-preview">{{ view.result.json_text }}</pre>
        <button type="button" data-testid="trial-suite-download" @click="view.download">{{ t('promptTrialSuite.download') }}</button>
        <p class="reading-note">{{ t('promptTrialSuite.nextStep') }}</p>
        <p class="reading-note">{{ t('promptTrialSuite.privacy') }}</p>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildPromptSuiteFromTrials } from '../utils/promptTrialSuite.js'

const props = defineProps({ pins: { type: Array, required: true }, importedOrigins: { type: Map, default: () => new Map() } })
const { t } = useI18n()
const name = ref(''), selected = shallowRef([]), capture = shallowRef(null), error = ref(null), revision = ref(0)
const memberships = new Map()
let retired = false, nextCapture = 0, nextMembership = 0, buildGeneration = 0
const orderedSelection = computed(() => props.pins.filter(saved => selected.value.includes(saved)))
const validName = computed(() => typeof name.value === 'string' && name.value.trim().length > 0 && Array.from(name.value).length <= 80 && !/\p{C}/u.test(name.value))
const canBuild = computed(() => !retired && validName.value && orderedSelection.value.length >= 1 && orderedSelection.value.length <= 5)
const sameSelection = (left, right) => left.length === right.length && left.every((saved, index) => saved === right[index])

// Membership belongs to exact pin objects. A removed/replaced pin cannot become
// selected again merely because another object carries the same request ID.
watch(() => props.pins.slice(), () => {
  for (const saved of memberships.keys()) if (!props.pins.includes(saved)) memberships.delete(saved)
  for (const saved of props.pins) if (!memberships.has(saved)) memberships.set(saved, ++nextMembership)
  const retained = selected.value.filter(saved => props.pins.includes(saved))
  if (retained.length !== selected.value.length) selected.value = retained
}, { flush: 'sync', immediate: true })
watch(() => ({ name: name.value, selection: orderedSelection.value }), (current, previous) => {
  if (current.name !== previous.name || !sameSelection(current.selection, previous.selection)) {
    revision.value++; capture.value = null; error.value = null
  }
}, { flush: 'sync' })

function setName(value) { if (!retired) name.value = value }
function select(saved, token, checked) {
  if (retired || !props.pins.includes(saved) || memberships.get(saved) !== token) return
  if (!checked) selected.value = selected.value.filter(value => value !== saved)
  else if (!selected.value.includes(saved) && selected.value.length < 5) selected.value = [...selected.value, saved]
}
const pinViews = computed(() => props.pins.map(saved => {
  const token = memberships.get(saved)
  return { saved, token, select: checked => select(saved, token, checked) }
}))
function ownsDraft(owned) {
  return !retired && revision.value === owned.token && name.value === owned.name && sameSelection(orderedSelection.value, owned.snapshots)
}
function build(owned) {
  if (!ownsDraft(owned) || !canBuild.value) return
  const generation = ++buildGeneration
  const current = () => buildGeneration === generation && ownsDraft(owned)
  capture.value = null; error.value = null
  try {
    const caseIds = owned.snapshots.map(() => crypto.randomUUID())
    if (!current()) return
    const result = buildPromptSuiteFromTrials({ name: owned.name, snapshots: owned.snapshots, caseIds })
    if (current()) capture.value = { token: ++nextCapture, draft: owned, result }
  } catch { if (current()) error.value = 'invalid' }
}
const draftViews = computed(() => {
  const owned = { token: revision.value, name: name.value, snapshots: [...orderedSelection.value] }
  return [{ token: owned.token, build: () => build(owned) }]
})
function ownsCapture(owned) { return capture.value === owned && ownsDraft(owned.draft) }
function download(owned) {
  if (!ownsCapture(owned)) return
  let url = null, anchor = null, failed = false
  try {
    const blob = new Blob([owned.result.json_text], { type: 'application/json' })
    if (!ownsCapture(owned)) return
    url = URL.createObjectURL(blob)
    if (!ownsCapture(owned)) return
    anchor = document.createElement('a')
    if (!ownsCapture(owned)) return
    anchor.href = url; anchor.download = 'local_prompt_suite.json'
    if (!ownsCapture(owned)) return
    document.body.appendChild(anchor)
    if (!ownsCapture(owned)) return
    anchor.click()
  } catch { failed = true }
  finally {
    // Browser cleanup failures are independent: neither can skip the other.
    try { anchor?.remove() } catch { failed = true }
    try { if (url !== null) URL.revokeObjectURL(url) } catch { failed = true }
    if (ownsCapture(owned)) error.value = failed ? 'download' : null
  }
}
// The v-for aliases retain the specific captured object even with production
// handler caching. An old callback cannot resolve to a later replacement.
const captureViews = computed(() => {
  const owned = capture.value
  return owned ? [{ token: owned.token, result: owned.result, download: () => download(owned) }] : []
})
onBeforeUnmount(() => { retired = true; capture.value = null; selected.value = []; memberships.clear(); error.value = null })
</script>

<style scoped>
.suite-builder { padding: 26px; margin-top: 20px; background: #fff; border: 1px solid #e1e6ed; border-radius: 11px; min-width: 0; }
h2 { margin: 0 0 12px; font-size: 19px; }h3 { margin: 22px 0 10px; font-size: 17px; }h4 { margin: 18px 0 8px; font-size: 14px; }
.reading-note, small { color: #616d7c; font-size: 13px; line-height: 1.75; }.field { display: flex; flex-direction: column; gap: 7px; margin: 18px 0; }.field label { font-size: 14px; font-weight: 600; }.field input { width: 100%; box-sizing: border-box; padding: 11px; border: 1px solid #bdc6d1; border-radius: 6px; background: #fff; color: #27313e; font: inherit; }
fieldset { padding: 16px; margin: 20px 0; border: 1px solid #e1e6ed; border-radius: 7px; }legend { padding: 0 6px; font-size: 14px; font-weight: 600; }.suite-pin { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid #e4e9ef; overflow-wrap: anywhere; font-size: 14px; }.suite-pin input { width: 18px; height: 18px; flex-shrink: 0; accent-color: #253245; }.suite-pin span { min-width: 0; white-space: pre-wrap; }.suite-pin small { display: block; margin-top: 5px; }
button { cursor: pointer; padding: 11px 16px; min-height: 44px; border: 1px solid #bdc6d1; border-radius: 7px; background: #fff; color: #28323f; font: inherit; font-size: 14px; }button.primary { background: #253245; color: #fff; border-color: #253245; }button:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #eaf0f6; }button.primary:hover:enabled { background: #3b4b61; }button:focus-visible, input:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.notice { padding: 14px 16px; border-radius: 7px; background: #eaf0f6; font-size: 14px; line-height: 1.7; }.error { color: #943528; background: #fff0ec; }.captured-preview { border-top: 1px solid #e4e9ef; margin-top: 22px; }.captured-preview ol { padding-left: 24px; }.captured-preview li { padding: 0 0 18px; border-bottom: 1px solid #e4e9ef; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; }.suite-name { font-weight: 600; }
.case-settings { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; }dt { color: #626e7d; font-size: 12px; margin-bottom: 7px; }dd { margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 14px; line-height: 1.75; background: #f8f9fb; border: 1px solid #e4e9ef; border-radius: 7px; padding: 16px; max-height: 480px; overflow-y: auto; }.json-preview { font-family: ui-monospace, monospace; font-size: 12px; }
@media (max-width: 720px) { .suite-builder { padding: 19px; }.case-settings { grid-template-columns: 1fr; } }
</style>
