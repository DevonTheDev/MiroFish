import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'
import { createLoadedGraphFile } from '../src/utils/loadedGraphFile.js'

// Real Vue SFC and D3 with the existing synthetic host. These checks do not
// establish native select keyboard/focus behavior, browser layout or geometry.
const messagesFor = locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
const english = messagesFor('en')
const node = (uuid, name) => ({ uuid, name, labels: ['Entity', 'Person'] })
const edge = (fact_type = 'KNOWLEDGE', extra = {}) => ({
  uuid: 'relationship', name: 'KNOWS', fact: 'Match fact', fact_type,
  source_node_uuid: 'a', target_node_uuid: 'b', ...extra,
})
const graph = (edges = [], graph_id = 'types-A', nodes = [node('a', 'Alice'), node('b', 'Bob')]) => ({ graph_id, nodes, edges })
const select = h => h.find('.relationship-search-type-select')
const options = h => select(h)?.querySelectorAll('option') ?? []
const choice = h => options(h).find(option => option.props.value === select(h)?.props.value)?.textContent
const rows = h => h.host.querySelectorAll('.relationship-search-result')
const facts = h => rows(h).map(row => row.querySelector('.relationship-search-fact')?.textContent ?? '')
const paths = h => h.find('.links')?.querySelectorAll('path') ?? []
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const range = h => h.find('.node-search-range')?.textContent
const expectedRange = (start, end, total) => english.graph.searchRange
  .replace('{start}', String(start)).replace('{end}', String(end)).replace('{total}', String(total))
const relationships = async h => h.click(h.find('.search-mode-relationships'))
const chooseType = async (h, type) => {
  assert.ok(select(h), 'Relationships mode offers a relationship-type control')
  const option = type === null ? options(h)[0] : options(h).slice(1).find(option => option.textContent === type)
  assert.ok(option, `type option exists: ${type}`)
  select(h).dispatchEvent({ type: 'change', target: { value: option.props.value } })
  await settle()
}
const matches = count => Array.from({ length: count }, (_, index) => edge('KNOWLEDGE', { fact: `Match ${index}` }))
const redraw = async h => {
  const queued = h.takeRedraws()
  assert.equal(queued.length, 1)
  queued[0]()
  await settle()
}
const styles = h => ({
  nodes: circles(h).map(item => [item.props.stroke, item.props['stroke-width']]),
  edges: paths(h).map(item => [item.props.stroke, item.props['stroke-width']]),
})

test('an explicit relationship type finds records without a text query', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    edge('KNOWLEDGE', { fact: '', name: '' }), edge('KNOWS', { fact: 'Other type' }),
  ]) })
  await settle(); await relationships(h)
  assert.equal(rows(h).length, 0)
  await chooseType(h, 'KNOWLEDGE')
  assert.equal(rows(h).length, 1)
  assert.equal(rows(h)[0].querySelector('.node-search-type').textContent, 'KNOWLEDGE')
  assert.equal(range(h), expectedRange(1, 1, 1))
  assert.equal(h.find('.node-search-input').props.value, '')
  await chooseType(h, null)
  assert.equal(rows(h).length, 0)
  assert.equal(h.find('.node-search-pagination'), null)
})

for (const [locale, label, all] of [
  ['en', 'Relationship type', 'All types'], ['zh', '关系类型', '所有类型'],
]) {
  test(`${locale} relationship type has a native visible label and localized feedback`, async t => {
    const messages = messagesFor(locale)
    const h = mountGraphPanel(t, { messages, initialGraph: graph([edge()]) })
    await settle()
    assert.equal(select(h), null, 'the relationship selector is absent in Nodes')
    await relationships(h)
    assert.equal(select(h).type, 'select')
    assert.equal(select(h).parentNode.type, 'label')
    assert.ok(select(h).parentNode.textContent.includes(label))
    assert.equal(select(h).props.tabindex, undefined)
    assert.equal(choice(h), all)
    assert.equal(h.find('.relationship-search-type-hint').textContent, messages.graph.searchRelationshipTypeHint)
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchRelationshipPrompt)
    await chooseType(h, 'KNOWLEDGE'); await h.input('absent')
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchRelationshipNoMatches)
    await h.load(graph([]))
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchEmptyRelationships)
    const source = readFileSync(new URL('../src/components/GraphPanel.vue', import.meta.url), 'utf8')
    assert.match(source, /\.relationship-search-type-select:focus-visible/)
  })
}

