import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { mountWorkflow, deferredApi, observation, record, source, resolve, flush } from './helpers/saved-interview-comparison-workflow-fixture.js'
import { readSavedInterviewFile, SAVED_INTERVIEW_FILE_MAX_BYTES } from '../src/utils/savedInterviewFiles.js'

// Actual compiled scripts/templates/router and production strict parser. The
// saved API response and download host are synthetic boundaries, not Flask,
// SQLite, Axios transport, native browser, or standalone offline-app coverage.
const comparePath = '/interview-files/compare', filePath = '/interview-files'
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const file = (data, name = 'saved.json') => new File([JSON.stringify(data)], name, { type: 'application/json' })
async function choose(h, value, selector = 'interview-compare-file-input') {
  const target = { files: value ? [value] : [], value: 'selected' }
  const control = h.byId(selector); assert.ok(control, `missing native file admission control ${selector}`)
  control.props.onChange({ target }); await flush(); assert.equal(target.value, '')
}
async function accept(h, data, side, name = `${side}.json`) {
  await choose(h, data instanceof File ? data : file(data, name))
  assert.ok(h.byId('interview-compare-preview'), 'strict file admission must produce a pending preview')
  await h.click(`interview-compare-accept-${side}`)
}
async function state(t, path = comparePath, locale = 'en', downloadHooks = {}) {
  const d = deferredApi(), h = await mountWorkflow({ api: d.api, initialPath: path, locale, downloadHooks })
  t.after(() => h.unmount()); return { h, ...d }
}
async function exported(h, calls, data) {
  const query = new URLSearchParams(Object.entries(data.filters).filter(([, value]) => value !== null)).toString()
  await h.navigate(`/simulation/${data.simulation_id}/interviews${query ? '?' + query : ''}`)
  await resolve(calls.getSavedInterviews.at(-1), data)
  await h.click('interviews-download')
  const download = h.downloads.at(-1), bytes = await download.blob.arrayBuffer()
  assert.equal(new TextDecoder().decode(bytes), JSON.stringify(data, null, 2) + '\n')
  const value = new File([bytes], download.filename, { type: 'application/json' })
  assert.deepEqual(await readSavedInterviewFile(value), data)
  return value
}
const ids = (h, side) => h.all(n => String(n.props['data-testid'] ?? '').startsWith(`interview-compare-row-${side}-`)).map(n => n.props['data-testid'])
const options = h => h.byId('interview-compare-question-select').children.filter(n => n.type === 'option')
const counts = (h, side) => [...h.text(h.byId(`interview-compare-${side}-search-count`)).matchAll(/\d+/g)].map(match => Number(match[0]))
const query = (h, side) => h.byId(`interview-compare-${side}-search`).props.value
const prompt = h => h.text(h.byId('interview-compare-prompt'))
function noLocalRequests(h, calls, expected = 0) {
  assert.equal(calls.getSavedInterviews.length, expected, 'no comparison action may request another saved observation')
  assert.equal(calls.getSimulationHistory.length, 0, 'no comparison action may request simulation history')
  assert.deepEqual(h.forbiddenCalls, [], 'the compiled comparison must not touch network or browser persistence')
  assert.deepEqual(h.warnings, [])
}
async function downloadEquals(h, side, data) {
  await h.click(`interview-compare-${side}-download`)
  const actual = h.downloads.at(-1)
  assert.equal(await actual.blob.text(), JSON.stringify(data, null, 2) + '\n', 'a side download must retain its full bare observation, including hidden and ungrouped rows')
  assert.deepEqual(await readSavedInterviewFile(new File([await actual.blob.arrayBuffer()], actual.filename)), data)
  return actual
}
const maxRow = 9223372036854775807n, repeatedAgent = '9007199254740993'
function rows(platform, count, build) {
  return Array.from({ length: count }, (_, i) => record(platform, String(maxRow - BigInt(i)), { agent_id: repeatedAgent, ...build(i) }))
}
const shared = '[Context: saved observation]\n  café 🐟\u0000 <script>literal [a.*]</script>  '
const longPrefix = 'full literal prompt '.repeat(80)
function pairData() {
  const distinct = ['__proto__', 'constructor', 'toString', '', ' Same ', 'Same', 'same', 'café', 'cafe\u0301', '[Context A] Same', '[Context B] Same', longPrefix + 'left ending']
  const left = observation({ simulation_id: 'left_observation', observed_at: '2026-10-01T01:02:03Z', records: [
    ...rows('twitter', 27, i => ({ prompt: shared, response: `left answer ${i}${i === 26 ? ' Needle [a.*]' : ''}`, ...(i === 0 ? { truncated: true, warnings: ['timestamp_truncated'] } : {}) })),
    ...rows('reddit', distinct.length + 4, i => i < distinct.length ? { prompt: distinct[i], response: `left distinct ${i}` }
      : i === distinct.length ? { prompt: null, warnings: ['missing_prompt'] }
      : i === distinct.length + 1 ? { prompt: null, response: null, payload_kind: 'raw', raw_preview: '<img onerror=literal> Needle raw', warnings: ['invalid_json'] }
      : i === distinct.length + 2 ? { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }
      : { prompt: shared, response: 'Incomplete prompt Needle', truncated: true, warnings: ['payload_truncated'] }),
  ] })
  left.sources.reddit = source({ status: 'query_limited', returned_count: left.records.filter(r => r.platform === 'reddit').length, has_more: null, coverage: 'partial', warnings: ['query_limited', 'record_warnings'] })
  const rightDistinct = [longPrefix + 'right ending', 'constructor', 'RIGHT only', ' Same ', '']
  const right = observation({ simulation_id: 'right_observation', observed_at: '2026-10-02T03:04:05Z', records: [
    ...rows('twitter', rightDistinct.length, i => ({ prompt: rightDistinct[i], response: `right distinct ${i}` })),
    ...rows('reddit', 31, i => ({ prompt: shared, response: `right answer ${i}${i === 30 ? ' Needle [a.*]' : ''}` })),
  ] })
  right.sources.twitter = source({ returned_count: rightDistinct.length, has_more: true, coverage: 'partial', warnings: ['response_limit'] })
  right.availability = 'partial'
  return { left, right, expectedPrompts: [shared, ...distinct, ...rightDistinct.filter(value => !distinct.includes(value))] }
}
async function acceptedPair(t, locale = 'en', downloadHooks = {}) {
  const current = await state(t, comparePath, locale, downloadHooks), data = pairData()
  await accept(current.h, data.left, 'left', 'left saved.json')
  await accept(current.h, data.right, 'right', 'right saved.json')
  return { ...current, ...data }
}
function callbacks(h, side) {
  return ['search', 'search-clear', 'first', 'previous', 'next', 'download', 'clear'].map(name => h.byId(`interview-compare-${side}-${name}`)?.props[name === 'search' ? 'onInput' : 'onClick']).filter(Boolean)
}
async function invoke(actions, value = 'retired Needle') {
  for (const callback of actions) callback(event(value))
  await flush()
}
function deferredFile(data, name = 'pending.json') {
  let complete, reject
  const pending = new Promise((yes, no) => { complete = yes; reject = no })
  const value = file(data, name)
  value.arrayBuffer = () => pending
  return { value, reject, complete: () => complete(new TextEncoder().encode(JSON.stringify(data)).buffer) }
}

