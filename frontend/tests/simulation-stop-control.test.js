import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, runView, runChild } from './helpers/parent-route-fixture.js'

// The actual Step3 and parent scripts/templates run with real Vue and Router.
// HTTP, timers, transitions and unrelated visual boundaries are fixture-owned.
const fixture = (options = {}) => build({ locale: 'en', disableTransitions: true, assertNoWarnings: true, ...options })
const node = (h, id) => h.find(value => value.props?.['data-testid'] === id)
const text = value => value ? (value.text || '') + (value.children || []).map(text).join('') : ''
const stop = h => node(h, 'stop-simulation')
const report = h => node(h, 'generate-report')
const click = button => { assert.equal(button?.type, 'button'); assert.equal(typeof button.props.onClick, 'function'); return button.props.onClick }
const child = h => h.state(runChild)
const parent = h => h.state(runView)
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const response = (runner_status = 'running', platform = 'twitter') => ok({ runner_status, ...(platform ? { platform } : {}) })
const detail = id => ok({ all_actions: id ? [{ id, timestamp: '2026-10-15T00:00:00Z', platform: 'twitter', agent_id: 1, agent_name: 'Fixture', action_type: 'CREATE_POST', action_args: { content: id } }] : [] })
const visibleLog = (h, message) => {
  assert.ok(parent(h).systemLogs.some(log => log.msg === message), 'the current parent owns the log')
  assert.ok(text(h.host).includes(message), 'the log is rendered in the child monitor')
}
async function running(h, status = 'running', platform = 'twitter') {
  await h.mount('/simulation/A/start')
  pending(h, 'startSimulation').resolve(response(status, platform)); await settle()
}
async function status(h, value) {
  await h.tick(2000)
  pending(h, 'getRunStatus').resolve(response(value)); await settle()
}
async function failed(h) {
  await running(h); await status(h, 'failed')
  pending(h, 'getRunStatusDetail').resolve(detail()); await settle()
}
async function select(h, id) {
  await h.navigate('/simulation/' + id + '/start')
  assert.equal(pending(h, 'startSimulation').args[0].simulation_id, id)
  pending(h, 'startSimulation').resolve(response()); await settle()
}

// The identical test is the sole unchanged-main witness. It must fail at the
// reachability assertion, rather than at fixture/import/setup preparation.
test('accepted startup renders a reachable native Stop control', async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A/start')
    assert.equal(stop(h), undefined)
    assert.equal(h.calls('startSimulation').length, 1)
    pending(h, 'startSimulation').resolve(response()); await settle()
    assert.ok(stop(h), 'Stop is reachable after accepted startup')
    assert.equal(stop(h).type, 'button'); assert.equal(stop(h).props.type, 'button')
    assert.equal(stop(h).props.disabled, false)
    assert.equal(text(stop(h)), 'Stop simulation')
    visibleLog(h, h.i18n.global.t('log.step3Init'))
    click(stop(h))(); await settle()
    assert.equal(h.calls('stopSimulation').length, 1)
    assert.equal(h.calls('stopSimulation')[0].args[0].simulation_id, 'A')
  } finally { h.close() }
})

test('clearing the child selection hides Stop and leaves captured callbacks inactive', async () => {
  const h = fixture()
  try {
    await running(h); const old = click(stop(h))
    h.child(runChild).props.simulationId = undefined; await settle()
    assert.equal(stop(h), undefined); assert.equal(child(h).phase, 0)
    old(); await settle()
    assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(h.calls('startSimulation').length, 1)
  } finally { h.close() }
})

for (const outcome of ['refused', 'rejected']) test(`startup ${outcome} never exposes Stop or report admission`, async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A/start')
    if (outcome === 'rejected') pending(h, 'startSimulation').reject(new Error('startup unavailable'))
    else pending(h, 'startSimulation').resolve({ success: false, error: 'startup refused' })
    await settle()
    assert.equal(stop(h), undefined); assert.equal(child(h).phase, 0)
    assert.equal(report(h).props.disabled, true)
    click(report(h))(); await settle()
    assert.equal(h.calls('generateReport').length, 0)
    assert.equal(h.calls('stopSimulation').length, 0)
  } finally { h.close() }
})

for (const observed of ['starting', 'running', 'paused', 'stopping', 'legacy']) test(`accepted ${observed} run remains eligible for Stop`, async () => {
  const h = fixture()
  try {
    await running(h, observed === 'legacy' ? 'running' : observed, observed === 'legacy' ? null : 'twitter')
    if (observed !== 'legacy') await status(h, observed)
    assert.equal(stop(h)?.props.disabled, false)
    click(stop(h))(); await settle()
    assert.equal(h.calls('stopSimulation').length, 1)
    assert.equal(child(h).phase, 1)
  } finally { h.close() }
})