test('relationship options use only literal nonempty string fact types and never a display fallback', async t => {
  const types = ['all', 'type-0', 'relationship-type-0', '__proto__', 'constructor', 'KNOWS', 'knows', ' KNOWS ', ' ', '<b>Type</b>', 'Unknown']
  const invalid = [undefined, null, '', 0, false, {}, []]
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    ...types.map((type, index) => edge(type, { fact: `Literal ${index}` })),
    ...invalid.map((value, index) => edge('ignored', { fact_type: value, name: 'LABEL_ONLY', fact: `Untyped ${index}` })),
  ]) })
  await settle(); await relationships(h)
  assert.deepEqual(options(h).map(option => option.textContent), ['All types', ...types])
  assert.equal(new Set(options(h).map(option => option.props.value)).size, types.length + 1)
  for (const [index, type] of types.entries()) {
    await chooseType(h, type)
    assert.deepEqual(facts(h), [`Literal ${index}`])
    assert.equal(choice(h), type)
    assert.equal(rows(h)[0].querySelector('b'), null)
    assert.equal(select(h).querySelector('b'), null)
  }
  await chooseType(h, null); await h.input('untyped')
  assert.equal(rows(h).length, invalid.length, 'missing or unusable types remain text-searchable under All')
  await h.input('Unknown')
  assert.deepEqual(facts(h), ['Literal 10'], 'Unknown matches only the stored literal string')
  await chooseType(h, 'Unknown')
  assert.deepEqual(facts(h), ['Literal 10'])
})

test('relationship text and exact type compose with AND without changing available choices', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    edge('A', { name: 'Label.[x]', fact: 'Full fact' }),
    edge('B', { name: 'Label.[x]', fact: 'Other fact' }),
    edge('A', { name: 'Different', fact: 'Other fact' }),
  ]) })
  await settle(); await relationships(h); await chooseType(h, 'A')
  for (const [query, expected] of [['  LABEL.[X]  ', ['Full fact']], ['full fact', ['Full fact']], ['alice', ['Full fact', 'Other fact']], ['bob', ['Full fact', 'Other fact']]]) {
    await h.input(query); assert.deepEqual(facts(h), expected)
  }
  await h.input('label.[x]'); await chooseType(h, 'B')
  assert.deepEqual(facts(h), ['Other fact'])
  assert.equal(h.find('.node-search-input').props.value, 'label.[x]')
  assert.deepEqual(options(h).map(option => option.textContent), ['All types', 'A', 'B'])
  await h.input(''); assert.deepEqual(facts(h), ['Other fact'])
  await chooseType(h, null); assert.equal(rows(h).length, 0)
})

