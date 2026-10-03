<template>
  <div class="runtime-page">
    <header class="app-header">
      <RouterLink class="brand" to="/">MIROFISH</RouterLink>
      <div class="header-actions"><RouterLink to="/">{{ t('runtime.backHome') }}</RouterLink><LanguageSwitcher /></div>
    </header>
    <main>
      <header class="page-heading">
        <p class="eyebrow">{{ t('runtime.eyebrow') }}</p>
        <h1>{{ t('runtime.title') }}</h1>
        <p>{{ t('runtime.scope') }}</p>
      </header>
      <p><RouterLink to="/prompt-trials" data-testid="prompt-trials-link">{{ t('promptTrials.runtimeLink') }}</RouterLink></p>
      <LocalReadinessPanel />
      <section class="toolbar" :aria-label="t('runtime.observationControls')">
        <button type="button" class="primary" data-testid="refresh" :disabled="loading" @click="refresh">{{ t('runtime.refresh') }}</button>
        <label class="auto-control"><input type="checkbox" data-testid="auto-refresh" :checked="autoRefresh" @change="setAutoRefresh($event.target.checked)">{{ t('runtime.autoRefresh') }}</label>
        <button type="button" data-testid="download" :disabled="!canDownload" @click="download">{{ t('runtime.download') }}</button>
      </section>
      <p v-if="loading" class="notice" role="status">{{ t('runtime.loading') }}</p>
      <p v-if="error" class="notice error" role="alert">{{ t('runtime.error') }}</p>
      <p v-if="exportError" class="notice error" role="alert">{{ t('runtime.exportError') }}</p>
      <section v-if="snapshot" data-testid="results" :aria-label="t('runtime.observation')">
        <div data-testid="snapshot">
          <div class="observation-meta">
            <p data-testid="observed-at">{{ t('runtime.observedAt') }} <time :datetime="snapshot.observed_at">{{ formatDate(snapshot.observed_at) }}</time></p>
            <span v-if="error || loading" data-testid="stale" class="badge warning">{{ t('runtime.stale') }}</span>
            <span class="badge">{{ t(`runtime.modes.${snapshot.mode}`) }}</span>
          </div>
          <article class="panel gateway-panel">
            <div class="panel-heading"><h2>{{ t('runtime.gatewayTitle') }}</h2><span class="badge" data-testid="gateway-state">{{ t(`runtime.states.${snapshot.gateway.state}`) }}</span></div>
            <p class="reading-note">{{ t(`runtime.stateNotes.${snapshot.gateway.state}`) }}</p>
            <dl class="identity-grid">
              <div><dt>{{ t('runtime.instanceId') }}</dt><dd data-testid="instance-id">{{ value(snapshot.gateway.instance_id) }}</dd></div>
              <div><dt>{{ t('runtime.startedAt') }}</dt><dd>{{ formatDate(snapshot.gateway.started_at) }}</dd></div>
              <div><dt>{{ t('runtime.uptime') }}</dt><dd>{{ value(snapshot.gateway.uptime_seconds) }}</dd></div>
            </dl>
            <h3>{{ t('runtime.currentActivity') }}</h3>
            <div class="metrics-grid">
              <div v-for="metric in gaugeFields" :key="metric" class="metric-card" :data-testid="`metric-${metric}`">
                <span class="metric-label">{{ t(`runtime.metrics.${metric}`) }}</span><strong class="metric-value">{{ value(snapshot.gateway.metrics?.[metric]) }}</strong>
              </div>
            </div>
            <p class="reading-note">{{ t('runtime.gaugeNote') }}</p>
            <h3>{{ t('runtime.forwardedRequests') }}</h3>
            <div class="metrics-grid outcomes">
              <div v-for="metric in outcomeFields" :key="metric" class="metric-card" :data-testid="`metric-${metric}`">
                <span class="metric-label">{{ t(`runtime.metrics.${metric}`) }}</span><strong class="metric-value">{{ value(snapshot.gateway.metrics?.[metric]) }}</strong>
              </div>
            </div>
            <p class="reading-note">{{ t('runtime.outcomeNote') }}</p>
            <p class="rejected" data-testid="metric-rejected_connections">{{ t('runtime.metrics.rejected_connections') }}: <strong>{{ value(snapshot.gateway.metrics?.rejected_connections) }}</strong></p>
            <p class="reading-note">{{ t('runtime.rejectionNote') }} {{ t('runtime.processNote') }}</p>
          </article>
          <article v-if="snapshot.configuration" class="panel" data-testid="configuration">
            <div class="panel-heading"><h2>{{ t('runtime.configurationTitle') }}</h2><span class="badge" :class="{ warning: !snapshot.configuration.valid }">{{ t(snapshot.configuration.valid ? 'runtime.configValid' : 'runtime.configInvalid') }}</span></div>
            <p class="reading-note">{{ t('runtime.configNote') }}</p>
            <ul v-if="snapshot.configuration.issues.length" class="issues">
              <li v-for="(issue, index) in snapshot.configuration.issues" :key="index">{{ issueLabel(issue) }}</li>
            </ul>
            <dl class="config-grid">
              <div v-for="field in configFields" :key="field" :data-testid="`config-${field}`"><dt>{{ t(`runtime.fields.${field}`) }}</dt><dd>{{ field === 'reasoning_effort' && snapshot.configuration[field] === null && !snapshot.configuration.issues.some(issue => issue.field === 'reasoning_effort') ? t('runtime.serverDefault') : value(snapshot.configuration[field]) }}</dd></div>
            </dl>
            <p class="reading-note">{{ t('runtime.contextNote') }}</p>
          </article>
          <article v-else class="panel"><h2>{{ t('runtime.cloudTitle') }}</h2><p>{{ t('runtime.cloudNote') }}</p></article>
          <article class="panel">
            <h2>{{ t('runtime.limitsTitle') }}</h2>
            <p class="reading-note">{{ t('runtime.limitsNote') }}</p>
            <div class="table-scroll" tabindex="0" :aria-label="t('runtime.limitsTitle')">
              <table>
                <caption>{{ t('runtime.limitsCaption') }}</caption>
                <thead><tr><th scope="col">{{ t('runtime.limit') }}</th><th scope="col">{{ t('runtime.loadedPolicy') }}</th><th scope="col">{{ t('runtime.actualPolicy') }}</th></tr></thead>
                <tbody><tr v-for="field in limitFields" :key="field"><th scope="row">{{ t(`runtime.limits.${field}`) }}</th><td :data-testid="`loaded-${field}`">{{ value(snapshot.configuration?.gateway_limits?.[field]) }}</td><td :data-testid="`actual-${field}`">{{ value(snapshot.gateway.limits?.[field]) }}</td></tr></tbody>
              </table>
            </div>
          </article>
        </div>
      </section>
      <aside class="scope-note"><h2>{{ t('runtime.capabilityTitle') }}</h2><p>{{ t('runtime.capabilityNote') }}</p><p>{{ t('runtime.doctorNote') }}</p><a href="https://github.com/DevonTheDev/MiroFish/blob/main/docs/LOCAL_MODE.md" target="_blank" rel="noopener noreferrer">{{ t('runtime.doctorLink') }}</a></aside>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import LocalReadinessPanel from '../components/LocalReadinessPanel.vue'
