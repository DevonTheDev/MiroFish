import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Real Vue and D3 in the existing synthetic host. Native keyboard/focus, browser
// geometry and overlay occlusion are not established by these checks.
const rawNode = (uuid, name = uuid) => ({ uuid, name, labels: ['Entity'] })
const edge = (source = 'a', target = 'b', extra = {}) => ({
  uuid: 'relationship', source_node_uuid: source, target_node_uuid: target,
  name: 'KNOWS', fact: 'Match fact', ...extra,
})
const graph = (edges = [edge()], nodes = [rawNode('a'), rawNode('b'), rawNode('c')]) => ({
  graph_id: 'endpoints-A', nodes, edges,
})
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const paths = h => h.find('.links')?.querySelectorAll('path') ?? []
const root = svg => svg.children.find(child => child.type === 'g')
const button = h => {
  const control = h.find('.graph-fit-relationship')
  assert.ok(control, 'relationship details expose Fit relationship endpoints')
  return control
}
const invoke = h => button(h).props.onClick()
const positions = (h, values) => circles(h).forEach((circle, index) => {
  [circle.__data__.x, circle.__data__.y] = values[index]
})
const assertViewport = (svg, expected) => {
  const actual = d3.zoomTransform(svg)
  for (const key of ['x', 'y', 'k']) assert.ok(
    Math.abs(actual[key] - expected[key]) <= Math.max(1, Math.abs(expected[key])) * 1e-12,
    `${key}: ${actual[key]} should equal ${expected[key]}`)
  assert.equal(root(svg).getAttribute('transform'), actual.toString())
}
const redraw = h => {
  const queued = h.takeRedraws()
  assert.equal(queued.length, 1)
  queued[0]()
}
const search = async h => { await h.click(h.find('.search-mode-relationships')); await h.input('match') }
const rows = h => h.host.querySelectorAll('.relationship-search-result')
function wheel(svg, deltaY = -500) {
  const event = { type: 'wheel', currentTarget: svg, pageX: 200, pageY: 150, clientX: 200, clientY: 150,
    deltaY, deltaMode: 0, ctrlKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() {} }
  svg.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
}

for (const [locale, label] of [['en', 'Fit relationship endpoints'], ['zh', '适应关系端点']]) {
  test(`${locale} endpoint fitting is a localized native text button only in relationship details`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { initialGraph: graph(), messages })
    await settle()
    assert.equal(h.find('.graph-fit-relationship'), null)
    await h.click(paths(h)[0])
    const control = button(h)
    assert.equal(control.type, 'button'); assert.equal(control.props.type, 'button')
    assert.equal(control.textContent, label); assert.equal(control.props.disabled, false)
    assert.strictEqual(control.parentNode, h.find('.detail-content'))
    assert.equal(h.find('.header-tools').querySelectorAll('button').length, 6)
    await h.click(circles(h)[0]); assert.equal(h.find('.graph-fit-relationship'), null)
  })
}

test('path, label, background and search selection never move until the explicit endpoint action', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await search(h)
  const svg = h.find('.graph-svg')
  for (const target of [paths(h)[0], h.find('.links').querySelector('rect'), h.find('.links').querySelector('text'), rows(h)[0]]) {
    const before = d3.zoomTransform(svg)
    await h.click(target)
    assert.strictEqual(d3.zoomTransform(svg), before)
    positions(h, [[-100, 0], [100, 0], [100000, 100000]])
    invoke(h)
    assertViewport(svg, { x: 400, y: 300, k: 752 / 224 })
  }
})

test('duplicate or absent relationship UUIDs and repeated references use exact occurrences and D3 endpoint nodes', async t => {
  const repeated = edge('a', 'b')
  const h = mountGraphPanel(t, { initialGraph: graph([
    repeated, edge('b', 'c'), repeated, edge('a', 'c', { uuid: undefined }), edge('b', 'c', { uuid: undefined }),
  ], [rawNode('a', 'first duplicate'), rawNode('a', 'second duplicate'), rawNode('b'), rawNode('c')]) })
  await settle(); await search(h)
  const svg = h.find('.graph-svg')
  for (const mode of ['pointer', 'search']) for (let index = 0; index < 5; index++) {
    await h.click(mode === 'pointer' ? paths(h)[index] : rows(h)[index])
    positions(h, [[1e6, 1e6], [0, 0], [100, 0], [0, 100]])
    const selected = paths(h)[index].__data__
    if (selected.source.id === 'a') assert.strictEqual(selected.source, circles(h)[1].__data__)
    invoke(h)
    const centerX = (selected.source.x + selected.target.x) / 2
    const centerY = (selected.source.y + selected.target.y) / 2
    assertViewport(svg, { x: 400 - 4 * centerX, y: 300 - 4 * centerY, k: 4 })
    assert.equal(paths(h)[index].getAttribute('stroke'), '#3498db')
  }
})

