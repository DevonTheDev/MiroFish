import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { build, settle, ok } from './helpers/parent-route-fixture.js'

const byId = (h, id = 'download-input-recipe') => h.find(node => node.props?.['data-testid'] === id)
const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
const history = 'components/HistoryDatabase.vue'
const record = id => ({ simulation_id: 'simulation_' + id, project_id: id, simulation_requirement: 'Saved scenario', created_at: '2026-10-17T00:00:00Z', files: [] })
const payload = source => new TextEncoder().encode(JSON.stringify({ format: 'mirofish-project-input-recipe', version: 1,
  source_kind: 'saved_extracted_text', source_text: source, simulation_requirement: 'Scenario', source_project_name: '../unsafe-name', captured_at: '2026-10-17T12:34:56.789Z' })).buffer
const request = h => h.calls('getProjectInputRecipe').at(-1)
async function setup(t, options = {}) {
  const h = build({ historyRoute: true, graphRoute: true, disableTransitions: true, locale: 'en', assertNoWarnings: true, ...options })
  t.after(() => h.close()); await h.mount('/')
  h.calls('getSimulationHistory')[0].resolve(ok([record('A'), record('B')]))
  await settle()
  const card = h.find(node => String(node.props?.class ?? '').split(/\s+/).includes('project-card'))
  card.props.onClick({ currentTarget: card }); await settle(); assert.ok(byId(h)); return h
}

for (const locale of ['en', 'zh']) test(`${locale}: selected History download does not open Process or invoke models`, async t => {
  const h = await setup(t, { locale }), before = h.pushes.length
  const pending = byId(h).props.onClick(); assert.equal(request(h).args[0], 'A'); assert.equal(byId(h).props.type, 'button')
  request(h).resolve(payload('Exact 😀\r\n')); await pending; await settle()
  assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].filename, 'mirofish-project-input-recipe.json')
  assert.equal(h.downloads[0].blob.type, 'application/json;charset=utf-8')
  assert.equal(JSON.parse(await h.downloads[0].blob.text()).source_text, 'Exact 😀\r\n')
  assert.equal(h.pushes.length, before); assert.equal(h.calls('getProject').length, 0); assert.equal(h.calls('buildGraph').length, 0); assert.equal(h.calls('generateOntology').length, 0)
  assert.ok(byId(h, 'input-recipe-download-status')); assert.ok(h.anchors.every(a => !a.attached))
  assert.equal(h.objectUrls.size, 1)
  for (const [id, timer] of [...h.timeouts]) if (timer.ms === 1000) { h.timeouts.delete(id); timer.callback() }
  assert.equal(h.objectUrls.size, 0)
})

test('double click makes one request; stale callback cannot download a replacement selection', async t => {
  const h = await setup(t), old = byId(h).props.onClick, first = old(); old()
  assert.equal(h.calls('getProjectInputRecipe').length, 1)
  h.state(history).selectedProject = record('B')
  old(); assert.equal(h.calls('getProjectInputRecipe').length, 1, 'current selection getter retires before render')
  await settle(); assert.equal(request(h).signal.aborted, true)
  request(h).resolve(payload('stale A')); await first; await settle(); assert.equal(h.downloads.length, 0)
  const second = byId(h).props.onClick(); assert.equal(request(h).args[0], 'B')
  request(h).resolve(payload('current B')); await second; assert.equal(h.downloads.length, 1)
})

for (const change of ['close', 'route', 'unmount']) test(`${change} retires pending response and error ownership`, async t => {
  const h = await setup(t), first = byId(h).props.onClick(), pending = request(h)
  if (change === 'close') h.state(history).closeModal()
  if (change === 'route') await h.navigate('/runtime')
  if (change === 'unmount') h.close()
  await settle(); assert.equal(pending.signal.aborted, true)
  pending.reject(Object.assign(new Error('/private/source secret'), { status: 409 })); await first; await settle()
  assert.equal(h.downloads.length, 0); assert.equal(byId(h, 'input-recipe-download-error'), undefined)
})

