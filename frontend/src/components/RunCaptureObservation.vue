<template>
  <article class="observation">
    <template v-if="capture">
      <h3>{{ capture.label }}</h3><p v-if="capture.note" class="literal">{{ capture.note }}</p>
      <dl><dt>{{ t('runCaptures.captureId') }}</dt><dd>{{ capture.capture_id }}</dd><dt>{{ t('runCaptures.capturedAt') }}</dt><dd>{{ capture.captured_at }}</dd></dl>
    </template>
    <p class="identity">{{ summary.simulation_id }}</p>
    <p class="status" :class="{ interrupted: ['failed', 'stopped'].includes(summary.status) }">{{ t('comparison.savedStatus') }}: <strong>{{ statusLabel(summary.status) }}</strong></p>
    <p class="availability" :class="summary.availability">{{ availabilityLabel(summary.availability) }}</p>
    <h4>{{ t('comparison.scenario') }}</h4><p class="literal">{{ summary.scenario || t('comparison.notSaved') }}</p>
    <dl><dt>{{ t('runCaptures.observedAt') }}</dt><dd>{{ observation.observed_at }}</dd><template v-for="field in contextFields" :key="field"><dt>{{ t(`comparison.fields.${field}`) }}</dt><dd>{{ contextValue(field) }}</dd></template></dl>
    <p class="note">{{ t('comparison.modelNote') }}</p>
    <ul v-if="summary.warnings.length" class="warnings" :aria-label="t('comparison.warningsTitle')"><li v-for="(warning, index) in summary.warnings" :key="index">{{ warningLabel(warning) }}</li></ul>
    <template v-if="showMetrics">
      <h4>{{ t('comparison.recordedActivity') }}</h4>
      <dl><template v-for="metric in globalMetrics" :key="metric"><dt>{{ t(`comparison.metrics.${metric}`) }}</dt><dd>{{ count(summary.metrics[metric]) }}</dd></template></dl>
      <div v-for="platform in platforms" :key="platform" class="platform"><h4>{{ t(`comparison.platforms.${platform}`) }} · {{ availabilityLabel(summary.metrics.platforms[platform].availability) }}</h4><dl><template v-for="metric in platformMetrics" :key="metric"><dt>{{ t(`comparison.metrics.${metric}`) }}</dt><dd>{{ count(summary.metrics.platforms[platform][metric]) }}</dd></template></dl></div>
      <h4>{{ t('comparison.actionTypes') }}</h4><dl v-if="summary.metrics.action_types.length"><template v-for="action in summary.metrics.action_types" :key="action.action_type"><dt>{{ action.action_type }}</dt><dd>{{ count(action.count) }}</dd></template></dl><p v-else class="note">{{ t('comparison.noActionTypes') }}</p>
    </template>
  </article>
</template>
<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({ observation: { type: Object, required: true }, capture: { type: Object, default: null }, showMetrics: { type: Boolean, default: true } })
const { t } = useI18n()
const summary = computed(() => props.observation.summary)
const platforms = ['twitter', 'reddit'], globalMetrics = ['recorded_actions', 'rounds_with_actions'], platformMetrics = ['recorded_actions', 'active_agents']
const contextFields = ['configured_model', 'configured_agents', 'requested_rounds', 'last_saved_round', 'created_at', 'updated_at', 'started_at', 'completed_at']
const statusCodes = ['idle', 'created', 'preparing', 'ready', 'starting', 'running', 'paused', 'stopping', 'completed', 'stopped', 'failed']
const warningCodes = ['config_unavailable', 'run_state_unavailable', 'run_not_terminal', 'partial_run', 'platform_log_missing', 'platform_not_configured', 'invalid_records', 'source_unreadable', 'source_too_large', 'no_action_logs']
function statusLabel(value) { return t(`comparison.statuses.${statusCodes.includes(value) ? value : 'unknown'}`) }
function availabilityLabel(value) { return t(`comparison.availability.${['complete', 'partial', 'unavailable'].includes(value) ? value : 'unavailable'}`) }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—' }
function contextValue(field) { const value = summary.value[field]; return typeof value === 'string' && value !== '' ? value : '—' }
function warningLabel(warning) {
  const code = warningCodes.includes(warning.code) ? warning.code : 'generic'
  const message = t(`comparison.warnings.${code}`, { count: count(warning.count) })
  return platforms.includes(warning.platform) ? `${t(`comparison.platforms.${warning.platform}`)}: ${message}` : message
}
</script>
<style scoped>
.observation { min-width: 0; }h3 { margin: 0 0 10px; font-size: 18px; overflow-wrap: anywhere; }h4 { margin: 20px 0 8px; color: #68707c; font-size: 13px; }p { line-height: 1.6; }.literal { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }.identity { font: 12px monospace; overflow-wrap: anywhere; color: #68707c; }.status { padding: 10px 12px; background: #eff3f6; border-radius: 6px; font-size: 13px; }.status.interrupted { background: #fff0e5; color: #8a4121; border-left: 3px solid #c07243; }.availability { font-size: 12px; font-weight: 600; }.availability.partial { color: #805518; }.availability.unavailable { color: #68707c; }dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 14px; font-size: 13px; }dt { color: #68707c; overflow-wrap: anywhere; }dd { margin: 0; overflow-wrap: anywhere; }.note { color: #68707c; font-size: 12px; }.warnings { padding: 14px 14px 14px 30px; background: #fff8e9; border-radius: 7px; font-size: 12px; line-height: 1.7; color: #7b5a21; }.platform { padding-top: 2px; }
</style>
