import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Actual Vue and D3 with the existing synthetic DOM host. Pin fields exercise
// admission, not native dragging; browser layout, focus and pixels are unverified.
const graph = (count = 2, graph_id = 'fit-A') => ({ graph_id,
  nodes: Array.from({ length: count }, (_, index) => ({ uuid: String(index),
    name: `Node ${index}`, labels: ['Entity'], attributes: { count: 0 }, x: 999, y: 999 })),
  edges: [], node_count: count, edge_count: 0 })
const rootGroup = svg => svg.children.find(child => child.type === 'g')
const circles = h => h.find('.nodes').querySelectorAll('circle')
const positions = (h, values) => circles(h).forEach((circle, index) => {
  [circle.__data__.x, circle.__data__.y] = values[index]
})
const invoke = (h, command = 'fit') => {
  const button = h.find(`.graph-zoom-${command}`)
  assert.ok(button, `${command} button exists`)
  button.props.onClick()
}
const transform = svg => {
  const { x, y, k } = d3.zoomTransform(svg)
  return { x, y, k }
}
const closeNumber = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
  `${actual} should equal ${expected}`)
const assertViewport = (svg, expected) => {
  for (const key of ['x', 'y', 'k']) closeNumber(transform(svg)[key], expected[key])
  assert.equal(rootGroup(svg).getAttribute('transform'), d3.zoomTransform(svg).toString())
}
const runRedraw = h => {
  const redraws = h.takeRedraws()
  assert.equal(redraws.length, 1)
  redraws[0]()
}
function wheel(svg, deltaY = -500) {
  const event = { type: 'wheel', currentTarget: svg, pageX: 200, pageY: 150,
    deltaY, deltaMode: 0, ctrlKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.stopped = true } }
  svg.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
}

for (const [locale, label] of [['en', 'Fit graph'], ['zh', '适应图谱']]) {
  test(`${locale} Fit has native semantics after every existing toolbar control`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { initialGraph: graph(), messages })
    await settle()
    const buttons = h.find('.header-tools').querySelectorAll('button'), fit = h.find('.graph-zoom-fit')
    assert.equal(buttons.length, 6)
    assert.equal(buttons[0].querySelector('span').props.class['icon-refresh'] ?? buttons[0].querySelector('span').props.class, 'icon-refresh')
    assert.equal(buttons[1].querySelector('span').props.class, 'icon-maximize')
    for (const [index, command] of ['in', 'out', 'reset', 'fit'].entries()) {
      assert.strictEqual(buttons[index + 2], h.find(`.graph-zoom-${command}`))
    }
    assert.equal(fit.type, 'button')
    assert.equal(fit.props.type, 'button')
    assert.equal(fit.props['aria-label'], label)
    assert.equal(fit.props.title, label)
    assert.equal(fit.querySelector('span').props['aria-hidden'], 'true')
    assert.equal(fit.textContent, '⤢')
    assert.equal(fit.props.disabled, false)
    await h.click(buttons[0]); await h.click(buttons[1])
    assert.deepEqual(h.emitted, ['refresh', 'toggle-maximize'])
  })
}

test('Fit centers finite bounds synchronously including the selected circle marker radius', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  positions(h, [[-100, -50], [300, 150]])
  const svg = h.find('.graph-svg')
  invoke(h)
  assertViewport(svg, { x: 11800 / 53, y: 11200 / 53, k: 94 / 53 })
  const fitted = d3.zoomTransform(svg)
  closeNumber(fitted.applyX(-112), 24)
  closeNumber(fitted.applyX(312), 776)
  assert.ok(fitted.applyY(-62) >= 24)
  assert.ok(fitted.applyY(162) <= 576)
})

test('single and coincident nodes center at the maximum scale', async t => {
  for (const count of [1, 3]) {
    const h = mountGraphPanel(t, { initialGraph: graph(count) })
    await settle()
    positions(h, Array.from({ length: count }, () => [50, -25]))
    invoke(h)
    assertViewport(h.find('.graph-svg'), { x: 200, y: 400, k: 4 })
  }
})

