import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountGraphPanel, settle } from './helpers/graph-panel-fixture.js'

// Source-prepared qualification. This synthetic host exercises the real Vue
// component and D3 adapters; it does not establish native browser behavior.
const messages = locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8'))
const english = messages('en'), copy = english.graph.path
const node = (uuid, name = uuid) => ({ uuid, name, labels: ['Entity', 'Person'] })
const edge = (source, target, fact, extra = {}) => ({ uuid: 'duplicate', name: 'LINK', fact_type: 'recorded', fact,
  source_node_uuid: source, target_node_uuid: target, ...extra })
const graph = (edges = [edge('a', 'b', 'First fact'), edge('b', 'c', 'Second fact')],
  nodes = [node('a', 'Alice'), node('b', 'Bridge'), node('c', 'Carol')]) => ({ graph_id: 'graph-path', nodes, edges })
const largeGraph = () => graph(undefined, [node('a', 'Alice'), node('b', 'Bridge'), node('c', 'Carol'),
  ...Array.from({ length: 520 }, (_, index) => node(`unused-${index}`))])
const rows = h => h.host.querySelectorAll('.graph-path-row')
const circles = h => h.find('.nodes')?.querySelectorAll('circle') || []
const paths = h => h.find('.links')?.querySelectorAll('path') || []
const status = h => h.find('.graph-path-state')?.textContent
const back = h => h.find('.graph-path-back')
const fact = h => h.find('.fact-text')?.textContent
const value = (h, side) => h.find(`.graph-path-${side}-value`)?.textContent
const saved = button => { assert.ok(button, 'the control to retain exists'); assert.equal(typeof button.props.onClick, 'function'); return button.props.onClick }
const invoke = callback => callback({ stopPropagation() {} })
const mount = (t, data = graph(), options = {}) => mountGraphPanel(t,
  { messages: english, initialGraph: data, controlledTicks: true, controlledPathJobs: true, ...options })
const flush = async h => { for (const callback of h.takeRedraws()) callback(); await settle() }
const choose = async (h, start = 'a', end = 'c') => {
  await h.select(start); await h.click(h.find('.graph-path-start'))
  await h.select(end); await h.click(h.find('.graph-path-end'))
}
const finish = async h => {
  // The admitted graph and 256-item slices have a finite upper bound. A bad
  // rescheduling loop must fail this fixture rather than hang the test process.
  for (let count = 0; count < 512; count++) if (!await h.runNextPathTask()) return
  assert.fail('path work exceeded the finite fixture task bound')
}
const findPath = async h => { await h.click(h.find('.graph-path-find')); await finish(h) }
const view = h => ({ start: value(h, 'start'), end: value(h, 'end'), state: status(h),
  rows: rows(h).map(row => [Number(row.props['data-source-index']), row.textContent]),
  detail: h.find('.detail-content')?.textContent, back: Boolean(back(h)),
  circles: circles(h).map(circle => [circle.props.stroke, circle.props['stroke-width']]),
  paths: paths(h).map(path => [path.props.stroke, path.props['stroke-width']]),
  focus: h.observations.focus.length })
const searchView = h => ({ query: h.find('.node-search-input')?.props.value,
  nodes: h.find('.search-mode-nodes')?.props['aria-pressed'],
  relationships: h.find('.search-mode-relationships')?.props['aria-pressed'],
  type: h.find('.relationship-search-type-select')?.props.value ?? h.find('.node-search-type-select')?.props.value,
  range: h.find('.node-search-range')?.textContent, scroll: h.find('.node-search')?.scrollTop,
  zoom: h.find('.graph-svg')?.__zoom })