test('the actual saved API reader exports unchanged bytes and links to the dedicated comparison route', async t => {
  const { h, calls } = await state(t, filePath)
  const data = observation({ simulation_id: 'export_contract', records: [record('twitter', '9223372036854775807')] })
  const value = await exported(h, calls, data)
  assert.ok(value.size > 0)
  assert.equal(calls.getSavedInterviews.length, 1)
  assert.ok(h.byId('interviews-compare-link'), 'an accepted existing saved reader needs its comparison entry')
  await h.click('interviews-compare-link')
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviewComparison')
  await accept(h, value, 'left')
  assert.ok(h.text(h.byId('interview-compare-left-side')).includes('export_contract'))
  assert.equal(calls.getSavedInterviews.length, 1, 'local comparison admission must never fetch a new observation')
  assert.deepEqual(h.forbiddenCalls, [])
})

test('a fresh comparison route mounts its own compiled file admission without an API request', async t => {
  const { h, calls } = await state(t)
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviewComparison', 'the production router must own the dedicated comparison URL')
  assert.ok(h.byId('interview-compare-file-input'))
  assert.ok(h.byId('interview-compare-reader-link'))
  assert.equal(calls.getSavedInterviews.length, 0)
  assert.equal(calls.getSimulationHistory.length, 0)
  assert.deepEqual(h.forbiddenCalls, [])
})

