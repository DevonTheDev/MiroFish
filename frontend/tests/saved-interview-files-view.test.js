import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { setup, mountSavedInterviews, deferredApi, resolve, observation, record, source, flush } from './helpers/saved-interviews-view-fixture.js'

const livePath = '/simulation/sim_A/interviews', filePath = '/interview-files'
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const file = (data = observation(), name = 'saved.json') => new File([JSON.stringify(data)], name, { type: 'application/json' })
async function choose(h, files) {
  const input = h.byId('interviews-file-input'); assert.ok(input, 'local interview file input must exist')
  const target = { files, value: 'chosen' }
  input.props.onChange({ target }); await flush(); return target
}
async function open(h, data = observation(), name) { await choose(h, [file(data, name)]); await h.click('interviews-file-open') }
const ids = h => h.all(n => String(n.props['data-testid'] ?? '').startsWith('interview-row-')).map(n => n.props['data-testid'])
function deferredFile(name = 'pending.json', data = observation()) {
  let complete, reject
  const promise = new Promise((yes, no) => { complete = yes; reject = no })
  const value = file(data, name)
  value.arrayBuffer = () => promise
  value.text = () => promise.then(bytes => new TextDecoder().decode(bytes))
  return { value, complete: data => complete(new TextEncoder().encode(JSON.stringify(data)).buffer), reject }
}

for (const locale of ['en', 'zh']) test(`file route previews one local observation before explicit acceptance in ${locale}`, async t => {
  const { h, calls } = await setup(t, filePath, locale)
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviewFiles')
  assert.equal(calls.getSavedInterviews.length, 0); assert.equal(calls.getSimulationHistory.length, 0)
  for (const id of ['interviews-form', 'interviews-refresh', 'interviews-apply']) assert.equal(Boolean(h.byId(id)), false)
  assert.equal(h.byId('interviews-file-input').props.multiple, undefined)
  const data = observation({ simulation_id: 'historical_A', filters: { platform: 'reddit', agent_id: '9223372036854775807' }, records: [record('reddit', '-9223372036854775808', { agent_id: '9223372036854775807', prompt: '<script>literal</script>', response: '<img src=x>' })] })
  const name = '<img src=x> saved.json', target = await choose(h, [file(data, name)])
  assert.equal(target.value, ''); assert.ok(h.byId('interviews-file-preview')); assert.equal(Boolean(h.byId('interviews-results')), false)
  assert.ok(h.text(h.byId('interviews-file-preview')).includes(name)); assert.ok(h.text().includes('historical_A')); assert.ok(h.text().includes('9223372036854775807')); assert.ok(h.text().includes(data.observed_at))
  await h.click('interviews-file-open'); assert.ok(h.byId('interviews-results')); assert.equal(Boolean(h.byId('interviews-file-preview')), false)
  assert.ok(h.text(h.byId('interviews-file-name')).includes(name)); assert.ok(h.text().includes('<script>literal</script>')); assert.equal(h.all(n => ['script', 'img', 'iframe'].includes(n.type) || n.props.innerHTML).length, 0)
  assert.equal(h.all(n => n.type === 'a' && String(n.props.href).includes('historical_A')).length, 0)
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.equal(calls.getSavedInterviews.length, 0); assert.doesNotMatch(h.text(), /savedInterviewFiles\.|savedInterviews\./); assert.deepEqual(h.warnings, [])
})

test('historical preview and results qualify recorded status, coverage, limits and unknown provenance', async t => {
  const { h } = await setup(t, filePath)
  const rows = Array.from({ length: 100 }, (_, i) => record('twitter', String(100-i)))
  const data = observation({ records: rows, sources: { twitter: source({ returned_count: 100, has_more: true, coverage: 'partial', warnings: ['row_limit'] }), reddit: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }) } })
  await choose(h, [file(data)])
  assert.match(h.text(h.byId('interviews-file-preview')), /historical|recorded/i); assert.match(h.text(), /unverified/i); assert.match(h.text(), /current.*authenticity|authenticity.*current/i)
  await h.click('interviews-file-open')
  assert.match(h.text(h.byId('interviews-source-twitter')), /recorded|historical/i); assert.match(h.text(h.byId('interviews-source-reddit')), /recorded|historical/i)
  assert.doesNotMatch(h.text(), /narrow the filters|more matching saved rows are available|current platform databases|the platform database is missing\./i)
  assert.match(h.text(), /recorded.*limit|limit.*recorded/i); assert.match(h.text(), /recorded.*filter|filter.*recorded/i)
})

