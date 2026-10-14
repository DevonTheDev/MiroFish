import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'
import { createLoadedGraphFile } from '../src/utils/loadedGraphFile.js'

// Mounted real Vue SFC and D3. This synthetic host does not establish native
// select keyboard behavior, focus, browser geometry or visual placement.
const messagesFor = locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
const english = messagesFor('en')
const node = (name, uuid, labels = ['Entity', 'Person'], attributes = {}) => ({
  name, uuid, labels, attributes, summary: '', created_at: null,
})
const graph = (nodes = [], graph_id = 'types-A', edges = []) => ({
  graph_id, nodes, edges, node_count: nodes.length, edge_count: edges.length,
})
const select = h => h.find('.node-search-type-select')
const options = h => select(h)?.querySelectorAll('option') ?? []
const choice = h => options(h).find(option => option.props.value === select(h).props.value)?.textContent
const rows = h => h.host.querySelectorAll('.node-search-result')
const names = h => rows(h).map(row => row.querySelector('.node-search-name').textContent)
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const range = h => h.find('.node-search-range')?.textContent
const expectedRange = (start, end, total) => english.graph.searchRange
  .replace('{start}', String(start)).replace('{end}', String(end)).replace('{total}', String(total))
const chooseType = async (h, type) => {
  assert.ok(select(h), 'Nodes mode offers a displayed-type control')
  const option = type === null ? options(h)[0] : options(h).slice(1).find(option => option.textContent === type)
  assert.ok(option, `type option exists: ${type}`)
  select(h).dispatchEvent({ type: 'change', target: { value: option.props.value } })
  await settle()
}
const matches = count => Array.from({ length: count }, (_, index) => node(`Match ${index}`, `n${index}`, ['Person'], { position: index }))
const redraw = h => {
  const pending = h.takeRedraws()
  assert.equal(pending.length, 1)
  pending[0]()
}
const styles = h => ({
  circles: circles(h).map(circle => [circle.props.stroke, circle.props['stroke-width']]),
  edges: (h.find('.links')?.querySelectorAll('path') ?? []).map(edge => [edge.props.stroke, edge.props['stroke-width']]),
})

test('an explicit displayed type finds nodes without a name query', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    node('Alice', 'a'), node('Harbor', 'b', ['Place']),
  ]) })
  await settle()
  assert.equal(rows(h).length, 0, 'All types plus blank name preserves the existing empty search')
  await chooseType(h, 'Person')
  assert.deepEqual(names(h), ['Alice'])
  assert.equal(range(h), expectedRange(1, 1, 1))
  assert.equal(h.find('.node-search-input').props.value, '')
  await chooseType(h, null)
  assert.equal(rows(h).length, 0)
  assert.equal(h.find('.node-search-pagination'), null)
})

for (const [locale, label, all, noMatches] of [
  ['en', 'Displayed type', 'All types', 'No matching nodes.'],
  ['zh', '显示类型', '所有类型', '没有匹配的节点。'],
]) {
  test(`${locale} displayed-type control has a native visible label and localized feedback`, async t => {
    const messages = messagesFor(locale)
    const h = mountGraphPanel(t, { messages, initialGraph: graph([node('Alice', 'a')]) })
    await settle()
    const input = select(h)
    assert.ok(input)
    assert.equal(input.type, 'select')
    assert.equal(input.parentNode.type, 'label')
    assert.ok(input.parentNode.textContent.includes(label))
    assert.equal(input.props.tabindex, undefined)
    assert.equal(choice(h), all)
    assert.equal(h.find('.node-search-type-hint').textContent, messages.graph.searchTypeHint)
    assert.ok(messages.graph.searchTypeHint && !messages.graph.searchTypeHint.includes('graph.'))
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchPrompt)
    await chooseType(h, 'Person')
    await h.input('absent')
    assert.equal(h.find('.node-search-status').textContent, noMatches)
    const source = readFileSync(new URL('../src/components/GraphPanel.vue', import.meta.url), 'utf8')
    assert.match(source, /\.node-search-type-select:focus-visible/)
  })
}

