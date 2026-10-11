import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { formatSavedInterviewText } from '../src/utils/savedInterviewText.js'
import { setup, resolve, observation, windowObservation, record, source, mountSavedInterviews, deferredApi, flush } from './helpers/saved-interviews-view-fixture.js'

test('accepted live observation exposes a native TXT action beside JSON', async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0], observation())
  const control = h.byId('interviews-download-text')
  assert.ok(control, 'accepted observation must offer Download observation TXT')
  assert.equal(h.text(control), 'Download observation TXT')
  assert.equal(control.props.type, 'button')
  assert.ok(!control.props.disabled)
})

const livePath = '/simulation/sim_A/interviews', filePath = '/interview-files'
const txt = 'interviews-download-text', json = 'interviews-download'
const event = () => ({ stopPropagation() {}, preventDefault() {} })
const file = data => new File([JSON.stringify(data)], 'saved.json', { type: 'application/json' })
async function choose(h, files) { h.byId('interviews-file-input').props.onChange({ target: { files, value: 'chosen' } }); await flush() }
async function open(h, data = observation()) { await choose(h, [file(data)]); await h.click('interviews-file-open') }
async function accept(h, calls, path, data = observation()) {
  if (path === filePath) await open(h, data)
  else await resolve(calls.getSavedInterviews.at(-1), data)
}
async function hooked(t, path) {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath: path, downloadHooks: hooks })
  t.after(() => h.unmount())
  await accept(h, d.calls, path)
  return { h, hooks, calls: d.calls }
}
const apiCounts = calls => [calls.getSavedInterviews.length, calls.getSimulationHistory.length]

for (const path of [livePath, filePath]) for (const locale of ['en', 'zh']) test(`TXT acceptance, native download attributes and localized scope work in ${locale} on ${path}`, async t => {
  const { h, calls } = await setup(t, path, locale)
  if (path === livePath) assert.ok(h.byId(txt).props.disabled)
  else {
    assert.equal(h.byId(txt), undefined)
    await choose(h, [file(observation())]); assert.equal(h.byId(txt), undefined)
  }
  const data = observation({ records: [record('twitter', '1', { prompt: '中文\n\ud800\\literal' }), record('reddit', '1')] })
  await accept(h, calls, path, data)
  const count = apiCounts(calls), control = h.byId(txt)
  assert.equal(h.text(control), locale === 'en' ? 'Download observation TXT' : '下载观察结果 TXT')
  assert.equal(control.props.type, 'button'); assert.ok(!control.props.disabled)
  assert.equal(control.parent, h.byId(json).parent)
  assert.match(h.text(h.byId('interviews-text-note')), locale === 'en' ? /regardless of search, selected question or page/ : /不受搜索、所选问题或页码影响/)
  assert.doesNotMatch(h.text(), /savedInterviews\./)
  await h.click(txt)
  assert.equal(h.downloads.length, 1)
  assert.equal(h.downloads[0].filename, 'sim_A-saved-interviews.txt')
  assert.equal(h.downloads[0].blob.type, 'text/plain;charset=utf-8')
  assert.equal(await h.downloads[0].blob.text(), formatSavedInterviewText(data))
  assert.deepEqual(apiCounts(calls), count)
  assert.equal(h.anchors.some(a => a.attached), false)
  assert.deepEqual(h.warnings, [])
})

for (const path of [livePath, filePath]) test(`TXT exports the whole accepted observation despite page, question and zero-match search on ${path}`, async t => {
  const { h, calls } = await setup(t, path)
  const data = observation({ records: Array.from({ length: 58 }, (_, i) => record('twitter', String(60-i), { prompt: i < 30 ? 'First question' : 'Second question', response: `reply ${i}` })) })
  await accept(h, calls, path, data)
  const count = apiCounts(calls)
  await h.click(json)
  const oldTxt = h.byId(txt).props.onClick
  await h.click('interviews-next')
  await h.click('interviews-questions-mode')
  await h.change('interviews-question-select', 'question-1')
  await h.click('interviews-next')
  await h.input('interviews-search', 'NO MATCH ANYWHERE')
  assert.ok(h.byId('interviews-search-empty'))
  oldTxt(event()); await flush()
  assert.equal(await h.downloads[1].blob.text(), formatSavedInterviewText(data))
  assert.equal((await h.downloads[1].blob.text()).match(/^Record \d+$/gm).length, 58)
  await h.click(json)
  for (const download of [h.downloads[0], h.downloads[2]]) {
    assert.equal(download.filename, 'sim_A-saved-interviews.json')
    assert.equal(download.blob.type, 'application/json;charset=utf-8')
    assert.equal(await download.blob.text(), JSON.stringify(data, null, 2) + '\n')
  }
  assert.deepEqual(apiCounts(calls), count)
})

