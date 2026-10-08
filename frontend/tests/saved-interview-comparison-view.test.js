import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSavedInterviewComparison, record, observation, source, flush } from './helpers/saved-interview-comparison-view-fixture.js'

const path = '/interview-files/compare'
const event = () => ({ preventDefault() {}, stopPropagation() {} })
const file = (data = observation(), name = 'same.json') => new File([JSON.stringify(data)], name)
async function choose(h, files) { const target = { files, value: 'selected' }; h.byId('interview-compare-file-input').props.onChange({ target }); await flush(); assert.equal(target.value, '') }
async function accept(h, side, data = observation(), name) { await choose(h, [file(data, name)]); await h.click(`interview-compare-accept-${side}`) }
async function setup(t, options) { const h = await mountSavedInterviewComparison(options); t.after(() => h.unmount()); return h }
const ids = (h, side) => h.all(node => node.props['data-testid']?.startsWith(`interview-compare-row-${side}-`)).map(node => node.props['data-testid'])
const replies = (side, count) => observation({ records: Array.from({ length: count }, (_, index) => record('twitter', String(40 - index), { response: `${side} reply ${index}` })) })
function deferredFile(data = observation(), name = 'late.json') { let resolve; const bytes = new TextEncoder().encode(JSON.stringify(data)); return { value: { name, size: bytes.length, arrayBuffer: () => new Promise(done => { resolve = done }) }, complete: () => resolve(bytes.buffer) } }

test('preview explicitly accepts two immutable observations; replacement, invalid and cancelled reads retain accepted sides', async t => {
  const h = await setup(t)
  assert.ok(h.byId('interview-compare-reader-link')); assert.equal(h.requests.calls.getSavedInterviews.length, 0)
  await choose(h, [file(replies('left', 27), 'left.json')])
  assert.ok(h.byId('interview-compare-preview')); assert.equal(Boolean(h.byId('interview-compare-left-side')), false)
  const staleAccept = h.byId('interview-compare-accept-right').props.onClick
  await h.click('interview-compare-accept-left'); staleAccept(event()); await flush()
  assert.equal(Boolean(h.byId('interview-compare-right-side')), false)
  await accept(h, 'right', replies('right', 31), 'right.json')
  assert.ok(h.text(h.byId('interview-compare-left-side')).includes('left.json')); assert.ok(h.text(h.byId('interview-compare-right-side')).includes('right.json'))
  await choose(h, [new File(['bad'], 'bad.json')]); assert.ok(h.byId('interview-compare-error')); assert.equal(ids(h, 'left').length, 25)
  await choose(h, []); assert.equal(Boolean(h.byId('interview-compare-error')), false); assert.equal(ids(h, 'right').length, 25)
  await choose(h, [file(observation({ simulation_id: 'replacement' }))]); await h.click('interview-compare-cancel'); assert.ok(h.text(h.byId('interview-compare-left-side')).includes('left.json'))
  await accept(h, 'left', observation({ simulation_id: 'replacement' })); assert.ok(h.text(h.byId('interview-compare-left-side')).includes('replacement')); assert.ok(h.text(h.byId('interview-compare-right-side')).includes('right.json'))
  assert.deepEqual(h.warnings, [])
})

test('exact union questions, separate paging and literal search retain counts and complete side downloads', async t => {
  const h = await setup(t), left = replies('left', 27), right = replies('right', 31)
  left.records.push(record('reddit', '4', { prompt: 'left only', response: '<script>literal</script>\u0000\ud800' })); left.sources.reddit.returned_count++
  right.records.push(record('reddit', '4', { prompt: 'right only' })); right.sources.reddit.returned_count++
  await accept(h, 'left', left); await accept(h, 'right', right)
  assert.equal(ids(h, 'left').length, 25); assert.equal(ids(h, 'right').length, 25)
  assert.ok(h.text(h.byId('interview-compare-left-counts')).includes('27')); assert.ok(h.text(h.byId('interview-compare-right-counts')).includes('31'))
  await h.click('interview-compare-left-next'); assert.equal(ids(h, 'left').length, 2); assert.equal(ids(h, 'right').length, 25)
  await h.click('interview-compare-right-next'); assert.equal(ids(h, 'right').length, 6)
  await h.input('interview-compare-left-search', 'left reply 26'); assert.equal(ids(h, 'left').length, 1); assert.equal(ids(h, 'right').length, 6)
  await h.click('interview-compare-left-download'); assert.deepEqual(JSON.parse(await h.downloads.at(-1).blob.text()), left)
  await h.change('interview-compare-question-select', 'question-1'); assert.equal(h.text(h.byId('interview-compare-prompt')), 'left only'); assert.equal(ids(h, 'left').length, 1)
  assert.ok(h.text(h.byId('interview-compare-right-absent')).includes('admitted observation')); assert.ok(h.text(h.byId('interview-compare-left-side')).includes('<script>literal</script>'))
  await h.click('interview-compare-right-download'); assert.deepEqual(JSON.parse(await h.downloads.at(-1).blob.text()), right)
  await h.change('interview-compare-question-select', 'question-2'); assert.equal(ids(h, 'left').length, 0); assert.equal(ids(h, 'right').length, 1)
})

