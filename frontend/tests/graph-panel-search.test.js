import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

const node = (name, uuid, extra = {}) => ({ name, uuid, labels: ['Entity', 'Person'], attributes: {}, ...extra })
const graph = (nodes = [], graph_id = 'graph-A', edges = []) => ({ graph_id, nodes, edges, node_count: nodes.length, edge_count: edges.length })
const results = h => h.host.querySelectorAll('.node-search-result')
const names = h => results(h).map(button => button.querySelector('.node-search-name').textContent)
const circles = h => h.find('.nodes')?.querySelectorAll('circle') ?? []
const detail = h => h.find('.detail-content')?.textContent
const callback = button => button.props.onClick
const invoke = fn => fn({ stopPropagation() {} })
const messagesFor = locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
const english = messagesFor('en')
const previous = h => h.find('.node-search-previous')
const next = h => h.find('.node-search-next')
const range = h => h.find('.node-search-range')?.textContent
const rangeText = (messages, start, end, total) => messages.graph.searchRange
  .replace('{start}', String(start)).replace('{end}', String(end)).replace('{total}', String(total))
const matchingNodes = count => Array.from({ length: count }, (_, i) => node(`Match ${i + 1}`, String(i), { attributes: { position: i + 1 } }))
const styles = h => ({
  nodes: circles(h).map(n => [n.props.stroke, n.props['stroke-width']]),
  edges: h.find('.links')?.querySelectorAll('path').map(n => [n.props.stroke, n.props['stroke-width']]) ?? [],
})

test('node search offers a labelled bounded input and result buttons', async t => {
  const h = mountGraphPanel(t, { initialGraph: graph([node('Alice Example', 'alice')]) })
  await settle()
  const input = h.find('.node-search-input')
  assert.ok(input, 'GraphPanel must expose node-name search')
  assert.equal(circles(h).length, 1, 'the initial graph renders without a prop replacement')
  assert.equal(input.type, 'input')
  assert.equal(input.props.type, 'search')
  assert.equal(String(input.props.maxlength), '200')
  assert.equal(input.parentNode.type, 'label')
  assert.ok(input.parentNode.textContent.includes('graph.searchNodes'))
  await h.input('Alice')
  assert.equal(results(h).length, 1)
  assert.equal(results(h)[0].type, 'button')
  assert.equal(results(h)[0].props.type, 'button')
  assert.equal(results(h)[0].props.disabled, false)
  await h.click(results(h)[0])
  assert.ok(detail(h).includes('Alice Example'))
  assert.equal(circles(h)[0].__data__.id, 'alice')
  assert.equal(circles(h)[0].props.stroke, '#E91E63')
})

test('search uses literal case-insensitive full names and trims only query edges', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([
    node('Long prefix ALPHA.[x]*+ ending', 'a'), node('alphaZZx', 'b'),
    node('Alpha  Beta', 'c'), node('Alpha Beta', 'd'), node('Other', 'e', { summary: 'alpha.[x]*+' }),
  ]))
  await h.input('  aLpHa.[X]*+  ')
  assert.deepEqual(names(h), ['Long prefix ALPHA.[x]*+ ending'])
  await h.input('Alpha  Beta')
  assert.deepEqual(names(h), ['Alpha  Beta'])
  await h.input('ending')
  assert.deepEqual(names(h), ['Long prefix ALPHA.[x]*+ ending'])
})

test('blank query, empty graph and no matches have distinct states', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([node('Alice', 'a')]))
  assert.equal(h.find('.node-search-status').textContent, 'graph.searchPrompt')
  await h.input('   ')
  assert.equal(h.find('.node-search-status').textContent, 'graph.searchPrompt')
  assert.equal(results(h).length, 0)
  await h.input('missing')
  assert.equal(h.find('.node-search-status').textContent, 'graph.searchNoMatches')
  await h.load(graph([]))
  assert.equal(h.find('.node-search-status').textContent, 'graph.searchEmptyGraph')
  assert.equal(results(h).length, 0)
  await h.load(null)
  assert.equal(h.find('.node-search'), null)
})

