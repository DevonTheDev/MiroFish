import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import * as text from '../src/utils/savedInterviewText.js'
import { buildSavedInterviewQuestions } from '../src/utils/savedInterviewQuestions.js'
import { filterSavedInterviewRecords } from '../src/utils/savedInterviewSearch.js'
import { setup, resolve, observation, windowObservation, record, source, mountSavedInterviews, deferredApi, flush } from './helpers/saved-interviews-view-fixture.js'

const live = '/simulation/sim_A/interviews', local = '/interview-files'
const matches = 'interviews-download-matches-text', txt = 'interviews-download-text', json = 'interviews-download'
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const file = (data, name = 'accepted.json') => new File([JSON.stringify(data)], name, { type: 'application/json' })
const apiCounts = calls => [calls.getSavedInterviews.length, calls.getSimulationHistory.length]
const many = () => observation({ records: ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 30 }, (_, i) => record(platform, String(10 - i), { prompt: i < 28 ? 'First question' : 'Second question', response: `MATCH ${i}` }))) })
async function choose(h, files) { h.byId('interviews-file-input').props.onChange({ target: { files, value: 'chosen' } }); await flush() }
async function open(h, data = many(), name) { await choose(h, [file(data, name)]); await h.click('interviews-file-open') }
async function accept(h, calls, path, data = many()) { if (path === local) await open(h, data); else await resolve(calls.getSavedInterviews.at(-1), data) }
async function hooked(t, path = live, data = many()) {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath: path, downloadHooks: hooks })
  t.after(() => h.unmount()); await accept(h, d.calls, path, data); await h.input('interviews-search', 'mAtCh')
  return { h, hooks, calls: d.calls, data }
}
function expected(data, path, query = 'mAtCh', questionKey = null, filename = 'accepted.json') {
  const group = buildSavedInterviewQuestions(data).groups.find(group => group.key === questionKey)
  const eligibleRows = questionKey === null ? [...data.records] : [...group?.records ?? []]
  return text.formatSavedInterviewMatchesText(data, { mode: questionKey === null ? 'records' : 'questions', query, questionKey, questionPrompt: group?.prompt ?? null,
    origin: path === local ? 'accepted local file' : 'accepted saved-storage observation', filename: path === local ? filename : null,
    eligibleRows, matchingRows: filterSavedInterviewRecords(eligibleRows, query) })
}
const suffix = id => id === json ? '-saved-interviews.json' : id === txt ? '-saved-interviews.txt' : '-saved-interview-matches.txt'

test('baseline witness: accepted local search exposes the separately labelled native matching TXT action', async t => {
  const { h } = await hooked(t)
  const control = h.byId(matches)
  assert.ok(control, 'matching TXT control must be present for active local search')
  assert.equal(h.text(control), 'Download matching rows TXT')
  assert.equal(control.props.type, 'button')
})

