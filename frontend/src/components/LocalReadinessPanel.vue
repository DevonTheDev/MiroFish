<template>
  <section class="readiness-panel" data-testid="readiness-panel" :aria-labelledby="'readiness-heading'">
    <div class="heading"><h2 id="readiness-heading">{{ t('readiness.title') }}</h2><span v-if="run" class="badge" :class="run.state" data-testid="readiness-state">{{ t(`readiness.states.${run.state}`) }}</span></div>
    <p>{{ t('readiness.scope') }}</p>
    <p class="note">{{ t('readiness.limits') }}</p>
    <div class="controls">
      <button class="primary" type="button" data-testid="readiness-start" :disabled="!canStart" @click="start">{{ t('readiness.start') }}</button>
      <button type="button" data-testid="readiness-refresh" :disabled="loading || acting" @click="refresh">{{ t('readiness.refresh') }}</button>
      <button v-if="active" type="button" data-testid="readiness-stop" :disabled="acting || run.state === 'stopping' || run.cancel_requested" @click="stop">{{ t('readiness.stop') }}</button>
      <button type="button" data-testid="readiness-download" :disabled="!canDownload" @click="download">{{ t('readiness.download') }}</button>
    </div>
    <p v-if="loading || acting" role="status" class="notice">{{ t(acting ? 'readiness.sending' : 'readiness.loading') }}</p>
    <p v-if="error" role="alert" class="notice warning" data-testid="readiness-error">{{ t('readiness.error') }}</p>
    <p v-if="notice" role="status" class="notice warning" data-testid="readiness-notice">{{ t(`readiness.${notice}`) }}</p>
    <p v-if="exportError" role="alert" class="notice warning">{{ t('readiness.exportError') }}</p>
    <p v-if="snapshot && !snapshot.available" class="notice warning" data-testid="readiness-unavailable">{{ t(`readiness.unavailable.${snapshot.unavailable_code}`) }}</p>
    <p v-if="snapshot && !run" class="note">{{ t('readiness.idle') }}</p>
    <div v-if="run" data-testid="readiness-result">
      <div class="meta"><p>{{ t('readiness.observedAt') }} <time :datetime="snapshot.observed_at">{{ formatDate(snapshot.observed_at) }}</time></p><span v-if="error || loading || acting" class="badge">{{ t('readiness.stale') }}</span></div>
      <p v-if="active" class="note">{{ t(run.state === 'stopping' || run.cancel_requested ? 'readiness.stoppingNote' : 'readiness.runningNote') }}</p>
      <p v-else class="note">{{ t(`readiness.results.${run.state}`) }}</p>
      <dl class="details">
        <div><dt>{{ t('readiness.startedAt') }}</dt><dd>{{ formatDate(run.started_at) }}</dd></div>
        <div><dt>{{ t('readiness.finishedAt') }}</dt><dd>{{ formatDate(run.finished_at) }}</dd></div>
        <div><dt>{{ t('readiness.elapsed') }}</dt><dd>{{ seconds(run.elapsed_ms) }}</dd></div>
        <div><dt>{{ t('readiness.chatModel') }}</dt><dd>{{ run.configuration.chat_model ?? t('readiness.unknown') }}</dd></div>
        <div><dt>{{ t('readiness.embeddingModel') }}</dt><dd>{{ run.configuration.embedding_model ?? t('readiness.unknown') }}</dd></div>
        <div><dt>{{ t('readiness.embeddingDimensions') }}</dt><dd>{{ run.configuration.embedding_dimensions ?? t('readiness.unknown') }}</dd></div>
      </dl>
      <p class="note" data-testid="readiness-budgets">{{ t('readiness.budgets', { overall: seconds(run.budget.overall_ms), model: seconds(run.budget.model_step_ms), database: seconds(run.budget.database_step_ms), gateway: seconds(run.budget.gateway_step_ms), cleanup: seconds(run.budget.cleanup_ms) }) }}</p>
      <ol class="steps" :aria-label="t('readiness.stepsLabel')">
        <li v-for="step in run.steps" :key="step.id" :data-testid="`readiness-step-${step.id}`" :class="step.state">
          <div class="step-heading"><strong>{{ t(`readiness.steps.${step.id}`) }}</strong><span>{{ t(`readiness.stepStates.${step.state}`) }}</span><span v-if="step.duration_ms !== null">{{ seconds(step.duration_ms) }}</span></div>
          <p v-if="step.code" class="note">{{ t(`readiness.codes.${step.code}`) }}</p>
        </li>
      </ol>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { acceptReadinessSnapshot, getLocalReadiness, startLocalReadiness, cancelLocalReadiness } from '../api/runtime'