for (const locale of ['en', 'zh']) test(`two actual API-reader exports align full prompts, preserve provenance, and round-trip unchanged side files in ${locale}`, async t => {
  const { h, calls } = await state(t, filePath, locale), { left, right, expectedPrompts } = pairData()
  const originals = [JSON.stringify(left), JSON.stringify(right)]
  const leftFile = await exported(h, calls, left), rightFile = await exported(h, calls, right)
  assert.equal(calls.getSavedInterviews.length, 2)
  await h.click('interviews-compare-link')
  await accept(h, leftFile, 'left'); await accept(h, rightFile, 'right')
  const leftSide = h.text(h.byId('interview-compare-left-side')), rightSide = h.text(h.byId('interview-compare-right-side'))
  for (const [text, data, value] of [[leftSide, left, leftFile], [rightSide, right, rightFile]]) {
    assert.ok(text.includes(data.simulation_id))
    assert.ok(text.includes(data.observed_at))
    assert.ok(text.includes(value.name))
  }
  const optionValues = options(h).map(option => option.props.value)
  const actualPrompts = []
  for (const key of optionValues) { await h.change('interview-compare-question-select', key); actualPrompts.push(prompt(h)) }
  assert.deepEqual(actualPrompts, expectedPrompts, 'union must use exact complete strings, with deterministic left-first order')
  await h.change('interview-compare-question-select', optionValues[0])
  assert.equal(prompt(h), shared)
  assert.deepEqual(counts(h, 'left'), [27, 27]); assert.deepEqual(counts(h, 'right'), [31, 31])
  assert.deepEqual([...h.text(h.byId('interview-compare-left-counts')).matchAll(/\d+/g)].map(match => Number(match[0])), [27, 0])
  assert.deepEqual([...h.text(h.byId('interview-compare-right-counts')).matchAll(/\d+/g)].map(match => Number(match[0])), [0, 31])
  assert.equal(ids(h, 'left').length, 25); assert.equal(ids(h, 'right').length, 25)
  assert.ok(h.text().includes(repeatedAgent)); assert.ok(h.text().includes(String(maxRow)))
  assert.equal(h.all(n => ['script', 'img', 'iframe'].includes(n.type) || n.props.innerHTML).length, 0)
  const summaries = ['left', 'right'].flatMap(side => ['twitter', 'reddit'].map(platform => h.text(h.byId(`interview-compare-${side}-source-${platform}`))))
  for (const [side, data] of [['left', left], ['right', right]]) for (const platform of ['twitter', 'reddit']) {
    const status = h.text(h.byId(`interview-compare-${side}-source-${platform}`)), facts = data.sources[platform]
    assert.ok(status.includes(h.i18n.global.t(`savedInterviewFiles.statuses.${facts.status}`)))
    assert.ok(status.includes(h.i18n.global.t(`savedInterviewFiles.coverage.${facts.coverage}`)))
    assert.ok(status.includes(String(facts.returned_count)))
    const extraRecords = h.i18n.global.t(`savedInterviewComparison.${facts.has_more === null ? 'unknown' : facts.has_more ? 'yes' : 'no'}`)
    assert.ok(status.includes(h.i18n.global.t('savedInterviewComparison.hasMore', { value: extraRecords })))
    for (const warning of facts.warnings) assert.ok(status.includes(warning), `source warning code ${warning} stays visible`)
  }
  await h.click('interview-compare-left-next')
  assert.equal(ids(h, 'left').length, 2); assert.equal(ids(h, 'right').length, 25)
  await h.click('interview-compare-right-next')
  assert.equal(ids(h, 'right').length, 6); assert.equal(ids(h, 'left').length, 2)
  await h.input('interview-compare-left-search', 'nEeDlE [A.*]')
  assert.deepEqual(counts(h, 'left'), [1, 27]); assert.deepEqual(counts(h, 'right'), [31, 31])
  assert.equal(ids(h, 'left')[0], `interview-compare-row-left-twitter:${maxRow - 26n}`)
  assert.equal(ids(h, 'right').length, 6); assert.equal(query(h, 'right'), '')
  await h.input('interview-compare-right-search', 'NO saved answer matches')
  assert.deepEqual(ids(h, 'right'), []); assert.deepEqual(counts(h, 'right'), [0, 31])
  assert.deepEqual(counts(h, 'left'), [1, 27])
  assert.deepEqual(['left', 'right'].flatMap(side => ['twitter', 'reddit'].map(platform => h.text(h.byId(`interview-compare-${side}-source-${platform}`)))), summaries)
  await downloadEquals(h, 'left', left); await downloadEquals(h, 'right', right)
  assert.deepEqual([JSON.stringify(left), JSON.stringify(right)], originals, 'the transport-owned original records must remain untouched')
  await h.click('interview-compare-left-search-clear'); await h.click('interview-compare-right-search-clear')
  assert.deepEqual(counts(h, 'left'), [27, 27]); assert.deepEqual(counts(h, 'right'), [31, 31])
  assert.equal(ids(h, 'left').length, 25); assert.equal(ids(h, 'right').length, 25)
  assert.doesNotMatch(h.text(), /savedInterviewComparison\.|savedInterviewFiles\.|savedInterviews\./)
  noLocalRequests(h, calls, 2)
})

