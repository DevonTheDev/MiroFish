import assert from 'node:assert/strict'
import test from 'node:test'
import * as observationModule from '../src/utils/savedReportObservation.js'
import * as fileModule from '../src/utils/savedReportFiles.js'
const keys = ['report_id', 'simulation_id', 'title', 'summary_preview', 'requirement_preview', 'status', 'created_at', 'completed_at', 'source', 'metadata_revision', 'observed_at', 'content_available', 'content_source', 'markdown_content', 'content_bytes', 'content_revision', 'content_error']
const bytes = text => new TextEncoder().encode(text)
const invalid = error => error instanceof Error && error.message === 'Invalid or unsupported saved report file'
const bodyLimit = 8 * 1024 * 1024, apiLimit = 16 * 1024 * 1024, fileLimit = apiLimit + 256
function api() {
  for (const name of ['validSavedReportSummary', 'validSavedReportObservation']) assert.equal(typeof observationModule[name], 'function', `${name} must exist`)
  for (const name of ['createSavedReportFile', 'readSavedReportFile']) assert.equal(typeof fileModule[name], 'function', `${name} must exist`)
  return { ...observationModule, ...fileModule }
}
function report(overrides = {}) {
  return {
    report_id: 'report_A', simulation_id: 'sim_saved', title: 'Saved report',
    summary_preview: '<b>Saved summary</b>', requirement_preview: 'Saved requirement',
    status: 'completed', created_at: '2026-10-01T12:00:00', completed_at: null,
    source: 'modern', metadata_revision: 'b'.repeat(64), observed_at: '2026-10-03T12:00:01Z',
    content_available: true, content_source: 'full_report.md', markdown_content: '# Hi\n',
    content_bytes: 5, content_revision: 'c'.repeat(64), content_error: null, ...overrides,
  }
}
const withBody = (body, overrides = {}) => report({ markdown_content: body, content_bytes: bytes(body).length, ...overrides })
const unavailable = overrides => report({ content_available: false, content_source: null, markdown_content: null, content_bytes: null, content_revision: null, content_error: 'not_saved', ...overrides })
const envelope = observation => ({ format: 'mirofish-saved-report-observation', version: 1, observation })
const file = input => {
  const payload = typeof input === 'string' ? bytes(input) : input
  return { size: payload.byteLength, async arrayBuffer() { return payload.slice().buffer } }
}
const downloaded = observation => file(JSON.stringify(envelope(observation)) + '\n')
async function roundTrip(data) {
  const { createSavedReportFile, readSavedReportFile } = api()
  const actual = await readSavedReportFile(file(createSavedReportFile(data)))
  assert.deepEqual(actual, data)
  return actual
}

test('exposes the canonical seventeen fields and inclusive portable file budget', () => {
  const core = api()
  assert.deepEqual(core.REPORT_OBSERVATION_KEYS, keys)
  assert.equal(Object.isFrozen(core.REPORT_OBSERVATION_KEYS), true)
  assert.equal(core.SAVED_REPORT_FILE_MAX_BYTES, fileLimit)
})

test('shared summary validation preserves live Unicode limits and arbitrary recorded strings', () => {
  const { validSavedReportSummary, validSavedReportObservation } = api()
  for (const status of ['pending', 'planning', 'generating', 'completed', 'failed', 'unknown']) {
    const data = report({ status, title: '😀'.repeat(300), summary_preview: '😀'.repeat(500), requirement_preview: '文'.repeat(500), simulation_id: '../ arbitrary\r\n\u0000', created_at: 'not a date', completed_at: '', observed_at: '\ufeff historical \r\n' })
    assert.equal(validSavedReportSummary(data), true)
    assert.equal(validSavedReportObservation(data), true)
  }
  for (const value of [null, '', '\ud800']) {
    assert.equal(validSavedReportSummary(report({ simulation_id: value, created_at: value, completed_at: value })), true)
  }
  // Live Blob byte accounting replaces isolated UTF-16 surrogates. File
  // admission must reject them without changing this existing live behavior.
  assert.equal(validSavedReportObservation(withBody('\ud800')), true)
  assert.equal(validSavedReportObservation({ ...report(), extra: { ignored: true } }), true)
})

