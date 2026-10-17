import assert from 'node:assert/strict'
import test from 'node:test'
import { readSavedActivityFile } from '../src/utils/savedActivityFiles.js'
import { bytes, deferred, envelope, revision, simulationId, transport, response, validation } from './helpers/saved-actions-export-fixture.mjs'

const valid = data => validation.validateSavedActionsExport(bytes(data), simulationId, revision)
const invalid = data => assert.throws(() => valid(data), error => error.exportCode === 'invalid_response')
const rejects = (promise, code) => assert.rejects(promise, error => error.exportCode === code)

test('validator accepts more than one page and preserves exact identifiers and opaque details', () => {
  const data = envelope(101), admitted = valid(data)
  assert.equal(admitted.actions.length, 101)
  assert.equal(admitted.actions[0].agent_id, '9007199254740993')
  assert.equal(admitted.actions[0].details_json, data.actions[0].details_json)
})

test('validator admits empty legacy and modern observations with explicit optional coverage', () => {
  valid(envelope(0))
  const data = envelope(0); data.sources = ['legacy']; data.platform_coverage.twitter.source = 'legacy'; valid(data)
})

test('validator admits disabled-but-covered source and required partial status notices', () => {
  const data = envelope(); data.platform_coverage.twitter.enabled = false; data.context.status = 'stopped'; data.warnings = [{ code: 'partial_run' }, { code: 'platform_not_configured', platform: 'twitter' }, { code: 'config_unavailable' }, { code: 'run_state_unavailable' }]; valid(data)
})

for (const [name, change] of [
  ['format', data => { data.format = 'page' }], ['version', data => { data.version = 2 }],
  ['simulation', data => { data.simulation_id = 'other' }], ['revision', data => { data.source_revision = 'b'.repeat(64) }],
  ['scope', data => { data.scope = 'page' }], ['order', data => { data.order = 'timestamp' }], ['truncation', data => { data.truncated = true }],
  ['count mismatch', data => { data.record_count = 0 }], ['record cap', data => { data.record_count = 50001 }],
  ['active state', data => { data.context.status = 'running' }], ['partial overall availability', data => { data.availability = 'partial' }],
  ['uncovered required platform', data => { data.platform_coverage.reddit.enabled = true }],
  ['unknown optional platform', data => { data.platform_coverage.reddit.enabled = null }],
  ['coverage count', data => { data.platform_coverage.twitter.recorded_actions = 2 }],
  ['source not selected', data => { data.sources = ['reddit'] }], ['mixed legacy sources', data => { data.sources = ['twitter', 'legacy'] }],
  ['blocking warning', data => { data.warnings = [{ code: 'invalid_records', count: 1 }] }],
  ['unknown warning', data => { data.warnings = [{ code: 'future' }] }],
  ['missing partial notice', data => { data.context.status = 'failed' }],
  ['missing disabled notice', data => { data.platform_coverage.twitter.enabled = false }],
  ['unexpected outer field', data => { data.filters = {} }], ['preview field', data => { data.actions[0].match_preview = null }],
  ['number identifier', data => { data.actions[0].agent_id = 9007199254740992 }],
  ['record id newline', data => { data.actions[0].record_id += '\n' }],
  ['duplicate record identity', data => { data.actions.push({ ...data.actions[0] }); data.record_count++; data.platform_coverage.twitter.recorded_actions++ }],
]) test(`validator rejects ${name}`, () => { const data = envelope(); change(data); invalid(data) })

for (const [name, make] of [
  ['duplicate key', source => source.replace('"version":1', '"version":1,"version":1')],
  ['missing newline', source => source.slice(0, -1)],
  ['non-ASCII envelope', source => source.replace('CREATE_POST', 'POST🌱')],
  ['trailing bytes', source => source + '{}'],
  ['excess nesting', source => source.replace('"context":{', '"context":'.concat('['.repeat(10), '{'))],
]) test(`validator rejects ${name} encoding`, () => {
  const buffer = new TextEncoder().encode(make(new TextDecoder().decode(bytes(envelope()))))
  assert.throws(() => validation.validateSavedActionsExport(buffer, simulationId, revision), error => error.exportCode === 'invalid_response')
})

test('streamed transport preserves configured base language credentials and exact bytes without query filters', async () => {
  const data = envelope(101), body = bytes(data), calls = []
  const fetch = async (...args) => { calls.push(args); return response(data, { chunks: [body.slice(0, 13), body.slice(13)] }) }
  const result = await transport(fetch, { defaults: { baseURL: '/proxy/api-root/', withCredentials: true }, language: 'zh' })(simulationId, revision)
  assert.deepEqual(result.bytes, body)
  assert.equal(calls[0][0], `/proxy/api-root/api/simulation/${simulationId}/saved-actions/export?revision=${revision}`)
  assert.equal(calls[0][1].credentials, 'include'); assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[0][1].headers['Accept-Language'], 'zh')
})

