import service from './index'
import i18n from '../i18n'
import { parseBoundedJson } from '../utils/boundedJson.js'
import { SAVED_ACTIONS_MAX_BYTES, SAVED_ACTIONS_ERROR_MAX_BYTES, savedActionsError, validSavedActionsIdentity, validateSavedActionsExport } from '../utils/savedActionsExport.js'

const statusCodes = {
  400: ['invalid_selection', 'invalid_filters', 'invalid_revision', 'revision_required', 'unsafe_path'],
  404: ['simulation_not_found', 'simulation_unreadable'],
  409: ['sources_changed', 'simulation_active', 'run_not_terminal'],
  413: ['export_too_large'],
  422: ['export_incomplete']
}
const jsonContent = response => /^application\/json(?:\s*;[^\r\n]*)?$/i.test(response.headers.get('Content-Type') ?? '')

// This GET deliberately bypasses Axios' JSON decoding and response-data
// interceptor. Keep the configured base URL, locale and cookie behavior.
export async function getSavedActionsExport(simulationId, revision, signal, isCurrent = () => true) {
  if (!validSavedActionsIdentity(simulationId, revision)) throw savedActionsError('invalid_selection')
  const controller = new AbortController()
  let reader = null, timeout = null, timedOut = false
  const abort = () => { controller.abort(); try { Promise.resolve(reader?.cancel()).catch(() => {}) } catch { /* cancellation is best effort */ } }
  const check = () => {
    if (signal?.aborted || !isCurrent()) { abort(); throw savedActionsError('cancelled') }
    if (timedOut) throw savedActionsError('timeout')
  }
  try {
    signal?.addEventListener('abort', abort, { once: true })
    check()
    if (typeof fetch !== 'function') throw savedActionsError('unsupported_reader')
    const milliseconds = service.defaults.timeout
    if (Number.isFinite(milliseconds) && milliseconds > 0) timeout = setTimeout(() => { timedOut = true; abort() }, milliseconds)
    const baseURL = String(service.defaults.baseURL ?? '').replace(/\/+$/, '')
    const response = await fetch(`${baseURL}/api/simulation/${encodeURIComponent(simulationId)}/saved-actions/export?revision=${encodeURIComponent(revision)}`, {
      method: 'GET', cache: 'no-store', credentials: service.defaults.withCredentials === true ? 'include' : 'same-origin', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': i18n.global.locale.value }
    })
    if (response.body && typeof response.body.getReader === 'function') reader = response.body.getReader()
    check()
    if (!reader) throw savedActionsError('unsupported_reader')
    if (!jsonContent(response)) throw savedActionsError('invalid_response')
    const maximum = response.ok ? SAVED_ACTIONS_MAX_BYTES : SAVED_ACTIONS_ERROR_MAX_BYTES
    const length = response.headers.get('Content-Length')
    if (length !== null && /^[0-9]+$/.test(length) && Number(length) > maximum) throw savedActionsError(response.ok ? 'export_too_large' : 'invalid_response')
    const chunks = []; let size = 0
    while (true) {
      const chunk = await reader.read()
      check()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) throw savedActionsError('invalid_response')
      size += chunk.value.byteLength
      if (size > maximum) throw savedActionsError(response.ok ? 'export_too_large' : 'invalid_response')
      chunks.push(chunk.value)
    }
    check()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    if (!response.ok) {
      const invalid = () => { throw savedActionsError('invalid_response') }
      let source
      try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { invalid() }
      const failure = parseBoundedJson(source, SAVED_ACTIONS_ERROR_MAX_BYTES, 4, invalid, true, 100)
      const code = statusCodes[response.status]?.includes(failure?.error_code) ? failure.error_code : 'generic'
      throw savedActionsError(code)
    }
    const data = validateSavedActionsExport(bytes, simulationId, revision)
    check()
    return { bytes, data }
  } catch (cause) {
    abort()
    if (signal?.aborted || !isCurrent()) throw savedActionsError('cancelled')
    if (timedOut) throw savedActionsError('timeout')
    throw cause?.exportCode ? cause : savedActionsError('generic')
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    try { reader?.releaseLock() } catch { /* a pending cancelled read may own the lock */ }
  }
}
