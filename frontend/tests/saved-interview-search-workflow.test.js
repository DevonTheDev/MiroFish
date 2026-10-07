import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { setup, resolve, observation, record, source, flush } from './helpers/saved-interviews-view-fixture.js'

// These tests mount the actual compiled SavedInterviewsView through the real Vue
// renderer and application router. Only the local API boundary is deferred.
const livePath = '/simulation/sim_A/interviews', filePath = '/interview-files'
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const ids = h => h.all(n => String(n.props['data-testid'] ?? '').startsWith('interview-row-')).map(n => n.props['data-testid'])
const options = h => h.byId('interviews-question-select').children.filter(n => n.type === 'option')
const search = h => {
  const control = h.byId('interviews-search')
  assert.ok(control, 'accepted saved interviews must expose the local text search control')
  return control
}
const query = h => search(h).props.value
const counts = h => {
  const status = h.byId('interviews-search-count')
  assert.ok(status, 'local text search must report matches separately from source counts')
  return [...h.text(status).matchAll(/\d+/g)].map(match => Number(match[0]))
}
const file = (data, name = 'saved.json') => new File([JSON.stringify(data)], name, { type: 'application/json' })
async function choose(h, files) {
  const target = { files, value: 'selected' }
  h.byId('interviews-file-input').props.onChange({ target }); await flush()
  assert.equal(target.value, '')
}
async function open(h, data, name) {
  await choose(h, [file(data, name)])
  await h.click('interviews-file-open')
}
function deferredFile(data, name = 'pending.json') {
  let resolveRead, reject
  const pending = new Promise((yes, no) => { resolveRead = yes; reject = no })
  const value = file(data, name)
  value.arrayBuffer = () => pending
  value.text = () => pending.then(bytes => new TextDecoder().decode(bytes))
  return { value, reject, complete: () => resolveRead(new TextEncoder().encode(JSON.stringify(data)).buffer) }
}
function severalPages() {
  return observation({ records: ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 32 }, (_, i) => record(platform, String(100 - i), {
    prompt: platform === 'twitter' ? 'First question' : 'Second question',
    response: `${platform} response ${i}${i === 29 ? ' Needle [a.*]' : ''}`,
  }))) })
}
async function accepted(t, path = livePath, locale = 'en', data = severalPages()) {
  const state = await setup(t, path, locale)
  if (path === filePath) await open(state.h, data)
  else await resolve(state.calls.getSavedInterviews[0], data)
  search(state.h)
  return { ...state, data }
}
function assertRequests(calls, path, count = path === filePath ? 0 : 1) {
  assert.equal(calls.getSavedInterviews.length, count, 'search must not fetch another observation')
  assert.equal(calls.getSimulationHistory.length, 0, 'search must not request simulation history')
}
function sourceSummary(h, platform) {
  const section = h.byId(`interviews-source-${platform}`)
  return h.text(section.children.find(node => String(node.props.class ?? '').includes('source-summary')))
}
function retained(h) {
  return [search(h).props.onInput, h.byId('interviews-search-clear').props.onClick,
    h.byId('interviews-questions-mode').props.onClick, h.byId('interviews-next').props.onClick]
}
async function invoke(callbacks, value = 'stale text') {
  for (const callback of callbacks) callback(event(value))
  await flush()
}

for (const path of [livePath, filePath]) for (const locale of ['en', 'zh']) test(`search reaches hidden pages and clears locally with accessible controls in ${locale} on ${path}`, async t => {
  const { h, calls } = await accepted(t, path, locale)
  const initialPath = h.router.currentRoute.value.fullPath
  assert.equal(query(h), '')
  assert.deepEqual(counts(h), [64, 64])
  assert.equal(ids(h).length, 25)
  assert.equal(ids(h).includes('interview-row-twitter:71'), false)
  assert.equal(search(h).props.type, 'search')
  const label = h.find(n => n.type === 'label' && n.props.for === search(h).props.id)
  assert.ok(label && h.text(label).trim(), 'search needs an associated, translated label')
  assert.ok(h.byId('interviews-search-note'))
  assert.equal(Boolean(h.byId('interviews-search-empty')), false)
  await h.click('interviews-next')
  await h.input('interviews-search', 'nEeDlE [A.*]')
  assert.equal(query(h), 'nEeDlE [A.*]')
  assert.deepEqual(ids(h), ['interview-row-twitter:71', 'interview-row-reddit:71'])
  assert.deepEqual(counts(h), [2, 64])
  assert.equal(h.byId('interviews-previous').props.disabled, true)
  assert.equal(h.byId('interviews-next').props.disabled, true)
  await h.input('interviews-search', 'No stored text contains this')
  assert.deepEqual(ids(h), [])
  assert.deepEqual(counts(h), [0, 64])
  assert.ok(h.byId('interviews-search-empty'))
  await h.click('interviews-search-clear')
  assert.equal(query(h), '')
  assert.deepEqual(counts(h), [64, 64])
  assert.equal(ids(h)[0], 'interview-row-twitter:100')
  assert.equal(ids(h).length, 25)
  assert.equal(Boolean(h.byId('interviews-search-empty')), false)
  assert.equal(h.router.currentRoute.value.fullPath, initialPath)
  assertRequests(calls, path)
  assert.doesNotMatch(h.text(), /savedInterview(?:Files|s)\./)
  assert.deepEqual(h.warnings, [])
})

