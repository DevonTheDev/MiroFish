import assert from 'node:assert/strict'
import test from 'node:test'
import { PATH_LIMITS, createLoadedGraphPathJob } from '../src/utils/loadedGraphPath.js'

const node = uuid => ({ uuid, name: 'Same name' })
const edge = (source_node_uuid, target_node_uuid, extra = {}) => ({ source_node_uuid, target_node_uuid, ...extra })
const endpoint = (graph, index) => ({ index, raw: graph.nodes[index], id: graph.nodes[index]?.uuid })
const selection = (graph, start = 0, end = graph.nodes.length - 1) => ({ start: endpoint(graph, start), end: endpoint(graph, end) })
const makeJob = (graph, selected = selection(graph), now = () => 0) => createLoadedGraphPathJob(graph, selected, { now })
const finish = job => {
  for (let slices = 0; slices < 2000; slices++) {
    const result = job.step()
    if (result.state !== 'running') return result
  }
  assert.fail('the bounded graph job did not terminate')
}
const derive = (graph, start = 0, end = graph.nodes.length - 1) => finish(makeJob(graph, selection(graph, start, end)))
const noExcluded = { invalidNodes: 0, invalidEdges: 0, missingEndpoints: 0, ambiguousEndpoints: 0 }
const chain = hops => ({
  nodes: Array.from({ length: hops + 1 }, (_, index) => node(`n${index}`)),
  edges: Array.from({ length: hops }, (_, index) => edge(`n${index}`, `n${index + 1}`))
})

test('a directed chain returns exact source occurrences, and its reverse is absent', () => {
  const graph = chain(3)
  const result = derive(graph)
  assert.equal(result.state, 'found')
  assert.deepEqual(result.nodes, graph.nodes.map((raw, index) => ({ index, raw, id: raw.uuid })))
  assert.deepEqual(result.edges, graph.edges.map((raw, index) => ({ index, raw, sourceId: raw.source_node_uuid, targetId: raw.target_node_uuid })))
  assert.deepEqual(result.excluded, noExcluded)
  assert.equal(derive(graph, 3, 0).state, 'notFound')
})

test('minimum hops take priority, and equal-hop alternatives follow source edge order', () => {
  const graph = { nodes: ['a', 'b', 'c', 'd', 'z'].map(node), edges: [
    edge('a', 'b'), edge('b', 'c'), edge('c', 'z'), edge('a', 'd'), edge('d', 'z'),
    edge('b', 'z')
  ] }
  assert.deepEqual(derive(graph).edges.map(item => item.index), [0, 5])
  graph.edges.unshift(edge('a', 'z'))
  assert.deepEqual(derive(graph).edges.map(item => item.index), [0])
})

test('parallel and repeated raw edges keep occurrence positions without needing edge UUIDs', () => {
  const shared = edge('a', 'b', { uuid: 'duplicate' })
  const graph = { nodes: ['a', 'b', 'z'].map(node), edges: [null, shared, shared, { ...shared }, edge('b', 'z')] }
  const result = derive(graph)
  assert.equal(result.state, 'found')
  assert.deepEqual(result.edges.map(item => item.index), [1, 4])
  assert.equal(result.edges[0].raw, shared)
  assert.equal(result.excluded.invalidEdges, 1)
})

test('cycles and self-loops do not displace a shortest path', () => {
  const graph = { nodes: ['a', 'b', 'z'].map(node), edges: [
    edge('a', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'b'), edge('b', 'z')
  ] }
  assert.deepEqual(derive(graph).edges.map(item => item.index), [1, 4])
})

test('literal IDs preserve whitespace, case, Unicode and prototype-like names', () => {
  const ids = [' a ', 'a', 'A', '__proto__', 'constructor', 'é', 'e\u0301']
  const graph = { nodes: ids.map(node), edges: ids.slice(1).map((id, index) => edge(ids[index], id)) }
  const result = derive(graph)
  assert.equal(result.state, 'found')
  assert.deepEqual(result.nodes.map(item => item.id), ids)
  assert.equal(result.edges.length, 6)
  assert.equal(derive({ nodes: [node(' a '), node('a')], edges: [edge('a', ' a ')] }).state, 'notFound')
})

