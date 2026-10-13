import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

const messagesFor = locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
const english = messagesFor('en')
const node = (uuid, name) => ({ uuid, name, labels: ['Entity', 'Person'] })
const edge = (fact = 'Match fact', extra = {}) => ({ uuid: 'relation', name: 'KNOWS', fact_type: 'KNOWLEDGE', fact,
  source_node_uuid: 'a', target_node_uuid: 'b', ...extra })
const graph = (edges = [], nodes = [node('a', 'Alice'), node('b', 'Bob')], graph_id = 'graph-A') => ({ graph_id, nodes, edges })
const rows = h => h.host.querySelectorAll('.relationship-search-result')
const paths = h => h.find('.links')?.querySelectorAll('path') ?? []
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const detail = h => h.find('.detail-content')?.textContent
const fact = h => h.find('.fact-text')?.textContent
const next = h => h.find('.node-search-next')
const previous = h => h.find('.node-search-previous')
const range = h => h.find('.node-search-range')?.textContent
const expectedRange = (start, end, total) => english.graph.searchRange.replace('{start}', start).replace('{end}', end).replace('{total}', total)
const captured = button => button.props.onClick
const invoke = fn => fn({ stopPropagation() {} })
const flushRedraws = async h => { for (const redraw of h.takeRedraws()) redraw(); await settle() }
const choose = async (h, mode = 'relationships') => {
  const button = h.find(`.search-mode-${mode}`)
  assert.ok(button, 'explicit Nodes/Relationships selector exists')
  await h.click(button)
}
const search = async (h, query) => { await choose(h); await h.input(query) }
const styleSnapshot = h => ({ circles: circles(h).map(c => [c.props.stroke, c.props['stroke-width']]),
  paths: paths(h).map(p => [p.props.stroke, p.props['stroke-width']]),
  labels: h.find('.links')?.querySelectorAll('text').map(p => p.props.fill) ?? [],
  backgrounds: h.find('.links')?.querySelectorAll('rect').map(p => p.props.fill) ?? [] })

test('mode defaults to Nodes; switching clears query/page and preserves details, drawing and expansion', async t => {
  const records = Array.from({ length: 21 }, (_, i) => edge(`Match ${i}`))
  records.push(edge('Loop fact', { source_node_uuid: 'a', target_node_uuid: 'a' }))
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph(records) })
  await settle()
  assert.equal(h.find('.search-mode-nodes')?.props['aria-pressed'], true)
  for (const mode of ['nodes', 'relationships']) {
    const button = h.find(`.search-mode-${mode}`)
    assert.equal(button.type, 'button'); assert.equal(button.props.type, 'button')
  }
  await h.input('Alice'); await h.click(h.find('.node-search-result'))
  const selected = detail(h), styles = styleSnapshot(h), originalPaths = paths(h)
  await choose(h)
  assert.equal(h.find('.node-search-input').props.value, '')
  assert.equal(detail(h), selected); assert.deepEqual(styleSnapshot(h), styles)
  await h.input('match'); await h.click(next(h))
  const group = paths(h).find(p => p.__data__.rawData.isSelfLoopGroup)
  await h.click(group); await h.click(h.find('.self-loop-item-header'))
  const grouped = detail(h), expanded = h.find('.self-loop-item-header')
  await choose(h, 'nodes')
  assert.equal(detail(h), grouped); assert.equal(expanded.props['aria-expanded'], true)
  await choose(h); await h.input('match')
  assert.equal(range(h), expectedRange(1, 20, 21))
  assert.deepEqual(paths(h), originalPaths); assert.deepEqual(h.emitted, [])
})

