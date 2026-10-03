import service from './index'

export const getRuntimeStatus = (signal) => service.get('/api/runtime/status', { signal })

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
