import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import test from 'node:test'
import { build, settle, ok, graphView } from './helpers/parent-route-fixture.js'
import { clearPendingUpload, getPendingUpload, setPendingUpload } from '../src/store/pendingUpload.js'

const homeView = 'views/Home.vue'
const byId = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const state = h => h.state(homeView)
const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
const start = h => h.find(node => String(node.props?.class ?? '').split(/\s+/).includes('start-engine-btn'))
const restore = h => byId(h, 'restore-previous-submission')
const confirm = h => byId(h, 'confirm-restore-submission')
const cancel = h => byId(h, 'cancel-restore-submission')
const counts = h => Object.fromEntries(Object.entries(h.requests).map(([key, value]) => [key, value.length]))
const sameFiles = (actual, expected) => {
  assert.equal(actual.length, expected.length)
  expected.forEach((file, index) => assert.equal(actual[index], file, `File reference at ${index}`))
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function home(t, { pending, locale = 'en' } = {}) {
  clearPendingUpload()
  if (pending) setPendingUpload(pending.files, pending.requirement)
  // The real runtime-dom v-model directive reads this realm's document when
  // restoration changes a textarea value. Component VM globals are separate.
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true, writable: true, value: { activeElement: null },
  })
  let h
  t.after(() => {
    try { h?.close() }
    finally {
      clearPendingUpload()
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else delete globalThis.document
    }
  })
  h = build({ graphRoute: true, extraViews: [homeView], locale })
  await h.mount('/')
  return h
}
async function requirement(h, value) {
  const input = byId(h, 'simulation-requirement')
  input.value = value
  input.listeners.input({ target: input })
  await settle()
}
async function source(h, value) {
  byId(h, 'pasted-source-text').props.onInput({ target: { value } })
  await settle()
}
async function select(h, files) {
  h.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files, value: 'selection' } })
  await settle()
}
async function click(h, id) {
  const button = byId(h, id)
  assert.ok(button, id)
  assert.ok(!button.props.disabled, `${id} is enabled`)
  button.props.onClick()
  await settle()
}
function retained() {
  return { files: [new File(['  café 中文 🌱\r\n'], 'retained.txt', { type: 'text/plain', lastModified: 42 })],
    requirement: '  original scenario\r\n  ' }
}
function holdNavigation(h, predicate) {
  const entered = deferred(), result = deferred()
  const remove = h.router.beforeEach(to => {
    if (predicate(to)) { entered.resolve(); return result.promise }
  })
  return { entered, result, remove }
}
async function restoredFields(h, expected) {
  sameFiles(state(h).files, expected.files)
  assert.equal(state(h).formData.simulationRequirement, expected.requirement)
  assert.equal(byId(h, 'pasted-source-text').props.value, '')
  assert.equal(getPendingUpload().isPending, false)
  assert.equal(restore(h), undefined)
  assert.equal(byId(h, 'restored-submission').props.role, 'status')
}

for (const locale of ['en', 'zh']) {
  test(`${locale}: empty Home explicitly restores staged inputs and focuses the scenario with no request`, { timeout: 3000 }, async t => {
    const expected = retained(), h = await home(t, { pending: expected, locale })
    const snapshot = getPendingUpload(), before = counts(h)
    assert.equal(state(h).files.length, 0, 'Home never auto-hydrates')
    assert.equal(state(h).formData.simulationRequirement, '')
    assert.equal(restore(h).props.type, 'button')
    assert.equal(restore(h).props['aria-describedby'], 'restore-submission-hint')
    assert.equal(text(restore(h)), h.i18n.global.t('home.restorePreviousSubmission'))
    let focused = 0
    byId(h, 'simulation-requirement').focus = () => { focused++ }
    const oldClick = restore(h).props.onClick
    oldClick(); oldClick(); await settle()
    await restoredFields(h, expected)
    assert.equal(focused, 1)
    assert.notEqual(state(h).files, snapshot.files)
    assert.equal(await state(h).files[0].text(), '  café 中文 🌱\r\n')
    assert.equal(state(h).files[0].lastModified, 42)
    assert.equal(state(h).files[0].type, 'text/plain')
    state(h).files.pop()
    assert.equal(snapshot.files.length, 1, 'editing Home cannot mutate the prior snapshot membership')
    assert.deepEqual(counts(h), before)
    assert.equal(h.warnings.length, 0)
  })
}

