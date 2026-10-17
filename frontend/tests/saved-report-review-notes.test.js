import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, webcrypto } from 'node:crypto'
import { parseBoundedJson } from '../src/utils/boundedJson.js'
import { createSavedReportFile, SAVED_REPORT_FILE_MAX_BYTES } from '../src/utils/savedReportFiles.js'
import { REPORT_OBSERVATION_KEYS, validSavedReportObservation } from '../src/utils/savedReportObservation.js'
import { indexReportHeadings } from '../src/utils/savedReportHeadings.js'
import {
  REVIEW_NOTES_LIMITS, projectReviewSource, digestReviewSource,
  readReviewNotesFile, createReviewNotesFile, validateReviewNote,
  boundReviewDraft, validReviewFilename, displayReviewMetadata,
} from '../src/utils/savedReportReviewNotes.js'

// Finite source-only test plan: exactly eight top-level pure-contract groups,
// no fuzzing, retries, app imports, network, model calls or browser dependencies.
// Largest body fixture: 8 MiB + 1 byte. Largest metadata fixture: 16 MiB + 256
// ASCII characters, rejected by unchanged observation export admission.
// Other ceilings: 33 notes; 2,001 points/note; 524,289 file bytes; 257 parser
// values; depth 5; 201 headings; 513 filename points; 161 metadata points.
// Every loop below is a fixed case table or one of these exact boundary counts.
// AUTHORIZATION STATUS: authored only; no test/import/build has been executed.

const host = { crypto: webcrypto }
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const observation = (text = '# First\r\nA\n## Second\nB', overrides = {}) => ({
  report_id: 'report_A', simulation_id: 'sim_A', title: 'Captured report',
  summary_preview: '', requirement_preview: '', status: 'completed',
  created_at: null, completed_at: null, source: 'modern',
  metadata_revision: 'a'.repeat(64), observed_at: '2026-10-17T12:00:00Z',
  content_available: true, content_source: 'full_report.md', markdown_content: text,
  content_bytes: Buffer.byteLength(text), content_revision: 'b'.repeat(64), content_error: null,
  ...overrides,
})
const bindingFor = source => Object.freeze({ report_id: source.report_id,
  text_sha256: hash(source.markdown_content), text_bytes: Buffer.byteLength(source.markdown_content) })
const headingsFor = source => Object.freeze(indexReportHeadings(source.markdown_content).headings.map(Object.freeze))
const general = text => ({ heading_start: null, text })
const file = (text, overrides = {}) => {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text)
  return { name: 'review.notes.json', size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...overrides }
}
const parseInvalid = () => { throw new Error('Rejected bounded JSON') }
const bounded = text => parseBoundedJson(text, 524288, 4, parseInvalid, true, 256)
const rejected = (text, binding, headings) => assert.rejects(readReviewNotesFile(file(text), binding, headings))
const valuesIn = value => value && typeof value === 'object'
  ? 1 + Object.values(value).reduce((sum, child) => sum + valuesIn(child), 0) : 1

test('pure contract 1: empty/general/heading note round-trip', async () => {
  const source = projectReviewSource(observation()), binding = await digestReviewSource(source, () => true, host)
  const headings = headingsFor(source)
  assert.deepEqual(binding, bindingFor(source))
  assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(source))
  const cases = [[], [general('  Review\r\nthis\rquestion\n  ')], [
    { heading_start: headings[0].lineStart, text: 'First question' },
    general('A general question'),
    { heading_start: headings[1].lineStart, text: 'Second question' },
    { heading_start: headings[0].lineStart, text: 'First question' },
    general('A general question'),
  ]]
  for (const notes of cases) {
    const serialized = createReviewNotesFile(binding, notes, headings)
    const expected = { format: 'mirofish-report-review-notes', version: 1, source: binding, notes }
    assert.equal(serialized, JSON.stringify(expected) + '\n')
    assert.equal(createReviewNotesFile(binding, notes, headings), serialized)
    const admitted = await readReviewNotesFile(file(serialized), binding, headings)
    assert.deepEqual(admitted, expected)
    assert.deepEqual(Object.keys(admitted), ['format', 'version', 'source', 'notes'])
    assert.deepEqual(Object.keys(admitted.source), ['report_id', 'text_sha256', 'text_bytes'])
    assert.ok(Object.isFrozen(admitted)); assert.ok(Object.isFrozen(admitted.source))
    assert.ok(Object.isFrozen(admitted.notes)); assert.ok(admitted.notes.every(Object.isFrozen))
    assert.notEqual(admitted.source, binding); assert.notEqual(admitted.notes, notes)
    for (const note of admitted.notes) assert.deepEqual(Object.keys(note), ['heading_start', 'text'])
    assert.equal(createReviewNotesFile(admitted.source, admitted.notes, headings), serialized)
  }
  const editable = general('Original'), serialized = createReviewNotesFile(binding, [editable], headings)
  editable.text = 'Later mutation'
  assert.equal((await readReviewNotesFile(file(serialized), binding, headings)).notes[0].text, 'Original')
})