test('directed rows open exact source occurrences and Back focuses the same row without a restored node', async t => {
  const shared = edge('a', 'b', 'Chosen first parallel fact')
  const data = graph([edge('b', 'a', 'Reverse'), shared, shared, edge('b', 'c', 'Chosen second fact'),
    edge('a', 'absent', 'Excluded missing endpoint')], [node('a', 'Same name'), node('b', 'Bridge'), node('c', 'Same name')])
  const h = mount(t, data); await settle(); await choose(h)
  const source = JSON.stringify(h.props.graphData), drawn = paths(h), zoom = h.find('.graph-svg').__zoom
  await h.click(h.find('.graph-path-find'))
  assert.equal(status(h), copy.running); assert.equal(rows(h).length, 0)
  await finish(h)
  assert.equal(status(h), copy.found.replace('{count}', 2))
  assert.deepEqual(rows(h).map(row => Number(row.props['data-source-index'])), [1, 3])
  assert.ok(h.find('.graph-path-excluded').textContent.includes('1'))
  const excluded = h.find('.graph-path-excluded').textContent
  for (const index of [0, 1]) {
    const row = rows(h)[index]
    await h.click(row); assert.equal(fact(h), data.edges[[1, 3][index]].fact)
    assert.equal(h.find('.self-loop-list'), null); assert.ok(back(h))
    await h.click(back(h)); assert.equal(h.find('.detail-panel'), null)
    assert.equal(h.observations.focus.at(-1).target, rows(h)[index])
    assert.equal(h.observations.focus.at(-1).options.preventScroll, true)
    assert.equal(circles(h).some(circle => circle.props.stroke === '#E91E63'), false)
    assert.equal(paths(h).some(path => path.props.stroke === '#E91E63'), false)
  }
  assert.equal(JSON.stringify(h.props.graphData), source)
  assert.deepEqual(paths(h), drawn); assert.equal(h.find('.graph-svg').__zoom, zoom); assert.deepEqual(h.emitted, [])
  await choose(h, 'c', 'a'); await findPath(h)
  assert.equal(status(h), copy.notFound); assert.equal(rows(h).length, 0)
  assert.equal(h.find('.graph-path-excluded').textContent, excluded)
})

test('path search, inspection, Back and Clear preserve current global filters, page and viewport', async t => {
  const noise = Array.from({ length: 45 }, (_, index) => edge('c', 'a', `Noise ${index}`, { fact_type: 'noise' }))
  const h = mount(t, graph([...graph().edges, ...noise])); await settle(); await choose(h)
  await h.click(h.find('.search-mode-relationships')); await h.input('Noise')
  const select = h.find('.relationship-search-type-select')
  const option = select.querySelectorAll('option').find(item => item.textContent === 'noise')
  assert.ok(option)
  select.dispatchEvent({ type: 'change', target: { value: option.props.value } }); await settle()
  await h.click(h.find('.node-search-next')); await h.click(h.find('.graph-zoom-in'))
  h.find('.node-search').scrollTop = 73
  const original = searchView(h)
  assert.ok(original.range.includes('21')); assert.notEqual(original.zoom.k, 1)
  await findPath(h); assert.deepEqual(rows(h).map(row => Number(row.props['data-source-index'])), [0, 1])
  await h.click(rows(h)[1]); assert.deepEqual(searchView(h), original)
  await h.input('Noise 4'); const edited = searchView(h)
  await h.click(back(h)); assert.deepEqual(searchView(h), edited)
  await h.click(h.find('.graph-path-clear')); assert.deepEqual(searchView(h), edited)
})

test('both locales render bounded literal path text while individual details keep the complete fact', async t => {
  for (const locale of ['en', 'zh']) await t.test(locale, async t => {
    const localeMessages = messages(locale), localCopy = localeMessages.graph.path
    const fullFact = 'x'.repeat(159) + '😀<img src=x> complete fact', id = 'z'.repeat(97)
    const fullName = 'a'.repeat(79) + '😀<b>name', label = '<b>' + 'n'.repeat(81), type = 't'.repeat(81)
    const h = mount(t, graph([edge(' a ', id, fullFact, { name: label, fact_type: type, uuid: id })],
      [node(' a ', fullName), node(id, 'Target')]), { messages: localeMessages })
    await settle(); await choose(h, ' a ', id); await findPath(h)
    const panel = h.find('.graph-path'), row = rows(h)[0]
    assert.ok(panel.textContent.includes(localCopy.title)); assert.ok(panel.textContent.includes(localCopy.explanation))
    assert.equal(status(h), localCopy.found.replace('{count}', 1))
    assert.ok(value(h, 'start').includes(' a '), 'literal ID whitespace is preserved')
    assert.ok(value(h, 'start').includes('a'.repeat(79) + '…'))
    assert.ok(value(h, 'end').includes('z'.repeat(96) + '…')); assert.equal(value(h, 'end').includes(id), false)
    assert.equal(row.querySelector('.graph-path-fact').textContent, 'x'.repeat(159) + '…')
    assert.equal(row.textContent.includes(label), false); assert.equal(row.textContent.includes(type), false)
    assert.equal(panel.querySelector('b'), null); assert.equal(panel.querySelector('img'), null)
    assert.equal(panel.textContent.includes('graph.path.'), false)
    assert.ok(panel.querySelectorAll('*').every(item => item.props.innerHTML == null
      && !String(item.props.title ?? '').includes(fullFact) && !String(item.props['aria-label'] ?? '').includes(fullFact)))
    await h.click(row); assert.equal(fact(h), fullFact)
    assert.equal(back(h).textContent, localCopy.back)
  })
})

