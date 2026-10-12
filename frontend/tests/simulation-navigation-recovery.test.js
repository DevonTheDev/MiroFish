import assert from 'node:assert/strict'
import test from 'node:test'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { build as buildParent, settle, ok, graphView, graphChild } from './helpers/parent-route-fixture.js'

const build = (locale = 'en') => buildParent({ graphRoute: true, locale, manualPlan: true })
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const create = h => control(h, 'create-simulation')
const open = h => control(h, 'open-created-simulation')
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const completed = (id = 'A', graph = 'G' + id) => ({ project_id: id, status: 'graph_completed', graph_id: graph })
async function loaded(h, id = 'A', graph = 'G' + id) {
  pending(h, 'getProject').resolve(ok(completed(id, graph))); await settle()
  pending(h, 'getGraphData')?.resolve(ok({ nodes: [{ name: graph }] })); await settle()
}
function outcome(h, predicate = to => to.path === '/simulation/sim-created-A') {
  return new Promise(resolve => {
    const finish = value => { removeAfter(); removeError(); resolve(value) }
    const removeAfter = h.router.afterEach((to, from, failure) => { if (predicate(to)) finish({ to, from, failure }) })
    const removeError = h.router.onError((error, to) => { if (predicate(to)) finish({ to, error }) })
  })
}
async function accept(h, destination = to => to.path === '/simulation/sim-created-A') {
  const settled = outcome(h, destination)
  create(h).props.onClick(); await settle()
  pending(h, 'createSimulation').resolve(ok({ simulation_id: 'sim-created-A' }))
  const result = await settled; await settle(); return result
}
function noExtraMutation(h) {
  assert.equal(h.calls('createSimulation').length, 1)
  assert.deepEqual(Object.keys(h.requests).filter(name => !name.startsWith('get')), ['createSimulation'],
    'all calls other than the single create remain observations; destination plan/status stay deferred')
  assert.equal(h.warnings.filter(item => item[0] === 'alert').length, 0)
}

test('accepted simulation survives a real guard abort and opens the same ID without another create', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    const removeGuard = h.router.beforeEach(to => to.path === '/simulation/sim-created-A' ? false : undefined)
    const result = await accept(h)
    assert.ok(result.failure)
    assert.equal(h.router.currentRoute.value.fullPath, '/process/A')
    assert.equal(h.calls('getProject').length, 2)
    noExtraMutation(h)
    await loaded(h)
    assert.ok(open(h), 'accepted simulation must expose an open-existing control after MainView recovery')
    assert.equal(create(h).props.disabled, true, 'accepted simulation must block a second create')
    assert.equal(open(h).props.disabled, false)
    removeGuard()
    const opened = outcome(h)
    open(h).props.onClick(); open(h).props.onClick()
    await opened; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, '/simulation/sim-created-A')
    noExtraMutation(h)
  } finally { h.close() }
})

const receipt = h => h.child(graphChild).props.simulationHandoff.receipt
const pushCount = h => h.pushes.length
const textContent = node => [node.text ?? '', ...(node.children ?? []).filter(child => child.type !== '#comment').map(textContent)].join(' ')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function hold(h, path, stage = 'beforeEach') {
  const gate = deferred(), entered = deferred()
  const remove = h.router[stage](to => {
    if (to.fullPath === path) { entered.resolve(to); return gate.promise }
  })
  return { gate, entered: entered.promise, close() { gate.resolve(false); remove() } }
}
async function acceptedAfterAbort(h) {
  await h.mount('/process/A'); await loaded(h)
  const remove = h.router.beforeEach(to => to.path === '/simulation/sim-created-A' ? false : undefined)
  await accept(h); remove(); await loaded(h)
}
async function retry(h) {
  const settled = outcome(h)
  open(h).props.onClick()
  const result = await settled; await settle(); return result
}
function retryReady(h) {
  assert.equal(h.router.currentRoute.value.path, '/process/A')
  assert.ok(open(h)); assert.equal(open(h).props.disabled, false)
  assert.equal(create(h).props.disabled, true)
  assert.equal(control(h, 'simulation-platform').props.disabled, true)
  assert.equal(receipt(h).simulationId, 'sim-created-A')
  noExtraMutation(h)
}

test('a real guard exception is caught after creation and leaves an opening retry', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    const remove = h.router.beforeEach(to => { if (to.name === 'Simulation') throw new Error('synthetic private router detail') })
    const result = await accept(h)
    assert.match(result.error.message, /synthetic private/)
    retryReady(h)
    assert.doesNotMatch(textContent(h.host), /synthetic private/)
    remove(); await retry(h)
    assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
  } finally { h.close() }
})

