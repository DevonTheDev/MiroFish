import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build, settle, ok, graphView } from './helpers/parent-route-fixture.js'
import { MAX_GRAPH_VIEW_SVG_BYTES } from '../src/utils/graphViewSvg.js'

// Group 3 exercises the real MainView and memory router with exact child
// capture descriptors. It does not establish native download completion.
const messages = JSON.parse(readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8')).graph
const fixture = () => build({ graphRoute: true, locale: 'en', assertNoWarnings: true })
const state = h => h.state(graphView)
const descriptor = h => h.graph().props.graphViewDownload
const action = h => { assert.equal(descriptor(h).enabled, true); return descriptor(h).action }
const jsonAction = h => { assert.equal(h.graph().props.graphDownload.enabled, true); return h.graph().props.graphDownload.action }
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const graph = (id = 'GA') => ({ graph_id: id, nodes: [{ uuid: 'one', name: 'One' }], edges: [], node_count: 1, edge_count: 0 })
const project = (id = 'A') => ({ project_id: id, graph_id: 'G' + id, status: 'graph_completed' })
const resourcesEmpty = h => { assert.equal(h.objectUrls.size, 0); assert.ok(h.anchors.every(anchor => !anchor.attached)) }
const requestCounts = h => Object.fromEntries(Object.entries(h.requests).map(([name, calls]) => [name, calls.length]))
const refresh = async h => { h.graph().emit('refresh'); await settle() }
async function loaded(h, id = 'A', value = graph('G' + id)) {
  pending(h, 'getProject').resolve(ok(project(id))); await settle()
  pending(h, 'getGraphData').resolve(ok(value)); await settle()
}
function drawing(h, options = {}) {
  const control = { ready: true, captures: 0, body: '<svg xmlns="http://www.w3.org/2000/svg"><text>First</text></svg>', ...options }
  control.descriptor = Object.freeze({ source: options.source ?? state(h).graphData,
    isReady: () => control.ready,
    capture: () => { control.captures++; return control.onCapture ? control.onCapture() : control.body },
  })
  return control
}
const publish = (h, capture) => h.graph().emit('graph-view-capture', capture.descriptor)
const retire = (h, capture) => { capture.ready = false; h.graph().emit('graph-view-retired', capture.descriptor) }
async function ready(h) {
  await h.mount('/process/A'); await loaded(h)
  const capture = drawing(h); publish(h, capture); await settle(); return capture
}

test('SVG admission requires the exact ready capture source and settled current project owner', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A')
    assert.equal(descriptor(h).enabled, false)
    pending(h, 'getProject').resolve(ok(project())); await settle()
    assert.equal(descriptor(h).enabled, false)
    pending(h, 'getGraphData').reject(new Error('private first read failure')); await settle()
    assert.equal(descriptor(h).enabled, false)
    await refresh(h); pending(h, 'getGraphData').resolve(ok(graph())); await settle()
    assert.equal(descriptor(h).enabled, false, 'a source without a completed drawing has no SVG action')
    const wrong = drawing(h, { source: graph() }), incomplete = drawing(h, { ready: false })
    publish(h, wrong); publish(h, incomplete); await settle()
    assert.equal(descriptor(h).enabled, false); resourcesEmpty(h)
    const current = drawing(h); publish(h, current); await settle(); const click = action(h)
    current.ready = false; click()
    assert.equal(current.captures, 0); resourcesEmpty(h)
    await settle(); assert.equal(descriptor(h).error, messages.viewDownload.invalid)
    current.ready = true; publish(h, current); await settle()
    assert.strictEqual(action(h), click, 'same-identity recovery preserves a current action')
    click(); assert.equal(h.downloads.length, 1)
    state(h).projectData.project_id = 'B'; click(); await settle()
    assert.equal(descriptor(h).enabled, false); assert.equal(h.downloads.length, 1); resourcesEmpty(h)
  } finally { h.close() }
})

