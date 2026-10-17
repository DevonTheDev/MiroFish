import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

const messages = locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
const english = messages('en'), copy = english.graph.nodeRelationships
const node = (uuid, name = uuid) => ({ uuid, name, labels: ['Entity', 'Person'] })
const edge = (fact, extra = {}) => ({ uuid: 'duplicate', name: 'KNOWS', fact_type: 'recorded', fact,
  source_node_uuid: 'a', target_node_uuid: 'b', ...extra })
const graph = (edges = [], nodes = [node('a', 'Alice'), node('b', 'Bob')]) => ({ graph_id: 'graph-A', nodes, edges })
const many = count => Array.from({ length: count }, (_, index) => edge(`Fact ${index + 1}`, { uuid: index % 2 ? undefined : 'duplicate' }))
const rows = h => h.host.querySelectorAll('.node-relationship-row')
const paths = h => h.find('.links')?.querySelectorAll('path') || []
const circles = h => h.find('.nodes')?.querySelectorAll('circle') || []
const fact = h => h.find('.fact-text')?.textContent
const range = h => h.find('.node-relationships-range')?.textContent
const next = h => h.find('.node-relationships-next')
const previous = h => h.find('.node-relationships-previous')
const back = h => h.find('.node-relationships-back')
const saved = button => button.props.onClick
const invoke = callback => callback({ stopPropagation() {} })
const expectedRange = (start, end, total) => copy.range.replace('{start}', start).replace('{end}', end).replace('{total}', total)
const flush = async h => { for (const callback of h.takeRedraws()) callback(); await settle() }
const snapshot = h => ({ detail: h.find('.detail-content')?.textContent, range: range(h),
  circles: circles(h).map(c => [c.props.stroke, c.props['stroke-width']]),
  paths: paths(h).map(p => [p.props.stroke, p.props['stroke-width']]),
  transform: h.find('.graph-svg')?.__zoom, focus: h.observations.focus.length })
const mount = (t, data, options = {}) => mountGraphPanel(t, { messages: english, initialGraph: data, controlledTicks: true, ...options })

for (const count of [0, 1, 20, 21, 40, 45]) {
  test(`node relationship pages and exact return for ${count} source occurrences`, async t => {
    const h = mount(t, graph(many(count))); await settle(); await h.select('a')
    const source = JSON.stringify(h.props.graphData), originalPaths = paths(h), zoom = h.find('.graph-svg').__zoom
    const pages = Math.max(1, Math.ceil(count / 20))
    for (let page = 1; page <= pages; page++) {
      const offset = (page - 1) * 20
      assert.equal(range(h), expectedRange(count ? offset + 1 : 0, Math.min(offset + 20, count), count))
      assert.equal(rows(h).length, Math.min(20, count - offset))
      assert.equal(previous(h).props.disabled, page === 1); assert.equal(next(h).props.disabled, page === pages)
      assert.deepEqual(rows(h).map(r => Number(r.props['data-source-index'])), Array.from({ length: rows(h).length }, (_, i) => offset + i))
      if (rows(h).length) {
        const index = rows(h).length - 1
        await h.click(rows(h)[index]); assert.equal(fact(h), `Fact ${offset + index + 1}`)
        assert.equal(h.observations.focus.at(-1).target, back(h))
        assert.equal(h.observations.focus.at(-1).options.preventScroll, true)
        await h.click(back(h)); assert.equal(range(h), expectedRange(offset + 1, Math.min(offset + 20, count), count))
        assert.equal(h.observations.focus.at(-1).target, rows(h)[index])
      } else assert.equal(h.find('.node-relationships-empty').textContent, copy.empty)
      await h.click(next(h))
    }
    assert.equal(JSON.stringify(h.props.graphData), source)
    assert.deepEqual(paths(h), originalPaths); assert.equal(h.find('.graph-svg').__zoom, zoom)
    assert.deepEqual(h.emitted, [])
  })
}