test('only five separate string fields match trimmed case-insensitive literal queries', async t => {
  const h = mountGraphPanel(t)
  const records = [
    edge('not here', { name: 'Name.[x]*+ End', fact_type: 'type0' }),
    edge('Full FACT.[x]*+ suffix', { name: 'other1', fact_type: 'type1' }),
    edge('', { name: 'other2', fact_type: 'Type.[x]*+ End' }),
    edge('', { name: 'other3', source_node_uuid: 'c' }),
    edge('', { name: 'other4', target_node_uuid: 'c' }),
  ]
  await h.load(graph(records, [node('a', 'Alice'), node('b', 'Bob'), node('c', 'Endpoint.[x]*+ End')]))
  await search(h, '  .[X]*+  ')
  assert.equal(rows(h).length, 5)
  for (const [query, count] of [['name.[x]*+', 1], ['fact.[x]*+', 1], ['type.[x]*+', 1], ['endpoint.[x]*+', 2], ['x.*end', 0]]) {
    await h.input(query); assert.equal(rows(h).length, count, query)
  }
  await h.load(graph([edge('beta', { name: 'alpha', fact_type: 123, attributes: { hidden: 'attribute-only' },
    episodes: ['episode-only'], created_at: 'date-only', uuid: 'uuid-only', source_name: 'enriched-only' })]))
  for (const query of ['alpha beta', 'attribute-only', 'episode-only', 'date-only', 'uuid-only', 'enriched-only', '123', 'source_node_uuid']) {
    await h.input(query); assert.equal(rows(h).length, 0, `${query} is not an eligible field`)
  }
})

test('endpoint text prefers current node names, then producer names, then UUID, without indexing Unknown placeholders', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([
    edge('current', { source_node_name: 'Old Alice', target_node_name: 'Old Bob' }),
    edge('producer', { source_node_uuid: 'missing-a', target_node_uuid: 'missing-b', source_node_name: 'Producer Source', target_node_name: 'Producer Target' }),
    edge('uuid', { source_node_uuid: 'endpoint-a', target_node_uuid: 'endpoint-b' }),
    edge('placeholder', { source_node_uuid: null, target_node_uuid: undefined, name: null, fact_type: null }),
  ]))
  await search(h, 'alice'); assert.equal(rows(h).length, 1)
  assert.equal(rows(h)[0].querySelector('.relationship-search-endpoints').textContent, 'Alice → Bob')
  for (const query of ['old alice', 'old bob', 'Unknown', 'RELATED_TO']) {
    await h.input(query); assert.equal(rows(h).length, 0)
  }
  await h.input('producer source')
  assert.equal(rows(h)[0].querySelector('.relationship-search-endpoints').textContent, 'Producer Source → Producer Target')
  await h.input('endpoint-b'); assert.equal(rows(h).length, 1)
  await h.load(graph([edge('fallback', { source_node_name: 'Producer Alice' })], [node('a', ''), node('b', 42)]))
  await h.input('producer alice')
  assert.equal(rows(h)[0].querySelector('.relationship-search-endpoints').textContent, 'Producer Alice → b')
})

test('full facts remain searchable while literal previews and all row strings are bounded and safe', async t => {
  const h = mountGraphPanel(t)
  const hostile = '<img src=x onerror=alert(1)> & <script>literal</script>'
  const longFact = 'x'.repeat(170) + hostile
  await h.load(graph([edge(longFact, { name: hostile, fact_type: '<b>Type</b>', uuid: '<svg onload=alert(1)>', source_node_name: 'unused' })], [node('a', '<b>Alice</b>'), node('b', 'Bob')]))
  await search(h, '<script>literal</script>')
  const row = rows(h)[0]
  assert.equal(row.querySelector('.relationship-search-fact').textContent, 'x'.repeat(160) + '…')
  assert.ok(row.textContent.includes(hostile)); assert.ok(row.textContent.includes('<b>Type</b>'))
  assert.ok(row.textContent.includes('<svg onload=alert(1)>')); assert.ok(row.textContent.includes('<b>Alice</b>'))
  assert.equal(row.querySelector('img'), null); assert.equal(row.querySelector('script'), null)
  assert.ok(row.querySelectorAll('*').every(n => !Object.hasOwn(n.props, 'innerHTML')))
  await h.click(row); assert.equal(fact(h), longFact)
  const bounded = '😀'.repeat(100)
  await h.load(graph([edge(bounded)])); await h.input(bounded + 'ignored')
  assert.equal(h.find('.node-search-input').props.value, bounded)
  assert.equal(h.find('.node-search-input').props.value.length, 200)
  assert.equal(rows(h).length, 1)
})

