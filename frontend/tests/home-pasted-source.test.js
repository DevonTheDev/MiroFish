import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import test from 'node:test'
import { build, settle, ok } from './helpers/parent-route-fixture.js'
import { clearPendingUpload, getPendingUpload, setPendingUpload } from '../src/store/pendingUpload.js'

const homeView = 'views/Home.vue'
const cap = 262144
const byId = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const state = h => h.state(homeView)
const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
const start = h => h.find(node => String(node.props?.class ?? '').split(/\s+/).includes('start-engine-btn'))
const apiCounts = h => Object.fromEntries(Object.entries(h.requests).map(([name, calls]) => [name, calls.length]))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function home(t, options = {}) {
  clearPendingUpload()
  const h = build({ graphRoute: true, extraViews: [homeView], locale: 'en', assertNoWarnings: true, ...options })
  t.after(() => { try { h.close() } finally { clearPendingUpload() } })
  await h.mount('/')
  return h
}

async function source(h, value) {
  const input = byId(h, 'pasted-source-text')
  assert.ok(input, 'a separate source-text editor is rendered')
  input.props.onInput({ target: { value } })
  await settle()
}

async function requirement(h, value = '  separate simulation goal\n') {
  const input = byId(h, 'simulation-requirement')
  assert.ok(input)
  input.value = value
  input.listeners.input({ target: input })
  await settle()
  return value
}

async function select(h, files) {
  h.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files, value: 'selected' } })
  await settle()
}

async function add(h) {
  const button = byId(h, 'add-pasted-source')
  assert.ok(button)
  button.props.onClick()
  await settle()
}

async function bytes(file) { return Buffer.from(await file.arrayBuffer()) }

function holdStart(h) {
  const entered = deferred(), result = deferred()
  const remove = h.router.beforeEach(to => {
    if (to.name === 'Process' && to.params.projectId === 'new') {
      entered.resolve()
      return result.promise
    }
  })
  return { entered, result, remove }
}

test('pasted source can be explicitly added without a disk file', { timeout: 3000 }, async t => {
  const h = await home(t), baseline = apiCounts(h)
  await source(h, 'A small town is considering a new park.')
  assert.equal(state(h).files.length, 0)
  await add(h)
  assert.equal(state(h).files.length, 1)
  assert.ok(state(h).files[0] instanceof File)
  assert.equal(state(h).files[0].name, 'pasted-source-1.txt')
  assert.equal(state(h).files[0].type, 'text/plain')
  assert.equal(await state(h).files[0].text(), 'A small town is considering a new park.')
  assert.equal(byId(h, 'pasted-source-text').props.value, '')
  assert.deepEqual(apiCounts(h), baseline, 'Add introduces no requests beyond the mounted-page baseline')
  assert.equal(getPendingUpload().isPending, false)
})

for (const locale of ['en', 'zh']) {
  test(`${locale}: source and requirement have distinct accessible labels and explicit actions`, { timeout: 3000 }, async t => {
    const h = await home(t, { locale }), input = byId(h, 'pasted-source-text'), goal = byId(h, 'simulation-requirement')
    assert.ok(input); assert.ok(goal); assert.notEqual(input.props.id, goal.props.id)
    for (const control of [input, goal]) {
      const label = h.find(node => node.type === 'label' && node.props.for === control.props.id)
      assert.ok(label); assert.ok(text(label).trim())
    }
    assert.equal(byId(h, 'add-pasted-source').props.type, 'button')
    assert.equal(byId(h, 'clear-pasted-source').props.type, 'button')
    assert.match(text(byId(h, 'pasted-source-hint')), /256 KiB/)
    await source(h, 'unadded source')
    assert.ok(text(byId(h, 'pasted-source-pending')).trim())
    assert.equal(start(h).props.disabled, true)
    assert.equal(byId(h, 'pasted-source-text').props['aria-describedby'], 'pasted-source-hint pasted-source-pending')
    assert.equal(h.warnings.length, 0)
  })
}

test('empty and whitespace-only source text cannot add a file', { timeout: 3000 }, async t => {
  const h = await home(t)
  for (const value of ['', ' \n\t\r\n']) {
    await source(h, value)
    assert.equal(byId(h, 'add-pasted-source').props.disabled, true)
    await add(h)
    assert.equal(state(h).files.length, 0)
    assert.equal(byId(h, 'pasted-source-text').props.value, value)
  }
})

test('generated TXT preserves UTF-8 of the editor value including Unicode and whitespace', { timeout: 3000 }, async t => {
  const h = await home(t), value = '  café 中文 🌱\r\nsecond\rthird\n\n  '
  await source(h, value); await add(h)
  assert.deepEqual(await bytes(state(h).files[0]), Buffer.from(value, 'utf8'))
})

test('exact 256 KiB UTF-8 source text is admitted', { timeout: 3000 }, async t => {
  const h = await home(t), value = '🌱'.repeat(cap / 4)
  assert.equal(Buffer.byteLength(value, 'utf8'), cap)
  await source(h, value); await add(h)
  assert.equal(state(h).files.length, 1)
  assert.equal(state(h).files[0].size, cap)
  assert.deepEqual(await bytes(state(h).files[0]), Buffer.from(value, 'utf8'))
})

