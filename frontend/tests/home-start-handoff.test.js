import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build, settle, ok, graphView } from './helpers/parent-route-fixture.js'
import { clearPendingUpload, getPendingUpload, setPendingUpload } from '../src/store/pendingUpload.js'

const homeView = 'views/Home.vue'
const hasClass = (node, name) => String(node.props?.class ?? '').split(/\s+/).includes(name)
const button = h => h.find(node => hasClass(node, 'start-engine-btn'))
const feedback = h => h.find(node => node.props?.['data-testid'] === 'home-start-error')
const state = h => h.state(homeView)
const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const sameFiles = (actual, expected) => {
  assert.equal(actual.length, expected.length)
  expected.forEach((file, index) => assert.equal(actual[index], file, `File identity at index ${index}`))
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const failureText = {
  en: 'Could not open the graph builder. Your draft is still here. Try Start Engine again.',
  zh: '无法打开图谱构建页面。草稿仍保留在此，请再次点击启动引擎。',
}

async function home(t, locale = 'en') {
  clearPendingUpload()
  const sources = process.env.MIRO_HOME_BASELINE
    ? { [homeView]: readFileSync(process.env.MIRO_HOME_BASELINE, 'utf8') } : undefined
  const h = build({ graphRoute: true, extraViews: [homeView], locale, sources })
  t.after(() => { h.close(); clearPendingUpload() })
  await h.mount('/')
  return h
}

async function draft(h, selected = [new File(['seed'], 'seed.txt')], requirement = '  accepted requirement\n') {
  const input = h.find(node => node.type === 'input' && node.props.type === 'file')
  const target = { files: selected, value: 'synthetic selection' }
  input.props.onChange({ target })
  assert.equal(target.value, '')
  const textarea = h.find(node => node.props?.['data-testid'] === 'simulation-requirement')
  textarea.value = requirement
  textarea.listeners.input({ target: textarea })
  await settle()
  return { files: Array.from(state(h).files), requirement }
}

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

async function finish(h, start) {
  await h.pushes.at(-1).promise
  await start
  await settle()
}

test('baseline witness: Home start latches loading before the navigation guard runs', { timeout: 3000 }, async t => {
  const h = await home(t), accepted = await draft(h), hold = holdStart(h)
  const start = button(h).props.onClick()
  const latchedImmediately = state(h).loading
  try {
    await hold.entered.promise
    assert.equal(getPendingUpload().simulationRequirement, accepted.requirement,
      'the old dynamic import continuation must actually reach the real store and router')
    assert.equal(getPendingUpload().files[0], accepted.files[0])
    assert.equal(latchedImmediately, true, 'an accepted start must synchronously set loading')
    await settle()
    assert.equal(button(h).props.disabled, true)
    assert.match(text(button(h)), /Initializing/)
  } finally {
    hold.result.resolve(false)
    await finish(h, start)
    hold.remove()
  }
})

test('baseline witness: a refused Home start shows visible retry feedback', { timeout: 3000 }, async t => {
  const h = await home(t), accepted = await draft(h), hold = holdStart(h)
  const start = button(h).props.onClick()
  await hold.entered.promise
  hold.result.resolve(false)
  await finish(h, start)
  hold.remove()
  assert.equal(h.router.currentRoute.value.name, 'Home')
  assert.equal(state(h).loading, false)
  assert.equal(getPendingUpload().simulationRequirement, accepted.requirement)
  assert.equal(text(feedback(h)), failureText.en, 'the still-selected Home must visibly offer retry')
  assert.equal(feedback(h).props.role, 'alert')
  assert.equal(button(h).props.disabled, false)
})

test('real Home button hands accepted files and exact requirement to MainView, then adopts the generated project', { timeout: 3000 }, async t => {
  const h = await home(t)
  const first = new File(['first seed'], 'first.PDF'), second = new File(['second seed'], 'second.Md')
  const accepted = await draft(h, [first, new File(['ignored'], 'ignored.csv'), second, first], '  exact\nrequirement  ')
  const homeFiles = state(h).files
  const initialPushes = h.pushes.length
  const start = button(h).props.onClick()
  assert.equal(h.pushes.length, initialPushes + 1, 'navigation starts before the first await')
  const captured = getPendingUpload()
  assert.notEqual(captured.files, homeFiles)
  sameFiles(captured.files, [first, second, first])
  await start; await settle()
  assert.equal(h.router.currentRoute.value.path, '/process/new')
  assert.ok(h.child(graphView), 'the actual MainView is mounted by the application Process route')
  const ontology = pending(h, 'generateOntology')
  assert.ok(ontology)
  sameFiles(ontology.args[0].getAll('files'), [first, second, first])
  assert.equal(ontology.args[0].get('simulation_requirement'), accepted.requirement)
  ontology.resolve(ok({ project_id: 'accepted', status: 'ontology_generated' }))
  await settle(); await new Promise(setImmediate); await settle()
  assert.equal(h.router.currentRoute.value.path, '/process/accepted')
  assert.equal(h.calls('generateOntology').length, 1)
  assert.equal(h.calls('getProject').length, 0)
  assert.equal(h.calls('buildGraph').length, 1)
  assert.equal(getPendingUpload().isPending, false, 'existing MainView adoption consumes its captured upload')
})

test('held navigation isolates its snapshot from draft changes and ignores repeated starts; retry accepts the current draft', { timeout: 3000 }, async t => {
  const h = await home(t), first = new File(['first'], 'first.txt'), later = new File(['later'], 'later.md')
  await draft(h, [first, first], 'original requirement')
  const hold = holdStart(h), click = button(h).props.onClick, initialPushes = h.pushes.length
  const start = click()
  await hold.entered.promise
  const captured = getPendingUpload()
  // An already-delivered picker event remains accepted while loading; removal
  // also mutates the editable draft, never the captured upload array.
  await draft(h, [later], 'edited requirement')
  h.find(node => hasClass(node, 'remove-btn')).props.onClick({ stopPropagation() {} })
  click(); click(); await settle()
  assert.equal(h.pushes.length, initialPushes + 1)
  assert.equal(getPendingUpload().files, captured.files)
  sameFiles(captured.files, [first, first])
  assert.equal(getPendingUpload().simulationRequirement, 'original requirement')
  sameFiles(state(h).files, [first, later])
  hold.result.resolve(false); await finish(h, start); hold.remove()
  assert.equal(state(h).formData.simulationRequirement, 'edited requirement')
  assert.equal(button(h).props.disabled, false)
  const retryHold = holdStart(h), retry = button(h).props.onClick()
  await retryHold.entered.promise; await settle()
  assert.equal(feedback(h), undefined, 'a new attempt clears the previous message')
  assert.notEqual(getPendingUpload().files, captured.files)
  sameFiles(getPendingUpload().files, [first, later])
  assert.equal(getPendingUpload().simulationRequirement, 'edited requirement')
  retryHold.result.resolve(false); await finish(h, retry); retryHold.remove()
})

for (const locale of ['en', 'zh']) {
  for (const outcome of ['false', 'reject', 'redirect Home']) {
    test(`${locale}: ${outcome} restores the selected Home draft with localized retry feedback`, { timeout: 3000 }, async t => {
      const h = await home(t, locale), accepted = await draft(h), original = h.child(homeView)
      const failures = []
      h.router.onError(error => failures.push(error))
      h.router.beforeEach(to => {
        if (to.name !== 'Process') return
        if (outcome === 'false') return false
        if (outcome === 'reject') throw new Error('synthetic route rejection')
        return { name: 'Home', query: { retry: '1' } }
      })
      await button(h).props.onClick(); await settle()
      assert.equal(h.router.currentRoute.value.name, 'Home')
      assert.equal(h.child(homeView), original, 'feedback belongs to the original still-selected Home')
      assert.equal(state(h).loading, false)
      assert.equal(button(h).props.disabled, false)
      sameFiles(state(h).files, accepted.files)
      assert.equal(state(h).formData.simulationRequirement, accepted.requirement)
      assert.equal(getPendingUpload().simulationRequirement, accepted.requirement)
      assert.equal(text(feedback(h)), failureText[locale])
      assert.equal(failures.length, outcome === 'reject' ? 1 : 0)
      assert.equal(h.calls('generateOntology').length, 0)
    })
  }
}

for (const outcome of ['resolve', 'reject']) {
  test(`retired Home ${outcome} cannot alter a remounted draft, newer attempt, or pending payload`, { timeout: 3000 }, async t => {
    const h = await home(t)
    await draft(h, [new File(['old'], 'old.txt')], 'old requirement')
    h.router.onError(() => {})
    const oldHome = h.child(homeView), oldState = state(h), oldClick = button(h).props.onClick
    const hold = holdStart(h), oldStart = oldClick()
    await hold.entered.promise
    const captured = getPendingUpload()
    await h.navigate('/runtime')
    assert.equal(oldHome.isUnmounted, true)
    assert.equal(getPendingUpload().files, captured.files, 'Home unmount never clears pending data')
    await h.navigate('/')
    const currentHome = h.child(homeView)
    assert.notEqual(currentHome, oldHome)
    assert.equal(state(h).loading, false)
    assert.deepEqual(Array.from(state(h).files), [])
    await draft(h, [new File(['current'], 'current.md')], 'current requirement')
    hold.remove()
    const currentHold = holdStart(h), currentStart = button(h).props.onClick()
    await currentHold.entered.promise
    const currentPayload = getPendingUpload()
    const pushesBeforeRetiredClick = h.pushes.length
    await oldClick()
    assert.equal(h.pushes.length, pushesBeforeRetiredClick, 'a retained callback from unmounted Home is inert')
    if (outcome === 'reject') hold.result.reject(new Error('retired start rejection'))
    else hold.result.resolve()
    await oldStart; await settle()
    assert.equal(h.child(homeView), currentHome)
    assert.equal(state(h).loading, true)
    assert.equal(state(h).error, '')
    assert.equal(oldState.error, '', 'late completion does not publish feedback on a retired instance')
    assert.equal(oldState.loading, true, 'late completion does not release a retired instance latch')
    assert.equal(getPendingUpload().files, currentPayload.files)
    assert.equal(getPendingUpload().simulationRequirement, 'current requirement')
    assert.equal(h.calls('generateOntology').length, 0)
    // A separate owner may publish yet another payload before this start ends.
    const newest = [new File(['newest'], 'newest.txt')]
    setPendingUpload(newest, 'newest requirement')
    const newestPayload = getPendingUpload()
    currentHold.result.resolve(false); await currentStart; await settle(); currentHold.remove()
    assert.equal(getPendingUpload().files, newestPayload.files, 'Home failure never clears a newer payload')
    assert.equal(getPendingUpload().simulationRequirement, 'newest requirement')
    assert.equal(text(feedback(h)), failureText.en)
  })
}
