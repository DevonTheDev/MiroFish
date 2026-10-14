import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_LOADED_GRAPH_BYTES, createLoadedGraphFile, hasLoadedGraphShape } from '../src/utils/loadedGraphFile.js'

const selection = Object.freeze({
  projectId: 'project-a',
  graphId: 'graph-a',
  downloadedAt: '2026-10-14T10:00:00.000Z',
})
const emptyGraph = () => ({ graph_id: 'graph-a', nodes: [], edges: [], node_count: 0, edge_count: 0 })
const envelope = graph => ({
  format: 'mirofish-loaded-graph-observation',
  version: 1,
  project_id: selection.projectId,
  graph_id: selection.graphId,
  downloaded_at: selection.downloadedAt,
  graph,
})
const expectedFile = graph => JSON.stringify(envelope(graph), null, 2) + '\n'
const hasCode = code => error => error instanceof Error && error.code === code

function richGraph() {
  const nodes = [
    {
      uuid: 'node-b', name: '東京 😀', labels: ['Node', '人物', 'Entity', 'Node'],
      summary: 'Literal <script>text</script>\n e\u0301 \ud800',
      attributes: { zero: 0, disabled: false, absent: null, nested: { list: ['二', 0, false, null] } },
      created_at: '2026-10-13 15:21:00+03:00', extra_node: { retained: true },
    },
    { uuid: 'node-a', name: null, labels: [], summary: '', attributes: {}, created_at: null },
  ]
  const edge = {
    uuid: 'edge-repeated', name: '関係', fact: 'literal fact', fact_type: 'RELATES_TO',
    source_node_uuid: 'node-b', target_node_uuid: 'node-b',
    source_node_name: '東京 😀', target_node_name: '東京 😀',
    attributes: { weight: 0, active: false, nested: { value: null } },
    created_at: 'created literal', valid_at: '2026-10-13T12:00:00+02:00',
    invalid_at: null, expired_at: 'expired literal', episodes: ['episode-z', 'episode-a', 'episode-z'],
    extra_edge: ['retained', false],
  }
  return {
    graph_id: 'graph-a', nodes,
    edges: [
      edge,
      { ...edge, name: 'second self-loop', attributes: {}, created_at: null, valid_at: null, invalid_at: 'invalid literal', expired_at: null, episodes: [] },
      { ...edge, uuid: 'edge-missing', target_node_uuid: 'missing-node', target_node_name: '', attributes: {}, episodes: ['missing-endpoint-episode'] },
    ],
    node_count: 2, edge_count: 3,
    additional: JSON.parse('{"__proto__":{"kept":true},"toJSON":"literal value","zero":0,"false":false,"null":null}'),
  }
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree)
    Object.freeze(value)
  }
  return value
}

test('round-trips the rich producer graph without changing values or record order', () => {
  const graph = richGraph(), before = structuredClone(graph), nodes = graph.nodes, edges = graph.edges
  freezeTree(graph)
  assert.equal(hasLoadedGraphShape(graph, selection.graphId), true)
  const text = createLoadedGraphFile(graph, selection), actual = JSON.parse(text)
  assert.equal(text, expectedFile(before))
  assert.deepEqual(actual, envelope(before))
  assert.deepEqual(graph, before)
  assert.equal(graph.nodes, nodes)
  assert.equal(graph.edges, edges)
  assert.deepEqual(actual.graph.nodes.map(node => node.uuid), ['node-b', 'node-a'])
  assert.deepEqual(actual.graph.edges.map(edge => edge.uuid), ['edge-repeated', 'edge-repeated', 'edge-missing'])
  assert.equal(actual.graph.edges.filter(edge => edge.source_node_uuid === edge.target_node_uuid).length, 2)
  assert.equal(actual.graph.edges[2].target_node_uuid, 'missing-node')
  assert.deepEqual(actual.graph.nodes[0].labels, ['Node', '人物', 'Entity', 'Node'])
  assert.deepEqual(actual.graph.edges[0].episodes, ['episode-z', 'episode-a', 'episode-z'])
  assert.equal(Object.hasOwn(actual.graph.additional, '__proto__'), true)
})