test('repeated aborted and rejected openings retain one receipt and never repeat creation', async () => {
  const h = build()
  try {
    await acceptedAfterAbort(h)
    const saved = receipt(h)
    for (const mode of ['abort', 'error', 'abort']) {
      const remove = h.router.beforeEach(to => {
        if (to.name !== 'Simulation') return
        if (mode === 'error') throw new Error('synthetic opening error')
        return false
      })
      await retry(h); remove()
      retryReady(h); assert.equal(receipt(h), saved)
    }
    await retry(h)
    assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
  } finally { h.close() }
})

for (const chained of [false, true]) {
  test(`${chained ? 'chained' : 'direct'} redirect back to A retains the accepted receipt without auto-repush`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); await loaded(h)
      const remove = h.router.beforeEach(to => {
        if (to.name === 'Simulation') return chained ? '/runtime' : '/process/A'
        if (to.path === '/runtime') return '/process/A'
      })
      await accept(h, to => to.path === '/process/A')
      retryReady(h)
      assert.equal(pushCount(h), 2, 'one mount and one automatic open, with redirects internal to the real router')
      remove(); await retry(h)
      assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
    } finally { h.close() }
  })
}

for (const rejected of [false, true]) {
  test(`accepted setup remains usable while recovery metadata is ${rejected ? 'rejected' : 'pending'}`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); await loaded(h)
      const remove = h.router.beforeEach(to => to.name === 'Simulation' ? false : undefined)
      await accept(h)
      const reread = pending(h, 'getProject')
      if (rejected) { reread.reject(new Error('synthetic GET failure')); await settle() }
      assert.equal(h.child(graphChild).props.projectData, null)
      assert.equal(h.child(graphChild).props.currentPhase, -1)
      retryReady(h)
      const staleCreate = create(h).props.onClick
      staleCreate(); await settle(); noExtraMutation(h)
      remove(); await retry(h)
      assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
    } finally { h.close() }
  })
}

test('graph A to B to A discards the receipt and permanently retires its callbacks', async () => {
  const h = build()
  try {
    await acceptedAfterAbort(h)
    const oldOpen = open(h).props.onClick, oldCreate = create(h).props.onClick
    const oldSelect = control(h, 'simulation-platform').props.onChange
    h.state(graphView).projectData = completed('A', 'GB'); await settle()
    assert.equal(open(h), undefined); assert.equal(create(h).props.disabled, false)
    h.state(graphView).projectData = completed('A', 'GA'); await settle()
    const pushes = pushCount(h)
    oldOpen(); oldCreate(); oldSelect({ target: { value: 'reddit' } }); await settle()
    assert.equal(pushCount(h), pushes); assert.equal(open(h), undefined)
    assert.equal(control(h, 'simulation-platform').props.value, 'parallel'); noExtraMutation(h)
    create(h).props.onClick(); await settle()
    assert.equal(h.calls('createSimulation').length, 2, 'the fresh graph lifetime can create new work')
    assert.equal(pending(h, 'createSimulation').args[0].graph_id, 'GA')
  } finally { h.close() }
})

test('project A to B to A starts a fresh selection without an old receipt', async () => {
  const h = build()
  try {
    await acceptedAfterAbort(h)
    const oldOpen = open(h).props.onClick, oldCreate = create(h).props.onClick
    const oldSelect = control(h, 'simulation-platform').props.onChange
    await h.navigate('/process/B'); await loaded(h, 'B')
    assert.equal(open(h), undefined)
    await h.navigate('/process/A'); await loaded(h)
    const pushes = pushCount(h)
    oldOpen(); oldCreate(); oldSelect({ target: { value: 'twitter' } }); await settle()
    assert.equal(pushCount(h), pushes); assert.equal(open(h), undefined)
    assert.equal(create(h).props.disabled, false)
    assert.equal(control(h, 'simulation-platform').props.value, 'parallel'); noExtraMutation(h)
  } finally { h.close() }
})

for (const unmount of [false, true]) {
  test(`${unmount ? 'explicit unmount' : 'successful other-view departure'} retires receipt callbacks and late reads`, async () => {
    const h = build()
    try {
      await h.mount('/process/A'); await loaded(h)
      const oldCreate = create(h).props.onClick, oldSelect = control(h, 'simulation-platform').props.onChange
      const remove = h.router.beforeEach(to => to.name === 'Simulation' ? false : undefined)
      await accept(h); remove()
      const oldOpen = open(h).props.onClick, reread = pending(h, 'getProject')
      if (unmount) h.close()
      else await h.navigate('/runtime')
      const route = h.router.currentRoute.value.fullPath, pushes = pushCount(h)
      oldOpen(); oldCreate(); oldSelect({ target: { value: 'reddit' } })
      reread.resolve(ok(completed())); await settle()
      assert.equal(h.router.currentRoute.value.fullPath, route); assert.equal(pushCount(h), pushes); noExtraMutation(h)
      assert.equal(h.intervals.size, 0)
    } finally { h.close() }
  })
}