for (const count of [0, 1, 20, 21, 40, 45]) {
  test(`relationship pages preserve raw source order and exact range for ${count} matches`, async t => {
    const h = mountGraphPanel(t, { messages: english })
    const matches = Array.from({ length: count }, (_, i) => edge(`Match ${i + 1}`, { uuid: i % 2 ? undefined : 'duplicate' }))
    await h.load(graph(matches.flatMap(record => [edge('other'), record])))
    await search(h, 'match')
    const originalPaths = paths(h)
    const pageCount = Math.max(1, Math.ceil(count / 20))
    for (let page = 1; page <= pageCount; page++) {
      const offset = (page - 1) * 20
      assert.equal(rows(h).length, Math.min(20, count - offset))
      assert.equal(range(h), expectedRange(count ? offset + 1 : 0, Math.min(offset + 20, count), count))
      assert.equal(previous(h).props.disabled, page === 1); assert.equal(next(h).props.disabled, page === pageCount)
      for (const [i, button] of rows(h).entries()) {
        assert.equal(button.querySelector('.node-search-position').textContent, english.graph.searchPosition.replace('{position}', String((offset + i) * 2 + 2)))
        await h.click(button); assert.equal(fact(h), `Match ${offset + i + 1}`)
        assert.deepEqual(paths(h).map(path => path.props.stroke === '#3498db'), paths(h).map((_path, index) => index === (offset + i) * 2 + 1))
      }
      assert.deepEqual(paths(h), originalPaths)
      await h.click(next(h))
    }
    invoke(captured(next(h))); await settle()
    assert.equal(next(h).props.disabled, true)
    const selected = detail(h), styles = styleSnapshot(h)
    await h.input(''); assert.equal(rows(h).length, 0)
    assert.equal(h.find('.node-search-pagination'), null)
    assert.equal(h.find('.node-search-status').textContent, count ? english.graph.searchRelationshipPrompt : english.graph.searchEmptyRelationships)
    assert.equal(detail(h), selected); assert.deepEqual(styleSnapshot(h), styles)
    assert.deepEqual(paths(h), originalPaths); assert.deepEqual(h.emitted, [])
  })
}

test('equal-looking ordinary records, repeated references and missing UUIDs select their exact rendered occurrence', async t => {
  const shared = edge('Same fact')
  const h = mountGraphPanel(t)
  await h.load(graph([shared, { ...shared }, shared, edge('Same fact', { uuid: undefined }), edge('Same fact', { uuid: undefined })]))
  await search(h, 'same')
  assert.equal(rows(h).length, 5)
  for (let i = 0; i < 5; i++) {
    await h.click(rows(h)[i]); assert.equal(fact(h), 'Same fact')
    assert.deepEqual(paths(h).map(path => path.props.stroke), paths(h).map((_path, index) => index === i ? '#3498db' : '#C0C0C0'))
  }
})

test('self-loop search opens exact individual members and leaves grouped pointer expansion behavior intact', async t => {
  const h = mountGraphPanel(t, { messages: english })
  const loops = [edge('Match first', { target_node_uuid: 'a' }), edge('Match second', { target_node_uuid: 'a' }),
    edge('Match third', { target_node_uuid: 'a', uuid: undefined })]
  await h.load(graph([edge('unrelated'), ...loops]))
  await search(h, 'match')
  assert.equal(paths(h).length, 2)
  const group = paths(h)[1]
  for (const [index, button] of rows(h).entries()) {
    await h.click(button)
    assert.equal(fact(h), loops[index].fact)
    assert.equal(h.find('.self-loop-list'), null)
    assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchIndividualSelfRelation)
    assert.equal(group.props.stroke, '#3498db'); assert.equal(paths(h)[0].props.stroke, '#C0C0C0')
  }
  await h.click(group)
  assert.equal(h.host.querySelectorAll('.self-loop-item').length, 3)
  assert.ok(h.host.querySelectorAll('.self-loop-item-header').every(button => button.props['aria-expanded'] === false))
  await h.click(h.host.querySelectorAll('.self-loop-item-header')[0])
  assert.deepEqual(h.host.querySelectorAll('.self-loop-item-header').map(button => button.props['aria-expanded']), [true, true, false], 'published duplicate-UUID expansion remains shared')
  await h.click(rows(h)[1]); assert.equal(fact(h), 'Match second'); assert.equal(h.find('.self-loop-list'), null)
  await h.click(group)
  assert.deepEqual(h.host.querySelectorAll('.self-loop-item-header').map(button => button.props['aria-expanded']), [true, true, false], 'search neither expands nor resets grouped disclosure state')
})