test('recorded coverage, filters, has_more, warning codes and ungrouped reasons remain available per side', async t => {
  const h = await setup(t), left = observation({ records: [record('twitter', '3', { prompt: null, warnings: ['missing_prompt'] }), record('twitter', '2', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'bad', warnings: ['invalid_json'] }), record('twitter', '1', { truncated: true, warnings: ['timestamp_truncated'] })], sources: { twitter: source({ returned_count: 3, has_more: true, coverage: 'partial', warnings: ['response_limit', 'record_warnings'] }), reddit: source({ status: 'missing', coverage: 'unavailable', has_more: null, warnings: ['source_missing'] }) }, availability: 'partial' })
  const right = observation({ filters: { platform: 'reddit', agent_id: '0' }, records: [] })
  await accept(h, 'left', left, '<img src=x>.json'); await accept(h, 'right', right)
  const text = h.text(h.byId('interview-compare-left-side'))
  for (const fragment of ['<img src=x>.json', left.simulation_id, left.observed_at, 'response_limit', 'record_warnings', 'source_missing', 'additional records: Yes', 'unknown']) assert.ok(text.toLowerCase().includes(fragment.toLowerCase()), fragment)
  assert.ok(h.text(h.byId('interview-compare-left-ungrouped')).includes('2')); assert.ok(h.text(h.byId('interview-compare-left-ungrouped')).includes('missing_prompt')); assert.ok(h.text(h.byId('interview-compare-left-ungrouped')).includes('invalid_json'))
  assert.ok(h.text(h.byId('interview-compare-right-side')).includes('excluded')); assert.ok(h.text(h.byId('interview-compare-right-side')).includes('zero matching'))
  await h.click('interview-compare-left-download'); assert.deepEqual(JSON.parse(await h.downloads.at(-1).blob.text()), left)
})

test('late reads, retained pair/question/page/search/download callbacks cannot change replacements, swaps or clears', async t => {
  const h = await setup(t), late = deferredFile()
  await choose(h, [late.value]); await accept(h, 'left', replies('new', 27)); late.complete(); await flush(); assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  await accept(h, 'right', replies('right', 31))
  const old = ['left-next', 'left-search', 'left-download', 'left-clear', 'swap', 'clear-both'].map(id => h.byId('interview-compare-' + id).props.onClick ?? h.byId('interview-compare-' + id).props.onInput)
  const question = h.byId('interview-compare-question-select').props.onChange
  await accept(h, 'left', observation({ records: [record('twitter', '1', { prompt: 'replacement only' })] }))
  old.forEach(handler => handler({ ...event(), target: { value: 'right' } })); question({ target: { value: 'question-1' } }); await flush()
  assert.equal(h.text(h.byId('interview-compare-prompt')), 'replacement only'); assert.equal(h.downloads.length, 0)
  await h.click('interview-compare-swap'); assert.ok(h.text(h.byId('interview-compare-prompt')).includes('Saved prompt'))
  await h.click('interview-compare-left-clear'); assert.equal(Boolean(h.byId('interview-compare-left-side')), false); assert.ok(h.byId('interview-compare-right-side'))
  await h.click('interview-compare-clear-both'); assert.equal(Boolean(h.byId('interview-compare-right-side')), false)
})

test('route changes, unmount and locale switches respect session ownership without live requests', async t => {
  const h = await setup(t)
  await accept(h, 'left', observation()); await accept(h, 'right', observation())
  const oldSelect = h.byId('interview-compare-file-input').props.onChange, oldDownload = h.byId('interview-compare-left-download').props.onClick
  h.i18n.global.locale.value = 'zh'; await flush(); assert.ok(h.text().includes('精确')); assert.equal(ids(h, 'right').length, 2)
  h.i18n.global.locale.value = 'en'; await flush(); await h.click('interview-compare-left-download')
  const late = deferredFile(); await choose(h, [late.value]); await h.navigate(path + '?new=1'); late.complete(); await flush()
  assert.equal(Boolean(h.byId('interview-compare-left-side')), false); assert.equal(Boolean(h.byId('interview-compare-preview')), false)
  oldSelect({ target: { files: [file()], value: 'x' } }); oldDownload(event()); await flush(); assert.equal(h.downloads.length, 1)
  assert.ok(h.revokedUrls.includes(h.downloads[0].url)); await accept(h, 'right'); const retained = h.byId('interview-compare-right-download').props.onClick
  h.unmount(); retained(event()); assert.equal(h.downloads.length, 1)
})