test('local records, exact questions and paging retain full accepted download without a request', async t => {
  const { h, calls } = await setup(t, filePath)
  const rows = [...Array.from({ length: 27 }, (_, i) => record('twitter', String(30-i), { prompt: i < 26 ? 'Same\n prompt' : 'Same prompt' })), record('reddit', '9', { prompt: 'Same\n prompt' })]
  const data = observation({ records: rows }); await open(h, data)
  assert.equal(ids(h).length, 25); await h.click('interviews-next'); assert.equal(ids(h).length, 3)
  await h.click('interviews-questions-mode'); assert.equal(ids(h).length, 25); assert.equal(h.text(h.byId('interviews-question-prompt')), 'Same\n prompt')
  await h.click('interviews-next'); assert.equal(ids(h).length, 2)
  await h.click('interviews-download'); assert.equal(await h.downloads[0].blob.text(), JSON.stringify(data, null, 2) + '\n')
  assert.equal(calls.getSavedInterviews.length, 0)
})

test('new preview preserves accepted rows while cancel and clear retire precise callbacks and URLs', async t => {
  const { h } = await setup(t, filePath); await open(h); await h.click('interviews-download')
  const staleDownload = h.byId('interviews-download').props.onClick, staleClear = h.byId('interviews-file-clear').props.onClick
  const replacement = observation({ records: [record('twitter', '9', { response: 'REPLACEMENT' })] })
  await choose(h, [file(replacement, 'replacement.json')]); assert.ok(h.byId('interview-row-twitter:1')); assert.ok(h.byId('interviews-file-preview'))
  staleClear(event()); staleDownload(event()); await flush(); assert.ok(h.byId('interviews-results')); assert.ok(h.byId('interviews-file-preview')); assert.equal(h.downloads.length, 1); assert.deepEqual(h.revokedUrls, [h.downloads[0].url])
  const staleOpen = h.byId('interviews-file-open').props.onClick, staleCancel = h.byId('interviews-file-cancel').props.onClick
  await h.click('interviews-file-cancel'); staleOpen(event()); staleCancel(event()); await flush(); assert.equal(Boolean(h.byId('interviews-file-preview')), false); assert.ok(h.byId('interview-row-twitter:1'))
  await choose(h, [file(replacement, 'replacement.json')]); staleOpen(event()); staleCancel(event()); await flush(); assert.ok(h.byId('interviews-file-preview'))
  await h.click('interviews-file-open'); assert.ok(h.byId('interview-row-twitter:9')); staleClear(event()); await flush(); assert.ok(h.byId('interviews-results'))
  await h.click('interviews-file-clear'); assert.equal(Boolean(h.byId('interviews-results')), false); assert.equal(Boolean(h.byId('interviews-file-preview')), false)
})

test('later file selection wins against older success, error and finally', async t => {
  const { h } = await setup(t, filePath); await open(h)
  const first = deferredFile('old.json'), second = deferredFile('new.json', observation({ simulation_id: 'new_file' }))
  await choose(h, [first.value]); assert.ok(h.byId('interviews-file-loading')); await choose(h, [second.value])
  first.reject(new Error('PRIVATE_FILE_FAILURE')); await flush(); assert.ok(h.byId('interviews-file-loading')); assert.equal(Boolean(h.byId('interviews-file-error')), false)
  second.complete(observation({ simulation_id: 'new_file' })); await flush(); assert.ok(h.text(h.byId('interviews-file-preview')).includes('new_file'))
  await h.click('interviews-file-open'); const third = deferredFile(); await choose(h, [third.value]); await h.click('interviews-file-cancel'); third.complete(observation({ simulation_id: 'stale_file' })); await flush()
  assert.equal(Boolean(h.byId('interviews-file-preview')), false); assert.ok(h.text().includes('new_file')); assert.doesNotMatch(h.text(), /PRIVATE_FILE_FAILURE|stale_file/)
})