test('selected occurrence identity distinguishes duplicate, invalid and equal endpoints from literal distinct IDs', async t => {
  const cases = [
    { name: 'duplicate IDs', nodes: [node('a', 'First A'), node('a', 'Second A'), node('b', 'Bob')], start: 1, end: 2, expected: 'ambiguousEndpoint', caption: 'Second A' },
    { name: 'blank ID', nodes: [node('   ', 'Blank ID'), node('b', 'Bob')], start: 0, end: 1, expected: 'invalidEndpoint' },
    { name: 'same endpoint', nodes: [node('a', 'Alice'), node('b', 'Bob')], start: 0, end: 0, expected: 'sameEndpoint' },
    { name: 'whitespace is distinct', nodes: [node('a', 'Same name'), node(' a ', 'Same name')], start: 0, end: 1, expected: 'found', edges: [edge('a', ' a ', 'Literal distinct ID')] },
  ]
  for (const entry of cases) await t.test(entry.name, async t => {
    const h = mount(t, graph(entry.edges ?? [], entry.nodes)); await settle()
    await h.click(circles(h)[entry.start]); await h.click(h.find('.graph-path-start'))
    if (entry.caption) assert.ok(value(h, 'start').includes(entry.caption))
    await h.click(circles(h)[entry.end]); await h.click(h.find('.graph-path-end')); await findPath(h)
    assert.equal(status(h), copy[entry.expected].replace('{count}', 1))
    assert.equal(rows(h).length, entry.expected === 'found' ? 1 : 0)
  })
})

test('endpoint edits retire results and Clear closes only a path-owned detail', async t => {
  const h = mount(t); await settle(); await choose(h); await findPath(h); await h.click(rows(h)[0])
  await h.click(h.find('.graph-path-clear'))
  assert.equal(h.find('.detail-panel'), null); assert.equal(rows(h).length, 0); assert.equal(status(h), copy.chooseEndpoints)
  await choose(h); await findPath(h); await h.select('b')
  const selected = h.find('.detail-content').textContent
  await h.click(h.find('.graph-path-start'))
  assert.equal(rows(h).length, 0); assert.equal(back(h), null); assert.ok(value(h, 'start').includes('Bridge'))
  assert.equal(h.find('.detail-content').textContent, selected)
  await findPath(h); assert.deepEqual(rows(h).map(row => Number(row.props['data-source-index'])), [1])
  await h.select('a'); const unrelated = h.find('.detail-content').textContent
  await h.click(h.find('.graph-path-clear'))
  assert.equal(h.find('.detail-content').textContent, unrelated); assert.equal(rows(h).length, 0)
  await choose(h); await h.click(h.find('.graph-path-find'))
  const pending = h.takePathTasks(); assert.ok(pending.length)
  await h.select('b'); await h.click(h.find('.graph-path-end'))
  const changed = view(h)
  for (const callback of pending) invoke(callback)
  await settle(); assert.deepEqual(view(h), changed); assert.equal(await h.runNextPathTask(), false)
  await findPath(h); assert.deepEqual(rows(h).map(row => Number(row.props['data-source-index'])), [0])
})