test('shared summary rejects invalid recorded field types, lengths, statuses and sources', () => {
  const { validSavedReportSummary } = api()
  for (const data of [null, false, {}, report({ report_id: '../x' }), report({ report_id: '' }), report({ report_id: 'a'.repeat(129) }), report({ report_id: 'report_A\n' }), report({ simulation_id: 1 }), report({ title: '😀'.repeat(301) }), report({ summary_preview: '😀'.repeat(501) }), report({ requirement_preview: null }), report({ status: 'future-status' }), report({ created_at: 1 }), report({ completed_at: false }), report({ source: 'remote' }), report({ metadata_revision: 'A'.repeat(64) }), report({ metadata_revision: 'b'.repeat(64) + '\n' })]) assert.equal(validSavedReportSummary(data), false)
})

test('shared detail validation retains exact selected report and truthy revision pin checks', () => {
  const { validSavedReportObservation: valid } = api(), data = report()
  assert.equal(valid(data), true)
  assert.equal(valid(data, null), true)
  assert.equal(valid(data, { report_id: data.report_id }), true)
  assert.equal(valid(data, { report_id: data.report_id, metadata_revision: '' }), true)
  assert.equal(valid(data, { report_id: data.report_id, metadata_revision: data.metadata_revision }), true)
  assert.equal(valid(data, { report_id: 'report_B' }), false)
  assert.equal(valid(data, { report_id: data.report_id, metadata_revision: 'a'.repeat(64) }), false)
  assert.equal(valid(data, {}), false)
})

test('shared detail validation distinguishes empty available body from unavailable content', () => {
  const { validSavedReportObservation: valid } = api()
  assert.equal(valid(withBody('')), true)
  for (const source of [null, 'full_report.md', 'legacy_markdown', 'metadata']) for (const error of ['not_saved', 'unreadable', 'too_large']) assert.equal(valid(unavailable({ content_source: source, content_error: error })), true)
  for (const data of [report({ observed_at: null }), report({ content_available: 1 }), report({ content_source: null }), report({ content_bytes: 4 }), report({ content_bytes: 5.5 }), report({ content_revision: null }), report({ content_error: 'not_saved' }), unavailable({ markdown_content: '' }), unavailable({ content_bytes: 0 }), unavailable({ content_revision: 'c'.repeat(64) }), unavailable({ content_error: null })]) assert.equal(valid(data), false)
})

test('exports compact canonical JSON with one final newline and excludes unrelated response fields', async () => {
  const { createSavedReportFile, readSavedReportFile } = api(), data = report()
  const response = { ...data, runtime: { secret: 'not portable' }, extra: () => {} }
  const text = createSavedReportFile(response)
  assert.equal(text, JSON.stringify(envelope(data)) + '\n')
  assert.deepEqual(Object.keys(JSON.parse(text).observation), keys)
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.endsWith('\n\n'), false)
  assert.doesNotMatch(text, /runtime|not portable|extra/)
  assert.equal(response.runtime.secret, 'not portable')
  assert.deepEqual(await readSavedReportFile(file(text)), data)
})

test('reopens exact literal strings, mixed newline forms, body BOM and recorded provenance', async () => {
  const literal = '\ufeff# 文 😀\r\nCR\rLF\nNUL\u0000e\u0301é\u2028\u2029<img src="https://example.org/tracker">\\n'
  const data = withBody(literal, { simulation_id: '\ufeff ../literal\r\n', title: '  <script>literal</script>\r\n', summary_preview: '\u0000e\u0301😀', requirement_preview: '  requirement\r', created_at: '', completed_at: 'not a timestamp', observed_at: '\ufeff original time\n' })
  const actual = await roundTrip(data)
  assert.deepEqual(bytes(actual.markdown_content), bytes(literal))
  assert.equal(Object.isFrozen(actual), true)
  assert.throws(() => { actual.title = 'changed' }, TypeError)
  data.title = 'changed source'
  assert.notEqual(actual.title, data.title)
})

test('exports and reopens empty, unavailable, modern, legacy and unknown observations', async () => {
  for (const source of ['modern', 'legacy']) for (const content_source of ['full_report.md', 'legacy_markdown', 'metadata']) {
    await roundTrip(withBody('', { source, content_source, status: 'unknown', simulation_id: null, created_at: null, completed_at: null }))
    for (const content_error of ['not_saved', 'unreadable', 'too_large']) await roundTrip(unavailable({ source, content_source, content_error, status: 'unknown' }))
  }
  await roundTrip(unavailable())
})

test('preserves accepted signed numeric zero without JSON normalization', async () => {
  const data = withBody('', { content_bytes: -0 })
  const actual = await roundTrip(data)
  assert.equal(Object.is(actual.content_bytes, -0), true)
})

