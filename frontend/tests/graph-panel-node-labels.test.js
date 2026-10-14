import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as d3 from 'd3'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Actual Vue checkbox directives and D3 run in the unchanged synthetic host.
// These checks do not establish native focus, keyboard, legibility or performance.
const graph = (graph_id = 'labels-A') => ({ graph_id,
  nodes: [
    { uuid: 'a', name: 'LongNameAlpha', labels: ['Entity', 'Person'], attributes: { count: 0 } },
    { uuid: 'b', name: 'Beta', labels: ['Entity', 'Person'] },
  ],
  edges: [
    { uuid: 'ab', source_node_uuid: 'a', target_node_uuid: 'b', name: 'KNOWS', fact: 'Ordinary fact' },
    { uuid: 'aa', source_node_uuid: 'a', target_node_uuid: 'a', name: 'REFLECTS', fact: 'Self fact' },
  ],
})
const checkbox = h => h.find('.node-labels-toggle')?.querySelector('input')
const labels = h => h.find('.nodes')?.querySelectorAll('text') ?? []
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const rootGroup = svg => svg.children.find(child => child.type === 'g')
const display = elements => elements.map(element => element.style.getPropertyValue('display'))
const assertVisible = (h, visible) => {
  assert.equal(checkbox(h).checked, visible)
  assert.ok(labels(h).length)
  assert.deepEqual(display(labels(h)), labels(h).map(() => visible ? '' : 'none'))
}
const change = async (input, checked) => {
  assert.ok(input, 'the native checkbox exists')
  input.checked = checked
  input.dispatchEvent({ type: 'change' })
  await settle()
}
const toggle = (h, value) => change(checkbox(h), value)
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

for (const [locale, name] of [['en', 'Show node labels'], ['zh', '显示节点标签']]) {
  test(`${locale} node labels have a visible native checkbox with a localized wrapping label`, async t => {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
    const h = mountGraphPanel(t, { messages, initialGraph: graph() })
    await settle()
    const label = h.find('.node-labels-toggle'), input = checkbox(h)
    assert.equal(label.type, 'label')
    assert.equal(label.textContent, name)
    assert.equal(input.type, 'input')
    assert.equal(input.props.type, 'checkbox')
    assert.equal(input.props.disabled, undefined)
    assert.equal(input.props.tabindex, undefined)
    assert.equal(input.props['aria-label'], undefined, 'the visible wrapping label supplies the name')
    assert.strictEqual(input.parentNode, label)
    assert.strictEqual(label.parentNode, h.find('.edge-labels-toggle'))
    assert.notStrictEqual(input, h.find('.toggle-switch').querySelector('input'))
    assertVisible(h, true)
    assert.deepEqual(labels(h).map(label => label.textContent), ['LongName…', 'Beta'])
    assert.ok(labels(h).every(label => label.style['pointer-events'] === 'none'))
  })
}

test('null data has no checkbox; a truthy empty graph offers the default checked choice', async t => {
  const h = mountGraphPanel(t)
  await settle()
  assert.equal(checkbox(h), undefined)
  await h.load({ graph_id: 'empty', nodes: [], edges: [] })
  assert.equal(checkbox(h).checked, true)
  assert.deepEqual(labels(h), [])
  await toggle(h, false)
  await h.load(graph())
  assertVisible(h, false)
})

