<template>
  <div class="trials-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <nav class="header-actions" :aria-label="t('promptTrials.navigation')"><RouterLink to="/">{{ t('runtime.backHome') }}</RouterLink><RouterLink to="/runtime">{{ t('runtime.navTitle') }}</RouterLink><RouterLink to="/prompt-suites" data-testid="prompt-suites-link">{{ t('promptSuites.navTitle') }}</RouterLink><LanguageSwitcher /></nav>
    </header>
    <main>
      <header class="page-heading"><p class="eyebrow">{{ t('promptTrials.eyebrow') }}</p><h1>{{ t('promptTrials.title') }}</h1><p>{{ t('promptTrials.scope') }}</p></header>
      <aside class="scope-note"><p>{{ t('promptTrials.observationNote') }}</p><p>{{ t('promptTrials.retentionNote') }}</p></aside>
      <section class="toolbar" :aria-label="t('promptTrials.controls')">
        <button type="button" data-testid="trial-refresh" :disabled="loading" @click="refresh">{{ t(ownerId ? 'promptTrials.reconcile' : 'promptTrials.refresh') }}</button>
        <span v-if="loading" role="status">{{ t('promptTrials.loading') }}</span>
        <span v-if="snapshot" class="observed">{{ t('promptTrials.observedAt') }} <time :datetime="snapshot.observed_at">{{ formatDate(snapshot.observed_at) }}</time></span>
      </section>
      <p v-if="stale && snapshot" class="notice warning" data-testid="trial-stale" role="status">{{ t('promptTrials.stale') }}</p>
      <p v-if="error" class="notice error" data-testid="trial-error" role="alert">{{ t('promptTrials.readError') }}</p>
      <p v-if="notice" class="notice" data-testid="trial-notice" role="status">{{ t(`promptTrials.notices.${notice}`) }}</p>
      <div v-if="ownerId && stale && !loading" class="notice"><p>{{ t('promptTrials.releaseNote') }}</p><button type="button" data-testid="trial-release" @click="release">{{ t('promptTrials.release') }}</button></div>
      <p v-if="snapshot && !snapshot.available" class="notice warning" data-testid="trial-unavailable">{{ t(`promptTrials.unavailable.${snapshot.unavailable_code}`) }}</p>
      <p v-if="exportError" class="notice error" role="alert">{{ t('promptTrials.exportError') }}</p>
      <form class="panel" data-testid="trial-form" @submit.prevent="start">
        <h2>{{ t('promptTrials.newTrial') }}</h2>
        <div class="field"><label for="trial-label">{{ t('promptTrials.label') }}</label><input id="trial-label" data-testid="trial-label" :value="draft.label" required @input="draft.label = $event.target.value"><small>{{ t('promptTrials.labelHint') }}</small></div>
        <div class="field"><label for="trial-system">{{ t('promptTrials.systemPrompt') }}</label><textarea id="trial-system" data-testid="trial-system_prompt" rows="3" :value="draft.system_prompt" @input="draft.system_prompt = $event.target.value" /><small>{{ t('promptTrials.systemHint') }}</small></div>
        <div class="field"><label for="trial-user">{{ t('promptTrials.userPrompt') }}</label><textarea id="trial-user" data-testid="trial-user_prompt" rows="5" required :value="draft.user_prompt" @input="draft.user_prompt = $event.target.value" /><small>{{ t('promptTrials.userHint') }}</small></div>
        <div class="settings-grid">
          <div class="field"><label for="trial-temperature">{{ t('promptTrials.temperature') }}</label><input id="trial-temperature" data-testid="trial-temperature" type="number" min="0" max="1" step="any" required :value="draft.temperature" @input="draft.temperature = $event.target.value === '' ? '' : Number($event.target.value)"></div>
          <div class="field"><label for="trial-output">{{ t('promptTrials.maxOutputTokens') }}</label><input id="trial-output" data-testid="trial-max_output_tokens" type="number" min="1" :max="snapshot?.limits.max_output_tokens ?? 512" step="1" required :value="draft.max_output_tokens" @input="draft.max_output_tokens = $event.target.value === '' ? '' : Number($event.target.value)"><small>{{ t('promptTrials.outputHint', { cap: snapshot?.limits.max_output_tokens ?? t('promptTrials.unknown') }) }}</small></div>
        </div>
        <p v-if="validationError" class="notice warning" role="alert">{{ t('promptTrials.validationError') }}</p>
        <button class="primary" type="submit" data-testid="trial-run" :disabled="!canRun">{{ t('promptTrials.run') }}</button>
        <p class="reading-note">{{ t('promptTrials.runNote') }}</p>
      </form>
      <section class="panel" aria-labelledby="latest-title">
        <div class="panel-heading"><h2 id="latest-title">{{ t('promptTrials.latest') }}</h2><span v-if="snapshot?.run" class="badge" data-testid="trial-state">{{ t(`promptTrials.states.${snapshot.run.state}`) }}</span></div>
        <div class="toolbar">
          <button type="button" data-testid="trial-pin" :disabled="!canPin" @click="pin">{{ t('promptTrials.pin') }}</button>
          <button type="button" data-testid="trial-download" :disabled="!canDownload" @click="download(snapshot)">{{ t('promptTrials.download') }}</button>
          <button type="button" data-testid="trial-reuse" :disabled="!canDownload" @click="reuse(snapshot)">{{ t('promptTrials.reuse') }}</button>
        </div>
        <div v-if="snapshot?.run" data-testid="trial-result"><ResultDetails :run="snapshot.run" prefix="trial" /></div>
        <p v-else class="reading-note">{{ t('promptTrials.noResult') }}</p>
        <p class="reading-note">{{ t('promptTrials.privateExport') }}</p>
      </section>
      <section class="panel" aria-labelledby="pins-title">
        <div class="panel-heading"><h2 id="pins-title">{{ t('promptTrials.pins') }} ({{ pins.length }}/10)</h2><span>{{ t('promptTrials.chooseTwo') }}</span></div>
        <p class="reading-note">{{ t('promptTrials.pinsNote') }}</p>
        <p v-if="!pins.length" class="reading-note">{{ t('promptTrials.noPins') }}</p>
        <ul class="pin-list">
          <li v-for="saved in pins" :key="saved.run.request_id" :data-testid="`pin-item-${saved.run.request_id}`">
            <label class="pin-select"><input type="checkbox" :data-testid="`pin-select-${saved.run.request_id}`" :checked="selectedIds.includes(saved.run.request_id)" :disabled="selectedIds.length === 2 && !selectedIds.includes(saved.run.request_id)" @change="select(saved.run.request_id, $event.target.checked)"><span>{{ saved.run.request.label }}<small>{{ saved.run.configuration.model }} · {{ t(`promptTrials.states.${saved.run.state}`) }}</small></span></label>
            <div class="pin-actions"><button type="button" :data-testid="`pin-reuse-${saved.run.request_id}`" @click="reuse(saved)">{{ t('promptTrials.reuse') }}</button><button type="button" :data-testid="`pin-download-${saved.run.request_id}`" :disabled="!canUsePins" @click="download(saved)">{{ t('promptTrials.download') }}</button><button type="button" :data-testid="`pin-remove-${saved.run.request_id}`" @click="removePin(saved.run.request_id)">{{ t('promptTrials.remove') }}</button></div>
          </li>
        </ul>
      </section>
      <div v-if="comparison.length === 2" class="toolbar"><button type="button" data-testid="comparison-download" :disabled="!canUsePins" @click="downloadComparison">{{ t('promptTrials.downloadComparison') }}</button><span class="reading-note">{{ t('promptTrials.privateExport') }}</span></div>
      <section v-if="comparison.length === 2" class="comparison" :aria-label="t('promptTrials.comparison')">
        <article v-for="saved in comparison" :key="saved.run.request_id" class="panel" :data-testid="`comparison-${saved.run.request_id}`"><h2>{{ saved.run.request.label }}</h2><span class="badge">{{ t(`promptTrials.states.${saved.run.state}`) }}</span><ResultDetails :run="saved.run" :prefix="`compare-${saved.run.request_id}`" /></article>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { acceptPromptTrialRequest, acceptPromptTrialSnapshot, getPromptTrial, getPromptTrials, isPromptTrialTerminal, samePromptTrialRequest, startPromptTrial } from '../api/promptTrials'