test('pure contract 2: exact 32/33 notes and 2,000/2,001-code-point limits including astral characters', async () => {
  const source = observation(''), binding = bindingFor(source), headings = headingsFor(source)
  for (const character of ['a', '😀']) {
    const maximum = character.repeat(2000), excess = character.repeat(2001)
    const notes = Array.from({ length: 32 }, () => general(maximum))
    const serialized = createReviewNotesFile(binding, notes, headings)
    assert.deepEqual((await readReviewNotesFile(file(serialized), binding, headings)).notes, notes)
    assert.equal(notes.reduce((sum, note) => sum + [...note.text].length, 0), 64000)
    assert.ok(notes.reduce((sum, note) => sum + Buffer.byteLength(note.text), 0) <= 256000)
    assert.equal(boundReviewDraft(maximum), maximum)
    assert.throws(() => boundReviewDraft(excess))
    assert.throws(() => validateReviewNote(general(excess), headings))
    assert.throws(() => createReviewNotesFile(binding, [general(excess)], headings))
    const tooLong = JSON.parse(serialized); tooLong.notes[0].text = excess
    await rejected(JSON.stringify(tooLong), binding, headings)
    assert.throws(() => createReviewNotesFile(binding, [...notes, general('33')], headings))
    const tooMany = JSON.parse(serialized); tooMany.notes.push(general('33'))
    await rejected(JSON.stringify(tooMany), binding, headings)
  }
  for (const blank of ['', ' \t\r\n', '\u0085\u00a0\u2000\u2028\u2029\u3000\ufeff']) {
    assert.equal(boundReviewDraft(blank), blank)
    assert.throws(() => validateReviewNote(general(blank), headings))
  }
  assert.equal(validateReviewNote(general('\u200b'), headings).text, '\u200b')
  const escapedMaximum = Array.from({ length: 32 }, () => general('\0'.repeat(2000)))
  const escapedFile = createReviewNotesFile(binding, escapedMaximum, headings)
  assert.ok(Buffer.byteLength(escapedFile) <= 524288)
  assert.deepEqual((await readReviewNotesFile(file(escapedFile), binding, headings)).notes, escapedMaximum)
  assert.throws(() => createReviewNotesFile(binding, Array(1), headings))
  for (const bad of [null, 3, {}, '\ud800', '\udfff']) assert.throws(() => boundReviewDraft(bad))
  assert.equal(REVIEW_NOTES_LIMITS.notes, 32); assert.equal(REVIEW_NOTES_LIMITS.notePoints, 2000)
})

