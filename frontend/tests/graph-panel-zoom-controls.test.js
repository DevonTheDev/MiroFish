import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Real Vue and D3 in the unchanged synthetic host; native focus, keyboard,
// browser geometry and visual placement are not established by these tests.
const graph = (graph_id = 'controls-A', nodes = [
  { uuid: 'one', name: 'One', labels: ['Entity'], attributes: { count: 0 } },
]) => ({ graph_id, nodes, edges: [], node_count: nodes.length, edge_count: 0 })
const rootGroup = svg => svg.children.find(child => child.type === 'g')
const transform = svg => {
  const { x, y, k } = d3.zoomTransform(svg)
  return { x, y, k }
}
const controls = h => ['in', 'out', 'reset'].map(name => h.find(`.graph-zoom-${name}`))
const invoke = (h, name) => h.find(`.graph-zoom-${name}`).props.onClick()
const assertViewport = (svg, expected) => {
  assert.deepEqual(transform(svg), expected)
  assert.equal(rootGroup(svg).getAttribute('transform'), d3.zoomTransform(svg).toString())
}
const assertDisabled = (h, values) => controls(h).forEach((button, index) =>
  assert.equal(Boolean(button.props.disabled), values[index]))
const runRedraw = h => {
  const redraws = h.takeRedraws()
  assert.equal(redraws.length, 1)
  redraws[0]()
}
function wheel(svg, deltaY = -500, pageX = 200, pageY = 150) {
  const event = { type: 'wheel', currentTarget: svg, pageX, pageY,
    deltaY, deltaMode: 0, ctrlKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.stopped = true } }
  svg.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
}
function assertGesture(svg, gesture, timer) {
  assert.strictEqual(svg.__zooming, gesture)
  assert.equal(gesture.active, 1)
  assert.strictEqual(gesture.wheel, timer)
  if ('_destroyed' in timer) assert.equal(timer._destroyed, false)
}

for (const [locale, labels] of [
  ['en', ['Zoom in', 'Zoom out', 'Reset view', 'Graph view controls']],
  ['zh', ['放大', '缩小', '重置视图', '图谱视图控制']],
]) {
  test(`${locale} zoom toolbar has native button and group semantics`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { initialGraph: graph(), messages })
    await settle()
    const group = h.find('.graph-zoom-controls')
    assert.equal(group.props.role, 'group')
    assert.equal(group.props['aria-label'], labels[3])
    controls(h).forEach((button, index) => {
      assert.equal(button.type, 'button')
      assert.equal(button.props.type, 'button')
      assert.equal(button.props['aria-label'], labels[index])
      assert.equal(button.props.title, labels[index])
      assert.equal(button.querySelector('span').props['aria-hidden'], 'true')
      assert.equal(button.textContent, ['+', '−', '↺'][index])
    })
    assertDisabled(h, [false, false, false])
    const existing = h.find('.header-tools').querySelectorAll('button').filter(button =>
      !String(button.props.class).includes('graph-zoom-button'))
    assert.equal(existing.length, 2)
    await h.click(existing[0])
    await h.click(existing[1])
    assert.deepEqual(h.emitted, ['refresh', 'toggle-maximize'])
  })
}

test('commands wait for the latest populated render and reject forced clicks while pending or empty', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle()
  const svg = h.find('.graph-svg')
  assertDisabled(h, [true, true, true])
  for (const name of ['in', 'out', 'reset']) invoke(h, name)
  assert.equal(rootGroup(svg), undefined)
  runRedraw(h)
  await settle()
  invoke(h, 'in')
  assertViewport(svg, { x: -400, y: -300, k: 2 })
  h.resize()
  const stale = h.takeRedraws()[0]
  await h.load(graph('controls-B'))
  assertDisabled(h, [true, true, true])
  for (const name of ['in', 'out', 'reset']) invoke(h, name)
  assertViewport(svg, { x: -400, y: -300, k: 2 })
  stale()
  await settle()
  assertDisabled(h, [true, true, true])
  runRedraw(h)
  await settle()
  assertDisabled(h, [false, false, false])
  await h.load(graph('controls-B', []))
  runRedraw(h)
  await settle()
  assertDisabled(h, [true, true, true])
  for (const name of ['in', 'out', 'reset']) invoke(h, name)
  assert.deepEqual(transform(svg), { x: -400, y: -300, k: 2 })
  assert.equal(rootGroup(svg), undefined)
})