test('relationship type pagination preserves source positions and resets only the edited criterion page', async t => {
  const wanted = matches(45)
  const records = wanted.flatMap(record => [edge('OTHER', { fact: 'Match gap' }), record])
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph(records) })
  await settle(); await relationships(h); await chooseType(h, 'KNOWLEDGE'); await h.input('match')
  for (let page = 1; page <= 3; page++) {
    const offset = (page - 1) * 20
    assert.deepEqual(facts(h), wanted.slice(offset, offset + 20).map(record => record.fact))
    assert.equal(range(h), expectedRange(offset + 1, Math.min(offset + 20, 45), 45))
    assert.equal(h.find('.node-search-previous').props.disabled, page === 1)
    assert.equal(h.find('.node-search-next').props.disabled, page === 3)
    rows(h).forEach((row, index) => assert.equal(row.querySelector('.node-search-position').textContent,
      english.graph.searchPosition.replace('{position}', String((offset + index) * 2 + 2))))
    if (page < 3) await h.click(h.find('.node-search-next'))
  }
  await h.click(h.find('.node-search-previous'))
  assert.equal(range(h), expectedRange(21, 40, 45))
  await chooseType(h, 'OTHER')
  assert.equal(range(h), expectedRange(1, 20, 45))
  assert.equal(h.find('.node-search-input').props.value, 'match')
  await h.click(h.find('.node-search-next')); await h.input('not present')
  assert.equal(choice(h), 'OTHER')
  assert.equal(range(h), expectedRange(0, 0, 0))
  await h.input('match'); assert.equal(range(h), expectedRange(1, 20, 45))
})

test('filtered later-page relationships retain exact duplicate and repeated source occurrence selection', async t => {
  const shared = edge('KNOWLEDGE', { fact: 'Shared' })
  const records = matches(23)
  records[0] = shared
  records[20] = edge('KNOWLEDGE', { fact: 'Later duplicate' })
  records[21] = edge('KNOWLEDGE', { uuid: undefined, fact: 'Missing UUID' })
  records[22] = shared
  const h = mountGraphPanel(t, { initialGraph: graph(records) })
  await settle(); await relationships(h); await chooseType(h, 'KNOWLEDGE')
  await h.click(h.find('.node-search-next'))
  for (let index = 0; index < 3; index++) {
    await h.click(rows(h)[index])
    assert.equal(h.find('.fact-text').textContent, ['Later duplicate', 'Missing UUID', 'Shared'][index])
    assert.deepEqual(paths(h).map(path => path.props.stroke), paths(h).map((_path, sourceIndex) => sourceIndex === 20 + index ? '#3498db' : '#C0C0C0'))
    assert.equal(h.find('.graph-fit-relationship').props.disabled, false)
  }
})

test('type-only self-relations select individual members while missing endpoints remain details only', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    edge('A', { target_node_uuid: 'a', fact: 'First loop' }),
    edge('B', { target_node_uuid: 'a', fact: 'Second loop' }),
    edge('B', { target_node_uuid: 'missing', fact: 'Orphan' }),
  ]) })
  await settle(); await relationships(h); await chooseType(h, 'B')
  assert.deepEqual(facts(h), ['Second loop', 'Orphan'])
  await h.click(rows(h)[0])
  assert.equal(h.find('.fact-text').textContent, 'Second loop')
  assert.equal(h.find('.self-loop-list'), null)
  assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchIndividualSelfRelation)
  assert.equal(h.find('.graph-fit-relationship').props.disabled, false)
  await h.click(rows(h)[1])
  assert.equal(h.find('.fact-text').textContent, 'Orphan')
  assert.equal(h.find('.graph-fit-relationship').props.disabled, true)
  assert.ok(paths(h).every(path => path.props.stroke === '#C0C0C0'))
  await h.load(graph([edge('B', { fact: 'No nodes' })], 'types-A', []))
  assert.equal(choice(h), 'B')
  assert.equal(rows(h).length, 1)
  await h.click(rows(h)[0])
  assert.equal(h.find('.fact-text').textContent, 'No nodes')
  assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchRelationshipDetailsOnly)
  assert.equal(h.find('.graph-fit-relationship').props.disabled, true)
})

