import { parseBoundedJson } from './boundedJson.js'
import { validSavedInterviewObservation } from './savedInterviewObservation.js'

export const SAVED_INTERVIEW_FILE_MAX_BYTES = 8 * 1024 * 1024
const invalid = () => { throw new Error('Invalid saved interview file') }

function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy))
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozenCopy(child)])))
  return value
}

// Read the existing bare download. Validation and freezing preserve every saved
// row and exact string, including escaped lone surrogates exported by the backend.
export async function readSavedInterviewFile(file) {
  try {
    const size = file?.size
    if (!Number.isSafeInteger(size) || size < 0 || size > SAVED_INTERVIEW_FILE_MAX_BYTES || typeof file.arrayBuffer !== 'function') invalid()
    const buffer = await file.arrayBuffer()
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size || buffer.byteLength > SAVED_INTERVIEW_FILE_MAX_BYTES) invalid()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    const data = parseBoundedJson(text, SAVED_INTERVIEW_FILE_MAX_BYTES, 8, invalid, false, 10000)
    if (!validSavedInterviewObservation(data, { simulation_id: data?.simulation_id, filters: data?.filters })) invalid()
    return frozenCopy(data)
  } catch { return invalid() }
}