test('one UTF-8 byte over the limit preserves the source draft and selected files', { timeout: 3000 }, async t => {
  const h = await home(t), native = new File(['keep'], 'keep.txt'), value = '🌱'.repeat(cap / 4) + 'a'
  await select(h, [native]); const goal = await requirement(h)
  assert.equal(Buffer.byteLength(value, 'utf8'), cap + 1)
  await source(h, value); await add(h)
  assert.deepEqual(Array.from(state(h).files), [native])
  assert.equal(byId(h, 'pasted-source-text').props.value, value)
  assert.equal(state(h).formData.simulationRequirement, goal)
  assert.equal(byId(h, 'pasted-source-error').props.role, 'alert')
  assert.match(text(byId(h, 'pasted-source-error')), /256 KiB/)
})

test('UTF-8 byte admission rejects multibyte text below the JavaScript length cap', { timeout: 3000 }, async t => {
  const h = await home(t), value = '中'.repeat(Math.floor(cap / 3) + 1)
  assert.ok(value.length < cap); assert.ok(Buffer.byteLength(value, 'utf8') > cap)
  await source(h, value); await add(h)
  assert.equal(state(h).files.length, 0)
  assert.equal(byId(h, 'pasted-source-text').props.value, value)
  assert.ok(byId(h, 'pasted-source-error'))
})

test('File construction failure preserves source text requirement and selected files', { timeout: 3000 }, async t => {
  const h = await home(t, { fileConstructor: class { constructor() { throw new Error('synthetic File failure') } } })
  const native = new File(['keep'], 'keep.txt'), value = 'keep this source'
  await select(h, [native]); const goal = await requirement(h)
  await source(h, value); await add(h)
  assert.deepEqual(Array.from(state(h).files), [native])
  assert.equal(byId(h, 'pasted-source-text').props.value, value)
  assert.equal(state(h).formData.simulationRequirement, goal)
  assert.ok(byId(h, 'pasted-source-error'))
  assert.doesNotMatch(text(byId(h, 'pasted-source-error')), /synthetic/)
})

test('generated display names skip exact names already in the selected list', { timeout: 3000 }, async t => {
  const h = await home(t)
  await select(h, [new File(['one'], 'pasted-source-1.txt'), new File(['three'], 'pasted-source-3.txt')])
  await source(h, 'two'); await add(h)
  assert.equal(state(h).files[2].name, 'pasted-source-2.txt')
  await source(h, 'four'); await add(h)
  assert.equal(state(h).files[3].name, 'pasted-source-4.txt')
})

test('repeated Add after success does not duplicate a source', { timeout: 3000 }, async t => {
  const h = await home(t); await source(h, 'once')
  const click = byId(h, 'add-pasted-source').props.onClick
  click(); click(); await settle()
  assert.equal(state(h).files.length, 1)
  assert.equal(await state(h).files[0].text(), 'once')
  assert.equal(byId(h, 'pasted-source-error'), undefined)
})

test('ordinary removal and explicit re-add preserve the selected-source behavior', { timeout: 3000 }, async t => {
  const h = await home(t); await source(h, 'again'); await add(h)
  const old = state(h).files[0]
  h.find(node => String(node.props?.class ?? '').split(/\s+/).includes('remove-btn')).props.onClick({ stopPropagation() {} })
  await settle(); assert.equal(state(h).files.length, 0)
  await source(h, 'again'); await add(h)
  assert.equal(state(h).files.length, 1)
  assert.notEqual(state(h).files[0], old)
  assert.equal(await state(h).files[0].text(), 'again')
})

test('unadded meaningful source blocks both rendered Start and its retained callback', { timeout: 3000 }, async t => {
  const h = await home(t); await select(h, [new File(['seed'], 'seed.txt')]); await requirement(h)
  const click = start(h).props.onClick, pushes = h.pushes.length
  await source(h, 'not yet added')
  assert.equal(start(h).props.disabled, true)
  await click(); await settle()
  assert.equal(h.pushes.length, pushes)
  assert.equal(getPendingUpload().isPending, false)
  await add(h)
  assert.equal(start(h).props.disabled, false)
})

test('Clear changes only the unadded editor text and its feedback', { timeout: 3000 }, async t => {
  const h = await home(t), native = new File(['seed'], 'seed.txt')
  await select(h, [native]); const goal = await requirement(h)
  await source(h, '中'.repeat(cap)); await add(h)
  assert.ok(byId(h, 'pasted-source-error'))
  byId(h, 'clear-pasted-source').props.onClick(); await settle()
  assert.equal(byId(h, 'pasted-source-text').props.value, '')
  assert.equal(byId(h, 'pasted-source-error'), undefined)
  assert.deepEqual(Array.from(state(h).files), [native])
  assert.equal(state(h).formData.simulationRequirement, goal)
  assert.equal(start(h).props.disabled, false)
})