test('canceled leave renews only current actions and rejects captured or foreign handoffs', async () => {
  const h = build()
  try {
    await acceptedAfterAbort(h)
    const saved = receipt(h), oldOpen = open(h).props.onClick, oldCreate = create(h).props.onClick
    const oldSelect = control(h, 'simulation-platform').props.onChange
    const oldHandoff = h.child(graphChild).props.simulationHandoff
    const remove = h.router.beforeEach(to => to.path === '/runtime' ? false : undefined)
    await h.navigate('/runtime'); remove()
    const pushes = pushCount(h)
    oldOpen(); oldCreate(); oldSelect({ target: { value: 'reddit' } })
    h.child(graphChild).emit('simulation-created', { owner: oldHandoff.owner, projectId: 'A', graphId: 'GA', simulationId: 'wrong-old', platform: 'reddit' })
    h.child(graphChild).emit('simulation-created', { owner: {}, projectId: 'A', graphId: 'GA', simulationId: 'wrong-foreign', platform: 'reddit' })
    await settle()
    assert.equal(pushCount(h), pushes); assert.equal(receipt(h), saved); retryReady(h)
    assert.notEqual(open(h).props.onClick, oldOpen)
    await retry(h); assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
  } finally { h.close() }
})

for (const rejection of [false, true]) {
  test(`older opening ${rejection ? 'rejection' : 'abort'} cannot revive actions during a newer departure`, async () => {
    const h = build(); let older, newer
    try {
      await acceptedAfterAbort(h)
      const saved = receipt(h)
      older = hold(h, '/simulation/sim-created-A'); newer = hold(h, '/process/A?view=new', 'beforeResolve')
      open(h).props.onClick(); await older.entered; await settle()
      const oldPush = h.pushes.at(-1).promise
      const newerPush = h.router.push('/process/A?view=new'); await newer.entered; await settle()
      const pushes = pushCount(h)
      if (rejection) {
        older.gate.reject(new Error('older synthetic rejection'))
        await assert.rejects(oldPush, /older synthetic rejection/)
      } else { older.gate.resolve(false); await oldPush }
      await settle()
      assert.equal(h.calls('getProject').length, 2, 'older settlement cannot restart graph observation')
      assert.equal(open(h).props.disabled, true); assert.equal(receipt(h), saved)
      open(h).props.onClick(); create(h).props.onClick(); await settle()
      assert.equal(pushCount(h), pushes); noExtraMutation(h)
      newer.gate.resolve(false); await newerPush; await settle()
      retryReady(h); assert.equal(receipt(h), saved); assert.equal(h.calls('getProject').length, 3)
      older.close(); newer.close(); await retry(h)
      assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
    } finally { older?.close(); newer?.close(); h.close() }
  })
}

for (const destination of ['/process/A?view=graph', '/process/B', '/runtime']) {
  test(`newer committed ${destination} stays current after an older opening settles`, async () => {
    const h = build(); let older
    try {
      await acceptedAfterAbort(h)
      const saved = receipt(h), oldOpen = open(h).props.onClick
      older = hold(h, '/simulation/sim-created-A')
      oldOpen(); await older.entered; await settle()
      const oldPush = h.pushes.at(-1).promise
      await h.navigate(destination)
      if (destination.startsWith('/process/')) await loaded(h, destination.includes('/B') ? 'B' : 'A')
      const pushes = pushCount(h), reads = h.calls('getProject').length
      older.gate.resolve(); const failure = await oldPush; await settle()
      assert.ok(isNavigationFailure(failure, NavigationFailureType.cancelled))
      oldOpen(); await settle()
      assert.equal(h.router.currentRoute.value.fullPath, destination)
      assert.equal(pushCount(h), pushes); assert.equal(h.calls('getProject').length, reads); noExtraMutation(h)
      if (destination.includes('/process/A')) {
        assert.equal(receipt(h), saved); assert.equal(open(h).props.disabled, false)
        assert.equal(create(h).props.disabled, true)
      } else if (destination === '/process/B') {
        assert.equal(open(h), undefined); assert.equal(create(h).props.disabled, false)
      }
    } finally { older?.close(); h.close() }
  })
}