test('completed request URL is cleaned on replacement without revoking newer resources', async t => {
  const h = await setup(t), first = byId(h).props.onClick(); request(h).resolve(payload('one')); await first
  const firstUrl = h.downloads[0].href, second = byId(h).props.onClick()
  assert.ok(h.revoked.includes(firstUrl)); request(h).resolve(payload('two')); await second
  const secondUrl = h.downloads[1].href; assert.notEqual(secondUrl, firstUrl); assert.equal(h.objectUrls.has(secondUrl), true)
  h.state(history).closeModal(); await settle(); assert.ok(h.revoked.includes(secondUrl)); assert.equal(h.objectUrls.size, 0)
})

for (const status of [400, 404, 409, 413, 422, 500]) test(`HTTP ${status} offers safe error and no recipe file`, async t => {
  const h = await setup(t), pending = byId(h).props.onClick()
  request(h).reject(Object.assign(new Error('/private/source secret <script>'), { status })); await pending; await settle()
  assert.equal(h.downloads.length, 0); assert.equal(h.objectUrls.size, 0)
  assert.ok(byId(h, 'input-recipe-download-error')); assert.doesNotMatch(text(byId(h, 'input-recipe-download-error')), /private|secret|script/)
})

test('selection change during URL creation cleans only the retired request URL', async t => {
  const h = await setup(t), first = byId(h).props.onClick()
  h.downloadHooks.createObjectURL = () => { h.state(history).selectedProject = record('B') }
  request(h).resolve(payload('retired during allocation')); await first; await settle()
  assert.equal(h.downloads.length, 0); assert.equal(h.objectUrls.size, 0)
  delete h.downloadHooks.createObjectURL
  const second = byId(h).props.onClick(); request(h).resolve(payload('current')); await second
  assert.equal(h.downloads.length, 1); assert.equal(h.objectUrls.size, 1)
})

test('attachment failure reports a safe error and eventually releases its URL', async t => {
  const h = await setup(t), pending = byId(h).props.onClick()
  h.downloadHooks.append = () => { throw new Error('private attachment failure') }
  request(h).resolve(payload('source')); await pending; await settle()
  assert.equal(h.downloads.length, 0); assert.ok(byId(h, 'input-recipe-download-error'))
  for (const [id, timer] of [...h.timeouts]) if (timer.ms === 1000) { h.timeouts.delete(id); timer.callback() }
  assert.equal(h.objectUrls.size, 0); assert.ok(h.anchors.every(a => !a.attached))
})

test('an error JSON or malformed success body cannot become a recipe download', async t => {
  const h = await setup(t), pending = byId(h).props.onClick()
  request(h).resolve(new TextEncoder().encode('{"success":false,"error":"private"}').buffer); await pending; await settle()
  assert.equal(h.downloads.length, 0); assert.ok(byId(h, 'input-recipe-download-error'))
})

test('existing failed project view can request export without successful ontology', async t => {
  const h = build({ graphRoute: true, locale: 'en', assertNoWarnings: true }); t.after(() => h.close())
  await h.mount('/process/failed_project')
  h.calls('getProject')[0].resolve(ok({ project_id: 'failed_project', status: 'failed', name: 'Failed', simulation_requirement: 'Scenario', files: [] })); await settle()
  const pending = byId(h).props.onClick(); assert.equal(request(h).args[0], 'failed_project')
  request(h).resolve(payload('Full saved inputs')); await pending
  assert.equal(h.downloads.length, 1); assert.equal(h.calls('buildGraph').length, 0)
})

test('download API encodes exact selected ID, uses configured endpoint and never logs raw errors', async () => {
  const source = readFileSync(new URL('../src/api/projectInputRecipe.js', import.meta.url), 'utf8')
  const calls = [], controller = new AbortController(), secret = new Error('raw private response')
  const api = vm.runInNewContext(source.replace(/^import .*$/gm, '').replace('export async function', 'async function')
    .replace('import.meta.env', 'environment') + '\n;getProjectInputRecipe', {
    i18n: { global: { locale: { value: 'en' } } }, environment: { VITE_API_BASE_URL: 'https://selected.example/' },
    fetch: async (...args) => { calls.push(args); return { ok: false, status: 409, arrayBuffer() { throw secret } } },
    console: { error() { throw new Error('must not log') } },
  })
  await assert.rejects(api('A /?', controller.signal), error => error.status === 409 && !error.message.includes('private'))
  assert.equal(calls[0][0], 'https://selected.example/api/graph/project/A%20%2F%3F/input-recipe')
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].signal, controller.signal)
  assert.equal(calls.length, 1)
})