test('pure contract 3: exact 512 KiB file boundary and JSON depth/value caps', async () => {
  const source = observation('x'), binding = bindingFor(source), headings = headingsFor(source)
  const serialized = createReviewNotesFile(binding, [], headings)
  const boundary = serialized + ' '.repeat(524288 - Buffer.byteLength(serialized))
  assert.equal(Buffer.byteLength(boundary), 524288)
  assert.deepEqual((await readReviewNotesFile(file(boundary), binding, headings)).notes, [])
  await rejected(boundary + ' ', binding, headings)
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 524289]) {
    let reads = 0
    await assert.rejects(readReviewNotesFile(file(serialized, { size, arrayBuffer: async () => { reads++; return new ArrayBuffer(0) } }), binding, headings))
    assert.equal(reads, 0)
  }
  for (const size of [Buffer.byteLength(serialized) - 1, Buffer.byteLength(serialized) + 1]) {
    await assert.rejects(readReviewNotesFile(file(serialized, { size }), binding, headings))
  }
  for (const result of [new Uint8Array(1), null, { byteLength: 1 }]) {
    await assert.rejects(readReviewNotesFile(file(serialized, { size: 1, arrayBuffer: async () => result }), binding, headings))
  }
  const shadowed = new ArrayBuffer(1)
  Object.defineProperty(shadowed, 'byteLength', { value: Buffer.byteLength(serialized) })
  await assert.rejects(readReviewNotesFile(file(serialized, { arrayBuffer: async () => shadowed }), binding, headings))
  await assert.rejects(readReviewNotesFile(file(serialized, { arrayBuffer: async () => { throw new Error('Read failed') } }), binding, headings))
  await assert.rejects(readReviewNotesFile({ get size() { throw new Error('Size failed') } }, binding, headings))
  await assert.rejects(readReviewNotesFile(file(serialized, { arrayBuffer: null }), binding, headings))
  const full = createReviewNotesFile(binding, Array.from({ length: 32 }, () => general('x')), headings)
  assert.equal(valuesIn(JSON.parse(full)), 104)
  assert.equal(bounded(full).notes.length, 32)
  assert.equal(bounded(JSON.stringify(Array(255).fill(0))).length, 255)
  assert.throws(() => bounded(JSON.stringify(Array(256).fill(0))))
  assert.deepEqual(bounded('[[[[0]]]]'), [[[[0]]]])
  assert.throws(() => bounded('[[[[[0]]]]]'))
  // Valid parser boundaries still cannot evade the notes envelope schema.
  await rejected(JSON.stringify(Array(255).fill(0)), binding, headings)
  await rejected('[[[[0]]]]', binding, headings)
  assert.equal(REVIEW_NOTES_LIMITS.fileBytes, 524288)
  assert.equal(REVIEW_NOTES_LIMITS.depth, 4); assert.equal(REVIEW_NOTES_LIMITS.values, 256)
})

test('pure contract 4: malformed UTF-8/BOM/duplicate/unknown fields/unpaired surrogates', async () => {
  const source = observation('# A'), binding = bindingFor(source), headings = headingsFor(source)
  const serialized = createReviewNotesFile(binding, [{ heading_start: 0, text: 'literal' }], headings)
  await rejected(Uint8Array.from([0xc3, 0x28]), binding, headings)
  await rejected('\ufeff' + serialized, binding, headings)
  const alias = serialized.replace('"text":', '"\\u0074ext":')
  assert.equal((await readReviewNotesFile(file(alias), binding, headings)).notes[0].text, 'literal')
  const badTexts = [
    serialized.replace('"text":"literal"', '"text":"literal","text":"again"'),
    serialized.replace('"text":"literal"', '"text":"literal","\\u0074ext":"again"'),
    serialized.replace('"version":1', '"version":1,"version":1'),
    serialized.replace('"text":"literal"', '"text":"\\ud800"'),
    serialized.replace('"text":"literal"', '"text":"\\udfff"'),
    serialized.replace('"text":"literal"', '"text":"literal","\\ud800":1'),
    serialized.replace('"text_bytes":3', '"text_bytes":1e400'),
    serialized.replace('"text_bytes":3', '"text_bytes":-0'),
    serialized.replace('"heading_start":0', '"heading_start":-0'),
    serialized.trimEnd() + ' trailing', '{', '',
  ]
  for (const text of badTexts) await rejected(text, binding, headings)
  const mutations = [
    data => { data.extra = true }, data => { data.source.extra = true },
    data => { data.notes[0].extra = true }, data => { delete data.notes[0].text },
    data => { delete data.source.text_bytes }, data => { data.version = 2 },
    data => { data.version = '1' }, data => { data.format = 'mirofish-saved-report-observation' },
    data => { data.notes = {} }, data => { data.notes = [null] },
    data => { data.notes[0].text = 1 }, data => { data.source.report_id = '../report_A' },
    data => { data.source.report_id = 'a'.repeat(129) }, data => { data.source.text_sha256 = 'A'.repeat(64) },
    data => { data.source.text_sha256 = 'a'.repeat(63) }, data => { data.source.text_bytes = 8388609 },
    data => { data.source.text_bytes = 1.5 }, data => { data.source.text_bytes = -1 },
  ]
  for (const mutate of mutations) {
    const data = JSON.parse(serialized); mutate(data)
    await rejected(JSON.stringify(data), binding, headings)
  }
  const numericSpellings = serialized.replace('"version":1', '"version":1.0')
    .replace('"heading_start":0', '"heading_start":0e0').replace('"text_bytes":3', '"text_bytes":3e0')
  assert.equal((await readReviewNotesFile(file(numericSpellings), binding, headings)).notes[0].heading_start, 0)
  const zeroBinding = { ...binding, text_bytes: -0 }
  assert.throws(() => createReviewNotesFile(zeroBinding, [], headings))
  assert.throws(() => validateReviewNote({ ...general('x'), [Symbol('extra')]: true }, headings))
})

