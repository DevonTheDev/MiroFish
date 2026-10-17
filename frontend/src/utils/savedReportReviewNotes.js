import { parseBoundedJson } from './boundedJson.js'
import { createSavedReportFile } from './savedReportFiles.js'
import { REPORT_OBSERVATION_KEYS } from './savedReportObservation.js'

export const REVIEW_NOTES_LIMITS = Object.freeze({
  fileBytes: 512 * 1024, bodyBytes: 8 * 1024 * 1024, notes: 32, notePoints: 2000,
  depth: 4, values: 256, headings: 200, metadataPoints: 160,
  filenameUnits: 1024, filenamePoints: 512, filenameBytes: 2048,
})
const format = 'mirofish-report-review-notes'
const bindingKeys = ['report_id', 'text_sha256', 'text_bytes']
const invalid = () => { throw new Error('Invalid or unsupported review notes file') }
const invalidSource = () => { throw new Error('This source cannot be reviewed as a portable completed report') }
const staleSource = () => { throw new Error('This review capture is no longer current') }
const scalarText = text => typeof text === 'string' && !/\p{Cs}/u.test(text)
const byteLength = text => new TextEncoder().encode(text).length
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0
  && !Object.is(value, -0) && value <= maximum
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function withinPoints(text, maximum) {
  let count = 0
  for (let index = 0; index < text.length; index += text.codePointAt(index) > 0xffff ? 2 : 1) {
    if (++count > maximum) return false
  }
  return true
}

// Project only existing observation fields before asking the unchanged portable
// observation serializer to validate. Response extras and toJSON never survive.
export function projectReviewSource(source) {
  try {
    const snapshot = Object.fromEntries(REPORT_OBSERVATION_KEYS.map(key => [key, source[key]]))
    if (snapshot.status !== 'completed' || snapshot.content_available !== true
      || !scalarText(snapshot.markdown_content)
      || !Number.isSafeInteger(snapshot.content_bytes) || snapshot.content_bytes < 0
      || snapshot.content_bytes > REVIEW_NOTES_LIMITS.bodyBytes
      || snapshot.markdown_content.length > REVIEW_NOTES_LIMITS.bodyBytes
      || byteLength(snapshot.markdown_content) !== snapshot.content_bytes) invalidSource()
    createSavedReportFile(snapshot)
    return Object.freeze(snapshot)
  } catch { return invalidSource() }
}

// The owner also permanently retires the attempt on synchronous parent/source
// changes; no predicate polling can observe an A -> B -> A transition by itself.
// host is injectable for deterministic lifecycle tests, never an alternate hash.
export async function digestReviewSource(snapshot, isCurrent = () => true, host = globalThis) {
  let live = true
  const current = () => {
    if (!live) return false
    try { live = typeof isCurrent === 'function' && isCurrent() === true } catch { live = false }
    return live
  }
  const requireCurrent = () => { if (!current()) staleSource() }
  try {
    requireCurrent()
    const captured = projectReviewSource(snapshot)
    requireCurrent()
    const bytes = new TextEncoder().encode(captured.markdown_content)
    requireCurrent()
    if (bytes.byteLength !== captured.content_bytes || bytes.byteLength > REVIEW_NOTES_LIMITS.bodyBytes) invalidSource()
    const crypto = host.crypto
    requireCurrent()
    const subtle = crypto?.subtle
    requireCurrent()
    const digest = subtle?.digest
    requireCurrent()
    if (typeof digest !== 'function') throw new Error('Missing SHA-256')
    const pending = Reflect.apply(digest, subtle, ['SHA-256', bytes])
    // Observe synchronous retirement immediately. Still await the operation to
    // consume its rejection; a retired operation can never become live again.
    current()
    const result = await pending
    requireCurrent()
    if (!(result instanceof ArrayBuffer)) throw new Error('Invalid SHA-256 result')
    const hash = new Uint8Array(result)
    if (hash.byteLength !== 32) throw new Error('Invalid SHA-256 result')
    const text_sha256 = Array.from(hash, value => value.toString(16).padStart(2, '0')).join('')
    requireCurrent()
    return Object.freeze({ report_id: captured.report_id, text_sha256, text_bytes: bytes.byteLength })
  } catch {
    if (!current()) return staleSource()
    throw new Error('SHA-256 could not be computed for this review source')
  }
}