test('commands require positive finite viewport dimensions and recover on a valid resize', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle()
  const container = h.find('.graph-container'), svg = h.find('.graph-svg')
  for (const [width, height] of [[0, 600], [800, 0], [-1, 600], [800, Infinity], [NaN, 600]]) {
    container.clientWidth = width
    container.clientHeight = height
    runRedraw(h)
    await settle()
    assertDisabled(h, [true, true, true])
    for (const name of ['in', 'out', 'reset']) invoke(h, name)
    assert.deepEqual(transform(svg), { x: 0, y: 0, k: 1 })
    h.resize()
  }
  container.clientWidth = 1000
  container.clientHeight = 500
  runRedraw(h)
  await settle()
  assertDisabled(h, [false, false, false])
  invoke(h, 'in')
  assertViewport(svg, { x: -500, y: -250, k: 2 })
  // A container can collapse without a window resize or a new render request.
  for (const [width, height] of [[0, 500], [1000, 0], [Infinity, 500], [1000, NaN]]) {
    container.clientWidth = width
    container.clientHeight = height
    for (const name of ['in', 'out', 'reset']) invoke(h, name)
    assertViewport(svg, { x: -500, y: -250, k: 2 })
  }
  container.clientWidth = 1000
  container.clientHeight = 500
  invoke(h, 'out')
  assertViewport(svg, { x: 0, y: 0, k: 1 })
})

test('buttons scale synchronously around the viewport center with no redraw or data change', async t => {
  const source = graph(), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle()
  const svg = h.find('.graph-svg'), group = rootGroup(svg), circle = group.querySelector('circle')
  wheel(svg)
  assertViewport(svg, { x: -200, y: -150, k: 2 })
  invoke(h, 'in')
  assertViewport(svg, { x: -800, y: -600, k: 4 })
  invoke(h, 'out')
  assertViewport(svg, { x: -200, y: -150, k: 2 })
  assert.strictEqual(rootGroup(svg), group)
  assert.strictEqual(group.querySelector('circle'), circle)
  assert.equal(JSON.stringify(source), original)
  assert.deepEqual(h.emitted, [])
})

for (const [name, deltaY, bound] of [['in', -10000, 4], ['out', 10000, 0.1]]) {
  test(`${name} reacts to the D3 bound and independently rejects forced disabled activation`, async t => {
    const h = mountGraphPanel(t, { initialGraph: graph() })
    await settle()
    const svg = h.find('.graph-svg')
    const savedHandler = h.find(`.graph-zoom-${name}`).props.onClick
    wheel(svg, deltaY)
    const current = d3.zoomTransform(svg), gesture = svg.__zooming, timer = gesture.wheel
    assert.equal(current.k, bound)
    // Invoke before Vue has patched disabled, then after it has patched it.
    savedHandler()
    assert.strictEqual(d3.zoomTransform(svg), current)
    assertGesture(svg, gesture, timer)
    await settle()
    assert.equal(h.find(`.graph-zoom-${name}`).props.disabled, true)
    h.find(`.graph-zoom-${name}`).dispatchEvent({ type: 'click' })
    assert.strictEqual(d3.zoomTransform(svg), current)
    assertGesture(svg, gesture, timer)
    invoke(h, 'reset')
    await settle()
    assertViewport(svg, { x: 0, y: 0, k: 1 })
    assertDisabled(h, [false, false, false])
  })
}

test('button steps clamp to both scale bounds', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg')
  for (const scale of [0.5, 0.25, 0.125, 0.1]) {
    invoke(h, 'out')
    assertViewport(svg, { x: 400 * (1 - scale), y: 300 * (1 - scale), k: scale })
  }
  await settle()
  assertDisabled(h, [false, true, false])
  for (const [k, x, y] of [[0.2, 320, 240], [0.4, 240, 180], [0.8, 80, 60],
    [1.6, -240, -180], [3.2, -880, -660], [4, -1200, -900]]) {
    invoke(h, 'in')
    assertViewport(svg, { x, y, k })
  }
  await settle()
  assertDisabled(h, [true, false, false])
})

test('reset is exact and idempotent without changing details, selection, layout or emits', async t => {
  const source = graph(), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle()
  await h.select('one')
  const svg = h.find('.graph-svg'), group = rootGroup(svg), circle = group.querySelector('circle')
  const detail = h.find('.detail-panel'), detailText = detail.textContent
  const node = circle.__data__, coordinates = [node.x, node.y, node.vx, node.vy]
  const listeners = svg.__on
  wheel(svg)
  for (let i = 0; i < 2; i++) {
    invoke(h, 'reset')
    assertViewport(svg, { x: 0, y: 0, k: 1 })
    assert.strictEqual(rootGroup(svg), group)
    assert.strictEqual(circle.__data__, node)
    assert.deepEqual([node.x, node.y, node.vx, node.vy], coordinates)
    assert.strictEqual(svg.__on, listeners)
    assert.strictEqual(h.find('.detail-panel'), detail)
    assert.equal(detail.textContent, detailText)
    assert.equal(circle.getAttribute('stroke'), '#E91E63')
  }
  await settle()
  assert.equal(h.find('.graph-zoom-reset').props.disabled, false)
  assert.deepEqual(h.properties(), { count: '0' })
  assert.deepEqual(h.emitted, [])
  assert.equal(JSON.stringify(source), original)
})