test('duplicate node occurrences, including repeated raw references, block either selected endpoint', () => {
  const shared = node('a')
  const graph = { nodes: [shared, shared, node('z')], edges: [edge('a', 'z')] }
  assert.deepEqual([derive(graph).state, derive(graph).endpoint], ['ambiguousEndpoint', 'start'])
  assert.deepEqual([derive(graph, 2, 1).state, derive(graph, 2, 1).endpoint], ['ambiguousEndpoint', 'end'])
  graph.nodes[1] = node('a')
  assert.equal(derive(graph).state, 'ambiguousEndpoint')
})

test('ambiguous intermediates are excluded and counts use invalid, missing, ambiguous precedence', () => {
  const graph = { nodes: [node('a'), node('b'), node('b'), null, node(' '), node(4), node('z')], edges: [
    null, edge('', 'missing'), edge('missing', 'b'), edge('a', 'b'), edge('b', 'z'),
    edge('a', 'absent'), edge('a', 'z')
  ] }
  const result = derive(graph)
  assert.equal(result.state, 'found')
  assert.deepEqual(result.edges.map(item => item.index), [6])
  assert.deepEqual(result.excluded, { invalidNodes: 3, invalidEdges: 2, missingEndpoints: 2, ambiguousEndpoints: 2 })
  graph.edges.pop()
  const absent = derive(graph)
  assert.equal(absent.state, 'notFound')
  assert.deepEqual(absent.excluded, result.excluded)
})

test('sparse arrays and malformed records are counted without converting nonstring IDs', () => {
  const hostile = { toString() { throw new Error('must not convert an ID') } }
  const graph = { nodes: [node('a'), , [], node(hostile), node('z')], edges: [
    , [], 4, edge(hostile, 'z'), edge('a', 'z')
  ] }
  const result = derive(graph)
  assert.equal(result.state, 'found')
  assert.deepEqual(result.edges.map(item => item.index), [4])
  assert.deepEqual(result.excluded, { ...noExcluded, invalidNodes: 3, invalidEdges: 4 })
})

test('unavailable arrays, missing occurrences and invalid selected IDs have distinct states', () => {
  for (const graph of [null, {}, { nodes: [], edges: null }, { nodes: {}, edges: [] }]) {
    assert.equal(finish(makeJob(graph, {})).state, 'unavailable')
  }
  const graph = chain(1)
  for (const start of [undefined, {}, { index: -1, raw: graph.nodes[0], id: 'n0' },
    { index: 0.5, raw: graph.nodes[0], id: 'n0' }, { index: 0, raw: node('n0'), id: 'n0' },
    { index: 0, raw: graph.nodes[0], id: 'other' }]) {
    const result = finish(makeJob(graph, { start, end: endpoint(graph, 1) }))
    assert.deepEqual([result.state, result.endpoint], ['invalidEndpoint', 'start'])
  }
  for (const id of [undefined, null, '', ' \t\n', 0, false, [], {}, new String('a')]) {
    const invalid = { nodes: [node('a'), node(id)], edges: [] }
    const result = derive(invalid)
    assert.deepEqual([result.state, result.endpoint], ['invalidEndpoint', 'end'])
  }
  assert.equal(finish(makeJob({ nodes: [], edges: [] }, {})).state, 'invalidEndpoint')
})

test('a unique equal endpoint is rejected instead of becoming a zero-hop success', () => {
  const graph = chain(1)
  assert.equal(derive(graph, 0, 0).state, 'sameEndpoint')
})

test('eight relationships can succeed and a ninth remains bounded absence', () => {
  const eight = derive(chain(8)), nine = derive(chain(9))
  assert.equal(eight.state, 'found')
  assert.equal(eight.nodes.length, 9)
  assert.equal(eight.edges.length, 8)
  assert.equal(nine.state, 'notFound')
  assert.deepEqual(nine.excluded, noExcluded)
})

test('public limits match the accepted finite-work contract', () => {
  assert.deepEqual(PATH_LIMITS, {
    maxNodes: 5000, maxEdges: 20000, maxIdUnits: 256, maxTotalIdUnits: 2097152,
    maxHops: 8, maxOperationsPerSlice: 256, maxSliceMs: 4, maxActiveMs: 250
  })
  assert.ok(Object.isFrozen(PATH_LIMITS))
})

