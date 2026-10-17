import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { parseInputRecipeBytes, parseInputRecipeFile, inputRecipePreview, MAX_RECIPE_BYTES } from '../src/utils/projectInputRecipe.js'

const recipe = overrides => ({ format: 'mirofish-project-input-recipe', version: 1, source_kind: 'saved_extracted_text',
  source_text: '\ufeffCafé 雪 😀 e\u0301\r\n<script>literal</script>\x00', simulation_requirement: 'Scenario',
  source_project_name: 'Saved', captured_at: '2026-10-17T12:34:56.789Z', ...overrides })
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const parse = value => parseInputRecipeBytes(encode(value))
const fails = (value, code = 'invalid') => assert.throws(() => parse(value), error => error.code === code)

test('one validated frozen scalar projection preserves Unicode, controls, CRLF and interior BOM', async () => {
  const original = recipe(), result = await parseInputRecipeFile(new File([encode(original)], 'arbitrary.json'))
  assert.deepEqual(result, original); assert.ok(Object.isFrozen(result)); assert.equal(Object.keys(result).length, 7)
  const preview = inputRecipePreview(result)
  assert.equal(preview.sourceBytes, Buffer.byteLength(original.source_text))
  assert.equal(preview.sourceCodePoints, [...original.source_text].length)
  assert.equal(preview.excerpt, original.source_text)
})

for (const value of [null, [], true, 1, 'hello']) test(`reject root ${JSON.stringify(value)}`, () => fails(JSON.stringify(value)))
for (const field of Object.keys(recipe())) test(`reject missing ${field}`, () => {
  const value = recipe(); delete value[field]; fails(value)
})
for (const key of ['project_id', 'graph_id', 'ontology', '__proto__', 'constructor']) test(`reject unknown ${key}`, () => {
  fails(JSON.stringify(recipe()).replace(/}$/, `,${JSON.stringify(key)}:null}`))
})
for (const field of ['source_text', 'simulation_requirement', 'source_project_name', 'captured_at']) test(`strict scalar ${field}`, () => {
  for (const value of [null, true, 3, [], {}, '\ud800', '\udfff', 'x\ud800y']) fails(recipe({ [field]: value }))
})
test('exact identifiers and numeric version, including duplicate-key last-value-wins', () => {
  for (const value of [true, '1', 0, 2, null]) fails(recipe({ version: value }))
  fails(recipe({ format: 'other' })); fails(recipe({ source_kind: 'original_files' }))
  const raw = JSON.stringify(recipe())
  assert.equal(parse(raw.replace('"version":1', '"version":false,"version":1')).version, 1)
  fails(raw.replace('"version":1', '"version":1,"version":false'))
  assert.equal(parse(raw.replace('"source_kind":"saved_extracted_text"', '"source_kind":"wrong","source_kind":"saved_extracted_text"')).source_kind, 'saved_extracted_text')
  fails(raw.replace('"source_kind":"saved_extracted_text"', '"source_kind":"saved_extracted_text","source_kind":"wrong"'))
  assert.equal(parse(raw.replace('"source_text":', '"source_text":"discarded","source_text":')).source_text, recipe().source_text)
  assert.equal(parse(raw.replace(/}$/, ',"source_text":"last"}')).source_text, 'last')
})
test('exact shared blank grammar, with ZWSP remaining content', () => {
  const blank = '\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
  for (const field of ['source_text', 'simulation_requirement']) {
    fails(recipe({ [field]: '' })); fails(recipe({ [field]: blank }))
    assert.equal(parse(recipe({ [field]: blank + '\u200b' }))[field], blank + '\u200b')
  }
  assert.equal(parse(recipe({ source_project_name: '' })).source_project_name, '')
})
for (const [field, limit] of [['source_text', 1048576], ['simulation_requirement', 65536], ['source_project_name', 1024]]) {
  test(`inclusive UTF-8 byte cap ${field}`, () => {
    for (const char of ['a', 'é', '😀']) {
      const value = char.repeat(limit / Buffer.byteLength(char))
      assert.equal(parse(recipe({ [field]: value }))[field], value)
      fails(recipe({ [field]: value + 'a' }), 'tooLarge')
    }
  })
}
test('inclusive encoded envelope cap and escaped JSON expansion', async () => {
  const raw = JSON.stringify(recipe()), padding = ' '.repeat(MAX_RECIPE_BYTES - Buffer.byteLength(raw))
  assert.deepEqual(parse(padding + raw), recipe()); fails(padding + ' ' + raw, 'tooLarge')
  fails(recipe({ source_text: '\x00'.repeat(400000) }), 'tooLarge')
  let read = false
  await assert.rejects(parseInputRecipeFile({ size: MAX_RECIPE_BYTES + 1, arrayBuffer() { read = true } }), error => error.code === 'tooLarge')
  assert.equal(read, false)
  await assert.rejects(parseInputRecipeFile({ size: 1, arrayBuffer: async () => encode(padding + ' ' + raw) }), error => error.code === 'tooLarge')
})
test('fatal UTF-8, envelope BOM and malformed JSON are rejected', async () => {
  for (const bytes of [[0xc3, 0x28], [0xed, 0xa0, 0x80], [0xff], [0xef, 0xbb, 0xbf, ...encode(recipe())]]) {
    assert.throws(() => parseInputRecipeBytes(new Uint8Array(bytes)), error => error.code === 'invalid')
  }
  for (const raw of ['{', '{"format":NaN}', JSON.stringify(recipe()).replace(/}$/, ',}')]) fails(raw)
  await assert.rejects(parseInputRecipeFile({ size: 1, arrayBuffer: async () => { throw new Error('private') } }), error => error.code === 'readFailed' && !error.message.includes('private'))
})
test('calendar-valid canonical UTC timestamp years 0001 through 9999', () => {
  for (const value of ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '2024-02-29T00:00:00.000Z']) assert.equal(parse(recipe({ captured_at: value })).captured_at, value)
  for (const value of ['0000-01-01T00:00:00.000Z', '2025-02-29T00:00:00.000Z', '2026-04-31T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01T00:00:60.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00']) fails(recipe({ captured_at: value }))
})
test('excerpt ends at 2000 code points without splitting astral pairs', () => {
  const preview = inputRecipePreview(parse(recipe({ source_text: '😀'.repeat(2001) })))
  assert.equal(preview.excerpt, '😀'.repeat(2000)); assert.equal(preview.sourceCodePoints, 2001)
  assert.equal(preview.sourceBytes, 8004); assert.equal(preview.truncated, true)
})
