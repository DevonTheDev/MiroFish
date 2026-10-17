import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Real Vue and D3 with the existing synthetic host. Native browser layout,
// keyboard/focus, pointer geometry and drag behavior are not established here.
const rawNode = (uuid, name = 'Node') => ({ uuid, name, labels: ['Entity'], attributes: { count: 0 }, x: 999, y: 999 })
const graph = (nodes = [rawNode('one'), rawNode('two')], graph_id = 'center-A', edges = []) => ({
  graph_id, nodes, edges, node_count: nodes.length, edge_count: edges.length,
})
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const rootGroup = svg => svg.children.find(child => child.type === 'g')
const button = h => {
  const control = h.find('.graph-center-selected')
  assert.ok(control, 'node details expose the explicit Center selected node button')
  return control
}
const invoke = h => button(h).props.onClick()
const zoom = (h, command) => h.find(`.graph-zoom-${command}`).props.onClick()
const position = (h, index, x, y) => Object.assign(circles(h)[index].__data__, { x, y })
const transform = svg => {
  const { x, y, k } = d3.zoomTransform(svg)
  return { x, y, k }
}
const assertViewport = (svg, expected) => {
  assert.deepEqual(transform(svg), expected)
  assert.equal(rootGroup(svg).getAttribute('transform'), d3.zoomTransform(svg).toString())
}
const runRedraw = h => {
  const redraws = h.takeRedraws()
  assert.equal(redraws.length, 1)
  redraws[0]()
}
const select = async (h, index = 0) => { await h.click(circles(h)[index]); return button(h) }
function wheel(svg, deltaY = -500) {
  const event = { type: 'wheel', currentTarget: svg, pageX: 200, pageY: 150, clientX: 200, clientY: 150,
    deltaY, deltaMode: 0, ctrlKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.stopped = true } }
  svg.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true, 'real D3 consumes the wheel event')
}

for (const [locale, label] of [['en', 'Center selected node'], ['zh', '居中选中节点']]) {
  test(`${locale} Center is a localized native text button inside node details`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { initialGraph: graph(), messages })
    await settle()
    assert.equal(h.find('.graph-center-selected'), null)
    const control = await select(h)
    assert.equal(control.type, 'button')
    assert.equal(control.props.type, 'button')
    assert.equal(control.textContent, label)
    assert.equal(control.props.disabled, false)
    assert.strictEqual(h.find('.detail-content').querySelector('.graph-center-selected'), control)
    assert.equal(h.find('.header-tools').querySelectorAll('button').length, 6)
  })
}

test('pointer and search selection stay nonmoving until Center is explicitly invoked', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg')
  zoom(h, 'in')
  const before = d3.zoomTransform(svg)
  await select(h, 1)
  assert.strictEqual(d3.zoomTransform(svg), before)
  position(h, 1, 70, -40); invoke(h)
  assertViewport(svg, { x: 260, y: 380, k: 2 })
  await h.input('Node')
  const centered = d3.zoomTransform(svg)
  await h.click(h.host.querySelectorAll('.node-search-result')[0])
  assert.strictEqual(d3.zoomTransform(svg), centered)
  position(h, 0, -10, 15); invoke(h)
  assertViewport(svg, { x: 420, y: 270, k: 2 })
})

test('duplicate UUIDs, missing UUIDs and repeated raw references resolve exact pointer and search occurrences', async t => {
  const repeated = rawNode('repeated')
  const h = mountGraphPanel(t, { initialGraph: graph([
    rawNode('duplicate'), rawNode('duplicate'), rawNode(undefined), rawNode(undefined), repeated, repeated,
  ]) })
  await settle(); await h.input('Node')
  for (const mode of ['pointer', 'search']) {
    for (let index = 0; index < 6; index++) {
      if (mode === 'pointer') await select(h, index)
      else await h.click(h.host.querySelectorAll('.node-search-result')[index])
      circles(h).forEach((_circle, i) => position(h, i, i * 100, i * -20))
      invoke(h)
      assertViewport(h.find('.graph-svg'), { x: 400 - index * 100, y: 300 + index * 20, k: 1 })
      assert.equal(circles(h)[index].getAttribute('stroke'), '#E91E63')
    }
  }
})

