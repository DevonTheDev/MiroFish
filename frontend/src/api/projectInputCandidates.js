import i18n from '../i18n'

const BODY_LIMIT = 262144
const LIMITS = Object.freeze({ entries: 256, rows: 50, metadata_file_bytes: 1048576, metadata_total_bytes: 8388608 })
const REASONS = ['unsafe', 'missing', 'too_large', 'invalid', 'changed', 'unreadable']
const STATUSES = ['created', 'ontology_generated', 'graph_building', 'graph_stopped', 'graph_completed', 'failed', 'unknown']
const encoder = new TextEncoder()
const invalid = () => new Error('Saved inputs could not be listed.')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum
const boolean = value => typeof value === 'boolean'
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)

// Match Unicode whitespace normalization, not ECMAScript trim/\s: U+FEFF
// is a valid format scalar preserved by the metadata reader.
function display(value, points, bytes) {
  if (value === null) return true
  if (typeof value !== 'string' || !value.replace(/\p{White_Space}/gu, '')) return false
  if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /\p{White_Space}/u.test(value.replace(/ /g, '')) || /  /.test(value)) return false
  return [...value].length <= points && encoder.encode(value).byteLength <= bytes
}
function timestamp(value) {
  if (value === null) return true
  if (typeof value !== 'string' || value.length > 40) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))?$/.exec(value)
  if (!match) return false
  const [, yy, mm, dd, hh, mi, ss, , oh, om] = match
  const year = Number(yy), month = Number(mm), day = Number(dd)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(hh) <= 23 && Number(mi) <= 59 && Number(ss) <= 59
    && (oh === undefined || (Number(oh) <= 23 && Number(om) <= 59))
}
function candidate(row) {
  if (!object(row) || !id(row.project_id) || !display(row.name, 120, 512)
    || !display(row.scenario_excerpt, 240, 1024) || !boolean(row.name_truncated) || !boolean(row.scenario_truncated)
    || (row.name === null && row.name_truncated) || (row.scenario_excerpt === null && row.scenario_truncated)
    || !STATUSES.includes(row.status) || !timestamp(row.created_at) || !timestamp(row.updated_at)) throw invalid()
  return Object.freeze({ project_id: row.project_id, name: row.name, name_truncated: row.name_truncated,
    status: row.status, created_at: row.created_at, updated_at: row.updated_at,
    scenario_excerpt: row.scenario_excerpt, scenario_truncated: row.scenario_truncated })
}

// Retain only the declared, bounded transport fields. Metadata never establishes
// recipe eligibility; the existing explicit recipe action remains its validator.
export function validateProjectInputCandidates(envelope) {
  const data = envelope?.data
  if (!object(envelope) || envelope.success !== true || !object(data) || !object(data.limits)
    || !Object.entries(LIMITS).every(([key, value]) => data.limits[key] === value)
    || !Array.isArray(data.items) || data.items.length > LIMITS.rows
    || !integer(data.examined_entries, LIMITS.entries) || !integer(data.returned, LIMITS.rows)
    || data.returned !== data.items.length || !integer(data.metadata_bytes_budgeted, LIMITS.metadata_total_bytes)
    || !integer(data.budget_deferred, 1) || !object(data.skipped)
    || !REASONS.every(reason => integer(data.skipped[reason], LIMITS.entries))
    || !['end', 'entry_limit', 'row_limit', 'byte_limit'].includes(data.stop_reason)
    || !boolean(data.directory_changed) || !boolean(data.partial)) throw invalid()
  const skipped = Object.fromEntries(REASONS.map(reason => [reason, data.skipped[reason]]))
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0)
  if (data.examined_entries !== data.returned + skippedTotal + data.budget_deferred
    || data.partial !== (data.stop_reason !== 'end' || skippedTotal > 0 || data.budget_deferred > 0 || data.directory_changed)
    || (data.stop_reason === 'entry_limit' && data.examined_entries !== LIMITS.entries)
    || (data.stop_reason === 'row_limit' && data.returned !== LIMITS.rows)
    || (data.budget_deferred && data.stop_reason !== 'byte_limit')) throw invalid()
  const items = data.items.map(candidate)
  if (new Set(items.map(row => row.project_id)).size !== items.length
    || items.some((row, index) => index > 0 && items[index - 1].project_id >= row.project_id)) throw invalid()
  return Object.freeze({ items: Object.freeze(items), examined_entries: data.examined_entries, returned: data.returned,
    metadata_bytes_budgeted: data.metadata_bytes_budgeted, budget_deferred: data.budget_deferred,
    skipped: Object.freeze(skipped), stop_reason: data.stop_reason, directory_changed: data.directory_changed,
    partial: data.partial, limits: LIMITS })
}

async function readBounded(response) {
  const announced = response.headers.get('content-length')
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > BODY_LIMIT)) {
    await response.body?.cancel().catch(() => {})
    throw invalid()
  }
  const reader = response.body?.getReader()
  if (!reader) throw invalid()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array) || value.byteLength > BODY_LIMIT - total) throw invalid()
      total += value.byteLength
      chunks.push(value)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Isolated fetch avoids shared Axios logging of stored names or scenario text.
export async function getProjectInputCandidates(signal) {
  try {
    const base = (import.meta.env?.VITE_API_BASE_URL || 'http://localhost:5001').replace(/\/$/, '')
    const response = await fetch(`${base}/api/graph/project/input-candidates`, {
      method: 'GET', signal, cache: 'no-store', headers: { 'Accept-Language': i18n.global.locale.value },
    })
    if (!response.ok) throw invalid()
    return validateProjectInputCandidates(JSON.parse(await readBounded(response)))
  } catch {
    throw invalid()
  }
}