for (const terminal of ['failed', 'completed', 'stopped']) test(`authoritative ${terminal} status sets the rendered Stop eligibility`, async () => {
  const h = fixture()
  try {
    await running(h); const old = click(stop(h)); await status(h, terminal)
    assert.equal(child(h).phase, 2)
    assert.equal(parent(h).currentStatus, terminal === 'failed' ? 'error' : 'completed')
    if (terminal === 'failed') {
      assert.equal(stop(h)?.props.disabled, false)
      click(stop(h))(); await settle(); assert.equal(h.calls('stopSimulation').length, 1)
    } else {
      assert.equal(stop(h), undefined)
      old(); await settle(); assert.equal(h.calls('stopSimulation').length, 0)
    }
  } finally { h.close() }
})

test('two same-turn rendered Stop clicks share one pending request and busy control', async () => {
  const h = fixture()
  try {
    await running(h); const action = click(stop(h))
    const first = action(), second = action()
    assert.equal(first, second); await settle()
    assert.equal(h.calls('stopSimulation').length, 1)
    assert.equal(stop(h).props.disabled, true)
    assert.equal(stop(h).props['aria-busy'], true)
    assert.equal(text(stop(h)), 'Requesting stop…')
    action(); await settle(); assert.equal(h.calls('stopSimulation').length, 1)
    assert.equal(child(h).phase, 1); assert.equal(parent(h).statusText, 'Running')
  } finally { h.close() }
})

for (const outcome of ['refused', 'pending', 'rejected']) test(`Stop ${outcome} preserves the run and permits one explicit retry`, async () => {
  const h = fixture()
  try {
    await running(h); click(stop(h))(); await settle()
    const request = pending(h, 'stopSimulation'), failure = 'fixture ' + outcome
    if (outcome === 'rejected') request.reject(new Error(failure))
    else request.resolve({ success: false, pending: outcome === 'pending', error: failure })
    await settle()
    assert.equal(child(h).phase, 1); assert.equal(parent(h).statusText, 'Running')
    assert.equal(stop(h).props.disabled, false); assert.equal(stop(h).props['aria-busy'], false)
    assert.equal(h.calls('stopSimulation').length, 1, 'settlement never retries automatically')
    visibleLog(h, h.i18n.global.t(outcome === 'rejected' ? 'log.stopException' : 'log.stopFailed', { error: failure }))
    assert.deepEqual([...h.intervals.values()].map(timer => timer.ms).sort((a, b) => a - b), [2000, 3000, 30000])
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.calls('getRunStatus').length, 1); assert.equal(h.calls('getRunStatusDetail').length, 1)
    click(stop(h))(); await settle(); assert.equal(h.calls('stopSimulation').length, 2)
    assert.equal(h.calls('startSimulation').length, 1)
  } finally { h.close() }
})

test('accepted Stop projects Completed and waits for a fresh final action snapshot', async () => {
  const h = fixture()
  try {
    await running(h); await h.tick(3000)
    const staleDetail = pending(h, 'getRunStatusDetail')
    click(stop(h))(); await settle()
    pending(h, 'stopSimulation').resolve(response('stopped')); await settle()
    assert.equal(stop(h), undefined); assert.equal(child(h).phase, 2)
    assert.equal(parent(h).statusText, 'Completed')
    assert.ok(text(h.host).includes('Completed'))
    visibleLog(h, h.i18n.global.t('log.simStoppedSuccess'))
    assert.equal(h.intervals.size, 0); assert.equal(staleDetail.signal.aborted, true)
    assert.equal(h.calls('getRunStatusDetail').length, 1)
    staleDetail.resolve(detail('obsolete preview')); await settle()
    assert.equal(child(h).allActions.length, 0)
    assert.equal(h.calls('getRunStatusDetail').length, 2)
    pending(h, 'getRunStatusDetail').resolve(detail('final action')); await settle()
    assert.deepEqual(Array.from(child(h).allActions, action => action.id), ['final action'])
    assert.ok(text(h.host).includes('final action'))
    assert.equal(report(h).props.disabled, false)
  } finally { h.close() }
})

test('failed-run Stop success without data hides Stop while phase stays two', async () => {
  const h = fixture()
  try {
    await failed(h); assert.equal(child(h).phase, 2); assert.equal(child(h).runStatus.runner_status, 'failed')
    click(stop(h))(); await settle(); pending(h, 'stopSimulation').resolve({ success: true }); await settle()
    assert.equal(child(h).phase, 2); assert.equal(child(h).runStatus.runner_status, 'failed')
    assert.equal(stop(h), undefined); assert.equal(parent(h).statusText, 'Completed')
    assert.equal(h.calls('startSimulation').length, 1)
    assert.equal(h.calls('getRunStatusDetail').length, 2)
    assert.equal(report(h).props.disabled, false)
  } finally { h.close() }
})

