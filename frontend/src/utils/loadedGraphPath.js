// A projection of loaded source occurrences, never a traversal of D3 objects.
export const PATH_LIMITS = Object.freeze({
  maxNodes: 5000,
  maxEdges: 20000,
  maxIdUnits: 256,
  maxTotalIdUnits: 2097152,
  maxHops: 8,
  maxOperationsPerSlice: 256,
  maxSliceMs: 4,
  maxActiveMs: 250
})

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Call only after the length check; trim tests emptiness without changing identity.
const usableId = value => typeof value === 'string' && value.trim().length > 0
const capture = value => ({ index: value?.index, raw: value?.raw, id: value?.id })

/**
 * Each step performs at most 256 constant-size work items, also yielding after
 * 4 ms of observed work. These are cooperative limits, not realtime deadlines.
 * The caller schedules the next step with a cancellable macrotask and owns graph
 * revision checks for arbitrary in-place edits. This helper independently checks
 * array identity/length and captured endpoint identity before slices/publication.
 */
export function createLoadedGraphPathJob(graph, endpoints, { now = () => performance.now() } = {}) {
  let graphRef = graph, selected = endpoints
  let nodes = graph?.nodes, edges = graph?.edges
  const nodeCount = Array.isArray(nodes) ? nodes.length : 0
  const edgeCount = Array.isArray(edges) ? edges.length : 0
  let startInput = endpoints?.start, endInput = endpoints?.end
  let start = capture(startInput), end = capture(endInput)
  let startChecked = false, endChecked = false
  const excluded = { invalidNodes: 0, invalidEdges: 0, missingEndpoints: 0, ambiguousEndpoints: 0 }
  const running = Object.freeze({ state: 'running' })
  let terminal = null, activeMs = 0, idUnits = 0
  let phase = 'start', nodeCursor = 0, edgeCursor = 0
  let index = new Map(), queue = [], queueCursor = 0
  let startEntry = null, endEntry = null, activeNode = null, outgoingCursor = 0
  let reconstructNode = null, resultNodes = [], resultEdges = []

  const settle = candidate => {
    if (terminal) return terminal
    terminal = { ...candidate, excluded: { ...excluded } }
    // Drop whole scratch structures. No unbudgeted Map iteration or cleanup pass.
    index = queue = activeNode = startEntry = endEntry = reconstructNode = null
    graphRef = selected = nodes = edges = startInput = endInput = start = end = null
    resultNodes = resultEdges = null
    return terminal
  }

  const sameCapture = (input, saved) => input?.index === saved.index && input?.raw === saved.raw && input?.id === saved.id
  const currentOccurrence = saved => nodes[saved.index] === saved.raw && saved.raw.uuid === saved.id
  const sourceIsCurrent = () => graphRef?.nodes === nodes && graphRef?.edges === edges &&
    nodes.length === nodeCount && edges.length === edgeCount &&
    selected?.start === startInput && selected?.end === endInput &&
    sameCapture(startInput, start) && sameCapture(endInput, end) &&
    (!startChecked || currentOccurrence(start)) && (!endChecked || currentOccurrence(end))

  const validateEndpoint = (input, saved, endpoint) => {
    if (!record(input) || !Number.isInteger(saved.index) || saved.index < 0 || saved.index >= nodeCount ||
      !record(saved.raw) || nodes[saved.index] !== saved.raw || saved.raw.uuid !== saved.id) {
      return { state: 'invalidEndpoint', endpoint }
    }
    if (typeof saved.id === 'string' && saved.id.length > PATH_LIMITS.maxIdUnits) {
      return { state: 'identifierLimit', endpoint }
    }
    if (!usableId(saved.id)) return { state: 'invalidEndpoint', endpoint }
    return null
  }

  const accountId = id => {
    if (typeof id !== 'string') return true
    // All strings, including blank/excluded IDs, count. No hashing or trimming
    // occurs until both the individual and aggregate limits have been admitted.
    if (id.length > PATH_LIMITS.maxIdUnits) return false
    idUnits += id.length
    return idUnits <= PATH_LIMITS.maxTotalIdUnits
  }

  // One call is one bounded work item. Phase transitions also consume an item.
  // Duplicate counts are finalized by the node pass; no resolution scan follows.
  const advance = () => {
    if (phase === 'start') {
      const error = validateEndpoint(startInput, start, 'start')
      if (error) return error
      startChecked = true
      phase = 'end'
    } else if (phase === 'end') {
      const error = validateEndpoint(endInput, end, 'end')
      if (error) return error
      endChecked = true
      phase = 'nodes'
    } else if (phase === 'nodes') {
      if (nodeCursor === nodeCount) {
        phase = 'endpoints'
      } else {
        const position = nodeCursor++, raw = nodes[position]
        if (!record(raw)) {
          excluded.invalidNodes++
        } else {
          const id = raw.uuid
          if (!accountId(id)) return { state: 'identifierLimit' }
          if (!usableId(id)) {
            excluded.invalidNodes++
          } else {
            const existing = index.get(id)
            if (existing) existing.count++
            else index.set(id, {
              count: 1, occurrence: { index: position, raw, id }, outgoing: [],
              depth: -1, previous: null, previousEdge: null
            })
          }
        }
      }
    } else if (phase === 'endpoints') {
      startEntry = index.get(start.id)
      endEntry = index.get(end.id)
      // Normal loaded records always resolve here; guard a changed projection too.
      if (!startEntry) return { state: 'invalidEndpoint', endpoint: 'start' }
      if (!endEntry) return { state: 'invalidEndpoint', endpoint: 'end' }
      if (startEntry.count !== 1) return { state: 'ambiguousEndpoint', endpoint: 'start' }
      if (endEntry.count !== 1) return { state: 'ambiguousEndpoint', endpoint: 'end' }
      if (start.id === end.id) return { state: 'sameEndpoint' }
      phase = 'edges'
    } else if (phase === 'edges') {
      if (edgeCursor === edgeCount) {
        startEntry.depth = 0
        queue.push(startEntry)
        phase = 'search'
      } else {
        const position = edgeCursor++, raw = edges[position]
        if (!record(raw)) {
          excluded.invalidEdges++
        } else {
          const sourceId = raw.source_node_uuid, targetId = raw.target_node_uuid
          if (!accountId(sourceId) || !accountId(targetId)) return { state: 'identifierLimit' }
          if (!usableId(sourceId) || !usableId(targetId)) {
            excluded.invalidEdges++
          } else {
            const source = index.get(sourceId), target = index.get(targetId)
            if (!source || !target) excluded.missingEndpoints++
            else if (source.count !== 1 || target.count !== 1) excluded.ambiguousEndpoints++
            else source.outgoing.push({
              occurrence: { index: position, raw, sourceId, targetId }, target
            })
          }
        }
      }
    } else if (phase === 'search') {
      if (activeNode) {
        if (outgoingCursor === activeNode.outgoing.length) {
          activeNode = null
        } else {
          const next = activeNode.outgoing[outgoingCursor++], target = next.target
          if (target.depth < 0) {
            target.depth = activeNode.depth + 1
            target.previous = activeNode
            target.previousEdge = next.occurrence
            if (target === endEntry) {
              reconstructNode = target
              phase = 'reconstruct'
            } else queue.push(target)
          }
        }
      } else if (queueCursor === queue.length) {
        return { state: 'notFound' }
      } else {
        const next = queue[queueCursor++]
        if (next.depth < PATH_LIMITS.maxHops) {
          activeNode = next
          outgoingCursor = 0
        }
      }
    } else if (phase === 'reconstruct') {
      // Write directly into the final position: no reverse, unshift or copy pass.
      const depth = reconstructNode.depth
      resultNodes[depth] = reconstructNode.occurrence
      if (depth === 0) return { state: 'found', nodes: resultNodes, edges: resultEdges }
      resultEdges[depth - 1] = reconstructNode.previousEdge
      reconstructNode = reconstructNode.previous
    }
    return null
  }

  const step = () => {
    if (terminal) return terminal
    const started = now()
    let elapsed = 0, operations = 0
    const sampleTime = () => {
      elapsed = Math.max(elapsed, now() - started, 0)
      return activeMs + elapsed >= PATH_LIMITS.maxActiveMs
    }
    const endSlice = candidate => {
      const exhausted = sampleTime()
      activeMs += elapsed
      if (exhausted && candidate?.state !== 'cancelled') candidate = { state: 'workLimit' }
      return candidate ? settle(candidate) : running
    }
    if (!sourceIsCurrent()) return endSlice({ state: 'cancelled' })
    while (operations < PATH_LIMITS.maxOperationsPerSlice) {
      if (sampleTime()) return endSlice({ state: 'workLimit' })
      if (elapsed >= PATH_LIMITS.maxSliceMs) return endSlice()
      const candidate = advance()
      operations++
      if (sampleTime()) return endSlice({ state: 'workLimit' })
      if (candidate) {
        return endSlice(sourceIsCurrent() ? candidate : { state: 'cancelled' })
      }
      if (elapsed >= PATH_LIMITS.maxSliceMs) return endSlice()
    }
    return endSlice()
  }

  // Constructor admission is shallow: never scan records or inspect attributes.
  if (!Array.isArray(nodes) || !Array.isArray(edges)) settle({ state: 'unavailable' })
  else if (nodeCount > PATH_LIMITS.maxNodes || edgeCount > PATH_LIMITS.maxEdges) settle({ state: 'tooLarge' })

  return { step, cancel: () => terminal || settle({ state: 'cancelled' }) }
}
