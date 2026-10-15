import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ref } from 'vue'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

const graph = (id = 'A') => ({ graph_id: id,
  nodes: [{ uuid: 'one', name: 'First long label', labels: ['Person'] },
    { uuid: 'two', name: 'Second', labels: ['Place'] }],
  edges: [{ uuid: 'edge', source_node_uuid: 'one', target_node_uuid: 'two', name: 'knows' }],
})
const descriptor = h => h.captures.at(-1)
const circles = h => h.find('.nodes').querySelectorAll('circle')
const controls = () => ({ enabled: false, action: undefined, status: '', error: '' })
const snapshot = node => ({ type: node.type, attributes: [...node.attributes].map(({ name, value }) => [name, value]),
  text: node.nodeType === 3 ? node.data : null, children: node.children.map(snapshot) })
const nativeHostIdentity = svg => {
  const heldSvg = ref(svg)
  assert.strictEqual(heldSvg.value, svg, 'holding a native-like host node in a Vue ref preserves its identity')
  assert.strictEqual(heldSvg.value.firstChild, svg.firstChild, 'Vue ref and D3 see the exact same root child')
  assert.strictEqual(svg.firstChild.parentNode, svg, 'the root points to the exact same SVG parent')
  assert.strictEqual(ref(svg.firstChild).value, svg.firstChild, 'the root host node also stays non-reactive')
}

test('SVG controls are optional and retain the exact rendered action', async t => {
  const h = mountGraphPanel(t, { controlledTicks: true })
  await settle()
  assert.equal(h.find('.graph-view-download-button'), null)
  assert.equal(h.find('.graph-view-download-copy'), null)
  let first = 0, second = 0
  const firstAction = () => { first++ }, secondAction = () => { second++ }
  h.props.graphViewDownload = { ...controls(), action: firstAction }
  await settle()
  let button = h.find('.graph-view-download-button')
  assert.equal(button.props.type, 'button'); assert.equal(button.props.disabled, true)
  assert.equal(button.props.onClick, undefined)
  await h.click(button); assert.equal(first, 0)
  h.props.graphViewDownload = { ...controls(), enabled: true, action: firstAction }
  await settle(); button = h.find('.graph-view-download-button')
  const retained = button.props.onClick
  assert.strictEqual(retained, firstAction)
  h.props.graphViewDownload = { ...controls(), enabled: true, action: secondAction }
  await settle(); retained(); await h.click(h.find('.graph-view-download-button'))
  assert.equal(first, 1); assert.equal(second, 1)
})

for (const locale of ['en', 'zh']) {
  test(`${locale} SVG controls localize the boundary and show literal supplied feedback`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { messages, controlledTicks: true })
    const status = messages.graph.viewDownload.started + ' <b>{status}</b>'
    const error = messages.graph.viewDownload.invalid + ' <script>{error}</script>'
    h.props.graphViewDownload = { ...controls(), status, error }
    await settle()
    assert.equal(h.find('.graph-view-download-button').textContent, messages.graph.viewDownload.label)
    assert.equal(h.find('.graph-view-download-note').textContent, messages.graph.viewDownload.description)
    assert.equal(h.find('.graph-view-download-status').textContent, status)
    assert.equal(h.find('.graph-view-download-status').props.role, 'status')
    assert.equal(h.find('.graph-view-download-status').props['aria-live'], 'polite')
    assert.equal(h.find('.graph-view-download-error').textContent, error)
    assert.equal(h.find('.graph-view-download-error').props.role, 'alert')
    assert.equal(h.find('.graph-view-download-copy').querySelector('script'), null)
    assert.equal(h.find('.graph-view-download-copy').querySelector('b'), null)
  })
}

test('SVG capture waits for the first completed frame and empty drawings never publish', async t => {
  const h = mountGraphPanel(t, { controlledTicks: true })
  await h.load({ graph_id: 'empty', nodes: [], edges: [] })
  assert.equal(h.captures.length, 0); assert.equal(h.simulations.length, 0)
  await h.load(graph()); assert.equal(h.captures.length, 0)
  assert.equal(h.find('.graph-zoom-in').props.disabled, false, 'zoom readiness precedes the first frame')
  h.tick()
  const capture = descriptor(h)
  assert.ok(Object.isFrozen(capture)); assert.strictEqual(capture.source, h.props.graphData)
  assert.equal(capture.isReady(), true)
  h.tick(); assert.equal(h.captures.length, 1, 'one exact descriptor is published per drawing')
  await h.load(null)
  assert.equal(capture.isReady(), false); assert.deepEqual(h.retired, [capture])
})