import { acceptRuntimeSnapshot, getRuntimeStatus } from '../api/runtime'

const { t, locale } = useI18n()
const snapshot = ref(null)
const loading = ref(false)
const error = ref(false)
const exportError = ref(false)
const autoRefresh = ref(false)
const canDownload = computed(() => snapshot.value !== null && !loading.value && !error.value)
const gaugeFields = ['admitted_connections', 'active_requests', 'queued_requests']
const outcomeFields = ['started_requests', 'succeeded_requests', 'failed_requests', 'timed_out_requests', 'cancelled_requests']
const limitFields = ['max_concurrency', 'max_queue', 'request_timeout', 'max_output_tokens', 'max_input_chars']
const configFields = ['chat_model', 'embedding_model', 'chat_endpoint', 'embedding_endpoint', 'graph_endpoint', 'embedding_dimensions', 'context_tokens', 'max_agents', 'max_rounds', 'max_agent_iterations', 'reasoning_effort']
let retired = false
let request = null
let timer = null

function clearTimer() {
  if (timer !== null) clearTimeout(timer)
  timer = null
}
function schedule() {
  clearTimer()
  if (!retired && autoRefresh.value && !request) timer = setTimeout(refresh, 5000)
}
function setAutoRefresh(enabled) {
  autoRefresh.value = enabled === true
  schedule()
}
async function refresh() {
  if (retired || request) return
  clearTimer()
  const current = { controller: new AbortController() }
  request = current
  loading.value = true
  exportError.value = false
  const isCurrent = () => !retired && request === current
  try {
    const response = await getRuntimeStatus(current.controller.signal)
    if (!isCurrent()) return
    snapshot.value = acceptRuntimeSnapshot(response)
    error.value = false
  } catch {
    if (isCurrent()) error.value = true
  } finally {
    if (isCurrent()) {
      request = null
      loading.value = false
      schedule()
    }
  }
}
function value(input) {
  if (input === null || input === undefined) return t('runtime.unknown')
  if (typeof input !== 'number') return input
  return new Intl.NumberFormat(locale.value, { maximumSignificantDigits: 17,
    notation: (input > 0 && input < 0.01) || input >= 1e21 ? 'scientific' : 'standard' }).format(input)
}
function formatDate(input) {
  return input === null ? t('runtime.unknown') : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(input))
}
function issueLabel(issue) {
  const field = issue.field.startsWith('gateway_limits.') ? t(`runtime.limits.${issue.field.slice(15)}`)
    : issue.field === 'gateway' ? t('runtime.gatewayTitle') : t(`runtime.fields.${issue.field}`)
  return `${field}: ${t(`runtime.issues.${issue.code}`)}`
}
function download() {
  if (retired || !canDownload.value) return
  let url = null
  let anchor = null
  try {
    const accepted = acceptRuntimeSnapshot({ success: true, data: snapshot.value })
    url = URL.createObjectURL(new Blob([JSON.stringify(accepted, null, 2)], { type: 'application/json' }))
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'mirofish-local-runtime-status.json'
    document.body.appendChild(anchor)
    anchor.click()
    exportError.value = false
  } catch { exportError.value = true }
  finally {
    anchor?.remove()
    if (url !== null) URL.revokeObjectURL(url)
  }
}
onMounted(refresh)
onBeforeUnmount(() => {
  retired = true
  clearTimer()
  request?.controller.abort()
  request = null
})
</script>

