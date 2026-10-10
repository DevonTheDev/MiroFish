import service from './index'

// Read current saved interview traces only. IDs remain decimal text.
export function getSavedInterviews(simulationId, filters = {}, signal) {
  const params = Object.fromEntries(['platform', 'agent_id', 'window', 'before_row', 'revision']
    .filter(key => filters[key] !== undefined && filters[key] !== null && filters[key] !== '')
    .map(key => [key, filters[key]]))
  return service.get(`/api/simulation/${encodeURIComponent(simulationId)}/saved-interviews`, { params, signal })
}