const { t, locale } = useI18n()
const snapshot = ref(null), loading = ref(false), stale = ref(true), error = ref(false), exportError = ref(false), validationError = ref(false), notice = ref(null)
const draft = ref({ label: '', system_prompt: '', user_prompt: '', temperature: 0.2, max_output_tokens: 128 })
const pins = ref([]), selectedIds = ref([]), ownerId = ref(null)
let retired = false, generation = 0, request = null, timer = null, owner = null, polls = 0
const canDownload = computed(() => !retired && !loading.value && !stale.value && isPromptTrialTerminal(snapshot.value?.run))
const canPin = computed(() => canDownload.value && pins.value.length < 10 && !pins.value.some(item => item.run.request_id === snapshot.value.run.request_id))
const canUsePins = computed(() => !retired && pins.value.length > 0)
const canRun = computed(() => !retired && !loading.value && !stale.value && snapshot.value?.available === true &&
  (!snapshot.value.run || isPromptTrialTerminal(snapshot.value.run)) && (!owner || isPromptTrialTerminal(snapshot.value.run)))
const comparison = computed(() => selectedIds.value.map(id => pins.value.find(item => item.run.request_id === id)).filter(Boolean))

function clearTimer() { if (timer !== null) clearTimeout(timer); timer = null }
function current(token) { return !retired && request === token && generation === token.generation && ownerId.value === token.ownerId && !token.controller.signal.aborted }
function begin() {
  clearTimer()
  const token = { generation: ++generation, ownerId: ownerId.value, controller: new AbortController() }
  request = token; loading.value = true; stale.value = true; exportError.value = false
  return token
}
function accept(response) {
  const accepted = acceptPromptTrialSnapshot(response)
  if (owner && (!accepted.run || accepted.run.request_id !== ownerId.value || !samePromptTrialRequest(accepted.run.request, owner.request) ||
    (owner.fingerprint !== null && accepted.run.fingerprint !== owner.fingerprint))) throw new Error('Unconfirmed trial identity')
  if (owner) owner.fingerprint = accepted.run.fingerprint
  snapshot.value = accepted; stale.value = false; error.value = false; notice.value = null
}
function schedule() {
  clearTimer()
  if (retired || request || stale.value || !owner || snapshot.value?.run?.request_id !== ownerId.value || snapshot.value.run.state !== 'running') return
  if (polls >= 60) { stale.value = true; notice.value = 'paused'; return }
  const expected = generation, id = ownerId.value
  timer = setTimeout(() => {
    timer = null
    if (!retired && generation === expected && ownerId.value === id && !request) { polls++; observe() }
  }, 1500)
}
async function observe() {
  if (retired || request) return
  const token = begin()
  try {
    const response = token.ownerId === null ? await getPromptTrials(token.controller.signal) : await getPromptTrial(token.ownerId, token.controller.signal)
    if (!current(token)) return
    accept(response)
  } catch {
    if (current(token)) { error.value = true; notice.value = owner ? 'uncertain' : null }
  } finally {
    if (current(token)) { request = null; loading.value = false; schedule() }
  }
}
function refresh() { if (!retired && !request) { polls = 0; observe() } }
async function start() {
  if (retired || request || !canRun.value) return
  let frozen
  try {
    frozen = Object.freeze(acceptPromptTrialRequest({ request_id: crypto.randomUUID(), label: draft.value.label,
      system_prompt: draft.value.system_prompt, user_prompt: draft.value.user_prompt, temperature: draft.value.temperature, max_output_tokens: draft.value.max_output_tokens }))
    if (frozen.max_output_tokens > snapshot.value.limits.max_output_tokens) throw new Error('Loaded output limit')
  } catch { validationError.value = true; return }
  validationError.value = false; error.value = false; notice.value = null; polls = 0
  owner = { request: frozen, fingerprint: null }; ownerId.value = frozen.request_id
  const token = begin()
  let reconcile = false
  try {
    const response = await startPromptTrial(frozen, token.controller.signal)
    if (!current(token)) return
    accept(response)
  } catch (failure) {
    if (current(token)) {
      const definitive = { invalid_request: 400, local_mode_required: 403, local_browser_required: 403, already_running: 409, request_conflict: 409 }
      const code = failure?.response?.data?.error_code
      if (failure?.response?.data?.success === false && typeof code === 'string' && Object.hasOwn(definitive, code) && failure.response.status === definitive[code]) {
        notice.value = 'rejected'; error.value = false
        // Finish this token before releasing its identity; no automatic POST or GET.
        request = null; loading.value = false; owner = null; ownerId.value = null; generation++
      } else { notice.value = 'uncertain'; error.value = true; reconcile = true }
    }
  } finally {
    if (current(token)) {
      request = null; loading.value = false
      if (reconcile) observe()
      else schedule()
    }
  }
}
function release() {
  if (retired || request || !owner || !stale.value) return
  clearTimer(); generation++; owner = null; ownerId.value = null; notice.value = 'released'; polls = 0
  observe()
}
function copySnapshot(value) { return acceptPromptTrialSnapshot({ success: true, data: value }) }
function pin() {
  if (retired || !canPin.value) return
  try { pins.value.push(copySnapshot(snapshot.value)) } catch { stale.value = true; error.value = true }
}
function select(id, enabled) {
  if (retired || !pins.value.some(item => item.run.request_id === id)) return
  if (!enabled) selectedIds.value = selectedIds.value.filter(value => value !== id)
  else if (selectedIds.value.length < 2 && !selectedIds.value.includes(id)) selectedIds.value.push(id)
}
function removePin(id) {
  if (retired) return
  selectedIds.value = selectedIds.value.filter(value => value !== id)
  pins.value = pins.value.filter(item => item.run.request_id !== id)
}
function reuse(saved) {
  if (retired || !saved || (!pins.value.includes(saved) && (saved !== snapshot.value || !canDownload.value))) return
  try {
    const accepted = copySnapshot(saved)
    if (!isPromptTrialTerminal(accepted.run)) return
    draft.value = { label: accepted.run.request.label, system_prompt: accepted.run.request.system_prompt,
      user_prompt: accepted.run.request.user_prompt, temperature: accepted.run.request.temperature, max_output_tokens: accepted.run.request.max_output_tokens }
    validationError.value = false
  } catch { exportError.value = true }
}
function download(saved) {
  const fromCurrent = saved === snapshot.value
  if (retired || !saved || (fromCurrent ? !canDownload.value : !canUsePins.value || !pins.value.includes(saved))) return
  const expected = generation, id = saved.run.request_id
  let url = null, anchor = null
  try {
    const accepted = copySnapshot(saved)
    if (!isPromptTrialTerminal(accepted.run)) return
    url = URL.createObjectURL(new Blob([JSON.stringify(accepted, null, 2)], { type: 'application/json' }))
    if (retired || saved.run.request_id !== id || (fromCurrent ? generation !== expected || saved !== snapshot.value || !canDownload.value : !pins.value.includes(saved) || !canUsePins.value)) return
    anchor = document.createElement('a'); anchor.href = url; anchor.download = `local_prompt_trial_${id}.json`
    document.body.appendChild(anchor); anchor.click(); exportError.value = false
  } catch { if (!retired && (fromCurrent ? generation === expected : pins.value.includes(saved))) exportError.value = true }
  finally { anchor?.remove(); if (url !== null) URL.revokeObjectURL(url) }
}
function downloadComparison() {
  if (retired || !canUsePins.value || comparison.value.length !== 2) return
  const selected = [...comparison.value]
  let url = null, anchor = null
  try {
    const trials = selected.map(copySnapshot)
    if (!trials.every(item => isPromptTrialTerminal(item.run))) return
    const data = { schema_version: 1, kind: 'mirofish_local_prompt_trial_comparison', trials }
    url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    if (retired || !canUsePins.value || comparison.value.length !== 2 || selected.some((item, i) => item !== comparison.value[i])) return
    anchor = document.createElement('a'); anchor.href = url; anchor.download = 'local_prompt_trial_comparison.json'
    document.body.appendChild(anchor); anchor.click(); exportError.value = false
  } catch { if (!retired && selected.every((item, i) => item === comparison.value[i])) exportError.value = true }
  finally { anchor?.remove(); if (url !== null) URL.revokeObjectURL(url) }
}
function value(input) { return input === null || input === undefined ? t('promptTrials.unknown') : String(input) }
function formatDate(input) { return input === null ? t('promptTrials.unknown') : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(input)) }
const ResultDetails = defineComponent({
  props: { run: { type: Object, required: true }, prefix: { type: String, required: true } },
  setup(props) {
    return () => {
      const r = props.run
      const row = (key, content) => h('div', [h('dt', t('promptTrials.' + key)), h('dd', value(content))])
      const literal = (key, content, testId) => h('div', [h('h3', t('promptTrials.' + key)), h('pre', { 'data-testid': testId }, content)])
      return h('div', { class: 'result-details' }, [
        h('p', { class: 'run-label' }, r.request.label),
        h('dl', { class: 'result-grid' }, [row('requestId', r.request_id), row('capturedModel', r.configuration.model),
          row('reasoningEffort', r.configuration.reasoning_effort === null ? t('promptTrials.serverDefault') : r.configuration.reasoning_effort),
          row('temperature', r.request.temperature), row('maxOutputTokens', r.request.max_output_tokens), row('finishReason', r.response?.finish_reason),
          row('startedAt', formatDate(r.started_at)), row('finishedAt', formatDate(r.finished_at)), row('requestDuration', r.request_duration_ms), row('overallDuration', r.elapsed_ms),
          row('promptTokens', r.response?.usage.prompt_tokens), row('completionTokens', r.response?.usage.completion_tokens), row('totalTokens', r.response?.usage.total_tokens),
          row('cleanup', t('promptTrials.cleanupStates.' + r.cleanup.state)), row('cleanupDuration', r.cleanup.duration_ms)]),
        r.error_code === null ? null : h('p', { class: 'notice error' }, t('promptTrials.errors.' + r.error_code)),
        literal('reply', r.response?.content === null || !r.response ? t('promptTrials.noContent') : r.response.content === '' ? t('promptTrials.emptyContent') : r.response.content, props.prefix + '-response'),
        r.response?.refusal === null || !r.response ? null : literal('refusal', r.response.refusal === '' ? t('promptTrials.emptyRefusal') : r.response.refusal, props.prefix + '-refusal'),
        h('details', [h('summary', t('promptTrials.capturedPrompts')), literal('systemPrompt', r.request.system_prompt === '' ? t('promptTrials.noSystem') : r.request.system_prompt), literal('userPrompt', r.request.user_prompt)]),
        h('p', { class: 'reading-note' }, t('promptTrials.timingNote')),
      ])
    }
  },
})
onMounted(observe)
onBeforeUnmount(() => {
  retired = true; generation++; clearTimer(); request?.controller.abort(); request = null; owner = null; ownerId.value = null
  pins.value = []; selectedIds.value = []
})
</script>