for (const path of [livePath + '?platform=twitter', filePath]) test(`v2 TXT exports only the accepted older window and exact provenance on ${path}`, async t => {
  const { h, calls } = await setup(t, path)
  const filters = { platform: 'twitter', agent_id: null }
  const newest = windowObservation({ filters, records: [record('twitter', '0', { response: 'newest-only' })], sources: { twitter: source({ returned_count: 1, has_more: true, coverage: 'partial', warnings: ['response_limit'] }), reddit: source({ status: 'not_requested', has_more: null, coverage: 'not_requested' }) } })
  const older = windowObservation({ filters, window: { before_row: '0', source_revision: 'a'.repeat(64) }, records: [record('twitter', '-9223372036854775808', { response: 'older-only' })] })
  if (path === filePath) await open(h, older)
  else { await resolve(calls.getSavedInterviews[0], newest); await h.click('interviews-older'); await resolve(calls.getSavedInterviews[1], older) }
  const count = apiCounts(calls)
  await h.click(txt)
  const text = await h.downloads[0].blob.text()
  assert.equal(text, formatSavedInterviewText(older))
  assert.ok(text.includes('before_row:\n  0\n'))
  assert.ok(text.includes('source_revision:\n  ' + 'a'.repeat(64)))
  assert.ok(text.includes('row_id:\n  -9223372036854775808\n'))
  assert.doesNotMatch(text, /newest-only/)
  assert.deepEqual(apiCounts(calls), count)
})

for (const action of ['filter', 'refresh', 'A-B-A', 'live-file-live', 'unmount']) test(`retained TXT callbacks are inert after ${action}`, async t => {
  const { h, calls } = await setup(t)
  await resolve(calls.getSavedInterviews[0])
  const old = h.byId(txt).props.onClick
  await h.click(txt)
  if (action === 'filter') await h.input('interviews-agent-id', '5')
  if (action === 'refresh') { await h.click('interviews-refresh'); await resolve(calls.getSavedInterviews.at(-1)) }
  if (action === 'A-B-A') { await h.navigate('/simulation/sim_B/interviews'); await h.navigate(livePath); await resolve(calls.getSavedInterviews.at(-1)) }
  if (action === 'live-file-live') { await h.navigate(filePath); await open(h); await h.navigate(livePath); await resolve(calls.getSavedInterviews.at(-1)) }
  if (action === 'unmount') h.unmount()
  const count = apiCounts(calls)
  old(event()); await flush()
  assert.equal(h.downloads.length, 1)
  assert.ok(h.revokedUrls.includes(h.downloads[0].url))
  assert.deepEqual(apiCounts(calls), count)
  assert.equal(h.anchors.some(a => a.attached), false)
})

test('pending file selection, cancel and failure preserve accepted data but rotate TXT callbacks; replacement and clear retire data', async t => {
  const { h, calls } = await setup(t, filePath)
  const accepted = observation()
  await open(h, accepted)
  let finish
  const pending = file(observation({ simulation_id: 'pending' }))
  pending.arrayBuffer = () => new Promise(resolve => { finish = resolve })
  let old = h.byId(txt).props.onClick
  await choose(h, [pending])
  assert.ok(h.byId('interviews-file-loading')); old(event()); await flush(); assert.equal(h.downloads.length, 0)
  await h.click(txt); assert.equal(await h.downloads.at(-1).blob.text(), formatSavedInterviewText(accepted))
  old = h.byId(txt).props.onClick
  await h.click('interviews-file-cancel'); old(event()); await flush(); assert.equal(h.downloads.length, 1)
  finish(new TextEncoder().encode(JSON.stringify(observation({ simulation_id: 'pending' }))).buffer); await flush()
  assert.equal(h.byId('interviews-file-preview'), undefined)
  old = h.byId(txt).props.onClick
  await choose(h, [new File(['invalid'], 'bad.json')]); old(event()); await flush(); assert.equal(h.downloads.length, 1)
  assert.ok(h.byId('interviews-file-error')); assert.ok(h.byId('interviews-results'))
  await h.click(txt); assert.equal(await h.downloads.at(-1).blob.text(), formatSavedInterviewText(accepted))
  await choose(h, [file(observation({ simulation_id: 'replacement' }))])
  old = h.byId(txt).props.onClick
  await h.click('interviews-file-open'); old(event()); await flush(); assert.equal(h.downloads.length, 2)
  await h.click(txt); assert.equal(h.downloads.at(-1).filename, 'replacement-saved-interviews.txt')
  old = h.byId(txt).props.onClick
  await h.click('interviews-file-clear'); old(event()); await flush(); assert.equal(h.downloads.length, 3)
  assert.equal(h.byId(txt), undefined)
  assert.ok(h.revokedUrls.includes(h.downloads.at(-1).url))
  assert.deepEqual(apiCounts(calls), [0, 0])
})

