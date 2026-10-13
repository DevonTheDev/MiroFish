import assert from 'node:assert/strict'
import test from 'node:test'
import { mountGraphPanel } from './helpers/graph-panel-fixture.js'

const selfLoop = (uuid, extra = {}) => ({
  uuid, source_node_uuid: 'a', target_node_uuid: 'a', fact: 'Synthetic relation fact', ...extra,
})
const graph = edges => ({
  graph_id: 'self-loop-disclosure',
  nodes: [{ uuid: 'a', name: 'Alice', labels: ['Entity', 'Person'], attributes: {} }],
  edges, node_count: 1, edge_count: edges.length,
})
const rows = h => h.host.querySelectorAll('.self-loop-item')
const header = row => row.querySelector('.self-loop-item-header')
const content = row => row.querySelector('.self-loop-item-content')
const expanded = (row, expected) => {
  assert.equal(header(row).props['aria-expanded'], expected)
  assert.equal(String(row.props.class).split(/\s+/).includes('expanded'), expected)
  assert.equal(content(row).style.display === 'none', !expected)
  assert.equal(row.querySelector('.self-loop-toggle').textContent, expected ? '−' : '+')
}
const openRelations = async h => {
  const paths = h.find('.links').querySelectorAll('path')
  assert.equal(paths.length, 1, 'D3 groups the self relations into one rendered edge')
  await h.click(paths[0])
  assert.ok(h.find('.self-loop-list'), 'the real D3 edge click opens the grouped relation details')
}

// The existing host mounts the actual Vue SFC and D3. It exposes rendered
// attributes and v-show, not a browser accessibility tree, native keyboard
// activation, tab order, form defaults or focus-outline pixels.
test('self-relation disclosures render named native buttons with collapsed state and decorative markers', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([
    selfLoop('named', { name: 'KNOWS_SELF' }),
    selfLoop('typed', { fact_type: 'REMEMBERS' }),
    selfLoop('fallback'),
  ]))
  assert.equal(h.find('.detail-panel'), null)
  await openRelations(h)
  assert.equal(rows(h).length, 3)
  for (const [index, name] of ['KNOWS_SELF', 'REMEMBERS', 'RELATED'].entries()) {
    const row = rows(h)[index], button = header(row)
    assert.equal(button.type, 'button')
    assert.equal(button.props.type, 'button', 'disclosure activation cannot submit an enclosing form')
    assert.equal(button.querySelector('.self-loop-index').textContent, `#${index + 1}`)
    assert.equal(button.querySelector('.self-loop-name').textContent, name)
    assert.equal(button.querySelector('.self-loop-toggle').props['aria-hidden'], 'true')
    assert.equal(button.props['aria-label'], undefined, 'visible row index and relation text supply the name')
    expanded(row, false)
    assert.ok(content(row).textContent.includes('Synthetic relation fact'), 'v-show retains the collapsed content')
  }
})

test('UUID and index-fallback disclosure rows toggle independently through repeated activation', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([
    selfLoop('first', { name: 'FIRST' }),
    selfLoop('second', { name: 'SECOND' }),
    selfLoop(undefined, { name: 'FIRST_INDEX_FALLBACK' }),
    selfLoop(undefined, { name: 'SECOND_INDEX_FALLBACK' }),
  ]))
  await openRelations(h)
  const states = [false, false, false, false]
  for (const index of [0, 1, 0, 2, 1, 3, 2, 3, 2, 0, 2, 0]) {
    await h.click(header(rows(h)[index]))
    states[index] = !states[index]
    rows(h).forEach((row, rowIndex) => expanded(row, states[rowIndex]))
    assert.equal(h.find('.self-loop-count').textContent, '4 items')
  }
})

test('explicit detail close resets expansion while graph background dismissal retains it', async t => {
  const h = mountGraphPanel(t)
  await h.load(graph([selfLoop('first', { name: 'FIRST' }), selfLoop(undefined, { name: 'INDEX_FALLBACK' })]))
  await openRelations(h)
  await h.click(header(rows(h)[0]))
  await h.click(header(rows(h)[1]))
  rows(h).forEach(row => expanded(row, true))
  await h.click(h.find('.graph-svg'))
  assert.equal(h.find('.detail-panel'), null)
  await openRelations(h)
  rows(h).forEach(row => expanded(row, true))
  await h.click(h.find('.detail-close'))
  assert.equal(h.find('.detail-panel'), null)
  await openRelations(h)
  rows(h).forEach(row => expanded(row, false))
  await h.click(header(rows(h)[1]))
  expanded(rows(h)[0], false)
  expanded(rows(h)[1], true)
})