test('missing endpoints open details only and clear all node, line and label highlights', async t => {
  const h = mountGraphPanel(t, { messages: english })
  await h.load(graph([edge('Drawn'), edge('Missing source', { source_node_uuid: 'gone', source_node_name: 'Former source' }),
    edge('Missing both', { source_node_uuid: 'gone-a', target_node_uuid: 'gone-b' })]))
  await h.select('a'); await h.click(h.find('.links').querySelector('text'))
  await search(h, 'missing')
  for (const button of rows(h)) {
    await h.click(button)
    assert.ok(fact(h).startsWith('Missing'))
    assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchRelationshipDetailsOnly)
    assert.ok(circles(h).every(circle => circle.props.stroke === '#fff'))
    assert.ok(paths(h).every(path => path.props.stroke === '#C0C0C0'))
    assert.ok(h.find('.links').querySelectorAll('text').every(label => label.props.fill === '#666'))
    assert.ok(h.find('.links').querySelectorAll('rect').every(bg => bg.props.fill === 'rgba(255,255,255,0.95)'))
  }
  assert.ok(detail(h).includes('gone-a')); assert.ok(detail(h).includes('gone-b'))
})

test('zero-node graphs complete relationship activation only after empty redraw, with no node search results', async t => {
  const h = mountGraphPanel(t, { messages: english, deferGraphRedraw: true })
  await h.load(graph([edge('Orphan relation')], []))
  await search(h, 'orphan')
  assert.equal(rows(h).length, 1); assert.equal(rows(h)[0].props.disabled, true)
  const saved = captured(rows(h)[0]); invoke(saved); await settle()
  assert.equal(h.find('.detail-panel'), null)
  await flushRedraws(h)
  assert.equal(rows(h)[0].props.disabled, false)
  invoke(saved); await settle(); assert.equal(fact(h), 'Orphan relation')
  assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchRelationshipDetailsOnly)
  assert.equal(circles(h).length, 0); assert.equal(paths(h).length, 0)
  await h.click(h.find('.graph-svg')); assert.equal(h.find('.detail-panel'), null)
  await choose(h, 'nodes'); await h.input('Alice')
  assert.equal(h.host.querySelectorAll('.node-search-result').length, 0)
  assert.equal(h.find('.node-search-status').textContent, english.graph.searchEmptyGraph)
})

test('deep changes, reorder, removal and replacement synchronously retire result and pointer callbacks', async t => {
  const h = mountGraphPanel(t, { deferGraphRedraw: true })
  await h.load(graph([edge('Match old'), edge('Match second', { uuid: undefined })])); await flushRedraws(h)
  await search(h, 'match')
  const changes = [
    () => { h.props.graphData.edges[0].fact = 'Match changed' },
    () => { h.props.graphData.edges.reverse() },
    () => { h.props.graphData.edges[0].episodes = ['deep change'] },
    () => { h.props.graphData.edges.splice(0, 1) },
    () => h.load(graph([edge('Match replacement')])),
  ]
  for (const change of changes) {
    const saved = captured(rows(h)[0]), oldPointers = ['path', 'rect', 'text'].map(type => h.find('.links').querySelector(type))
    const before = oldPointers.map(p => JSON.stringify(p.props))
    const delivered = change()
    // Top-level props pass through the fixture's parent render; await delivery,
    // while actual graph redraw remains deferred. Deep mutations stay immediate.
    if (delivered) await delivered
    invoke(saved)
    for (const pointer of oldPointers) pointer.dispatchEvent({ type: 'click' })
    assert.deepEqual(oldPointers.map(p => JSON.stringify(p.props)), before, 'retired pointer handlers cannot alter old highlights')
    await settle(); assert.equal(h.find('.detail-panel'), null)
    if (rows(h).length) assert.equal(rows(h)[0].props.disabled, true)
    await flushRedraws(h)
    await h.click(rows(h)[0]); assert.ok(fact(h).startsWith('Match'))
    h.props.graphData.edges[0].attributes = { changed: true }
    await settle(); assert.equal(h.find('.detail-panel'), null, 'data changes close search-opened details')
    await flushRedraws(h)
  }
})

