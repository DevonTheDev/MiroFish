import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { build, settle } from './helpers/parent-route-fixture.js'
import { clearPendingUpload, getPendingUpload, setPendingUpload } from '../src/store/pendingUpload.js'

const view = 'views/Home.vue'
const state = h => h.state(view)
const byId = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
const counts = h => Object.fromEntries(Object.entries(h.requests).map(([key, values]) => [key, values.length]))
const start = h => h.find(node => String(node.props?.class ?? '').split(/\s+/).includes('start-engine-btn'))
const recipe = (source = '\ufeffSaved Café 😀\r\n<script>literal</script>', scenario = 'Reuse scenario') => ({ format: 'mirofish-project-input-recipe', version: 1,
  source_kind: 'saved_extracted_text', source_text: source, simulation_requirement: scenario,
  source_project_name: '<b>Descriptive name</b>', captured_at: '2026-10-17T12:34:56.789Z' })
const file = value => new File([typeof value === 'string' ? value : JSON.stringify(value)], 'recipe.json')
const bytes = async value => Buffer.from(await value.arrayBuffer())
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { resolve, reject, promise } }

async function home(t, options = {}) {
  clearPendingUpload()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  const h = build({ graphRoute: true, extraViews: [view], locale: 'en', assertNoWarnings: true, ...options })
  t.after(() => { try { h.close() } finally { clearPendingUpload(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document } })
  await h.mount('/'); return h
}
async function click(h, id) { const control = byId(h, id); assert.ok(control, id); const result = control.props.onClick(); await settle(); return result }
function select(h, selected) { const target = { files: selected ? [selected] : [], value: 'picked' }; const promise = byId(h, 'input-recipe-file').props.onChange({ target }); assert.equal(target.value, ''); return promise }
async function draft(h, { files = [], scenario = '', source = '' } = {}) {
  if (files.length) h.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files, value: 'picked' } })
  const input = byId(h, 'simulation-requirement'); input.value = scenario; input.listeners.input({ target: input })
  byId(h, 'pasted-source-text').props.onInput({ target: { value: source } }); await settle()
}
const snapshot = h => ({ files: Array.from(state(h).files), scenario: state(h).formData.simulationRequirement, source: state(h).sourceText })
function unchanged(h, previous) {
  assert.equal(state(h).files.length, previous.files.length)
  previous.files.forEach((value, index) => assert.equal(state(h).files[index], value))
  assert.equal(state(h).formData.simulationRequirement, previous.scenario); assert.equal(state(h).sourceText, previous.source)
}

for (const locale of ['en', 'zh']) test(`${locale}: local preview is literal, bounded and never starts work`, async t => {
  const h = await home(t, { locale }), before = counts(h), value = recipe('😀'.repeat(2001) + '<script>literal</script>')
  await select(h, file(value)); await settle()
  assert.ok(byId(h, 'input-recipe-preview')); assert.ok(text(byId(h, 'input-recipe-preview')).includes('<b>Descriptive name</b>'))
  assert.equal(text(byId(h, 'input-recipe-excerpt')), '😀'.repeat(2000))
  assert.equal(text(byId(h, 'input-recipe-scenario')), value.simulation_requirement)
  assert.equal(state(h).files.length, 0); assert.equal(getPendingUpload().isPending, false)
  assert.deepEqual(counts(h), before); assert.equal(h.router.currentRoute.value.path, '/')
  await click(h, 'close-input-recipe'); assert.equal(byId(h, 'input-recipe-preview'), undefined)
})

test('empty draft adopts exact UTF-8 bytes into one fixed TXT; scenario remains editable', async t => {
  const h = await home(t), value = recipe(), before = counts(h)
  await select(h, file(value)); await click(h, 'use-input-recipe')
  assert.equal(state(h).files.length, 1); const staged = state(h).files[0]
  assert.equal(staged.name, 'reused-project-source.txt'); assert.equal(staged.type, 'text/plain')
  assert.deepEqual(await bytes(staged), Buffer.from(value.source_text)); assert.equal(state(h).formData.simulationRequirement, value.simulation_requirement)
  assert.equal(getPendingUpload().isPending, false); assert.deepEqual(counts(h), before)
  await draft(h, { scenario: 'Edited scenario' }); assert.equal(state(h).formData.simulationRequirement, 'Edited scenario')
})