test('pure contract 5: same-ID changed body and changed line endings rejected, same bytes with a different observation timestamp accepted', async () => {
  const original = projectReviewSource(observation('\ufeff# A\r\n雪😀\rB\n'))
  const binding = await digestReviewSource(original, () => true, host), headings = headingsFor(original)
  assert.deepEqual(binding, bindingFor(original))
  const serialized = createReviewNotesFile(binding, [general('Keep exact source bytes')], headings)
  const sameBytes = projectReviewSource({ ...original, observed_at: 'Later copied observation time',
    title: 'Different metadata', metadata_revision: 'c'.repeat(64), simulation_id: 'different_sim' })
  const sameBinding = await digestReviewSource(sameBytes, () => true, host)
  assert.deepEqual(sameBinding, binding)
  assert.equal((await readReviewNotesFile(file(serialized), sameBinding, headingsFor(sameBytes))).notes.length, 1)
  const changes = [
    observation(original.markdown_content + '!'),
    observation(original.markdown_content.replaceAll('\r\n', '\n')),
    observation(original.markdown_content.replaceAll('\r', '\n')),
    observation(original.markdown_content.slice(1)),
    observation(original.markdown_content, { report_id: 'report_B' }),
  ]
  for (const changed of changes) {
    const snapshot = projectReviewSource(changed), other = await digestReviewSource(snapshot, () => true, host)
    assert.notDeepEqual(other, binding)
    await assert.rejects(readReviewNotesFile(file(serialized), other, headingsFor(snapshot)))
  }
  const mutable = observation('old\r\n'), detached = projectReviewSource(mutable)
  mutable.markdown_content = 'new'; mutable.report_id = 'report_B'; mutable.observed_at = 'later'
  assert.equal(detached.markdown_content, 'old\r\n'); assert.equal(detached.report_id, 'report_A')
  assert.deepEqual(await digestReviewSource(detached, () => true, host), bindingFor(detached))
  assert.throws(() => projectReviewSource(observation('snow 雪', { content_bytes: 6 })))
  assert.deepEqual(Buffer.from(original.markdown_content), Buffer.from('\ufeff# A\r\n雪😀\rB\n'))
})

