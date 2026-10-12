import assert from 'node:assert/strict'
import test from 'node:test'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { build, settle, ok, runChild, runView } from './helpers/parent-route-fixture.js'

// Real compiled child/parent templates and Vue Router guards; only HTTP,
// timers, unrelated destinations and host DOM are the existing fixture facades.
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const generate = h => control(h, 'generate-report')
const open = h => control(h, 'open-accepted-report')
const receipt = h => h.child(runChild).props.reportHandoff?.receipt
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
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
function outcome(h, predicate = to => to.name === 'Report') {
  return new Promise(resolve => {
    const finish = value => { removeAfter(); removeError(); resolve(value) }
    const removeAfter = h.router.afterEach((to, from, failure) => { if (predicate(to)) finish({ to, from, failure }) })
    const removeError = h.router.onError((error, to) => { if (predicate(to)) finish({ to, error }) })
  })
}
async function completeRun(h) {
  pending(h, 'startSimulation').resolve(ok({ runner_status: 'running', platform: 'parallel', total_rounds: 1 }))
  await settle(); await h.tick(2000)
  pending(h, 'getRunStatus').resolve(ok({ runner_status: 'completed', platform: 'parallel', total_rounds: 1 }))
  await settle()
  pending(h, 'getRunStatusDetail')?.resolve(ok({ all_actions: [] })); await settle()
  assert.equal(h.state(runChild).phase, 2)
}
async function ready(locale = 'en') {
  const h = build({ disableTransitions: true, locale })
  await h.mount('/simulation/A/start'); await completeRun(h)
  assert.equal(generate(h).props.disabled, false)
  return h
}
async function submit(h, id = 'accepted-report-A') {
  const action = generate(h).props.onClick
  const work = action(); action(); await settle()
  assert.equal(h.calls('generateReport').length, 1)
  const request = pending(h, 'generateReport')
  assert.equal(request.args[0].simulation_id, 'A')
  assert.equal(request.args[0].force_regenerate, true)
  request.resolve(ok({ simulation_id: 'A', report_id: id, task_id: 'accepted-task-A' }))
  await work; await settle()
  return { action, request }
}
function noExtraMutation(h, starts = 1, reports = 1) {
  assert.equal(h.calls('startSimulation').length, starts)
  assert.equal(h.calls('generateReport').length, reports)
  assert.deepEqual(Object.keys(h.requests).filter(name => !name.startsWith('get')).sort(), ['generateReport', 'startSimulation'])
}
function retryReady(h, id = 'accepted-report-A') {
  assert.equal(h.router.currentRoute.value.name, 'SimulationRun')
  assert.equal(receipt(h)?.reportId, id)
  assert.ok(open(h), 'accepted report exposes a read-only opening action')
  assert.equal(open(h).props.disabled, false)
  assert.equal(generate(h).props.disabled, true)
  assert.equal(h.state(runChild).isGeneratingReport, false)
  assert.equal(h.state(runChild).phase, 2)
}
async function acceptedAfterAbort(h) {
  const remove = h.router.beforeEach(to => to.name === 'Report' ? false : undefined)
  const finished = outcome(h); await submit(h); const result = await finished
  await settle(); remove(); return result
}
async function retry(h) {
  const finished = outcome(h)
  open(h).props.onClick(); open(h).props.onClick()
  const result = await finished; await settle(); return result
}

