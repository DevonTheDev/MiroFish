import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Real Vue and D3 with the existing synthetic DOM. Every redraw below happens
// after wheel idle; these cases do not establish active-gesture or browser behavior.
const graph = (graph_id = 'viewport-A', nodes = [
  { uuid: 'one', name: 'One', labels: ['Entity'], attributes: { count: 0 } },
]) => ({ graph_id, nodes, edges: [], node_count: nodes.length, edge_count: 0 })
const rootGroup = svg => svg.children.find(child => child.type === 'g')
const transform = svg => {
  const { x, y, k } = d3.zoomTransform(svg)
  return { x, y, k }
}

async function completedWheel(svg, group, expectedScale) {
  assert.equal(svg.__zooming, undefined, 'the wheel starts an independent gesture')
  const event = { type: 'wheel', currentTarget: svg, pageX: 400, pageY: 300,
    deltaY: -500, deltaMode: 0, ctrlKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.stopped = true } }
  svg.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(d3.zoomTransform(svg).k, expectedScale)
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(svg).toString())
  const gesture = svg.__zooming
  assert.ok(gesture, 'the real D3 wheel gesture started')
  assert.equal(gesture.active, 1)
  assert.ok(gesture.wheel)
  await delay(200)
  assert.equal(svg.__zooming, undefined, 'redraw excludes an active wheel gesture')
  assert.equal(gesture.active, 0)
  assert.equal(gesture.wheel, null)
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(svg).toString())
}

async function zoomedGraph(t) {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg'), group = rootGroup(svg)
  assert.ok(group)
  assert.equal(svg.querySelectorAll('circle').length, 1)
  assert.deepEqual(transform(svg), { x: 0, y: 0, k: 1 })
  await completedWheel(svg, group, 2)
  assert.deepEqual(transform(svg), { x: -400, y: -300, k: 2 })
  return { h, svg, group }
}

function preservedRedraw(t, { h, svg, group }) {
  const replacement = rootGroup(svg)
  assert.strictEqual(h.find('.graph-svg'), svg, 'the SVG element is retained')
  assert.ok(replacement)
  assert.notStrictEqual(replacement, group, 'redraw replaces the root group')
  assert.equal(group.parentNode, null, 'the old root group is detached')
  assert.equal(svg.querySelectorAll('circle').length, 1)
  assert.deepEqual(transform(svg), { x: -400, y: -300, k: 2 })
  assert.equal(svg.__zooming, undefined, 'redraw starts no gesture')
  assert.equal(replacement.getAttribute('transform'), d3.zoomTransform(svg).toString(),
    'the replacement group preserves the completed viewport')
  t.diagnostic(JSON.stringify({ svgRetained: true, groupReplaced: true,
    groupTransform: replacement.getAttribute('transform'), svgTransform: transform(svg), activeGesture: false }))
  return replacement
}

test('completed wheel then resize preserves the viewport', { timeout: 10000 }, async t => {
  const state = await zoomedGraph(t)
  state.h.resize()
  await settle()
  preservedRedraw(t, state)
})

test('completed wheel then same-ID load preserves the viewport for the next independent gesture', { timeout: 10000 }, async t => {
  const state = await zoomedGraph(t)
  await state.h.load(graph())
  const replacement = preservedRedraw(t, state)
  const retiredTransform = state.group.getAttribute('transform')
  await completedWheel(state.svg, replacement, 4)
  assert.deepEqual(transform(state.svg), { x: -1200, y: -900, k: 4 })
  assert.equal(state.group.getAttribute('transform'), retiredTransform,
    'the next independent gesture leaves the detached group unchanged')
})

test('different graph ID retains the viewport of the reused SVG', { timeout: 10000 }, async t => {
  const state = await zoomedGraph(t)
  await state.h.load(graph('viewport-B'))
  preservedRedraw(t, state)
})

test('zero-node data retains the viewport for the next populated redraw', { timeout: 10000 }, async t => {
  const state = await zoomedGraph(t)
  await state.h.load(graph('viewport-A', []))
  assert.strictEqual(state.h.find('.graph-svg'), state.svg)
  assert.equal(rootGroup(state.svg), undefined)
  assert.equal(state.svg.querySelectorAll('circle').length, 0)
  assert.deepEqual(transform(state.svg), { x: -400, y: -300, k: 2 })
  assert.equal(state.svg.__zooming, undefined)
  await state.h.load(graph())
  preservedRedraw(t, state)
})

test('settled null data replaces the SVG and starts at identity', { timeout: 10000 }, async t => {
  const state = await zoomedGraph(t)
  await state.h.load(null)
  assert.equal(state.h.find('.graph-svg'), null)
  await state.h.load(graph())
  const svg = state.h.find('.graph-svg'), group = rootGroup(svg)
  assert.notStrictEqual(svg, state.svg)
  assert.ok(group)
  assert.equal(svg.querySelectorAll('circle').length, 1)
  assert.deepEqual(transform(svg), { x: 0, y: 0, k: 1 })
  assert.equal(group.getAttribute('transform'), d3.zoomIdentity.toString())
  assert.equal(svg.__zooming, undefined)
  t.diagnostic(JSON.stringify({ svgReplaced: true,
    groupTransform: group.getAttribute('transform'), svgTransform: transform(svg), activeGesture: false }))
})

test('selecting a node after redraw keeps the retained viewport', { timeout: 10000 }, async t => {
  const state = await zoomedGraph(t)
  state.h.resize()
  await settle()
  const replacement = preservedRedraw(t, state)
  await state.h.select('one')
  assert.deepEqual(state.h.properties(), { count: '0' })
  assert.equal(replacement.querySelector('circle').getAttribute('stroke'), '#E91E63')
  assert.deepEqual(transform(state.svg), { x: -400, y: -300, k: 2 })
  assert.equal(replacement.getAttribute('transform'), d3.zoomTransform(state.svg).toString())
  assert.equal(state.svg.__zooming, undefined)
})