// Fixed boundary cases exercise exact totals, all pages, and disabled-handler
// guards. Source gaps ensure match positions cannot stand in for raw positions.
for (const count of [0, 1, 20, 21, 40, 45]) {
  test(`search pages all ${count} matches in source order with exact ranges`, async t => {
    const records = matchingNodes(count)
    const rawRecords = records.flatMap((record, index) => [node(`Other ${index}`, `other-${index}`), record])
    const h = mountGraphPanel(t, { messages: english })
    await h.load(graph(rawRecords))
    await h.input('match')
    const originalCircles = circles(h)
    const assertPage = page => {
      const offset = (page - 1) * 20
      assert.deepEqual(names(h), records.slice(offset, offset + 20).map(record => record.name))
      assert.ok(results(h).length <= 20)
      assert.equal(range(h), rangeText(english, count ? offset + 1 : 0, Math.min(offset + 20, count), count))
      assert.equal(previous(h).props.disabled, page === 1)
      assert.equal(next(h).props.disabled, page === Math.max(1, Math.ceil(count / 20)))
      for (const [index, button] of results(h).entries()) {
        assert.equal(button.querySelector('.node-search-position').textContent,
          english.graph.searchPosition.replace('{position}', String((offset + index) * 2 + 2)))
      }
      assert.deepEqual(circles(h), originalCircles, 'pagination does not replace D3 circles')
      assert.deepEqual(h.emitted, [], 'pagination emits no refresh or maximize events')
    }
    for (const button of [previous(h), next(h)]) {
      assert.equal(button.type, 'button')
      assert.equal(button.props.type, 'button')
    }
    assert.equal(h.find('.node-search-range').props.role, 'status')
    assert.equal(h.find('.node-search-range').props['aria-live'], 'polite')
    assertPage(1)
    // The synthetic host does not suppress native disabled clicks. Invoke the
    // handlers directly to independently verify their lower and upper bounds.
    invoke(callback(previous(h))); invoke(callback(previous(h))); await settle()
    assertPage(1)
    const pageCount = Math.max(1, Math.ceil(count / 20))
    for (let page = 2; page <= pageCount; page++) {
      await h.click(next(h)); assertPage(page)
    }
    invoke(callback(next(h))); invoke(callback(next(h))); await settle()
    assertPage(pageCount)
    for (let page = pageCount - 1; page >= 1; page--) {
      await h.click(previous(h)); assertPage(page)
    }
  })
}

test('input is capped at two hundred UTF-16 units even for programmatic events', async t => {
  const h = mountGraphPanel(t)
  const bounded = '😀'.repeat(100)
  await h.load(graph([node(bounded, 'a')]))
  await h.input(bounded + 'ignored')
  assert.equal(h.find('.node-search-input').props.value, bounded)
  assert.equal(h.find('.node-search-input').props.value.length, 200)
  assert.deepEqual(names(h), [bounded])
})

test('duplicate names, duplicate UUIDs and missing UUIDs retain separate source records', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([
    node('Same name', 'duplicate', { attributes: { position: 1 } }),
    node('Same name', 'duplicate', { labels: ['Entity', 'Place'], attributes: { position: 2 } }),
    node('Same name', undefined, { attributes: { position: 3 } }),
    node('Same name', undefined, { attributes: { position: 4 } }),
    node('', 'empty'), node(null, 'null'), node(123, 'number'), { uuid: 'missing', labels: [] },
  ]))
  await h.input('same')
  assert.equal(results(h).length, 4)
  for (let index = 0; index < 4; index++) {
    const button = results(h)[index]
    assert.equal(button.querySelector('.node-search-position').textContent, `graph.searchPosition`)
    assert.equal(button.querySelector('.node-search-type').textContent, index === 1 ? 'Place' : 'Person')
    assert.equal(button.querySelector('.node-search-uuid')?.textContent, index < 2 ? 'duplicate' : undefined)
    await h.click(button)
    assert.deepEqual(h.properties(), { position: String(index + 1) })
    assert.deepEqual(circles(h).map(c => c.props.stroke), circles(h).map((_c, i) => i === index ? '#E91E63' : '#fff'))
  }
  await h.input('Unnamed')
  assert.equal(results(h).length, 0, 'rendered fallback names are not indexed')
})

test('duplicate and missing UUIDs on later pages select the exact raw source record', async t => {
  const records = matchingNodes(45).map((record, index) => ({ ...record, name: 'Same name',
    uuid: [0, 20, 40].includes(index) ? 'duplicate' : [19, 39, 44].includes(index) ? undefined : record.uuid }))
  const h = mountGraphPanel(t, { messages: english })
  await h.load(graph(records))
  await h.input('same')
  for (const sourceIndex of [0, 19, 20, 39, 40, 44]) {
    const targetPage = Math.floor(sourceIndex / 20) + 1
    if (targetPage > 1 && sourceIndex % 20 === 0) await h.click(next(h))
    const button = results(h)[sourceIndex % 20]
    assert.equal(button.querySelector('.node-search-position').textContent,
      english.graph.searchPosition.replace('{position}', String(sourceIndex + 1)))
    await h.click(button)
    assert.deepEqual(h.properties(), { position: String(sourceIndex + 1) })
    assert.equal(circles(h)[sourceIndex].__data__.rawData, h.props.graphData.nodes[sourceIndex])
    assert.deepEqual(circles(h).map(circle => circle.props.stroke),
      records.map((_record, index) => index === sourceIndex ? '#E91E63' : '#fff'))
  }
})

