import assert from 'node:assert/strict'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Shape returned by GraphBuilderService.get_graph_data and /api/graph/data/:id.
const node = (uuid, attributes) => ({ uuid, name: `Node ${uuid}`, labels: ['Entity', 'Person'], summary: '', attributes, created_at: null })
const graph = (...nodes) => ({ graph_id: 'synthetic-graph', nodes, edges: [], node_count: nodes.length, edge_count: 0 })

for (const [name, value, expected] of [
  ['zero', 0, '0'], ['false', false, 'false'], ['true', true, 'true'],
  ['positive number', 42, '42'], ['negative number', -1.5, '-1.5'],
  ['text', 'Known value', 'Known value'], ['whitespace', ' ', ' '],
  ['null', null, 'None'], ['undefined', undefined, 'None'], ['empty string', '', 'None'],
]) test(`selected node property displays ${name} faithfully`, async t => {
  const h = mountGraphPanel(t)
  await h.load(graph(node('A', { observed: value })))
  assert.equal(h.find('.detail-panel'), null)
  await h.select('A')
  assert.deepEqual(h.properties(), { observed: expected })
})

test('hostile-looking property values and keys remain literal text after selection', async t => {
  const h = mountGraphPanel(t)
  const attributes = {
    markup: '<img src=x onerror="globalThis.compromised=true">',
    script: '<script>alert("literal")</script>',
    entity: '&lt;b&gt;literal&lt;/b&gt;',
    '<svg onload=alert(1)>': '" onclick="alert(1)',
  }
  await h.load(graph(node('A', attributes)))
  await h.select('A')
  assert.deepEqual(h.properties(), attributes)
  const properties = h.find('.properties-list')
  assert.ok(properties.querySelectorAll('*').every(element => ['div', 'span'].includes(element.type)))
  assert.ok(properties.querySelectorAll('*').every(element => !Object.hasOwn(element.props, 'innerHTML')))
  assert.equal(properties.querySelector('script'), null)
  assert.equal(properties.querySelector('img'), null)
})

test('selected property updates retain zero and false, including repeated node selection', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph(node('A', { count: 5, active: true }), node('B', { count: 9, active: true })))
  await h.select('A')
  assert.deepEqual(h.properties(), { count: '5', active: 'true' })
  h.props.graphData.nodes[0].attributes.count = 0
  h.props.graphData.nodes[0].attributes.active = false
  await settle()
  assert.deepEqual(h.properties(), { count: '0', active: 'false' })
  await h.select('B')
  assert.deepEqual(h.properties(), { count: '9', active: 'true' })
  await h.select('A')
  assert.deepEqual(h.properties(), { count: '0', active: 'false' })
})

test('refresh and replacement graph reselection show current properties; close and background clear details', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph(node('A', { old: 'first' })))
  await h.select('A')
  await h.click(h.find('.tool-btn'))
  assert.deepEqual(h.emitted, ['refresh'])
  await h.load(graph(node('A', { current: 0, active: false })))
  await h.select('A')
  assert.deepEqual(h.properties(), { current: '0', active: 'false' })
  await h.click(h.find('.detail-close'))
  assert.equal(h.find('.detail-panel'), null)
  await h.select('A')
  await h.click(h.find('.graph-svg'))
  assert.equal(h.find('.detail-panel'), null)
  await h.select('A')
  await h.load(null)
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(h.find('.properties-list'), null)
})

test('nodes with absent or empty attributes have no Properties section', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph(node('A', {}), node('B', null), node('C', undefined)))
  for (const uuid of ['A', 'B', 'C']) {
    await h.select(uuid)
    assert.equal(h.find('.properties-list'), null)
  }
})