test('node and edge admission caps are inclusive and checked before reading records', () => {
  const nodes = Array.from({ length: PATH_LIMITS.maxNodes }, (_, index) => node(`n${index}`))
  assert.equal(derive({ nodes, edges: [] }).state, 'notFound')
  const edges = Array.from({ length: PATH_LIMITS.maxEdges }, () => edge('a', 'z'))
  assert.equal(derive({ nodes: [node('a'), node('z')], edges }).state, 'found')
  for (const graph of [
    { nodes: new Array(PATH_LIMITS.maxNodes + 1), edges: [] },
    { nodes: [], edges: new Array(PATH_LIMITS.maxEdges + 1) }
  ]) {
    Object.defineProperty(graph.nodes.length ? graph.nodes : graph.edges, 0, {
      get() { throw new Error('over-limit arrays must not be scanned') }
    })
    assert.equal(finish(makeJob(graph, {})).state, 'tooLarge')
  }
})

test('UTF-16 identifier length is inclusive, checked before blank rejection, and applies to both edge fields', () => {
  const long = '😀'.repeat(128)
  assert.equal(derive({ nodes: [node(long), node('z')], edges: [edge(long, 'z')] }).state, 'found')
  for (const id of ['x'.repeat(257), ' '.repeat(257), '😀'.repeat(129)]) {
    assert.equal(derive({ nodes: [node(id), node('z')], edges: [] }).state, 'identifierLimit')
    assert.equal(derive({ nodes: [node('a'), node(id), node('z')], edges: [] }).state, 'identifierLimit')
    assert.equal(derive({ nodes: [node('a'), node('z')], edges: [edge(id, null)] }).state, 'identifierLimit')
    assert.equal(derive({ nodes: [node('a'), node('z')], edges: [edge(null, id)] }).state, 'identifierLimit')
  }
})

test('aggregate ID units include every node and both edge fields, even excluded records', () => {
  const a = 'a'.repeat(256), z = 'z'.repeat(256)
  const graph = { nodes: [node(a), node(z)], edges: Array.from({ length: 4095 }, () => edge(a, z)) }
  assert.equal(512 + graph.edges.length * 512, PATH_LIMITS.maxTotalIdUnits)
  assert.equal(derive(graph).state, 'found')
  graph.edges.push(edge(' ', null))
  assert.equal(derive(graph).state, 'identifierLimit')
})

test('constructor does only shallow admission and record indexing stays within each slice', () => {
  let reads = 0
  const nodes = Array.from({ length: 1000 }, (_, index) => index === 0 || index === 999 ? node(`n${index}`) : {
    get uuid() { reads++; return `n${index}` }
  })
  const graph = { nodes, edges: [] }, job = makeJob(graph)
  assert.equal(reads, 0)
  let previousReads = 0, result
  do {
    result = job.step()
    assert.ok(reads - previousReads <= PATH_LIMITS.maxOperationsPerSlice)
    previousReads = reads
  } while (result.state === 'running')
  assert.equal(result.state, 'notFound')
  assert.equal(reads, 998)
})

test('BFS adjacency scanning also yields under the operation cap', () => {
  let projected = 0
  const graph = { nodes: ['a', 'b', 'z'].map(node), edges: Array.from({ length: 20000 }, () => ({
    get source_node_uuid() { projected++; return 'a' }, target_node_uuid: 'b'
  })) }
  const job = makeJob(graph)
  let result
  do { result = job.step() } while (result.state === 'running' && projected < graph.edges.length)
  assert.equal(projected, graph.edges.length)
  assert.equal(result.state, 'running')
  let remainingSlices = 0
  while (result.state === 'running' && remainingSlices < 200) {
    result = job.step()
    remainingSlices++
  }
  assert.equal(result.state, 'notFound')
  assert.ok(remainingSlices >= Math.floor(graph.edges.length / PATH_LIMITS.maxOperationsPerSlice) - 1)
})