test('literal empty, prototype-key, whitespace, Unicode and context variants align without matching local question keys', async t => {
  const { h, calls, expectedPrompts } = await acceptedPair(t)
  const keys = options(h).map(option => option.props.value)
  for (let i = 0; i < expectedPrompts.length; i++) {
    await h.change('interview-compare-question-select', keys[i])
    assert.equal(prompt(h), expectedPrompts[i])
    const expectedLeft = i === 0 ? 27 : i < 13 ? 1 : 0
    const expectedRight = i === 0 ? 31 : ['constructor', ' Same ', '', longPrefix + 'right ending', 'RIGHT only'].includes(expectedPrompts[i]) ? 1 : 0
    assert.deepEqual(counts(h, 'left'), [expectedLeft, expectedLeft])
    assert.deepEqual(counts(h, 'right'), [expectedRight, expectedRight])
  }
  const ungrouped = h.text(h.byId('interview-compare-left-ungrouped'))
  assert.match(ungrouped, /4/, 'all four incomplete/raw/missing prompt rows must remain explicitly ungrouped')
  for (const reason of ['missing_prompt', 'invalid_json', 'missing_payload', 'payload_truncated']) assert.ok(ungrouped.includes(reason), `ungrouped reason ${reason} remains available`)
  assert.equal(h.all(n => String(n.props['data-testid'] ?? '').startsWith('interview-compare-row-')).some(n => h.text(n).includes('Incomplete prompt')), false)
  noLocalRequests(h, calls)
})

test('a locale switch retains both accepted observations, selection and independent page/search state with associated labels', async t => {
  const { h, calls } = await acceptedPair(t)
  for (const side of ['left', 'right']) {
    const input = h.byId(`interview-compare-${side}-search`)
    assert.equal(input.props.type, 'search')
    assert.ok(h.find(n => n.type === 'label' && n.props.for === input.props.id && h.text(n).trim()))
  }
  await h.click('interview-compare-left-next'); await h.input('interview-compare-right-search', 'Needle')
  const before = [ids(h, 'left'), ids(h, 'right'), prompt(h), query(h, 'left'), query(h, 'right')]
  const language = h.byId('interview-compare-language')
  assert.ok(language, 'comparison needs its own session-only language control')
  assert.ok(language.parent?.type === 'label' && h.text(language.parent).trim()
    || language.props.id && h.find(n => n.type === 'label' && n.props.for === language.props.id && h.text(n).trim()))
  await h.change('interview-compare-language', 'zh')
  assert.equal(h.i18n.global.locale.value, 'zh')
  assert.deepEqual([ids(h, 'left'), ids(h, 'right'), prompt(h), query(h, 'left'), query(h, 'right')], before)
  assert.doesNotMatch(h.text(), /savedInterviewComparison\.|savedInterviewFiles\.|savedInterviews\./)
  assert.match(h.text(h.byId('interview-compare-left-side')), /[\u3400-\u9fff]/)
  await h.change('interview-compare-language', 'en')
  assert.equal(h.i18n.global.locale.value, 'en')
  assert.deepEqual([ids(h, 'left'), ids(h, 'right'), prompt(h), query(h, 'left'), query(h, 'right')], before)
  noLocalRequests(h, calls)
})