test('retained endpoint, Find, Cancel and Clear handlers cannot change a newer selection or job', async t => {
  const h = mount(t, largeGraph()); await settle(); await h.select('a')
  const oldStart = saved(h.find('.graph-path-start')), oldEnd = saved(h.find('.graph-path-end'))
  await h.select('b'); const unchosen = view(h)
  invoke(oldStart); invoke(oldEnd); await settle(); assert.deepEqual(view(h), unchosen)
  await choose(h)
  const firstFind = saved(h.find('.graph-path-find')), firstClear = saved(h.find('.graph-path-clear'))
  invoke(firstFind); await settle()
  const oldCancel = saved(h.find('.graph-path-cancel'))
  await h.click(h.find('.graph-path-cancel')); assert.equal(status(h), copy.cancelled)
  await h.click(h.find('.graph-path-find')); const newer = view(h)
  for (const callback of [oldStart, oldEnd, firstFind, firstClear, oldCancel]) invoke(callback)
  await settle(); assert.deepEqual(view(h), newer)
  const firstSlice = h.takePathTasks(); assert.equal(firstSlice.length, 1)
  invoke(firstSlice[0]); await settle(); assert.equal(status(h), copy.running)
  const successor = h.takePathTasks(); assert.equal(successor.length, 1)
  const yielded = view(h)
  invoke(firstSlice[0]); invoke(firstSlice[0]); await settle()
  assert.deepEqual(view(h), yielded); assert.deepEqual(h.takePathTasks(), [], 'a consumed slice cannot replace its successor')
  invoke(successor[0]); await settle()
  await finish(h); assert.equal(status(h), copy.found.replace('{count}', 2))
  const firstRow = saved(rows(h)[0]); await h.click(rows(h)[0]); const oldBack = saved(back(h))
  await h.click(rows(h)[1]); const newerDetail = view(h)
  invoke(oldBack); await settle(); assert.deepEqual(view(h), newerDetail)
  await h.select('a'); assert.equal(back(h), null); assert.equal(rows(h).length, 2)
  const selected = view(h)
  for (const callback of [oldStart, firstFind, firstClear, oldCancel, firstRow, oldBack]) invoke(callback)
  await settle(); assert.deepEqual(view(h), selected)
  await h.click(rows(h)[0]); const nextBack = saved(back(h))
  await h.click(paths(h)[0]); assert.equal(back(h), null); assert.equal(rows(h).length, 2)
  const pointer = view(h); invoke(nextBack); await settle(); assert.deepEqual(view(h), pointer)
  await h.click(rows(h)[0]); const dismissedBack = saved(back(h))
  await h.click(h.find('.detail-close'))
  assert.equal(h.find('.detail-panel'), null); assert.equal(back(h), null); assert.equal(rows(h).length, 2)
  const dismissed = view(h); invoke(dismissedBack); await settle(); assert.deepEqual(view(h), dismissed)
  const completedRows = rows(h).map(saved)
  h.props.graphData.nodes[1] = { ...h.props.graphData.nodes[1] }
  for (const callback of completedRows) invoke(callback)
  await settle(); assert.equal(rows(h).length, 0); assert.equal(status(h), copy.changed)
})

test('graph and array replacements and in-place edits cancel between slices before stale work can publish', async t => {
  const mutations = [
    ['graph replacement', h => { h.props.graphData = largeGraph() }],
    ['node array replacement', h => { h.props.graphData.nodes = [...h.props.graphData.nodes] }],
    ['edge array replacement', h => { h.props.graphData.edges = [...h.props.graphData.edges] }],
    ['literal node ID edit', h => { h.props.graphData.nodes[0].uuid = 'changed' }],
    ['edge endpoint edit', h => { h.props.graphData.edges[0].target_node_uuid = 'c' }],
    ['same-ID source occurrence replacement', h => { h.props.graphData.edges[0] = { ...h.props.graphData.edges[0] } }],
  ]
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const h = mount(t, largeGraph()); await settle(); await choose(h)
    const oldFind = saved(h.find('.graph-path-find')), oldClear = saved(h.find('.graph-path-clear'))
    await h.click(h.find('.graph-path-find')); assert.equal(await h.runNextPathTask(), true)
    assert.equal(status(h), copy.running, 'preparation yields before this graph is completely indexed')
    const oldCancel = saved(h.find('.graph-path-cancel')), callbacks = h.takePathTasks()
    assert.ok(callbacks.length > 0)
    mutate(h)
    // Deliver replacement root props to the child; nested reactive edits are
    // already synchronously visible to its graph watcher.
    if (name === 'graph replacement') await settle()
    for (const callback of callbacks.concat(oldFind, oldClear, oldCancel)) invoke(callback)
    await settle()
    assert.equal(status(h), copy.changed); assert.equal(rows(h).length, 0); assert.equal(back(h), null)
    assert.equal(value(h, 'start').includes('Alice'), false); assert.equal(value(h, 'end').includes('Carol'), false)
    assert.equal(await h.runNextPathTask(), false, 'retired callbacks cannot schedule more work')
    const retired = view(h)
    for (const callback of callbacks) invoke(callback)
    await settle(); assert.deepEqual(view(h), retired)
  })
})