<style scoped>
.trials-page { min-height: 100vh; background: #f6f7f9; color: #27313e; font-family: 'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif; }
.app-header { min-height: 64px; padding: 12px 40px; background: #fff; border-bottom: 1px solid #e3e7ed; display: flex; align-items: center; justify-content: space-between; gap: 20px; }.brand { font-size: 20px; font-weight: 800; color: #202833; text-decoration: none; letter-spacing: 1px; }.header-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 24px; font-size: 14px; }.header-actions a { color: #536173; }
main { max-width: 1180px; margin: auto; padding: 40px 28px 64px; }.eyebrow { color: #a24c2f; font-size: 12px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 10px 0 14px; }h2 { font-size: 19px; margin: 0 0 12px; }.page-heading > p:last-child { max-width: 900px; color: #596575; line-height: 1.7; }.scope-note { color: #616d7c; font-size: 13px; line-height: 1.75; }
.panel { padding: 26px; margin-top: 20px; background: #fff; border: 1px solid #e1e6ed; border-radius: 11px; min-width: 0; }.panel-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }.panel-heading h2 { margin: 0; }.panel-heading > span { font-size: 13px; color: #616d7c; }.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 20px 0; }.observed { margin-left: auto; font-size: 12px; color: #626e7d; }
button { cursor: pointer; padding: 11px 16px; min-height: 44px; border: 1px solid #bdc6d1; border-radius: 7px; background: #fff; color: #28323f; font: inherit; font-size: 14px; }button.primary { background: #253245; color: #fff; border-color: #253245; }button:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #eaf0f6; }button.primary:hover:enabled { background: #3b4b61; }button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, :deep(summary:focus-visible) { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.field { display: flex; flex-direction: column; gap: 7px; margin: 18px 0; }.field label { font-size: 14px; font-weight: 600; }.field input, .field textarea { width: 100%; box-sizing: border-box; border: 1px solid #bdc6d1; border-radius: 6px; background: #fff; color: #27313e; padding: 11px; font: inherit; font-size: 14px; }.field textarea { resize: vertical; line-height: 1.6; }.field small { font-size: 12px; line-height: 1.6; color: #616d7c; }.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.notice, :deep(.notice) { padding: 14px 16px; border-radius: 7px; background: #eaf0f6; font-size: 14px; line-height: 1.7; }.error, :deep(.error) { color: #943528; background: #fff0ec; }.warning { color: #825a17; background: #fff1cf; }.badge { display: inline-block; padding: 6px 11px; font-size: 12px; font-weight: 600; border-radius: 20px; background: #eaf0f6; color: #415067; }.reading-note, :deep(.reading-note) { color: #616d7c; font-size: 13px; line-height: 1.75; }
:deep(.result-grid) { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin: 24px 0; }:deep(dt) { color: #626e7d; font-size: 12px; margin-bottom: 7px; }:deep(dd) { margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }:deep(pre) { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 14px; line-height: 1.75; background: #f8f9fb; border: 1px solid #e4e9ef; border-radius: 7px; padding: 16px; max-height: 480px; overflow-y: auto; }:deep(h3) { font-size: 14px; margin: 20px 0 10px; }:deep(summary) { cursor: pointer; min-height: 44px; display: list-item; align-content: center; font-size: 14px; }:deep(.run-label) { font-weight: 600; overflow-wrap: anywhere; }
.pin-list { list-style: none; padding: 0; margin: 0; }.pin-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid #e4e9ef; padding: 16px 0; }.pin-select { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 220px; font-size: 14px; overflow-wrap: anywhere; }.pin-select input { width: 18px; height: 18px; flex: 0 0 auto; accent-color: #253245; }.pin-select small { display: block; margin-top: 5px; color: #626e7d; font-size: 12px; }.pin-actions { display: flex; flex-wrap: wrap; gap: 8px; }.pin-actions button { font-size: 12px; padding: 8px 12px; }.comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }.comparison :deep(.result-grid) { grid-template-columns: 1fr 1fr; }.comparison h2 { overflow-wrap: anywhere; }
@media (max-width: 720px) { .app-header { padding: 12px 20px; flex-wrap: wrap; }.header-actions { gap: 16px; }main { padding: 28px 16px; }.panel { padding: 19px; }.settings-grid, .comparison { grid-template-columns: 1fr; gap: 0; }:deep(.result-grid), .comparison :deep(.result-grid) { grid-template-columns: 1fr 1fr; }.observed { width: 100%; margin: 0; }.toolbar button { flex: 1 1 auto; } }
@media (max-width: 400px) { :deep(.result-grid), .comparison :deep(.result-grid) { grid-template-columns: 1fr; } }
</style>