test('observed slice time yields before the operation cap and accumulates active work to a terminal limit', () => {
  let clock = 0, reads = 0
  const graph = { nodes: [node('a'), ...Array.from({ length: 1000 }, (_, index) => ({
    get uuid() { reads++; return `n${index}` }
  })), node('z')], edges: [] }
  const job = makeJob(graph, selection(graph), () => clock++)
  assert.equal(job.step().state, 'running')
  assert.ok(reads < PATH_LIMITS.maxOperationsPerSlice)
  const result = finish(job), stoppedReads = reads
  assert.equal(result.state, 'workLimit')
  assert.ok(reads < 1000)
  assert.equal(job.step(), result)
  assert.equal(job.cancel(), result)
  assert.equal(reads, stoppedReads)
})

test('time spent waiting between slices is outside the active-work budget', () => {
  let clock = 0
  const graph = { nodes: Array.from({ length: 1000 }, (_, index) => node(`n${index}`)), edges: [] }
  const job = makeJob(graph, selection(graph), () => clock)
  let result
  do {
    result = job.step()
    clock += 10000
  } while (result.state === 'running')
  assert.equal(result.state, 'notFound')
})

test('time-limited slices reconstruct the same complete bounded result', () => {
  let clock = 0
  const graph = chain(8), job = makeJob(graph, selection(graph), () => clock++)
  const result = finish(job)
  assert.equal(result.state, 'found')
  assert.deepEqual(result.nodes.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(result.edges.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('cancellation is immediate, idempotent, and never resumes indexing', () => {
  let reads = 0
  const graph = { nodes: [node('a'), ...Array.from({ length: 1000 }, (_, index) => ({
    get uuid() { reads++; return `n${index}` }
  })), node('z')], edges: [] }
  const job = makeJob(graph)
  assert.equal(job.step().state, 'running')
  const result = job.cancel(), stoppedReads = reads
  assert.equal(result.state, 'cancelled')
  assert.equal(job.cancel(), result)
  assert.equal(job.step(), result)
  assert.equal(reads, stoppedReads)
  assert.equal(makeJob(chain(1)).cancel().state, 'cancelled')
})

test('changed graph array identities, lengths and selected occurrence identities cancel before another slice', () => {
  for (const mutate of [
    graph => { graph.nodes = [...graph.nodes] }, graph => { graph.edges = [...graph.edges] },
    graph => { graph.nodes.push(node('extra')) }, graph => { graph.edges.push(edge('n0', 'n1')) },
    graph => { graph.nodes[0] = node('n0') }, graph => { graph.nodes[0].uuid = 'changed' },
    (graph, selected) => { selected.start = { ...selected.start } },
    (graph, selected) => { selected.end.index = 0 },
    (graph, selected) => { selected.end.id = 'changed' }
  ]) {
    const graph = { nodes: Array.from({ length: 1000 }, (_, index) => node(`n${index}`)), edges: [] }
    const selected = selection(graph), job = makeJob(graph, selected)
    assert.equal(job.step().state, 'running')
    mutate(graph, selected)
    assert.equal(job.step().state, 'cancelled')
  }
})

test('source identity is checked again before a terminal result is published', () => {
  const graph = chain(1)
  graph.edges = [{ get source_node_uuid() { graph.nodes[0] = node('n0'); return 'n0' }, target_node_uuid: 'n1' }]
  assert.equal(derive(graph).state, 'cancelled')
})

test('successful terminal results are emitted once and source records remain untouched', () => {
  const graph = chain(2)
  for (const raw of [...graph.nodes, ...graph.edges]) {
    Object.defineProperties(raw, {
      fact: { get() { throw new Error('facts are not path input') } },
      attributes: { get() { throw new Error('attributes are not path input') } }
    })
    Object.freeze(raw)
  }
  Object.freeze(graph.nodes); Object.freeze(graph.edges); Object.freeze(graph)
  const job = makeJob(graph), result = finish(job)
  assert.equal(result.state, 'found')
  assert.equal(job.step(), result)
  assert.equal(job.cancel(), result)
  assert.equal(job.step(), result)
  assert.equal(result.nodes[0].raw, graph.nodes[0])
  assert.equal(result.edges[1].raw, graph.edges[1])
})
