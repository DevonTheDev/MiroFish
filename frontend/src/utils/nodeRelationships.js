// Loaded source occurrences only. IDs remain literal; names never establish identity.
export const relationshipPageSize = 20
export const usableRelationshipId = value => typeof value === 'string' && value.trim().length > 0
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const displayString = value => typeof value === 'string' && value.length > 0 ? value : ''

export function relationshipPreview(value, limit, fallback = '') {
  const text = displayString(value) || fallback
  if (text.length <= limit) return text
  let end = limit
  const last = text.charCodeAt(end - 1), next = text.charCodeAt(end)
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
  return text.slice(0, end) + '…'
}

export function relationshipDirection(raw, id) {
  if (!record(raw)) return null
  const source = raw.source_node_uuid === id, target = raw.target_node_uuid === id
  return source && target ? 'self' : source ? 'outgoing' : target ? 'incoming' : null
}

export function deriveNodeRelationships(graph, rawNode) {
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) return { state: 'unavailable' }
  const id = rawNode?.uuid
  if (!usableRelationshipId(id)) return { state: 'invalid' }
  const endpoints = new Map()
  for (const node of graph.nodes) {
    if (!record(node) || !usableRelationshipId(node.uuid)) continue
    const entry = endpoints.get(node.uuid)
    if (entry) entry.count++
    else endpoints.set(node.uuid, { count: 1, name: displayString(node.name) })
  }
  const occurrences = [], counts = { incoming: 0, outgoing: 0, self: 0 }
  for (let index = 0; index < graph.edges.length; index++) {
    const raw = graph.edges[index], direction = relationshipDirection(raw, id)
    if (!direction) continue
    occurrences.push({ index, raw, direction })
    counts[direction]++
  }
  return { state: 'ready', id, endpoints, occurrences, counts, duplicateCount: endpoints.get(id)?.count || 0 }
}

export function relationshipEndpoint(index, id, producerName) {
  const valid = usableRelationshipId(id), entry = valid ? index.get(id) : null
  const name = (entry?.count === 1 ? entry.name : '') || displayString(producerName) || displayString(id)
  return {
    text: relationshipPreview(name, 80), id: relationshipPreview(id, 96),
    count: entry?.count || 0,
    status: !valid ? 'idUnavailable' : !entry ? 'notLoaded' : entry.count > 1 ? 'multiple' : null
  }
}

export function formatNodeRelationship(derived, occurrence) {
  const raw = occurrence.raw
  return { ...occurrence,
    source: relationshipEndpoint(derived.endpoints, raw.source_node_uuid, raw.source_node_name),
    target: relationshipEndpoint(derived.endpoints, raw.target_node_uuid, raw.target_node_name),
    label: relationshipPreview(raw.name, 80, 'RELATED_TO'),
    recordedType: relationshipPreview(raw.fact_type, 80, 'Unknown'),
    uuid: relationshipPreview(raw.uuid, 96), fact: relationshipPreview(raw.fact, 160)
  }
}
