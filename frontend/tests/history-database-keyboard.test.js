import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedSimulations, deferredApi, flush, ok } from './helpers/saved-simulations-view-fixture.js'

// Compiled-component tests in an opt-in synthetic focus contract. These do not
// prove native keyboard defaults, tab order, screen-reader behavior or layout.
const record = (id, requirement = 'Saved scenario', extra = {}) => ({ simulation_id: id,
  project_id: `project_${id}`, report_id: `report_${id}`, simulation_requirement: requirement,
  created_at: '2026-10-01T10:00:00Z', files: [], ...extra })
const hasClass = (node, name) => String(node.props.class).split(' ').includes(name)
const cards = h => h.all(node => hasClass(node, 'project-card'))
const dialog = h => h.find(node => hasClass(node, 'modal-content'))
const overlay = h => h.find(node => hasClass(node, 'modal-overlay'))
const close = h => h.find(node => hasClass(node, 'modal-close'))
const history = h => h.find(node => hasClass(node, 'history-database'))
function event(target, key, extra = {}) {
  return { target, currentTarget: target, key, repeat: false, isComposing: false,
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    prevented: 0, stopped: 0, preventDefault() { this.prevented++ }, stopPropagation() { this.stopped++ }, ...extra }
}
function fire(target, prop, key, extra) {
  assert.equal(typeof target.props[prop], 'function', `compiled template must bind ${prop}`)
  const e = event(target, key, extra); target.props[prop](e); return e
}
const press = card => fire(card, 'onKeydown', 'Enter')
const click = (target, actualTarget = target) => fire(target, 'onClick', undefined, { target: actualTarget })
const same = (actual, expected, message = 'expected exact host element identity') => assert.ok(actual === expected, message)
async function setup(t, { locale = 'en', keepAlive = false, cacheHandlers = false,
  records = [record('sim_exact_FIRST'), record('sim_exact_SECOND', 'Second scenario')] } = {}) {
  const d = deferredApi()
  const h = await mountSavedSimulations({ api: d.api, initialPath: '/', locale, keepAlive, cacheHandlers, focusContract: true })
  t.after(() => {
    h.unmount()
    assert.equal(h.focus.listenerCount(), 0, 'unmount must release document focus ownership')
    assert.equal(d.calls.getComparisonCandidates.length, 0)
    assert.equal(h.networkCalls.length, 0); assert.equal(h.storageWrites.length, 0); assert.equal(h.downloads.length, 0)
    assert.deepEqual(h.warnings, [], 'unexpected compiled component warning')
    for (const request of d.calls.getSimulationHistory) assert.deepEqual(request.args, [20])
  })
  assert.equal(d.calls.getSimulationHistory.length, 1)
  d.calls.getSimulationHistory[0].resolve(ok(records)); await flush()
  return { h, ...d, records }
}
async function dismiss(h) { click(close(h)); await flush(); h.focus.completeLeave(h.focus.leaves.length - 1) }
function assertControlled(e, prevented, stopped) { assert.equal(e.prevented, prevented); assert.equal(e.stopped, stopped) }

// This control passes on the baseline: the host really connects the actual
// compiled card/dialog nodes and can deliver focus and leave callbacks.
test('opt-in host connects compiled refs and provides an explicit synthetic focus surface', async t => {
  const { h } = await setup(t)
  const card = cards(h)[0]
  assert.ok(card.isConnected); assert.ok(history(h).contains(card))
  same(card.ownerDocument, h.focus.document)
  assert.equal(typeof card.focus, 'function'); assert.equal(typeof card.contains, 'function')
  click(card); await flush()
  const content = dialog(h)
  assert.ok(content.isConnected); assert.ok(h.body.contains(content))
  same(content.ownerDocument, h.focus.document)
  assert.equal(content.querySelectorAll('button:not([disabled])').length, 9)
  click(close(h)); await flush()
  assert.equal(h.focus.leaves.length, 1)
  assert.equal(h.focus.leaves[0].element.type, 'div')
})

test('pointer-opened compiled dialog declares its semantics independently of card keyboard support', async t => {
  const { h } = await setup(t)
  click(cards(h)[0]); await flush()
  assert.equal(dialog(h).props.role, 'dialog')
  assert.equal(dialog(h).props['aria-modal'], 'true')
  assert.equal(dialog(h).props.tabindex, '-1')
})

test('compiled card tabindex declaration is checked independently of its role', async t => {
  const { h } = await setup(t)
  for (const card of cards(h)) assert.equal(card.props.tabindex, '0')
})

