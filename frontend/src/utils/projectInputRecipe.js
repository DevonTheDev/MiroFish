export const MAX_RECIPE_BYTES = 2 * 1024 * 1024
export const MAX_RECIPE_SOURCE_BYTES = 1024 * 1024
export const RECIPE_SOURCE_FILENAME = 'reused-project-source.txt'
export const RECIPE_DOWNLOAD_FILENAME = 'mirofish-project-input-recipe.json'
const keys = ['format', 'version', 'source_kind', 'source_text', 'simulation_requirement', 'source_project_name', 'captured_at']
const blank = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/u

export class InputRecipeError extends Error {
  constructor(code = 'invalid') { super('Input recipe could not be opened.'); this.code = code }
}

function scalar(value) {
  if (typeof value !== 'string') throw new InputRecipeError()
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new InputRecipeError()
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new InputRecipeError()
  }
  return value
}

function bounded(value, limit, required = false) {
  scalar(value)
  if (new TextEncoder().encode(value).byteLength > limit) throw new InputRecipeError('tooLarge')
  if (required && blank.test(value)) throw new InputRecipeError()
  return value
}

export function parseInputRecipeBytes(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength > MAX_RECIPE_BYTES) throw new InputRecipeError('tooLarge')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new InputRecipeError()
  let value
  try {
    // One native parse: duplicate keys have last-value-wins semantics everywhere.
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch { throw new InputRecipeError() }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new InputRecipeError()
  if (value.format !== 'mirofish-project-input-recipe' || value.version !== 1
    || value.source_kind !== 'saved_extracted_text') throw new InputRecipeError()
  const source = bounded(value.source_text, MAX_RECIPE_SOURCE_BYTES, true)
  const scenario = bounded(value.simulation_requirement, 64 * 1024, true)
  const name = bounded(value.source_project_name, 1024)
  const time = scalar(value.captured_at)
  if (!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(time)) throw new InputRecipeError()
  const date = new Date(time)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== time) throw new InputRecipeError()
  // Never spread/merge the parsed object, and never retain unvalidated fields.
  return Object.freeze({ format: 'mirofish-project-input-recipe', version: 1,
    source_kind: 'saved_extracted_text', source_text: source,
    simulation_requirement: scenario, source_project_name: name, captured_at: time })
}

export async function parseInputRecipeFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0) throw new InputRecipeError()
  if (file.size > MAX_RECIPE_BYTES) throw new InputRecipeError('tooLarge')
  let bytes
  try { bytes = await file.arrayBuffer() } catch { throw new InputRecipeError('readFailed') }
  return parseInputRecipeBytes(bytes)
}

export function inputRecipePreview(recipe) {
  const points = Array.from(recipe.source_text)
  return { sourceBytes: new TextEncoder().encode(recipe.source_text).byteLength,
    sourceCodePoints: points.length, excerpt: points.slice(0, 2000).join(''), truncated: points.length > 2000 }
}
