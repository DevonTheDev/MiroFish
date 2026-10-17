import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REPORT_CONVERSATION_TEXT_MAX_BYTES, formatReportConversationText } from '../src/utils/reportConversationText.js'

// Golden prefix and explicit field expectations come from the reviewed format,
// independently of the formatter. All input objects are kept unchanged.
const prefix = readFileSync(new URL('./fixtures/report-conversation-prefix.txt', import.meta.url), 'utf8')
const capturedAt = '2026-10-17T12:00:00.000Z'
const message = (content = 'Question', role = 'user', timestamp = 'stored timestamp') => ({ role, timestamp, content })
const capture = (messages = [message()], extra = {}) => ({ reportId: 'report_A', simulationId: 'sim_A', capturedAt, messages, ...extra })
const header = count => prefix + 'report_id:\n  report_A\nsimulation_id:\n  sim_A\ncaptured_at:\n  ' + capturedAt + '\nmessage_count: ' + count + '\n'
const bytes = text => new TextEncoder().encode(text).byteLength

test('exact grammar preserves all fields, stored timestamp strings and final LF without mutation', () => {
  const input = capture([message('Question **literal**\nsecond line'), message('Error occurred: offline', 'assistant', '')])
  const original = structuredClone(input)
  const expected = header(2) + '\nMessage 1\nrole: user\ntimestamp:\n  stored timestamp\ncontent:\n  Question **literal**\n  second line\n'
    + '\nMessage 2\nrole: assistant\ntimestamp:\n[empty string]\ncontent:\n  Error occurred: offline\n'
  assert.deepEqual(formatReportConversationText(input), { ok: true, text: expected })
  assert.deepEqual(input, original)
  assert.equal(REPORT_CONVERSATION_TEXT_MAX_BYTES, 1048576)
})

test('fourteen ordered turns retain repetitions and failure text but never read extra fields', () => {
  const messages = Array.from({ length: 14 }, (_, i) => Object.freeze({ ...message(i === 13 ? 'Error: offline' : 'repeat', i % 2 ? 'assistant' : 'user'),
    get tool_calls() { throw new Error('hidden metadata was read') }, get platformReplies() { throw new Error('other target was read') } }))
  const input = Object.freeze(capture(Object.freeze(messages)))
  const result = formatReportConversationText(input)
  assert.equal(result.ok, true)
  assert.equal((result.text.match(/^Message \d+$/gm) || []).length, 14)
  assert.equal((result.text.match(/^  repeat$/gm) || []).length, 13)
  assert.ok(result.text.endsWith('content:\n  Error: offline\n'))
  assert.ok(!result.text.includes('tool_calls'))
})

test('visible string convention preserves Unicode, Markdown, whitespace and every LF', () => {
  const content = '  雪😀 **bold** <b>literal</b>\n\n[empty string]\r\n\t\\\u0000\u202e\u2028\u2029\ud800\n'
  const expectedContent = '  ' + '  雪😀 **bold** <b>literal</b>\n  \n  [empty string]\\r\n  \\t\\\\\\u0000\\u202e\\u2028\\u2029\\ud800\n  ' + '\n'
  const result = formatReportConversationText(capture([message(content)]))
  assert.equal(result.ok, true)
  assert.equal(result.text, header(1) + '\nMessage 1\nrole: user\ntimestamp:\n  stored timestamp\ncontent:\n' + expectedContent)
  const empty = formatReportConversationText(capture([message('')]))
  assert.ok(empty.text.endsWith('content:\n[empty string]\n'))
  const literal = formatReportConversationText(capture([message('[empty string]')]))
  assert.ok(literal.text.endsWith('content:\n  [empty string]\n'))
})

test('astral format controls use UTF-16 escapes while ordinary astral characters remain intact', () => {
  const result = formatReportConversationText(capture([message('😀\u{e0001}')])); assert.equal(result.ok, true)
  assert.ok(result.text.endsWith('content:\n  😀\\udb40\\udc01\n'))
})

test('invalid shapes refuse atomically without coercing values', () => {
  let coercions = 0
  const object = { toString() { coercions++; return 'coerced' } }
  for (const input of [null, {}, capture([], {}), capture(null), capture([message()], { reportId: '' }),
    capture([message()], { simulationId: undefined }), capture([message()], { capturedAt: null }),
    capture([message(object)]), capture([{ role: 'user', content: 'missing timestamp' }]),
    capture([message('text', 'system')]), capture([message(), message('text', 'assistant', null)])]) {
    assert.deepEqual(formatReportConversationText(input), { ok: false, code: 'invalid' })
  }
  assert.equal(coercions, 0)
})

for (const [name, unit] of [['ASCII', 'a'], ['Chinese', '雪'], ['emoji', '😀'], ['escaped backslash', '\\']]) {
  test(`${name} complete-output boundary accepts exactly one MiB and refuses one byte more`, () => {
    const fixed = header(1) + '\nMessage 1\nrole: user\ntimestamp:\n  stored timestamp\ncontent:\n  \n'
    const remaining = REPORT_CONVERSATION_TEXT_MAX_BYTES - bytes(fixed)
    const unitBytes = unit === '\\' ? 2 : bytes(unit)
    const content = unit.repeat(Math.floor(remaining / unitBytes)) + 'a'.repeat(remaining % unitBytes)
    const result = formatReportConversationText(capture([message(content)]))
    assert.equal(result.ok, true); assert.equal(bytes(result.text), REPORT_CONVERSATION_TEXT_MAX_BYTES)
    assert.deepEqual(formatReportConversationText(capture([message(content + 'a')])), { ok: false, code: 'too_large' })
  })
}

test('oversized metadata and later rows return no prefix or shortened transcript', () => {
  const huge = 'a'.repeat(REPORT_CONVERSATION_TEXT_MAX_BYTES + 1)
  for (const input of [capture([message()], { reportId: huge }), capture([message('first'), message(huge, 'assistant')])]) {
    assert.deepEqual(formatReportConversationText(input), { ok: false, code: 'too_large' })
  }
})