for (const path of [live, local]) for (const locale of ['en', 'zh']) test(`matching TXT visibility, translated scope and all-page bytes in ${locale} on ${path}`, async t => {
  const { h, calls } = await setup(t, path, locale), data = many(), original = JSON.stringify(data)
  assert.equal(h.byId(matches), undefined)
  if (path === local) { await choose(h, [file(data)]); assert.equal(h.byId(matches), undefined); await h.click('interviews-file-open') }
  else await resolve(calls.getSavedInterviews[0], data)
  assert.equal(h.byId(matches), undefined)
  const fullTxt = h.byId(txt).props.onClick, fullJson = h.byId(json).props.onClick
  fullTxt(event()); fullJson(event()); await flush()
  const counts = apiCounts(calls), route = h.router.currentRoute.value.fullPath
  await h.input('interviews-search', 'mAtCh')
  const button = h.byId(matches), scope = h.byId('interviews-matches-scope')
  assert.equal(button.type, 'button'); assert.equal(button.props.type, 'button'); assert.ok(!button.props.disabled)
  assert.equal(h.text(button), locale === 'en' ? 'Download matching rows TXT' : '下载匹配记录 TXT')
  assert.equal(button.props['aria-describedby'], scope.props.id)
  assert.match(h.text(scope), locale === 'en' ? /All 60 matching rows across all client pages in this loaded observation\/window/ : /全部 60 条匹配记录.*所有客户端分页/)
  await h.click(matches)
  const first = h.downloads.at(-1), body = await first.blob.text()
  assert.equal(first.filename, 'sim_A-saved-interview-matches.txt')
  assert.equal(first.blob.type, 'text/plain;charset=utf-8')
  assert.equal(body, expected(data, path))
  await h.click('interviews-next'); assert.ok(h.revokedUrls.includes(first.url))
  await h.click(matches); assert.equal(await h.downloads.at(-1).blob.text(), body)
  await h.click('interviews-questions-mode'); await h.change('interviews-question-select', 'question-1')
  await h.click(matches); assert.equal(await h.downloads.at(-1).blob.text(), expected(data, path, 'mAtCh', 'question-1'))
  await h.input('interviews-search', 'NO MATCH'); assert.ok(!h.byId(matches).props.disabled)
  await h.click(matches); assert.ok((await h.downloads.at(-1).blob.text()).includes('No records match this captured view'))
  fullTxt(event()); fullJson(event()); await flush()
  assert.equal(await h.downloads[0].blob.text(), text.formatSavedInterviewText(data))
  assert.equal(await h.downloads.at(-2).blob.text(), await h.downloads[0].blob.text())
  assert.equal(await h.downloads[1].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.equal(await h.downloads.at(-1).blob.text(), await h.downloads[1].blob.text())
  await h.click('interviews-search-clear'); assert.ok(h.byId(matches), 'question mode with empty query remains exportable')
  await h.click('interviews-records-mode'); assert.equal(h.byId(matches), undefined)
  await h.input('interviews-search', ' '); assert.ok(h.byId(matches), 'whitespace-only query is active')
  assert.deepEqual(apiCounts(calls), counts); assert.equal(h.router.currentRoute.value.fullPath, route)
  assert.equal(JSON.stringify(data), original); assert.deepEqual(h.warnings, [])
  assert.equal(h.all(node => ['script', 'img', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
})

for (const path of [live, local]) test(`question mode with no complete question exports an explicit empty report on ${path}`, async t => {
  const data = observation({ records: [record('twitter', '1', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] })] })
  const { h, calls } = await setup(t, path); await accept(h, calls, path, data)
  await h.click('interviews-questions-mode'); assert.ok(!h.byId(matches).props.disabled)
  await h.click(matches)
  const output = await h.downloads[0].blob.text()
  assert.ok(output.includes('No complete saved question is selected')); assert.ok(output.includes('No records match this captured view'))
})

const localChanges = {
  query: h => h.input('interviews-search', 'MATCH'),
  'query-away-and-back': async h => { await h.input('interviews-search', 'other'); await h.input('interviews-search', 'mAtCh') },
  clear: h => h.click('interviews-search-clear'),
  questions: h => h.click('interviews-questions-mode'),
  records: h => h.click('interviews-records-mode'),
  question: h => h.change('interviews-question-select', 'question-1'),
  'page-away-and-back': async h => { await h.click('interviews-next'); await h.click('interviews-previous') },
}
for (const path of [live, local]) for (const [change, act] of Object.entries(localChanges)) test(`stale matching callback after ${change} cannot revoke a newer URL or clear its error on ${path}`, async t => {
  const { h, hooks, calls } = await hooked(t, path), counts = apiCounts(calls)
  if (['records', 'question'].includes(change)) await h.click('interviews-questions-mode')
  const old = h.byId(matches).props.onClick
  await h.click(matches); const previous = h.downloads[0]
  await act(h); assert.ok(h.revokedUrls.includes(previous.url))
  await h.click(json); const newer = h.downloads.at(-1)
  old(event()); await flush()
  assert.equal(h.downloads.length, 2); assert.ok(!h.revokedUrls.includes(newer.url))
  hooks.blob = () => { throw new Error('newer failure') }
  await h.click(json); delete hooks.blob
  const error = h.text(h.byId('interviews-error')), revoked = [...h.revokedUrls], anchors = h.anchors.length
  old(event()); await flush()
  assert.equal(h.text(h.byId('interviews-error')), error); assert.deepEqual(h.revokedUrls, revoked); assert.equal(h.anchors.length, anchors)
  assert.deepEqual(apiCounts(calls), counts)
})

for (const action of ['filter', 'apply', 'refresh', 'A-B-A', 'live-file-live', 'back-forward', 'unmount']) test(`matching ownership retires across ${action}`, async t => {
  const { h, calls } = await hooked(t), old = h.byId(matches).props.onClick
  await h.click(matches)
  if (action === 'filter') await h.input('interviews-agent-id', '5')
  if (action === 'apply') { await h.click('interviews-apply'); await resolve(calls.getSavedInterviews.at(-1), many()) }
  if (action === 'refresh') { await h.click('interviews-refresh'); await resolve(calls.getSavedInterviews.at(-1), many()) }
  if (action === 'A-B-A') { await h.navigate('/simulation/sim_B/interviews'); await h.navigate(live); await resolve(calls.getSavedInterviews.at(-1), many()) }
  if (action === 'live-file-live') { await h.navigate(local); await open(h); await h.navigate(live); await resolve(calls.getSavedInterviews.at(-1), many()) }
  if (action === 'back-forward') { await h.navigate('/simulation/sim_B/interviews'); await h.back(); await resolve(calls.getSavedInterviews.at(-1), many()); await h.forward(); await resolve(calls.getSavedInterviews.at(-1), observation({ simulation_id: 'sim_B' })) }
  if (action === 'unmount') h.unmount()
  const counts = apiCounts(calls), revoked = [...h.revokedUrls]
  old(event()); await flush()
  assert.equal(h.downloads.length, 1); assert.deepEqual(h.revokedUrls, revoked)
  assert.ok(h.revokedUrls.includes(h.downloads[0].url)); assert.deepEqual(apiCounts(calls), counts)
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
})

test('older-window transition with the same question key binds only to that accepted window', async t => {
  const path = live + '?platform=twitter', filters = { platform: 'twitter', agent_id: null }
  const newest = windowObservation({ filters, records: [record('twitter', '0', { response: 'newest match' })], sources: { twitter: source({ returned_count: 1, has_more: true, coverage: 'partial', warnings: ['response_limit'] }), reddit: source({ status: 'not_requested', has_more: null, coverage: 'not_requested' }) } })
  const older = windowObservation({ filters, window: { before_row: '0', source_revision: 'a'.repeat(64) }, records: [record('twitter', '-1', { response: 'older match' })] })
  const { h, calls } = await setup(t, path); await resolve(calls.getSavedInterviews[0], newest)
  await h.click('interviews-questions-mode'); const old = h.byId(matches).props.onClick
  await h.click('interviews-older'); assert.equal(h.byId(matches), undefined)
  await resolve(calls.getSavedInterviews.at(-1), older); await h.click('interviews-questions-mode')
  await h.click(matches); const newer = h.downloads[0]
  old(event()); await flush(); assert.equal(h.downloads.length, 1); assert.ok(!h.revokedUrls.includes(newer.url))
  const output = await newer.blob.text()
  assert.ok(output.includes('before_row:\n  0')); assert.ok(output.includes('older match')); assert.doesNotMatch(output, /newest match/)
})

test('file select, completion, cancel, failure, open and clear retire old callbacks while retained data keeps its accepted filename and query', async t => {
  const { h, calls } = await setup(t, local), data = many(), acceptedName = 'accepted\n<script>\\name.json'
  await open(h, data, acceptedName); await h.input('interviews-search', 'mAtCh')
  let finish
  const pending = file(observation({ simulation_id: 'preview' }), 'pending.json')
  pending.arrayBuffer = () => new Promise(resolve => { finish = resolve })
  let old = h.byId(matches).props.onClick
  await choose(h, [pending]); old(event()); await flush(); assert.equal(h.downloads.length, 0)
  await h.click(matches); assert.equal(await h.downloads.at(-1).blob.text(), expected(data, local, 'mAtCh', null, acceptedName))
  old = h.byId(matches).props.onClick
  finish(new TextEncoder().encode(JSON.stringify(observation({ simulation_id: 'preview' }))).buffer); await flush()
  old(event()); await flush(); assert.equal(h.downloads.length, 1)
  await h.click(matches); assert.equal(await h.downloads.at(-1).blob.text(), expected(data, local, 'mAtCh', null, acceptedName))
  old = h.byId(matches).props.onClick
  await h.click('interviews-file-cancel'); old(event()); await flush(); assert.equal(h.downloads.length, 2)
  old = h.byId(matches).props.onClick
  await choose(h, []); old(event()); await flush(); assert.equal(h.downloads.length, 2)
  old = h.byId(matches).props.onClick
  await choose(h, [new File(['invalid'], 'bad.json')]); old(event()); await flush(); assert.equal(h.downloads.length, 2)
  assert.ok(h.byId('interviews-file-error')); await h.click(matches)
  assert.equal(await h.downloads.at(-1).blob.text(), expected(data, local, 'mAtCh', null, acceptedName))
  await choose(h, [file(many(), 'replacement.json')]); old = h.byId(matches).props.onClick
  await h.click('interviews-file-open'); old(event()); await flush(); assert.equal(h.downloads.length, 3); assert.equal(h.byId(matches), undefined)
  await h.click('interviews-questions-mode'); await h.click(matches)
  assert.equal(await h.downloads.at(-1).blob.text(), expected(many(), local, '', 'question-0', 'replacement.json'))
  old = h.byId(matches).props.onClick
  await h.click('interviews-file-clear'); old(event()); await flush(); assert.equal(h.downloads.length, 4); assert.equal(h.byId(matches), undefined)
  assert.ok(h.revokedUrls.includes(h.downloads.at(-1).url)); assert.deepEqual(apiCounts(calls), [0, 0])
})

for (const path of [live, local]) for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove']) test(`matching ${step} failure keeps accepted data and supports deliberate retry on ${path}`, async t => {
  const { h, hooks, calls, data } = await hooked(t, path), counts = apiCounts(calls)
  hooks[step] = () => { throw new Error('PRIVATE_MATCH_FAILURE') }
  await h.click(matches)
  assert.ok(h.byId('interviews-results')); assert.match(h.text(), /check your downloads before retrying/i); assert.doesNotMatch(h.text(), /PRIVATE_MATCH_FAILURE/)
  assert.equal(h.downloads.length, step === 'remove' ? 1 : 0, 'a completed click cannot be undone')
  assert.equal(h.anchors.some(anchor => anchor.attached), false)
  delete hooks[step]; await h.click(matches)
  assert.equal(h.byId('interviews-error'), undefined); assert.equal(await h.downloads.at(-1).blob.text(), expected(data, path))
  assert.deepEqual(apiCounts(calls), counts)
  h.unmount(); assert.ok(h.revokedUrls.includes(h.downloads.at(-1).url))
})