test('displayed primary type follows label order and the existing Entity fallback', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    node('Single', 'a', ['Person']),
    node('Secondary place', 'b', ['Entity', 'Person', 'Place']),
    node('Primary place', 'c', ['Place', 'Person']),
    node('Entity only', 'd', ['Entity']),
    node('Empty labels', 'e', []),
    node('Null labels', 'f', null),
    { name: 'Missing labels', uuid: 'g' },
    node('Empty first label', 'h', ['', 'Person']),
    node(null, 'i', ['Person']),
    node('', 'j', ['Person']),
  ]) })
  await settle()
  assert.deepEqual(options(h).map(option => option.textContent), ['All types', 'Person', 'Place', 'Entity'])
  await chooseType(h, 'Place')
  assert.deepEqual(names(h), ['Primary place'])
  await chooseType(h, 'Entity')
  assert.deepEqual(names(h), ['Entity only', 'Empty labels', 'Null labels', 'Missing labels', 'Empty first label'])
  await chooseType(h, 'Person')
  assert.deepEqual(names(h), ['Single', 'Secondary place', '', ''])
  await h.input('Unnamed')
  assert.equal(rows(h).length, 0, 'drawing fallback names are not indexed')
})

test('type matching is exact and literal and a type named all remains distinct from All types', async t => {
  // These values exercise filter storage and opaque option IDs; legend/color
  // behavior for prototype-like labels is an existing, separate concern.
  const types = ['all', 'type-0', '__proto__', 'constructor', 'Person', 'person', ' Person ', '<b>Person</b>']
  const h = mountGraphPanel(t, { messages: english,
    initialGraph: graph(types.map((type, index) => node(`Member ${index}`, String(index), [type]))) })
  await settle()
  for (const [index, type] of types.entries()) {
    await chooseType(h, type)
    assert.equal(choice(h), type)
    assert.deepEqual(names(h), [`Member ${index}`])
    assert.equal(rows(h)[0].querySelector('.node-search-type').textContent, type)
    assert.equal(rows(h)[0].querySelector('b'), null, 'type text does not become markup')
  }
  assert.notEqual(options(h)[0].props.value, options(h)[1].props.value)
  await chooseType(h, null)
  await h.input('member')
  assert.equal(rows(h).length, types.length)
})

test('name and type compose with AND while available type choices stay independent of the query', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([
    node('Alpha.[x] end', 'a'), node('ALPHA.[X] end', 'b', ['Place']), node('Other', 'c', ['Person']),
  ]) })
  await settle()
  await chooseType(h, 'Person')
  await h.input('  aLpHa.[X]  ')
  assert.deepEqual(names(h), ['Alpha.[x] end'])
  assert.deepEqual(options(h).map(option => option.textContent), ['All types', 'Person', 'Place'])
  await chooseType(h, 'Place')
  assert.deepEqual(names(h), ['ALPHA.[X] end'])
  assert.equal(h.find('.node-search-input').props.value, '  aLpHa.[X]  ')
  await h.input('')
  assert.deepEqual(names(h), ['ALPHA.[X] end'])
  await chooseType(h, null)
  assert.equal(rows(h).length, 0)
})

for (const count of [0, 1, 20, 21, 45]) {
  test(`type and name criteria page ${count} matches in source order with original positions`, async t => {
    const wanted = matches(count)
    const records = [node('Other person', 'seed'), ...wanted.flatMap((record, index) => [
      node(`Match gap ${index}`, `gap${index}`, ['Place']), record,
    ])]
    const h = mountGraphPanel(t, { messages: english, initialGraph: graph(records) })
    await settle()
    await chooseType(h, 'Person')
    await h.input('match')
    const originalCircles = circles(h)
    const pages = Math.max(1, Math.ceil(count / 20))
    for (let page = 1; page <= pages; page++) {
      const offset = (page - 1) * 20
      assert.deepEqual(names(h), wanted.slice(offset, offset + 20).map(record => record.name))
      assert.equal(range(h), expectedRange(count ? offset + 1 : 0, Math.min(offset + 20, count), count))
      assert.equal(h.find('.node-search-previous').props.disabled, page === 1)
      assert.equal(h.find('.node-search-next').props.disabled, page === pages)
      rows(h).forEach((row, index) => {
        assert.equal(row.querySelector('.node-search-position').textContent,
          english.graph.searchPosition.replace('{position}', String((offset + index) * 2 + 3)))
      })
      if (page < pages) await h.click(h.find('.node-search-next'))
    }
    assert.deepEqual(circles(h), originalCircles)
    await chooseType(h, null)
    assert.equal(h.find('.node-search-previous').props.disabled, true, 'type changes reset the page')
    assert.equal(h.find('.node-search-input').props.value, 'match')
    assert.deepEqual(h.emitted, [])
  })
}

