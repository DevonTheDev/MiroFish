import assert from 'node:assert/strict'
import test from 'node:test'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Real Vue and D3 with the existing synthetic DOM. These wheel events do not
// establish native browser geometry, rendering, pan, touch or transitions.
const graph = (graph_id = 'active-A', nodes = [
  { uuid: 'one', name: 'One', labels: ['Entity'] },
]) => ({ graph_id, nodes, edges: [], node_count: nodes.length, edge_count: 0 })
const rootGroup = svg => svg.children.find(child => child.type === 'g')
const transform = svg => {
  const { x, y, k } = d3.zoomTransform(svg)
  return { x, y, k }
}

function wheel(svg, expectedScale, deltaY = -500) {
  const event = { type: 'wheel', currentTarget: svg, pageX: 400, pageY: 300,
    deltaY, deltaMode: 0, ctrlKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.stopped = true } }
  svg.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true, 'the real D3 wheel handler consumed the event')
  assert.equal(d3.zoomTransform(svg).k, expectedScale)
  assert.ok(svg.__zooming, 'a real D3 wheel gesture is active')
  assert.equal(svg.__zooming.active, 1)
  assert.ok(svg.__zooming.wheel)
  if ('_destroyed' in svg.__zooming.wheel) assert.equal(svg.__zooming.wheel._destroyed, false)
}

function retainedGesture(state) {
  assert.strictEqual(state.svg.__zooming, state.gesture, 'redraw retains the real active Gesture')
  assert.equal(state.gesture.active, 1)
  assert.strictEqual(state.gesture.wheel, state.timer, 'redraw does not replace the wheel idle timer')
  if ('_destroyed' in state.timer) assert.equal(state.timer._destroyed, false, 'the retained timer is still live')
}

async function activeGraph(t, options = {}) {
  const h = mountGraphPanel(t, { initialGraph: graph(), ...options })
  await settle()
  if (options.deferGraphRedraw) {
    const initial = h.takeRedraws()
    assert.equal(initial.length, 1)
    initial[0]()
  }
  const svg = h.find('.graph-svg'), group = rootGroup(svg)
  assert.ok(group)
  assert.equal(svg.__zooming, undefined)
  wheel(svg, 2)
  assert.deepEqual(transform(svg), { x: -400, y: -300, k: 2 })
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(svg).toString())
  return { h, svg, group, gesture: svg.__zooming, timer: svg.__zooming.wheel }
}

function replacement(state) {
  retainedGesture(state)
  assert.strictEqual(state.h.find('.graph-svg'), state.svg)
  const group = rootGroup(state.svg)
  assert.ok(group)
  assert.notStrictEqual(group, state.group)
  assert.equal(state.group.parentNode, null)
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(state.svg).toString())
  return group
}

function continueOnReplacement(t, state, group) {
  const oldTransform = state.group.getAttribute('transform')
  const timerRetainedThroughRedraw = state.gesture.wheel === state.timer
  const timerDestroyedBeforeContinuation = state.gesture.wheel._destroyed
  wheel(state.svg, 4)
  assert.strictEqual(state.svg.__zooming, state.gesture, 'the next wheel continues the original Gesture')
  assert.deepEqual(transform(state.svg), { x: -1200, y: -900, k: 4 })
  t.diagnostic(JSON.stringify({ svgTransform: transform(state.svg),
    currentGroupTransform: group.getAttribute('transform'),
    detachedGroupTransform: state.group.getAttribute('transform'),
    detachedGroupBefore: oldTransform, sameGesture: state.svg.__zooming === state.gesture,
    active: state.gesture.active, timerRetainedThroughRedraw,
    timerDestroyedBeforeContinuation, timerLive: Boolean(state.gesture.wheel),
    timerDestroyed: state.gesture.wheel._destroyed }))
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(state.svg).toString(),
    'the current group follows the retained active wheel Gesture')
  assert.equal(state.group.getAttribute('transform'), oldTransform,
    'the detached group stays unchanged')
}

test('active wheel survives resize and updates the replacement group', { timeout: 10000 }, async t => {
  const state = await activeGraph(t)
  state.h.resize()
  await settle()
  continueOnReplacement(t, state, replacement(state))
})

test('active wheel survives same-ID refresh and updates the replacement group', { timeout: 10000 }, async t => {
  const state = await activeGraph(t)
  await state.h.load(graph())
  continueOnReplacement(t, state, replacement(state))
})

test('active wheel survives changed-ID refresh on the same SVG', { timeout: 10000 }, async t => {
  const state = await activeGraph(t)
  await state.h.load(graph('active-B'))
  continueOnReplacement(t, state, replacement(state))
})