test('SVG refresh retires immediately and failed refresh renews the still-current capture action', async () => {
  const h = fixture()
  try {
    let capture = await ready(h); const original = action(h); original()
    const firstUrl = h.downloads[0].href, source = state(h).graphData
    h.graph().emit('refresh')
    assert.ok(h.revoked.includes(firstUrl)); resourcesEmpty(h)
    original(); assert.equal(h.downloads.length, 1, 'retirement precedes child prop delivery')
    await settle(); assert.equal(descriptor(h).enabled, false)
    retire(h, capture); capture = drawing(h, { body: '<svg>Redrawn while refreshing</svg>' }); publish(h, capture)
    pending(h, 'getGraphData').reject(new Error('private refresh failure')); await settle()
    assert.strictEqual(state(h).graphData, source)
    const recovered = action(h); assert.notEqual(recovered, original)
    assert.equal(descriptor(h).status, messages.viewDownload.retained)
    original(); assert.equal(h.downloads.length, 1)
    recovered(); await settle(); assert.equal(h.downloads.length, 2)
    assert.equal(await h.downloads[1].blob.text(), capture.body)
    assert.equal(descriptor(h).status, messages.viewDownload.retained + ' ' + messages.viewDownload.started)
    capture.ready = false
    await refresh(h); pending(h, 'getGraphData').reject(new Error('refresh failed during incomplete frame')); await settle()
    assert.equal(descriptor(h).enabled, false, 'parent recovery cannot bind an incomplete frame')
    capture.ready = true; publish(h, capture); await settle()
    const afterFrameRecovery = action(h)
    assert.notEqual(afterFrameRecovery, recovered)
    recovered(); assert.equal(h.downloads.length, 2)
    afterFrameRecovery(); await settle(); assert.equal(h.downloads.length, 3)
    assert.equal(descriptor(h).status, messages.viewDownload.retained + ' ' + messages.viewDownload.started)
  } finally { h.close() }
})

test('SVG source replacement and delayed capture or prop delivery cannot redirect an old action', async () => {
  const h = fixture()
  try {
    const oldCapture = await ready(h), oldAction = action(h)
    await refresh(h); pending(h, 'getGraphData').resolve(ok(graph())); await settle()
    publish(h, oldCapture); await settle()
    assert.equal(descriptor(h).enabled, false, 'same graph ID does not admit a different source reference')
    const first = drawing(h); publish(h, first); await settle(); const staleRenderedAction = action(h)
    retire(h, first)
    const replacement = drawing(h, { body: '<svg>Replacement</svg>' }); publish(h, replacement)
    oldAction(); staleRenderedAction(); resourcesEmpty(h)
    assert.equal(first.captures, 0); assert.equal(oldCapture.captures, 0)
    await settle(); action(h)()
    assert.equal(await h.downloads[0].blob.text(), replacement.body)
    state(h).graphData = graph(); action(h)(); await settle()
    assert.equal(descriptor(h).enabled, false); assert.equal(h.downloads.length, 1); resourcesEmpty(h)
  } finally { h.close() }
})

test('SVG A to B to A selection and unmount leave departed capture actions inert', async () => {
  const h = fixture()
  try {
    await ready(h); const firstA = action(h)
    await h.navigate('/process/B'); await loaded(h, 'B')
    publish(h, drawing(h)); await settle(); const middleB = action(h)
    await h.navigate('/process/A'); await loaded(h)
    publish(h, drawing(h, { body: '<svg>New A</svg>' })); await settle(); const latest = action(h)
    firstA(); middleB(); assert.equal(h.downloads.length, 0)
    latest(); assert.equal(await h.downloads[0].blob.text(), '<svg>New A</svg>')
    h.close(); firstA(); middleB(); latest()
    assert.equal(h.downloads.length, 1); resourcesEmpty(h)
  } finally { h.close() }
})