for (const path of [livePath, filePath]) test(`search preserves query across pages and exact-question views while each query starts at page one on ${path}`, async t => {
  const { h, calls } = await accepted(t, path)
  await h.input('interviews-search', 'response')
  await h.click('interviews-next')
  assert.equal(query(h), 'response')
  assert.equal(ids(h)[0], 'interview-row-twitter:75')
  await h.click('interviews-questions-mode')
  assert.equal(query(h), 'response')
  assert.deepEqual(counts(h), [32, 32])
  assert.equal(ids(h)[0], 'interview-row-twitter:100')
  const originalOptions = options(h).map(option => h.text(option))
  assert.equal(originalOptions.length, 2)
  await h.click('interviews-next')
  assert.equal(ids(h).length, 7)
  await h.input('interviews-search', 'needle')
  assert.deepEqual(ids(h), ['interview-row-twitter:71'])
  assert.deepEqual(counts(h), [1, 32])
  assert.equal(h.byId('interviews-previous').props.disabled, true)
  assert.match(h.text(h.byId('interviews-question-counts-twitter')), /32/)
  assert.deepEqual(options(h).map(option => h.text(option)), originalOptions)
  await h.change('interviews-question-select', options(h)[1].props.value)
  assert.equal(query(h), 'needle')
  assert.deepEqual(ids(h), ['interview-row-reddit:71'])
  assert.deepEqual(counts(h), [1, 32])
  assert.match(h.text(h.byId('interviews-question-counts-reddit')), /32/)
  await h.input('interviews-search', 'First question')
  assert.deepEqual(ids(h), [], 'a match in another question must not leak into the selected question')
  assert.deepEqual(counts(h), [0, 32])
  assert.ok(h.byId('interviews-search-empty'))
  await h.click('interviews-records-mode')
  assert.equal(query(h), 'First question')
  assert.deepEqual(counts(h), [32, 64])
  assert.equal(ids(h)[0], 'interview-row-twitter:100')
  await h.click('interviews-next')
  await h.input('interviews-search', 'First question')
  assert.equal(ids(h)[0], 'interview-row-twitter:100', 'even an input with the same text resets the current page')
  h.i18n.global.locale.value = 'zh'; await flush()
  assert.equal(query(h), 'First question')
  assert.deepEqual(counts(h), [32, 64])
  assertRequests(calls, path)
  assert.deepEqual(h.warnings, [])
})