test('accepted report opens normally after one generation and retires child polling', { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    const finished = outcome(h); await submit(h); const result = await finished; await settle()
    assert.equal(result.failure, undefined)
    assert.equal(h.router.currentRoute.value.fullPath, '/report/accepted-report-A')
    assert.equal(h.child(runChild).isUnmounted, true); assert.equal(h.intervals.size, 0)
    noExtraMutation(h)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test(`accepted report survives guard false and opens the same ID (${locale})`, { timeout: 3000 }, async () => {
  const h = await ready(locale)
  let opening
  try {
    const result = await acceptedAfterAbort(h)
    assert.ok(isNavigationFailure(result.failure, NavigationFailureType.aborted))
    retryReady(h); noExtraMutation(h)
    assert.equal(open(h).type, 'button')
    assert.equal(control(h, 'report-opening-status').props.role, 'alert')
    assert.equal(control(h, 'report-opening-status').props['aria-live'], 'polite')
    assert.equal(textContent(open(h)).trim(), locale === 'en' ? 'Open report' : '打开报告')
    assert.match(textContent(control(h, 'report-opening-status')), locale === 'en' ? /accepted.*could not open/i : /已接受.*未能打开/)
    assert.equal(pending(h, 'getSimulation'), undefined, 'retired metadata cannot own report recovery')
    const pushes = h.pushes.length
    await generate(h).props.onClick(); await settle(); assert.equal(h.pushes.length, pushes)
    opening = hold(h, '/report/accepted-report-A', 'beforeResolve')
    open(h).props.onClick(); open(h).props.onClick(); await opening.entered; await settle()
    assert.equal(open(h).props.disabled, true)
    assert.equal(textContent(open(h)).trim(), locale === 'en' ? 'Opening report...' : '正在打开报告...')
    assert.equal(control(h, 'report-opening-status').props.role, 'status')
    assert.equal(h.pushes.length, pushes + 1)
    const promise = h.pushes.at(-1).promise
    opening.gate.resolve(); await promise; await settle()
    assert.equal(h.router.currentRoute.value.params.reportId, 'accepted-report-A'); noExtraMutation(h)
  } finally { opening?.close(); h.close() }
})

for (const mode of ['throw', 'rejected-failure', 'resolved-failure']) test(`opening ${mode} is caught and retains read-only retry`, { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    const remove = h.router.beforeEach(to => {
      if (to.name !== 'Report') return
      if (mode === 'throw') throw new Error('private synthetic guard detail')
      return false
    })
    if (mode === 'rejected-failure') {
      // Preserve actual guards and their NavigationFailure, adapt only the
      // promise-result boundary to exercise callers that reject that failure.
      const push = h.router.push
      h.router.push = async (...args) => {
        const result = await push(...args)
        if (isNavigationFailure(result)) throw result
        return result
      }
    }
    const finished = outcome(h); await submit(h); await finished; await settle()
    retryReady(h); noExtraMutation(h)
    assert.doesNotMatch(textContent(h.host), /private synthetic guard detail/)
    remove(); await retry(h); noExtraMutation(h)
    assert.equal(h.router.currentRoute.value.name, 'Report')
  } finally { h.close() }
})

for (const destination of ['/simulation/A/start', '/simulation/A/start?returned=1', '/runtime']) test(`redirect to ${destination} does not claim accepted Report arrival or auto-repush`, { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    const remove = h.router.beforeEach(to => to.name === 'Report' ? destination : undefined)
    const finished = outcome(h, to => to.fullPath === destination)
    await submit(h); await finished; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, destination)
    assert.equal(h.pushes.length, 2); noExtraMutation(h)
    if (destination.startsWith('/simulation/')) {
      retryReady(h); remove(); await retry(h); noExtraMutation(h)
    } else assert.equal(h.child(runChild).isUnmounted, true)
  } finally { h.close() }
})

for (const stage of ['beforeEach', 'beforeResolve']) {
  for (const olderResult of ['abort', 'reject', 'cancel']) test(`older opening ${olderResult} stays retired while newer same-run query waits in ${stage}`, { timeout: 3000 }, async () => {
    const h = await ready(); let older, newer
    try {
      await acceptedAfterAbort(h); retryReady(h)
      const saved = receipt(h), oldOpen = open(h).props.onClick, oldGenerate = generate(h).props.onClick
      older = hold(h, '/report/accepted-report-A'); newer = hold(h, '/simulation/A/start?view=new', stage)
      oldOpen(); await older.entered; await settle()
      const opening = h.pushes.at(-1).promise
      const changing = h.router.push('/simulation/A/start?view=new'); await newer.entered; await settle()
      const pushes = h.pushes.length
      if (olderResult === 'reject') {
        older.gate.reject(new Error('older private rejection'))
        await assert.rejects(opening, /older private rejection/)
      } else {
        older.gate.resolve(olderResult === 'abort' ? false : undefined)
        const failure = await opening
        assert.ok(isNavigationFailure(failure, olderResult === 'abort' ? NavigationFailureType.aborted : NavigationFailureType.cancelled))
      }
      await settle()
      assert.equal(open(h).props.disabled, true); assert.equal(receipt(h), saved)
      open(h).props.onClick(); oldOpen(); oldGenerate(); await settle()
      assert.equal(h.pushes.length, pushes); noExtraMutation(h)
      newer.gate.resolve(false); await changing; await settle()
      retryReady(h); assert.equal(receipt(h), saved)
      assert.notEqual(open(h).props.onClick, oldOpen)
      oldOpen(); oldGenerate(); await settle(); assert.equal(h.pushes.length, pushes)
      older.close(); newer.close(); await retry(h); noExtraMutation(h)
    } finally { older?.close(); newer?.close(); h.close() }
  })
}