test('SVG canceled reused-route navigation renews its action without rereading the current drawing', async () => {
  const h = fixture(); let release
  try {
    const capture = await ready(h), original = action(h); original()
    const counts = requestCounts(h), source = state(h).graphData
    h.router.beforeEach(to => to.query.view ? new Promise(resolve => { release = resolve }) : undefined)
    const navigation = h.router.push('/process/A?view=graph'); await settle()
    assert.equal(descriptor(h).enabled, false); original(); resourcesEmpty(h)
    capture.ready = false
    release(false); await navigation; await settle()
    assert.strictEqual(state(h).graphData, source); assert.deepEqual(requestCounts(h), counts)
    assert.equal(descriptor(h).enabled, false, 'navigation recovery waits for a completed frame')
    capture.ready = true; publish(h, capture); await settle()
    const recovered = action(h); assert.notEqual(recovered, original)
    original(); assert.equal(capture.captures, 1)
    recovered(); assert.equal(capture.captures, 2); assert.equal(h.downloads.length, 2)
  } finally { release?.(false); h.close() }
})

test('SVG competing full departures recover only with a new matching drawing descriptor', async () => {
  const h = fixture(), releases = new Map()
  try {
    const oldCapture = await ready(h), original = action(h); original()
    h.router.beforeEach(to => new Promise(resolve => releases.set(to.path, resolve)))
    const first = h.router.push('/'); await settle(); resourcesEmpty(h)
    const second = h.router.push('/runtime'); await settle()
    releases.get('/')(false); await first; await settle()
    assert.equal(descriptor(h).enabled, false); original(); assert.equal(h.calls('getProject').length, 1)
    releases.get('/runtime')(false); await second; await settle()
    assert.equal(h.calls('getProject').length, 2)
    await loaded(h); publish(h, oldCapture); await settle()
    assert.equal(descriptor(h).enabled, false)
    publish(h, drawing(h)); await settle(); const recovered = action(h)
    original(); assert.equal(h.downloads.length, 1)
    recovered(); assert.equal(h.downloads.length, 2)
  } finally { for (const release of releases.values()) release(false); h.close() }
})

test('SVG child retirement clears only its exact descriptor and does not revoke a frozen file during a tick', async () => {
  const h = fixture()
  try {
    const first = await ready(h); action(h)(); const firstUrl = h.downloads[0].href
    first.ready = false
    assert.ok(h.objectUrls.has(firstUrl), 'an ordinary tick gate does not retire an already frozen file')
    action(h)(); await settle()
    assert.equal(descriptor(h).error, messages.viewDownload.invalid)
    assert.ok(h.objectUrls.has(firstUrl), 'an unavailable-frame click preserves the earlier frozen file')
    first.ready = true
    const sameAction = action(h), priorStatus = descriptor(h).status
    publish(h, first); await settle()
    assert.strictEqual(action(h), sameAction); assert.equal(descriptor(h).status, priorStatus)
    assert.ok(h.objectUrls.has(firstUrl), 'same-identity recovery does not retire successful resources')
    retire(h, first); assert.ok(h.revoked.includes(firstUrl)); resourcesEmpty(h)
    const second = drawing(h); publish(h, second); await settle(); const current = action(h); current()
    const url = h.downloads[1].href, status = state(h).graphViewDownload.status
    h.graph().emit('graph-view-retired', first.descriptor)
    assert.ok(h.objectUrls.has(url)); assert.equal(state(h).graphViewDownload.status, status)
    assert.strictEqual(state(h).graphViewDownload.action, current)
    retire(h, second); current(); await settle()
    assert.equal(descriptor(h).enabled, false); assert.equal(h.downloads.length, 2); resourcesEmpty(h)
  } finally { h.close() }
})