test('relationship criteria preserve drawing viewport labels selection expansion and complete export', async t => {
  const source = graph([edge('A', { target_node_uuid: 'a' }), edge('B')])
  // Use the producer shape exercised by loaded-graph-file.test.js richGraph.
  source.nodes = source.nodes.map(record => ({ ...record, summary: '', attributes: {}, created_at: null }))
  source.edges = source.edges.map(record => ({ ...record,
    source_node_name: 'Alice', target_node_name: record.target_node_uuid === 'a' ? 'Alice' : 'Bob',
    attributes: {}, created_at: null, valid_at: null, invalid_at: null, expired_at: null, episodes: [],
  }))
  source.node_count = source.nodes.length
  source.edge_count = source.edges.length
  const metadata = { projectId: 'project-A', graphId: 'types-A', downloadedAt: '2026-10-14T00:00:00.000Z' }
  const before = createLoadedGraphFile(source, metadata), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle(); await relationships(h); await h.click(h.find('.graph-zoom-in'))
  const svg = h.find('.graph-svg'), root = svg.children.find(child => child.type === 'g')
  for (const selector of ['.node-labels-toggle', '.edge-labels-toggle']) {
    const checkbox = h.find(selector).querySelector('input')
    checkbox.checked = false; checkbox.dispatchEvent({ type: 'change' })
  }
  await settle()
  await h.click(paths(h).find(path => path.__data__.isSelfLoop))
  await h.click(h.find('.self-loop-item-header'))
  const originalPaths = paths(h), originalCircles = circles(h), transform = root.props.transform
  const panel = h.find('.detail-panel'), details = panel.textContent, selectedStyles = styles(h)
  const disclosure = h.find('.self-loop-item-content')
  for (const type of ['A', 'B', null]) {
    await chooseType(h, type)
    assert.strictEqual(h.find('.graph-svg'), svg)
    assert.strictEqual(svg.children.find(child => child.type === 'g'), root)
    assert.deepEqual(paths(h), originalPaths); assert.deepEqual(circles(h), originalCircles)
    assert.equal(root.props.transform, transform); assert.deepEqual(styles(h), selectedStyles)
    assert.strictEqual(h.find('.detail-panel'), panel); assert.equal(panel.textContent, details)
    assert.strictEqual(h.find('.self-loop-item-content'), disclosure)
    assert.equal(h.find('.self-loop-item-header').props['aria-expanded'], true)
    assert.equal(h.find('.graph-fit-relationship').props.disabled, false)
    assert.ok(h.find('.nodes').querySelectorAll('text').every(label => label.style.display === 'none'))
    assert.ok(h.find('.links').querySelectorAll('text').every(label => label.style.display === 'none'))
  }
  await chooseType(h, 'B'); await h.click(rows(h)[0])
  const selectedFact = h.find('.fact-text').textContent, resultStyles = styles(h)
  await chooseType(h, 'A')
  assert.equal(h.find('.fact-text').textContent, selectedFact)
  assert.deepEqual(styles(h), resultStyles)
  assert.equal(h.find('.graph-fit-relationship').props.disabled, false)
  assert.equal(JSON.stringify(source), original)
  assert.equal(createLoadedGraphFile(source, metadata), before)
  assert.deepEqual(h.emitted, [])
})

test('same-identity refresh retains a vanished relationship type and durably clamps the page', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph(matches(45)) })
  await settle(); await relationships(h); await chooseType(h, 'KNOWLEDGE'); await h.input('match')
  await h.click(h.find('.node-search-next')); await h.click(h.find('.node-search-next'))
  await h.click(rows(h)[0])
  await h.load(graph(matches(25)))
  assert.equal(choice(h), 'KNOWLEDGE'); assert.equal(range(h), expectedRange(21, 25, 25))
  assert.equal(h.find('.detail-panel'), null)
  await h.load(graph([edge('OTHER')]))
  assert.equal(choice(h), 'KNOWLEDGE')
  assert.deepEqual(options(h).map(option => option.textContent), ['All types', 'OTHER', 'KNOWLEDGE'])
  assert.equal(range(h), expectedRange(0, 0, 0))
  await h.load(graph(matches(45)))
  assert.equal(range(h), expectedRange(1, 20, 45))
  h.props.graphData.edges[0].fact_type = 'OTHER'; await settle()
  assert.equal(choice(h), 'KNOWLEDGE'); assert.equal(range(h), expectedRange(1, 20, 44))
})