for (const previous of [{ files: [new File(['old'], 'old.txt')] }, { scenario: ' ' }, { source: '\t' },
  { files: [new File(['old'], 'old.txt')], scenario: 'old scenario', source: 'unadded' }]) {
  test(`Replace/Keep protects draft ${Object.keys(previous).join('+')}`, async t => {
    const h = await home(t); await draft(h, previous); const old = snapshot(h)
    await select(h, file(recipe())); await click(h, 'use-input-recipe')
    assert.ok(byId(h, 'input-recipe-confirmation')); unchanged(h, old)
    await click(h, 'keep-input-recipe'); unchanged(h, old); assert.equal(byId(h, 'input-recipe-confirmation'), undefined)
    await click(h, 'use-input-recipe'); await click(h, 'replace-input-recipe')
    assert.equal(state(h).files.length, 1); assert.equal(state(h).sourceText, ''); assert.equal(state(h).sourceError, ''); assert.equal(state(h).error, '')
  })
}

test('draft edit invalidates an open confirmation and requires a fresh decision', async t => {
  const h = await home(t); await draft(h, { scenario: 'before' })
  await select(h, file(recipe())); await click(h, 'use-input-recipe')
  const oldConfirm = byId(h, 'replace-input-recipe').props.onClick
  await draft(h, { scenario: 'after' }); oldConfirm(); await settle()
  assert.equal(state(h).formData.simulationRequirement, 'after'); assert.equal(state(h).files.length, 0)
  assert.equal(byId(h, 'input-recipe-preview'), undefined)
  await select(h, file(recipe())); await click(h, 'use-input-recipe'); assert.ok(byId(h, 'input-recipe-confirmation'))
})

test('competing delayed parses and stale errors cannot replace the newer preview', async t => {
  const h = await home(t), old = deferred(), oldRead = select(h, { size: 1, arrayBuffer: () => old.promise })
  await select(h, file(recipe('newer'))); old.resolve(Buffer.from(JSON.stringify(recipe('older')))); await oldRead; await settle()
  assert.equal(state(h).recipePreview.recipe.source_text, 'newer')
  const failure = deferred(), failed = select(h, { size: 1, arrayBuffer: () => failure.promise })
  await select(h, file(recipe('newest'))); failure.reject(new Error('private error')); await failed; await settle()
  assert.equal(state(h).recipePreview.recipe.source_text, 'newest'); assert.equal(byId(h, 'input-recipe-error'), undefined)
})

for (const retire of ['close', 'edit', 'owner', 'route', 'unmount', 'start']) test(`pending parse retired by ${retire}`, async t => {
  const h = await home(t); await draft(h, { files: [new File(['old'], 'old.txt')], scenario: 'old' })
  const oldState = state(h), delayed = deferred(), parsed = select(h, { size: 1, arrayBuffer: () => delayed.promise })
  if (retire === 'close') { await settle(); await click(h, 'close-input-recipe') }
  if (retire === 'edit') await draft(h, { source: 'newer' })
  if (retire === 'owner') setPendingUpload([new File(['accepted'], 'accepted.txt')], 'accepted')
  if (retire === 'route') await h.navigate('/runtime')
  if (retire === 'unmount') h.close()
  if (retire === 'start') { const remove = h.router.beforeEach(to => to.name === 'Process' ? false : undefined); await start(h).props.onClick(); remove() }
  delayed.resolve(Buffer.from(JSON.stringify(recipe('late')))); await parsed; await settle()
  assert.equal(oldState.recipePreview, null); assert.equal(oldState.recipeError, '')
  assert.equal(oldState.files[0].name, 'old.txt')
})

test('aborted navigation preserves the same Home preview authority', async t => {
  const h = await home(t); await select(h, file(recipe()))
  const use = byId(h, 'use-input-recipe').props.onClick, route = h.router.currentRoute.value
  const remove = h.router.beforeEach(to => to.path === '/runtime' ? false : undefined)
  await h.navigate('/runtime'); remove(); assert.equal(h.router.currentRoute.value, route)
  use(); await settle(); assert.equal(state(h).files[0].name, 'reused-project-source.txt')
})

test('pending submission survives adoption, and existing restore still consumes only its own Files', async t => {
  const h = await home(t), accepted = new File(['accepted'], 'accepted.txt')
  setPendingUpload([accepted], 'accepted scenario'); const pending = getPendingUpload()
  await select(h, file(recipe())); await click(h, 'use-input-recipe')
  assert.equal(getPendingUpload().submissionId, pending.submissionId); assert.equal(getPendingUpload().files[0], accepted)
  await click(h, 'restore-previous-submission'); await click(h, 'cancel-restore-submission')
  assert.equal(getPendingUpload().files[0], accepted); assert.equal(state(h).files[0].name, 'reused-project-source.txt')
  await click(h, 'restore-previous-submission'); await click(h, 'confirm-restore-submission')
  assert.equal(state(h).files[0], accepted); assert.equal(state(h).formData.simulationRequirement, 'accepted scenario'); assert.equal(getPendingUpload().isPending, false)
})

