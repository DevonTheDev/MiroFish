import i18n from '../i18n'

// Keep raw stored content and transport exceptions out of the shared logger.
export async function getProjectInputRecipe(projectId, signal) {
  const base = (import.meta.env?.VITE_API_BASE_URL || 'http://localhost:5001').replace(/\/$/, '')
  const response = await fetch(`${base}/api/graph/project/${encodeURIComponent(projectId)}/input-recipe`, {
    method: 'GET', signal, cache: 'no-store', headers: { 'Accept-Language': i18n.global.locale.value },
  })
  if (!response.ok) {
    const error = new Error('Saved inputs could not be downloaded.')
    error.status = response.status
    throw error
  }
  return response.arrayBuffer()
}