test('grouped self-loops and individually searched members fit their shared current endpoint', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph([edge('a', 'a'), edge('a', 'a', { uuid: undefined })]) })
  await settle(); await h.click(paths(h)[0]); await h.click(h.find('.self-loop-item-header'))
  const header = h.find('.self-loop-item-header')
  positions(h, [[50, -25], [10000, 10000], [-10000, -10000]])
  invoke(h); assertViewport(h.find('.graph-svg'), { x: 200, y: 400, k: 4 })
  assert.equal(header.props['aria-expanded'], true)
  await search(h)
  for (const row of rows(h)) {
    const before = d3.zoomTransform(h.find('.graph-svg'))
    await h.click(row); assert.strictEqual(d3.zoomTransform(h.find('.graph-svg')), before)
    assert.equal(h.find('.self-loop-list'), null)
    positions(h, [[-20, 30], [10000, 10000], [-10000, -10000]])
    invoke(h); assertViewport(h.find('.graph-svg'), { x: 480, y: 180, k: 4 })
  }
  await h.click(paths(h)[0]); assert.equal(h.find('.self-loop-item-header').props['aria-expanded'], true)
})

test('missing rendered edges remain Details only with disabled fitting, including an empty graph', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph([edge('missing', 'b')]) })
  await settle(); await search(h); await h.click(rows(h)[0])
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg)
  assert.equal(button(h).props.disabled, true)
  assert.equal(h.find('.relationship-search-notice').textContent, 'graph.searchRelationshipDetailsOnly')
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  await h.load(graph([edge('missing', 'b')], [])); await h.click(rows(h)[0])
  assert.equal(button(h).props.disabled, true)
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
})

test('current edge, all grouped source records and both exact source-bound D3 endpoints are required', async t => {
  const source = graph([edge('a', 'a'), edge('a', 'a', { uuid: 'other' })])
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle(); await search(h); await h.click(rows(h)[1])
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg), live = paths(h)[0].__data__
  const endpoint = live.source, raw = endpoint.rawData, records = live.sourceRecords
  const refuse = change => { const restore = change(); invoke(h); assert.strictEqual(d3.zoomTransform(svg), before); restore() }
  refuse(() => { live.source = { ...endpoint }; return () => { live.source = endpoint } })
  refuse(() => { live.target = { ...endpoint }; return () => { live.target = endpoint } })
  refuse(() => { endpoint.rawData = { ...raw }; return () => { endpoint.rawData = raw } })
  refuse(() => { const old = source.nodes[0]; source.nodes[0] = { ...old }; return () => { source.nodes[0] = old } })
  refuse(() => { const old = source.edges[0]; source.edges[0] = { ...old }; return () => { source.edges[0] = old } })
  refuse(() => { live.sourceRecords = records.slice(1); return () => { live.sourceRecords = records } })
  refuse(() => { live.sourceRecords = [records[1], records[0]]; return () => { live.sourceRecords = records } })
  positions(h, [[50, -25], [0, 0], [0, 0]])
  invoke(h); assertViewport(svg, { x: 200, y: 400, k: 4 })
})

test('endpoint marker fitting uses live coordinates, both axis extents, bounded inset and scale limits', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await h.click(paths(h)[0])
  const svg = h.find('.graph-svg'), container = h.find('.graph-container')
  const cases = [
    { size: [800, 600], points: [[-100, -200], [100, 200]], expected: { x: 400, y: 300, k: 552 / 424 } },
    { size: [800, 600], points: [[50, -25], [50, -25]], expected: { x: 200, y: 400, k: 4 } },
    { size: [20, 12], points: [[0, 0], [0, 0]], expected: { x: 10, y: 6, k: 0.25 } },
    { size: [800, 600], points: [[-1e6, 0], [1e6, 0]], expected: { x: 400, y: 300, k: 0.1 } },
  ]
  for (const { size: [width, height], points, expected } of cases) {
    container.clientWidth = width; container.clientHeight = height
    h.resize(); await settle()
    positions(h, [...points, [NaN, Infinity]])
    invoke(h); assertViewport(svg, expected)
    invoke(h); assertViewport(svg, expected)
  }
})