test('new pending owner invalidates retained replacement confirmation', async t => {
  const h = await home(t); await draft(h, { scenario: 'old draft' }); await select(h, file(recipe())); await click(h, 'use-input-recipe')
  const confirm = byId(h, 'replace-input-recipe').props.onClick
  setPendingUpload([new File(['new accepted'], 'new.txt')], 'new accepted'); const accepted = getPendingUpload()
  confirm(); await settle(); assert.equal(state(h).files.length, 0); assert.equal(state(h).formData.simulationRequirement, 'old draft')
  assert.equal(getPendingUpload().submissionId, accepted.submissionId)
})

test('allocation failure preserves every original draft reference and field', async t => {
  class FailingFile extends File { constructor(parts, name, options) { if (name === 'reused-project-source.txt') throw new Error('private'); super(parts, name, options) } }
  const h = await home(t, { fileConstructor: FailingFile }); await draft(h, { files: [new File(['old'], 'old.txt')], scenario: 'old', source: 'pending' })
  const old = snapshot(h); await select(h, file(recipe())); await click(h, 'use-input-recipe'); await click(h, 'replace-input-recipe')
  unchanged(h, old); assert.ok(byId(h, 'input-recipe-error')); assert.doesNotMatch(text(byId(h, 'input-recipe-error')), /private/)
})

test('ownership changed during File allocation cannot cross into the new accepted submission', async t => {
  let change = () => {}
  class ChangingFile extends File { constructor(parts, name, options) { super(parts, name, options); if (name === 'reused-project-source.txt') change() } }
  const h = await home(t, { fileConstructor: ChangingFile }); await draft(h, { files: [new File(['old'], 'old.txt')], scenario: 'old' })
  const old = snapshot(h); await select(h, file(recipe())); await click(h, 'use-input-recipe')
  const accepted = new File(['accepted'], 'accepted.txt'); change = () => setPendingUpload([accepted], 'new accepted')
  await click(h, 'replace-input-recipe'); unchanged(h, old); assert.equal(getPendingUpload().files[0], accepted)
})

test('duplicate source last-value-wins feeds the same preview and staged File', async t => {
  const h = await home(t), raw = JSON.stringify(recipe('first')).replace(/}$/, ',"source_text":"last 😀"}')
  await select(h, file(raw)); assert.equal(state(h).recipePreview.recipe.source_text, 'last 😀')
  await click(h, 'use-input-recipe'); assert.deepEqual(await bytes(state(h).files[0]), Buffer.from('last 😀'))
})

test('generated backend response passes real parser/File and ordinary MainView multipart only after Start', async t => {
  assert.ok(process.env.MIROFISH_RECIPE_FIXTURE_OUTPUT, 'runner must provide the actual generated backend response')
  const generated = readFileSync(process.env.MIROFISH_RECIPE_FIXTURE_OUTPUT), original = JSON.parse(generated.toString('utf8'))
  const recordedHash = readFileSync(process.env.MIROFISH_RECIPE_FIXTURE_OUTPUT.replace(/\.json$/, '.sha256'), 'utf8').split(' ')[0]
  assert.equal(createHash('sha256').update(generated).digest('hex'), recordedHash)
  const h = await home(t), before = counts(h)
  await select(h, new File([generated], 'generated.json')); await click(h, 'use-input-recipe')
  const staged = state(h).files[0]; assert.deepEqual(await bytes(staged), Buffer.from(original.source_text))
  assert.deepEqual(counts(h), before); assert.equal(getPendingUpload().isPending, false)
  await start(h).props.onClick(); await settle()
  const calls = h.calls('generateOntology'); assert.equal(calls.length, 1)
  const multipart = calls[0].args[0]
  assert.deepEqual([...multipart.keys()], ['files', 'simulation_requirement'])
  assert.equal(multipart.getAll('files').length, 1); assert.equal(multipart.get('files'), staged)
  assert.deepEqual(await bytes(multipart.get('files')), Buffer.from(original.source_text))
  assert.equal(multipart.get('simulation_requirement'), original.simulation_requirement)
  assert.equal(h.calls('buildGraph').length, 0, 'ontology remains an unresolved mock, not a live model qualification')
})