test('newest of overlapping same-run query departures alone may renew report actions', { timeout: 3000 }, async () => {
  const h = await ready(); let first, latest
  try {
    await acceptedAfterAbort(h)
    first = hold(h, '/simulation/A/start?first=1'); latest = hold(h, '/simulation/A/start?latest=1', 'beforeResolve')
    const stale = open(h).props.onClick
    const firstPush = h.router.push('/simulation/A/start?first=1'); await first.entered
    const latestPush = h.router.push('/simulation/A/start?latest=1'); await latest.entered
    first.gate.resolve(false); await firstPush; await settle()
    assert.equal(open(h).props.disabled, true)
    const pushes = h.pushes.length; stale(); open(h).props.onClick(); await settle(); assert.equal(h.pushes.length, pushes)
    latest.gate.resolve(); await latestPush; await settle()
    retryReady(h); assert.equal(h.router.currentRoute.value.query.latest, '1')
    assert.equal(h.pushes.length, pushes, 'committed same-run update does not automatically reopen')
    stale(); await settle(); assert.equal(h.pushes.length, pushes)
    noExtraMutation(h)
  } finally { first?.close(); latest?.close(); h.close() }
})

for (const redirect of ['/simulation/A/start?old-redirect=1', '/runtime']) {
for (const abort of [false, true]) test(`old redirect to ${redirect} stays retired until newer query ${abort ? 'aborts' : 'settles cancelled'}`, { timeout: 3000 }, async () => {
  const h = await ready(); let older, newer
  try {
    await acceptedAfterAbort(h)
    older = hold(h, '/report/accepted-report-A'); newer = hold(h, '/simulation/A/start?latest=1')
    const oldOpen = open(h).props.onClick
    oldOpen(); await older.entered
    const opening = h.pushes.at(-1).promise
    const changing = h.router.push('/simulation/A/start?latest=1'); await newer.entered; await settle()
    const pushes = h.pushes.length
    older.gate.resolve(redirect)
    await opening; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, '/simulation/A/start')
    assert.equal(open(h).props.disabled, true)
    oldOpen(); open(h).props.onClick(); await settle(); assert.equal(h.pushes.length, pushes)
    newer.gate.resolve(abort ? false : undefined)
    const failure = await changing; await settle()
    assert.ok(isNavigationFailure(failure, abort ? NavigationFailureType.aborted : NavigationFailureType.cancelled),
      'Vue Router may cancel the newer query after processing the old redirect; recovery must not repush it')
    retryReady(h); noExtraMutation(h)
    older.close(); newer.close(); await retry(h); noExtraMutation(h)
  } finally { older?.close(); newer?.close(); h.close() }
})
}

test('newer committed departure cancels opening and permanently retires its callbacks', { timeout: 3000 }, async () => {
  const h = await ready(); let older
  try {
    older = hold(h, '/report/accepted-report-A')
    const oldGenerate = generate(h).props.onClick
    await submit(h); await older.entered
    const oldOpen = open(h).props.onClick, opening = h.pushes.at(-1).promise
    await h.navigate('/runtime')
    older.gate.resolve(); assert.ok(isNavigationFailure(await opening, NavigationFailureType.cancelled)); await settle()
    const pushes = h.pushes.length; oldGenerate(); oldOpen(); await settle()
    assert.equal(h.router.currentRoute.value.fullPath, '/runtime'); assert.equal(h.pushes.length, pushes)
    assert.equal(h.intervals.size, 0); noExtraMutation(h)
  } finally { older?.close(); h.close() }
})