test('Fit ignores invalid coordinate pairs without coercing them', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(7) })
  await settle()
  positions(h, [[50, -25], ['10000', 0], [0, null], [undefined, 0],
    [Infinity, 0], [0, NaN], [new Number(10000), 0]])
  invoke(h)
  assertViewport(h.find('.graph-svg'), { x: 200, y: 400, k: 4 })
})

test('Fit with no finite coordinate pair leaves the current viewport object untouched', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg')
  invoke(h, 'in')
  const current = d3.zoomTransform(svg)
  for (const values of [[[NaN, 0], [0, Infinity]], [[null, 0], [0, undefined]],
    [['1', '2'], [-Infinity, 0]]]) {
    positions(h, values)
    invoke(h)
    assert.strictEqual(d3.zoomTransform(svg), current)
  }
})

test('finite coordinates with overflowing spans or translation are rejected', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg'), current = d3.zoomTransform(svg)
  for (const values of [[[-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0]],
    [[0, -Number.MAX_VALUE], [0, Number.MAX_VALUE]],
    [[Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0]],
    [[0, Number.MAX_VALUE], [0, Number.MAX_VALUE]]]) {
    positions(h, values)
    invoke(h)
    assert.strictEqual(d3.zoomTransform(svg), current)
  }
})

test('Fit clamps both scale limits and safely centers huge finite bounds at the minimum', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg')
  positions(h, [[0, 0], [1, 1]])
  invoke(h)
  assertViewport(svg, { x: 398, y: 298, k: 4 })
  positions(h, [[-10000, -20000], [10000, 20000]])
  invoke(h)
  assertViewport(svg, { x: 400, y: 300, k: 0.1 })
  assert.ok(d3.zoomTransform(svg).applyX(-10012) < 0, 'minimum scale need not fit every marker')
  positions(h, [[1.2e308, 0], [1.4e308, 0]])
  invoke(h)
  assertViewport(svg, { x: -1.3e307, y: 300, k: 0.1 })
})

test('a tiny positive viewport uses a bounded inset before clamping scale', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(1), deferGraphRedraw: true })
  await settle()
  const container = h.find('.graph-container')
  container.clientWidth = 10; container.clientHeight = 8
  runRedraw(h); await settle()
  positions(h, [[0, 0]])
  invoke(h)
  assertViewport(h.find('.graph-svg'), { x: 5, y: 4, k: 1 / 6 })
})

test('Fit reads the current rendered node objects at each invocation', async t => {
  const source = graph(1), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle()
  const svg = h.find('.graph-svg'), node = circles(h)[0].__data__
  positions(h, [[50, -25]])
  invoke(h)
  assertViewport(svg, { x: 200, y: 400, k: 4 })
  positions(h, [[-75, 100]])
  invoke(h)
  assertViewport(svg, { x: 700, y: -100, k: 4 })
  assert.strictEqual(circles(h)[0].__data__, node)
  assert.equal(JSON.stringify(source), original)
})

test('Fit uses completed-render viewBox units after resize and ignores CSS-only size changes', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const container = h.find('.graph-container'), svg = h.find('.graph-svg'), old = rootGroup(svg)
  container.clientWidth = 1000; container.clientHeight = 400
  h.resize(); await settle()
  assert.notStrictEqual(rootGroup(svg), old)
  assert.equal(svg.getAttribute('viewBox'), '0 0 1000 400')
  positions(h, [[-100, -50], [300, 150]])
  invoke(h)
  assertViewport(svg, { x: 2400 / 7, y: 850 / 7, k: 11 / 7 })
  container.clientWidth = 600; container.clientHeight = 300
  invoke(h)
  assertViewport(svg, { x: 2400 / 7, y: 850 / 7, k: 11 / 7 })
})