test('preserves copied revision metadata without claiming or recomputing content authenticity', async () => {
  const data = withBody('This body does not hash to the opaque recorded revisions', { metadata_revision: '0'.repeat(64), content_revision: 'f'.repeat(64) })
  await roundTrip(data)
})

test('round-trips an inclusive 8 MiB UTF-8 body and refuses one extra body byte', async () => {
  const { createSavedReportFile, readSavedReportFile } = api()
  const data = withBody('😀'.repeat(bodyLimit / 4))
  await roundTrip(data)
  const tooLarge = withBody(data.markdown_content + 'x')
  assert.throws(() => createSavedReportFile(tooLarge), invalid)
  await assert.rejects(readSavedReportFile(downloaded(tooLarge)), invalid)
})

test('export/import closes at the 16 MiB API response boundary with escaped content', async () => {
  const { createSavedReportFile, readSavedReportFile } = api()
  const data = withBody('"'.repeat(bodyLimit - 2048) + '😀\r\n\u0000文', { title: '文 😀 saved report' })
  const responseBytes = bytes(JSON.stringify({ success: true, data }) + '\n').length
  data.simulation_id += 'x'.repeat(apiLimit - responseBytes)
  assert.equal(bytes(JSON.stringify({ success: true, data }) + '\n').length, apiLimit)
  const text = createSavedReportFile(data)
  assert.ok(bytes(text).length > apiLimit)
  assert.ok(bytes(text).length <= fileLimit)
  assert.deepEqual(await readSavedReportFile(file(text)), data)
})

test('uses the actual final UTF-8 envelope budget and preserves unrestricted optional strings', async () => {
  const { createSavedReportFile, readSavedReportFile } = api(), data = withBody('')
  const overhead = bytes(createSavedReportFile(data)).length
  data.simulation_id += 'x'.repeat(fileLimit - overhead)
  const text = createSavedReportFile(data)
  assert.equal(bytes(text).length, fileLimit)
  assert.deepEqual(await readSavedReportFile(file(text)), data)
  data.simulation_id += 'x'
  assert.throws(() => createSavedReportFile(data), invalid)
  const escaped = withBody('\u0000'.repeat(Math.ceil(fileLimit / 6)))
  assert.ok(escaped.content_bytes < bodyLimit)
  assert.throws(() => createSavedReportFile(escaped), invalid)
})

test('checks advertised size before reading and requires an exact bounded ArrayBuffer', async () => {
  const { readSavedReportFile: read } = api()
  for (const size of [-1, 0.25, NaN, Infinity, fileLimit + 1, '1', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    let reads = 0
    await assert.rejects(read({ size, arrayBuffer() { reads++; throw new Error('PRIVATE') } }), invalid)
    assert.equal(reads, 0)
  }
  const payload = bytes(JSON.stringify(envelope(report())))
  for (const candidate of [null, {}, { size: payload.length }, { size: payload.length, arrayBuffer: async () => payload }, { size: payload.length + 1, arrayBuffer: async () => payload.buffer }, { size: 1, arrayBuffer: async () => new ArrayBuffer(fileLimit + 1) }, { size: payload.length, arrayBuffer() { throw new Error('PRIVATE_FILE_PATH') } }, { get size() { throw new Error('PRIVATE_FILE_PATH') } }]) await assert.rejects(read(candidate), invalid)
})

test('accepts legal JSON whitespace exactly to the cap and refuses the next byte', async () => {
  const { readSavedReportFile: read } = api(), text = JSON.stringify(envelope(report()))
  const padded = text + ' '.repeat(fileLimit - bytes(text).length)
  assert.deepEqual(await read(file(padded)), report())
  await assert.rejects(read(file(padded + ' ')), invalid)
})

test('strictly rejects malformed UTF-8 and any BOM outside JSON', async () => {
  const { readSavedReportFile: read } = api(), text = JSON.stringify(envelope(report()))
  for (const invalidBytes of [[0xc3, 0x28], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]]) await assert.rejects(read(file(new Uint8Array(invalidBytes))), invalid)
  for (const input of [new Uint8Array([...bytes(text), 0xff]), bytes('\ufeff' + text), bytes(text + '\ufeff'), bytes(' \ufeff' + text)]) await assert.rejects(read(file(input)), invalid)
})