test('compiled card accessible name is checked independently of its role and tabindex', async t => {
  const { h, records } = await setup(t)
  for (let i = 0; i < records.length; i++) {
    const name = cards(h)[i].props['aria-label']
    assert.equal(typeof name, 'string')
    assert.ok(name.includes(records[i].simulation_id))
  }
})

test('connected pointer-opened dialog must acquire initial focus and a removable containment listener', async t => {
  const { h } = await setup(t)
  const opener = cards(h)[0]
  assert.ok(opener.isConnected); same(opener.ownerDocument, h.focus.document)
  click(opener); await flush()
  const content = dialog(h)
  assert.ok(content.isConnected); same(content.ownerDocument, h.focus.document)
  same(h.focus.document.activeElement, content)
  assert.equal(h.focus.listenerCount(), 1)
  click(close(h)); assert.equal(h.focus.listenerCount(), 0); await flush()
  h.focus.completeLeave(h.focus.leaves.length - 1)
  same(h.focus.document.activeElement, opener)
})

for (const locale of ['en', 'zh']) {
  test(`compiled cards and details expose localized names and exact inert IDs (${locale})`, async t => {
    const records = [record('sim_<svg onload=1>_Exact-ID', '<b>Saved</b>'), record('sim_SECOND_FULL_ID', '', { project_id: null, report_id: null })]
    const { h } = await setup(t, { locale, records })
    assert.equal(cards(h).length, 2)
    for (let i = 0; i < records.length; i++) {
      const card = cards(h)[i]
      assert.equal(card.type, 'div'); assert.equal(card.props.role, 'button'); assert.equal(card.props.tabindex, '0')
      assert.equal(card.props['aria-haspopup'], 'dialog')
      assert.ok(card.props['aria-label'].includes(records[i].simulation_id))
      const title = h.find(node => card.contains(node) && hasClass(node, 'card-title'))
      assert.ok(card.props['aria-label'].includes(h.text(title)), 'label retains the localized title fallback/truncation')
      assert.doesNotMatch(card.props['aria-label'], /history\.openDetails/)
      assert.equal(h.all(node => node.type === 'svg' || node.type === 'b').length, 0, 'markup stays inert text')
    }
    assert.match(cards(h)[0].props['aria-label'], /<b>Saved<\/b>/)
    assert.match(cards(h)[0].props['aria-label'], locale === 'en' ? /^Open simulation details:/ : /^打开模拟详情：/)
    press(cards(h)[1]); await flush()
    const content = dialog(h)
    assert.equal(content.props.role, 'dialog'); assert.equal(content.props['aria-modal'], 'true'); assert.equal(content.props.tabindex, '-1')
    assert.ok(content.props['aria-label'].includes(records[1].simulation_id))
    assert.match(content.props['aria-label'], locale === 'en' ? /^Simulation details:/ : /^模拟详情：/)
    assert.equal(content.props['aria-describedby'], undefined)
    assert.equal(close(h).props['aria-label'], locale === 'en' ? 'Close' : '关闭')
    assert.equal(close(h).props.type, 'button')
    const buttons = h.all(node => content.contains(node) && node.type === 'button')
    assert.equal(buttons.length, 9)
    for (const button of buttons) assert.equal(button.props.type, 'button')
    assert.equal(buttons.filter(button => button.props.disabled).length, 3)
    assert.doesNotMatch(h.text(content), /history\.|comparison\.|runCaptures\.|saved(Activity|Interviews)\./)
    assert.equal(h.router.currentRoute.value.fullPath, '/')
  })
}

test('Enter activates once, ignores repeat and descendants, and preserves pointer selection', async t => {
  const { h, calls } = await setup(t)
  const [first, second] = cards(h)
  assertControlled(press(first), 1, 1)
  assertControlled(fire(first, 'onKeydown', 'Enter', { repeat: true }), 1, 1)
  press(second); await flush()
  assert.ok(h.text(dialog(h)).includes('Saved scenario'), 'selection remains idempotent while open')
  assert.equal(h.all(node => hasClass(node, 'modal-content')).length, 1)
  await dismiss(h)
  assertControlled(fire(second, 'onKeydown', 'Enter', { target: second.children[0] }), 0, 0)
  assert.equal(dialog(h), undefined)
  click(second, second.children[0]); await flush()
  assert.match(h.text(dialog(h)), /Second scenario/)
  assert.equal(calls.getSimulationHistory.length, 1)
  assert.equal(h.router.currentRoute.value.fullPath, '/')
})

