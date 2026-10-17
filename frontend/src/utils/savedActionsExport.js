import { parseBoundedJson } from './boundedJson.js'

export const SAVED_ACTIONS_MAX_BYTES = 8 * 1024 * 1024
export const SAVED_ACTIONS_MAX_RECORDS = 50000
export const SAVED_ACTIONS_ERROR_MAX_BYTES = 16 * 1024
export const savedActionsError = code => Object.assign(new Error(code), { exportCode: code })
const invalid = () => { throw savedActionsError('invalid_response') }
const platforms = ['twitter', 'reddit']
const rootKeys = ['format', 'version', 'simulation_id', 'source_revision', 'observed_at', 'context', 'availability', 'sources', 'platform_coverage', 'warnings', 'order', 'scope', 'truncated', 'record_count', 'actions']
const contextKeys = ['status', 'created_at', 'updated_at', 'started_at', 'completed_at', 'requested_rounds', 'last_saved_round']
const rowKeys = ['record_id', 'platform', 'agent_id', 'round_num', 'agent_name', 'timestamp', 'action_type', 'success', 'details_json']
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max
const decimal = value => typeof value === 'string' && /0|[1-9][0-9]*/.exec(value)?.[0] === value
const optionalText = value => value === null || typeof value === 'string'
const laterDecimal = (value, previous) => value.length > previous.length || value.length === previous.length && value > previous
export const validSavedActionsIdentity = (simulationId, revision) => typeof simulationId === 'string' && simulationId.length >= 1 && simulationId.length <= 128 && !/[^A-Za-z0-9_-]/.test(simulationId) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(simulationId) && typeof revision === 'string' && revision.length === 64 && !/[^a-f0-9]/.test(revision)

// Validate only the versioned envelope and row metadata. details_json is opaque
// saved evidence; parsing it would round source integers through JavaScript.
export function validateSavedActionsExport(bytes, simulationId, revision) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > SAVED_ACTIONS_MAX_BYTES || !validSavedActionsIdentity(simulationId, revision)) invalid()
  let source
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { invalid() }
  // Server output is canonical ASCII JSON, including the final newline. The
  // cap covers those exact bytes, including escapes around details_json.
  if (!source.endsWith('\n') || /[^\x00-\x7f]/.test(source)) invalid()
  const data = parseBoundedJson(source, SAVED_ACTIONS_MAX_BYTES, 8, invalid, false, 600000)
  if (!exactKeys(data, rootKeys) || data.format !== 'mirofish-saved-actions' || data.version !== 1 || data.simulation_id !== simulationId || data.source_revision !== revision || data.scope !== 'all_saved_actions' || data.order !== 'source_record' || data.truncated !== false || data.availability !== 'complete') invalid()
  if (typeof data.observed_at !== 'string' || !/(?:Z|\+00:00)$/.test(data.observed_at) || !Number.isFinite(Date.parse(data.observed_at))) invalid()
  const context = data.context
  if (!exactKeys(context, contextKeys) || !['completed', 'stopped', 'failed'].includes(context.status) || !contextKeys.filter(key => key.endsWith('_at')).every(key => optionalText(context[key])) || !['requested_rounds', 'last_saved_round'].every(key => context[key] === null || decimal(context[key]))) invalid()
  if (!Array.isArray(data.sources) || ![['twitter'], ['reddit'], ['twitter', 'reddit'], ['legacy']].some(sources => sources.length === data.sources.length && sources.every((kind, index) => kind === data.sources[index]))) invalid()
  if (!exactKeys(data.platform_coverage, platforms) || !bounded(data.record_count, SAVED_ACTIONS_MAX_RECORDS) || !Array.isArray(data.actions) || data.actions.length !== data.record_count) invalid()
  const legacy = data.sources[0] === 'legacy'
  for (const platform of platforms) {
    const coverage = data.platform_coverage[platform]
    if (!exactKeys(coverage, ['enabled', 'availability', 'source', 'recorded_actions']) || ![true, false, null].includes(coverage.enabled)) invalid()
    if (coverage.availability === 'complete') {
      if (coverage.source !== (legacy ? 'legacy' : platform) || !data.sources.includes(coverage.source) || !bounded(coverage.recorded_actions, SAVED_ACTIONS_MAX_RECORDS)) invalid()
    } else if (coverage.availability !== 'unavailable' || coverage.enabled !== false || coverage.source !== null || coverage.recorded_actions !== null || !legacy && data.sources.includes(platform)) invalid()
  }
  const warningKeys = new Set()
  if (!Array.isArray(data.warnings) || data.warnings.length > 5) invalid()
  for (const warning of data.warnings) {
    if (!warning || typeof warning !== 'object') invalid()
    if (warning.code === 'platform_not_configured') {
      if (!exactKeys(warning, ['code', 'platform']) || !platforms.includes(warning.platform)) invalid()
    } else if (!['config_unavailable', 'run_state_unavailable', 'partial_run'].includes(warning.code) || !exactKeys(warning, ['code'])) invalid()
    const key = `${warning.code}:${warning.platform ?? ''}`
    if (warningKeys.has(key)) invalid()
    warningKeys.add(key)
  }
  if (warningKeys.has('partial_run:') !== ['stopped', 'failed'].includes(context.status)) invalid()
  for (const platform of platforms) {
    const coverage = data.platform_coverage[platform]
    if (warningKeys.has(`platform_not_configured:${platform}`) !== (coverage.enabled === false && coverage.availability === 'complete')) invalid()
  }
  let previousSource = null, previousLine = null
  const counts = { twitter: 0, reddit: 0 }
  for (const row of data.actions) {
    if (!exactKeys(row, rowKeys) || !platforms.includes(row.platform) || !decimal(row.agent_id) || !decimal(row.round_num) || !optionalText(row.agent_name) || !optionalText(row.timestamp) || typeof row.action_type !== 'string' || !row.action_type.length || [...row.action_type].length > 256 || /^[\p{White_Space}\u001c-\u001f]+$/u.test(row.action_type) || ![true, false, null].includes(row.success) || typeof row.details_json !== 'string') invalid()
    const record = typeof row.record_id === 'string' && /(twitter|reddit|legacy):([1-9][0-9]*)/.exec(row.record_id)
    if (!record || record[0] !== row.record_id) invalid()
    const [, kind, line] = record
    const coverage = data.platform_coverage[row.platform]
    if (!data.sources.includes(kind) || kind !== coverage.source || coverage.availability !== 'complete' || kind !== 'legacy' && kind !== row.platform) invalid()
    if (previousSource !== null && (kind === previousSource ? !laterDecimal(line, previousLine) : data.sources.indexOf(kind) <= data.sources.indexOf(previousSource))) invalid()
    previousSource = kind; previousLine = line; counts[row.platform]++
  }
  if (platforms.some(platform => counts[platform] !== (data.platform_coverage[platform].recorded_actions ?? 0))) invalid()
  return data
}
