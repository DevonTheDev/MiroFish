import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, graphView } from './helpers/parent-route-fixture.js'
import { createLoadedGraphFile, MAX_LOADED_GRAPH_BYTES } from '../src/utils/loadedGraphFile.js'

const fixture = () => build({ graphRoute: true, locale: 'en', assertNoWarnings: true })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const state = h => h.state(graphView)
const descriptor = h => h.graph().props.graphDownload
const action = h => { assert.equal(descriptor(h).enabled, true); return descriptor(h).action }
const graph = (id = 'GA', label = 'first') => ({ graph_id: id, nodes: [], edges: [], node_count: 0, edge_count: 0, extra: { label } })
const project = (id = 'A') => ({ project_id: id, graph_id: 'G' + id, status: 'graph_completed' })
const refresh = async h => { h.graph().emit('refresh'); await settle() }
const body = async h => JSON.parse(await h.downloads.at(-1).blob.text())
const resourcesEmpty = h => { assert.equal(h.objectUrls.size, 0); assert.ok(h.anchors.every(anchor => !anchor.attached)) }
async function loaded(h, id = 'A', value = graph('G' + id)) {
  pending(h, 'getProject').resolve(ok(project(id))); await settle()
  pending(h, 'getGraphData').resolve(ok(value)); await settle()
}

// Case 6 plus the project-binding row in case 2. A graph response has no
// project_id of its own; only the actual MainView can check selected metadata.
test('loaded graph action requires a settled completed bound project and makes no API request', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A')
    assert.equal(descriptor(h).enabled, false)
    pending(h, 'getProject').resolve(ok(project())); await settle()
    assert.equal(descriptor(h).enabled, false)
    pending(h, 'getGraphData').reject(new Error('private first-read failure')); await settle()
    assert.equal(descriptor(h).enabled, false); resourcesEmpty(h)
    await refresh(h); pending(h, 'getGraphData').resolve(ok(graph())); await settle()
    const click = action(h), before = Object.fromEntries(Object.entries(h.requests).map(([key, calls]) => [key, calls.length]))
    click(); await settle()
    assert.equal(h.downloads.length, 1)
    assert.equal(h.downloads[0].filename, 'mirofish-loaded-graph.json')
    assert.equal(h.downloads[0].blob.type, 'application/json;charset=utf-8')
    assert.deepEqual(Object.fromEntries(Object.entries(h.requests).map(([key, calls]) => [key, calls.length])), before)
    assert.equal((await body(h)).project_id, 'A')
    state(h).projectData.project_id = 'B'; click(); await settle()
    assert.equal(descriptor(h).enabled, false); assert.equal(h.downloads.length, 1); resourcesEmpty(h)
    state(h).projectData.project_id = 'A'; await refresh(h)
    pending(h, 'getGraphData').resolve(ok(graph('wrong-graph'))); await settle()
    assert.equal(descriptor(h).enabled, false)
    assert.equal(descriptor(h).error, 'This loaded graph cannot be downloaded as JSON.')
    await refresh(h); pending(h, 'getGraphData').resolve(ok({ graph_id: 'GA', nodes: null, edges: [] })); await settle()
    assert.equal(descriptor(h).enabled, false); resourcesEmpty(h)
    assert.equal(descriptor(h).error, 'This loaded graph cannot be downloaded as JSON.')
  } finally { h.close() }
})

// Case 8. The successful source receipt and latest failed read are distinct.
test('failed refresh publishes fresh actions for the retained source until a later success replaces it', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A'); await loaded(h)
    const original = action(h), source = state(h).graphData
    for (const failure of [new Error('private refresh failure'), { success: false, error: 'private repeated failure' }]) {
      const previous = action(h)
      await refresh(h); assert.equal(descriptor(h).enabled, false)
      previous(); original(); assert.equal(h.downloads.length, failure instanceof Error ? 0 : 1)
      const request = pending(h, 'getGraphData')
      if (failure instanceof Error) request.reject(failure); else request.resolve(failure)
      await settle()
      assert.equal(state(h).graphData, source)
      assert.equal(descriptor(h).status, 'Refresh failed; download uses the previously loaded graph.')
      const current = action(h); assert.notEqual(current, previous)
      const count = h.downloads.length; previous(); original(); assert.equal(h.downloads.length, count)
      current(); await settle(); assert.equal((await body(h)).graph.extra.label, 'first')
      assert.equal(descriptor(h).status, 'Refresh failed; download uses the previously loaded graph.')
    }
    const retained = action(h)
    await refresh(h); pending(h, 'getGraphData').resolve(ok(graph('GA', 'replacement'))); await settle()
    assert.equal(descriptor(h).status, '')
    retained(); original(); assert.equal(h.downloads.length, 2)
    action(h)(); assert.equal((await body(h)).graph.extra.label, 'replacement')
  } finally { h.close() }
})