for (const first of ['stop', 'report']) test(`same-turn ${first} first excludes the opposing failed-run action`, async () => {
  const h = fixture()
  try {
    await failed(h); const stopAction = click(stop(h)), reportAction = click(report(h))
    if (first === 'stop') { stopAction(); reportAction() } else { reportAction(); stopAction() }
    await settle()
    assert.equal(h.calls('stopSimulation').length, first === 'stop' ? 1 : 0)
    assert.equal(h.calls('generateReport').length, first === 'report' ? 1 : 0)
    assert.equal(stop(h).props.disabled, true); assert.equal(report(h).props.disabled, true)
    const firstName = first === 'stop' ? 'stopSimulation' : 'generateReport'
    pending(h, firstName).resolve({ success: false, error: 'first request refused' }); await settle()
    assert.equal(stop(h).props.disabled, false); assert.equal(report(h).props.disabled, false)
    if (first === 'stop') reportAction(); else stopAction()
    await settle()
    assert.equal(h.calls('stopSimulation').length, 1); assert.equal(h.calls('generateReport').length, 1)
    assert.equal(h.calls('startSimulation').length, 1)
  } finally { h.close() }
})

test('accepted report keeps captured and newly rendered Stop callbacks inactive', async () => {
  const h = fixture()
  try {
    await failed(h); const old = click(stop(h))
    h.router.beforeEach(to => to.name === 'Report' ? false : undefined)
    click(report(h))(); await settle()
    pending(h, 'generateReport').resolve(ok({ report_id: 'report-A' })); await settle()
    assert.equal(parent(h).reportHandoff.receipt.reportId, 'report-A')
    assert.equal(stop(h).props.disabled, true)
    old(); click(stop(h))(); await settle()
    assert.equal(h.calls('stopSimulation').length, 0); assert.equal(h.calls('generateReport').length, 1)
    assert.equal(h.router.currentRoute.value.name, 'SimulationRun')
  } finally { h.close() }
})

for (const outcome of ['success', 'rejection']) test(`A to B to A retires captured Stop actions and old ${outcome}`, async () => {
  const h = fixture()
  try {
    await running(h); const oldA = click(stop(h)); oldA(); await settle()
    const oldRequest = pending(h, 'stopSimulation')
    await select(h, 'B'); const oldB = click(stop(h))
    await select(h, 'A'); const current = click(stop(h))
    oldA(); oldB(); await settle(); assert.equal(h.calls('stopSimulation').length, 1)
    current(); await settle(); assert.equal(h.calls('stopSimulation').length, 2)
    const logs = JSON.stringify(parent(h).systemLogs)
    if (outcome === 'success') oldRequest.resolve(response('stopped'))
    else oldRequest.reject(new Error('retired A Stop'))
    await settle()
    assert.equal(oldRequest.signal.aborted, true)
    assert.equal(parent(h).statusText, 'Running'); assert.equal(child(h).phase, 1)
    assert.equal(stop(h).props.disabled, true); assert.equal(child(h).isStopping, true)
    assert.equal(JSON.stringify(parent(h).systemLogs), logs)
    pending(h, 'stopSimulation').resolve({ success: true }); await settle()
    assert.equal(parent(h).statusText, 'Completed'); assert.equal(stop(h), undefined)
  } finally { h.close() }
})