test('interleaved incoming/outgoing/self and omitted endpoints open exact source facts', async t => {
  const shared = edge('Repeated exact fact')
  const data = graph([edge('Incoming', { source_node_uuid: 'b', target_node_uuid: 'a' }),
    edge('Self first', { target_node_uuid: 'a' }), edge('Missing endpoint', { target_node_uuid: 'gone' }),
    shared, shared, edge('Self second', { target_node_uuid: 'a' }), edge('Same name is unrelated', { source_node_uuid: 'c' })],
    [node('a', 'Alice'), node('b', 'Bob'), node('c', 'Alice')])
  const h = mount(t, data); await settle(); await h.select('a')
  assert.equal(rows(h).length, 6)
  assert.equal(h.find('.node-relationships-counts').textContent, '6 total · Outgoing 3 · Incoming 1 · Self 2')
  for (let i = 0; i < 6; i++) {
    await h.click(rows(h)[i]); assert.equal(fact(h), data.edges[i].fact)
    assert.ok(h.find('.node-relationship-context').textContent.includes(`Relationship source position ${i + 1}`))
    assert.equal(h.find('.self-loop-list'), null)
    if ([1, 5].includes(i)) assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchIndividualSelfRelation)
    if (i === 2) {
      assert.equal(h.find('.relationship-search-notice').textContent, english.graph.searchRelationshipDetailsOnly)
      assert.equal(h.find('.graph-fit-relationship').props.disabled, true)
    }
    await h.click(back(h))
  }
})

test('duplicate node occurrences retain their own details and show persistent ID-level ambiguity', async t => {
  const h = mount(t, graph([edge('Fact', { source_node_name: 'Producer A', target_node_name: 'Producer B' })],
    [node('a', 'First A'), node('a', 'Second A'), node('b', 'First B'), node('b', 'Second B')]))
  await settle()
  for (const index of [0, 1]) {
    await h.click(circles(h)[index])
    assert.ok(h.find('.detail-content').textContent.includes(index ? 'Second A' : 'First A'))
    assert.equal(h.find('.node-relationships-warning').textContent, copy.duplicate.replace('{count}', 2))
    assert.equal(rows(h)[0].querySelector('.node-relationship-endpoints').textContent, 'Producer A → Producer B')
    await h.click(rows(h)[0]); assert.ok(h.find('.node-relationship-context').textContent.includes(`Node source position ${index + 1}`))
    assert.equal(h.find('.node-relationships-warning').textContent, copy.duplicate.replace('{count}', 2))
    await h.click(back(h)); assert.equal(circles(h)[index].props.stroke, '#E91E63')
  }
})

for (const locale of ['en', 'zh']) {
  test(`${locale} copy and bounded literal rows preserve complete fact and literal endpoint IDs in detail`, async t => {
    const full = 'x'.repeat(159) + '😀' + '<img src=x> complete fact'
    const id = 'z'.repeat(97), h = mount(t, graph([edge(full, { name: '<b>' + 'n'.repeat(81), fact_type: 't'.repeat(81), uuid: id, target_node_uuid: id })],
      [node('a', 'a'.repeat(79) + '😀'), node(id, 'b'.repeat(81))]), { messages: messages(locale) })
    await settle(); await h.select('a')
    assert.equal(h.find('.node-relationships-title').textContent, messages(locale).graph.nodeRelationships.title)
    const row = rows(h)[0]
    assert.equal(row.querySelector('.node-relationship-fact').textContent, 'x'.repeat(159) + '…')
    assert.equal(row.querySelector('.node-relationship-label').textContent.length, 81)
    assert.equal(row.querySelector('.node-relationship-type').textContent.length, 81)
    assert.equal(row.querySelector('.node-relationship-uuid').textContent.length, 97)
    assert.equal(row.querySelector('b'), null); assert.equal(row.querySelector('img'), null)
    assert.ok(row.querySelectorAll('*').every(n => n.props.title == null && n.props['aria-label'] == null && n.props.innerHTML == null))
    await h.click(row); assert.equal(fact(h), full)
    assert.ok(h.host.querySelectorAll('.node-relationship-literal-id').some(n => n.textContent === id))
  })
}

test('global query/type/mode/page edits preserve anchor; search node selection starts a fresh session', async t => {
  const h = mount(t, graph(many(45))); await settle(); await h.input('Alice'); await h.click(h.find('.node-search-result'))
  await h.click(next(h)); const page = range(h)
  await h.click(rows(h)[0]); const opened = fact(h)
  await h.click(h.find('.search-mode-relationships')); await h.input('Fact'); await h.click(h.find('.node-search-next'))
  h.find('.relationship-search-type-select').dispatchEvent({ type: 'change', target: { value: 'relationship-type-0' } }); await settle()
  assert.equal(fact(h), opened); assert.ok(back(h)); await h.click(back(h)); assert.equal(range(h), page)
  assert.equal(h.find('.search-mode-relationships').props['aria-pressed'], true)
  assert.equal(h.find('.node-search-input').props.value, 'Fact')
  await h.click(h.find('.search-mode-nodes')); await h.input('Alice'); await h.click(h.find('.node-search-result'))
  assert.equal(range(h), expectedRange(1, 20, 45))
})

