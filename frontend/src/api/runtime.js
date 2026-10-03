import service from './index'

export const getRuntimeStatus = (signal) => service.get('/api/runtime/status', { signal })

// Aborting observation does not cancel an accepted backend check.
export const getLocalReadiness = (signal) => service.get('/api/runtime/readiness', { signal, timeout: 15000 })
export const startLocalReadiness = (signal) => service.post('/api/runtime/readiness', {}, { signal, timeout: 15000 })
export const cancelLocalReadiness = (runId, signal) => {
  if (!readinessUuid(runId)) return invalid()
  return service.post(`/api/runtime/readiness/${runId}/cancel`, {}, { signal, timeout: 15000 })
}

const states = ['disabled', 'inherited', 'not_running', 'transitioning', 'starting', 'running', 'closing', 'closed', 'failed']
const limitFields = ['max_concurrency', 'max_queue', 'request_timeout', 'max_output_tokens', 'max_input_chars']
const integerFields = ['embedding_dimensions', 'context_tokens', 'max_agents', 'max_rounds', 'max_agent_iterations']
const metricFields = ['admitted_connections', 'rejected_connections', 'queued_requests', 'active_requests', 'started_requests', 'succeeded_requests', 'failed_requests', 'timed_out_requests', 'cancelled_requests']
const issueFields = ['chat_model', 'embedding_model', 'chat_endpoint', 'embedding_endpoint', 'graph_endpoint', 'reasoning_effort', 'gateway', ...integerFields, ...limitFields.map(field => `gateway_limits.${field}`)]
const issueCodes = ['invalid_positive_integer', 'invalid_positive_number', 'invalid_local_endpoint', 'invalid_model', 'invalid_reasoning_effort', 'output_exceeds_context', 'invalid_gateway_configuration']
const invalid = () => { throw new Error('Invalid runtime observation') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, maximum = 256) => {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum || /\p{C}/u.test(value)) return invalid()
  return value
}
const number = (value, minimum = 0, integer = true) => {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) return invalid()
  return value
}
const timestamp = value => {
  if (value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) || !Number.isFinite(Date.parse(value))) return invalid()
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid()
  return value
}
const limits = (value, loaded = false) => {
  if (value === null) return null
  if (!object(value)) return invalid()
  return Object.fromEntries(limitFields.map(field => [field,
    number(value[field], field === 'max_queue' && !loaded ? 0 : Number.MIN_VALUE, field !== 'request_timeout')]))
}
const endpoint = (value, graph = false) => {
  if (value === null) return null
  text(value, 2048)
  // Server already canonicalizes these. Reject non-loopback/userinfo/path data
  // defensively rather than turning a future raw endpoint into a download.
  const match = /^(https?|bolt):\/\/(127(?:\.(?:0|[1-9][0-9]{0,2})){3}|\[::1\])(?::([1-9][0-9]{0,4}))?((?:\/[A-Za-z0-9._~-]*)*)$/.exec(value)
  if (!match || (graph ? match[1] !== 'bolt' : !['http', 'https'].includes(match[1])) ||
    (match[2] !== '[::1]' && match[2].split('.').some(part => Number(part) > 255)) ||
    (match[3] && Number(match[3]) > 65535) ||
    (graph ? match[4].includes('//') || match[4].split('/').some(part => part === '.' || part === '..') : !['', '/v1'].includes(match[4]))) return invalid()
  return value
}

// This projection is shared by rendering and download. Never retain the raw
// envelope or spread server objects: unknown nested keys may contain secrets.
export function acceptRuntimeSnapshot(envelope) {
  const data = envelope?.data
  if (envelope?.success !== true || !object(data) || data.schema_version !== 1 ||
    data.kind !== 'mirofish_local_runtime_status' || !['local', 'cloud'].includes(data.mode) ||
    !object(data.gateway) || !states.includes(data.gateway.state)) return invalid()
  const observedAt = timestamp(data.observed_at)
  if (!observedAt) return invalid()
  let configuration = null
  if (data.mode === 'local') {
    const source = data.configuration
    if (!object(source) || typeof source.valid !== 'boolean' || !Array.isArray(source.issues) || source.issues.length > 64) return invalid()
    const issues = source.issues.map(issue => object(issue) && issueFields.includes(issue.field) && issueCodes.includes(issue.code)
      ? { field: issue.field, code: issue.code }
      : { field: 'gateway', code: 'invalid_gateway_configuration' })
    configuration = {
      valid: source.valid && issues.length === 0, issues,
      chat_model: text(source.chat_model), embedding_model: text(source.embedding_model),
      chat_endpoint: endpoint(source.chat_endpoint), embedding_endpoint: endpoint(source.embedding_endpoint),
      graph_endpoint: endpoint(source.graph_endpoint, true),
      ...Object.fromEntries(integerFields.map(field => [field, number(source[field], 1)])),
      reasoning_effort: text(source.reasoning_effort, 64), gateway_limits: limits(source.gateway_limits, true),
    }
    if (['chat_model', 'embedding_model'].some(field => /(?::|-)(?:cloud)$/i.test(configuration[field] ?? ''))) return invalid()
    if (configuration.valid && (['chat_model', 'embedding_model', 'chat_endpoint', 'embedding_endpoint', 'graph_endpoint', ...integerFields]
      .some(field => !configuration[field]) || !configuration.gateway_limits || Object.values(configuration.gateway_limits).some(value => value === null))) return invalid()
  } else if (data.configuration !== null || data.gateway.state !== 'disabled') return invalid()
  const source = data.gateway
  const unobserved = ['disabled', 'inherited', 'not_running', 'transitioning'].includes(source.state)
  let metrics = null
  if (!unobserved && source.metrics !== null) {
    if (!object(source.metrics)) return invalid()
    metrics = Object.fromEntries(metricFields.map(field => [field, number(source.metrics[field])]))
  }
  const instanceId = source.instance_id === null ? null : text(source.instance_id, 64)
  if (instanceId !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(instanceId)) return invalid()
  return {
    schema_version: 1, kind: 'mirofish_local_runtime_status', observed_at: observedAt, mode: data.mode,
    configuration,
    gateway: { state: source.state, instance_id: unobserved ? null : instanceId,
      started_at: unobserved ? null : timestamp(source.started_at),
      uptime_seconds: unobserved ? null : number(source.uptime_seconds, 0, false),
      limits: unobserved ? null : limits(source.limits), metrics },
  }
}

