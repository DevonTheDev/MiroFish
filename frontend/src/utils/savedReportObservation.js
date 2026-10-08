export const REPORT_OBSERVATION_KEYS = Object.freeze([
  'report_id', 'simulation_id', 'title', 'summary_preview', 'requirement_preview',
  'status', 'created_at', 'completed_at', 'source', 'metadata_revision', 'observed_at',
  'content_available', 'content_source', 'markdown_content', 'content_bytes',
  'content_revision', 'content_error',
])

const statuses = ['pending', 'planning', 'generating', 'completed', 'failed']
const revisionPattern = /^[a-f0-9]{64}$/, idPattern = /^[A-Za-z0-9_-]{1,128}$/
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max
const optionalText = value => value === null || typeof value === 'string'

// These are the saved library's existing live acceptance rules. File admission
// adds its own encoding/schema bounds without narrowing recorded live strings.
export function validSavedReportSummary(data) {
  return !!data && typeof data.report_id === 'string' && idPattern.test(data.report_id) && optionalText(data.simulation_id) && typeof data.title === 'string' && [...data.title].length <= 300 && ['summary_preview', 'requirement_preview'].every(key => typeof data[key] === 'string' && [...data[key]].length <= 500) && [...statuses, 'unknown'].includes(data.status) && optionalText(data.created_at) && optionalText(data.completed_at) && ['modern', 'legacy'].includes(data.source) && typeof data.metadata_revision === 'string' && revisionPattern.test(data.metadata_revision)
}

export function validSavedReportObservation(data, selected = null) {
  if (!validSavedReportSummary(data) || (selected !== null && (data.report_id !== selected.report_id || (selected.metadata_revision && data.metadata_revision !== selected.metadata_revision))) || typeof data.observed_at !== 'string' || typeof data.content_available !== 'boolean') return false
  if (data.content_available) return ['full_report.md', 'legacy_markdown', 'metadata'].includes(data.content_source) && typeof data.markdown_content === 'string' && bounded(data.content_bytes, 8 * 1024 * 1024) && new Blob([data.markdown_content]).size === data.content_bytes && typeof data.content_revision === 'string' && revisionPattern.test(data.content_revision) && data.content_error === null
  return data.markdown_content === null && data.content_bytes === null && data.content_revision === null && (data.content_source === null || ['full_report.md', 'legacy_markdown', 'metadata'].includes(data.content_source)) && ['not_saved', 'unreadable', 'too_large'].includes(data.content_error)
}