for (const selector of ['path', 'text', 'rect']) {
  test(`standalone ${selector} pointer relationship ends anchored return`, async t => {
    const h = mount(t, graph([edge('Fact')])); await settle(); await h.select('a'); await h.click(rows(h)[0])
    const oldBack = saved(back(h)); await h.click(h.find('.links').querySelector(selector))
    assert.equal(back(h), null); const current = snapshot(h); invoke(oldBack); await settle(); assert.deepEqual(snapshot(h), current)
  })
}

test('global relationship result ends anchored return', async t => {
  const h = mount(t, graph([edge('Fact')])); await settle(); await h.select('a'); await h.click(rows(h)[0])
  const oldBack = saved(back(h)); await h.click(h.find('.search-mode-relationships')); await h.input('Fact')
  await h.click(h.find('.relationship-search-result')); assert.equal(back(h), null)
  const current = snapshot(h); invoke(oldBack); await settle(); assert.deepEqual(snapshot(h), current)
})

test('retained page/row/Back actions cannot cross page visits, edge details, or node selections', async t => {
  const h = mount(t, graph(many(45))); await settle(); await h.select('a')
  const first = [saved(rows(h)[0]), saved(previous(h)), saved(next(h))]
  invoke(first[2]); invoke(first[2]); await settle(); assert.equal(range(h), expectedRange(21, 40, 45))
  const second = [saved(rows(h)[0]), saved(previous(h)), saved(next(h))]
  await h.click(previous(h)); const current = snapshot(h)
  for (const callback of first.concat(second)) invoke(callback)
  await settle(); assert.deepEqual(snapshot(h), current)
  await h.click(rows(h)[0]); const oldBack = saved(back(h)); await h.click(back(h)); await h.click(rows(h)[1])
  const newer = snapshot(h); invoke(oldBack); await settle(); assert.deepEqual(snapshot(h), newer)
  await h.select('a'); const fresh = snapshot(h)
  for (const callback of first.concat(second, oldBack)) invoke(callback)
  await settle(); assert.deepEqual(snapshot(h), fresh)
  await h.select('b'); const another = snapshot(h)
  for (const callback of first.concat(second, oldBack)) invoke(callback)
  await settle(); assert.deepEqual(snapshot(h), another)
})

for (const dismissal of ['close', 'background', 'null', 'unmount']) {
  test(`${dismissal} retires every new callback and queued focus`, async t => {
    const h = mount(t, graph(many(21)), { deferGraphRedraw: true }); await flush(h); await h.select('a')
    const callbacks = [saved(rows(h)[0]), saved(previous(h)), saved(next(h))]
    await h.click(rows(h)[0]); callbacks.push(saved(back(h)))
    const pending = h.takeRedraws()
    if (dismissal === 'close') await h.click(h.find('.detail-close'))
    if (dismissal === 'background') await h.click(h.find('.graph-svg'))
    if (dismissal === 'null') await h.load(null)
    if (dismissal === 'unmount') h.close()
    const current = snapshot(h)
    for (const callback of callbacks) invoke(callback)
    for (const callback of pending) callback()
    await settle(); assert.deepEqual(snapshot(h), current)
  })
}

test('explicit Refresh retires synchronously before loading; failed reads never revive old actions', async t => {
  const h = mount(t, graph(many(21))); await settle(); await h.select('a')
  const row = saved(rows(h)[0]), nextPage = saved(next(h))
  const refresh = h.host.querySelectorAll('button').find(b => b.props.title === english.graph.refreshGraph)
  invoke(saved(refresh)); invoke(row); invoke(nextPage); await settle()
  assert.equal(rows(h).length, 0); assert.equal(range(h), undefined); assert.equal(h.find('.node-relationships-state').textContent, copy.changed)
  assert.deepEqual(h.emitted, ['refresh'])
  h.props.loading = true; await settle(); await h.select('a'); assert.equal(rows(h).length, 0)
  h.props.loading = false; await settle(); invoke(row); assert.equal(rows(h).length, 0)
  await h.select('a'); assert.equal(rows(h).length, 20)
  await h.click(rows(h)[0]); const oldBack = saved(back(h)); h.props.loading = true; await settle()
  invoke(oldBack); await settle(); assert.equal(h.find('.detail-panel'), null)
  h.props.loading = false; await settle(); invoke(oldBack); assert.equal(h.find('.detail-panel'), null)
})