test('query edits and clearing reset pagination without changing selected details or circles', async t => {
  const h = mountGraphPanel(t, { messages: english })
  await h.load(graph(matchingNodes(45)))
  await h.input('match')
  await h.click(next(h)); await h.click(next(h))
  await h.click(results(h)[0])
  const selectedDetails = detail(h), selectedStyles = styles(h), originalCircles = circles(h)
  for (const query of ['MATCH', '  MATCH  ', '']) {
    await h.input(query)
    assert.equal(detail(h), selectedDetails)
    assert.deepEqual(styles(h), selectedStyles)
    assert.deepEqual(circles(h), originalCircles)
    if (query) {
      assert.equal(range(h), rangeText(english, 1, 20, 45))
      await h.click(next(h))
    } else {
      assert.equal(results(h).length, 0)
      assert.equal(h.find('.node-search-pagination'), null)
    }
  }
  await h.input('match')
  assert.equal(range(h), rangeText(english, 1, 20, 45))
  assert.deepEqual(h.emitted, [])
})

test('same-graph refresh keeps valid pages and durably clamps after shrink before later growth', async t => {
  const h = mountGraphPanel(t, { messages: english })
  await h.load(graph(matchingNodes(45)))
  await h.input('match')
  await h.click(next(h))
  await h.load(graph(matchingNodes(43)))
  assert.equal(range(h), rangeText(english, 21, 40, 43))
  await h.click(next(h))
  const oldClick = callback(results(h)[0]), oldCircle = circles(h)[40]
  await h.click(results(h)[0])
  const refreshed = matchingNodes(25).map(record => ({ ...record, attributes: { ...record.attributes, version: 'new' } }))
  await h.load(graph(refreshed))
  assert.equal(h.find('.node-search-input').props.value, 'match')
  assert.equal(range(h), rangeText(english, 21, 25, 25))
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(circles(h).includes(oldCircle), false, 'old D3 circle was replaced')
  invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null, 'old page callbacks cannot select replacement records')
  await h.click(results(h)[0])
  assert.deepEqual(h.properties(), { position: '21', version: 'new' })
  await h.load(graph(matchingNodes(45)))
  assert.equal(range(h), rangeText(english, 21, 40, 45), 'growth cannot revive page three')
  invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  await h.load(graph([]))
  assert.equal(range(h), rangeText(english, 0, 0, 0))
  await h.load(graph(matchingNodes(45)))
  assert.equal(range(h), rangeText(english, 1, 20, 45), 'empty refresh durably clamps to page one')
})

test('deep same-graph shrink retires page callbacks synchronously and keeps the clamped page after growth', async t => {
  const h = mountGraphPanel(t, { messages: english })
  await h.load(graph(matchingNodes(45)))
  await h.input('match')
  await h.click(next(h)); await h.click(next(h))
  const oldClick = callback(results(h)[0]), oldCircle = circles(h)[40]
  h.props.graphData.nodes.splice(25)
  invoke(oldClick)
  assert.equal(oldCircle.props.stroke, '#fff', 'stale page activation is rejected before queued redraws')
  await settle()
  assert.equal(range(h), rangeText(english, 21, 25, 25))
  assert.equal(h.find('.detail-panel'), null)
  h.props.graphData.nodes.push(...matchingNodes(45).slice(25))
  await settle()
  assert.equal(range(h), rangeText(english, 21, 40, 45))
  await h.click(results(h)[0])
  assert.deepEqual(h.properties(), { position: '21' })
})