test('Center uses live coordinates and exact current scale while preserving drawing, source and selection state', async t => {
  const source = graph(), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle(); await h.input('Node'); await select(h)
  const svg = h.find('.graph-svg'), group = rootGroup(svg), detail = h.find('.detail-panel')
  const detailText = detail.textContent, listeners = svg.__on, originalCircles = circles(h)
  const nodes = originalCircles.map(circle => circle.__data__)
  for (const k of [0.1, 0.75, 1, 4]) {
    svg.__zoom = d3.zoomIdentity.translate(12, -30).scale(k)
    position(h, 0, 50, -25)
    const state = nodes.map(node => ({ ...node }))
    invoke(h)
    assertViewport(svg, { x: 400 - k * 50, y: 300 + k * 25, k })
    assert.deepEqual(nodes.map(node => ({ ...node })), state)
    position(h, 0, -75, 100); invoke(h)
    assertViewport(svg, { x: 400 + k * 75, y: 300 - k * 100, k })
  }
  assert.strictEqual(rootGroup(svg), group)
  assert.deepEqual(circles(h), originalCircles)
  assert.strictEqual(svg.__on, listeners)
  assert.strictEqual(h.find('.detail-panel'), detail)
  assert.equal(detail.textContent, detailText)
  assert.equal(circles(h)[0].getAttribute('stroke'), '#E91E63')
  assert.equal(h.find('.node-search-input').props.value, 'Node')
  assert.deepEqual(h.properties(), { count: '0' })
  assert.deepEqual(h.emitted, [])
  assert.equal(JSON.stringify(source), original)
})

test('resize disables pending Center and resolves replacement nodes in completed viewBox units', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle(); runRedraw(h); await settle(); await select(h)
  const svg = h.find('.graph-svg'), oldNodes = circles(h).map(circle => circle.__data__)
  const container = h.find('.graph-container'), before = d3.zoomTransform(svg)
  container.clientWidth = 1000; container.clientHeight = 400
  h.resize(); const stale = h.takeRedraws()[0]
  h.resize(); await settle()
  assert.equal(button(h).props.disabled, true)
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  stale(); await settle()
  assert.equal(button(h).props.disabled, true)
  runRedraw(h); await settle()
  assert.equal(button(h).props.disabled, false)
  oldNodes.forEach(node => Object.assign(node, { x: 1e8, y: 1e8, fx: 0 }))
  position(h, 0, 50, -25); invoke(h)
  assertViewport(svg, { x: 450, y: 225, k: 1 })
  container.clientWidth = 600; container.clientHeight = 300
  invoke(h); assertViewport(svg, { x: 450, y: 225, k: 1 })
})

test('deep in-place changes retain pointer details but invalidate Center until the node is reselected', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle(); runRedraw(h); await settle(); await select(h)
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg)
  h.props.graphData.nodes[0].attributes.count = 2
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  await settle()
  assert.equal(button(h).props.disabled, true)
  assert.deepEqual(h.properties(), { count: '2' })
  runRedraw(h); await settle()
  assert.equal(button(h).props.disabled, true)
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  await select(h)
  assert.equal(button(h).props.disabled, false)
  position(h, 0, 30, 20); invoke(h)
  assertViewport(svg, { x: 370, y: 280, k: 1 })
})

test('replacement, reorder, removal and graph identity changes cannot revive stale pointer selections', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await select(h)
  const svg = h.find('.graph-svg')
  for (const next of [graph(), graph([rawNode('two'), rawNode('one')]), graph([rawNode('two')]), graph(undefined, 'center-B'), graph([])]) {
    const before = d3.zoomTransform(svg)
    await h.load(next)
    assert.ok(h.find('.detail-panel'), 'pointer details retain their existing lifetime')
    assert.equal(button(h).props.disabled, true)
    invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
    if (next.nodes.length) await select(h)
  }
})