for (const path of [livePath, filePath]) test(`search treats saved fields separately and hostile content literally on ${path}`, async t => {
  const hostile = '<img src=x onerror=alert(1)><script>literal [a.*]</script>'
  const data = observation({ records: [
    record('twitter', '9', { prompt: 'left', response: 'right', timestamp: 'metadata-only-search-term' }),
    record('twitter', '8', { prompt: 'Stored question', response: hostile }),
    record('twitter', '7', { prompt: null, response: null, payload_kind: 'raw', raw_preview: hostile, warnings: ['invalid_json'] }),
    record('twitter', '6', { prompt: 'Partly retained', response: 'Needle preview', truncated: true, warnings: ['payload_truncated'] }),
    record('twitter', '5', { prompt: 'café', response: '  spaced  ' }),
    record('twitter', '4', { prompt: '', response: '' }),
    record('twitter', '3', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
  ] })
  const { h, calls } = await accepted(t, path, 'en', data)
  assert.deepEqual(counts(h), [7, 7])
  for (const term of ['left right', 'metadata-only-search-term', 'cafe\u0301', '.*literal']) {
    await h.input('interviews-search', term)
    assert.deepEqual(ids(h), [], `query ${JSON.stringify(term)} must not concatenate, inspect metadata, normalize or use regex`)
  }
  await h.input('interviews-search', '[A.*]')
  assert.deepEqual(ids(h), ['interview-row-twitter:8', 'interview-row-twitter:7'])
  assert.ok(h.text().includes(hostile))
  assert.equal(h.all(n => ['img', 'script', 'iframe'].includes(n.type) || n.props.innerHTML).length, 0)
  await h.input('interviews-search', '  ')
  assert.deepEqual(ids(h), ['interview-row-twitter:5'], 'spaces are searched without trimming')
  await h.input('interviews-search', 'needle')
  assert.deepEqual(ids(h), ['interview-row-twitter:6'])
  assert.match(h.text(h.byId('interview-row-twitter:6')), /truncated/i)
  await h.click('interviews-search-clear')
  assert.equal(ids(h).length, 7)
  assert.ok(h.byId('interview-row-twitter:3'), 'empty search restores missing payloads')
  assertRequests(calls, path)
  assert.deepEqual(h.warnings, [])
})

for (const path of [livePath, filePath]) for (const status of ['missing', 'unreadable', 'too_large', 'query_limited']) test(`search preserves ${status} source facts and complete downloads on ${path}`, async t => {
  const warning = { missing: 'source_missing', unreadable: 'source_unreadable', too_large: 'database_too_large', query_limited: 'query_limited' }[status]
  const rows = Array.from({ length: 100 }, (_, i) => record('twitter', String(100 - i), { response: i === 90 ? 'Needle preview' : 'Other stored answer', ...(i === 90 ? { truncated: true, warnings: ['payload_truncated'] } : {}) }))
  const data = observation({ records: rows, sources: {
    twitter: source({ returned_count: 100, has_more: true, coverage: 'partial', warnings: ['row_limit', 'record_warnings'] }),
    reddit: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }),
  } })
  const { h, calls } = await accepted(t, path, 'en', data)
  const originalSummary = ['twitter', 'reddit'].map(platform => sourceSummary(h, platform))
  const availability = h.text(h.byId('interviews-availability'))
  await h.input('interviews-search', 'needle')
  assert.deepEqual(ids(h), ['interview-row-twitter:10'])
  assert.deepEqual(counts(h), [1, 100])
  assert.match(h.text(h.byId('interview-row-twitter:10')), /truncated/i)
  assert.match(h.text(h.byId('interviews-search-note')), /stored|accepted/i)
  assert.match(h.text(h.byId('interviews-search-note')), /missing|unavailable/i)
  assert.match(h.text(h.byId('interviews-search-note')), /truncat/i)
  for (const term of ['not present anywhere', 'needle']) {
    await h.input('interviews-search', term)
    assert.deepEqual(['twitter', 'reddit'].map(platform => sourceSummary(h, platform)), originalSummary)
    assert.equal(h.text(h.byId('interviews-availability')), availability)
    await h.click('interviews-download')
    assert.equal(await h.downloads.at(-1).blob.text(), JSON.stringify(data, null, 2) + '\n', 'filtering must never create a partial observation export')
  }
  await h.click('interviews-questions-mode')
  assert.deepEqual(ids(h), [], 'payload-truncated prompts remain ungrouped even when the record matches')
  assert.match(h.text(h.byId('interviews-question-ungrouped')), /1/)
  assert.match(h.text(h.byId('interviews-question-counts-twitter')), /99/)
  assert.deepEqual(counts(h), [0, 99])
  await h.click('interviews-download')
  assert.equal(await h.downloads.at(-1).blob.text(), JSON.stringify(data, null, 2) + '\n')
  assertRequests(calls, path)
  assert.deepEqual(h.warnings, [])
})

test('retained search, clear, mode, group and page controls cannot change later query or page state', async t => {
  const { h, calls } = await accepted(t)
  const emptyControls = retained(h)
  await h.input('interviews-search', 'response')
  await invoke(emptyControls, 'needle')
  assert.equal(query(h), 'response')
  assert.equal(ids(h)[0], 'interview-row-twitter:100')
  const oldQueryControls = retained(h)
  await h.click('interviews-next')
  await invoke(oldQueryControls, 'needle')
  assert.equal(query(h), 'response')
  assert.equal(ids(h)[0], 'interview-row-twitter:75')
  const oldPageControls = retained(h)
  await h.click('interviews-questions-mode')
  const oldGroup = h.byId('interviews-question-select').props.onChange
  const oldGroupControls = retained(h)
  await h.input('interviews-search', 'needle')
  oldGroup(event(options(h)[1].props.value))
  await invoke([...oldPageControls, ...oldGroupControls], 'no matches')
  assert.equal(query(h), 'needle')
  assert.equal(h.text(h.byId('interviews-question-prompt')), 'First question')
  assert.deepEqual(ids(h), ['interview-row-twitter:71'])
  const beforeClear = retained(h)
  await h.click('interviews-search-clear')
  await invoke(beforeClear, 'stale')
  assert.equal(query(h), '')
  assert.equal(h.text(h.byId('interviews-question-prompt')), 'First question')
  assert.equal(ids(h)[0], 'interview-row-twitter:100')
  assertRequests(calls, livePath)
  assert.deepEqual(h.warnings, [])
})