function projectBinding(binding) {
  if (!exactKeys(binding, bindingKeys)) return invalid()
  const { report_id, text_sha256, text_bytes } = binding
  if (typeof report_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(report_id)
    || typeof text_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(text_sha256)
    || !integer(text_bytes, REVIEW_NOTES_LIMITS.bodyBytes)) return invalid()
  return Object.freeze({ report_id, text_sha256, text_bytes })
}

export function boundReviewDraft(text) {
  if (!scalarText(text) || !withinPoints(text, REVIEW_NOTES_LIMITS.notePoints)) return invalid()
  return text
}

export function validateReviewNote(note, headings) {
  if (!exactKeys(note, ['heading_start', 'text']) || !Array.isArray(headings)
    || headings.length > REVIEW_NOTES_LIMITS.headings) return invalid()
  const { heading_start, text } = note
  boundReviewDraft(text)
  if (!/[^\p{White_Space}\uFEFF]/u.test(text)) return invalid()
  if (heading_start !== null && (!integer(heading_start, Number.MAX_SAFE_INTEGER)
    || !headings.some(heading => heading.lineStart === heading_start))) return invalid()
  return Object.freeze({ heading_start, text })
}

function envelope(binding, notes, headings) {
  const source = projectBinding(binding)
  if (!Array.isArray(notes) || notes.length > REVIEW_NOTES_LIMITS.notes) return invalid()
  // Array.from visits sparse slots too: a hole must not become JSON null.
  const admitted = Object.freeze(Array.from(notes, note => validateReviewNote(note, headings)))
  return Object.freeze({ format, version: 1, source, notes: admitted })
}

export function createReviewNotesFile(binding, notes, headings) {
  try {
    const text = JSON.stringify(envelope(binding, notes, headings)) + '\n'
    if (byteLength(text) > REVIEW_NOTES_LIMITS.fileBytes) return invalid()
    return text
  } catch { return invalid() }
}

export async function readReviewNotesFile(file, binding, headings) {
  try {
    const expected = projectBinding(binding), size = file?.size, read = file?.arrayBuffer
    if (!Number.isSafeInteger(size) || size < 0 || size > REVIEW_NOTES_LIMITS.fileBytes
      || typeof read !== 'function') return invalid()
    const buffer = await Reflect.apply(read, file, [])
    if (!(buffer instanceof ArrayBuffer)) return invalid()
    const raw = new Uint8Array(buffer)
    if (raw.byteLength !== size || raw.byteLength > REVIEW_NOTES_LIMITS.fileBytes) return invalid()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    const data = parseBoundedJson(text, 524288, 4, invalid, true, 256)
    if (!exactKeys(data, ['format', 'version', 'source', 'notes'])
      || data.format !== format || data.version !== 1) return invalid()
    const admitted = envelope(data.source, data.notes, headings)
    if (!bindingKeys.every(key => admitted.source[key] === expected[key])) return invalid()
    return admitted
  } catch { return invalid() }
}

export function validReviewFilename(filename) {
  return scalarText(filename) && filename.length <= REVIEW_NOTES_LIMITS.filenameUnits
    && withinPoints(filename, REVIEW_NOTES_LIMITS.filenamePoints)
    && byteLength(filename) <= REVIEW_NOTES_LIMITS.filenameBytes
}

export function displayReviewMetadata(text) {
  if (text === null) return ''
  if (!scalarText(text)) return invalid()
  let end = 0, count = 0
  for (const character of text) {
    if (count++ === REVIEW_NOTES_LIMITS.metadataPoints) return text.slice(0, end) + '…'
    end += character.length
  }
  return text
}