test('strict parser freezes full accepted records and comparison admits two independent 200-record observations with 400 exact prompts', async t => {
  const { h, calls } = await state(t)
  const data = name => observation({ simulation_id: name, records: ['twitter', 'reddit'].flatMap(platform => rows(platform, 100, i => ({ prompt: `${name}:${platform}:${i}`, response: `saved ${i}` }))) })
  const left = data('bounded_left'), right = data('bounded_right')
  const admitted = await readSavedInterviewFile(file(left))
  assert.ok(Object.isFrozen(admitted)); assert.ok(Object.isFrozen(admitted.records)); assert.ok(Object.isFrozen(admitted.records[0])); assert.ok(Object.isFrozen(admitted.sources.twitter.warnings))
  assert.throws(() => { admitted.records[0].prompt = 'changed' }, TypeError)
  const { buildSavedInterviewComparison } = await import('../src/utils/savedInterviewComparison.js')
  const pair = buildSavedInterviewComparison(admitted, await readSavedInterviewFile(file(right)))
  assert.equal(pair.groups.length, 400)
  assert.equal(pair.groups[0].left.records[0], admitted.records[0], 'grouping must retain every original record identity')
  assert.equal(pair.groups[0].right.records.length, 0)
  assert.equal(new Set(pair.groups.map(group => group.key)).size, 400)
  await accept(h, left, 'left'); await accept(h, right, 'right')
  assert.equal(options(h).length, 400)
  await downloadEquals(h, 'left', left); await downloadEquals(h, 'right', right)
  const excessive = data('over_limit')
  excessive.records.push(record('reddit', '-1', { prompt: '201st' })); excessive.sources.reddit.returned_count++
  await choose(h, file(excessive, 'too-many.json'))
  assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  assert.ok(h.byId('interview-compare-error'))
  await downloadEquals(h, 'left', left); await downloadEquals(h, 'right', right)
  noLocalRequests(h, calls)
})

test('the unchanged 8 MiB file limit admits padded bare observations and rejects larger files before reading', async t => {
  const { h, calls } = await state(t), data = observation({ simulation_id: 'file_limit' })
  const json = JSON.stringify(data), padded = new File([json, ' '.repeat(SAVED_INTERVIEW_FILE_MAX_BYTES - Buffer.byteLength(json))], 'exact-limit.json')
  assert.equal(padded.size, SAVED_INTERVIEW_FILE_MAX_BYTES)
  await accept(h, padded, 'left')
  const tooLarge = new File([' '.repeat(SAVED_INTERVIEW_FILE_MAX_BYTES + 1)], 'over-limit.json')
  let reads = 0; tooLarge.arrayBuffer = async () => { reads++; throw new Error('PRIVATE_OVER_LIMIT_READ') }
  await choose(h, tooLarge)
  assert.equal(reads, 0); assert.ok(h.byId('interview-compare-error'))
  assert.doesNotMatch(h.text(), /PRIVATE_OVER_LIMIT_READ/)
  await downloadEquals(h, 'left', data)
  noLocalRequests(h, calls)
})

for (const status of ['missing', 'unreadable', 'too_large', 'query_limited']) test(`a ${status} source remains visible and downloadable while an absent group never asserts the run had no interview`, async t => {
  const { h, calls } = await state(t)
  const warning = { missing: 'source_missing', unreadable: 'source_unreadable', too_large: 'database_too_large', query_limited: 'query_limited' }[status]
  const left = observation({ simulation_id: 'observed_left', records: [record('twitter', '1', { prompt: shared })], sources: {
    twitter: source({ returned_count: 1 }), reddit: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }),
  } })
  const right = observation({ simulation_id: 'observed_empty', records: [] })
  await accept(h, left, 'left'); await accept(h, right, 'right')
  assert.deepEqual(counts(h, 'left'), [1, 1]); assert.deepEqual(counts(h, 'right'), [0, 0])
  assert.ok(h.text(h.byId('interview-compare-left-source-reddit')).trim())
  assert.match(h.text(h.byId('interview-compare-right-side')), /admitted|observation|qualifying|stored/i)
  const before = h.text(h.byId('interview-compare-left-source-reddit'))
  await h.input('interview-compare-left-search', 'does not occur')
  assert.equal(h.text(h.byId('interview-compare-left-source-reddit')), before)
  await downloadEquals(h, 'left', left); await downloadEquals(h, 'right', right)
  noLocalRequests(h, calls)
})

