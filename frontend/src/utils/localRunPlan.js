const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const portableId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export const validLocalLimits = limits => !!limits && limits.valid === true
  && ['max_agents', 'max_selectable_agents', 'max_rounds', 'max_concurrency', 'max_catalog_entities'].every(key => positiveInteger(limits[key]))
  && limits.max_selectable_agents === Math.min(limits.max_agents, 1000)
  && limits.max_catalog_entities <= 1000

export const validLocalPlan = plan => validLocalLimits(plan?.limits)
  && typeof plan.owner?.busy === 'boolean' && typeof plan.prepared?.available === 'boolean'
  && typeof plan.can_prepare === 'boolean' && typeof plan.can_reuse === 'boolean'

export const validLocalCatalog = (data, id) => data?.simulation_id === id && validLocalLimits(data.limits)
  && Array.isArray(data.entities) && data.entities.length <= data.limits.max_catalog_entities
  && data.eligible_count === data.entities.length
  && new Set(data.entities.map(entity => entity?.uuid)).size === data.entities.length
  && data.entities.every(entity => portableId(entity?.uuid) && typeof entity.name === 'string' && Array.from(entity.name).length <= 256
    && typeof entity.entity_type === 'string' && entity.entity_type.length > 0 && Array.from(entity.entity_type).length <= 128
    && typeof entity.summary === 'string' && Array.from(entity.summary).length <= 240 && typeof entity.text_truncated === 'boolean')

export const configuredRounds = config => {
  const hours = config?.time_config?.total_simulation_hours
  const minutes = config?.time_config?.minutes_per_round
  if (typeof hours !== 'number' || typeof minutes !== 'number' || !Number.isFinite(hours) || !Number.isFinite(minutes) || hours <= 0 || minutes <= 0) return null
  const rounds = Math.floor(hours * 60 / minutes)
  return positiveInteger(rounds) ? rounds : null
}

export const validLocalMaximum = (value, cap) => positiveInteger(value) && positiveInteger(cap) && value <= cap
export const effectiveRounds = (config, requested, cap) => {
  const configured = configuredRounds(config)
  return configured && validLocalMaximum(requested, cap) ? Math.min(configured, requested, cap) : null
}

export const planningErrorKey = error => {
  const code = error?.response?.data?.error_code || error?.error_code || error
  if (['preparation_busy', 'run_busy', 'updater_busy', 'lifecycle_busy', 'graph_busy', 'ownership_unavailable'].includes(code)) return 'localPlan.busyError'
  if (['graph_changed', 'selection_changed', 'invalid_selection', 'source_changed'].includes(code)) return 'localPlan.changedError'
  if (['existing_preparation', 'prepared_unavailable', 'missing_artifacts', 'invalid_artifacts', 'unsafe_path', 'artifact_count_mismatch', 'agent_limit_exceeded'].includes(code)) return 'localPlan.savedError'
  if (['request_too_large', 'source_too_large', 'graph_too_large', 'catalog_too_large', 'preview_too_large'].includes(code)) return 'localPlan.sizeError'
  if (code === 'invalid_configuration') return 'localPlan.invalidLimits'
  return 'localPlan.requestError'
}