test('refresh still closes search-opened details and fresh search selection enables Center', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await h.input('Node'); await h.click(h.find('.node-search-result'))
  const handler = button(h).props.onClick, svg = h.find('.graph-svg'), before = d3.zoomTransform(svg)
  await h.load(graph())
  assert.equal(h.find('.detail-panel'), null)
  handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  await h.click(h.find('.node-search-result'))
  assert.equal(button(h).props.disabled, false)
  position(h, 0, 10, 20); invoke(h)
  assertViewport(svg, { x: 390, y: 280, k: 1 })
})

test('edge selection, close and background dismissal remove Center and reject retained handlers', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(undefined, 'center-A', [
    { uuid: 'edge', source_node_uuid: 'one', target_node_uuid: 'two', name: 'KNOWS' },
  ]) })
  await settle()
  const svg = h.find('.graph-svg')
  for (const target of ['edge', 'close', 'background']) {
    const handler = (await select(h)).props.onClick, before = d3.zoomTransform(svg)
    await h.click(target === 'edge' ? h.find('.links').querySelector('path')
      : target === 'close' ? h.find('.detail-close') : svg)
    assert.equal(h.find('.graph-center-selected'), null)
    handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  }
})

test('invalid coordinates, invalid scale and overflowing center arithmetic leave the viewport untouched', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await select(h)
  const svg = h.find('.graph-svg')
  zoom(h, 'in')
  const before = d3.zoomTransform(svg)
  for (const [x, y] of [[NaN, 0], [0, Infinity], ['12', 0], [0, null], [undefined, 0], [new Number(2), 0], [Number.MAX_VALUE, 0], [0, -Number.MAX_VALUE]]) {
    position(h, 0, x, y); invoke(h)
    assert.strictEqual(d3.zoomTransform(svg), before)
  }
  position(h, 0, 10, 20)
  for (const k of [NaN, Infinity, 0, -1, '2']) {
    const invalid = { x: 0, y: 0, k }
    svg.__zoom = invalid
    invoke(h); assert.strictEqual(d3.zoomTransform(svg), invalid)
  }
  svg.__zoom = before
  invoke(h); assertViewport(svg, { x: 380, y: 260, k: 2 })
})

test('nonpositive or nonfinite live dimensions reject Center independently of disabled UI', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await select(h)
  const svg = h.find('.graph-svg'), container = h.find('.graph-container'), before = d3.zoomTransform(svg)
  position(h, 0, 50, -25)
  for (const [width, height] of [[0, 600], [-1, 600], [NaN, 600], [800, 0], [800, Infinity]]) {
    container.clientWidth = width; container.clientHeight = height
    invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  }
  container.clientWidth = 800; container.clientHeight = 600
  invoke(h); assertViewport(svg, { x: 350, y: 325, k: 1 })
})

test('detached roots, replaced SVGs and unmounted owners are rejected independently across panels', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  const other = mountGraphPanel(t, { initialGraph: graph(undefined, 'other') })
  await settle(); await select(h); await select(other)
  const handler = button(h).props.onClick, svg = h.find('.graph-svg'), group = rootGroup(svg), parent = svg.parentNode
  const before = d3.zoomTransform(svg)
  position(h, 0, 50, -25)
  svg.removeChild(group); handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  svg.appendChild(group)
  parent.removeChild(svg); handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  parent.appendChild(svg)
  await h.load(null); handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  await h.load(graph()); await select(h)
  const replacement = h.find('.graph-svg')
  assert.notStrictEqual(replacement, svg)
  position(h, 0, 50, -25); invoke(h)
  assertViewport(replacement, { x: 350, y: 325, k: 1 })
  h.close(); handler()
  assertViewport(replacement, { x: 350, y: 325, k: 1 })
  assertViewport(svg, { x: 0, y: 0, k: 1 })
  assertViewport(other.find('.graph-svg'), { x: 0, y: 0, k: 1 })
  position(other, 0, -50, 25); invoke(other)
  assertViewport(other.find('.graph-svg'), { x: 450, y: 275, k: 1 })
})