test('paging preserves node details, highlights and expanded self-relation details without D3 redraws', async t => {
  const h = mountGraphPanel(t)
  const records = matchingNodes(45)
  const edges = [
    { uuid: 'link', source_node_uuid: '0', target_node_uuid: '1', name: 'KNOWS' },
    { uuid: 'loop', source_node_uuid: '0', target_node_uuid: '0', name: 'SELF', fact: 'Keep expanded' },
  ]
  await h.load(graph(records, 'graph-A', edges))
  await h.input('match')
  await h.click(results(h)[0])
  const originalCircles = circles(h), nodeDetails = detail(h), nodeStyles = styles(h)
  await h.click(next(h)); await h.click(previous(h))
  assert.equal(detail(h), nodeDetails)
  assert.deepEqual(styles(h), nodeStyles)
  const loopPath = h.find('.links').querySelectorAll('path').find(path => path.__data__.rawData.isSelfLoopGroup)
  await h.click(loopPath)
  await h.click(h.find('.self-loop-item-header'))
  const loopDetails = detail(h), loopStyles = styles(h), loopHeader = h.find('.self-loop-item-header')
  assert.equal(loopHeader.props['aria-expanded'], true)
  await h.click(next(h)); await h.click(next(h)); await h.click(previous(h))
  assert.equal(detail(h), loopDetails)
  assert.equal(h.find('.self-loop-item-header'), loopHeader)
  assert.equal(loopHeader.props['aria-expanded'], true)
  assert.deepEqual(styles(h), loopStyles)
  assert.deepEqual(circles(h), originalCircles)
  assert.deepEqual(h.emitted, [])
})

test('hostile-looking names, types and UUIDs remain full literal text', async t => {
  const h = mountGraphPanel(t)
  const name = '<img src=x onerror=alert(1)> & <script>literal</script>'
  await h.load(graph([node(name, '<svg onload=alert(1)>', { labels: ['Entity', '<b>Person</b>'] })]))
  await h.input('<img')
  assert.deepEqual(names(h), [name])
  const button = results(h)[0]
  assert.equal(button.querySelector('.node-search-type').textContent, '<b>Person</b>')
  assert.equal(button.querySelector('.node-search-uuid').textContent, '<svg onload=alert(1)>')
  assert.equal(button.querySelector('img'), null)
  assert.equal(button.querySelector('script'), null)
  assert.ok(button.querySelectorAll('*').every(n => !Object.hasOwn(n.props, 'innerHTML')))
  await h.click(button)
  assert.ok(detail(h).includes(name))
})

test('search and original circle activation produce the same details and edge highlights', async t => {
  const h = mountGraphPanel(t)
  const edges = [{ uuid: 'ab', source_node_uuid: 'a', target_node_uuid: 'b', name: 'KNOWS', fact: 'Synthetic link' },
    { uuid: 'aa', source_node_uuid: 'a', target_node_uuid: 'a', name: 'SELF', fact: 'Synthetic self loop' }]
  await h.load(graph([node('Alice', 'a', { attributes: { active: false, score: 0 } }), node('Bob', 'b')], 'graph-A', edges))
  await h.select('a')
  const circleDetails = detail(h), circleStyles = styles(h)
  await h.click(h.find('.graph-svg'))
  await h.input('Alice')
  await h.click(results(h)[0])
  assert.equal(detail(h), circleDetails)
  assert.deepEqual(styles(h), circleStyles)
  assert.deepEqual(h.properties(), { active: 'false', score: '0' })
})

test('repeated search activation, detail close and background dismissal remain usable', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([node('Alice', 'a')]))
  await h.input('Alice')
  for (let i = 0; i < 3; i++) await h.click(results(h)[0])
  assert.ok(detail(h).includes('Alice'))
  await h.click(h.find('.detail-close'))
  assert.equal(h.find('.detail-panel'), null)
  await h.click(results(h)[0])
  await h.click(h.find('.graph-svg'))
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(circles(h)[0].props.stroke, '#fff')
  assert.equal(h.find('.node-search-input').props.value, 'Alice')
})

test('deep changes synchronously retire captured result activation and search-opened details', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([node('Alice', 'a', { attributes: { version: 'old' } })]))
  await h.input('Alice')
  const oldClick = callback(results(h)[0]), oldCircle = circles(h)[0]
  assert.equal(oldCircle.props.stroke, '#fff', 'the captured result starts unselected')
  h.props.graphData.nodes[0].attributes.version = 'new'
  invoke(oldClick)
  assert.equal(oldCircle.props.stroke, '#fff', 'stale activation is rejected before any queued watcher or redraw')
  await settle()
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(h.find('.node-search-input').props.value, 'Alice')
  await h.click(results(h)[0])
  assert.deepEqual(h.properties(), { version: 'new' })
  h.props.graphData.nodes[0].attributes.version = 'search detail retired'
  await settle()
  assert.equal(h.find('.detail-panel'), null, 'a further deep change closes search-opened details')
  await h.select('a')
  h.props.graphData.nodes[0].attributes.version = 'ordinary click retained'
  await settle()
  assert.deepEqual(h.properties(), { version: 'ordinary click retained' })
})