test('filtered later-page results select exact duplicate and repeated source occurrences', async t => {
  const shared = node('Shared', 'duplicate', ['Person'], { marker: 'shared' })
  const records = matches(23)
  records[0] = shared
  records[20] = node('Duplicate', 'duplicate', ['Person'], { marker: 'later' })
  records[21] = node('Missing UUID', undefined, ['Person'], { marker: 'missing' })
  records[22] = shared
  const h = mountGraphPanel(t, { initialGraph: graph(records) })
  await settle()
  await chooseType(h, 'Person')
  await h.click(h.find('.node-search-next'))
  for (let index = 0; index < 3; index++) {
    await h.click(rows(h)[index])
    assert.equal(h.properties().marker, ['later', 'missing', 'shared'][index])
    assert.deepEqual(circles(h).map(circle => circle.props.stroke),
      circles(h).map((_circle, sourceIndex) => sourceIndex === 20 + index ? '#E91E63' : '#fff'))
  }
})

test('changing type preserves drawing, viewport, labels, selection and expanded self-relation details', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph([node('Alice', 'a'), node('Harbor', 'b', ['Place'])], 'types-A', [
    { uuid: 'aa', name: 'REFLECTS', fact: 'Self fact', source_node_uuid: 'a', target_node_uuid: 'a' },
  ]) })
  await settle()
  const svg = h.find('svg'), root = svg.children.find(child => child.type === 'g')
  await h.click(h.find('.graph-zoom-in'))
  const transform = root.props.transform, originalCircles = circles(h)
  const checkbox = h.find('.node-labels-toggle').querySelector('input')
  checkbox.checked = false
  checkbox.dispatchEvent({ type: 'change' })
  await settle()
  await h.click(h.find('.links').querySelector('path'))
  await h.click(h.find('.self-loop-item-header'))
  const panel = h.find('.detail-panel'), details = panel.textContent, disclosure = h.find('.self-loop-item-content')
  const originalStyles = styles(h)
  for (const type of ['Person', 'Place', null]) {
    await chooseType(h, type)
    assert.strictEqual(h.find('svg'), svg)
    assert.strictEqual(svg.children.find(child => child.type === 'g'), root)
    assert.deepEqual(circles(h), originalCircles)
    assert.equal(root.props.transform, transform)
    assert.deepEqual(styles(h), originalStyles)
    assert.strictEqual(h.find('.detail-panel'), panel)
    assert.equal(panel.textContent, details)
    assert.strictEqual(h.find('.self-loop-item-content'), disclosure)
    assert.equal(h.find('.self-loop-item-header').props['aria-expanded'], true)
    assert.ok(h.find('.nodes').querySelectorAll('text').every(label => label.style.display === 'none'))
  }
  await chooseType(h, 'Person')
  await h.click(rows(h)[0])
  const selectedText = h.find('.detail-panel').textContent, selectedStyles = styles(h)
  await chooseType(h, 'Place')
  assert.equal(h.find('.detail-panel').textContent, selectedText)
  assert.deepEqual(styles(h), selectedStyles)
  assert.equal(h.find('.graph-center-selected').props.disabled, false)
  assert.equal(root.props.transform, transform)
  assert.deepEqual(h.emitted, [])
})

test('same-ID refresh retains an absent selected type and durably clamps its page before reappearance', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph(matches(45)) })
  await settle()
  await chooseType(h, 'Person')
  await h.input('match')
  await h.click(h.find('.node-search-next')); await h.click(h.find('.node-search-next'))
  await h.click(rows(h)[0])
  await h.load(graph(matches(25)))
  assert.equal(choice(h), 'Person')
  assert.equal(range(h), expectedRange(21, 25, 25))
  assert.equal(h.find('.detail-panel'), null)
  await h.load(graph([node('Match harbor', 'b', ['Place'])]))
  assert.equal(choice(h), 'Person', 'the selected type remains a visible option when absent')
  assert.deepEqual(options(h).map(option => option.textContent), ['All types', 'Place', 'Person'])
  assert.equal(rows(h).length, 0)
  assert.equal(range(h), expectedRange(0, 0, 0))
  await h.load(graph(matches(45)))
  assert.equal(range(h), expectedRange(1, 20, 45), 'growth cannot revive the vanished page')
  h.props.graphData.nodes[0].labels = ['Place']
  await settle()
  assert.equal(choice(h), 'Person')
  assert.equal(range(h), expectedRange(1, 20, 44))
})