test('Home offers nothing after legacy clear or for a pending record with no files', { timeout: 3000 }, async t => {
  const h = await home(t)
  assert.equal(restore(h), undefined)
  setPendingUpload([], 'scenario'); await settle()
  assert.equal(restore(h), undefined)
  setPendingUpload(retained().files, 'scenario'); await settle()
  assert.ok(restore(h))
  clearPendingUpload(); await settle()
  assert.equal(restore(h), undefined)
})

for (const locale of ['en', 'zh']) {
  test(`${locale}: replacement cancel preserves all current values and confirmation replaces them`, { timeout: 3000 }, async t => {
    const expected = retained(), h = await home(t, { pending: expected, locale })
    const current = new File(['current'], 'current.md')
    await select(h, [current]); await requirement(h, 'current scenario'); await source(h, 'unadded text')
    state(h).sourceError = 'home.sourceAddFailed'; state(h).error = 'home.startFailed'
    const snapshot = getPendingUpload(), before = counts(h)
    await click(h, 'restore-previous-submission')
    sameFiles(state(h).files, [current]); assert.equal(state(h).sourceText, 'unadded text')
    assert.equal(getPendingUpload().submissionId, snapshot.submissionId)
    assert.equal(byId(h, 'restore-replacement-confirmation').props.role, 'group')
    assert.equal(text(confirm(h)), h.i18n.global.t('home.restoreReplace'))
    assert.equal(text(cancel(h)), h.i18n.global.t('home.restoreKeep'))
    const oldConfirm = confirm(h).props.onClick
    await click(h, 'cancel-restore-submission'); oldConfirm(); await settle()
    sameFiles(state(h).files, [current]); assert.equal(state(h).sourceText, 'unadded text')
    assert.equal(state(h).formData.simulationRequirement, 'current scenario')
    assert.equal(getPendingUpload().submissionId, snapshot.submissionId)
    assert.equal(confirm(h), undefined)
    await click(h, 'restore-previous-submission')
    await click(h, 'confirm-restore-submission')
    await restoredFields(h, expected)
    assert.equal(state(h).sourceError, '')
    assert.equal(state(h).error, '')
    oldConfirm(); await settle()
    sameFiles(state(h).files, expected.files)
    assert.deepEqual(counts(h), before)
  })
}

for (const field of ['source', 'scenario', 'files']) {
  test(`${field}: even one literal current input requires replacement confirmation`, { timeout: 3000 }, async t => {
    const h = await home(t, { pending: retained() })
    if (field === 'source') await source(h, ' \r\n\t')
    if (field === 'scenario') await requirement(h, ' \n\t')
    if (field === 'files') await select(h, [new File(['current'], 'current.txt')])
    const id = getPendingUpload().submissionId
    await click(h, 'restore-previous-submission')
    assert.ok(confirm(h)); assert.equal(getPendingUpload().submissionId, id)
    assert.equal(byId(h, 'restored-submission'), undefined)
  })
}