test('redraw preserves the viewport and commands use the new viewport dimensions', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg'), old = rootGroup(svg)
  invoke(h, 'in')
  await h.load(graph())
  assert.strictEqual(h.find('.graph-svg'), svg)
  assertViewport(svg, { x: -400, y: -300, k: 2 })
  h.find('.graph-container').clientWidth = 1000
  h.find('.graph-container').clientHeight = 400
  h.resize()
  await settle()
  assertViewport(svg, { x: -400, y: -300, k: 2 })
  assert.notStrictEqual(rootGroup(svg), old)
  invoke(h, 'in')
  assertViewport(svg, { x: -1300, y: -800, k: 4 })
  await h.load(graph('controls-B'))
  assertViewport(svg, { x: -1300, y: -800, k: 4 })
  invoke(h, 'out')
  assertViewport(svg, { x: -400, y: -300, k: 2 })
  invoke(h, 'reset')
  assertViewport(svg, { x: 0, y: 0, k: 1 })
  invoke(h, 'in')
  assertViewport(svg, { x: -500, y: -200, k: 2 })
  await h.load(graph('controls-B', []))
  assertDisabled(h, [true, true, true])
  assert.equal(rootGroup(svg), undefined)
  assert.deepEqual(transform(svg), { x: -500, y: -200, k: 2 })
  await h.load(graph('controls-B'))
  assert.strictEqual(h.find('.graph-svg'), svg)
  assertViewport(svg, { x: -500, y: -200, k: 2 })
  invoke(h, 'reset')
  await h.load(graph('controls-B'))
  assertViewport(svg, { x: 0, y: 0, k: 1 })
})

for (const [name, afterCommand, afterWheel] of [
  ['in', { x: -800, y: -600, k: 4 }, { x: -300, y: -225, k: 2 }],
  ['out', { x: 100, y: 75, k: 1 }, { x: 150, y: 112.5, k: 0.5 }],
  ['reset', { x: 0, y: 0, k: 1 }, { x: 100, y: 75, k: 0.5 }],
]) {
  test(`active wheel then redraw then ${name} reanchors the same gesture for continued wheel`, async t => {
    const h = mountGraphPanel(t, { initialGraph: graph() })
    await settle()
    const svg = h.find('.graph-svg'), old = rootGroup(svg)
    wheel(svg)
    const gesture = svg.__zooming, timer = gesture.wheel, oldTransform = old.getAttribute('transform')
    h.resize()
    await settle()
    const group = rootGroup(svg)
    assert.notStrictEqual(group, old)
    assertGesture(svg, gesture, timer)
    invoke(h, name)
    assertViewport(svg, afterCommand)
    assertGesture(svg, gesture, timer)
    assert.deepEqual(gesture.mouse[1], d3.zoomTransform(svg).invert([200, 150]))
    assert.equal(old.getAttribute('transform'), oldTransform)
    wheel(svg, 500)
    assert.strictEqual(svg.__zooming, gesture)
    assert.equal(gesture.active, 1)
    assertViewport(svg, afterWheel)
    assert.equal(old.getAttribute('transform'), oldTransform)
    await settle()
    assertDisabled(h, [false, false, false])
  })
}

test('detached root, replaced SVG and unmounted owners cannot receive stale commands', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  const other = mountGraphPanel(t, { initialGraph: graph('other') })
  await settle()
  const svg = h.find('.graph-svg'), group = rootGroup(svg), otherSvg = other.find('.graph-svg')
  const handlers = controls(h).map(button => button.props.onClick)
  invoke(h, 'in')
  svg.removeChild(group)
  for (const handler of handlers) handler()
  assert.deepEqual(transform(svg), { x: -400, y: -300, k: 2 })
  svg.appendChild(group)
  await h.load(null)
  assertDisabled(h, [true, true, true])
  for (const handler of handlers) handler()
  assert.deepEqual(transform(svg), { x: -400, y: -300, k: 2 })
  await h.load(graph())
  const current = h.find('.graph-svg')
  assert.notStrictEqual(current, svg)
  assertViewport(current, { x: 0, y: 0, k: 1 })
  wheel(svg)
  await settle()
  assertDisabled(h, [false, false, false])
  assertViewport(current, { x: 0, y: 0, k: 1 })
  const oldTransform = transform(svg)
  h.close()
  for (const handler of handlers) handler()
  assert.deepEqual(transform(svg), oldTransform)
  assert.deepEqual(transform(current), { x: 0, y: 0, k: 1 })
  assertViewport(otherSvg, { x: 0, y: 0, k: 1 })
  invoke(other, 'in')
  assertViewport(otherSvg, { x: -400, y: -300, k: 2 })
})