test('thrown and stale ticks cannot publish or restore SVG frame readiness', async t => {
  const h = mountGraphPanel(t, { controlledTicks: true, deferGraphRedraw: true })
  await h.load(graph()); for (const redraw of h.takeRedraws()) redraw()
  h.hooks.attribute = (element, key) => { if (element.type === 'circle' && key === 'cy') throw new Error('incomplete tick') }
  assert.throws(() => h.tick(), /incomplete tick/); assert.equal(h.captures.length, 0)
  delete h.hooks.attribute; h.tick(); const capture = descriptor(h), old = h.simulations.at(-1)
  h.hooks.bbox = () => { throw new Error('later failed tick') }
  assert.throws(() => h.tick(), /later failed tick/)
  assert.equal(capture.isReady(), false); assert.throws(() => capture.capture(), { code: 'invalid' })
  delete h.hooks.bbox; h.tick(); assert.equal(capture.isReady(), true)
  assert.equal(h.captures.length, 2, 'a successful tick re-notifies after an incomplete frame')
  assert.strictEqual(h.captures[1], capture, 'recovery publishes the same exact descriptor')
  h.tick(); assert.equal(h.captures.length, 2, 'ordinary completed ticks stay silent')
  let changed = false
  h.hooks.attribute = (element, key) => {
    if (!changed && element.type === 'circle' && key === 'cx') { changed = true; h.props.graphData.nodes[0].name = 'changed' }
  }
  h.tick(); assert.equal(capture.isReady(), false)
  delete h.hooks.attribute
  for (const redraw of h.takeRedraws()) redraw()
  const current = h.simulations.at(-1)
  h.tick(current); const fresh = descriptor(h)
  old.on('tick').call(old)
  assert.strictEqual(descriptor(h), fresh); assert.equal(fresh.isReady(), true)
  assert.equal(capture.isReady(), false)
})

test('SVG capture freezes current geometry crop labels and selection without layout work', async t => {
  const h = mountGraphPanel(t, { controlledTicks: true })
  await h.load(graph()); h.tick(); await h.select('one')
  const svg = h.find('.graph-svg'), root = svg.firstChild
  nativeHostIdentity(svg)
  svg.clientWidth = 417.5; svg.clientHeight = 300
  root.setAttribute('transform', 'translate(31,-8) scale(1.5)')
  circles(h)[0].setAttribute('cx', '-12.25')
  const before = snapshot(svg), metrics = { ...h.observations }
  const body = descriptor(h).capture()
  assert.match(body, /width="417.5"/); assert.match(body, /height="300"/)
  assert.match(body, /viewBox="0 0 800 600"/); assert.match(body, /translate\(31,-8\) scale\(1.5\)/)
  assert.match(body, /cx="-12.25"/); assert.match(body, /stroke="#E91E63"/)
  assert.match(body, /First lo…/); assert.doesNotMatch(body, /First long label/)
  assert.match(body, />knows<\/text>/)
  assert.deepEqual(snapshot(svg), before)
  assert.deepEqual(h.observations, { ...metrics, viewport: metrics.viewport + 1 })
  const toggles = h.find('.edge-labels-toggle').querySelectorAll('input')
  for (const input of toggles) input.props['onUpdate:modelValue'](false)
  await settle()
  const hidden = descriptor(h).capture()
  assert.doesNotMatch(hidden, /First lo…|>knows<\/text>/)
  assert.equal(h.observations.ticks, metrics.ticks)
  assert.equal(h.observations.bbox, metrics.bbox)
})

test('SVG capture accepts only the renderer touch styles in both D3 touch modes', async t => {
  for (const touchEnabled of [false, true]) {
    const h = mountGraphPanel(t, { controlledTicks: true, touchEnabled })
    await h.load(graph()); h.tick()
    nativeHostIdentity(h.find('.graph-svg'))
    const circle = circles(h)[0]
    assert.equal(circle.style.getPropertyValue('touch-action'), touchEnabled ? 'none' : '')
    const body = descriptor(h).capture()
    assert.doesNotMatch(body, /touch-action|tap-highlight|style=/)
    h.close()
  }
})

test('redraw deep change source replacement queued renders and unmount retire exact SVG descriptors', async t => {
  const h = mountGraphPanel(t, { controlledTicks: true, deferGraphRedraw: true })
  const render = () => { for (const redraw of h.takeRedraws()) redraw(); h.tick(); return descriptor(h) }
  await h.load(graph()); const first = render()
  h.resize(); assert.equal(first.isReady(), false); assert.deepEqual(h.retired, [first])
  const second = render(); assert.notStrictEqual(second, first)
  h.props.graphData.nodes[0].name = 'mutated'
  assert.equal(second.isReady(), false); assert.strictEqual(h.retired.at(-1), second)
  await settle(); const third = render()
  await h.load(graph('B')); const queued = h.takeRedraws()
  await h.load(graph('A')); const latest = h.takeRedraws()
  queued.forEach(redraw => redraw()); assert.equal(third.isReady(), false)
  latest.forEach(redraw => redraw()); h.tick(); const fourth = descriptor(h)
  assert.notStrictEqual(fourth, third); assert.equal(fourth.isReady(), true)
  for (const old of [first, second, third]) assert.throws(() => old.capture(), { code: 'invalid' })
  const stops = h.observations.stops
  h.props.graphViewDownload = controls(); await settle()
  assert.equal(fourth.isReady(), true); assert.equal(h.observations.stops, stops, 'parent action/resource retirement does not stop the drawing')
  h.close(); assert.equal(fourth.isReady(), false); assert.strictEqual(h.retired.at(-1), fourth)
  assert.equal(new Set(h.retired).size, h.retired.length)
})