for (const outcome of ['success', 'rejection']) test(`unmount retires rendered Stop callbacks and pending ${outcome}`, async () => {
  const h = fixture()
  try {
    await running(h); const old = click(stop(h)); old(); await settle()
    const request = pending(h, 'stopSimulation'); h.close()
    const logs = JSON.stringify(parent(h).systemLogs), oldStatus = parent(h).currentStatus
    old()
    if (outcome === 'success') request.resolve(response('stopped'))
    else request.reject(new Error('unmounted Stop'))
    await settle()
    assert.equal(h.calls('stopSimulation').length, 1); assert.equal(request.signal.aborted, true)
    assert.equal(parent(h).currentStatus, oldStatus); assert.equal(JSON.stringify(parent(h).systemLogs), logs)
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

test('real aborted leave renews Stop and projects its successful parent outcome', async () => {
  const h = fixture(); let release
  try {
    await running(h); const old = click(stop(h))
    const reads = h.calls('getSimulation').length
    h.router.beforeEach(to => to.path === '/' ? new Promise(resolve => { release = resolve }) : undefined)
    const navigation = h.router.push('/'); await settle()
    assert.equal(typeof release, 'function'); assert.equal(stop(h).props.disabled, true)
    old(); click(stop(h))(); await settle(); assert.equal(h.calls('stopSimulation').length, 0)
    release(false); await navigation; await settle()
    const fresh = click(stop(h)); assert.notEqual(fresh, old)
    old(); await settle(); assert.equal(h.calls('stopSimulation').length, 0)
    assert.equal(stop(h).props.disabled, false); fresh(); await settle()
    pending(h, 'stopSimulation').resolve({ success: true }); await settle()
    assert.equal(parent(h).statusText, 'Completed'); assert.ok(text(h.host).includes('Completed'))
    visibleLog(h, h.i18n.global.t('log.simStoppedSuccess'))
    assert.equal(stop(h), undefined); assert.equal(h.calls('getRunStatusDetail').length, 1)
    pending(h, 'getRunStatusDetail').resolve(detail('recovered final action')); await settle()
    assert.ok(text(h.host).includes('recovered final action'))
    assert.equal(h.calls('getSimulation').length, reads, 'recovery does not restart metadata')
    assert.equal(h.intervals.size, 0)
  } finally { release?.(false); h.close() }
})

test('real aborted leave preserves visible current Stop rejection and explicit retry', async () => {
  const h = fixture()
  try {
    await running(h)
    h.router.beforeEach(to => to.path === '/' ? false : undefined)
    await h.navigate('/')
    click(stop(h))(); await settle(); pending(h, 'stopSimulation').reject(new Error('recovered failure')); await settle()
    visibleLog(h, h.i18n.global.t('log.stopException', { error: 'recovered failure' }))
    assert.equal(parent(h).statusText, 'Running'); assert.equal(stop(h).props.disabled, false)
    click(stop(h))(); await settle(); assert.equal(h.calls('stopSimulation').length, 2)
    assert.equal(h.calls('getSimulation').length, 1)
    assert.ok(![...h.intervals.values()].some(timer => timer.ms === 30000))
  } finally { h.close() }
})

test('an already-dispatched Stop result survives parent action renewal', async () => {
  const h = fixture()
  try {
    await running(h); const old = click(stop(h)); old(); await settle()
    const request = pending(h, 'stopSimulation')
    h.router.beforeEach(to => to.path === '/' ? false : undefined)
    await h.navigate('/')
    assert.notEqual(click(stop(h)), old)
    request.resolve({ success: true }); await settle()
    assert.equal(parent(h).statusText, 'Completed'); assert.equal(stop(h), undefined)
    visibleLog(h, h.i18n.global.t('log.simStoppedSuccess'))
    assert.equal(h.calls('stopSimulation').length, 1)
  } finally { h.close() }
})

// Deliberately inject retirement at the real parent's guard boundary before
// singleFlight's microtask. Separate tests above use real router guard timing.
for (const action of ['stop', 'report']) test(`direct guard-boundary retirement fences deferred ${action} dispatch`, async () => {
  const h = fixture()
  try {
    await failed(h)
    const old = click(action === 'stop' ? stop(h) : report(h))
    old()
    const to = { name: 'Home', path: '/', fullPath: '/' }
    parent(h).suspendReport(to)
    await settle()
    assert.equal(h.calls('stopSimulation').length, 0); assert.equal(h.calls('generateReport').length, 0)
    parent(h).recoverReport(to); await settle()
    old(); await settle()
    assert.equal(h.calls('stopSimulation').length, 0); assert.equal(h.calls('generateReport').length, 0)
    click(action === 'stop' ? stop(h) : report(h))(); await settle()
    assert.equal(h.calls(action === 'stop' ? 'stopSimulation' : 'generateReport').length, 1)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test(`${locale} Stop copy and native accessibility properties render consistently`, async () => {
  const h = fixture({ locale })
  const expected = locale === 'en'
    ? ['Stop simulation', 'Requesting stop…', 'Requests an end to this simulation. Stopping may take time, and the recorded run may be partial.']
    : ['停止模拟', '正在请求停止…', '请求结束本次模拟。停止可能需要一些时间，已记录的模拟结果可能不完整。']
  try {
    await running(h)
    assert.equal(text(stop(h)), expected[0]); assert.equal(stop(h).props.type, 'button')
    assert.equal(stop(h).props['aria-busy'], false); assert.equal(stop(h).props.disabled, false)
    const id = stop(h).props['aria-describedby']
    const note = h.find(value => value.props?.id === id)
    assert.equal(note?.type, 'p'); assert.equal(text(note), expected[2])
    assert.notEqual(note.parent, stop(h).parent, 'the explanation sits outside the action controls')
    click(stop(h))(); await settle()
    assert.equal(text(stop(h)), expected[1]); assert.equal(stop(h).props['aria-busy'], true)
    assert.equal(stop(h).props.disabled, true); assert.equal(text(note), expected[2])
  } finally { h.close() }
})