for (const destination of ['/simulation/A/start?latest=1', '/runtime']) test(`late redirect from an older opening cannot take over committed ${destination}`, { timeout: 3000 }, async () => {
  const h = await ready(); let older
  try {
    older = hold(h, '/report/accepted-report-A')
    const openingGuards = new Set(), beforeEach = h.router.beforeEach
    h.router.beforeEach = guard => {
      openingGuards.add(guard)
      const remove = beforeEach(guard)
      return () => { openingGuards.delete(guard); remove() }
    }
    await submit(h); await older.entered
    const opening = h.pushes.at(-1).promise, oldOpen = open(h).props.onClick
    await h.navigate(destination)
    assert.equal(openingGuards.size, 1, 'only the pending opening keeps its exact-root guard')
    const selected = destination === '/runtime' ? '/runtime?newest=1' : destination
    if (selected !== destination) await h.navigate(selected)
    const pushes = h.pushes.length
    older.gate.resolve('/simulation/A/start?old-return=1')
    await opening; await settle()
    assert.equal(h.router.currentRoute.value.fullPath, selected, 'unrelated navigation remains available while old opening is pending')
    assert.equal(openingGuards.size, 0, 'the opening finalizer removes its retained guard')
    oldOpen(); await settle(); assert.equal(h.pushes.length, pushes)
    noExtraMutation(h)
    if (destination.startsWith('/simulation/')) retryReady(h)
    else {
      assert.equal(h.child(runChild).isUnmounted, true)
      await h.navigate('/reports?fresh=1')
      assert.equal(h.router.currentRoute.value.fullPath, '/reports?fresh=1')
      noExtraMutation(h)
    }
  } finally { older?.close(); h.close() }
})

test('A to B to A retires accepted IDs and actions despite reuse of the same parent and child', { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    await acceptedAfterAbort(h)
    const oldHandoff = h.child(runChild).props.reportHandoff
    const oldOpen = open(h).props.onClick, oldGenerate = generate(h).props.onClick
    await h.navigate('/simulation/B/start'); await h.navigate('/simulation/A/start'); await completeRun(h)
    assert.equal(h.instances[runView].length, 1); assert.equal(h.instances[runChild].length, 1)
    const pushes = h.pushes.length; oldOpen(); oldGenerate()
    oldHandoff.accept({ owner: oldHandoff.owner, simulationId: 'A', reportId: 'stale-A' })
    const current = h.child(runChild).props.reportHandoff
    current.accept({ owner: oldHandoff.owner, simulationId: 'A', reportId: 'foreign-A' })
    await settle()
    assert.equal(open(h), undefined); assert.equal(receipt(h), null); assert.equal(generate(h).props.disabled, false)
    assert.equal(h.pushes.length, pushes); noExtraMutation(h, 3)
  } finally { h.close() }
})

for (const accepted of [false, true]) test(`unmount retires ${accepted ? 'accepted receipt' : 'pending generation'} and captured callbacks`, { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    const oldGenerate = generate(h).props.onClick
    if (accepted) await acceptedAfterAbort(h)
    else { oldGenerate(); await settle() }
    const oldOpen = open(h)?.props.onClick, oldHandoff = h.child(runChild).props.reportHandoff
    const request = h.calls('generateReport')[0]
    h.close(); const pushes = h.pushes.length
    oldGenerate(); oldOpen?.()
    oldHandoff.accept({ owner: oldHandoff.owner, simulationId: 'A', reportId: 'late-report' })
    if (!accepted) request.resolve(ok({ report_id: 'late-report' }))
    await settle()
    assert.equal(h.pushes.length, pushes); assert.equal(h.intervals.size, 0)
    assert.equal(request.signal.aborted, true); noExtraMutation(h)
  } finally { h.close() }
})