test('switching search mode clears the type and query while retaining details and relationship matching', async t => {
  const h = mountGraphPanel(t, { messages: english, initialGraph: graph([node('Alice', 'a')], 'types-A', [
    { uuid: 'aa', name: 'REFLECTS', fact: 'Full fact', fact_type: 'Reflection', source_node_uuid: 'a', target_node_uuid: 'a' },
  ]) })
  await settle()
  await chooseType(h, 'Person'); await h.input('ali'); await h.click(rows(h)[0])
  const details = h.find('.detail-panel').textContent
  await h.click(h.find('.search-mode-nodes'))
  assert.equal(choice(h), 'Person', 'clicking the active tab is still a no-op')
  assert.equal(h.find('.node-search-input').props.value, 'ali')
  assert.equal(h.find('.detail-panel').textContent, details)
  await h.click(h.find('.search-mode-relationships'))
  assert.equal(select(h), null)
  assert.equal(h.find('.node-search-input').props.value, '')
  assert.equal(rows(h).length, 0)
  assert.equal(h.find('.detail-panel').textContent, details)
  await h.input('Reflection')
  assert.equal(rows(h).length, 1)
  await h.click(h.find('.search-mode-nodes'))
  assert.equal(choice(h), 'All types')
  assert.equal(h.find('.node-search-input').props.value, '')
  assert.equal(rows(h).length, 0)
})

test('graph identity changes reset type even while Nodes is already active and removal resets it too', async t => {
  const h = mountGraphPanel(t, { messages: english })
  for (const id of ['different', '', '   ', null, undefined]) {
    await h.load(graph([node('Alice', 'a')], 'types-A'))
    await chooseType(h, 'Person')
    await h.input('ali')
    const data = graph([node('Alice', 'a')])
    data.graph_id = id
    await h.load(data)
    assert.equal(choice(h), 'All types')
    assert.equal(h.find('.node-search-input').props.value, '')
    assert.equal(rows(h).length, 0)
  }
  await chooseType(h, 'Person')
  await h.load(null)
  assert.equal(select(h), null)
  await h.load(graph([node('Alice', 'a')]))
  assert.equal(choice(h), 'All types')
})

test('resize preserves type while pending and retired source or mode callbacks cannot select old records', async t => {
  const h = mountGraphPanel(t, { messages: english, deferGraphRedraw: true,
    initialGraph: graph([node('Alice', 'a')]) })
  await settle(); redraw(h); await settle()
  await chooseType(h, 'Person')
  const captured = rows(h)[0].props.onClick
  h.resize()
  captured({ stopPropagation() {} })
  assert.equal(h.find('.detail-panel'), null, 'activation waits for the current drawing')
  assert.equal(choice(h), 'Person')
  redraw(h); await settle()
  await h.click(rows(h)[0])
  assert.ok(h.find('.detail-panel'))
  await h.load(graph([node('Updated', 'a')]))
  captured({ stopPropagation() {} }); await settle()
  assert.equal(h.find('.detail-panel'), null)
  redraw(h); await settle()
  const current = rows(h)[0].props.onClick
  await h.click(h.find('.search-mode-relationships'))
  await h.click(h.find('.search-mode-nodes'))
  current({ stopPropagation() {} }); await settle()
  assert.equal(h.find('.detail-panel'), null)
  h.close()
  current({ stopPropagation() {} })
})

test('mounted instances keep independent type choices and a new instance starts with All types', async t => {
  const first = mountGraphPanel(t, { messages: english, initialGraph: graph([node('Alice', 'a')]) })
  const second = mountGraphPanel(t, { messages: english, initialGraph: graph([node('Alice', 'a')]) })
  await settle()
  await chooseType(first, 'Person')
  assert.equal(choice(second), 'All types')
  assert.equal(rows(second).length, 0)
  first.close()
  const replacement = mountGraphPanel(t, { messages: english, initialGraph: graph([node('Alice', 'a')]) })
  await settle()
  assert.equal(choice(replacement), 'All types')
})

test('type filtering leaves the held graph and complete exported graph values unchanged', async t => {
  const source = graph([node('Alice', 'a'), node('Harbor', 'b', ['Place'])])
  const metadata = { projectId: 'project-A', graphId: 'types-A', downloadedAt: '2026-10-14T00:00:00.000Z' }
  const before = createLoadedGraphFile(source, metadata), original = JSON.stringify(source)
  const h = mountGraphPanel(t, { initialGraph: source })
  await settle()
  await chooseType(h, 'Person'); await h.click(rows(h)[0]); await chooseType(h, 'Place')
  assert.equal(JSON.stringify(source), original)
  assert.equal(createLoadedGraphFile(source, metadata), before)
  assert.equal(JSON.parse(before).graph.nodes.length, 2)
})