// Case 9. These are current decoded values, never an accepted-response hash.
test('same-ID source replacement retires old actions while click-time values detach before Blob creation', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A'); await loaded(h)
    const old = action(h)
    await refresh(h); pending(h, 'getGraphData').resolve(ok(graph('GA', 'replacement'))); await settle()
    old(); assert.equal(h.downloads.length, 0)
    const click = action(h), source = state(h).graphData
    source.extra.label = 'valid before click'
    h.downloadHooks.blob = () => { delete h.downloadHooks.blob; source.extra.label = 'valid after serialization' }
    click(); assert.equal((await body(h)).graph.extra.label, 'valid before click')
    click(); assert.equal((await body(h)).graph.extra.label, 'valid after serialization')
    source.extra.label = undefined
    const anchors = h.anchors.length
    click(); await settle(); assert.equal(h.downloads.length, 2); assert.equal(h.anchors.length, anchors); resourcesEmpty(h)
    assert.equal(descriptor(h).error, 'This loaded graph cannot be downloaded as JSON.')
    source.extra.label = 'valid retry'; click(); assert.equal((await body(h)).graph.extra.label, 'valid retry')
    state(h).graphData = graph('GA', 'unowned replacement'); click(); await settle()
    assert.equal(h.downloads.length, 3); assert.equal(descriptor(h).enabled, false); resourcesEmpty(h)
  } finally { h.close() }
})

// Case 10, using the existing real-memory-router A → B → A ownership pattern.
test('A to B to A and unmount keep departed loaded graph callbacks inert', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A'); await loaded(h); const firstA = action(h)
    await h.navigate('/process/B'); await loaded(h, 'B'); const middleB = action(h)
    await h.navigate('/process/A'); await loaded(h, 'A', graph('GA', 'new A'))
    const current = action(h), logs = state(h).systemLogs.length
    firstA(); middleB(); assert.equal(h.downloads.length, 0)
    assert.equal(state(h).systemLogs.length, logs)
    current(); assert.equal((await body(h)).graph.extra.label, 'new A')
    h.close()
    assert.equal(state(h).systemLogs.length, 0, 'the existing unmount lifecycle resets logs')
    const logsAfterUnmount = state(h).systemLogs.length
    firstA(); middleB(); current()
    assert.equal(h.downloads.length, 1); resourcesEmpty(h)
    assert.equal(state(h).systemLogs.length, logsAfterUnmount)
  } finally { h.close() }
})

// Case 11. Older cancellation cannot clear the newer pending navigation token.
test('canceled and competing departures recover only fresh current graph download actions', async () => {
  const h = fixture(), releases = new Map()
  try {
    await h.mount('/process/A'); await loaded(h); const original = action(h)
    h.router.beforeEach(to => new Promise(resolve => releases.set(to.path, resolve)))
    const first = h.router.push('/'); await settle()
    assert.equal(descriptor(h).enabled, false); original(); resourcesEmpty(h)
    const second = h.router.push('/runtime'); await settle()
    releases.get('/')(false); await first; await settle()
    assert.equal(descriptor(h).enabled, false); original(); assert.equal(h.calls('getProject').length, 1)
    releases.get('/runtime')(false); await second; await settle()
    assert.equal(descriptor(h).enabled, false); assert.equal(h.calls('getProject').length, 2)
    await loaded(h); const recovered = action(h)
    assert.notEqual(recovered, original); original(); assert.equal(h.downloads.length, 0)
    recovered(); assert.equal(h.downloads.length, 1)
  } finally { for (const release of releases.values()) release(false); h.close() }
})