test('mode changes clear both types and text while the active Relationships tab preserves criteria', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([edge()]) })
  await settle()
  const nodeSelect = h.find('.node-search-type-select')
  const person = nodeSelect.querySelectorAll('option').find(option => option.textContent === 'Person')
  nodeSelect.dispatchEvent({ type: 'change', target: { value: person.props.value } }); await settle()
  await h.input('ali'); await h.click(h.find('.node-search-result'))
  const details = h.find('.detail-panel').textContent
  await relationships(h)
  assert.equal(choice(h), 'All types'); assert.equal(h.find('.node-search-input').props.value, '')
  assert.equal(h.find('.node-search-type-select'), null)
  await chooseType(h, 'KNOWLEDGE'); await h.input('match'); await relationships(h)
  assert.equal(choice(h), 'KNOWLEDGE'); assert.equal(h.find('.node-search-input').props.value, 'match')
  assert.equal(h.find('.detail-panel').textContent, details)
  await h.click(h.find('.search-mode-nodes'))
  assert.equal(select(h), null); assert.equal(h.find('.node-search-type-select').props.value, 'all')
  assert.equal(h.find('.node-search-input').props.value, '')
  await relationships(h)
  assert.equal(choice(h), 'All types'); assert.equal(rows(h).length, 0)
})

test('changed missing or invalid graph identities and removal reset relationship criteria', async t => {
  const h = mountGraphPanel(t, { messages: english })
  for (const id of ['different', '', ' ', null, undefined, 42]) {
    await h.load(graph([edge()])); await relationships(h); await chooseType(h, 'KNOWLEDGE'); await h.input('match')
    const data = graph([edge()]); data.graph_id = id
    await h.load(data)
    assert.equal(h.find('.search-mode-nodes').props['aria-pressed'], true)
    assert.equal(h.find('.node-search-input').props.value, '')
    await relationships(h); assert.equal(choice(h), 'All types'); assert.equal(rows(h).length, 0)
  }
  await h.load(graph([edge()])); await relationships(h); await chooseType(h, 'KNOWLEDGE')
  await h.load(null); assert.equal(select(h), null)
  await h.load(graph([edge()])); await relationships(h); assert.equal(choice(h), 'All types')
})

test('resize keeps relationship criteria and source or mode retirement rejects captured selections', async t => {
  const h = mountGraphPanel(t, { messages: english, deferGraphRedraw: true, initialGraph: graph([edge()]) })
  await settle(); await redraw(h); await relationships(h); await chooseType(h, 'KNOWLEDGE')
  const captured = rows(h)[0].props.onClick
  h.resize(); captured({ stopPropagation() {} })
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(choice(h), 'KNOWLEDGE')
  await redraw(h); await h.click(rows(h)[0]); assert.ok(h.find('.detail-panel'))
  await h.load(graph([edge('KNOWLEDGE', { fact: 'Updated' })]))
  captured({ stopPropagation() {} }); await settle(); assert.equal(h.find('.detail-panel'), null)
  await redraw(h)
  const current = rows(h)[0].props.onClick
  await h.click(h.find('.search-mode-nodes')); await relationships(h); await chooseType(h, 'KNOWLEDGE')
  current({ stopPropagation() {} }); await settle(); assert.equal(h.find('.detail-panel'), null)
  h.close(); current({ stopPropagation() {} })
})

test('relationship type choices are independent between instances and reset after remount', async t => {
  const first = mountGraphPanel(t, { messages: english, initialGraph: graph([edge()]) })
  const second = mountGraphPanel(t, { messages: english, initialGraph: graph([edge()]) })
  await settle(); await relationships(first); await relationships(second); await chooseType(first, 'KNOWLEDGE')
  assert.equal(choice(second), 'All types'); assert.equal(rows(second).length, 0)
  first.close()
  const replacement = mountGraphPanel(t, { messages: english, initialGraph: graph([edge()]) })
  await settle(); await relationships(replacement); assert.equal(choice(replacement), 'All types')
})