test('same-ID replacement rejects old callbacks and selects only the new snapshot', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([node('Alice', 'a', { attributes: { version: 'old' } })]))
  await h.input('Alice')
  const oldClick = callback(results(h)[0])
  await h.click(results(h)[0])
  await h.load(graph([node('Alice', 'a', { attributes: { version: 'new' } })]))
  invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(h.find('.node-search-input').props.value, 'Alice')
  await h.click(results(h)[0])
  assert.deepEqual(h.properties(), { version: 'new' })
})

test('reorder, rename, removal and empty replacement reject captured source positions', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([node('Match A', 'a'), node('Match B', 'b')]))
  await h.input('Match')
  let oldClick = callback(results(h)[0])
  h.props.graphData.nodes.reverse(); invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  assert.deepEqual(names(h), ['Match B', 'Match A'])
  await h.click(results(h)[0]); assert.ok(detail(h).includes('Match B'))
  oldClick = callback(results(h)[0])
  h.props.graphData.nodes[0].name = 'Renamed'; invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  assert.deepEqual(names(h), ['Match A'])
  oldClick = callback(results(h)[0])
  h.props.graphData.nodes.pop(); invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  await h.load(graph([])); invoke(oldClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  assert.equal(circles(h).length, 0)
})

test('only equal concrete graph IDs retain query and page; changed, invalid and cleared identities reset both', async t => {
  const h = mountGraphPanel(t, { messages: english })
  await h.load(graph(matchingNodes(45)))
  await h.input('match')
  await h.click(next(h)); await h.click(next(h))
  await h.load(graph(matchingNodes(45)))
  assert.equal(h.find('.node-search-input').props.value, 'match')
  assert.equal(range(h), rangeText(english, 41, 45, 45))
  for (const id of ['graph-B', undefined, undefined, '', '  ', null, 42]) {
    const data = graph(matchingNodes(45)); data.graph_id = id
    await h.load(data)
    assert.equal(h.find('.node-search-input').props.value, '')
    assert.equal(h.find('.node-search-pagination'), null)
    await h.input('match')
    assert.equal(range(h), rangeText(english, 1, 20, 45))
    await h.click(next(h)); await h.click(next(h))
  }
  await h.load(null)
  assert.equal(h.find('.node-search'), null)
  await h.load(graph(matchingNodes(45)))
  assert.equal(h.find('.node-search-input').props.value, '')
  await h.input('match')
  assert.equal(range(h), rangeText(english, 1, 20, 45))
})

test('older queued redraws cannot revive a retired snapshot after refresh or unmount', async t => {
  const h = mountGraphPanel(t, { deferGraphRedraw: true })
  await h.load(graph([node('Old match', 'a')]))
  const oldRedraws = h.takeRedraws()
  await h.load(graph([node('Current match', 'b')]))
  const currentRedraws = h.takeRedraws()
  for (const redraw of currentRedraws) redraw()
  await settle(); await h.input('match')
  assert.deepEqual(circles(h).map(c => c.__data__.rawData.name), ['Current match'])
  for (const redraw of oldRedraws) redraw()
  await settle()
  assert.deepEqual(circles(h).map(c => c.__data__.rawData.name), ['Current match'])
  const savedClick = callback(results(h)[0])
  h.resize()
  const resizeRedraws = h.takeRedraws()
  invoke(savedClick); await settle()
  assert.equal(h.find('.detail-panel'), null, 'activation is unavailable until current circles are rebuilt')
  h.close()
  for (const redraw of resizeRedraws) redraw()
  invoke(savedClick); await settle()
  assert.equal(h.host.children.length, 0)
})