test('filtered metadata and a not-requested platform survive comparison without being treated as an empty queried source', async t => {
  const { h, calls } = await state(t)
  const left = observation({ simulation_id: 'filtered', filters: { platform: 'twitter', agent_id: repeatedAgent }, records: [record('twitter', '7', { agent_id: repeatedAgent, prompt: shared })] })
  const right = observation({ simulation_id: 'unavailable', records: [], sources: {
    twitter: source({ status: 'unreadable', has_more: null, coverage: 'unavailable', warnings: ['source_unreadable'] }),
    reddit: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }),
  } })
  await accept(h, left, 'left', 'filters.json'); await accept(h, right, 'right', 'unavailable.json')
  assert.ok(h.text(h.byId('interview-compare-left-side')).includes(repeatedAgent))
  assert.match(h.text(h.byId('interview-compare-left-source-reddit')), /not requested/i)
  assert.equal(ids(h, 'right').length, 0)
  await downloadEquals(h, 'left', left); await downloadEquals(h, 'right', right)
  noLocalRequests(h, calls)
})

test('search and page callbacks captured before later local presentation cannot alter the accepted current side state', async t => {
  const { h, calls } = await acceptedPair(t)
  const initial = callbacks(h, 'left')
  await h.click('interview-compare-left-next')
  // Clear and download belong to the observation rather than presentation.
  // Exercise just the stale presentation controls here; side controls are
  // exercised after replacement in the separate ownership test below.
  await invoke(initial.slice(0, 5), 'Needle')
  assert.equal(query(h, 'left'), ''); assert.equal(ids(h, 'left').length, 2)
  const oldPage = callbacks(h, 'left').slice(0, 5)
  await h.input('interview-compare-left-search', 'Needle')
  await invoke(oldPage, 'no match')
  assert.equal(query(h, 'left'), 'Needle'); assert.deepEqual(counts(h, 'left'), [1, 27])
  assert.deepEqual(counts(h, 'right'), [31, 31]); assert.equal(ids(h, 'right').length, 25)
  noLocalRequests(h, calls)
})

test('invalid, cancelled and stale file reads preserve the pair and pending explicit acceptance owns only its current preview', async t => {
  const { h, calls, left, right } = await acceptedPair(t)
  await h.click('interview-compare-left-next'); await h.input('interview-compare-right-search', 'Needle')
  const original = [ids(h, 'left'), ids(h, 'right'), query(h, 'left'), query(h, 'right')]
  const old = deferredFile(observation({ simulation_id: 'old_preview' }), 'old.json')
  await choose(h, old.value)
  assert.deepEqual([ids(h, 'left'), ids(h, 'right'), query(h, 'left'), query(h, 'right')], original)
  await h.click('interview-compare-cancel'); old.complete(); await flush()
  assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  await choose(h, new File(['PRIVATE_INVALID_JSON'], 'bad.json'))
  assert.ok(h.byId('interview-compare-error')); assert.doesNotMatch(h.text(), /PRIVATE_INVALID_JSON/)
  assert.deepEqual([ids(h, 'left'), ids(h, 'right'), query(h, 'left'), query(h, 'right')], original)
  const failing = deferredFile(left)
  await choose(h, failing.value); failing.reject(new Error('PRIVATE_FILE_FAILURE')); await flush()
  assert.ok(h.byId('interview-compare-error')); assert.doesNotMatch(h.text(), /PRIVATE_FILE_FAILURE/)
  await choose(h, null)
  await choose(h, file(observation({ simulation_id: 'cancelled_preview' }), 'cancelled.json'))
  const cancelledAcceptance = h.byId('interview-compare-accept-left').props.onClick
  await h.click('interview-compare-cancel'); await invoke([cancelledAcceptance])
  assert.deepEqual([ids(h, 'left'), ids(h, 'right'), query(h, 'left'), query(h, 'right')], original)
  await downloadEquals(h, 'left', left); await downloadEquals(h, 'right', right)
  const slow = deferredFile(observation({ simulation_id: 'slow_preview' }), 'slow.json')
  await choose(h, slow.value)
  const replacement = observation({ simulation_id: 'latest', records: [record('reddit', '3', { prompt: shared, response: 'Latest answer' })] })
  await choose(h, file(replacement, 'latest.json'))
  const once = h.byId('interview-compare-accept-left').props.onClick
  await h.click('interview-compare-accept-left'); await invoke([once])
  slow.complete(); await flush()
  assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  await downloadEquals(h, 'left', replacement); await downloadEquals(h, 'right', right)
  noLocalRequests(h, calls)
})