test('any current node pin blocks Center without changing pins or existing zoom controls', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await select(h)
  const svg = h.find('.graph-svg'), pinned = circles(h)[1].__data__
  for (const [field, value] of [['fx', 0], ['fy', 0], ['fx', NaN], ['fy', false]]) {
    position(h, 0, 50, -25)
    pinned[field] = value
    const before = d3.zoomTransform(svg)
    invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
    assert.strictEqual(pinned[field], value)
    zoom(h, 'in'); assertViewport(svg, { x: -400, y: -300, k: 2 })
    zoom(h, 'reset'); pinned[field] = null
  }
  invoke(h); assertViewport(svg, { x: 350, y: 325, k: 1 })
})

test('Center retains the active wheel gesture and timer and reanchors continued wheel after resize', async t => {
  for (const redraw of [false, true]) {
    const h = mountGraphPanel(t, { initialGraph: graph() })
    await settle(); await select(h)
    const svg = h.find('.graph-svg'), old = rootGroup(svg)
    wheel(svg)
    const gesture = svg.__zooming, timer = gesture.wheel, oldTransform = old.getAttribute('transform')
    if (redraw) { h.resize(); await settle() }
    position(h, 0, 50, -25); invoke(h)
    assertViewport(svg, { x: 300, y: 350, k: 2 })
    assert.strictEqual(svg.__zooming, gesture)
    assert.equal(gesture.active, 1)
    assert.strictEqual(gesture.wheel, timer)
    if ('_destroyed' in timer) assert.equal(timer._destroyed, false)
    assert.deepEqual(gesture.mouse[1], d3.zoomTransform(svg).invert([200, 150]))
    wheel(svg, 500)
    assert.strictEqual(svg.__zooming, gesture)
    assert.equal(gesture.active, 1)
    assertViewport(svg, { x: 250, y: 250, k: 1 })
    if (redraw) assert.equal(old.getAttribute('transform'), oldTransform)
  }
})

test('repeated Center is numerically idempotent and Fit, Zoom and Reset remain available', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph([rawNode('one')]) })
  await settle(); await select(h)
  const svg = h.find('.graph-svg')
  position(h, 0, 50, -25)
  for (let i = 0; i < 2; i++) { invoke(h); assertViewport(svg, { x: 350, y: 325, k: 1 }) }
  zoom(h, 'fit'); assertViewport(svg, { x: 200, y: 400, k: 4 })
  invoke(h); assertViewport(svg, { x: 200, y: 400, k: 4 })
  zoom(h, 'out'); assertViewport(svg, { x: 300, y: 350, k: 2 })
  zoom(h, 'reset'); assertViewport(svg, { x: 0, y: 0, k: 1 })
})

test('exact selected raw identity is checked against both source position and live rendered record', async t => {
  const source = graph(), h = mountGraphPanel(t, { initialGraph: source })
  await settle(); await select(h)
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg), live = circles(h)[0].__data__, raw = live.rawData
  live.rawData = { ...raw }
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  live.rawData = raw
  // Bypass Vue notification deliberately to test the independent identity guard.
  const original = source.nodes[0]
  source.nodes[0] = { ...original }
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  source.nodes[0] = original
  position(h, 0, 50, -25); invoke(h)
  assertViewport(svg, { x: 350, y: 325, k: 1 })
})

test('incomplete invalid-size renders and stale queued work cannot enable Center after empty or null data', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle(); runRedraw(h); await settle(); await select(h)
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg), container = h.find('.graph-container')
  container.clientWidth = 0
  h.resize(); runRedraw(h); await settle()
  assert.equal(button(h).props.disabled, true)
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  container.clientWidth = 800
  h.resize(); const stale = h.takeRedraws()[0]
  await h.load(graph([])); stale(); runRedraw(h); await settle()
  assert.equal(button(h).props.disabled, true)
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  const handler = button(h).props.onClick
  await h.load(null); runRedraw(h); handler()
  assert.equal(h.find('.detail-panel'), null)
  assert.strictEqual(d3.zoomTransform(svg), before)
})