for (const path of [live, local]) for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove']) for (const change of ['query', 'question', 'page']) test(`matching ${step} synchronous ${change} retirement cleans only its own resources on ${path}`, async t => {
  const { h, hooks, calls } = await hooked(t, path), counts = apiCounts(calls)
  hooks[step] = () => {
    delete hooks[step]
    if (change === 'query') h.byId('interviews-search').props.onInput(event('changed'))
    if (change === 'question') h.byId('interviews-questions-mode').props.onClick(event())
    if (change === 'page') h.byId('interviews-next').props.onClick(event())
    h.byId(json).props.onClick(event())
  }
  await h.click(matches)
  const newer = h.downloads.find(download => download.filename.endsWith('.json'))
  assert.ok(newer); assert.ok(!h.revokedUrls.includes(newer.url)); assert.equal(h.byId('interviews-error'), undefined)
  if (!['click', 'remove'].includes(step)) assert.equal(h.downloads.length, 1, 'retired attempt must not reach click')
  assert.equal(h.anchors.some(anchor => anchor.attached), false); assert.deepEqual(apiCounts(calls), counts)
  h.unmount(); assert.ok(h.revokedUrls.includes(newer.url))
})

const formatPairs = [[matches, json], [matches, txt], [json, matches], [txt, matches]]
for (const path of [live, local]) for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove', 'revoke']) for (const [outer, inner] of formatPairs) test(`${outer} to ${inner} during ${step} preserves the newer attempt on ${path}`, async t => {
  const { h, hooks, calls } = await hooked(t, path), counts = apiCounts(calls)
  if (step === 'revoke') await h.click(outer)
  hooks[step] = () => { delete hooks[step]; h.byId(inner).props.onClick(event()); if (step !== 'revoke') throw new Error('PRIVATE_SUPERSEDED_MATCH_DOWNLOAD') }
  await h.click(outer)
  const newer = h.downloads.at(-1)
  assert.ok(newer.filename.endsWith(suffix(inner))); assert.ok(!h.revokedUrls.includes(newer.url))
  assert.equal(h.byId('interviews-error'), undefined); assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.deepEqual(apiCounts(calls), counts)
  h.unmount(); assert.ok(h.revokedUrls.includes(newer.url))
})