test('replacement, swap and clear retire old side and pair callbacks without changing or resurrecting a newer observation', async t => {
  const { h, calls, left, right } = await acceptedPair(t)
  const stale = [...callbacks(h, 'left'), ...callbacks(h, 'right'), h.byId('interview-compare-swap').props.onClick, h.byId('interview-compare-clear-both').props.onClick, h.byId('interview-compare-question-select').props.onChange]
  const replacement = observation({ simulation_id: 'replacement', records: [record('twitter', '8', { prompt: shared, response: 'Replacement answer' })] })
  await accept(h, replacement, 'left', 'replacement.json'); await invoke(stale)
  assert.equal(query(h, 'left'), ''); assert.deepEqual(counts(h, 'left'), [1, 1]); assert.deepEqual(counts(h, 'right'), [31, 31])
  assert.equal(h.downloads.length, 0, 'retained old side download must not export the replacement')
  await downloadEquals(h, 'left', replacement); await downloadEquals(h, 'right', right)
  const beforeSwap = [...callbacks(h, 'left'), ...callbacks(h, 'right')]
  await h.click('interview-compare-swap'); await invoke(beforeSwap)
  await downloadEquals(h, 'left', right); await downloadEquals(h, 'right', replacement)
  const beforeClear = [...callbacks(h, 'left'), ...callbacks(h, 'right')]
  await h.click('interview-compare-right-clear'); await invoke(beforeClear)
  assert.equal(Boolean(h.byId('interview-compare-right-side')), false)
  await downloadEquals(h, 'left', right)
  const beforeBoth = [...callbacks(h, 'left'), h.byId('interview-compare-clear-both').props.onClick]
  await h.click('interview-compare-clear-both'); await invoke(beforeBoth)
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false); assert.equal(Boolean(h.byId('interview-compare-right-side')), false)
  assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  await accept(h, left, 'left'); assert.deepEqual(counts(h, 'left'), [27, 27])
  noLocalRequests(h, calls)
})

for (const step of ['blob', 'url', 'element', 'append', 'click']) test(`clearing one source reentrantly during download ${step} retires only the old export and preserves the opposite source`, async t => {
  const hooks = {}, { h, calls, right } = await acceptedPair(t, 'en', hooks)
  const clear = h.byId('interview-compare-left-clear').props.onClick
  hooks[step] = () => { delete hooks[step]; clear(event()); throw new Error('PRIVATE_RETIRED_EXPORT') }
  await h.click('interview-compare-left-download')
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  assert.equal(h.downloads.length, 0)
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.doesNotMatch(h.text(), /PRIVATE_RETIRED_EXPORT/)
  await downloadEquals(h, 'right', right)
  noLocalRequests(h, calls)
})

for (const step of ['blob', 'url', 'element', 'append', 'click']) test(`a current opposite-side export started during download ${step} cannot be revoked by the failed older attempt`, async t => {
  const hooks = {}, { h, calls, left, right } = await acceptedPair(t, 'en', hooks)
  hooks[step] = () => {
    delete hooks[step]
    h.byId('interview-compare-right-download').props.onClick(event())
    throw new Error('PRIVATE_OLDER_EXPORT_FAILURE')
  }
  await h.click('interview-compare-left-download')
  assert.equal(h.downloads.length, 1)
  assert.equal(await h.downloads[0].blob.text(), JSON.stringify(right, null, 2) + '\n')
  assert.equal(h.revokedUrls.includes(h.downloads[0].url), false)
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.doesNotMatch(h.text(), /PRIVATE_OLDER_EXPORT_FAILURE/)
  await h.click('interview-compare-clear-both')
  assert.ok(h.revokedUrls.includes(h.downloads[0].url))
  assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), right)
  assert.equal(left.simulation_id, 'left_observation')
  noLocalRequests(h, calls)
})