test('resize preserves later pages and query while deferred redraws keep their separate ownership', async t => {
  const h = mountGraphPanel(t, { messages: english, deferGraphRedraw: true })
  await h.load(graph(matchingNodes(45)))
  for (const redraw of h.takeRedraws()) redraw()
  await settle(); await h.input('match'); await h.click(next(h)); await h.click(next(h))
  const savedClick = callback(results(h)[0]), originalCircles = circles(h)
  assert.equal(h.takeRedraws().length, 0, 'paging alone queues no graph redraw')
  h.resize()
  const olderResizeRedraws = h.takeRedraws()
  await settle()
  assert.equal(range(h), rangeText(english, 41, 45, 45))
  assert.equal(h.find('.node-search-input').props.value, 'match')
  assert.equal(results(h)[0].props.disabled, true)
  invoke(savedClick); await settle()
  assert.equal(h.find('.detail-panel'), null)
  await h.click(previous(h))
  assert.equal(range(h), rangeText(english, 21, 40, 45))
  assert.equal(h.takeRedraws().length, 0, 'paging while resizing queues no additional redraw')
  h.resize()
  const currentResizeRedraws = h.takeRedraws()
  for (const redraw of olderResizeRedraws) redraw()
  await settle()
  assert.deepEqual(circles(h), originalCircles, 'older resize tickets cannot rebuild circles')
  assert.equal(results(h)[0].props.disabled, true)
  for (const redraw of currentResizeRedraws) redraw()
  await settle()
  assert.notEqual(circles(h)[0], originalCircles[0])
  assert.equal(range(h), rangeText(english, 21, 40, 45))
  assert.equal(results(h)[0].props.disabled, false)
  invoke(savedClick); await settle()
  assert.deepEqual(h.properties(), { position: '41' }, 'resize retains the valid graph-revision callback')
  await h.click(results(h)[0])
  assert.deepEqual(h.properties(), { position: '21' })
  assert.deepEqual(h.emitted, [])
})

test('refresh, maximize, edge selection, edge labels and resize remain available', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([node('Alice', 'a'), node('Bob', 'b')], 'graph-A', [
    { uuid: 'ab', source_node_uuid: 'a', target_node_uuid: 'b', name: 'KNOWS', fact: 'Synthetic link' },
  ]))
  await h.input('Alice')
  await h.click(h.host.querySelectorAll('.tool-btn')[0])
  await h.click(h.host.querySelectorAll('.tool-btn')[1])
  assert.deepEqual(h.emitted, ['refresh', 'toggle-maximize'])
  await h.click(h.find('.links').querySelector('path'))
  assert.ok(detail(h).includes('Synthetic link'))
  const checkbox = h.find('.toggle-switch').querySelector('input')
  checkbox.props['onUpdate:modelValue'](false); await settle()
  assert.ok(h.find('.links').querySelectorAll('text').every(n => n.style.display === 'none'))
  h.resize(); await settle()
  assert.equal(h.find('.node-search-input').props.value, 'Alice')
  assert.equal(circles(h).length, 2)
  await h.click(results(h)[0])
  assert.ok(detail(h).includes('Alice'))
  checkbox.props['onUpdate:modelValue'](true); await settle()
  assert.ok(h.find('.links').querySelectorAll('text').every(n => n.style.display === 'block'))
})

test('English and Chinese search controls show localized page ranges and source positions', async t => {
  for (const locale of ['en', 'zh']) {
    const messages = messagesFor(locale)
    for (const key of ['searchNodes', 'searchPlaceholder', 'searchPrompt', 'searchEmptyGraph', 'searchNoMatches', 'searchRange', 'searchPrevious', 'searchNext', 'searchPosition']) {
      assert.equal(typeof messages.graph[key], 'string', `${locale} includes ${key}`)
      assert.ok(messages.graph[key].trim())
    }
    const h = mountGraphPanel(t, { messages })
    await h.load(graph(matchingNodes(21)))
    const input = h.find('.node-search-input')
    assert.ok(input.parentNode.textContent.includes(messages.graph.searchNodes))
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchPrompt)
    await h.input('Match')
    assert.equal(previous(h).textContent, messages.graph.searchPrevious)
    assert.equal(next(h).textContent, messages.graph.searchNext)
    assert.equal(results(h)[0].querySelector('.node-search-position').textContent, messages.graph.searchPosition.replace('{position}', '1'))
    assert.equal(results(h)[19].querySelector('.node-search-position').textContent, messages.graph.searchPosition.replace('{position}', '20'))
    assert.equal(range(h), rangeText(messages, 1, 20, 21))
    await h.click(next(h))
    assert.equal(range(h), rangeText(messages, 21, 21, 21))
    assert.equal(results(h)[0].querySelector('.node-search-position').textContent, messages.graph.searchPosition.replace('{position}', '21'))
    await h.input('missing')
    assert.equal(range(h), rangeText(messages, 0, 0, 0))
    assert.equal(h.find('.node-search-status').textContent, messages.graph.searchNoMatches)
    assert.equal(previous(h).props.disabled, true)
    assert.equal(next(h).props.disabled, true)
  }
})