for (const path of [live, local]) for (const [outer, inner] of formatPairs) test(`nested ${inner} failure survives older ${outer} catch/finally on ${path}`, async t => {
  const { h, hooks } = await hooked(t, path)
  hooks.click = () => {
    delete hooks.click; hooks.blob = () => { delete hooks.blob; throw new Error('inner failure') }
    h.byId(inner).props.onClick(event()); throw new Error('outer failure')
  }
  await h.click(outer)
  assert.match(h.text(h.byId('interviews-error')), /download could not be completed/i)
  assert.equal(h.downloads.length, 0); assert.equal(h.anchors.some(anchor => anchor.attached), false)
  await h.click(inner); assert.equal(h.byId('interviews-error'), undefined)
})

for (const format of [json, txt]) test(`presentation cleanup leaves an observation-level ${format} URL alive`, async t => {
  const { h } = await hooked(t)
  await h.click(format); const saved = h.downloads[0]
  await h.input('interviews-search', 'changed'); await h.click('interviews-questions-mode')
  assert.ok(!h.revokedUrls.includes(saved.url)); h.unmount(); assert.ok(h.revokedUrls.includes(saved.url))
})

for (const path of [live, local]) for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove']) test(`matching ${step} session retirement disposes late resources and cannot publish a stale error on ${path}`, async t => {
  const { h, hooks, calls } = await hooked(t, path), counts = apiCounts(calls)
  hooks[step] = () => {
    delete hooks[step]
    if (path === local) h.byId('interviews-file-input').props.onChange({ target: { files: [], value: 'cancelled' } })
    else h.router.currentRoute.value = h.router.resolve(local)
  }
  await h.click(matches)
  assert.equal(h.byId('interviews-error'), undefined); assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.equal(h.downloads.length, ['click', 'remove'].includes(step) ? 1 : 0)
  assert.equal(h.revokedUrls.length, step === 'blob' ? 0 : 1, 'late URL returns must be retired by the original attempt')
  assert.deepEqual(apiCounts(calls), counts)
  if (path === live) { await open(h); await h.input('interviews-search', 'mAtCh') }
  await h.click(matches); const fresh = h.downloads.at(-1)
  assert.equal(await fresh.blob.text(), expected(many(), local))
  assert.ok(!h.revokedUrls.includes(fresh.url))
})

for (const path of [live, local]) for (const inner of [json, txt]) for (const fail of [false, true]) test(`presentation watcher revoke preserves nested ${inner} ${fail ? 'error' : 'URL'} on ${path}`, async t => {
  const { h, hooks } = await hooked(t, path)
  await h.click(matches); const old = h.byId(matches).props.onClick
  hooks.revoke = () => {
    delete hooks.revoke
    if (fail) hooks.blob = () => { delete hooks.blob; throw new Error('newest failure') }
    h.byId(inner).props.onClick(event())
  }
  await h.input('interviews-search', 'changed')
  const revoked = [...h.revokedUrls], error = h.byId('interviews-error') && h.text(h.byId('interviews-error'))
  old(event()); await flush(); assert.deepEqual(h.revokedUrls, revoked)
  if (fail) assert.equal(h.text(h.byId('interviews-error')), error)
  else assert.ok(!h.revokedUrls.includes(h.downloads.at(-1).url))
  assert.equal(h.byId('interviews-search').props.value, 'changed')
})