const { t, locale } = useI18n()
const snapshot = ref(null), loading = ref(false), acting = ref(false), error = ref(false), notice = ref(null), exportError = ref(false)
const run = computed(() => snapshot.value?.run ?? null)
const active = computed(() => ['running', 'stopping'].includes(run.value?.state))
const canStart = computed(() => snapshot.value?.available === true && !active.value && !loading.value && !acting.value && !error.value)
const canDownload = computed(() => run.value !== null && !active.value && !loading.value && !acting.value && !error.value)
let retired = false, generation = 0, request = null, action = null, timer = null, polls = 0
const pollLimit = 240

function clearTimer() {
  if (timer !== null) clearTimeout(timer)
  timer = null
}
function retireObservation() {
  generation++
  clearTimer()
  request?.controller.abort()
  request = null
  loading.value = false
}
function schedule() {
  clearTimer()
  if (retired || request || acting.value || !active.value || error.value) return
  if (polls >= pollLimit) { notice.value = 'pollingPaused'; return }
  timer = setTimeout(() => { polls++; observe(run.value?.id ?? null) }, 1500)
}
function accept(response, expectedRunId = null) {
  const accepted = acceptReadinessSnapshot(response)
  if (expectedRunId !== null && accepted.run?.id !== expectedRunId) throw new Error('Readiness run changed')
  snapshot.value = accepted
  error.value = false
  return accepted
}
async function observe(expectedRunId = null) {
  if (retired || request || acting.value) return
  clearTimer()
  const current = { controller: new AbortController(), generation }
  request = current
  loading.value = true
  const owns = () => !retired && request === current && generation === current.generation
  try {
    const response = await getLocalReadiness(current.controller.signal)
    if (owns()) accept(response, expectedRunId)
  } catch {
    if (owns()) error.value = true
  } finally {
    if (owns()) { request = null; loading.value = false; schedule() }
  }
}
function refresh() {
  if (retired || acting.value || request) return
  polls = 0; notice.value = null; exportError.value = false
  observe()
}
async function perform(kind) {
  if (retired || acting.value || (kind === 'start' ? !canStart.value : !active.value || run.value.cancel_requested)) return
  const targetId = kind === 'stop' ? run.value.id : null
  retireObservation()
  const current = { controller: new AbortController(), generation }
  action = current; acting.value = true; notice.value = null; exportError.value = false; polls = 0
  const owns = () => !retired && action === current && current.generation === generation
  try {
    const response = await (kind === 'start' ? startLocalReadiness(current.controller.signal) : cancelLocalReadiness(targetId, current.controller.signal))
    if (!owns()) return
    const accepted = accept(response, targetId)
    if (!accepted.run) throw new Error('Missing accepted readiness run')
  } catch (failure) {
    if (!owns()) return
    // A conflict already contains the current shared run. Project it before use.
    let reconciled = false
    if (kind === 'start' && failure?.response?.data?.error_code === 'already_running') {
      try {
        const accepted = accept({ success: true, data: failure.response.data.data })
        if (!accepted.run) throw new Error('Missing conflicting readiness run')
        notice.value = 'alreadyRunning'; reconciled = true
      } catch { /* Fall through to a fresh, passive observation. */ }
    }
    if (!reconciled) {
      // An uncertain POST is never retried. Its accepted work may continue even
      // after a network timeout, so use a GET owned by this same action instead.
      try {
        const response = await getLocalReadiness(current.controller.signal)
        if (!owns()) return
        const accepted = accept(response, targetId)
        notice.value = kind === 'start' ? active.value ? 'startReconciled' : 'startUncertain'
          : accepted.run?.cancel_requested || !active.value ? 'stopReconciled' : 'stopUncertain'
      } catch {
        if (owns()) { error.value = true; notice.value = kind === 'start' ? 'startUncertain' : 'stopUncertain' }
      }
    }
  } finally {
    if (owns()) { action = null; acting.value = false; schedule() }
  }
}
function start() { perform('start') }
function stop() { perform('stop') }
function seconds(milliseconds) {
  return t('readiness.seconds', { value: new Intl.NumberFormat(locale.value, { maximumFractionDigits: 3 }).format(milliseconds / 1000) })
}
function formatDate(value) {
  return value === null ? t('readiness.unknown') : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(value))
}
function download() {
  if (retired || !canDownload.value) return
  let url = null, anchor = null
  try {
    const accepted = acceptReadinessSnapshot({ success: true, data: snapshot.value })
    url = URL.createObjectURL(new Blob([JSON.stringify(accepted, null, 2)], { type: 'application/json' }))
    anchor = document.createElement('a'); anchor.href = url; anchor.download = 'local_readiness_check.json'
    document.body.appendChild(anchor); anchor.click(); exportError.value = false
  } catch { exportError.value = true }
  finally { anchor?.remove(); if (url !== null) URL.revokeObjectURL(url) }
}
onMounted(refresh)
onBeforeUnmount(() => {
  retired = true; retireObservation(); action?.controller.abort(); action = null
})
</script>