test('refresh, failed replacement and API filter changes retire query with the accepted observation', async t => {
  const { h, calls } = await accepted(t)
  await h.input('interviews-search', 'needle')
  const oldControls = retained(h)
  await h.click('interviews-refresh')
  assert.equal(Boolean(h.byId('interviews-search')), false)
  await invoke(oldControls)
  calls.getSavedInterviews[1].reject(new Error('PRIVATE_REFRESH_FAILURE')); await flush()
  assert.ok(h.byId('interviews-error'))
  assert.equal(Boolean(h.byId('interviews-search')), false)
  await h.click('interviews-refresh')
  const replacement = severalPages()
  replacement.records.forEach(row => { row.response = 'Newly accepted answer' })
  await resolve(calls.getSavedInterviews[2], replacement)
  await invoke(oldControls, 'needle')
  assert.equal(query(h), '')
  assert.deepEqual(counts(h), [64, 64])
  await h.input('interviews-search', 'Newly accepted')
  await h.input('interviews-agent-id', '0')
  assert.equal(Boolean(h.byId('interviews-search')), false)
  await h.click('interviews-apply')
  await resolve(calls.getSavedInterviews[3], { ...replacement, filters: { platform: null, agent_id: '0' } })
  assert.equal(query(h), '')
  assert.deepEqual(counts(h), [64, 64])
  assertRequests(calls, livePath, 4)
  assert.doesNotMatch(h.text(), /PRIVATE_REFRESH_FAILURE/)
  assert.deepEqual(h.warnings, [])
})

test('pending, cancelled and failed native file previews preserve accepted query while new acceptance resets it', async t => {
  const { h, calls } = await accepted(t, filePath)
  await h.input('interviews-search', 'needle')
  await h.click('interviews-questions-mode')
  const oldControls = retained(h)
  const pending = deferredFile(observation({ simulation_id: 'pending_file' }))
  await choose(h, [pending.value])
  assert.ok(h.byId('interviews-file-loading'))
  assert.equal(query(h), 'needle')
  assert.deepEqual(ids(h), ['interview-row-twitter:71'])
  await invoke(oldControls)
  assert.equal(query(h), 'needle')
  await h.input('interviews-search', 'response')
  await h.click('interviews-next')
  assert.equal(ids(h).length, 7)
  await h.click('interviews-file-cancel')
  pending.complete(); await flush()
  assert.equal(Boolean(h.byId('interviews-file-preview')), false)
  assert.equal(query(h), 'response')
  assert.equal(ids(h).length, 7)
  const failing = deferredFile(observation())
  await choose(h, [failing.value]); failing.reject(new Error('PRIVATE_FILE_READ_FAILURE')); await flush()
  assert.ok(h.byId('interviews-file-error'))
  assert.equal(query(h), 'response')
  assert.equal(ids(h).length, 7)
  await choose(h, [new File(['PRIVATE_INVALID_JSON'], 'invalid.json')])
  assert.ok(h.byId('interviews-file-error'))
  assert.equal(query(h), 'response')
  await choose(h, [])
  assert.equal(query(h), 'response')
  const replacement = observation({ records: [record('twitter', '9', { prompt: 'New question', response: 'New observation' })] })
  await choose(h, [file(replacement, 'new.json')])
  const staleOpen = h.byId('interviews-file-open').props.onClick
  await h.click('interviews-file-cancel')
  staleOpen(event()); await flush()
  assert.equal(query(h), 'response')
  await choose(h, [file(replacement, 'new.json')])
  const beforeAcceptance = retained(h)
  await h.click('interviews-file-open')
  await invoke(beforeAcceptance)
  assert.equal(query(h), '')
  assert.deepEqual(counts(h), [1, 1])
  assert.deepEqual(ids(h), ['interview-row-twitter:9'])
  assert.equal(h.byId('interviews-records-mode').props['aria-pressed'], true)
  await h.input('interviews-search', 'no match')
  await h.click('interviews-download')
  assert.equal(await h.downloads.at(-1).blob.text(), JSON.stringify(replacement, null, 2) + '\n')
  const beforeClear = retained(h)
  await h.click('interviews-file-clear')
  await invoke(beforeClear)
  assert.equal(Boolean(h.byId('interviews-search')), false)
  await open(h, replacement)
  assert.equal(query(h), '')
  assertRequests(calls, filePath)
  assert.doesNotMatch(h.text(), /PRIVATE_FILE_READ_FAILURE|PRIVATE_INVALID_JSON/)
  assert.deepEqual(h.warnings, [])
})

