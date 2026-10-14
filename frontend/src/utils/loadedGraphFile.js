export const MAX_LOADED_GRAPH_BYTES = 8388608

const INVALID = Symbol('invalid loaded graph')
const TOO_LARGE = Symbol('loaded graph exceeds file limit')
const MISSING = Symbol('missing data property')
const invalid = () => { throw INVALID }
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0
const optionalString = value => value === null || typeof value === 'string'

function jsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : MISSING
}

function arrayLength(value) {
  if (!Array.isArray(value)) return MISSING
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : MISSING
}

// Receipt admission is deliberately shallow: no record, attribute, array item,
// accessor or serialization is inspected merely to offer the download control.
export function hasLoadedGraphShape(graph, graphId) {
  try {
    if (!nonemptyString(graphId) || !jsonObject(graph) || ownValue(graph, 'graph_id') !== graphId) return false
    const nodes = ownValue(graph, 'nodes'), edges = ownValue(graph, 'edges')
    const nodeCount = ownValue(graph, 'node_count'), edgeCount = ownValue(graph, 'edge_count')
    return Number.isSafeInteger(nodeCount) && nodeCount >= 0 && nodeCount === arrayLength(nodes)
      && Number.isSafeInteger(edgeCount) && edgeCount >= 0 && edgeCount === arrayLength(edges)
  } catch { return false }
}

// Read descriptors instead of values on the source. Null-prototype copies also
// prevent JSON.stringify from finding inherited toJSON hooks on the snapshot.
// Only ancestors mark a cycle: shared, acyclic JSON values remain exportable.
function copyJson(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return value
  }
  if (typeof value !== 'object' || ancestors.has(value)) invalid()
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype && prototype !== null : !jsonObject(value)) invalid()
  ancestors.add(value)

  const keys = Reflect.ownKeys(value)
  const result = array ? Object.setPrototypeOf([], null) : Object.create(null)
  if (array) {
    const length = arrayLength(value)
    // Extra properties and holes cannot be represented by a JSON array. Reject
    // them rather than silently drop extra values or replace holes with null.
    if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) invalid()
    for (let index = 0; index < length; index++) {
      const child = ownValue(value, String(index))
      if (child === MISSING) invalid()
      result[index] = copyJson(child, ancestors)
    }
  } else {
    for (const key of keys) {
      if (typeof key !== 'string') invalid()
      const child = ownValue(value, key)
      if (child === MISSING) invalid()
      result[key] = copyJson(child, ancestors)
    }
  }
  ancestors.delete(value)
  return result
}

function stringArray(value) {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) if (typeof value[index] !== 'string') return false
  return true
}

function validNode(node) {
  return jsonObject(node) && typeof node.uuid === 'string' && optionalString(node.name)
    && stringArray(node.labels) && typeof node.summary === 'string'
    && jsonObject(node.attributes) && optionalString(node.created_at)
}

const edgeStrings = ['uuid', 'name', 'fact', 'fact_type', 'source_node_uuid', 'target_node_uuid', 'source_node_name', 'target_node_name']
const edgeDates = ['created_at', 'valid_at', 'invalid_at', 'expired_at']
function validEdge(edge) {
  return jsonObject(edge) && edgeStrings.every(key => typeof edge[key] === 'string')
    && edgeDates.every(key => optionalString(edge[key]))
    && jsonObject(edge.attributes) && stringArray(edge.episodes)
}

function validateGraph(graph, graphId) {
  if (!hasLoadedGraphShape(graph, graphId)) invalid()
  for (let index = 0; index < graph.nodes.length; index++) if (!validNode(graph.nodes[index])) invalid()
  for (let index = 0; index < graph.edges.length; index++) if (!validEdge(graph.edges[index])) invalid()
}

// The parent owns project binding and click/resource lifetimes. This synchronous
// boundary only captures the current held JSON values, validates producer types,
// and returns a complete file body; it never reads the API or creates resources.
export function createLoadedGraphFile(graph, options) {
  try {
    // Metadata is supplied by the parent, not exported as a JSON value tree.
    // Only these own data fields matter; its realm/prototype and extras do not.
    if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid()
    const projectId = ownValue(options, 'projectId'), graphId = ownValue(options, 'graphId')
    const downloadedAt = ownValue(options, 'downloadedAt')
    if (!nonemptyString(projectId) || !nonemptyString(graphId) || !nonemptyString(downloadedAt)
      || new Date(downloadedAt).toISOString() !== downloadedAt || !hasLoadedGraphShape(graph, graphId)) invalid()

    const snapshot = copyJson(graph, new WeakSet())
    validateGraph(snapshot, graphId)
    const envelope = Object.assign(Object.create(null), {
      format: 'mirofish-loaded-graph-observation',
      version: 1,
      project_id: projectId,
      graph_id: graphId,
      downloaded_at: downloadedAt,
      graph: snapshot,
    })
    const body = JSON.stringify(envelope, null, 2) + '\n'
    if (new TextEncoder().encode(body).byteLength > MAX_LOADED_GRAPH_BYTES) throw TOO_LARGE
    return body
  } catch (cause) {
    // Never inspect a thrown source value, which could itself expose accessors.
    // This also turns excessive nesting/serialization failures into safe errors.
    const code = cause === TOO_LARGE ? 'too_large' : 'invalid'
    const error = new Error(code === 'too_large' ? 'Loaded graph exceeds the 8 MiB file limit' : 'Invalid loaded graph JSON')
    error.code = code
    throw error
  }
}