test('pure contract 6: misleading copied content-revision strings cannot substitute for a computed digest', async () => {
  const source = projectReviewSource(observation('authentic bytes', { content_revision: '0'.repeat(64) }))
  const binding = await digestReviewSource(source, () => true, host), headings = headingsFor(source)
  assert.equal(binding.text_sha256, hash('authentic bytes'))
  assert.notEqual(binding.text_sha256, source.content_revision)
  const forged = createReviewNotesFile({ ...binding, text_sha256: source.content_revision }, [general('Forged binding')], headings)
  await rejected(forged, binding, headings)
  const changed = projectReviewSource(observation('different bytes', { content_revision: binding.text_sha256 }))
  assert.notEqual((await digestReviewSource(changed, () => true, host)).text_sha256, binding.text_sha256)
  const brokenHosts = [
    {}, { crypto: null }, { crypto: {} }, { crypto: { subtle: {} } },
    { crypto: { subtle: { digest: 1 } } },
    { get crypto() { throw new Error('crypto getter') } },
    { crypto: { get subtle() { throw new Error('subtle getter') } } },
    { crypto: { subtle: { get digest() { throw new Error('digest getter') } } } },
    { crypto: { subtle: { digest() { throw new Error('digest call') } } } },
    { crypto: { subtle: { digest: async () => { throw new Error('digest rejection') } } } },
  ]
  for (const broken of brokenHosts) await assert.rejects(digestReviewSource(source, () => true, broken))
  for (const result of [new ArrayBuffer(31), new ArrayBuffer(33), new Uint8Array(32), { byteLength: 32 }, null]) {
    await assert.rejects(digestReviewSource(source, () => true, { crypto: { subtle: { digest: async () => result } } }))
  }
  const shadowed = new ArrayBuffer(31)
  Object.defineProperty(shadowed, 'byteLength', { value: 32 })
  await assert.rejects(digestReviewSource(source, () => true, { crypto: { subtle: { digest: async () => shadowed } } }))
  for (const boundary of ['crypto', 'subtle', 'digest']) {
    let live = true, calls = 0
    const subtle = { digest() { calls++; return Promise.resolve(new ArrayBuffer(32)) } }
    const crypto = { subtle }, candidate = { crypto }
    const target = boundary === 'crypto' ? candidate : boundary === 'subtle' ? crypto : subtle
    const value = target[boundary]
    Object.defineProperty(target, boundary, { get() { live = false; return value } })
    await assert.rejects(digestReviewSource(source, () => live, candidate), /no longer current/)
    assert.equal(calls, 0)
  }
  let live = true, settle
  const pending = digestReviewSource(source, () => live, { crypto: { subtle: {
    digest() { live = false; return new Promise(resolve => { settle = resolve }) },
  } } })
  live = true; settle(new ArrayBuffer(32))
  await assert.rejects(pending, /no longer current/)
  // The owner's permanent token records changes while asynchronous work waits.
  let retired = false, complete
  const owned = digestReviewSource(source, () => !retired, { crypto: { subtle: {
    digest: () => new Promise(resolve => { complete = resolve }),
  } } })
  retired = true; complete(new ArrayBuffer(32))
  await assert.rejects(owned, /no longer current/)
  await assert.rejects(digestReviewSource(source, () => { throw new Error('Owner getter') }, host), /no longer current/)
  await assert.rejects(digestReviewSource(source, () => false, host), /no longer current/)
  assert.equal(source.content_revision, '0'.repeat(64))
})

test('pure contract 7: missing/fractional/negative/non-heading offsets rejected, duplicate heading titles distinguished', async () => {
  const source = projectReviewSource(observation('😀\r\n  # Repeated\ntext\r\n# Repeated\n'))
  const headings = headingsFor(source), binding = bindingFor(source)
  assert.equal(headings.length, 2); assert.equal(headings[0].label, headings[1].label)
  assert.notEqual(headings[0].lineStart, headings[1].lineStart)
  assert.equal(headings[0].lineStart, 4); assert.equal(headings[0].markerStart, 6)
  const notes = headings.map((heading, index) => ({ heading_start: heading.lineStart, text: `Question ${index + 1}` }))
  assert.deepEqual((await readReviewNotesFile(file(createReviewNotesFile(binding, notes, headings)), binding, headings)).notes, notes)
  for (const offset of [undefined, -1, -0, 1.5, 0, headings[0].markerStart, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '4']) {
    assert.throws(() => validateReviewNote({ heading_start: offset, text: 'Question' }, headings))
    const encoded = JSON.stringify({ format: 'mirofish-report-review-notes', version: 1,
      source: binding, notes: [{ heading_start: offset, text: 'Question' }] })
    // NaN/Infinity stringify to the valid general-note anchor null; inject the
    // invalid numeric lexeme rather than testing JSON.stringify's conversion.
    if (Number.isNaN(offset) || offset === Infinity) {
      await rejected(encoded.replace('"heading_start":null', '"heading_start":1e400'), binding, headings)
    } else if (Object.is(offset, -0)) {
      await rejected(encoded.replace('"heading_start":0', '"heading_start":-0'), binding, headings)
    } else await rejected(encoded, binding, headings)
  }
  const many = projectReviewSource(observation(Array.from({ length: 201 }, (_, i) => `# H${i}\n`).join('')))
  const indexed = indexReportHeadings(many.markdown_content), admittedHeadings = Object.freeze(indexed.headings.map(Object.freeze))
  assert.equal(admittedHeadings.length, 200); assert.equal(indexed.more, true)
  const excluded = many.markdown_content.indexOf('# H200\n')
  assert.throws(() => validateReviewNote({ heading_start: excluded, text: 'Outside index' }, admittedHeadings))
  assert.equal(validateReviewNote({ heading_start: admittedHeadings[199].lineStart, text: 'Inside index' }, admittedHeadings).text, 'Inside index')
  assert.equal(validateReviewNote(general('General note'), []).heading_start, null)
})