// Case 12: abort/commit after our observer and before an earlier global guard.
// Registration order is a real boundary: unseen pending intent is not owned.
test('reused-route query abort and commit respect guard ordering without rereading a valid source', async () => {
  for (const [order, outcome] of [['later', 'abort'], ['later', 'commit'], ['earlier', 'abort'], ['earlier', 'commit']]) {
    const h = fixture(); let release
    const guard = to => to.query.view ? new Promise(resolve => { release = resolve }) : undefined
    try {
      if (order === 'earlier') h.router.beforeEach(guard)
      await h.mount('/process/A'); await loaded(h); const original = action(h)
      const source = state(h).graphData
      if (order === 'later') h.router.beforeEach(guard)
      const navigation = h.router.push('/process/A?view=graph'); await settle()
      assert.ok(release); assert.equal(descriptor(h).enabled, order === 'earlier')
      original(); assert.equal(h.downloads.length, order === 'earlier' ? 1 : 0)
      release(outcome === 'abort' ? false : undefined); await navigation; await settle()
      assert.equal(h.router.currentRoute.value.fullPath, outcome === 'abort' ? '/process/A' : '/process/A?view=graph')
      assert.equal(h.calls('getProject').length, 1); assert.equal(h.calls('getGraphData').length, 1)
      assert.equal(state(h).graphData, source)
      const current = action(h)
      if (order === 'earlier' && outcome === 'abort') {
        assert.equal(current, original, 'an abort before MainView observes navigation preserves its current action')
        original(); assert.equal(h.downloads.length, 2)
      } else {
        assert.notEqual(current, original)
        const count = h.downloads.length; original(); assert.equal(h.downloads.length, count)
        current(); assert.equal(h.downloads.length, count + 1)
      }
    } finally { release?.(false); h.close() }
  }
})

// Case 13 plus case 4's browser boundary: whole-file oversize never allocates.
test('loaded graph URLs survive successful clicks and retire on new download refresh replacement and unmount', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A'); await loaded(h)
    action(h)(); const first = h.downloads[0].href
    assert.equal(h.objectUrls.size, 1); assert.deepEqual(h.revoked, []); assert.ok(h.anchors.every(anchor => !anchor.attached))
    action(h)(); const second = h.downloads[1].href
    assert.deepEqual(h.revoked, [first]); assert.equal(h.objectUrls.size, 1); assert.ok(h.objectUrls.has(second))
    await refresh(h); assert.deepEqual(h.revoked, [first, second]); resourcesEmpty(h)
    pending(h, 'getGraphData').resolve(ok(graph('GA', 'new'))); await settle()
    action(h)(); const third = h.downloads[2].href
    state(h).graphData = graph(); await settle(); assert.ok(h.revoked.includes(third)); resourcesEmpty(h)
    await refresh(h); pending(h, 'getGraphData').resolve(ok(graph())); await settle()
    // Use the same fixed-width ISO spelling as a real click to size the entire file.
    const source = state(h).graphData
    source.extra.label = ''
    const overhead = Buffer.byteLength(createLoadedGraphFile(source, { projectId: 'A', graphId: 'GA', downloadedAt: '2026-10-14T00:00:00.000Z' }))
    const anchors = h.anchors.length, downloads = h.downloads.length
    for (const multibyte of [false, true]) {
      const available = MAX_LOADED_GRAPH_BYTES - overhead + 1
      source.extra.label = multibyte ? '雪'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3) : 'x'.repeat(available)
      action(h)(); await settle()
      assert.equal(descriptor(h).error, 'Graph download exceeds the 8 MiB limit; no file was created.')
      assert.equal(h.downloads.length, downloads); assert.equal(h.anchors.length, anchors); resourcesEmpty(h)
    }
    source.extra.label = 'bounded retry'; action(h)(); const last = h.downloads.at(-1).href
    assert.ok(h.objectUrls.has(last)); h.close(); assert.ok(h.revoked.includes(last)); resourcesEmpty(h)
  } finally { h.close() }
})

// Case 14 has exactly five throwing and two one-shot reentry stages.
test('download failures clean only their attempt and URL reentry preserves the newer successful download', async () => {
  for (const stage of ['blob', 'createObjectURL', 'anchor', 'append', 'click']) {
    const h = fixture()
    try {
      await h.mount('/process/A'); await loaded(h)
      h.downloadHooks[stage] = () => { throw new Error('private synthetic ' + stage) }
      action(h)(); await settle(); resourcesEmpty(h)
      assert.equal(h.downloads.length, 0)
      assert.equal(descriptor(h).error, 'The graph download could not be started. Try again.')
      delete h.downloadHooks[stage]; action(h)(); await settle()
      assert.equal(h.downloads.length, 1); assert.equal(descriptor(h).error, '')
    } finally { h.close() }
  }
  for (const stage of ['createObjectURL', 'revokeObjectURL']) {
    const h = fixture()
    try {
      await h.mount('/process/A'); await loaded(h); const click = action(h)
      if (stage === 'revokeObjectURL') click()
      h.downloadHooks[stage] = () => { delete h.downloadHooks[stage]; click() }
      click(); await settle()
      assert.equal(h.objectUrls.size, 1)
      const current = h.downloads.at(-1).href
      assert.ok(h.objectUrls.has(current)); assert.ok(!h.revoked.includes(current))
      assert.equal(descriptor(h).error, ''); assert.ok(h.anchors.every(anchor => !anchor.attached))
      h.close(); resourcesEmpty(h)
    } finally { h.close() }
  }
})