for (const edit of ['source', 'scenario', 'files']) {
  test(`${edit}: an edit retires both the offered click and an open confirmation synchronously`, { timeout: 3000 }, async t => {
    const h = await home(t, { pending: retained() })
    await requirement(h, 'current')
    const oldClick = restore(h).props.onClick
    oldClick(); await settle()
    const oldConfirm = confirm(h).props.onClick, oldCancel = cancel(h).props.onClick
    if (edit === 'source') byId(h, 'pasted-source-text').props.onInput({ target: { value: 'edited' } })
    if (edit === 'scenario') state(h).formData.simulationRequirement = 'edited'
    if (edit === 'files') state(h).files.push(new File(['new'], 'new.txt'))
    oldClick(); oldConfirm(); oldCancel()
    assert.equal(getPendingUpload().isPending, true)
    await settle()
    assert.equal(confirm(h), undefined)
    assert.notEqual(restore(h).props.onClick, oldClick)
    await click(h, 'restore-previous-submission')
    const currentConfirm = confirm(h).props.onClick
    oldConfirm(); oldCancel(); await settle()
    assert.equal(confirm(h).props.onClick, currentConfirm, 'stale callbacks cannot replace a newer confirmation')
  })
}

test('identical submission B retires A click/confirmation and only B can be restored', { timeout: 3000 }, async t => {
  const expected = retained(), h = await home(t, { pending: expected })
  await source(h, 'current')
  const a = getPendingUpload(), oldClick = restore(h).props.onClick
  await click(h, 'restore-previous-submission')
  const oldConfirm = confirm(h).props.onClick
  setPendingUpload(expected.files, expected.requirement)
  const b = getPendingUpload()
  oldClick(); oldConfirm(); await settle()
  assert.notEqual(a.submissionId, b.submissionId)
  assert.equal(getPendingUpload().submissionId, b.submissionId)
  assert.equal(state(h).sourceText, 'current')
  assert.equal(confirm(h), undefined)
  await click(h, 'restore-previous-submission'); await click(h, 'confirm-restore-submission')
  await restoredFields(h, expected)
})

for (const outcome of ['false', 'reject', 'redirect']) {
  test(`${outcome}: ordinary navigation leaves restore owned by the current committed Home`, { timeout: 3000 }, async t => {
    const expected = retained(), h = await home(t, { pending: expected })
    await source(h, 'keep current')
    const oldClick = restore(h).props.onClick
    await click(h, 'restore-previous-submission')
    const oldConfirm = confirm(h).props.onClick, oldCancel = cancel(h).props.onClick
    const selected = h.child(homeView), selectedRoute = h.router.currentRoute.value, id = getPendingUpload().submissionId
    h.router.onError(() => {})
    const hold = holdNavigation(h, to => to.name === 'RuntimeStatus')
    const navigation = h.router.push('/runtime').catch(() => {})
    await hold.entered.promise; await settle()
    assert.equal(restore(h).props.onClick, oldClick)
    assert.equal(confirm(h).props.onClick, oldConfirm)
    assert.equal(h.router.currentRoute.value, selectedRoute)
    assert.equal(getPendingUpload().submissionId, id)
    if (outcome === 'reject') hold.result.reject(new Error('synthetic navigation rejection'))
    else hold.result.resolve(outcome === 'false' ? false : { name: 'Home', query: { restored: 'no' } })
    await navigation; await settle(); hold.remove()
    assert.equal(h.child(homeView), selected)
    assert.equal(state(h).sourceText, 'keep current')
    if (outcome === 'redirect') {
      assert.notEqual(h.router.currentRoute.value, selectedRoute)
      assert.notEqual(restore(h).props.onClick, oldClick)
      assert.equal(confirm(h), undefined)
      await click(h, 'restore-previous-submission')
      const fresh = confirm(h).props.onClick
      oldClick(); oldConfirm(); oldCancel(); await settle()
      assert.equal(confirm(h).props.onClick, fresh, 'committed query selection retires the old callbacks')
    } else {
      assert.equal(h.router.currentRoute.value, selectedRoute)
      assert.equal(confirm(h).props.onClick, oldConfirm, 'a failed ordinary departure keeps current local confirmation')
    }
    assert.equal(getPendingUpload().submissionId, id)
    await click(h, 'confirm-restore-submission')
    await restoredFields(h, expected)
    assert.equal(h.calls('generateOntology').length, 0)
  })
}