test('pure contract 8: blank/empty/unavailable/non-completed source behavior and literal hostile text', async () => {
  for (const body of ['', ' \t\r\n', '\ufeff', '<script>alert(1)</script>\r\n<img src="https://invalid.test/pixel">\r雪😀\n']) {
    const source = projectReviewSource(observation(body)), binding = await digestReviewSource(source, () => true, host)
    assert.equal(source.markdown_content, body); assert.deepEqual(binding, bindingFor(source))
    const before = createSavedReportFile(source), headings = headingsFor(source)
    const note = general('  <img src="https://invalid.test/note">\r\n[link](javascript:alert(1))\ufeff  ')
    const serialized = createReviewNotesFile(binding, [note], headings)
    const reopened = await readReviewNotesFile(file(serialized), binding, headings)
    assert.equal(reopened.notes[0].text, note.text)
    assert.equal(createSavedReportFile(source), before)
    assert.equal(source.markdown_content, body)
  }
  for (const status of ['pending', 'planning', 'generating', 'failed', 'cancelled', 'unknown']) {
    const source = observation('body', { status })
    assert.equal(validSavedReportObservation(source), true)
    assert.throws(() => projectReviewSource(source))
  }
  for (const content_error of ['not_saved', 'unreadable', 'too_large']) {
    const source = observation('', { content_available: false, markdown_content: null,
      content_bytes: null, content_revision: null, content_source: null, content_error })
    assert.equal(validSavedReportObservation(source), true)
    assert.throws(() => projectReviewSource(source))
  }
  for (const source of [observation('\ud800'), observation('body', { title: '\udfff' }),
    observation('body', { simulation_id: '\ud800' }), observation('body', { observed_at: '\udfff' })]) {
    assert.equal(validSavedReportObservation(source), true, 'live admission remains unchanged')
    assert.throws(() => projectReviewSource(source))
  }
  const hugeMetadata = observation('', { created_at: 'x'.repeat(SAVED_REPORT_FILE_MAX_BYTES) })
  assert.equal(validSavedReportObservation(hugeMetadata), true)
  assert.throws(() => createSavedReportFile(hugeMetadata))
  assert.throws(() => projectReviewSource(hugeMetadata))
  const maximum = observation('x'.repeat(8388608))
  assert.equal(projectReviewSource(maximum).content_bytes, 8388608)
  assert.throws(() => projectReviewSource(observation(maximum.markdown_content + 'x')))
  let extraReads = 0
  const source = observation('body')
  Object.defineProperty(source, 'ignored', { enumerable: true, get() { extraReads++; throw new Error('Do not retain extras') } })
  source.toJSON = () => { throw new Error('Do not invoke response serialization') }
  assert.deepEqual(Object.keys(projectReviewSource(source)), REPORT_OBSERVATION_KEYS)
  assert.equal(extraReads, 0)
  for (const value of ['', 'a'.repeat(160), '😀'.repeat(160)]) assert.equal(displayReviewMetadata(value), value)
  for (const character of ['a', '😀']) {
    assert.equal(displayReviewMetadata(character.repeat(161)), character.repeat(160) + '…')
    assert.equal([...displayReviewMetadata(character.repeat(161))].length, 161)
  }
  assert.equal(displayReviewMetadata(null), '')
  assert.equal(validReviewFilename('😀'.repeat(512)), true)
  assert.equal(validReviewFilename('a'.repeat(512)), true)
  for (const filename of ['😀'.repeat(513), 'a'.repeat(513), '\ud800', null, 3]) assert.equal(validReviewFilename(filename), false)
  assert.equal(validReviewFilename('../<img>.json'), true)
})