test('Space arms on down, opens once on matching up, and cancels blur or another card', async t => {
  const { h } = await setup(t)
  const [first, second] = cards(h)
  assertControlled(fire(first, 'onKeyup', ' '), 0, 0)
  assertControlled(fire(first, 'onKeydown', ' '), 1, 0)
  assertControlled(fire(first, 'onKeydown', ' ', { repeat: true }), 1, 0)
  await flush(); assert.equal(dialog(h), undefined)
  assertControlled(fire(first, 'onKeyup', ' '), 0, 0); await flush()
  assert.ok(dialog(h)); await dismiss(h)
  fire(first, 'onKeyup', ' '); await flush(); assert.equal(dialog(h), undefined)
  fire(first, 'onKeydown', ' '); fire(first, 'onBlur'); fire(first, 'onKeyup', ' '); await flush()
  assert.equal(dialog(h), undefined)
  fire(first, 'onKeydown', ' '); fire(second, 'onKeyup', ' '); fire(first, 'onKeyup', ' '); await flush()
  assert.equal(dialog(h), undefined)
  fire(first, 'onKeydown', ' '); fire(second, 'onKeydown', 'x'); fire(first, 'onKeyup', ' '); await flush()
  assert.equal(dialog(h), undefined)
  fire(first, 'onKeydown', ' '); click(second); await flush(); await dismiss(h)
  fire(first, 'onKeyup', ' '); await flush(); assert.equal(dialog(h), undefined)
})

test('modified and composing activations clear armed Space and keep shortcut defaults', async t => {
  const { h } = await setup(t)
  const card = cards(h)[0]
  for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
    for (const key of ['Enter', ' ']) {
      fire(card, 'onKeydown', ' ')
      assertControlled(fire(card, 'onKeydown', key, { [flag]: true }), 0, 0)
      assertControlled(fire(card, 'onKeyup', ' '), 0, 0)
      await flush(); assert.equal(dialog(h), undefined)
      fire(card, 'onKeydown', ' ')
      assertControlled(fire(card, 'onKeyup', ' ', { [flag]: true }), 0, 0)
      fire(card, 'onKeyup', ' '); await flush(); assert.equal(dialog(h), undefined)
    }
  }
  assertControlled(fire(card, 'onKeydown', 'x'), 0, 0)
  assertControlled(fire(card, 'onKeydown', ' ', { repeat: true }), 1, 0)
  fire(card, 'onKeyup', ' '); await flush(); assert.equal(dialog(h), undefined, 'repeat alone cannot arm')
})

test('synthetic initial focus, containment and live enabled-button Tab boundaries', async t => {
  const { h } = await setup(t, { records: [record('sim_disabled', 'Disabled replay', { project_id: null, report_id: null })] })
  const card = cards(h)[0]; press(card); await flush()
  const content = dialog(h), enabled = content.querySelectorAll('button:not([disabled])')
  assert.equal(h.focus.focusCalls.length, 1, 'initial focus must reach actual connected dialog ref'); same(h.focus.focusCalls[0].target, content)
  assert.equal(h.focus.focusCalls[0].options.preventScroll, true); assert.deepEqual(Object.keys(h.focus.focusCalls[0].options), ['preventScroll'])
  same(h.focus.document.activeElement, content); assert.equal(h.focus.listenerCount(), 1)
  assert.equal(enabled.length, 6)
  assertControlled(fire(content, 'onKeydown', 'Tab'), 1, 1)
  same(h.focus.document.activeElement, enabled[0])
  content.focus(); assertControlled(fire(content, 'onKeydown', 'Tab', { shiftKey: true }), 1, 1)
  same(h.focus.document.activeElement, enabled.at(-1))
  assertControlled(fire(content, 'onKeydown', 'Tab', { target: enabled.at(-1) }), 1, 1)
  same(h.focus.document.activeElement, enabled[0])
  assertControlled(fire(content, 'onKeydown', 'Tab', { target: enabled[0], shiftKey: true }), 1, 1)
  same(h.focus.document.activeElement, enabled.at(-1))
  enabled[1].focus(); assertControlled(fire(content, 'onKeydown', 'Tab', { target: enabled[1] }), 0, 0)
  assertControlled(fire(content, 'onKeydown', 'Tab', { target: enabled[1], shiftKey: true }), 0, 0)
  for (const flag of ['ctrlKey', 'altKey', 'metaKey']) assertControlled(fire(content, 'onKeydown', 'Tab', { [flag]: true }), 0, 0)
  assertControlled(fire(content, 'onKeydown', 'Tab', { isComposing: true }), 0, 0)
  card.focus(); same(h.focus.document.activeElement, content, 'outside focus is redirected to owned dialog')
  for (const button of h.all(node => content.contains(node) && node.type === 'button')) button.props.disabled = true
  assertControlled(fire(content, 'onKeydown', 'Tab'), 1, 1)
  same(h.focus.document.activeElement, content, 'no enabled button keeps container focus')
})