test('mode transitions invalidate captured callbacks even after returning to the original mode', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([edge('Match')]))
  await h.input('Alice'); const nodeClick = captured(h.find('.node-search-result'))
  await choose(h); invoke(nodeClick); await settle(); assert.equal(h.find('.detail-panel'), null)
  await h.input('match'); const relationClick = captured(rows(h)[0])
  await choose(h, 'nodes'); invoke(relationClick); await settle(); assert.equal(h.find('.detail-panel'), null)
  await choose(h); invoke(relationClick); await settle(); assert.equal(h.find('.detail-panel'), null)
  await choose(h, 'nodes'); invoke(nodeClick); await settle(); assert.equal(h.find('.detail-panel'), null)
})

test('same identified refresh keeps mode/query and durably clamps page; invalid identities reset Nodes and blank', async t => {
  const h = mountGraphPanel(t, { messages: english })
  const records = count => Array.from({ length: count }, (_, i) => edge(`Match ${i}`))
  await h.load(graph(records(45))); await search(h, 'match'); await h.click(next(h)); await h.click(next(h))
  const oldClick = captured(rows(h)[0]); await h.click(rows(h)[0])
  await h.load(graph(records(25))); invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(h.find('.search-mode-relationships').props['aria-pressed'], true)
  assert.equal(h.find('.node-search-input').props.value, 'match')
  assert.equal(range(h), expectedRange(21, 25, 25))
  await h.load(graph(records(45))); assert.equal(range(h), expectedRange(21, 40, 45))
  h.props.graphData.edges.splice(0); await settle(); assert.equal(range(h), expectedRange(0, 0, 0))
  h.props.graphData.edges.push(...records(45)); await settle(); assert.equal(range(h), expectedRange(1, 20, 45))
  for (const id of ['other', undefined, undefined, '', ' ', null, 42]) {
    const data = graph(records(21)); data.graph_id = id
    await h.load(data)
    assert.equal(h.find('.search-mode-nodes').props['aria-pressed'], true)
    assert.equal(h.find('.node-search-input').props.value, '')
    await search(h, 'match'); await h.click(next(h))
  }
  await h.load(null); assert.equal(h.find('.node-search'), null)
  await h.load(graph(records(21)))
  assert.equal(h.find('.search-mode-nodes').props['aria-pressed'], true)
  assert.equal(h.find('.node-search-input').props.value, '')
})

test('resize preserves state, disables pending activation, rejects old pointer render and resolves valid search callbacks against current drawing', async t => {
  const h = mountGraphPanel(t, { messages: english, deferGraphRedraw: true })
  await h.load(graph(Array.from({ length: 21 }, (_, i) => edge(`Match ${i}`)))); await flushRedraws(h)
  await search(h, 'match'); await h.click(next(h)); const saved = captured(rows(h)[0])
  const oldPointers = ['path', 'rect', 'text'].map(type => h.find('.links').querySelector(type))
  assert.equal(h.takeRedraws().length, 0)
  h.resize(); const older = h.takeRedraws(); await settle()
  assert.equal(rows(h)[0].props.disabled, true); invoke(saved); await settle(); assert.equal(h.find('.detail-panel'), null)
  h.resize(); const current = h.takeRedraws()
  for (const redraw of older) redraw(); await settle(); assert.equal(rows(h)[0].props.disabled, true)
  for (const redraw of current) redraw(); await settle()
  assert.equal(range(h), expectedRange(21, 21, 21)); assert.equal(h.find('.node-search-input').props.value, 'match')
  for (const pointer of oldPointers) await h.click(pointer)
  assert.equal(h.find('.detail-panel'), null)
  invoke(saved); await settle(); assert.equal(fact(h), 'Match 20'); assert.equal(paths(h)[20].props.stroke, '#3498db')
  await h.click(h.find('.detail-close'))
  h.resize(); const afterUnmount = h.takeRedraws(); h.close()
  for (const redraw of afterUnmount) redraw(); invoke(saved)
  for (const pointer of oldPointers) pointer.dispatchEvent({ type: 'click' })
  await settle(); assert.equal(h.host.children.length, 0)
})