test('input captures FileList before reset, permits same-file reselection and rejects ambiguous selections', async t => {
  const { h } = await setup(t, filePath), chosen = file()
  let files = [chosen]
  const target = { get files() { return files }, get value() { return 'picked' }, set value(value) { assert.equal(value, ''); files = [] } }
  h.byId('interviews-file-input').props.onChange({ target }); await flush(); assert.ok(h.byId('interviews-file-preview'))
  await h.click('interviews-file-cancel'); await choose(h, [chosen]); assert.ok(h.byId('interviews-file-preview'))
  await choose(h, [chosen, chosen]); assert.equal(Boolean(h.byId('interviews-file-preview')), false); assert.ok(h.byId('interviews-file-error'))
  for (const name of ['', 'x'.repeat(1025), '😀'.repeat(513)]) { await choose(h, [file(observation(), name)]); assert.ok(h.byId('interviews-file-error')); assert.equal(Boolean(h.byId('interviews-file-preview')), false) }
  await choose(h, []); assert.equal(Boolean(h.byId('interviews-file-preview')), false)
})

test('invalid files retain accepted content and never show parser or file read exceptions', async t => {
  const { h } = await setup(t, filePath); await open(h)
  for (const value of [new File(['PRIVATE_INVALID_JSON'], 'invalid.json'), file({ success: true, data: observation() }), new File(['{}'], 'tiny.json')]) {
    await choose(h, [value]); assert.ok(h.byId('interviews-file-error')); assert.equal(Boolean(h.byId('interviews-file-preview')), false); assert.ok(h.byId('interviews-results')); assert.doesNotMatch(h.text(), /PRIVATE_INVALID_JSON/)
  }
})

test('retained live form, Apply, Refresh and edits are invalid across A to file to A', async t => {
  const { h, calls } = await setup(t); await resolve(calls.getSavedInterviews[0])
  const callbacks = [h.byId('interviews-form').props.onSubmit, h.byId('interviews-apply').props.onClick, h.byId('interviews-refresh').props.onClick, h.byId('interviews-agent-id').props.onInput, h.byId('interviews-platform').props.onChange]
  await h.navigate(filePath); await open(h)
  for (const fn of callbacks) fn(event('reddit')); await flush()
  assert.equal(h.router.currentRoute.value.name, 'SavedInterviewFiles'); assert.equal(calls.getSavedInterviews.length, 1); assert.ok(h.byId('interviews-results'))
  await h.navigate(livePath); await resolve(calls.getSavedInterviews[1]); for (const fn of callbacks) fn(event('reddit')); await flush()
  assert.equal(calls.getSavedInterviews.length, 2); assert.equal(h.byId('interviews-agent-id').props.value, ''); assert.ok(h.byId('interviews-results'))
})

test('file and API reads cannot cross modes and Back, Forward, query changes and unmount clear files', async t => {
  const { h, calls } = await setup(t); await h.navigate(filePath)
  await resolve(calls.getSavedInterviews[0]); assert.equal(Boolean(h.byId('interviews-results')), false)
  const pending = deferredFile(); await choose(h, [pending.value]); await h.back(); pending.complete(observation()); await flush(); assert.equal(Boolean(h.byId('interviews-file-preview')), false)
  await resolve(calls.getSavedInterviews[1]); await h.forward(); assert.equal(Boolean(h.byId('interviews-results')), false)
  await open(h); await h.navigate(filePath + '?ignored=1'); assert.equal(Boolean(h.byId('interviews-results')), false); assert.equal(calls.getSavedInterviews.length, 2)
  const last = deferredFile(); await choose(h, [last.value]); const staleInput = h.byId('interviews-file-input').props.onChange
  h.unmount(); last.complete(observation()); staleInput({ target: { files: [file()], value: 'x' } }); await flush(); assert.equal(h.root.children.length, 0); assert.equal(calls.getSavedInterviews.length, 2)
})