test('repeated checkbox changes only hide node text, retaining drawing, events, data and independent edge labels', async t => {
  const source = graph(), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source, deferGraphRedraw: true })
  let downloads = 0
  h.props.graphDownload = { enabled: true, action: () => { downloads++ }, status: '', error: '' }
  await settle()
  runRedraw(h)
  await settle()
  const svg = h.find('.graph-svg'), group = rootGroup(svg), nodeText = labels(h), nodes = circles(h)
  const edgeText = h.find('.links').querySelectorAll('text'), backgrounds = h.find('.links').querySelectorAll('rect')
  const paths = h.find('.links').querySelectorAll('path'), text = nodeText.map(label => label.textContent)
  const records = nodes.map(node => node.__data__), handlers = nodes.map(node => node.__on), svgHandlers = svg.__on
  const coordinates = records.map(node => [node.x, node.y, node.vx, node.vy])
  const download = h.find('.graph-download-button'), downloadHandler = download.props.onClick
  for (const edgeVisible of [true, false]) {
    await change(h.find('.toggle-switch').querySelector('input'), edgeVisible)
    for (const visible of [false, true, false, true]) {
      await toggle(h, visible)
      assertVisible(h, visible)
      assert.strictEqual(rootGroup(svg), group)
      assert.deepEqual(labels(h), nodeText)
      assert.deepEqual(circles(h), nodes)
      assert.deepEqual(h.find('.links').querySelectorAll('path'), paths)
      assert.deepEqual(h.find('.links').querySelectorAll('text'), edgeText)
      assert.deepEqual(h.find('.links').querySelectorAll('rect'), backgrounds)
      assert.deepEqual(display([...edgeText, ...backgrounds]), [...edgeText, ...backgrounds].map(() => edgeVisible ? 'block' : 'none'))
      assert.deepEqual(nodeText.map(label => label.textContent), text)
      nodes.forEach((node, index) => {
        assert.strictEqual(node.__data__, records[index])
        assert.strictEqual(node.__on, handlers[index])
      })
      assert.strictEqual(svg.__on, svgHandlers)
      assert.deepEqual(records.map(node => [node.x, node.y, node.vx, node.vy]), coordinates)
      assert.strictEqual(h.find('.graph-download-button'), download)
      assert.strictEqual(download.props.onClick, downloadHandler)
      assert.equal(downloads, 0)
      assert.deepEqual(h.takeRedraws(), [])
      assert.equal(JSON.stringify(source), original)
      assert.deepEqual(h.emitted, [])
    }
  }
  await toggle(h, false)
  d3.timerFlush()
  nodeText.forEach((label, index) => {
    assert.equal(label.getAttribute('x'), nodes[index].getAttribute('cx'))
    assert.equal(label.getAttribute('y'), nodes[index].getAttribute('cy'))
    assert.equal(label.style.display, 'none', 'ticks still position hidden text')
  })
  await toggle(h, true)
  assertVisible(h, true)
})

test('hidden names remain searchable and selectable with page, full details and highlight retained across toggles', async t => {
  const source = { graph_id: 'many', nodes: Array.from({ length: 21 }, (_, index) => ({
    uuid: `n${index}`, name: `LongName${index}`, labels: ['Entity'], attributes: { index },
  })), edges: [] }
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle()
  await toggle(h, false)
  await h.input('LongName')
  await h.click(h.find('.node-search-next'))
  const result = h.find('.node-search-result'), range = h.find('.node-search-range').textContent
  await h.click(result)
  const detail = h.find('.detail-panel'), text = detail.textContent, selected = circles(h)[20]
  assert.ok(text.includes('LongName20'))
  assert.equal(selected.getAttribute('stroke'), '#E91E63')
  assertVisible(h, false)
  for (const visible of [true, false]) {
    await toggle(h, visible)
    assert.strictEqual(h.find('.detail-panel'), detail)
    assert.equal(detail.textContent, text)
    assert.strictEqual(h.find('.node-search-result'), result)
    assert.equal(h.find('.node-search-input').props.value, 'LongName')
    assert.equal(h.find('.node-search-range').textContent, range)
    assert.equal(selected.getAttribute('stroke'), '#E91E63')
    assertVisible(h, visible)
  }
  await h.select('n0')
  assert.ok(h.find('.detail-panel').textContent.includes('LongName0'))
  assertVisible(h, false, 'pointer selection does not reveal the selected label')
})

test('node visibility leaves relationship search, edge details and expanded self-relations intact', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  await h.click(h.find('.search-mode-relationships'))
  await h.input('fact')
  const result = h.find('.relationship-search-result')
  await h.click(result)
  const ordinary = h.find('.detail-panel'), ordinaryText = ordinary.textContent
  await toggle(h, false)
  assert.strictEqual(h.find('.detail-panel'), ordinary)
  assert.equal(ordinary.textContent, ordinaryText)
  assert.strictEqual(h.find('.relationship-search-result'), result)
  assert.equal(h.find('.search-mode-relationships').props['aria-pressed'], true)
  assert.equal(h.find('.node-search-input').props.value, 'fact')
  const loop = h.find('.links').querySelectorAll('path').find(path => path.__data__.isSelfLoop)
  await h.click(loop)
  const header = h.find('.self-loop-item-header')
  await h.click(header)
  const detail = h.find('.detail-panel'), content = h.find('.self-loop-item-content'), text = detail.textContent
  for (const visible of [true, false, true]) {
    await toggle(h, visible)
    assert.strictEqual(h.find('.detail-panel'), detail)
    assert.equal(detail.textContent, text)
    assert.strictEqual(h.find('.self-loop-item-header'), header)
    assert.strictEqual(h.find('.self-loop-item-content'), content)
    assert.equal(header.props['aria-expanded'], true)
    assert.notEqual(content.style.display, 'none')
    assert.equal(loop.getAttribute('stroke'), '#3498db')
  }
})