for (const path of [livePath, filePath]) for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove']) test(`TXT ${step} failure preserves accepted rows and permits deliberate retry on ${path}`, async t => {
  const { h, calls, hooks } = await hooked(t, path)
  const count = apiCounts(calls)
  hooks[step] = () => { throw new Error('PRIVATE_TXT_FAILURE') }
  await h.click(txt)
  assert.ok(h.byId('interviews-results'))
  assert.match(h.text(), /download could not be completed/i)
  assert.match(h.text(), /check your downloads before retrying/i)
  assert.doesNotMatch(h.text(), /PRIVATE_TXT_FAILURE/)
  assert.equal(h.anchors.some(a => a.attached), false)
  assert.equal(h.revokedUrls.length, ['blob', 'url'].includes(step) ? 0 : 1)
  assert.equal(h.downloads.length, step === 'remove' ? 1 : 0, 'removal may fail after the native click saved a file')
  delete hooks[step]
  await h.click(txt)
  assert.equal(h.byId('interviews-error'), undefined)
  assert.equal(await h.downloads.at(-1).blob.text(), formatSavedInterviewText(observation()))
  assert.deepEqual(apiCounts(calls), count)
  h.unmount(); assert.ok(h.revokedUrls.includes(h.downloads.at(-1).url))
})

for (const path of [livePath, filePath]) for (const step of ['blob', 'url', 'element', 'append', 'click']) test(`TXT ${step} retirement suppresses stale errors and cleans up on ${path}`, async t => {
  const { h, calls, hooks } = await hooked(t, path)
  const count = apiCounts(calls)
  hooks[step] = () => {
    delete hooks[step]
    if (path === filePath) h.byId('interviews-file-input').props.onChange({ target: { files: [file(observation({ simulation_id: 'new_preview' }))], value: 'chosen' } })
    else h.router.currentRoute.value = h.router.resolve(filePath)
    throw new Error('PRIVATE_RETIRED_TXT')
  }
  await h.click(txt)
  assert.equal(h.downloads.length, 0)
  assert.equal(h.byId('interviews-error'), undefined)
  assert.equal(h.anchors.some(a => a.attached), false)
  if (path === filePath) { assert.ok(h.byId('interviews-file-preview')); await h.click('interviews-file-open'); await h.click(txt); assert.equal(h.downloads[0].filename, 'new_preview-saved-interviews.txt') }
  else { assert.equal(h.byId('interviews-results'), undefined); await open(h); await h.click(txt) }
  assert.deepEqual(apiCounts(calls), count)
})

for (const path of [livePath, filePath]) for (const [outer, inner] of [[json, txt], [txt, json]]) test(`${outer} to ${inner} reentrancy during click preserves only the newer URL and error on ${path}`, async t => {
  const { h, calls, hooks } = await hooked(t, path)
  const count = apiCounts(calls)
  hooks.click = () => { delete hooks.click; h.byId(inner).props.onClick(event()); throw new Error('PRIVATE_OLDER_DOWNLOAD') }
  await h.click(outer)
  assert.equal(h.downloads.length, 1)
  const newer = h.downloads[0]
  assert.ok(newer.filename.endsWith(inner === txt ? '.txt' : '.json'))
  assert.equal(h.revokedUrls.includes(newer.url), false)
  assert.equal(h.byId('interviews-error'), undefined)
  assert.equal(h.anchors.some(a => a.attached), false)
  assert.deepEqual(apiCounts(calls), count)
  if (path === filePath) await h.click('interviews-file-clear')
  else h.unmount()
  assert.ok(h.revokedUrls.includes(newer.url))
})

for (const path of [livePath, filePath]) for (const [outer, inner] of [[json, txt], [txt, json]]) test(`${outer} to ${inner} reentrancy while revoking the preceding URL supersedes allocation on ${path}`, async t => {
  const { h, calls, hooks } = await hooked(t, path)
  const count = apiCounts(calls)
  await h.click(outer)
  hooks.revoke = () => { delete hooks.revoke; h.byId(inner).props.onClick(event()) }
  await h.click(outer)
  assert.equal(h.downloads.length, 2)
  assert.ok(h.downloads[1].filename.endsWith(inner === txt ? '.txt' : '.json'))
  assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
  assert.equal(h.byId('interviews-error'), undefined)
  h.unmount()
  assert.deepEqual(h.revokedUrls, [h.downloads[0].url, h.downloads[1].url])
  assert.equal(h.anchors.some(a => a.attached), false)
  assert.deepEqual(apiCounts(calls), count)
})