test('accepts an empty graph and rejects the fixed graph identity and producer shape failures', () => {
  const empty = emptyGraph()
  assert.equal(hasLoadedGraphShape(empty, selection.graphId), true)
  assert.equal(createLoadedGraphFile(empty, selection), expectedFile(empty))
  // Project-ID mismatches require MainView's project context; the graph producer
  // supplies graph_id only. That fixed scenario is tested at the parent boundary.
  const cases = [
    ['requested/returned graph mismatch', graph => { graph.graph_id = 'graph-b' }, false],
    ['missing nodes array', graph => { delete graph.nodes }, false],
    ['count mismatch', graph => { graph.edge_count-- }, false],
    ['malformed edge endpoint type', graph => { graph.edges[0].target_node_uuid = 17 }, true],
  ]
  for (const [label, mutate, shallow] of cases) {
    const graph = richGraph()
    mutate(graph)
    assert.equal(hasLoadedGraphShape(graph, selection.graphId), shallow, label)
    assert.throws(() => createLoadedGraphFile(graph, selection), hasCode('invalid'), label)
  }
})

test('rejects the nine fixed non-JSON values without invoking accessors or toJSON', () => {
  let accessorCalls = 0, toJSONCalls = 0
  const cases = [
    ['cycle', graph => { graph.nodes[0].attributes.self = graph }],
    ['undefined', graph => { graph.nodes[0].attributes.value = undefined }],
    ['callable toJSON', graph => { graph.nodes[0].attributes.toJSON = () => { toJSONCalls++; return {} } }],
    ['bigint', graph => { graph.nodes[0].attributes.value = 1n }],
    ['NaN', graph => { graph.nodes[0].attributes.value = NaN }],
    ['Infinity', graph => { graph.nodes[0].attributes.value = Infinity }],
    ['sparse array', graph => { graph.nodes[0].attributes.value = new Array(1) }],
    ['accessor', graph => { Object.defineProperty(graph.nodes[0].attributes, 'value', { enumerable: true, get() { accessorCalls++; return 'hidden' } }) }],
    ['Date instance', graph => { graph.nodes[0].attributes.value = new Date('2026-10-14T00:00:00.000Z') }],
  ]
  for (const [label, mutate] of cases) {
    const graph = richGraph()
    mutate(graph)
    assert.equal(hasLoadedGraphShape(graph, selection.graphId), true, `${label}: shallow admission does not inspect records`)
    assert.equal(accessorCalls, 0, label)
    assert.equal(toJSONCalls, 0, label)
    assert.throws(() => createLoadedGraphFile(graph, selection), hasCode('invalid'), label)
    assert.equal(accessorCalls, 0, label)
    assert.equal(toJSONCalls, 0, label)
  }
})

test('enforces the final UTF-8 cap for exact and one-byte-over ASCII and multibyte files', () => {
  assert.equal(MAX_LOADED_GRAPH_BYTES, 8388608)
  // Measure the complete independently constructed envelope, indentation and
  // final newline. Unicode rows deliberately use only an empty graph + payload.
  const graph = { ...emptyGraph(), payload: '' }
  const available = MAX_LOADED_GRAPH_BYTES - Buffer.byteLength(expectedFile(graph), 'utf8')
  const payloads = [
    ['ASCII', 'x'.repeat(available)],
    ['multibyte', '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3)],
  ]
  for (const [label, payload] of payloads) {
    graph.payload = payload
    const expected = expectedFile(graph)
    assert.equal(Buffer.byteLength(expected, 'utf8'), MAX_LOADED_GRAPH_BYTES, `${label}: exact fixture`)
    const actual = createLoadedGraphFile(graph, selection)
    assert.equal(Buffer.byteLength(actual, 'utf8'), MAX_LOADED_GRAPH_BYTES, label)
    assert.equal(actual, expected, label)
    assert.equal(JSON.parse(actual).graph.payload, payload, `${label}: no truncation`)
    graph.payload = payload + 'x'
    assert.equal(Buffer.byteLength(expectedFile(graph), 'utf8'), MAX_LOADED_GRAPH_BYTES + 1, `${label}: oversized fixture`)
    assert.throws(() => createLoadedGraphFile(graph, selection), hasCode('too_large'), label)
    assert.equal(graph.payload, payload + 'x', `${label}: rejected source stays intact`)
  }
})