test('streamed transport retains same-origin credentials by default', async () => {
  let request
  await transport(async (_url, options) => { request = options; return response(envelope()) })(simulationId, revision)
  assert.equal(request.credentials, 'same-origin')
})

test('transport accepts the exact whole-file byte limit and rejects one more byte without Content-Length', async () => {
  const data = envelope(), cap = validation.SAVED_ACTIONS_MAX_BYTES
  data.actions[0].details_json = ''
  const baseLength = bytes(data).byteLength
  data.actions[0].details_json = 'x'.repeat(cap - baseLength)
  const body = bytes(data); assert.equal(body.byteLength, cap)
  const good = await transport(async () => response(data, { chunks: [body] }))(simulationId, revision)
  assert.equal(good.bytes.byteLength, cap)
  const oversized = response(data, { chunks: [body, new Uint8Array([10])] })
  await rejects(transport(async () => oversized)(simulationId, revision), 'export_too_large')
  assert.ok(oversized.state.cancelled)
})

test('claimed small Content-Length cannot bypass the running ceiling', async () => {
  const body = response(null, { chunks: [new Uint8Array(validation.SAVED_ACTIONS_MAX_BYTES + 1)], headers: { 'Content-Length': '1' } })
  await rejects(transport(async () => body)(simulationId, revision), 'export_too_large'); assert.ok(body.state.cancelled)
})

test('oversized Content-Length is refused before reading', async () => {
  const body = response(null, { headers: { 'Content-Length': String(validation.SAVED_ACTIONS_MAX_BYTES + 1) } })
  await rejects(transport(async () => body)(simulationId, revision), 'export_too_large'); assert.equal(body.state.reads, 0); assert.ok(body.state.cancelled)
})

for (const [status, code] of [[400, 'invalid_revision'], [404, 'simulation_not_found'], [409, 'sources_changed'], [409, 'run_not_terminal'], [413, 'export_too_large'], [422, 'export_incomplete']]) {
  test(`transport maps bounded ${status} ${code} without server text`, async () => {
    const body = response({ success: false, error_code: code, error: '/private/path secret' }, { status })
    await rejects(transport(async () => body)(simulationId, revision), code)
  })
}

test('transport rejects oversized error bodies and never trusts unknown server errors', async () => {
  const oversized = response(null, { status: 500, chunks: [new Uint8Array(validation.SAVED_ACTIONS_ERROR_MAX_BYTES + 1)] })
  await rejects(transport(async () => oversized)(simulationId, revision), 'invalid_response'); assert.ok(oversized.state.cancelled)
  await rejects(transport(async () => response({ error_code: '/secret', error: 'secret' }, { status: 500 }))(simulationId, revision), 'generic')
})

for (const [name, make, code] of [
  ['unsupported reader', () => response(null, { noReader: true }), 'unsupported_reader'],
  ['wrong content type', () => response(null, { headers: { 'Content-Type': 'text/html' } }), 'invalid_response'],
  ['invalid UTF-8', () => response(null, { chunks: [new Uint8Array([255, 10])] }), 'invalid_response'],
  ['malformed envelope', () => response({ success: true }), 'invalid_response'],
]) test(`transport rejects ${name}`, async () => { const body = make(); await rejects(transport(async () => body)(simulationId, revision), code); if (!name.startsWith('unsupported')) assert.ok(body.state.cancelled) })

test('cancelled late Fetch response is suppressed and its ignored-abort body is cancelled', async () => {
  const pending = deferred(), controller = new AbortController(), body = response(envelope())
  const result = transport(() => pending.promise)(simulationId, revision, controller.signal)
  controller.abort(); pending.resolve(body)
  await rejects(result, 'cancelled'); assert.equal(body.state.reads, 0); assert.ok(body.state.cancelled)
})

test('ownership retirement after an awaited chunk cancels the reader and suppresses validation', async () => {
  let current = true
  const body = response(null, { read: async () => { current = false; return { value: bytes(envelope()), done: false } } })
  await rejects(transport(async () => body)(simulationId, revision, undefined, () => current), 'cancelled')
  assert.ok(body.state.cancelled)
})

test('transport timeout remains safe when Fetch rejects after abort', async () => {
  let timeoutCallback
  const get = transport((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private error')))), { defaults: { timeout: 1 }, globals: { setTimeout: callback => { timeoutCallback = callback; return 0 }, clearTimeout() {} } })
  const pending = get(simulationId, revision); timeoutCallback(); await rejects(pending, 'timeout')
})

test('ordinary page importer intentionally rejects the distinct all-actions format', async () => {
  const buffer = bytes(envelope())
  await assert.rejects(readSavedActivityFile({ size: buffer.byteLength, arrayBuffer: async () => buffer.buffer }), /Invalid or unsupported saved activity file/)
})