test('language switches preserve preview, accepted observation and current question', async t => {
  const { h } = await setup(t, filePath); await choose(h, [file()]); h.i18n.global.locale.value = 'zh'; await flush(); assert.ok(h.byId('interviews-file-preview'))
  await h.click('interviews-file-open'); await h.click('interviews-questions-mode'); h.i18n.global.locale.value = 'en'; await flush()
  assert.equal(h.text(h.byId('interviews-question-prompt')), 'Saved prompt'); assert.equal(h.byId('interviews-questions-mode').props['aria-pressed'], true); assert.doesNotMatch(h.text(), /savedInterviewFiles\./)
})

test('History and failed live views expose an independent file entry', async t => {
  const { h, calls } = await setup(t, '/'); assert.ok(h.byId('history-interview-files-link'))
  await h.click('history-interview-files-link'); assert.equal(h.router.currentRoute.value.name, 'SavedInterviewFiles'); assert.equal(calls.getSavedInterviews.length, 0)
  await h.navigate(livePath); calls.getSavedInterviews[0].reject(new Error('unavailable')); await flush()
  assert.ok(h.byId('interviews-files-link')); await h.click('interviews-files-link'); assert.equal(h.router.currentRoute.value.name, 'SavedInterviewFiles'); assert.equal(calls.getSavedInterviews.length, 1)
})

for (const step of ['blob', 'url', 'element', 'append', 'click']) test(`local export ${step} failures clean up and preserve accepted file`, async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath: filePath, downloadHooks: hooks }); t.after(() => h.unmount())
  await open(h); hooks[step] = () => { throw new Error('PRIVATE_DOWNLOAD') }; await h.click('interviews-download')
  assert.ok(h.byId('interviews-results')); assert.match(h.text(), /download could not be completed/i); assert.doesNotMatch(h.text(), /PRIVATE_DOWNLOAD/); assert.equal(h.anchors.some(a => a.attached), false)
  delete hooks[step]; await h.click('interviews-download'); assert.equal(h.downloads.length, 1); assert.equal(d.calls.getSavedInterviews.length, 0)
})

test('stale local input, group and paging handlers cannot act after a newer file session', async t => {
  const { h } = await setup(t, filePath)
  const rows = Array.from({ length: 27 }, (_, i) => record('twitter', String(30-i), { prompt: 'First' }))
  await open(h, observation({ records: rows })); await h.click('interviews-questions-mode')
  const oldInput = h.byId('interviews-file-input').props.onChange, oldSelect = h.byId('interviews-question-select').props.onChange, oldNext = h.byId('interviews-next').props.onClick, oldRecords = h.byId('interviews-records-mode').props.onClick
  const replacement = observation({ records: [record('twitter', '9', { prompt: 'Replacement' })] })
  await choose(h, [file(replacement)]); let read = false
  const obsolete = file(); obsolete.arrayBuffer = () => { read = true; return Promise.reject(new Error('STALE')) }
  oldInput({ target: { files: [obsolete], value: 'x' } }); oldSelect(event('question-0')); oldNext(event()); oldRecords(event()); await flush()
  assert.equal(read, false); assert.ok(h.byId('interviews-file-preview')); assert.equal(h.byId('interviews-questions-mode').props['aria-pressed'], true)
  await h.click('interviews-file-open'); oldSelect(event('question-0')); oldNext(event()); oldRecords(event()); await flush()
  assert.deepEqual(ids(h), ['interview-row-twitter:9']); assert.equal(h.byId('interviews-questions-mode').props['aria-pressed'], false)
})

test('a late successful file read cannot replace a newer accepted file or clear its error', async t => {
  const { h } = await setup(t, filePath), old = deferredFile()
  await choose(h, [old.value]); await open(h, observation({ simulation_id: 'new_file' }), 'new.json')
  await choose(h, [new File(['bad'], 'invalid.json')]); assert.ok(h.byId('interviews-file-error'))
  old.complete(observation()); await flush()
  assert.ok(h.byId('interviews-file-error')); assert.ok(h.text(h.byId('interviews-file-name')).includes('new.json')); assert.equal(Boolean(h.byId('interviews-file-preview')), false)
})