test('late file success cannot resurrect the older search after a newer file is accepted', async t => {
  const { h, calls } = await accepted(t, filePath)
  await h.input('interviews-search', 'needle')
  const old = deferredFile(severalPages(), 'old.json')
  await choose(h, [old.value])
  const replacement = observation({ simulation_id: 'latest_file', records: [record('reddit', '7', { response: 'Latest searchable answer' })] })
  await open(h, replacement, 'latest.json')
  assert.equal(query(h), '')
  await h.input('interviews-search', 'Latest')
  old.complete(); await flush()
  assert.equal(query(h), 'Latest')
  assert.deepEqual(counts(h), [1, 1])
  assert.deepEqual(ids(h), ['interview-row-reddit:7'])
  assert.equal(Boolean(h.byId('interviews-file-preview')), false)
  assertRequests(calls, filePath)
  assert.deepEqual(h.warnings, [])
})

test('A to file to A, Back, Forward and unmount retire exact search ownership', async t => {
  const { h, calls, data } = await accepted(t)
  await h.input('interviews-search', 'needle')
  const fromA = retained(h)
  await h.navigate(filePath)
  assert.equal(Boolean(h.byId('interviews-search')), false)
  await open(h, data)
  assert.equal(query(h), '')
  await h.input('interviews-search', 'First question')
  const fromFile = retained(h)
  await invoke(fromA)
  assert.equal(query(h), 'First question')
  await h.navigate(livePath)
  await resolve(calls.getSavedInterviews[1], data)
  await invoke([...fromA, ...fromFile])
  assert.equal(query(h), '')
  await h.input('interviews-search', 'response')
  await h.back()
  assert.equal(h.router.currentRoute.value.fullPath, filePath)
  assert.equal(Boolean(h.byId('interviews-search')), false)
  await open(h, data)
  assert.equal(query(h), '')
  await h.input('interviews-search', 'needle')
  await h.forward()
  await resolve(calls.getSavedInterviews[2], data)
  assert.equal(query(h), '')
  const beforeUnmount = retained(h)
  let valueReads = 0
  const readAfterUnmount = { target: { get value() { valueReads++; return 'stale' } } }
  h.unmount()
  beforeUnmount[0](readAfterUnmount)
  await invoke([...beforeUnmount.slice(1), ...fromA, ...fromFile])
  assert.equal(valueReads, 0)
  assert.equal(h.root.children.length, 0)
  assert.equal(calls.getSavedInterviews[2].signal.aborted, true)
  assertRequests(calls, livePath, 3)
  assert.deepEqual(h.warnings, [])
})

test('search reads input exactly once, rejects coercion and rechecks presentation ownership after that read', async t => {
  const { h, calls } = await accepted(t)
  await h.input('interviews-search', 'response')
  const currentInput = search(h).props.onInput
  let reads = 0, conversions = 0
  for (const value of [undefined, null, 7, false, [], { toString() { conversions++; return 'needle' } }]) {
    currentInput({ target: { get value() { reads++; return value } } }); await flush()
    assert.equal(query(h), 'response')
    assert.deepEqual(counts(h), [64, 64])
  }
  assert.equal(reads, 6)
  assert.equal(conversions, 0)
  let reentrantReads = 0
  currentInput({ target: { get value() {
    reentrantReads++
    h.byId('interviews-next').props.onClick(event())
    return 'needle'
  } } }); await flush()
  assert.equal(reentrantReads, 1)
  assert.equal(query(h), 'response', 'an input read that changes the page must retire the outer search callback')
  assert.equal(ids(h)[0], 'interview-row-twitter:75')
  const outer = search(h).props.onInput
  outer({ target: { get value() {
    search(h).props.onInput(event('needle'))
    return 'discarded outer query'
  } } }); await flush()
  assert.equal(query(h), 'needle')
  assert.deepEqual(ids(h), ['interview-row-twitter:71', 'interview-row-reddit:71'])
  assertRequests(calls, livePath)
  assert.deepEqual(h.warnings, [])
})