test('a newer Home selection supersedes held departure and its late completion cannot replace a new confirmation', { timeout: 3000 }, async t => {
  const h = await home(t, { pending: retained() })
  await requirement(h, 'current')
  const oldClick = restore(h).props.onClick
  await click(h, 'restore-previous-submission')
  const oldConfirm = confirm(h).props.onClick
  const hold = holdNavigation(h, to => to.name === 'RuntimeStatus')
  const oldNavigation = h.router.push('/runtime')
  await hold.entered.promise
  await h.navigate('/?current=2')
  const selectedRoute = h.router.currentRoute.value
  assert.notEqual(restore(h).props.onClick, oldClick)
  await click(h, 'restore-previous-submission')
  const fresh = confirm(h).props.onClick
  hold.result.resolve(false); await oldNavigation; await settle(); hold.remove()
  oldClick(); oldConfirm(); await settle()
  assert.equal(h.router.currentRoute.value, selectedRoute)
  assert.equal(confirm(h).props.onClick, fresh)
  assert.equal(state(h).formData.simulationRequirement, 'current')
  assert.equal(getPendingUpload().isPending, true)
})

for (const outcome of ['false', 'reject', 'redirect']) {
  test(`${outcome}: pending Start retires restore actions and failure republishes them with existing feedback`, { timeout: 3000 }, async t => {
    const h = await home(t, { pending: retained() })
    await select(h, [new File(['current'], 'current.txt')]); await requirement(h, 'current scenario')
    const oldClick = restore(h).props.onClick
    await click(h, 'restore-previous-submission')
    const oldConfirm = confirm(h).props.onClick
    h.router.onError(() => {})
    const hold = holdNavigation(h, to => to.name === 'Process')
    const attempt = start(h).props.onClick()
    assert.equal(state(h).loading, true)
    oldClick(); oldConfirm()
    await hold.entered.promise; await settle()
    const current = getPendingUpload()
    assert.equal(restore(h), undefined)
    if (outcome === 'reject') hold.result.reject(new Error('synthetic start rejection'))
    else hold.result.resolve(outcome === 'false' ? false : { name: 'Home', query: { start: 'failed' } })
    await attempt; await settle(); hold.remove()
    assert.equal(state(h).loading, false)
    assert.equal(state(h).error, 'home.startFailed')
    assert.equal(getPendingUpload().submissionId, current.submissionId)
    assert.notEqual(restore(h).props.onClick, oldClick)
    await click(h, 'restore-previous-submission')
    const fresh = confirm(h).props.onClick
    oldClick(); oldConfirm(); await settle()
    assert.equal(confirm(h).props.onClick, fresh)
    assert.equal(h.calls('generateOntology').length, 0)
  })
}

test('Home A callbacks cannot touch remounted Home B or the current pending record', { timeout: 3000 }, async t => {
  const expected = retained(), h = await home(t, { pending: expected })
  await source(h, 'Home A')
  const a = h.child(homeView), oldClick = restore(h).props.onClick
  await click(h, 'restore-previous-submission')
  const oldConfirm = confirm(h).props.onClick, oldCancel = cancel(h).props.onClick
  await h.navigate('/runtime'); await h.navigate('/')
  assert.equal(a.isUnmounted, true)
  assert.notEqual(h.child(homeView), a)
  await source(h, 'Home B')
  await click(h, 'restore-previous-submission')
  const fresh = confirm(h).props.onClick, id = getPendingUpload().submissionId
  oldClick(); oldConfirm(); oldCancel(); await settle()
  assert.equal(confirm(h).props.onClick, fresh)
  assert.equal(state(h).sourceText, 'Home B')
  assert.equal(getPendingUpload().submissionId, id)
})

