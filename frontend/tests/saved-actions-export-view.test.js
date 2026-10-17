import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { bytes, envelope, page, mounted, revision, simulationId, settle, transport, response, text } from './helpers/saved-actions-export-fixture.mjs'

async function setup(t, options) { const h = await mounted(options); t.after(() => h.close()); return h }
const start = h => h.byId('download-all').props.onClick()
const finish = async (h, index = h.requests.length - 1) => { const data = envelope(); h.requests[index].resolve({ bytes: bytes(data), data }); await settle() }
const noFile = h => { assert.equal(h.downloads.length, 0); assert.equal(h.blobs.size, 0); assert.ok(h.anchors.every(anchor => !anchor.attached)) }

for (const locale of ['en', 'zh']) test(`${locale}: compiled view provides explicit all-actions action, Cancel, and ordinary-JSON notice`, async t => {
  const h = await setup(t, { locale })
  assert.equal(h.byId('download-all').props.disabled, false)
  assert.ok(text(h.byId('download-all')).trim())
  assert.match(h.text(), locale === 'en' ? /ordinary JSON analysis tools/ : /普通 JSON 分析工具/)
  start(h); await settle()
  assert.ok(h.byId('cancel-download-all')); assert.ok(h.byId('export-progress'))
  assert.equal(h.byId('download-all').props.disabled, true); assert.deepEqual(h.warnings, [])
})

test('one synchronous start owns its exact accepted identity and rejects duplicate starts', async t => {
  const h = await setup(t), click = h.byId('download-all').props.onClick
  click(); click()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].args[0], simulationId); assert.equal(h.requests[0].args[1], revision)
  assert.equal(h.requests[0].args[2].aborted, false); assert.equal(h.requests[0].args[3](), true)
  await finish(h)
  assert.equal(h.downloads.length, 1); assert.match(h.downloads[0].filename, /-saved-actions-aaaaaaaaaaaa\.json$/)
  assert.deepEqual(new Uint8Array(await h.downloads[0].blob.arrayBuffer()), bytes(envelope()))
  assert.match(h.text(h.byId('export-status')), /Browser download started/)
  assert.match(h.text(h.byId('export-coverage')), /Complete saved-source coverage/)
  assert.equal(h.blobs.size, 1); assert.ok(h.anchors.every(anchor => !anchor.attached))
})

test('Cancel leaves accepted page available and cannot let old success clear a newer busy attempt', async t => {
  const h = await setup(t); start(h); await settle()
  await h.click('cancel-download-all')
  assert.ok(h.byId('results')); assert.equal(h.byId('download-all').props.disabled, false); assert.equal(h.requests[0].args[2].aborted, true)
  start(h); await settle(); await finish(h, 0)
  noFile(h); assert.ok(h.byId('export-progress')); assert.equal(h.requests[1].args[3](), true)
  await finish(h, 1); assert.equal(h.downloads.length, 1)
})

test('late rejection and finally from cancelled attempt cannot show an error or clear newer progress', async t => {
  const h = await setup(t); start(h); await settle(); await h.click('cancel-download-all'); start(h); await settle()
  h.requests[0].reject({ exportCode: 'sources_changed' }); await settle()
  assert.equal(h.byId('export-error'), undefined); assert.ok(h.byId('export-progress')); noFile(h)
})

for (const [name, retire] of [
  ['filter edit', h => h.input('agent-id', '0')], ['Refresh', h => h.click('refresh')],
  ['page navigation', h => h.click('next')], ['route change', h => h.navigate('/activity-files')],
  ['same-ID away and back', async h => { await h.navigate('/activity-files'); await h.navigate(`/simulation/${simulationId}/activity?revision=${revision}`) }],
  ['unmount', h => h.close()],
]) test(`${name} suppresses an ignored-abort late response`, async t => {
  const h = await setup(t); start(h); await settle(); await retire(h)
  assert.equal(h.requests[0].args[2].aborted, true)
  await finish(h); noFile(h)
  assert.equal(h.requests[0].args[3](), false)
})