test('SVG capture reentry cannot allocate or overwrite a newer descriptor download or refresh state', async () => {
  for (const replacement of [false, true]) {
    const h = fixture()
    try {
      const oldCapture = await ready(h), click = action(h)
      oldCapture.onCapture = () => {
        if (replacement) {
          retire(h, oldCapture)
          publish(h, drawing(h, { body: '<svg>New captured drawing</svg>' }))
          state(h).graphViewDownload.action()
        } else h.graph().emit('refresh')
        return '<svg>Stale captured drawing</svg>'
      }
      click(); await settle()
      assert.equal(h.downloads.length, replacement ? 1 : 0)
      assert.equal(h.anchors.length, replacement ? 1 : 0)
      if (replacement) {
        assert.equal(await h.downloads[0].blob.text(), '<svg>New captured drawing</svg>')
        assert.ok(h.objectUrls.has(h.downloads[0].href)); assert.equal(descriptor(h).error, '')
        assert.equal(descriptor(h).status, messages.viewDownload.started)
      } else { resourcesEmpty(h); assert.equal(descriptor(h).enabled, false); assert.equal(descriptor(h).status, '') }
    } finally { h.close() }
  }
})

test('SVG success requests the fixed file without API reads and retains only its newest URL', async () => {
  const h = fixture()
  try {
    const capture = await ready(h), counts = requestCounts(h); const click = action(h)
    click(); await settle(); const first = h.downloads[0]
    assert.equal(first.filename, 'mirofish-graph-view.svg')
    assert.equal(first.blob.type, 'image/svg+xml;charset=utf-8')
    assert.equal(await first.blob.text(), capture.body)
    assert.deepEqual(requestCounts(h), counts); assert.deepEqual(h.revoked, [])
    assert.equal(h.objectUrls.size, 1); assert.ok(h.anchors.every(anchor => !anchor.attached))
    assert.equal(descriptor(h).status, 'SVG download requested. Check your browser downloads.')
    click(); await settle()
    assert.deepEqual(h.revoked, [first.href]); assert.equal(h.objectUrls.size, 1)
    assert.ok(h.objectUrls.has(h.downloads[1].href)); assert.ok(h.anchors.every(anchor => !anchor.attached))
    h.close(); resourcesEmpty(h)
  } finally { h.close() }
})

test('SVG and JSON attempts preserve each other resources statuses and errors in both directions', async () => {
  const h = fixture()
  try {
    await h.mount('/process/A')
    const value = graph()
    value.nodes[0] = { uuid: 'one', name: 'One', labels: [], summary: '', attributes: {}, created_at: null }
    await loaded(h, 'A', value)
    const capture = drawing(h); publish(h, capture); await settle()
    const svg = action(h), json = jsonAction(h)
    const successfulJson = async () => {
      const count = h.downloads.length
      json(); await settle()
      assert.equal(h.downloads.length, count + 1, 'a successful JSON request creates its own new download')
      const download = h.downloads.at(-1)
      assert.equal(download.filename, 'mirofish-loaded-graph.json')
      assert.equal(download.blob.type, 'application/json;charset=utf-8')
      assert.equal(h.graph().props.graphDownload.error, '')
      return download.href
    }
    svg(); await settle(); const svgUrl = h.downloads.at(-1).href, svgStatus = descriptor(h).status
    const jsonFirst = await successfulJson()
    const jsonUrl = await successfulJson(), jsonStatus = h.graph().props.graphDownload.status
    assert.ok(h.revoked.includes(jsonFirst)); assert.ok(h.objectUrls.has(svgUrl)); assert.equal(descriptor(h).status, svgStatus)
    svg(); await settle(); assert.ok(h.revoked.includes(svgUrl)); assert.ok(h.objectUrls.has(jsonUrl))
    const svgSecond = h.downloads.at(-1).href
    assert.equal(h.graph().props.graphDownload.status, jsonStatus); assert.equal(h.objectUrls.size, 2)
    capture.onCapture = () => { throw Object.assign(new Error('private invalid capture'), { code: 'invalid' }) }
    svg(); await settle(); assert.ok(h.revoked.includes(svgSecond)); assert.ok(h.objectUrls.has(jsonUrl))
    assert.equal(descriptor(h).error, messages.viewDownload.invalid)
    assert.equal(h.graph().props.graphDownload.status, jsonStatus)
    delete capture.onCapture; svg(); await settle(); const svgThird = h.downloads.at(-1).href
    h.downloadHooks.blob = () => { throw new Error('private JSON-only download failure') }
    const beforeFailedJson = h.downloads.length
    json(); await settle(); assert.equal(h.downloads.length, beforeFailedJson)
    assert.ok(h.objectUrls.has(svgThird)); assert.equal(descriptor(h).status, svgStatus); assert.equal(descriptor(h).error, '')
    assert.equal(h.graph().props.graphDownload.error, messages.download.failed)
    delete h.downloadHooks.blob; await successfulJson(); assert.equal(h.objectUrls.size, 2)
    h.graph().emit('refresh'); resourcesEmpty(h)
  } finally { h.close() }
})