test('Refresh and loading retire endpoints, results, handlers and jobs; failed refresh cannot revive them', async t => {
  for (const cause of ['refresh', 'loading']) await t.test(cause, async t => {
    const h = mount(t, largeGraph()); await settle(); await choose(h); await findPath(h)
    const oldRow = saved(rows(h)[0]); await h.click(rows(h)[0]); const oldBack = saved(back(h))
    const stale = [oldRow, oldBack]
    if (cause === 'loading') {
      await h.click(h.find('.graph-path-find')); await h.runNextPathTask()
      stale.push(...h.takePathTasks(), saved(h.find('.graph-path-cancel')))
    }
    if (cause === 'refresh') {
      const refresh = h.host.querySelectorAll('button').find(button => button.props.title === english.graph.refreshGraph)
      invoke(saved(refresh))
    } else { h.props.loading = true; await settle() }
    for (const callback of stale) invoke(callback)
    await settle()
    assert.equal(rows(h).length, 0); assert.equal(back(h), null); assert.equal(h.find('.detail-panel'), null)
    assert.equal(value(h, 'start').includes('Alice'), false); assert.equal(value(h, 'end').includes('Carol'), false)
    assert.deepEqual(h.emitted, cause === 'refresh' ? ['refresh'] : [])
    h.props.loading = true; await settle(); h.props.loading = false; await settle()
    const failed = view(h)
    for (const callback of stale) invoke(callback)
    await settle(); assert.deepEqual(view(h), failed); assert.equal(await h.runNextPathTask(), false)
    assert.equal(status(h), copy.changed)
  })
})

test('resize retains logical results and renews row and Back owners only after the latest redraw', async t => {
  const h = mount(t, graph(), { deferGraphRedraw: true }); await flush(h); await choose(h); await findPath(h)
  const oldFind = saved(h.find('.graph-path-find')), oldClear = saved(h.find('.graph-path-clear'))
  const oldRow = saved(rows(h)[0]); await h.click(rows(h)[0]); const oldBack = saved(back(h))
  const logical = { start: value(h, 'start'), end: value(h, 'end'), state: status(h),
    indexes: rows(h).map(row => row.props['data-source-index']) }
  const focus = h.takeRedraws(), focusCount = h.observations.focus.length
  h.resize(); const first = h.takeRedraws(); h.resize(); const second = h.takeRedraws(); await settle()
  assert.equal(rows(h)[0].props.disabled, true); assert.equal(back(h).props.disabled, true)
  for (const callback of [oldFind, oldClear, oldRow, oldBack, ...focus, ...first]) invoke(callback)
  await settle(); assert.equal(h.observations.focus.length, focusCount)
  assert.equal(rows(h)[0].props.disabled, true); assert.equal(back(h).props.disabled, true)
  for (const callback of second) callback(); await settle()
  assert.equal(rows(h)[0].props.disabled, false); assert.equal(back(h).props.disabled, false)
  assert.deepEqual({ start: value(h, 'start'), end: value(h, 'end'), state: status(h),
    indexes: rows(h).map(row => row.props['data-source-index']) }, logical)
  assert.equal(await h.runNextPathTask(), false, 'resize does not rerun BFS')
  const renewed = view(h)
  for (const callback of [oldFind, oldClear, oldRow, oldBack]) invoke(callback)
  await settle(); assert.deepEqual(view(h), renewed)
  await h.click(back(h)); await flush(h)
  assert.equal(h.find('.detail-panel'), null); assert.equal(h.observations.focus.at(-1).target, rows(h)[0])
  assert.equal(h.observations.focus.at(-1).options.preventScroll, true)
  await h.click(rows(h)[1]); const deferredFocus = h.takeRedraws()
  await h.select('b'); const selected = view(h)
  for (const callback of deferredFocus) callback()
  await settle(); assert.deepEqual(view(h), selected, 'queued path focus cannot cross a newer node selection')
})

test('unmount cancels queued path work and prevents retained controls and focus from running', async t => {
  const h = mount(t, largeGraph(), { deferGraphRedraw: true }); await flush(h); await choose(h); await findPath(h)
  const callbacks = [saved(h.find('.graph-path-find')), saved(h.find('.graph-path-clear')), saved(rows(h)[0])]
  await h.click(rows(h)[0]); callbacks.push(saved(back(h)))
  const focus = h.takeRedraws()
  await h.click(h.find('.graph-path-find')); await h.runNextPathTask()
  callbacks.push(saved(h.find('.graph-path-cancel')))
  const tasks = h.takePathTasks(); assert.ok(tasks.length)
  h.close(); const closed = view(h), focusCount = h.observations.focus.length
  for (const callback of callbacks.concat(tasks, focus)) invoke(callback)
  await settle()
  assert.deepEqual(view(h), closed); assert.equal(h.observations.focus.length, focusCount)
  assert.equal(await h.runNextPathTask(), false)
})