test('a Process update observed at beforeResolve retires old callbacks until exact cancellation', async () => {
  const h = build(); let update
  try {
    await acceptedAfterAbort(h)
    const oldOpen = open(h).props.onClick, oldCreate = create(h).props.onClick
    const oldSelect = control(h, 'simulation-platform').props.onChange
    update = hold(h, '/process/A?view=graph', 'beforeResolve')
    const updating = h.router.push('/process/A?view=graph'); await update.entered; await settle()
    const pushes = pushCount(h), reads = h.calls('getProject').length
    oldOpen(); oldCreate(); oldSelect({ target: { value: 'reddit' } }); await settle()
    assert.equal(pushCount(h), pushes); assert.equal(h.calls('getProject').length, reads)
    assert.equal(open(h).props.disabled, true); noExtraMutation(h)
    update.gate.resolve(false); await updating; await settle()
    retryReady(h); assert.equal(h.calls('getProject').length, reads, 'update hook does not retire graph observation')
    oldOpen(); await settle(); assert.equal(pushCount(h), pushes)
    update.close(); await retry(h)
    assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
  } finally { update?.close(); h.close() }
})

test('duplicate current opening clicks produce one actual guarded navigation', async () => {
  const h = build(); let opening
  try {
    await acceptedAfterAbort(h)
    opening = hold(h, '/simulation/sim-created-A')
    const click = open(h).props.onClick, pushes = pushCount(h)
    click(); click(); await opening.entered; await settle()
    click(); open(h).props.onClick(); create(h).props.onClick(); await settle()
    assert.equal(pushCount(h), pushes + 1); assert.equal(open(h).props.disabled, true); noExtraMutation(h)
    const navigation = h.pushes.at(-1).promise
    opening.gate.resolve(); await navigation; await settle()
    assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
  } finally { opening?.close(); h.close() }
})

for (const locale of ['en', 'zh']) {
  test(`${locale} opening and recovery statuses are translated native accessible controls`, async () => {
    const h = build(locale); let opening
    try {
      await h.mount('/process/A'); await loaded(h)
      control(h, 'simulation-platform').props.onChange({ target: { value: 'reddit' } })
      opening = hold(h, '/simulation/sim-created-A')
      create(h).props.onClick(); await settle(); pending(h, 'createSimulation').resolve(ok({ simulation_id: 'sim-created-A' }))
      await opening.entered; await settle()
      let status = control(h, 'created-simulation-status')
      assert.equal(status.props.role, 'status'); assert.equal(status.props['aria-live'], 'polite')
      assert.equal(open(h).type, 'button'); assert.equal(open(h).props.type, 'button')
      assert.equal(open(h).props.disabled, true)
      assert.match(textContent(status), locale === 'en' ? /Opening simulation/ : /正在打开模拟/)
      assert.equal(control(h, 'simulation-platform').props.value, 'reddit')
      const navigation = h.pushes.at(-1).promise
      opening.gate.resolve(false); await navigation; await settle()
      status = control(h, 'created-simulation-status')
      assert.equal(status.props.role, 'alert'); assert.equal(status.props['aria-live'], 'polite')
      assert.match(textContent(status), locale === 'en' ? /simulation was created/ : /模拟已创建/)
      assert.match(textContent(open(h)), locale === 'en' ? /Open created simulation/ : /打开已创建的模拟/)
      assert.doesNotMatch(textContent(h.host), /step1\.(openingCreatedSimulation|createdSimulationOpenFailed|retryOpenSimulation)/)
      retryReady(h)
    } finally { opening?.close(); h.close() }
  })
}

test('same-target metadata and graph preview refresh keep the receipt, choice and action identity', async () => {
  const h = build()
  try {
    await h.mount('/process/A'); await loaded(h)
    control(h, 'simulation-platform').props.onChange({ target: { value: 'twitter' } })
    const remove = h.router.beforeEach(to => to.name === 'Simulation' ? false : undefined)
    await accept(h); remove(); await loaded(h)
    const saved = receipt(h), click = open(h).props.onClick, pushes = pushCount(h)
    h.state(graphView).projectData = { ...completed(), name: 'Metadata refresh' }; await settle()
    h.graph().emit('refresh'); await settle()
    pending(h, 'getGraphData').resolve(ok({ nodes: [{ name: 'refreshed graph' }] })); await settle()
    assert.equal(receipt(h), saved); assert.equal(open(h).props.onClick, click)
    assert.equal(control(h, 'simulation-platform').props.value, 'twitter')
    assert.equal(pushCount(h), pushes); retryReady(h)
  } finally { h.close() }
})

test('a fresh current click before an earlier global update guard releases is new navigation intent', async () => {
  const h = build(); let update
  try {
    await acceptedAfterAbort(h)
    const click = open(h).props.onClick
    update = hold(h, '/process/A?view=graph')
    const updating = h.router.push('/process/A?view=graph'); await update.entered; await settle()
    assert.equal(open(h).props.disabled, false, 'component update hook has not yet observed this earlier global guard')
    const settled = outcome(h)
    click(); await settled; await settle()
    assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A')
    update.gate.resolve(); await updating; await settle()
    assert.equal(h.router.currentRoute.value.path, '/simulation/sim-created-A'); noExtraMutation(h)
  } finally { update?.close(); h.close() }
})