test('Fit waits for the latest populated render and cannot revive stale or empty drawings', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle()
  const svg = h.find('.graph-svg')
  assert.equal(h.find('.graph-zoom-fit')?.props.disabled, true)
  invoke(h)
  assert.equal(rootGroup(svg), undefined)
  runRedraw(h); await settle()
  positions(h, [[50, -25], [50, -25]])
  invoke(h)
  const fitted = d3.zoomTransform(svg), oldNodes = circles(h).map(circle => circle.__data__)
  h.resize()
  const stale = h.takeRedraws()[0]
  await h.load(graph(1, 'fit-B'))
  invoke(h)
  assert.strictEqual(d3.zoomTransform(svg), fitted)
  stale(); await settle()
  assert.equal(h.find('.graph-zoom-fit').props.disabled, true)
  runRedraw(h); await settle()
  oldNodes.forEach(node => { node.x = 1e8; node.y = 1e8; node.fx = 1e8 })
  positions(h, [[-75, 100]])
  invoke(h)
  assertViewport(svg, { x: 700, y: -100, k: 4 })
  await h.load(graph(0, 'fit-B'))
  runRedraw(h); await settle()
  assert.equal(h.find('.graph-zoom-fit').props.disabled, true)
  const empty = d3.zoomTransform(svg)
  invoke(h)
  assert.strictEqual(d3.zoomTransform(svg), empty)
  assert.equal(rootGroup(svg), undefined)
})

test('Fit independently rejects nonpositive or nonfinite live container dimensions', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(1) })
  await settle()
  positions(h, [[50, -25]])
  const svg = h.find('.graph-svg'), container = h.find('.graph-container'), current = d3.zoomTransform(svg)
  for (const [width, height] of [[0, 600], [-1, 600], [NaN, 600], [800, 0], [800, Infinity]]) {
    container.clientWidth = width; container.clientHeight = height
    invoke(h)
    assert.strictEqual(d3.zoomTransform(svg), current)
  }
  container.clientWidth = 800; container.clientHeight = 600
  invoke(h)
  assertViewport(svg, { x: 200, y: 400, k: 4 })
})

test('Fit respects detached roots, replaced SVGs, unmounted owners and independent panels', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(1) })
  const other = mountGraphPanel(t, { initialGraph: graph(1, 'other') })
  await settle()
  const svg = h.find('.graph-svg'), group = rootGroup(svg), svgParent = svg.parentNode
  const handler = h.find('.graph-zoom-fit')?.props.onClick
  assert.equal(typeof handler, 'function')
  positions(h, [[50, -25]])
  svg.removeChild(group); handler()
  assert.deepEqual(transform(svg), { x: 0, y: 0, k: 1 })
  svg.appendChild(group)
  svgParent.removeChild(svg); handler()
  assertViewport(svg, { x: 0, y: 0, k: 1 })
  svgParent.appendChild(svg)
  await h.load(null); handler()
  assertViewport(svg, { x: 0, y: 0, k: 1 })
  await h.load(graph(1))
  const current = h.find('.graph-svg')
  assert.notStrictEqual(current, svg)
  positions(h, [[50, -25]])
  invoke(h)
  assertViewport(current, { x: 200, y: 400, k: 4 })
  assertViewport(svg, { x: 0, y: 0, k: 1 })
  h.close(); handler()
  assertViewport(current, { x: 200, y: 400, k: 4 })
  const otherSvg = other.find('.graph-svg')
  assertViewport(otherSvg, { x: 0, y: 0, k: 1 })
  positions(other, [[-75, 100]])
  invoke(other)
  assertViewport(otherSvg, { x: 700, y: -100, k: 4 })
})