<style scoped>
.readiness-panel { margin: 28px 0; padding: 26px; background: #fff; border: 1px solid #cfd9e5; border-radius: 11px; color: #27313e; }
.heading, .controls, .meta, .step-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }.heading { justify-content: space-between; }h2 { font-size: 20px; margin: 0; }p { font-size: 14px; line-height: 1.7; }.note, dt { font-size: 13px; color: #5d6979; }.controls { margin: 20px 0; }
button { padding: 10px 15px; min-height: 44px; border: 1px solid #b9c4d2; border-radius: 7px; background: #fff; color: #27313e; font: inherit; font-size: 14px; cursor: pointer; }button.primary { color: #fff; background: #253245; }button:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #eaf0f6; }button.primary:hover:enabled { background: #3b4b61; }button:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.badge { padding: 6px 10px; background: #eaf0f6; color: #415067; border-radius: 20px; font-size: 12px; }.badge.passed { background: #e8f4ed; color: #286343; }.badge.failed, .badge.timed_out { background: #fff0ec; color: #943528; }.notice { padding: 12px 14px; border-radius: 7px; background: #eaf0f6; }.warning { background: #fff4da; color: #78571c; }.meta p { margin-right: auto; font-size: 13px; }.details { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }dt { margin-bottom: 6px; }dd { margin: 0; overflow-wrap: anywhere; font-size: 14px; line-height: 1.6; }
.steps { padding-left: 24px; }.steps li { border-bottom: 1px solid #e4e9ef; padding: 13px 0 13px 4px; }.step-heading { font-size: 13px; }.step-heading strong { margin-right: auto; }.steps .note { margin: 5px 0 0; }.steps li.failed, .steps li.timed_out { color: #943528; }.steps li.running { color: #2d5889; }
@media (max-width: 720px) { .readiness-panel { padding: 19px; }.details { grid-template-columns: 1fr; }.controls { gap: 10px; } }
</style>