for (const failure of ['413', 'provider']) {
  test(`${failure}: restore after ontology failure preserves selected and pasted Files, then explicit edited Start uploads once`, { timeout: 3000 }, async t => {
    const h = await home(t), native = new File([' selected\r\n'], 'selected.md', { lastModified: 17 })
    await select(h, [native]); await source(h, '  pasted 中文 🌱\r\n')
    await click(h, 'add-pasted-source'); await requirement(h, '  submitted scenario\r\n')
    const files = Array.from(state(h).files), requirementValue = state(h).formData.simulationRequirement
    await start(h).props.onClick(); await settle()
    const initial = getPendingUpload(), request = h.calls('generateOntology')[0]
    assert.ok(request)
    sameFiles(request.args[0].getAll('files'), files)
    if (failure === '413') request.reject(Object.assign(new Error('Shorten source or scenario'), { response: { status: 413 } }))
    else request.resolve({ success: false, error: 'Local model unavailable' })
    await settle(); await h.navigate('/')
    const before = counts(h)
    await click(h, 'restore-previous-submission')
    await restoredFields(h, { files, requirement: requirementValue })
    assert.deepEqual(counts(h), before)
    assert.equal(await state(h).files[1].text(), '  pasted 中文 🌱\r\n')
    state(h).removeFile(1)
    await source(h, 'shorter source'); await click(h, 'add-pasted-source')
    await requirement(h, 'shorter scenario')
    const edited = Array.from(state(h).files)
    await start(h).props.onClick(); await settle()
    assert.equal(h.calls('generateOntology').length, 2)
    assert.notEqual(getPendingUpload().submissionId, initial.submissionId)
    sameFiles(h.calls('generateOntology')[1].args[0].getAll('files'), edited)
    assert.equal(h.calls('generateOntology')[1].args[0].get('simulation_requirement'), 'shorter scenario')
  })
}

test('restoration consumes recoverability before history can revisit process/new', { timeout: 3000 }, async t => {
  const h = await home(t, { pending: retained() })
  await click(h, 'restore-previous-submission')
  await h.navigate('/process/new')
  assert.equal(h.calls('generateOntology').length, 0)
  assert.equal(h.state(graphView).error, 'No pending files found.')
  await h.navigate('/')
  assert.equal(restore(h), undefined)
  assert.equal(state(h).files.length, 0)
})

for (const newer of [false, true]) {
  test(`committed ontology adoption clears only its captured identity; newer submission ${newer}`, { timeout: 3000 }, async t => {
    const expected = retained(), h = await home(t)
    await select(h, expected.files); await requirement(h, expected.requirement)
    await start(h).props.onClick(); await settle()
    const a = getPendingUpload()
    const hold = holdNavigation(h, to => to.name === 'Process' && to.params.projectId === 'accepted')
    h.calls('generateOntology')[0].resolve(ok({ project_id: 'accepted', status: 'ontology_generated' }))
    await hold.entered.promise; await settle()
    assert.equal(getPendingUpload().submissionId, a.submissionId, 'HTTP success alone never consumes input')
    assert.equal(h.calls('buildGraph').length, 0)
    if (newer) setPendingUpload(expected.files, expected.requirement)
    const current = getPendingUpload()
    hold.result.resolve(); await settle(); await new Promise(setImmediate); await settle(); hold.remove()
    assert.equal(h.router.currentRoute.value.path, '/process/accepted')
    assert.equal(h.calls('buildGraph').length, 1)
    assert.equal(h.calls('generateOntology').length, 1)
    assert.equal(getPendingUpload().isPending, newer)
    if (newer) assert.equal(getPendingUpload().submissionId, current.submissionId)
    await h.navigate('/')
    assert.equal(Boolean(restore(h)), newer)
  })
}