test('any non-null fx or fy blocks Fit until pins clear without blocking existing controls', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg'), pinned = circles(h)[1].__data__
  for (const [field, value] of [['fx', 0], ['fy', 0], ['fx', NaN], ['fy', false]]) {
    positions(h, [[50, -25], [NaN, Infinity]])
    pinned[field] = value
    const before = d3.zoomTransform(svg)
    invoke(h)
    assert.strictEqual(d3.zoomTransform(svg), before)
    invoke(h, 'in')
    assertViewport(svg, { x: -400, y: -300, k: 2 })
    invoke(h, 'reset')
    assertViewport(svg, { x: 0, y: 0, k: 1 })
    pinned[field] = null
  }
  invoke(h)
  assertViewport(svg, { x: 200, y: 400, k: 4 })
})

test('Fit preserves search, selection, details, source data, node state and listeners', async t => {
  const source = graph(), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle()
  await h.input('Node 0'); await h.select('0')
  const svg = h.find('.graph-svg'), group = rootGroup(svg), circle = circles(h)[0]
  const detail = h.find('.detail-panel'), detailText = detail.textContent, listeners = svg.__on
  positions(h, [[-100, -50], [300, 150]])
  const nodes = circles(h).map(circle => circle.__data__)
  const state = nodes.map(node => ({ ...node }))
  invoke(h)
  assertViewport(svg, { x: 11800 / 53, y: 11200 / 53, k: 94 / 53 })
  assert.strictEqual(rootGroup(svg), group)
  assert.strictEqual(circles(h)[0], circle)
  circles(h).forEach((circle, index) => assert.strictEqual(circle.__data__, nodes[index]))
  assert.deepEqual(nodes.map(node => ({ ...node })), state)
  assert.strictEqual(svg.__on, listeners)
  assert.strictEqual(h.find('.detail-panel'), detail)
  assert.equal(detail.textContent, detailText)
  assert.equal(circle.getAttribute('stroke'), '#E91E63')
  assert.equal(h.find('.node-search-input').props.value, 'Node 0')
  assert.deepEqual(h.properties(), { count: '0' })
  assert.deepEqual(h.emitted, [])
  assert.equal(JSON.stringify(source), original)
})

test('Fit retains the active wheel gesture and timer and reanchors continued wheel after redraw', async t => {
  for (const redraw of [false, true]) {
    const h = mountGraphPanel(t, { initialGraph: graph(1) })
    await settle()
    const svg = h.find('.graph-svg'), old = rootGroup(svg)
    wheel(svg)
    const gesture = svg.__zooming, timer = gesture.wheel, oldTransform = old.getAttribute('transform')
    if (redraw) { h.resize(); await settle() }
    positions(h, [[50, -25]])
    invoke(h)
    assertViewport(svg, { x: 200, y: 400, k: 4 })
    assert.strictEqual(svg.__zooming, gesture)
    assert.equal(gesture.active, 1)
    assert.strictEqual(gesture.wheel, timer)
    if ('_destroyed' in timer) assert.equal(timer._destroyed, false)
    assert.deepEqual(gesture.mouse[1], d3.zoomTransform(svg).invert([200, 150]))
    wheel(svg, 500)
    assert.strictEqual(svg.__zooming, gesture)
    assert.equal(gesture.active, 1)
    assertViewport(svg, { x: 200, y: 275, k: 2 })
    if (redraw) assert.equal(old.getAttribute('transform'), oldTransform)
  }
})

test('repeated Fit is numerically idempotent and Zoom and Reset retain their behavior', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(1) })
  await settle()
  positions(h, [[50, -25]])
  const svg = h.find('.graph-svg')
  for (let index = 0; index < 2; index++) {
    invoke(h)
    assertViewport(svg, { x: 200, y: 400, k: 4 })
  }
  invoke(h, 'out')
  assertViewport(svg, { x: 300, y: 350, k: 2 })
  invoke(h, 'in')
  assertViewport(svg, { x: 200, y: 400, k: 4 })
  invoke(h, 'reset')
  assertViewport(svg, { x: 0, y: 0, k: 1 })
})