for (const step of ['blob', 'url', 'element', 'append', 'click']) test(`file selection during export ${step} retires its attempt without touching the new preview`, async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath: filePath, downloadHooks: hooks }); t.after(() => h.unmount())
  await open(h); const select = h.byId('interviews-file-input').props.onChange
  hooks[step] = () => { delete hooks[step]; select({ target: { files: [file(observation({ simulation_id: 'replacement' }))], value: 'x' } }); throw new Error('PRIVATE_RETIRED_DOWNLOAD') }
  await h.click('interviews-download')
  assert.ok(h.byId('interviews-file-preview')); assert.ok(h.text(h.byId('interviews-file-preview')).includes('replacement')); assert.equal(Boolean(h.byId('interviews-error')), false)
  assert.equal(h.anchors.some(a => a.attached), false); assert.equal(h.downloads.length, 0)
  await h.click('interviews-file-open'); await h.click('interviews-download'); assert.equal(h.downloads.length, 1); assert.equal(JSON.parse(await h.downloads[0].blob.text()).simulation_id, 'replacement')
})

test('failed old local export cannot revoke a reentrant replacement export', async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath: filePath, downloadHooks: hooks }); t.after(() => h.unmount())
  await open(h)
  hooks.click = () => { delete hooks.click; h.byId('interviews-download').props.onClick(event()); throw new Error('PRIVATE_REPLACED_DOWNLOAD') }
  await h.click('interviews-download')
  assert.equal(h.downloads.length, 1); assert.equal(h.revokedUrls.includes(h.downloads[0].url), false); assert.equal(h.anchors.some(a => a.attached), false); assert.equal(Boolean(h.byId('interviews-error')), false)
  await h.click('interviews-file-clear'); assert.ok(h.revokedUrls.includes(h.downloads[0].url)); assert.equal(d.calls.getSavedInterviews.length, 0)
})

for (const control of ['interviews-file-open', 'interviews-file-cancel', 'interviews-file-clear', 'select']) test(`URL cleanup reentrancy during ${control} cannot overwrite a retired file route`, async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath: filePath, downloadHooks: hooks }); t.after(() => h.unmount())
  await open(h)
  await choose(h, [file(observation({ simulation_id: 'pending_file' }), 'pending.json')])
  await h.click('interviews-download')
  // Commit a second real router route synchronously during URL cleanup, before
  // the original callback resumes. Navigation completion can reenter watchers.
  hooks.revoke = () => { delete hooks.revoke; h.router.currentRoute.value = h.router.resolve(filePath + '?new=1') }
  if (control === 'select') await choose(h, [file(observation({ simulation_id: 'stale_read' }))])
  else await h.click(control)
  assert.equal(h.router.currentRoute.value.fullPath, filePath + '?new=1')
  assert.equal(Boolean(h.byId('interviews-results')), false); assert.equal(Boolean(h.byId('interviews-file-preview')), false); assert.equal(Boolean(h.byId('interviews-file-loading')), false)
  assert.equal(Boolean(h.byId('interviews-file-error')), false); assert.equal(Boolean(h.byId('interviews-error')), false)
  assert.equal(d.calls.getSavedInterviews.length, 0)
})

for (const initialPath of [filePath, livePath]) test(`a download started during URL revocation supersedes the older attempt on ${initialPath}`, async t => {
  const d = deferredApi(), hooks = {}, h = await mountSavedInterviews({ api: d.api, initialPath, downloadHooks: hooks }); t.after(() => h.unmount())
  if (initialPath === filePath) await open(h)
  else await resolve(d.calls.getSavedInterviews[0])
  await h.click('interviews-download')
  hooks.revoke = () => { delete hooks.revoke; h.byId('interviews-download').props.onClick(event()) }
  await h.click('interviews-download')
  assert.equal(h.downloads.length, 2, 'the reentrant download must supersede the outer attempt before allocation')
  assert.deepEqual(h.revokedUrls, [h.downloads[0].url]); h.unmount()
  assert.deepEqual(h.revokedUrls, [h.downloads[0].url, h.downloads[1].url]); assert.equal(h.anchors.some(a => a.attached), false)
})