test('Close, Escape and exact backdrop dismissal remove focus listener and return once after leave', async t => {
  const { h } = await setup(t)
  const card = cards(h)[0]
  for (const method of ['close', 'escape', 'backdrop']) {
    press(card); await flush()
    const content = dialog(h), backdrop = overlay(h)
    for (const flag of ['repeat', 'ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
      assertControlled(fire(content, 'onKeydown', 'Escape', { [flag]: true }), 0, 0)
      assert.ok(dialog(h))
    }
    click(backdrop, content); click(backdrop, content.children[0]); await flush(); same(dialog(h), content)
    const before = h.focus.focusCalls.length
    if (method === 'close') click(close(h))
    if (method === 'escape') assertControlled(fire(content, 'onKeydown', 'Escape'), 1, 1)
    if (method === 'backdrop') click(backdrop)
    assert.equal(h.focus.listenerCount(), 0, 'dismiss removes listener synchronously')
    await flush(); assert.equal(dialog(h), undefined)
    assert.equal(h.focus.focusCalls.length, before, 'return waits for leave completion')
    const index = h.focus.leaves.length - 1
    same(h.focus.leaves[index].element, backdrop)
    h.focus.completeLeave(index); h.focus.completeLeave(index)
    assert.equal(h.focus.focusCalls.length, before + 1)
    same(h.focus.document.activeElement, card)
    assert.equal(h.focus.focusCalls.at(-1).options.preventScroll, true); assert.deepEqual(Object.keys(h.focus.focusCalls.at(-1).options), ['preventScroll'])
  }
})

test('queued open focus and stale leave callbacks cannot own a newer dialog session', async t => {
  const { h } = await setup(t, { cacheHandlers: true })
  const [first, second] = cards(h)
  press(first); await flush()
  const oldClose = close(h).props.onClick, oldFocus = h.focus.listenerLog.find(entry => entry.action === 'add').callback
  click(close(h)); await flush()
  const oldLeave = h.focus.leaves.length - 1
  press(second); await flush()
  const newer = dialog(h), count = h.focus.focusCalls.length
  h.focus.completeLeave(oldLeave); oldFocus({ target: first })
  assert.equal(h.focus.focusCalls.length, count)
  same(h.focus.document.activeElement, newer)
  await dismiss(h)
  const before = h.focus.focusCalls.length
  press(first); oldClose(event(first)); await flush()
  assert.equal(dialog(h), undefined); assert.equal(h.focus.listenerCount(), 0)
  assert.equal(h.focus.focusCalls.length, before, 'close before initial nextTick invalidates queued focus')
})

test('repeated Close during leave preserves one return and rejects a different overlay identity', async t => {
  const { h } = await setup(t)
  const card = cards(h)[0]; press(card); await flush()
  const closeButton = close(h), before = h.focus.focusCalls.length
  click(closeButton); click(closeButton); await flush()
  const leave = h.focus.leaves.at(-1)
  leave.callback(h.byId('history-simulations'))
  assert.equal(h.focus.focusCalls.length, before, 'wrong element cannot consume the pending return')
  h.focus.completeLeave(h.focus.leaves.length - 1)
  assert.equal(h.focus.focusCalls.length, before + 1, 'repeated dismissal must not discard the pending return')
  same(h.focus.document.activeElement, card)
})

test('a deferred Home refresh removing the opener returns to Browse all after leave', async t => {
  const { h, calls } = await setup(t, { keepAlive: true })
  await h.navigate('/reports'); await h.navigate('/')
  assert.equal(calls.getSimulationHistory.length, 2)
  const opener = cards(h)[0]
  press(opener); await flush()
  calls.getSimulationHistory[1].resolve(ok([])); await flush()
  assert.equal(opener.isConnected, false); assert.ok(dialog(h))
  await dismiss(h)
  same(h.focus.document.activeElement, h.byId('history-simulations'))
})

const routeActions = [
  ['btn-project', 'Process', 'projectId', 'project_sim_exact_FIRST'],
  ['btn-simulation', 'Simulation', 'simulationId', 'sim_exact_FIRST'],
  ['btn-report', 'Report', 'reportId', 'report_sim_exact_FIRST'],
  ['history-captures-selected', 'RunCaptures', 'simulation', 'sim_exact_FIRST'],
  ['history-saved-interviews', 'SavedInterviews', 'simulationId', 'sim_exact_FIRST'],
  ['history-saved-activity', 'SavedActivity', 'simulationId', 'sim_exact_FIRST'],
  ['history-compare-selected', 'SimulationComparison', 'left', 'sim_exact_FIRST'],
]
for (const [control, name, key, value] of routeActions) test(`selected ${name} action preserves exact route and retires focus without returning`, async t => {
  const { h, calls } = await setup(t, { keepAlive: true })
  const card = cards(h)[0]; press(card); await flush()
  const listener = h.focus.listenerLog.find(entry => entry.action === 'add').callback
  const retainedKey = card.props.onKeydown, content = dialog(h), retainedDialogKey = content.props.onKeydown
  const count = h.focus.focusCalls.length
  const button = h.byId(control) ?? h.find(node => hasClass(node, control))
  click(button); await flush()
  assert.equal(h.router.currentRoute.value.name, name)
  assert.equal(h.router.currentRoute.value.params[key] ?? h.router.currentRoute.value.query[key], value)
  assert.equal(h.focus.listenerCount(), 0); assert.equal(dialog(h), undefined)
  for (let i = 0; i < h.focus.leaves.length; i++) h.focus.completeLeave(i)
  listener({ target: card }); retainedKey(event(card, 'Enter')); retainedDialogKey(event(content, 'Tab')); await flush()
  assert.equal(h.focus.focusCalls.length, count); assert.equal(dialog(h), undefined)
  assert.equal(calls.getSimulationHistory.length, 1)
})

test('Back/Forward and KeepAlive activation retire old dialog callbacks and share only the existing refresh', async t => {
  const { h, calls } = await setup(t, { keepAlive: true, cacheHandlers: true })
  const card = cards(h)[0]; press(card); await flush()
  const retainedClick = card.props.onClick, retainedKey = card.props.onKeyup
  click(close(h)); await flush()
  const leave = h.focus.leaves.length - 1, count = h.focus.focusCalls.length
  await h.navigate('/reports')
  h.focus.completeLeave(leave); retainedClick(event(card)); retainedKey(event(card, ' ')); await flush()
  assert.equal(h.focus.focusCalls.length, count); assert.equal(dialog(h), undefined)
  await h.back(); assert.equal(h.router.currentRoute.value.fullPath, '/')
  assert.equal(calls.getSimulationHistory.length, 2); assert.equal(dialog(h), undefined)
  fire(cards(h)[0], 'onKeydown', ' ')
  await h.forward(); assert.equal(h.router.currentRoute.value.fullPath, '/reports')
  await h.back(); assert.equal(calls.getSimulationHistory.length, 2, 'pending route/activation refresh stays shared')
  fire(cards(h)[0], 'onKeyup', ' '); await flush(); assert.equal(dialog(h), undefined)
  await h.navigate('/reports'); calls.getSimulationHistory[1].resolve(ok([record('sim_late')])); await flush()
  assert.equal(h.focus.focusCalls.length, count); assert.equal(h.focus.listenerCount(), 0)
  await h.navigate('/'); assert.equal(calls.getSimulationHistory.length, 3); assert.equal(dialog(h), undefined)
})

test('unmount before queued initial focus leaves retained card handlers inert', async t => {
  const { h } = await setup(t)
  const card = cards(h)[0], retainedKey = card.props.onKeydown, retainedClick = card.props.onClick
  press(card); h.unmount(); await flush()
  assert.equal(h.focus.focusCalls.length, 0); assert.equal(h.focus.listenerCount(), 0)
  retainedKey(event(card, 'Enter')); retainedClick(event(card)); await flush()
  assert.equal(dialog(h), undefined); assert.equal(h.focus.focusCalls.length, 0)
})

test('unmount after open or dismissal invalidates retained focus, key and leave callbacks', async t => {
  const { h } = await setup(t)
  const card = cards(h)[0]; press(card); await flush()
  const content = dialog(h), key = content.props.onKeydown
  const listener = h.focus.listenerLog.find(entry => entry.action === 'add').callback
  click(close(h)); await flush()
  const count = h.focus.focusCalls.length, leave = h.focus.leaves.length - 1
  h.unmount(); listener({ target: card }); key(event(content, 'Tab')); h.focus.completeLeave(leave); await flush()
  assert.equal(h.focus.focusCalls.length, count); assert.equal(h.focus.listenerCount(), 0)
})