test('all three current pointer controls still open ordinary and grouped edge details', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([edge('Ordinary'), edge('Grouped', { target_node_uuid: 'a' })]))
  await choose(h); await choose(h, 'nodes')
  for (const type of ['path', 'rect', 'text']) {
    const pointers = h.find('.links').querySelectorAll(type)
    await h.click(pointers[0]); assert.equal(fact(h), 'Ordinary'); assert.equal(h.find('.self-loop-list'), null)
    await h.click(pointers[1]); assert.ok(h.find('.self-loop-list')); assert.ok(detail(h).includes('Grouped'))
  }
})

test('English and Chinese relationship controls, empty states and notices are localized', async t => {
  for (const locale of ['en', 'zh']) {
    const messages = messagesFor(locale)
    const keys = ['searchMode', 'searchModeNodes', 'searchModeRelationships', 'searchRelationships', 'searchRelationshipPlaceholder',
      'searchRelationshipPrompt', 'searchEmptyRelationships', 'searchIndividualSelfRelation', 'searchRelationshipDetailsOnly']
    for (const key of keys) assert.ok(typeof messages.graph[key] === 'string' && messages.graph[key].trim(), `${locale}: ${key}`)
    const h = mountGraphPanel(t, { messages })
    await h.load(graph([edge('Loop', { target_node_uuid: 'a' }), edge('Missing', { target_node_uuid: 'missing' })]))
    assert.equal(h.find('.search-mode-nodes').textContent, messages.graph.searchModeNodes)
    assert.equal(h.find('.search-mode-relationships').textContent, messages.graph.searchModeRelationships)
    await choose(h)
    assert.ok(h.find('.node-search-input').parentNode.textContent.includes(messages.graph.searchRelationships))
    assert.equal(h.find('.node-search-input').props.placeholder, messages.graph.searchRelationshipPlaceholder)
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchRelationshipPrompt)
    await h.input('loop'); await h.click(rows(h)[0])
    assert.equal(h.find('.relationship-search-notice').textContent, messages.graph.searchIndividualSelfRelation)
    await h.input('missing'); await h.click(rows(h)[0])
    assert.equal(h.find('.relationship-search-notice').textContent, messages.graph.searchRelationshipDetailsOnly)
    await h.load(graph([])); assert.equal(h.find('.node-search-status').textContent, messages.graph.searchEmptyRelationships)
  }
})


test('raw positions survive omitted edges and populated-to-empty refresh installs a current dismiss handler', async t => {
  const h = mountGraphPanel(t, { messages: english, deferGraphRedraw: true })
  await h.load(graph([edge('Omitted', { source_node_uuid: 'missing' }), edge('Match drawn')]))
  await flushRedraws(h); await search(h, 'match');
  assert.equal(rows(h)[0].querySelector('.node-search-position').textContent, english.graph.searchPosition.replace('{position}', '2'))
  await h.click(rows(h)[0]); assert.equal(paths(h)[0].props.stroke, '#3498db')
  await h.load(graph([edge('Match orphan')], [])); await flushRedraws(h)
  await h.click(rows(h)[0]); assert.equal(fact(h), 'Match orphan')
  await h.click(h.find('.detail-close')); assert.equal(h.find('.detail-panel'), null)
  await h.click(rows(h)[0]); h.resize(); await flushRedraws(h)
  assert.equal(fact(h), 'Match orphan')
  await h.click(h.find('.graph-svg')); assert.equal(h.find('.detail-panel'), null)
  await h.click(rows(h)[0]); assert.equal(fact(h), 'Match orphan')
})


test('relationship no-match feedback names relationships in both locales and node feedback stays unchanged', async t => {
  for (const locale of ['en', 'zh']) {
    const messages = messagesFor(locale)
    const h = mountGraphPanel(t, { messages })
    await h.load(graph([edge('Existing fact')]))
    await search(h, 'no-such-record')
    assert.equal(rows(h).length, 0)
    assert.equal(h.find('.node-search-status').textContent,
      locale === 'en' ? 'No matching relationships.' : '没有匹配的关系。')
    await choose(h, 'nodes'); await h.input('no-such-record')
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchNoMatches)
  }
})
