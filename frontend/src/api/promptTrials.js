import axios from 'axios'

// This private-prompt transport intentionally bypasses the global client's
// localhost default and raw Axios error logging. Vite forwards relative /api.
const service = axios.create({ baseURL: '', timeout: 15000, headers: { 'Content-Type': 'application/json' } })
export const getPromptTrials = signal => service.get('/api/runtime/trials', { signal }).then(response => response.data)
export const getPromptTrial = (requestId, signal) => {
  if (!uuid(requestId)) return invalid()
  return service.get(`/api/runtime/trials/${requestId}`, { signal }).then(response => response.data)
}
export const startPromptTrial = (request, signal) => service.post('/api/runtime/trials', acceptPromptTrialRequest(request), { signal }).then(response => response.data)
export const cancelPromptTrial = (target, signal) => {
  if (!object(target) || !uuid(target.request_id) || !uuid(target.instance_id) ||
    typeof target.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(target.fingerprint)) return invalid()
  return service.post(`/api/runtime/trials/${target.request_id}/cancel`,
    { instance_id: target.instance_id, fingerprint: target.fingerprint }, { signal }).then(response => response.data)
}

const invalid = () => { throw new Error('Invalid prompt trial observation') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const fields = ['label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens']
const terminalStates = ['succeeded', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']
const errorCodes = ['invalid_configuration', 'gateway_unavailable', 'gateway_unsupported', 'gateway_busy', 'startup_timeout', 'request_timeout', 'overall_timeout', 'response_too_large', 'malformed_response', 'unsupported_completion', 'model_unavailable', 'cleanup_failed', 'backend_closing', 'user_cancelled', 'internal_failure']
const unavailableCodes = ['local_mode_required', 'inherited_process', 'backend_closing', 'cleanup_failed', 'invalid_configuration']
const fixedLimits = { max_body_bytes: 32768, label_chars: 80, system_prompt_chars: 1000, user_prompt_chars: 4000,
  response_bytes: 65536, retained_output_chars: 16384, gateway_startup_ms: 5000, request_ms: 60000, overall_ms: 65000, cleanup_ms: 10000 }
const number = (value, maximum = Number.MAX_SAFE_INTEGER, integer = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isSafeInteger(value))) return invalid()
  return value
}
const nullableNumber = value => value === null ? null : number(value)
const text = (value, maximum, { blank = true, plain = false } = {}) => {
  if (typeof value !== 'string' || Array.from(value).length > maximum || (!blank && !value.trim()) ||
    (plain ? /\p{C}/u : /[\p{Cc}\p{Cs}]/u).test(plain ? value : value.replace(/[\r\n\t]/g, ''))) return invalid()
  return value
}
const responseText = value => {
  if (typeof value !== 'string' || Array.from(value).length > 16384 || /\p{Cs}/u.test(value)) return invalid()
  return value
}
const modelText = (value, maximum = 256) => {
  const result = text(value, maximum, { blank: false, plain: true })
  if (result !== result.trim()) return invalid()
  return result
}
const timestamp = value => {
  if (value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid()
  return value
}
function requestFields(source) {
  if (!object(source)) return invalid()
  const cap = number(source.max_output_tokens, 512)
  if (cap < 1) return invalid()
  return { label: text(source.label, 80, { blank: false, plain: true }),
    system_prompt: text(source.system_prompt, 1000), user_prompt: text(source.user_prompt, 4000, { blank: false }),
    temperature: number(source.temperature, 1, false), max_output_tokens: cap }
}
// Shared fixed-field input admission for local suite definitions.
export const acceptPromptTrialInputs = requestFields
export function acceptPromptTrialRequest(source) {
  if (!object(source) || !uuid(source.request_id)) return invalid()
  const request = { request_id: source.request_id, ...requestFields(source) }
  if (new TextEncoder().encode(JSON.stringify(request)).length > 32768) return invalid()
  return request
}
export const samePromptTrialRequest = (left, right) => object(left) && object(right) && fields.every(field => left[field] === right[field])
export const isPromptTrialTerminal = run => object(run) && terminalStates.includes(run.state)

// A detached fixed-field projection is shared by rendering, pins and export.
// Unknown envelope/nested fields (including endpoints and raw errors) are dropped.
export function acceptPromptTrialSnapshot(envelope) {
  const data = envelope?.data
  if (envelope?.success !== true || !object(data) || data.schema_version !== 1 || data.kind !== 'mirofish_local_prompt_trials' ||
    !['local', 'cloud'].includes(data.mode) || typeof data.available !== 'boolean' ||
    !(data.unavailable_code === null || unavailableCodes.includes(data.unavailable_code)) || data.available !== (data.unavailable_code === null) ||
    !object(data.limits)) return invalid()
  const observedAt = timestamp(data.observed_at)
  if (!observedAt) return invalid()
  const limits = Object.fromEntries(Object.entries(fixedLimits).map(([key, value]) => {
    if (data.limits[key] !== value) return invalid()
    return [key, value]
  }))
  limits.max_output_tokens = data.limits.max_output_tokens === null ? null : number(data.limits.max_output_tokens, 512)
  if (limits.max_output_tokens === 0 || (data.available && limits.max_output_tokens === null) ||
    (data.mode === 'cloud' && (data.available || data.unavailable_code !== 'local_mode_required' || data.run !== null || limits.max_output_tokens !== null))) return invalid()
  let run = null
  if (data.run !== null) {
    const source = data.run
    if (!object(source) || !uuid(source.request_id) || typeof source.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint) ||
      (Object.hasOwn(source, 'instance_id') && !uuid(source.instance_id)) ||
      !['running', ...terminalStates].includes(source.state) || !object(source.configuration) || !object(source.cleanup) ||
      !['pending', 'running', 'succeeded', 'failed'].includes(source.cleanup.state) ||
      !(source.error_code === null || errorCodes.includes(source.error_code))) return invalid()
    const active = source.state === 'running'
    const startedAt = timestamp(source.started_at), finishedAt = timestamp(source.finished_at)
    if (!startedAt || (active ? finishedAt !== null : finishedAt === null || Date.parse(finishedAt) < Date.parse(startedAt)) ||
      (!active && !['succeeded', 'failed'].includes(source.cleanup.state))) return invalid()
    const configuration = { model: modelText(source.configuration.model), reasoning_effort: source.configuration.reasoning_effort === null ? null : modelText(source.configuration.reasoning_effort, 64) }
    if (configuration.model.includes('://') || /(?::|-)(?:cloud)$/i.test(configuration.model)) return invalid()
    let response = null
    if (source.response !== null) {
      const raw = source.response
      if (!object(raw) || !object(raw.usage) || !['stop', 'length', 'content_filter'].includes(raw.finish_reason)) return invalid()
      response = { content: raw.content === null ? null : responseText(raw.content), refusal: raw.refusal === null ? null : responseText(raw.refusal),
        finish_reason: raw.finish_reason, usage: { prompt_tokens: nullableNumber(raw.usage.prompt_tokens), completion_tokens: nullableNumber(raw.usage.completion_tokens), total_tokens: nullableNumber(raw.usage.total_tokens) } }
    }
    if (['succeeded', 'truncated', 'refused'].includes(source.state)) {
      if (source.error_code !== null || source.cleanup.state !== 'succeeded' || response === null) return invalid()
      if (source.state === 'succeeded' && (response.content === null || response.finish_reason !== 'stop' || ![null, ''].includes(response.refusal))) return invalid()
      if (source.state === 'truncated' && (response.content === null || response.finish_reason !== 'length' || ![null, ''].includes(response.refusal))) return invalid()
      if (source.state === 'refused' && response.finish_reason !== 'content_filter' && (response.refusal === null || response.refusal === '')) return invalid()
    }
    if (['failed', 'timed_out', 'cancelled'].includes(source.state) && source.error_code === null) return invalid()
    if (source.error_code === 'user_cancelled' && (!['running', 'cancelled'].includes(source.state) || response !== null)) return invalid()
    if (source.cleanup.state === 'failed' && (source.state !== 'failed' || source.error_code !== 'cleanup_failed')) return invalid()
    run = { request_id: source.request_id, fingerprint: source.fingerprint, state: source.state, started_at: startedAt, finished_at: finishedAt,
      elapsed_ms: number(source.elapsed_ms), request_duration_ms: nullableNumber(source.request_duration_ms), request: requestFields(source.request),
      configuration, response, error_code: source.error_code,
      cleanup: { state: source.cleanup.state, duration_ms: nullableNumber(source.cleanup.duration_ms) } }
    if (Object.hasOwn(source, 'instance_id')) run.instance_id = source.instance_id
  }
  return { schema_version: 1, kind: 'mirofish_local_prompt_trials', mode: data.mode, available: data.available,
    unavailable_code: data.unavailable_code, observed_at: observedAt, limits, run }
}