test('the actual comparison language control changes only in-memory labels and keeps both page/search states', async t => {
  const h = await setup(t); await accept(h, 'left', replies('left', 27)); await accept(h, 'right', replies('right', 31))
  const rootLanguage = () => h.find(node => node.props.class === 'comparison-page').props.lang
  assert.equal(rootLanguage(), 'en')
  await h.click('interview-compare-left-next'); await h.input('interview-compare-right-search', 'right reply 30')
  const before = [ids(h, 'left'), ids(h, 'right')], key = h.byId('interview-compare-question-select').props.value
  await h.change('interview-compare-language', 'zh')
  assert.equal(rootLanguage(), 'zh')
  assert.equal(h.i18n.global.locale.value, 'zh'); assert.deepEqual([ids(h, 'left'), ids(h, 'right')], before); assert.equal(h.byId('interview-compare-question-select').props.value, key)
  assert.equal(h.byId('interview-compare-right-search').props.value, 'right reply 30')
  await h.change('interview-compare-language', 'en'); assert.equal(rootLanguage(), 'en'); assert.equal(h.i18n.global.locale.value, 'en'); assert.deepEqual([ids(h, 'left'), ids(h, 'right')], before)
})

test('additional-record labels localize true, false and unknown without changing saved booleans or null', async t => {
  const h = await setup(t), data = observation({ records: [], sources: { twitter: source({ has_more: true, coverage: 'partial', warnings: ['response_limit'] }), reddit: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }) }, availability: 'partial' })
  await accept(h, 'left', data); await accept(h, 'right', observation({ records: [] }))
  assert.equal(h.text(h.byId('interview-compare-left-more-twitter')), 'File reports additional records: Yes')
  assert.equal(h.text(h.byId('interview-compare-left-more-reddit')), 'File reports additional records: Unknown')
  assert.equal(h.text(h.byId('interview-compare-right-more-twitter')), 'File reports additional records: No')
  await h.change('interview-compare-language', 'zh')
  assert.equal(h.text(h.byId('interview-compare-left-more-twitter')), '文件记载有更多记录：是')
  assert.equal(h.text(h.byId('interview-compare-left-more-reddit')), '文件记载有更多记录：未知')
  assert.equal(h.text(h.byId('interview-compare-right-more-twitter')), '文件记载有更多记录：否')
  await h.click('interview-compare-left-download'); assert.deepEqual(JSON.parse(await h.downloads.at(-1).blob.text()), data)
})

test('question review states the saved platform/physical-row ordering in both locales', async t => {
  const h = await setup(t); await accept(h, 'left')
  assert.equal(h.text(h.byId('interview-compare-order-note')), h.i18n.global.t('savedInterviews.orderNote'))
  await h.change('interview-compare-language', 'zh')
  assert.equal(h.text(h.byId('interview-compare-order-note')), h.i18n.global.t('savedInterviews.orderNote'))
})

for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove']) test(`download host reentry during ${step} cannot retain old resources or alter replacement side`, async t => {
  const hooks = {}, h = await setup(t, { downloadHooks: hooks }); await accept(h, 'left'); await choose(h, [file(observation({ simulation_id: 'replacement' }))])
  const acceptNew = h.byId('interview-compare-accept-left').props.onClick
  hooks[step] = () => { delete hooks[step]; acceptNew(event()); throw new Error('PRIVATE_HOST_FAILURE') }
  await h.click('interview-compare-left-download')
  assert.ok(h.text(h.byId('interview-compare-left-side')).includes('replacement')); assert.equal(h.anchors.some(anchor => anchor.attached), false)
  assert.equal(Boolean(h.byId('interview-compare-download-error')), false)
  await h.click('interview-compare-left-download'); assert.equal(JSON.parse(await h.downloads.at(-1).blob.text()).simulation_id, 'replacement')
})

for (const step of ['blob', 'url', 'element', 'append', 'click', 'remove']) test(`current download failure during ${step} retains both accepted observations and cleans owned resources`, async t => {
  const hooks = {}, h = await setup(t, { downloadHooks: hooks }); await accept(h, 'left'); await accept(h, 'right')
  hooks[step] = () => { delete hooks[step]; throw new Error('PRIVATE_DOWNLOAD_PATH') }; await h.click('interview-compare-left-download')
  assert.ok(h.byId('interview-compare-left-side')); assert.ok(h.byId('interview-compare-right-side')); assert.ok(h.byId('interview-compare-download-error'))
  assert.equal(h.anchors.some(anchor => anchor.attached), false); assert.equal(h.text().includes('PRIVATE_DOWNLOAD_PATH'), false)
  await h.click('interview-compare-right-download'); assert.deepEqual(JSON.parse(await h.downloads.at(-1).blob.text()), observation())
})

test('reentrant newer download supersedes older URL revocation without stealing its resource', async t => {
  const hooks = {}, h = await setup(t, { downloadHooks: hooks }); await accept(h, 'left'); await accept(h, 'right'); await h.click('interview-compare-left-download')
  hooks.revoke = () => { delete hooks.revoke; h.byId('interview-compare-right-download').props.onClick(event()) }
  await h.click('interview-compare-left-download'); assert.equal(h.downloads.length, 2); assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
  h.unmount(); assert.deepEqual(h.revokedUrls, [h.downloads[0].url, h.downloads[1].url])
})