for (const accepted of [false, true]) test(`explicit same-ID restart rejects the earlier ${accepted ? 'receipt' : 'pending acceptance'} and callbacks`, { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    const oldGenerate = generate(h).props.onClick, oldHandoff = h.child(runChild).props.reportHandoff
    if (accepted) await acceptedAfterAbort(h)
    else { oldGenerate(); await settle() }
    const request = h.calls('generateReport')[0], oldOpen = open(h)?.props.onClick
    h.state(runChild).doStartSimulation(); await settle(); await completeRun(h)
    const pushes = h.pushes.length
    if (!accepted) request.resolve(ok({ report_id: 'previous-run' }))
    oldHandoff.accept({ owner: oldHandoff.owner, simulationId: 'A', reportId: 'previous-run' })
    oldGenerate(); oldOpen?.(); await settle()
    assert.equal(open(h), undefined); assert.equal(generate(h).props.disabled, false)
    assert.equal(h.pushes.length, pushes); noExtraMutation(h, 2)
  } finally { h.close() }
})

for (const timing of ['during', 'after']) {
  for (const committed of [false, true]) test(`generation acceptance ${timing} a ${committed ? 'committed' : 'aborted'} same-run query preserves the receipt without taking over`, { timeout: 3000 }, async () => {
    const h = await ready(); let changing
    try {
      const oldGenerate = generate(h).props.onClick
      oldGenerate(); await settle(); const request = pending(h, 'generateReport')
      changing = hold(h, '/simulation/A/start?newer=1')
      const navigation = h.router.push('/simulation/A/start?newer=1'); await changing.entered; await settle()
      const accept = async () => { request.resolve(ok({ report_id: 'accepted-report-A' })); await settle() }
      if (timing === 'during') {
        await accept(); assert.equal(receipt(h)?.reportId, 'accepted-report-A')
        assert.equal(open(h).props.disabled, true)
      }
      changing.gate.resolve(committed ? undefined : false); await navigation; await settle()
      if (timing === 'after') await accept()
      retryReady(h)
      assert.equal(h.router.currentRoute.value.fullPath, committed ? '/simulation/A/start?newer=1' : '/simulation/A/start')
      assert.equal(h.pushes.length, 2, 'late acceptance must not override the newer navigation intent')
      oldGenerate(); await settle(); noExtraMutation(h)
      changing.close(); await retry(h); noExtraMutation(h)
    } finally { changing?.close(); h.close() }
  })
}

test('generation rejection and unsuccessful response keep the existing explicit generation retry', { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    generate(h).props.onClick(); await settle(); pending(h, 'generateReport').reject(new Error('synthetic generation failure')); await settle()
    assert.equal(generate(h).props.disabled, false); assert.equal(open(h), undefined)
    generate(h).props.onClick(); await settle(); pending(h, 'generateReport').resolve({ success: false, error: 'synthetic refusal' }); await settle()
    assert.equal(generate(h).props.disabled, false); assert.equal(open(h), undefined)
    assert.equal(h.pushes.length, 1); noExtraMutation(h, 1, 2)
  } finally { h.close() }
})

test('accepted ID is literal safe text and survives metadata retirement', { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    const id = '<img src=x onerror=alert(1)> /? # report'
    const metadata = pending(h, 'getSimulation')
    const remove = h.router.beforeEach(to => to.name === 'Report' ? false : undefined)
    const finished = outcome(h); await submit(h, id); await finished; await settle()
    metadata.reject(new Error('unavailable metadata')); await settle()
    retryReady(h, id)
    assert.match(textContent(control(h, 'accepted-report-id')), /<img src=x onerror=alert\(1\)>/)
    assert.equal(h.find(node => node.type === 'img'), undefined)
    assert.equal(h.calls('getSimulation').length, 1)
    remove(); await retry(h)
    assert.equal(h.router.currentRoute.value.params.reportId, id); noExtraMutation(h)
  } finally { h.close() }
})

for (const id of ['', '  ', null, 42]) test(`non-ID acceptance ${JSON.stringify(id)} cannot create an opening receipt`, { timeout: 3000 }, async () => {
  const h = await ready()
  try {
    await submit(h, id)
    assert.equal(open(h), undefined); assert.equal(h.pushes.length, 1)
    assert.equal(generate(h).props.disabled, false); noExtraMutation(h)
  } finally { h.close() }
})