test('pending Start disables and guards source actions without changing the captured snapshot', { timeout: 3000 }, async t => {
  const h = await home(t); await source(h, 'captured'); await add(h); await requirement(h)
  const addClick = byId(h, 'add-pasted-source').props.onClick, clearClick = byId(h, 'clear-pasted-source').props.onClick
  const input = byId(h, 'pasted-source-text').props.onInput
  const hold = holdStart(h), started = start(h).props.onClick()
  await hold.entered.promise; await settle()
  const accepted = getPendingUpload()
  for (const id of ['pasted-source-text', 'add-pasted-source', 'clear-pasted-source']) assert.equal(byId(h, id).props.disabled, true)
  input({ target: { value: 'late edit' } }); addClick(); clearClick(); await settle()
  assert.equal(byId(h, 'pasted-source-text').props.value, '')
  assert.equal(state(h).files.length, 1)
  assert.equal(getPendingUpload().files, accepted.files)
  assert.equal(await accepted.files[0].text(), 'captured')
  hold.result.resolve(false); await started; await settle(); hold.remove()
})

test('retired Home source callbacks cannot alter old or remounted drafts', { timeout: 3000 }, async t => {
  const h = await home(t); await source(h, 'old draft')
  const old = state(h), addClick = byId(h, 'add-pasted-source').props.onClick, clearClick = byId(h, 'clear-pasted-source').props.onClick
  const input = byId(h, 'pasted-source-text').props.onInput
  await h.navigate('/runtime')
  addClick(); clearClick(); input({ target: { value: 'stale' } }); await settle()
  assert.equal(old.sourceText, 'old draft'); assert.equal(old.files.length, 0)
  await h.navigate('/'); await source(h, 'new draft')
  addClick(); clearClick(); input({ target: { value: 'stale again' } }); await settle()
  assert.equal(byId(h, 'pasted-source-text').props.value, 'new draft')
  assert.equal(state(h).files.length, 0)
  assert.equal(old.sourceError, '')
})

for (const outcome of ['refused', 'rejected']) {
  test(`${outcome} Home navigation keeps the staged pasted source for explicit Start again`, { timeout: 3000 }, async t => {
    const h = await home(t); await source(h, 'retained'); await add(h); await requirement(h)
    const file = state(h).files[0]
    h.router.onError(() => {})
    const remove = h.router.beforeEach(to => {
      if (to.name !== 'Process') return
      if (outcome === 'rejected') throw new Error('synthetic navigation failure')
      return false
    })
    await start(h).props.onClick(); await settle()
    assert.equal(state(h).files[0], file)
    assert.equal(await file.text(), 'retained')
    assert.equal(start(h).props.disabled, false)
    assert.ok(byId(h, 'home-start-error'))
    assert.equal(h.calls('generateOntology').length, 0)
    remove()
  })
}

for (const mixed of [false, true]) {
  test(`${mixed ? 'mixed' : 'pasted-only'} sources reach one multipart handoff with the exact separate requirement`, { timeout: 3000 }, async t => {
    const h = await home(t), native = new File(['native bytes'], 'seed.md'), value = '  中文 source\r\n 🌱  '
    if (mixed) await select(h, [native])
    await source(h, value); await add(h)
    const goal = await requirement(h, '  distinct goal\n'), selected = Array.from(state(h).files)
    await start(h).props.onClick(); await settle()
    const calls = h.calls('generateOntology'); assert.equal(calls.length, 1)
    const body = calls[0].args[0], sent = body.getAll('files')
    assert.deepEqual(sent, selected)
    selected.forEach((file, index) => assert.equal(sent[index], file))
    assert.deepEqual(await bytes(sent.at(-1)), Buffer.from(value, 'utf8'))
    assert.equal(body.get('simulation_requirement'), goal)
    calls[0].resolve(ok({ project_id: 'pasted', status: 'ontology_generated' }))
    await settle(); await new Promise(setImmediate); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/pasted')
    assert.equal(h.calls('generateOntology').length, 1)
    assert.equal(h.calls('buildGraph').length, 1)
    assert.equal(getPendingUpload().isPending, false)
  })
}

test('held-navigation draft changes do not alter accepted bytes or clear newer pending data', { timeout: 3000 }, async t => {
  const h = await home(t); await source(h, 'original pasted bytes'); await add(h); await requirement(h)
  const hold = holdStart(h), started = start(h).props.onClick()
  await hold.entered.promise
  const captured = getPendingUpload(), file = captured.files[0]
  await select(h, [new File(['later native'], 'later.txt')])
  h.find(node => String(node.props?.class ?? '').split(/\s+/).includes('remove-btn')).props.onClick({ stopPropagation() {} })
  await settle()
  assert.equal(captured.files.length, 1); assert.equal(captured.files[0], file)
  assert.equal(await file.text(), 'original pasted bytes')
  const newest = [new File(['newer owner'], 'newer.txt')]
  setPendingUpload(newest, 'newer requirement')
  const newer = getPendingUpload()
  hold.result.resolve(false); await started; await settle(); hold.remove()
  assert.equal(getPendingUpload().files, newer.files)
  assert.equal(getPendingUpload().simulationRequirement, 'newer requirement')
})
