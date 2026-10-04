import { parseBoundedJson } from './boundedJson.js'
import { validLocalCatalog } from './localRunPlan.js'

export const LOCAL_CAST_PRESET_MAX_BYTES = 256 * 1024
const keys = ['schema_version', 'kind', 'project_id', 'graph_id', 'selected_entity_ids', 'use_llm_for_profiles', 'max_rounds']
const portableId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const bytes = value => new TextEncoder().encode(value).length
const invalid = (code = 'invalid_preset') => {
  throw Object.assign(new Error(`Invalid local cast preset: ${code}`), { code })
}

// This file is a draft recipe only. It contains no profiles, prompts, runtime
// configuration or source simulation, and its graph ID does not freeze graph content.
export function acceptLocalCastPreset(source) {
  try {
    if (source === null || typeof source !== 'object' || Array.isArray(source) ||
      Reflect.ownKeys(source).length !== keys.length || !keys.every(key => Object.hasOwn(source, key)) ||
      source.schema_version !== 1 || source.kind !== 'mirofish_local_cast_preset' ||
      !portableId(source.project_id) || !portableId(source.graph_id) ||
      typeof source.use_llm_for_profiles !== 'boolean' || !Number.isSafeInteger(source.max_rounds) || source.max_rounds < 1 ||
      !Array.isArray(source.selected_entity_ids) || source.selected_entity_ids.length < 1 || source.selected_entity_ids.length > 1000) return invalid()
    const selected = Array.from(source.selected_entity_ids)
    if (!selected.every(portableId) || new Set(selected).size !== selected.length) return invalid()
    return { schema_version: 1, kind: 'mirofish_local_cast_preset', project_id: source.project_id,
      graph_id: source.graph_id, selected_entity_ids: selected, use_llm_for_profiles: source.use_llm_for_profiles,
      max_rounds: source.max_rounds }
  } catch { return invalid() }
}

export function parseLocalCastPreset(source) {
  if (typeof source !== 'string') return invalid()
  if (bytes(source) > LOCAL_CAST_PRESET_MAX_BYTES) return invalid('file_too_large')
  return acceptLocalCastPreset(parseBoundedJson(source, LOCAL_CAST_PRESET_MAX_BYTES, 2, invalid, true))
}

// Browser callers check the declared File.size before reading. This admission
// checks the actual returned bytes and rejects invalid UTF-8 without replacement.
export function parseLocalCastPresetBytes(source) {
  const payload = source instanceof ArrayBuffer ? new Uint8Array(source) : source
  if (!(payload instanceof Uint8Array)) return invalid()
  if (payload.byteLength > LOCAL_CAST_PRESET_MAX_BYTES) return invalid('file_too_large')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload) }
  catch { return invalid('invalid_utf8') }
  return parseLocalCastPreset(text)
}

export function exportLocalCastPreset(source) {
  const result = JSON.stringify(acceptLocalCastPreset(source), null, 2)
  if (bytes(result) > LOCAL_CAST_PRESET_MAX_BYTES) return invalid('file_too_large')
  return result
}

// Keep the legacy planner catalog contract unchanged. Only preset operations
// require the validated project and graph binding returned by current previews.
export function validLocalCastPresetCatalog(catalog, simulationId) {
  try {
    return !!(validLocalCatalog(catalog, simulationId) && portableId(catalog.project_id) && portableId(catalog.graph_id))
  } catch { return false }
}

export function acceptCompatibleLocalCastPreset(source, catalog, simulationId) {
  const preset = acceptLocalCastPreset(source)
  if (!validLocalCastPresetCatalog(catalog, simulationId)) return invalid('invalid_catalog')
  if (preset.project_id !== catalog.project_id || preset.graph_id !== catalog.graph_id) return invalid('identity_mismatch')
  const available = new Set(catalog.entities.map(entity => entity.uuid))
  if (!preset.selected_entity_ids.every(id => available.has(id))) return invalid('selection_unavailable')
  if (preset.selected_entity_ids.length > catalog.limits.max_selectable_agents) return invalid('agent_limit_exceeded')
  if (preset.max_rounds > catalog.limits.max_rounds) return invalid('round_limit_exceeded')
  return preset
}