test('either invalid endpoint or unsafe span or translation leaves the viewport untouched', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await h.click(paths(h)[0])
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg)
  for (const invalid of [NaN, Infinity, -Infinity, '12', null, undefined, new Number(2)]) {
    for (const index of [0, 1]) for (const axis of [0, 1]) {
      const points = [[0, 0], [100, 100], [0, 0]]
      points[index][axis] = invalid; positions(h, points)
      invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
    }
  }
  for (const points of [
    [[-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0], [0, 0]],
    [[Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0], [0, 0]],
  ]) {
    positions(h, points); invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  }
})

test('resize disables pending fitting, rejects stale work and resolves fresh endpoint objects in completed viewBox units', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle(); redraw(h); await settle(); await h.click(paths(h)[0])
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg), old = paths(h)[0].__data__
  const container = h.find('.graph-container')
  container.clientWidth = 1000; container.clientHeight = 400
  h.resize(); const stale = h.takeRedraws()[0]
  h.resize(); await settle(); assert.equal(button(h).props.disabled, true)
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  stale(); await settle(); assert.equal(button(h).props.disabled, true)
  redraw(h); await settle(); assert.equal(button(h).props.disabled, false)
  Object.assign(old.source, { x: 1e8, y: 1e8, fx: 0 })
  Object.assign(old.target, { x: -1e8, y: -1e8, fy: 0 })
  positions(h, [[-100, 0], [100, 0], [0, 0]])
  invoke(h); assertViewport(svg, { x: 500, y: 200, k: 4 })
  container.clientWidth = 500; container.clientHeight = 300
  invoke(h); assertViewport(svg, { x: 500, y: 200, k: 4 })
})

test('data mutation and replacement invalidate retained pointer metadata; refresh still closes search details', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle(); redraw(h); await settle(); await h.click(paths(h)[0])
  const svg = h.find('.graph-svg'), before = d3.zoomTransform(svg)
  h.props.graphData.edges[0].fact = 'Match changed'
  invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
  await settle(); assert.ok(h.find('.detail-panel')); assert.equal(button(h).props.disabled, true)
  redraw(h); await settle(); assert.equal(button(h).props.disabled, true)
  for (const next of [graph([edge('b', 'a')]), graph([], []), { ...graph(), graph_id: 'different' }]) {
    await h.load(next); redraw(h); await settle()
    assert.ok(h.find('.detail-panel')); assert.equal(button(h).props.disabled, true)
    invoke(h); assert.strictEqual(d3.zoomTransform(svg), before)
    if (paths(h).length) await h.click(paths(h)[0])
  }
  await search(h); await h.click(rows(h)[0]); const handler = button(h).props.onClick
  await h.load(graph()); redraw(h); await settle()
  assert.equal(h.find('.detail-panel'), null)
  handler(); assert.strictEqual(d3.zoomTransform(svg), before)
})

test('invalid live dimensions, detached drawing and dismissed or unmounted owners reject fitting', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  const other = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await h.click(paths(h)[0]); await other.click(paths(other)[0])
  const svg = h.find('.graph-svg'), container = h.find('.graph-container'), before = d3.zoomTransform(svg)
  const handler = button(h).props.onClick, group = root(svg), parent = svg.parentNode
  positions(h, [[-100, 0], [100, 0], [0, 0]])
  for (const [width, height] of [[0, 600], [-1, 600], [NaN, 600], [800, 0], [800, Infinity]]) {
    container.clientWidth = width; container.clientHeight = height
    handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  }
  container.clientWidth = 800; container.clientHeight = 600
  svg.removeChild(group); handler(); assert.strictEqual(d3.zoomTransform(svg), before); svg.appendChild(group)
  parent.removeChild(svg); handler(); assert.strictEqual(d3.zoomTransform(svg), before); parent.appendChild(svg)
  for (const target of [h.find('.detail-close'), svg, circles(h)[0]]) {
    await h.click(target); handler(); assert.strictEqual(d3.zoomTransform(svg), before)
    await h.click(paths(h)[0])
  }
  await h.load(null); handler(); assert.strictEqual(d3.zoomTransform(svg), before)
  await h.load(graph()); await h.click(paths(h)[0])
  const replacement = h.find('.graph-svg')
  assert.notStrictEqual(replacement, svg)
  h.close(); handler(); assertViewport(replacement, { x: 0, y: 0, k: 1 })
  positions(other, [[0, 0], [100, 0], [0, 0]])
  invoke(other); assertViewport(other.find('.graph-svg'), { x: 200, y: 300, k: 4 })
})