for (const outcome of ['false', 'reject']) {
  test(`${outcome}: failed project adoption retains recoverable input without replaying ontology`, { timeout: 3000 }, async t => {
    const expected = retained(), h = await home(t)
    await select(h, expected.files); await requirement(h, expected.requirement)
    await start(h).props.onClick(); await settle()
    h.router.onError(() => {})
    h.router.beforeEach(to => {
      if (to.name !== 'Process' || to.params.projectId !== 'accepted') return
      if (outcome === 'reject') throw new Error('synthetic adoption rejection')
      return false
    })
    const id = getPendingUpload().submissionId
    h.calls('generateOntology')[0].resolve(ok({ project_id: 'accepted', status: 'ontology_generated' }))
    await settle(); await new Promise(setImmediate); await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/new')
    assert.equal(getPendingUpload().submissionId, id)
    assert.equal(h.calls('buildGraph').length, 0)
    assert.equal(h.calls('generateOntology').length, 1)
    await h.navigate('/'); await click(h, 'restore-previous-submission')
    await restoredFields(h, expected)
    assert.equal(h.calls('generateOntology').length, 1)
  })
}

test('late ontology success after Home restoration cannot adopt, clear a newer submission or overwrite current fields', { timeout: 3000 }, async t => {
  const expected = retained(), h = await home(t)
  await select(h, expected.files); await requirement(h, expected.requirement)
  await start(h).props.onClick(); await settle()
  const oldRequest = h.calls('generateOntology')[0]
  await h.navigate('/'); await click(h, 'restore-previous-submission')
  await requirement(h, 'current edits')
  setPendingUpload(expected.files, 'newer retained scenario')
  const current = getPendingUpload()
  assert.equal(oldRequest.signal.aborted, true)
  oldRequest.resolve(ok({ project_id: 'late', status: 'ontology_generated' })); await settle()
  assert.equal(h.router.currentRoute.value.name, 'Home')
  assert.equal(state(h).formData.simulationRequirement, 'current edits')
  sameFiles(state(h).files, expected.files)
  assert.equal(getPendingUpload().submissionId, current.submissionId)
  assert.equal(h.calls('generateOntology').length, 1)
  assert.equal(h.calls('buildGraph').length, 0)
})

test('aborted departure from process/new keeps its existing interrupted observation and never retries', { timeout: 3000 }, async t => {
  const expected = retained(), h = await home(t)
  await select(h, expected.files); await requirement(h, expected.requirement)
  await start(h).props.onClick(); await settle()
  const oldRequest = h.calls('generateOntology')[0], id = getPendingUpload().submissionId
  const remove = h.router.beforeEach(to => to.name === 'Home' ? false : undefined)
  await h.navigate('/')
  assert.equal(h.router.currentRoute.value.path, '/process/new')
  assert.match(h.state(graphView).error, /observation was interrupted/)
  assert.equal(getPendingUpload().submissionId, id)
  oldRequest.resolve(ok({ project_id: 'late', status: 'ontology_generated' })); await settle()
  assert.equal(h.calls('generateOntology').length, 1)
  assert.equal(h.calls('buildGraph').length, 0)
  remove(); await h.navigate('/'); await click(h, 'restore-previous-submission')
  await restoredFields(h, expected)
})

test('overlapping ordinary departures keep only the still-current Home confirmation', { timeout: 3000 }, async t => {
  const h = await home(t, { pending: retained() })
  await requirement(h, 'current'); await click(h, 'restore-previous-submission')
  const currentConfirm = confirm(h).props.onClick, releases = new Map()
  const remove = h.router.beforeEach(to => new Promise(resolve => releases.set(to.path, resolve)))
  const first = h.router.push('/runtime'); await settle()
  const second = h.router.push('/reports'); await settle()
  assert.ok(releases.has('/runtime')); assert.ok(releases.has('/reports'))
  assert.equal(confirm(h).props.onClick, currentConfirm)
  releases.get('/runtime')(false); await first; await settle()
  assert.equal(confirm(h).props.onClick, currentConfirm)
  assert.equal(getPendingUpload().isPending, true)
  releases.get('/reports')(false); await second; await settle(); remove()
  assert.equal(confirm(h).props.onClick, currentConfirm)
  assert.equal(state(h).formData.simulationRequirement, 'current')
})