for (const status of ['running', 'paused', 'ready', 'unknown']) test(`${status} observation cannot start all-actions export`, async t => {
  const h = await setup(t, { status }); assert.equal(h.byId('download-all').props.disabled, true); start(h); assert.equal(h.requests.length, 0)
})

for (const stage of ['blob', 'url', 'anchor', 'append', 'click']) test(`${stage} failure cleans up its anchor and object URL without success`, async t => {
  const h = await setup(t, { hooks: { [stage]() { throw new Error('PRIVATE_FAILURE') } } })
  start(h); await finish(h)
  noFile(h); assert.ok(h.byId('export-error')); assert.equal(h.byId('export-status'), undefined); assert.doesNotMatch(h.text(), /PRIVATE_FAILURE/)
})

for (const stage of ['blob', 'url', 'anchor', 'append']) test(`retirement during ${stage} construction suppresses the click`, async t => {
  const hooks = {}, h = await setup(t, { hooks })
  hooks[stage] = () => h.byId('cancel-download-all').props.onClick()
  start(h); await settle(); await finish(h)
  noFile(h); assert.equal(h.byId('export-error'), undefined)
})

test('successful URLs remain alive until replacement or navigation and never cross ownership', async t => {
  const h = await setup(t); start(h); await finish(h)
  const first = h.downloads[0].url; assert.equal(h.revoked.includes(first), false)
  start(h); assert.ok(h.revoked.includes(first)); await finish(h)
  const second = h.downloads[1].url; assert.equal(h.revoked.includes(second), false)
  await h.navigate('/activity-files'); assert.ok(h.revoked.includes(second)); assert.equal(h.blobs.size, 0)
})

test('mock transport-to-mounted-download contract validates and preserves exact bytes', async t => {
  const data = envelope(101), body = bytes(data), requests = []
  const get = transport(async (...args) => { requests.push(args); return response(data, { chunks: [body.slice(0, 8), body.slice(8)] }) })
  const h = await setup(t, { exportApi: get }); start(h); await settle()
  assert.equal(requests.length, 1); assert.equal(h.downloads.length, 1)
  assert.deepEqual(new Uint8Array(await h.downloads[0].blob.arrayBuffer()), body)
})

test('mock refused transport cannot create a download and exposes explicit page alternative', async t => {
  const get = transport(async () => response({ success: false, error_code: 'export_too_large' }, { status: 413 }))
  const h = await setup(t, { exportApi: get }); start(h); await settle()
  noFile(h); assert.match(h.text(h.byId('export-error')), /Download this page/)
})

test('existing page download remains its original independent page format', async t => {
  const h = await setup(t); await h.click('download')
  assert.equal(h.downloads.length, 1)
  const saved = JSON.parse(await h.downloads[0].blob.text())
  assert.equal(saved.format_version, 1); assert.equal(saved.returned_count, 1); assert.equal(saved.format, undefined)
  assert.equal(h.requests.length, 0)
})

test('real Flask fixture bytes pass mocked Fetch through compiled view into the same Blob', async t => {
  assert.ok(process.env.SAVED_ACTIONS_CONTRACT_PATH, 'qualification must provide the exact backend-produced contract fixture')
  const body = new Uint8Array(readFileSync(process.env.SAVED_ACTIONS_CONTRACT_PATH))
  const data = JSON.parse(new TextDecoder().decode(body))
  assert.ok(data.record_count > 100)
  const accepted = { ...page(data.simulation_id, data.context.status), source_revision: data.source_revision, context: data.context }
  const get = transport(async () => response(null, { chunks: [body.slice(0, 32), body.slice(32)] }))
  const h = await setup(t, { exportApi: get, page: () => accepted, initialPath: `/simulation/${data.simulation_id}/activity?revision=${data.source_revision}` })
  start(h); await settle()
  assert.equal(h.downloads.length, 1)
  assert.deepEqual(new Uint8Array(await h.downloads[0].blob.arrayBuffer()), body)
  assert.match(h.text(h.byId('export-status')), /Browser download started/)
})