test('all current node pins block fitting while a valid command retains active wheel gesture across resize', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle(); await h.click(paths(h)[0])
  const svg = h.find('.graph-svg'), pinned = circles(h)[2].__data__
  for (const [field, value] of [['fx', 0], ['fy', 0], ['fx', NaN], ['fy', false]]) {
    pinned[field] = value
    const before = d3.zoomTransform(svg)
    invoke(h); assert.strictEqual(d3.zoomTransform(svg), before); assert.strictEqual(pinned[field], value)
    pinned[field] = null
  }
  for (const resize of [false, true]) {
    wheel(svg)
    const gesture = svg.__zooming, timer = gesture.wheel
    if (resize) { h.resize(); await settle() }
    positions(h, [[-100, 0], [100, 0], [0, 0]])
    invoke(h); assertViewport(svg, { x: 400, y: 300, k: 752 / 224 })
    assert.strictEqual(svg.__zooming, gesture); assert.strictEqual(gesture.wheel, timer)
    assert.equal(gesture.active, 1)
    if ('_destroyed' in timer) assert.equal(timer._destroyed, false)
    assert.deepEqual(gesture.mouse[1], d3.zoomTransform(svg).invert([200, 150]))
    wheel(svg, 500)
    assert.strictEqual(svg.__zooming, gesture)
    assertViewport(svg, { x: 300, y: 225, k: 376 / 224 })
  }
})

test('fitting preserves details, highlights, label choices, search, download and source/layout state', async t => {
  const source = graph(), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source, deferGraphRedraw: true })
  let downloads = 0
  h.props.graphDownload = { enabled: true, action: () => { downloads++ }, status: '', error: '' }
  await settle(); redraw(h); await settle(); await search(h); await h.click(rows(h)[0])
  for (const input of [h.find('.node-labels-toggle').querySelector('input'), h.find('.toggle-switch').querySelector('input')]) {
    input.checked = false; input.dispatchEvent({ type: 'change' })
  }
  await settle()
  positions(h, [[-100, 0], [100, 0], [1000, 0]])
  const svg = h.find('.graph-svg'), group = root(svg), listeners = svg.__on
  const nodes = circles(h), links = paths(h), records = nodes.map(node => ({ ...node.__data__ }))
  const detail = h.find('.detail-panel'), text = detail.textContent, result = rows(h)[0]
  const download = h.find('.graph-download-button'), downloadAction = download.props.onClick
  invoke(h); invoke(h)
  assert.strictEqual(root(svg), group); assert.strictEqual(svg.__on, listeners)
  assert.deepEqual(circles(h), nodes); assert.deepEqual(paths(h), links)
  assert.deepEqual(nodes.map(node => ({ ...node.__data__ })), records)
  assert.strictEqual(h.find('.detail-panel'), detail); assert.equal(detail.textContent, text)
  assert.equal(links[0].getAttribute('stroke'), '#3498db')
  assert.strictEqual(rows(h)[0], result); assert.equal(h.find('.node-search-input').props.value, 'match')
  assert.ok(h.find('.nodes').querySelectorAll('text').every(label => label.style.display === 'none'))
  assert.ok(h.find('.links').querySelectorAll('text').every(label => label.style.display === 'none'))
  assert.strictEqual(h.find('.graph-download-button'), download); assert.strictEqual(download.props.onClick, downloadAction)
  assert.equal(downloads, 0); assert.deepEqual(h.takeRedraws(), []); assert.deepEqual(h.emitted, [])
  assert.equal(JSON.stringify(source), original)
  h.find('.graph-zoom-reset').props.onClick(); assertViewport(svg, { x: 0, y: 0, k: 1 })
  h.find('.graph-zoom-in').props.onClick(); assertViewport(svg, { x: -400, y: -300, k: 2 })
  h.find('.graph-zoom-fit').props.onClick(); assertViewport(svg, { x: 400 - 450 * 752 / 1124, y: 300, k: 752 / 1124 })
})