for (const mutation of ['same-ID replacement', 'node ID', 'edge endpoint', 'fact', 'reorder', 'removal', 'graph ID']) {
  test(`${mutation} synchronously retires list callbacks and preserves inert pointer-node details`, async t => {
    const h = mount(t, graph(many(21)), { deferGraphRedraw: true }); await flush(h); await h.select('a')
    const callbacks = [saved(rows(h)[0]), saved(previous(h)), saved(next(h))]
    if (mutation === 'same-ID replacement') h.props.graphData = graph(many(21))
    if (mutation === 'node ID') h.props.graphData.nodes[0].uuid = 'changed'
    if (mutation === 'edge endpoint') h.props.graphData.edges[0].target_node_uuid = 'changed'
    if (mutation === 'fact') h.props.graphData.edges[0].fact = 'changed'
    if (mutation === 'reorder') h.props.graphData.edges.reverse()
    if (mutation === 'removal') h.props.graphData.edges.pop()
    if (mutation === 'graph ID') h.props.graphData.graph_id = 'new-graph'
    if (mutation === 'same-ID replacement') await settle() // Parent-to-child prop delivery precedes its synchronous watcher.
    for (const callback of callbacks) invoke(callback)
    await settle()
    assert.equal(rows(h).length, 0); assert.equal(range(h), undefined)
    assert.ok(h.find('.detail-panel')); assert.equal(h.find('.node-relationships-state').textContent, copy.changed)
    await flush(h); const current = snapshot(h)
    for (const callback of callbacks) invoke(callback)
    await settle(); assert.deepEqual(snapshot(h), current)
  })
}

test('search node and anchored edge details close on deep data edits; pointer origin survives Back', async t => {
  const h = mount(t, graph([edge('Fact')])); await settle(); await h.input('Alice'); await h.click(h.find('.node-search-result'))
  h.props.graphData.edges[0].fact = 'new'; await settle(); assert.equal(h.find('.detail-panel'), null)
  await h.select('a'); await h.click(rows(h)[0]); const oldBack = saved(back(h))
  h.props.graphData.edges[0].fact = 'newer'; invoke(oldBack); await settle(); assert.equal(h.find('.detail-panel'), null)
  await h.select('a'); await h.click(rows(h)[0]); await h.click(back(h))
  h.props.graphData.edges[0].fact = 'last'; await settle(); assert.ok(h.find('.detail-panel'))
  assert.equal(h.find('.node-relationships-state').textContent, copy.changed)
})

for (const mode of ['list', 'detail', 'details-only']) {
  test(`resize preserves ${mode} anchor/page while retiring old render and focus owners`, async t => {
    const records = many(45)
    if (mode === 'details-only') records[20].target_node_uuid = 'gone'
    const h = mount(t, graph(records), { deferGraphRedraw: true }); await flush(h); await h.select('a'); await h.click(next(h))
    const old = [saved(rows(h)[0]), saved(previous(h)), saved(next(h))]
    if (mode !== 'list') { await h.click(rows(h)[0]); old.push(saved(back(h))) }
    const deferredFocus = h.takeRedraws(), focusCount = h.observations.focus.length
    h.resize(); const first = h.takeRedraws(); h.resize(); const second = h.takeRedraws()
    await settle(); assert.equal((mode === 'list' ? rows(h)[0] : back(h)).props.disabled, true)
    for (const callback of old.concat(deferredFocus, first)) invoke(callback)
    await settle(); assert.equal(h.observations.focus.length, focusCount)
    assert.equal((mode === 'list' ? rows(h)[0] : back(h)).props.disabled, true)
    for (const callback of second) callback(); await settle()
    assert.equal((mode === 'list' ? rows(h)[0] : back(h)).props.disabled, false)
    const current = snapshot(h); for (const callback of old) invoke(callback); await settle(); assert.deepEqual(snapshot(h), current)
    if (mode !== 'list') await h.click(back(h))
    assert.equal(range(h), expectedRange(21, 40, 45)); assert.equal(circles(h)[0].props.stroke, mode === 'list' ? '#fff' : '#E91E63')
    await flush(h)
    if (mode !== 'list') assert.equal(h.observations.focus.at(-1).target, rows(h)[0])
  })
}

test('independent panels and missing return focus targets use only their own detail scroller', async t => {
  const a = mount(t, graph([edge('A')]), { deferGraphRedraw: true }), b = mount(t, graph([edge('B')]))
  await flush(a); await settle(); await a.select('a'); await b.select('a')
  const bState = snapshot(b)
  await a.click(rows(a)[0]); await flush(a); await a.click(back(a)); await settle()
  const pending = a.takeRedraws(), row = rows(a)[0]; row.parentNode.removeChild(row)
  for (const callback of pending) callback()
  assert.equal(a.observations.focus.at(-1).target, a.find('.node-relationships-title'))
  assert.deepEqual(snapshot(b), bState)
})