test('a newer exact-Home duplicate keeps local restore available before the older held departure settles', { timeout: 3000 }, async t => {
  const h = await home(t, { pending: retained() })
  await requirement(h, 'current'); await click(h, 'restore-previous-submission')
  const currentConfirm = confirm(h).props.onClick, route = h.router.currentRoute.value
  const hold = holdNavigation(h, to => to.name === 'RuntimeStatus')
  const oldNavigation = h.router.push('/runtime')
  await hold.entered.promise
  await h.navigate('/')
  assert.equal(h.router.currentRoute.value, route)
  assert.equal(confirm(h).props.onClick, currentConfirm)
  await click(h, 'cancel-restore-submission'); await click(h, 'restore-previous-submission')
  const fresh = confirm(h).props.onClick
  assert.notEqual(fresh, currentConfirm)
  hold.result.resolve(false); await oldNavigation; await settle(); hold.remove()
  currentConfirm(); await settle()
  assert.equal(confirm(h).props.onClick, fresh)
  assert.equal(getPendingUpload().isPending, true)
  assert.equal(state(h).formData.simulationRequirement, 'current')
})

test('an older exact-Home duplicate cannot republish a retired owner during a newer held departure', { timeout: 3000 }, async t => {
  const h = await home(t, { pending: retained() })
  await requirement(h, 'before'); await click(h, 'restore-previous-submission')
  const retiredClick = restore(h).props.onClick, retiredConfirm = confirm(h).props.onClick
  const hold = holdNavigation(h, to => to.name === 'RuntimeStatus')
  const oldDuplicate = h.router.push('/')
  const newerNavigation = h.router.push('/runtime')
  // Retire the old owner synchronously before either navigation result is observed.
  state(h).formData.simulationRequirement = 'current edit'
  const currentClick = state(h).restoreControls.action
  await hold.entered.promise; await oldDuplicate; await settle()
  assert.equal(h.router.currentRoute.value.name, 'Home')
  assert.equal(restore(h).props.onClick, currentClick, 'duplicate settlement does not republish a current owner')
  await click(h, 'restore-previous-submission')
  const current = confirm(h).props.onClick
  retiredClick(); retiredConfirm(); await settle()
  assert.equal(confirm(h).props.onClick, current)
  assert.equal(getPendingUpload().isPending, true)
  assert.equal(state(h).formData.simulationRequirement, 'current edit')
  hold.result.resolve(); await newerNavigation; await settle(); hold.remove()
  assert.equal(h.router.currentRoute.value.name, 'RuntimeStatus')
  current(); await settle()
  assert.equal(getPendingUpload().isPending, true, 'committed departure retires the confirmation')
})

for (const destination of ['/runtime', '/process/new']) {
  test(`${destination}: restore during pending ordinary navigation does not cancel its commit or replay an upload`, { timeout: 3000 }, async t => {
    const expected = retained(), h = await home(t, { pending: expected })
    const hold = holdNavigation(h, to => to.path === destination)
    const navigation = h.router.push(destination)
    await hold.entered.promise
    await click(h, 'restore-previous-submission')
    await restoredFields(h, expected)
    assert.equal(h.router.currentRoute.value.name, 'Home')
    hold.result.resolve(); await navigation; await settle(); hold.remove()
    assert.equal(h.router.currentRoute.value.path, destination)
    if (destination === '/process/new') assert.equal(h.state(graphView).error, 'No pending files found.')
    await h.navigate('/')
    assert.equal(state(h).files.length, 0)
    assert.equal(restore(h), undefined)
    assert.equal(getPendingUpload().isPending, false)
    assert.equal(h.calls('generateOntology').length, 0)
  })
}