<style scoped>
.runtime-page { min-height: 100vh; background: #f6f7f9; color: #27313e; font-family: 'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif; }
.app-header { min-height: 64px; padding: 12px 40px; background: #fff; border-bottom: 1px solid #e3e7ed; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { font-size: 20px; font-weight: 800; color: #202833; text-decoration: none; letter-spacing: 1px; }
.header-actions { display: flex; align-items: center; gap: 24px; font-size: 14px; }.header-actions a { color: #536173; }
main { max-width: 1180px; margin: auto; padding: 40px 28px 64px; }
.eyebrow { color: #a24c2f; font-size: 12px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; }h1 { font-size: clamp(26px, 4vw, 36px); margin: 10px 0 14px; }h2 { font-size: 19px; margin: 0 0 12px; }h3 { font-size: 15px; margin: 24px 0 12px; }
.page-heading > p:last-child { max-width: 850px; color: #596575; line-height: 1.7; }.toolbar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 26px 0 20px; }
button { cursor: pointer; padding: 11px 17px; min-height: 44px; border: 1px solid #bdc6d1; border-radius: 7px; background: #fff; color: #28323f; font: inherit; font-size: 14px; }button.primary { background: #253245; color: #fff; border-color: #253245; }button:disabled { opacity: .5; cursor: not-allowed; }button:hover:enabled { background: #eaf0f6; }button.primary:hover:enabled { background: #3b4b61; }
.auto-control { display: flex; gap: 9px; align-items: center; min-height: 44px; font-size: 14px; margin-right: auto; }.auto-control input { width: 18px; height: 18px; accent-color: #253245; }
button:focus-visible, a:focus-visible, input:focus-visible, .table-scroll:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
.notice { padding: 14px 16px; border-radius: 7px; background: #eaf0f6; font-size: 14px; }.error { color: #943528; background: #fff0ec; }.observation-meta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 13px; color: #5d6877; margin: 14px 0; }.observation-meta p { margin-right: auto; }
.panel { padding: 26px; margin-top: 20px; background: #fff; border: 1px solid #e1e6ed; border-radius: 11px; }.panel-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }.panel-heading h2 { margin: 0; }.badge { display: inline-block; padding: 6px 11px; font-size: 12px; font-weight: 600; border-radius: 20px; background: #eaf0f6; color: #415067; }.warning { color: #825a17; background: #fff1cf; }
.reading-note, .scope-note p { color: #616d7c; font-size: 13px; line-height: 1.75; }.identity-grid, .config-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px 26px; margin: 24px 0; }.config-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }dt { color: #626e7d; font-size: 13px; margin-bottom: 7px; }dd { margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.metrics-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }.outcomes { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }.metric-card { padding: 17px; border: 1px solid #e4e9ef; border-radius: 8px; background: #f9fafc; display: flex; flex-direction: column; gap: 12px; }.metric-label { color: #596778; font-size: 13px; line-height: 1.5; }.metric-value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }.rejected { font-size: 14px; margin: 20px 0 0; }.issues { background: #fff7e8; color: #80591c; padding: 16px 16px 16px 34px; font-size: 13px; line-height: 1.8; }
.table-scroll { overflow-x: auto; }table { border-collapse: collapse; width: 100%; min-width: 540px; text-align: right; font-size: 14px; }caption { padding: 6px 0 14px; text-align: left; color: #626e7d; font-size: 12px; }th, td { padding: 14px 12px; border-bottom: 1px solid #e4e9ef; }th:first-child { text-align: left; width: 44%; }thead { font-size: 12px; color: #626e7d; }td { font-variant-numeric: tabular-nums; }.scope-note { margin-top: 28px; padding: 6px 4px; }.scope-note h2 { font-size: 16px; }
@media (max-width: 720px) { .app-header { padding: 12px 20px; flex-wrap: wrap; }.header-actions { gap: 16px; }main { padding: 28px 16px; }.panel { padding: 19px; }.identity-grid, .config-grid { grid-template-columns: 1fr; }.metrics-grid { grid-template-columns: 1fr; }.outcomes { grid-template-columns: repeat(2, minmax(0, 1fr)); }.auto-control { margin-right: 0; }.toolbar { gap: 10px; } }
</style>