test('SVG invalid and oversized captures fail before allocation and the final UTF-8 byte limit is exact', async () => {
  const h = fixture()
  try {
    const capture = await ready(h), click = action(h)
    for (const [value, code] of [[null, 'invalid'], ['', 'invalid'], [new Error('private capture failure'), 'failed'],
      [Object.assign(new Error('private invalid'), { code: 'invalid' }), 'invalid'],
      [Object.assign(new Error('private oversized'), { code: 'too_large' }), 'tooLarge']]) {
      capture.onCapture = () => { if (value instanceof Error) throw value; return value }
      click(); await settle(); resourcesEmpty(h)
      assert.equal(h.anchors.length, 0); assert.equal(h.downloads.length, 0)
      assert.equal(descriptor(h).error, messages.viewDownload[code])
    }
    capture.onCapture = () => { capture.ready = false; return capture.body }
    click(); await settle(); resourcesEmpty(h)
    assert.equal(h.anchors.length, 0); assert.equal(h.downloads.length, 0)
    assert.equal(descriptor(h).error, messages.viewDownload.invalid, 'readiness loss during capture reports only on its current attempt')
    capture.ready = true; publish(h, capture); await settle()
    delete capture.onCapture
    const overhead = '<svg></svg>'.length, available = MAX_GRAPH_VIEW_SVG_BYTES - overhead
    capture.body = '<svg>' + '雪'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3) + '</svg>'
    click(); await settle()
    assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].blob.size, MAX_GRAPH_VIEW_SVG_BYTES)
    capture.body = capture.body.replace('</svg>', 'x</svg>')
    click(); await settle(); resourcesEmpty(h)
    assert.equal(h.downloads.length, 1); assert.equal(h.anchors.length, 1)
    assert.equal(descriptor(h).error, messages.viewDownload.tooLarge)
  } finally { h.close() }
})

test('SVG five throwing download stages release their exact attempt and permit a clean retry', async () => {
  for (const stage of ['blob', 'createObjectURL', 'anchor', 'append', 'click']) {
    const h = fixture()
    try {
      await ready(h)
      h.downloadHooks[stage] = () => { throw new Error('private synthetic ' + stage) }
      action(h)(); await settle(); resourcesEmpty(h)
      assert.equal(h.downloads.length, 0); assert.equal(descriptor(h).error, messages.viewDownload.failed)
      delete h.downloadHooks[stage]; action(h)(); await settle()
      assert.equal(h.downloads.length, 1); assert.equal(descriptor(h).error, '')
    } finally { h.close() }
  }
})

test('SVG two one-shot URL reentries preserve the newer successful attempt and release only stale resources', async () => {
  for (const stage of ['createObjectURL', 'revokeObjectURL']) {
    const h = fixture()
    try {
      await ready(h); const click = action(h)
      if (stage === 'revokeObjectURL') click()
      h.downloadHooks[stage] = () => { delete h.downloadHooks[stage]; click() }
      click(); await settle()
      assert.equal(h.objectUrls.size, 1)
      const current = h.downloads.at(-1).href
      assert.ok(h.objectUrls.has(current)); assert.ok(!h.revoked.includes(current))
      assert.equal(descriptor(h).error, ''); assert.equal(descriptor(h).status, messages.viewDownload.started)
      assert.ok(h.anchors.every(anchor => !anchor.attached))
      h.close(); resourcesEmpty(h)
    } finally { h.close() }
  }
})