test('rejects lone UTF-16 surrogates in every recorded string while preserving surrogate pairs', async () => {
  const { createSavedReportFile: create, readSavedReportFile: read } = api()
  for (const key of keys.filter(key => typeof report()[key] === 'string').concat('completed_at')) {
    for (const value of ['\ud800', '\udfff']) {
      const data = report({ [key]: value })
      if (key === 'markdown_content') data.content_bytes = bytes(value).length
      assert.throws(() => create(data), invalid, key)
      await assert.rejects(read(downloaded(data)), invalid, key)
    }
  }
  await roundTrip(withBody('\ud83d\ude00', { title: '\ud83d\ude00' }))
})

test('rejects duplicate plain and escaped-alias keys at both envelope and observation levels', async () => {
  const { readSavedReportFile: read } = api(), text = JSON.stringify(envelope(report()))
  for (const input of [
    text.replace('"version":1', '"version":1,"version":1'),
    text.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    text.replace('"report_id":"report_A"', '"report_id":"report_A","report_id":"report_A"'),
    text.replace('"report_id":"report_A"', '"report_id":"report_A","\\u0072eport_id":"report_A"'),
    text.replace('"content_bytes":5', '"content_bytes":5,"content_bytes":5'),
  ]) await assert.rejects(read(file(input)), invalid)
  assert.deepEqual(await read(file(text.replace('"report_id"', '"\\u0072eport_id"'))), report())
})

test('bounds malformed nesting and parsed values before schema admission', async () => {
  const { readSavedReportFile: read } = api()
  for (const text of ['['.repeat(10000) + '0' + ']'.repeat(10000), '[0,0,0,0,' + Array.from({ length: 128 }, () => '0').join(',') + ']', '{"observation":{"title":[[[[0]]]]}}']) await assert.rejects(read(file(text)), invalid)
})

test('refuses invalid JSON and non-finite numbers with only a generic local error', async () => {
  const { readSavedReportFile: read } = api(), text = JSON.stringify(envelope(report()))
  for (const input of ['', text + ' PRIVATE', text.slice(0, -1), text.replace('"version":1', '"version":1e9999'), text.replace('"content_bytes":5', '"content_bytes":1e9999'), text.replace('"version":1', '"version":NaN'), text.replace('"version":1', '"version":01'), text.replace('"report_A"', '"PRIVATE\nVALUE"'), text + '{}']) await assert.rejects(read(file(input)), invalid)
})

test('requires exact own envelope and observation keys without synthesizing omitted fields', async () => {
  const { readSavedReportFile: read } = api()
  for (const key of ['format', 'version', 'observation']) {
    const value = envelope(report()); delete value[key]
    await assert.rejects(read(file(JSON.stringify(value))), invalid)
  }
  for (const key of keys) {
    const data = report(); delete data[key]
    await assert.rejects(read(downloaded(data)), invalid, key)
  }
  for (const value of [{ ...envelope(report()), extra: null }, envelope({ ...report(), extra: null }), JSON.parse(JSON.stringify(envelope(report())).replace('"version":1', '"version":1,"__proto__":{}')), envelope(JSON.parse(JSON.stringify(report()).replace('"report_id":"report_A"', '"report_id":"report_A","__proto__":{}')))]) await assert.rejects(read(file(JSON.stringify(value))), invalid)
})

test('refuses unsupported envelope versions, bare reports, old Markdown and malformed scalars', async () => {
  const { createSavedReportFile: create, readSavedReportFile: read } = api()
  for (const value of [null, [], true, report(), { success: true, data: report() }, { ...envelope(report()), format: 'mirofish-activity' }, { ...envelope(report()), version: 2 }, { ...envelope(report()), version: '1' }, { ...envelope(report()), observation: [] }]) await assert.rejects(read(file(JSON.stringify(value))), invalid)
  await assert.rejects(read(file('# Old Markdown\n')), invalid)
  for (const key of keys) {
    const data = report({ [key]: {} })
    assert.throws(() => create(data), invalid, key)
    await assert.rejects(read(downloaded(data)), invalid, key)
  }
  for (const value of [null, undefined, [], {}, report({ content_bytes: NaN }), report({ content_bytes: Infinity }), report({ title: undefined })]) assert.throws(() => create(value), invalid)
})

test('refuses incorrect UTF-8 byte metadata even when JavaScript character counts match', async () => {
  const { createSavedReportFile: create, readSavedReportFile: read } = api()
  for (const body of ['😀', 'é', '\ufeff', '文\r\n']) {
    const data = withBody(body, { content_bytes: body.length })
    assert.throws(() => create(data), invalid)
    await assert.rejects(read(downloaded(data)), invalid)
  }
})