test('node toggles preserve zoom transform and a live wheel gesture on the existing SVG and root', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  const svg = h.find('.graph-svg'), group = rootGroup(svg)
  wheel(svg)
  const transform = d3.zoomTransform(svg), gesture = svg.__zooming, timer = gesture.wheel
  for (const visible of [false, true, false]) {
    await toggle(h, visible)
    assert.strictEqual(d3.zoomTransform(svg), transform)
    assert.strictEqual(rootGroup(svg), group)
    assert.equal(group.getAttribute('transform'), transform.toString())
    assert.strictEqual(svg.__zooming, gesture)
    assert.equal(gesture.active, 1)
    assert.strictEqual(gesture.wheel, timer)
    if ('_destroyed' in timer) assert.equal(timer._destroyed, false)
  }
  wheel(svg)
  assert.strictEqual(svg.__zooming, gesture)
  assert.equal(d3.zoomTransform(svg).k, 4)
  assert.equal(group.getAttribute('transform'), d3.zoomTransform(svg).toString())
  assertVisible(h, false)
})

test('deferred renders use the latest choice and retired selections ignore subsequent changes', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph(), deferGraphRedraw: true })
  await settle()
  for (const value of [false, true, false]) await toggle(h, value)
  assert.deepEqual(labels(h), [])
  runRedraw(h)
  await settle()
  assertVisible(h, false)
  const svg = h.find('.graph-svg'), retired = labels(h), oldGroup = rootGroup(svg)
  h.resize()
  const stale = h.takeRedraws()[0]
  await toggle(h, true)
  assert.deepEqual(display(retired), ['none', 'none'], 'retirement releases the prior D3 selection immediately')
  await h.load(graph('new-identity'))
  for (const value of [false, true]) await toggle(h, value)
  stale()
  assert.strictEqual(rootGroup(svg), oldGroup)
  runRedraw(h)
  await settle()
  assertVisible(h, true)
  assert.notStrictEqual(rootGroup(svg), oldGroup)
  assert.equal(oldGroup.parentNode, null)
  await toggle(h, false)
  assertVisible(h, false)
  assert.deepEqual(display(retired), ['none', 'none'])
  h.resize()
  const abandoned = h.takeRedraws()[0], current = labels(h)
  h.close()
  abandoned()
  assert.deepEqual(display(current), ['none', 'none'])
  assert.equal(h.find('.graph-svg'), null)
})

test('choice survives resize, deep mutation, same and changed identities, and truthy empty redraws', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  await toggle(h, false)
  const svg = h.find('.graph-svg')
  h.resize(); await settle()
  assertVisible(h, false)
  h.props.graphData.nodes[0].name = 'RenamedFullNode'
  await settle()
  assertVisible(h, false)
  assert.equal(labels(h)[0].textContent, 'RenamedF…')
  await h.load(graph())
  assertVisible(h, false)
  await h.load(graph('different'))
  assertVisible(h, false)
  await h.load({ graph_id: 'different', nodes: [], edges: [] })
  assert.strictEqual(h.find('.graph-svg'), svg)
  assert.equal(checkbox(h).checked, false)
  assert.deepEqual(labels(h), [])
  await h.load(graph('different'))
  assertVisible(h, false)
  await toggle(h, true)
  h.resize(); await settle()
  assertVisible(h, true)
})

test('settled null replaces the SVG but keeps the choice; an actual component remount defaults on', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  await toggle(h, false)
  const svg = h.find('.graph-svg'), retired = labels(h)
  await h.load(null)
  assert.equal(h.find('.graph-svg'), null)
  assert.equal(checkbox(h), undefined)
  await h.load(graph('reload'))
  assert.notStrictEqual(h.find('.graph-svg'), svg)
  assertVisible(h, false)
  await toggle(h, true)
  assert.deepEqual(display(retired), ['none', 'none'])
  await toggle(h, false)
  h.close()
  const fresh = mountGraphPanel(t, { initialGraph: graph('reload') })
  await settle()
  assertVisible(fresh, true)
})

test('separate mounted GraphPanel instances keep independent label choices', async t => {
  const first = mountGraphPanel(t, { initialGraph: graph() })
  const second = mountGraphPanel(t, { initialGraph: graph() })
  await settle()
  await toggle(first, false)
  assertVisible(first, false)
  assertVisible(second, true)
  await toggle(second, false)
  await toggle(first, true)
  assertVisible(first, true)
  assertVisible(second, false)
  first.close()
  second.resize(); await settle()
  assertVisible(second, false)
})
