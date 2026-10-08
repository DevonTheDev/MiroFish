import { parseBoundedJson } from './boundedJson.js'
import { REPORT_OBSERVATION_KEYS, validSavedReportObservation } from './savedReportObservation.js'

// The API's compact {success:true,data:...}\n budget is 16 MiB. This allowance
// covers the fixed portable wrapper while checking the actual final UTF-8 size.
export const SAVED_REPORT_FILE_MAX_BYTES = 16 * 1024 * 1024 + 256
const format = 'mirofish-saved-report-observation'
const invalid = () => { throw new Error('Invalid or unsupported saved report file') }
const bytes = text => new TextEncoder().encode(text).length
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const project = observation => Object.fromEntries(REPORT_OBSERVATION_KEYS.map(key => [key, observation[key]]))
const scalar = value => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && !/\p{Cs}/u.test(value)

function validObservation(observation) {
  return exactKeys(observation, REPORT_OBSERVATION_KEYS)
    && REPORT_OBSERVATION_KEYS.every(key => scalar(observation[key]))
    && validSavedReportObservation(observation)
}

export function createSavedReportFile(observation) {
  try {
    const snapshot = project(observation)
    if (!validObservation(snapshot)) invalid()
    // JSON normally normalizes -0 to 0. Retain this accepted scalar too, while
    // JSON.stringify escapes every string and no response extras are traversed.
    const fields = REPORT_OBSERVATION_KEYS.map(key => `${JSON.stringify(key)}:${Object.is(snapshot[key], -0) ? '-0' : JSON.stringify(snapshot[key])}`)
    const text = `{"format":"${format}","version":1,"observation":{${fields.join(',')}}}\n`
    if (bytes(text) > SAVED_REPORT_FILE_MAX_BYTES) invalid()
    return text
  } catch { return invalid() }
}

export async function readSavedReportFile(file) {
  try {
    const size = file?.size
    if (!Number.isSafeInteger(size) || size < 0 || size > SAVED_REPORT_FILE_MAX_BYTES || typeof file.arrayBuffer !== 'function') invalid()
    const buffer = await file.arrayBuffer()
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size || buffer.byteLength > SAVED_REPORT_FILE_MAX_BYTES) invalid()
    // Retain a leading BOM so the JSON parser rejects it; a BOM inside a body
    // string remains literal content. Never replace malformed UTF-8 bytes.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    const data = parseBoundedJson(text, SAVED_REPORT_FILE_MAX_BYTES, 4, invalid, true, 128)
    if (!exactKeys(data, ['format', 'version', 'observation']) || data.format !== format || data.version !== 1 || !validObservation(data.observation)) invalid()
    // All accepted fields are scalar: a frozen detached projection is deeply
    // immutable. Revisions and observation time remain copied, unverified data.
    return Object.freeze(project(data.observation))
  } catch { return invalid() }
}