test('a download triggered during prior URL revocation supersedes the outer download before resource allocation', async t => {
  const hooks = {}, { h, calls, left, right } = await acceptedPair(t, 'en', hooks)
  const initial = await downloadEquals(h, 'left', left)
  hooks.revoke = () => { delete hooks.revoke; h.byId('interview-compare-right-download').props.onClick(event()) }
  await h.click('interview-compare-left-download')
  assert.equal(h.downloads.length, 2)
  assert.deepEqual(h.revokedUrls, [initial.url])
  assert.equal(await h.downloads[1].blob.text(), JSON.stringify(right, null, 2) + '\n')
  h.unmount()
  assert.deepEqual(h.revokedUrls, [initial.url, h.downloads[1].url])
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
  noLocalRequests(h, calls)
})

for (const control of ['interview-compare-swap', 'interview-compare-left-clear', 'interview-compare-clear-both', 'interview-compare-accept-left', 'interview-compare-cancel', 'select']) test(`route change reentrancy during cleanup for ${control} retires pair, preview and the callback before it can republish old state`, async t => {
  const hooks = {}, { h, calls, left } = await acceptedPair(t, 'en', hooks)
  await choose(h, file(observation({ simulation_id: 'pending_route' }), 'pending-route.json'))
  await downloadEquals(h, 'left', left)
  hooks.revoke = () => { delete hooks.revoke; h.router.currentRoute.value = h.router.resolve(comparePath + '?new-session=1') }
  if (control === 'select') await choose(h, file(observation({ simulation_id: 'retired_preview' })))
  else await h.click(control)
  assert.equal(h.router.currentRoute.value.fullPath, comparePath + '?new-session=1')
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  assert.equal(Boolean(h.byId('interview-compare-right-side')), false)
  assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  assert.equal(Boolean(h.byId('interview-compare-loading')), false)
  assert.equal(Boolean(h.byId('interview-compare-error')), false)
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
  noLocalRequests(h, calls)
})

test('comparison→single reader→Back→Forward and route-query changes retain no comparison files, callbacks or downloads', async t => {
  const { h, calls, left } = await acceptedPair(t)
  const oldControls = [...callbacks(h, 'left'), ...callbacks(h, 'right')]
  const oldInput = h.byId('interview-compare-file-input').props.onChange
  const pending = deferredFile(observation({ simulation_id: 'late_route' }), 'late-route.json')
  await choose(h, pending.value)
  await downloadEquals(h, 'left', left)
  const priorUrl = h.downloads.at(-1).url
  await h.click('interview-compare-reader-link')
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviewFiles')
  assert.equal(Boolean(h.byId('interviews-results')), false)
  assert.ok(h.revokedUrls.includes(priorUrl))
  await invoke(oldControls); pending.complete(); await flush()
  await h.back()
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviewComparison')
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false); assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  let reads = 0
  const neverRead = file(left); neverRead.arrayBuffer = () => { reads++; throw new Error('PRIVATE_RETIRED_FILE_INPUT') }
  oldInput({ target: { files: [neverRead], value: 'stale' } }); await flush(); assert.equal(reads, 0)
  await accept(h, left, 'left')
  const routeControls = callbacks(h, 'left')
  await h.navigate(comparePath + '?query-session=2'); await invoke(routeControls)
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  await h.back(); assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  await h.forward(); assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  await h.navigate(filePath); await choose(h, file(left), 'interviews-file-input'); await h.click('interviews-file-open')
  await h.click('interviews-download')
  assert.equal(await h.downloads.at(-1).blob.text(), JSON.stringify(left, null, 2) + '\n', 'existing single-file reader export remains unchanged')
  await h.click('interviews-compare-link')
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  noLocalRequests(h, calls)
})

test('unmount retires pending reads, native file input, pair controls and active exported URLs', async t => {
  const { h, calls, left } = await acceptedPair(t)
  const retained = [...callbacks(h, 'left'), ...callbacks(h, 'right')], oldInput = h.byId('interview-compare-file-input').props.onChange
  const pending = deferredFile(observation({ simulation_id: 'unmounted_pending' }))
  await choose(h, pending.value); await downloadEquals(h, 'left', left)
  const priorUrl = h.downloads.at(-1).url
  h.unmount(); pending.complete(); await invoke(retained)
  let reads = 0
  const neverRead = file(left); neverRead.arrayBuffer = () => { reads++; return Promise.reject(new Error('PRIVATE_UNMOUNT_READ')) }
  oldInput({ target: { files: [neverRead], value: 'stale' } }); await flush()
  assert.equal(reads, 0); assert.equal(h.root.children.length, 0); assert.ok(h.revokedUrls.includes(priorUrl))
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
  noLocalRequests(h, calls)
})