export const readinessStepIds = ['configuration', 'dependencies', 'database', 'gateway', 'json_output', 'json_schema', 'tool_call', 'embedding', 'cleanup']
const readinessStates = ['running', 'stopping', 'passed', 'failed', 'cancelled', 'timed_out']
const readinessStepStates = ['pending', 'running', 'passed', 'failed', 'timed_out', 'skipped']
const readinessCodes = ['ok', 'invalid_configuration', 'dependency_unavailable', 'database_unavailable', 'invalid_database_response', 'gateway_unavailable', 'gateway_unsupported', 'gateway_busy', 'model_unavailable', 'capability_unsupported', 'embedding_invalid', 'step_timeout', 'budget_exhausted', 'prerequisite_failed', 'stopped', 'cleanup_failed', 'internal_failure']
const readinessUnavailable = ['local_mode_required', 'backend_closing', 'cleanup_failed', 'inherited_process']
const readinessBudget = { overall_ms: 300000, model_step_ms: 60000, database_step_ms: 10000, gateway_step_ms: 5000, cleanup_ms: 10000 }
const readinessUuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const requiredNumber = (value, minimum = 0) => value === null ? invalid() : number(value, minimum)

// The UI and download share a detached, fixed-shape projection. Unknown fields
// (including credentials, prompts and raw errors) are never retained.
export function acceptReadinessSnapshot(envelope) {
  const data = envelope?.data
  if (envelope?.success !== true || !object(data) || data.schema_version !== 1 ||
    data.kind !== 'mirofish_local_readiness' || !['local', 'cloud'].includes(data.mode) ||
    typeof data.available !== 'boolean' || !(data.unavailable_code === null || readinessUnavailable.includes(data.unavailable_code))) return invalid()
  const observedAt = timestamp(data.observed_at)
  if (!observedAt || data.available !== (data.unavailable_code === null) ||
    (data.mode === 'cloud' && (data.available || data.unavailable_code !== 'local_mode_required' || data.run !== null))) return invalid()
  let run = null
  if (data.run !== null) {
    const source = data.run
    if (!object(source) || !readinessUuid(source.id) || !readinessStates.includes(source.state) ||
      typeof source.cancel_requested !== 'boolean' || !object(source.configuration) || !object(source.budget) ||
      !(source.current_step === null || readinessStepIds.includes(source.current_step)) ||
      !Array.isArray(source.steps) || source.steps.length !== readinessStepIds.length) return invalid()
    const active = ['running', 'stopping'].includes(source.state)
    const startedAt = timestamp(source.started_at), finishedAt = timestamp(source.finished_at)
    if (!startedAt || (active ? finishedAt !== null : finishedAt === null || source.current_step !== null) ||
      (finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) ||
      (source.state === 'stopping' && !source.cancel_requested)) return invalid()
    const budget = Object.fromEntries(Object.entries(readinessBudget).map(([key, maximum]) => {
      const value = requiredNumber(source.budget[key], 1)
      if (value > maximum) return invalid()
      return [key, value]
    }))
    const configuration = { chat_model: text(source.configuration.chat_model), embedding_model: text(source.configuration.embedding_model),
      embedding_dimensions: number(source.configuration.embedding_dimensions, 1) }
    if (['chat_model', 'embedding_model'].some(key => /(?::|-)(?:cloud)$/i.test(configuration[key] ?? ''))) return invalid()
    const steps = source.steps.map((step, index) => {
      if (!object(step) || step.id !== readinessStepIds[index] || !readinessStepStates.includes(step.state) ||
        !(step.code === null || readinessCodes.includes(step.code)) ||
        (!active && ['pending', 'running'].includes(step.state)) ||
        (source.state === 'passed' && (step.state !== 'passed' || step.code !== 'ok'))) return invalid()
      return { id: step.id, state: step.state, code: step.code, duration_ms: number(step.duration_ms) }
    })
    run = { id: source.id, state: source.state, started_at: startedAt, finished_at: finishedAt,
      elapsed_ms: requiredNumber(source.elapsed_ms), current_step: source.current_step, budget, configuration,
      cancel_requested: source.cancel_requested, steps }
  }
  return { schema_version: 1, kind: 'mirofish_local_readiness', observed_at: observedAt, mode: data.mode,
    available: data.available, unavailable_code: data.unavailable_code, run }
}
