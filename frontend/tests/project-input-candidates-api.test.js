import assert from 'node:assert/strict'
import test from 'node:test'
import { row, envelope, adapter } from './helpers/project-input-candidates-data.js'

test('bounded adapter uses one isolated no-store request and preserves exact declared frozen rows', async () => {
  const calls = [], controller = new AbortController(), value = envelope([row('A', { extra: 'ignored' })])
  const api = adapter(async (...args) => { calls.push(args); return new Response(JSON.stringify(value)) })
  const result = await api.getProjectInputCandidates(controller.signal)
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'https://selected.example/api/graph/project/input-candidates')
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].signal, controller.signal)
  assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].headers['Accept-Language'], 'zh')
  assert.equal(result.items[0].extra, undefined); assert.ok(Object.isFrozen(result.items[0])); assert.ok(Object.isFrozen(result.items)); assert.ok(Object.isFrozen(result))
})

for (const [label, mutate] of [
  ['wrong envelope', value => { value.success = false }],
  ['missing row field', value => { delete value.data.items[0].name }],
  ['ID alias', value => { value.data.items[0].project_id = '../source' }],
  ['reserved ID', value => { value.data.items[0].project_id = 'CON' }],
  ['raw status', value => { value.data.items[0].status = 'private message' }],
  ['invalid calendar date', value => { value.data.items[0].updated_at = '2026-02-30T11:00:00Z' }],
  ['invalid offset', value => { value.data.items[0].updated_at = '2026-01-30T11:00:00+24:00' }],
  ['surrogate', value => { value.data.items[0].name = '\ud800' }],
  ['display controls', value => { value.data.items[0].scenario_excerpt = 'hello\u202eevil' }],
  ['oversized name', value => { value.data.items[0].name = '😀'.repeat(121) }],
  ['oversized scenario', value => { value.data.items[0].scenario_excerpt = 'a'.repeat(241) }],
  ['null truncation', value => { value.data.items[0].name = null; value.data.items[0].name_truncated = true }],
  ['mismatched count', value => { value.data.returned = 0 }],
  ['excess bytes', value => { value.data.metadata_bytes_budgeted = 8388609 }],
  ['false partial', value => { value.data.partial = true }],
  ['altered limits', value => { value.data.limits.entries = 257 }],
  ['missing skip count', value => { delete value.data.skipped.changed }],
  ['impossible stop', value => { value.data.stop_reason = 'row_limit'; value.data.partial = true }],
  ['duplicate identity', value => { value.data.items.push(row()); value.data.returned++; value.data.examined_entries++ }],
  ['unsorted subset', value => { value.data.items = [row('Z'), row('A')]; value.data.returned = 2; value.data.examined_entries = 2 }],
]) test(`invalid transport is a failure rather than empty: ${label}`, async () => {
  const value = envelope(); mutate(value)
  const api = adapter(async () => new Response(JSON.stringify(value)))
  await assert.rejects(api.getProjectInputCandidates(), /Saved inputs could not be listed/)
})

test('healthy empty and partial empty remain distinct and retain all skip counters', () => {
  const api = adapter()
  assert.equal(api.validateProjectInputCandidates(envelope([])).partial, false)
  const partial = envelope([], { examined_entries: 2, skipped: { unsafe: 1, missing: 1, too_large: 0, invalid: 0, changed: 0, unreadable: 0 }, partial: true })
  assert.equal(api.validateProjectInputCandidates(partial).partial, true)
  assert.equal(api.validateProjectInputCandidates(partial).skipped.missing, 1)
})

test('announced oversized response is canceled without reading content', async () => {
  let canceled = 0
  const api = adapter(async () => ({ ok: true, headers: new Headers({ 'content-length': '262145' }),
    body: { async cancel() { canceled++ }, getReader() { throw new Error('must not read') } } }))
  await assert.rejects(api.getProjectInputCandidates()); assert.equal(canceled, 1)
})

test('received oversized stream is canceled before JSON parsing or publishing', async () => {
  let canceled = 0, released = 0, reads = 0
  const api = adapter(async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({
    async read() { reads++; return { done: false, value: new Uint8Array(131073) } },
    async cancel() { canceled++ }, releaseLock() { released++ },
  }) } }))
  await assert.rejects(api.getProjectInputCandidates()); assert.equal(reads, 2); assert.equal(canceled, 1); assert.equal(released, 1)
})

for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('{"success":true'), new TextEncoder().encode('null')]) {
  test('invalid UTF-8/JSON/envelope is sanitized', async () => {
    await assert.rejects(adapter(async () => new Response(bytes)).getProjectInputCandidates(), /Saved inputs could not be listed/)
  })
}

test('HTTP and network failures never echo raw metadata or exception strings', async () => {
  for (const fetch of [async () => new Response('private source', { status: 500 }), async () => { throw new Error('/private/project.json secret') }]) {
    await assert.rejects(adapter(fetch).getProjectInputCandidates(), error => error.message === 'Saved inputs could not be listed.')
  }
})

test('exact body cap, clipped trailing space and valid offset-free dates are accepted', async () => {
  const value = envelope([row('A', { name: 'x'.repeat(119) + ' ', name_truncated: true, updated_at: '0004-02-29T00:00:00.123456+23:59' })])
  value.padding = ''
  value.padding = 'x'.repeat(262144 - new TextEncoder().encode(JSON.stringify(value)).byteLength)
  const serialized = JSON.stringify(value); assert.equal(new TextEncoder().encode(serialized).byteLength, 262144)
  const result = await adapter(async () => new Response(serialized, { headers: { 'content-length': '262144' } })).getProjectInputCandidates()
  assert.equal(result.items[0].name.length, 120); assert.equal(result.padding, undefined)
})


test('valid FEFF format scalars survive at display boundaries and inside name/scenario', async () => {
  const values = ['\ufeffbegin', 'end\ufeff', 'a\ufeffb', '\ufeff']
  const items = values.map((value, index) => row('A' + index, { name: value, scenario_excerpt: value }))
  const result = await adapter(async () => new Response(JSON.stringify(envelope(items)))).getProjectInputCandidates()
  for (let index = 0; index < values.length; index++) {
    assert.equal(result.items[index].name, values[index])
    assert.equal(result.items[index].scenario_excerpt, values[index])
  }
})

test('Unicode whitespace and forbidden controls still cannot bypass display validation', async () => {
  for (const character of ['\u00a0', '\u0085', '\u2003', '\u2028', '\u3000', '\u001c', '\u200e']) {
    for (const field of ['name', 'scenario_excerpt']) {
      for (const value of [character, 'a' + character + 'b']) {
        const response = envelope([row('A', { [field]: value })])
        await assert.rejects(adapter(async () => new Response(JSON.stringify(response))).getProjectInputCandidates(), /Saved inputs could not be listed/)
      }
    }
  }
})