test('wheel while empty preserves the viewport for a populated replacement', { timeout: 10000 }, async t => {
  const state = await activeGraph(t)
  const oldTransform = state.group.getAttribute('transform')
  await state.h.load(graph('active-A', []))
  retainedGesture(state)
  assert.strictEqual(state.h.find('.graph-svg'), state.svg)
  assert.equal(rootGroup(state.svg), undefined)
  assert.equal(state.group.parentNode, null)
  wheel(state.svg, 1, 500)
  assert.strictEqual(state.svg.__zooming, state.gesture)
  assert.deepEqual(transform(state.svg), { x: 0, y: 0, k: 1 })
  assert.equal(state.group.getAttribute('transform'), oldTransform)
  state.timer = state.gesture.wheel
  await state.h.load(graph())
  const group = replacement(state)
  wheel(state.svg, 2)
  assert.strictEqual(state.svg.__zooming, state.gesture)
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(state.svg).toString())
  assert.equal(state.group.getAttribute('transform'), oldTransform)
})

test('fresh SVG starts at identity and late old-SVG wheel leaves groups unchanged', { timeout: 10000 }, async t => {
  const state = await activeGraph(t)
  const oldTransform = state.group.getAttribute('transform')
  await state.h.load(null)
  assert.equal(state.h.find('.graph-svg'), null)
  retainedGesture(state)
  await state.h.load(graph())
  const svg = state.h.find('.graph-svg'), group = rootGroup(svg)
  assert.notStrictEqual(svg, state.svg)
  assert.deepEqual(transform(svg), { x: 0, y: 0, k: 1 })
  assert.equal(group.getAttribute('transform'), d3.zoomIdentity.toString())
  assert.equal(svg.__zooming, undefined)
  retainedGesture(state)
  wheel(state.svg, 4)
  assert.strictEqual(state.svg.__zooming, state.gesture)
  assert.equal(state.group.getAttribute('transform'), oldTransform,
    'late old-SVG events cannot mutate its retired group')
  assert.deepEqual(transform(svg), { x: 0, y: 0, k: 1 })
  assert.equal(group.getAttribute('transform'), d3.zoomIdentity.toString())
  wheel(svg, 2)
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(svg).toString())
})

test('unmounted owner ignores late wheel while another owner remains independent', { timeout: 10000 }, async t => {
  const other = mountGraphPanel(t, { initialGraph: graph('other-owner') })
  await settle()
  const state = await activeGraph(t)
  const otherSvg = other.find('.graph-svg'), otherGroup = rootGroup(otherSvg)
  const oldTransform = state.group.getAttribute('transform')
  state.h.close()
  retainedGesture(state)
  wheel(state.svg, 4)
  assert.strictEqual(state.svg.__zooming, state.gesture)
  assert.equal(state.group.getAttribute('transform'), oldTransform)
  assert.deepEqual(transform(otherSvg), { x: 0, y: 0, k: 1 })
  assert.equal(otherGroup.getAttribute('transform'), d3.zoomIdentity.toString())
  wheel(otherSvg, 2)
  assert.equal(otherGroup.getAttribute('transform'), d3.zoomTransform(otherSvg).toString())
  assert.equal(state.group.getAttribute('transform'), oldTransform)
})

test('queued and repeated redraw keeps the attached group tracking until replacement', { timeout: 10000 }, async t => {
  const state = await activeGraph(t, { deferGraphRedraw: true })
  state.h.resize()
  const stale = state.h.takeRedraws()
  assert.equal(stale.length, 1)
  await state.h.load(graph('queued'))
  const latest = state.h.takeRedraws()
  assert.equal(latest.length, 1)
  retainedGesture(state)
  wheel(state.svg, 1, 500)
  assert.strictEqual(rootGroup(state.svg), state.group)
  assert.equal(state.group.getAttribute('transform'), d3.zoomTransform(state.svg).toString(),
    'a queued redraw must not reject updates to its still-attached group')
  const retiredTransform = state.group.getAttribute('transform')
  state.timer = state.gesture.wheel
  stale[0]()
  assert.strictEqual(rootGroup(state.svg), state.group)
  latest[0]()
  const middle = replacement(state)
  wheel(state.svg, 2)
  assert.equal(middle.getAttribute('transform'), d3.zoomTransform(state.svg).toString())
  assert.equal(state.group.getAttribute('transform'), retiredTransform)
  state.timer = state.gesture.wheel
  state.h.resize()
  const repeated = state.h.takeRedraws()
  assert.equal(repeated.length, 1)
  repeated[0]()
  retainedGesture(state)
  const current = rootGroup(state.svg), middleTransform = middle.getAttribute('transform')
  assert.notStrictEqual(current, middle)
  assert.equal(middle.parentNode, null)
  continueOnReplacement(t, state, current)
  assert.equal(middle.getAttribute('transform'), middleTransform)
})
