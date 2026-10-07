// Guarded Python workflows supply real disposable SQLite through Flask. The
// production Axios wrapper and compiled Vue/router execute in the host renderer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountSavedInterviews, waitFor, flush } from './saved-interviews-view-fixture.js'

const [baseURL, mode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['questions', 'questions-missing', 'questions-unreadable'].includes(mode))
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const requests = [], observations = []
service.interceptors.request.use(config => {
  assert.equal(config.method, 'get')
  assert.equal(config.baseURL, baseURL)
  assert.equal(config.url, '/api/simulation/sim_saved/saved-interviews')
  assert.deepEqual(config.params, {})
  assert.ok(config.signal instanceof AbortSignal)
  requests.push(config)
  return config
})
service.interceptors.response.use(envelope => {
  assert.equal(envelope.success, true)
  observations.push(envelope.data)
  return envelope
})
const wrappers = readFileSync(new URL('../../src/api/savedInterviews.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
const savedApi = new Function('service', wrappers + '\nreturn { getSavedInterviews };')(service)
const api = new Proxy(savedApi, { get(target, name) {
  return target[name] ?? (() => assert.fail(`Saved-question browsing invoked unrelated API ${String(name)}`))
} })
const view = await mountSavedInterviews({ api, initialPath: '/simulation/sim_saved/interviews', locale: 'en' })
const renderedRows = () => view.all(node => String(node.props['data-testid'] ?? '').startsWith('interview-row-'))
const rowIds = () => renderedRows().map(node => node.props['data-testid'].slice('interview-row-'.length))
const options = () => view.byId('interviews-question-select').children.filter(node => node.type === 'option')
const sourceText = () => Object.fromEntries(['twitter', 'reddit'].map(platform => {
  const section = view.byId(`interviews-source-${platform}`)
  const summary = section.children.find(node => String(node.props.class ?? '').includes('source-summary'))
  assert.ok(summary, `${platform} source summary stays visible`)
  return [platform, view.text(summary)]
}))
function usesSingleObservation() {
  assert.equal(requests.length, 1, 'Grouping, switching, paging, and downloading reuse the accepted observation')
  assert.equal(observations.length, 1)
}
function remainsLocal() {
  usesSingleObservation()
  assert.deepEqual(view.router.currentRoute.value.query, {})
  assert.equal(view.router.currentRoute.value.fullPath, '/simulation/sim_saved/interviews')
}
async function exactDownload(data) {
  const before = view.downloads.length
  await view.click('interviews-download')
  assert.equal(view.downloads.length, before + 1)
  const download = view.downloads.at(-1)
  assert.match(download.filename, /^sim_saved.*interviews.*\.json$/)
  assert.equal(await download.blob.text(), JSON.stringify(data, null, 2) + '\n',
    'Question selection must preserve the exact full accepted-observation export')
  assert.deepEqual(JSON.parse(await download.blob.text()), data)
  remainsLocal()
  return download
}
async function allDisplayedRows() {
  if (!view.byId('interviews-first').props.disabled) await view.click('interviews-first')
  const found = rowIds()
  let pages = 1
  while (!view.byId('interviews-next').props.disabled) {
    assert.ok(pages++ < 8, 'The existing observation cannot exceed eight 25-record pages')
    await view.click('interviews-next')
    found.push(...rowIds())
  }
  remainsLocal()
  return found
}
function countsFor(expected) {
  for (const platform of ['twitter', 'reddit']) {
    const text = view.text(view.byId(`interviews-question-counts-${platform}`))
    assert.match(text, new RegExp(`\\b${expected.filter(row => row.platform === platform).length}\\b`))
    assert.match(text, /observed records/i)
    assert.doesNotMatch(text, /respondents|participants|response rate|\d+\s*%/i)
  }
}
function noMarkupExecution() {
  assert.equal(view.all(node => ['script', 'img', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
}

try {
  await waitFor(() => observations.length === 1 && view.byId('interviews-results'))
  const data = observations[0], pristine = JSON.stringify(data)
  const fullSources = sourceText()
  assert.equal(view.byId('interviews-download').props.disabled, false)
  assert.equal(data.availability, 'partial')
  assert.equal(data.order, 'platform_then_row_desc')
  assert.equal(renderedRows().length, 25)
  await exactDownload(data)
  console.log(`Actual SQLite/Flask/Axios observation accepted: ${mode}, ${data.records.length} physical records`)

  // This is intentionally the first feature assertion: the untouched baseline
  // reaches the real accepted response and fails because this control is absent.
  assert.ok(view.byId('interviews-questions-mode'), 'Saved interviews needs the saved-question review control')
  await view.click('interviews-questions-mode')
  assert.deepEqual(sourceText(), fullSources)
  remainsLocal()

  if (mode === 'questions') {
    const prompt = '<script>Question & literal</script>\nCafé 雪 🐟'
    assert.equal(data.records.length, 47)
    assert.deepEqual(data.records.map(row => row.record_id), [
      'twitter:9223372036854775807',
      ...Array.from({ length: 40 }, (_, index) => `twitter:${42 - index}`),
      'twitter:-9223372036854775808',
      'reddit:5', 'reddit:4', 'reddit:3', 'reddit:2', 'reddit:1',
    ])
    assert.equal(data.sources.twitter.returned_count, 42)
    assert.equal(data.sources.reddit.returned_count, 5)
    assert.ok(Object.values(data.sources).every(source => source.has_more === false && source.coverage === 'partial'))
    const expected = data.records.filter(row => row.payload_kind === 'structured' && row.prompt === prompt)
    assert.equal(expected.length, 36)
    assert.equal(expected.filter(row => row.platform === 'twitter').length, 33)
    assert.equal(expected.filter(row => row.platform === 'reddit').length, 3)
    assert.equal(expected.filter(row => row.response === 'Repeated Twitter reply').length, 30)
    assert.equal(expected.filter(row => row.response === 'Repeated Reddit reply').length, 2)
    assert.equal(expected.filter(row => row.response === null).length, 2)
    assert.equal(expected.filter(row => row.response === '').length, 1)
    assert.ok(expected.some(row => row.agent_id === '9007199254740993'))
    assert.ok(expected.some(row => row.agent_id === '9223372036854775807'))
    const timestampOnly = expected.find(row => row.warnings.includes('timestamp_truncated'))
    assert.equal(timestampOnly.record_id, 'twitter:33')
    assert.equal(timestampOnly.truncated, true)
    assert.equal(timestampOnly.payload_kind, 'structured')
    assert.equal(data.records.find(row => row.record_id === 'twitter:41').payload_kind, 'raw')
    assert.ok(data.records.find(row => row.record_id === 'twitter:41').warnings.includes('payload_truncated'))
    const ungrouped = view.text(view.byId('interviews-question-ungrouped'))
    assert.match(ungrouped, /\b4\b/)
    assert.match(ungrouped, /ungrouped|not grouped/i)
    assert.equal(options().length, 7)
    const groupOptions = options().map(option => ({ key: option.props.value, text: view.text(option) }))
    assert.equal(new Set(groupOptions.map(option => option.key)).size, 7)
    assert.ok(groupOptions.every(option => typeof option.key === 'string' && !option.key.includes(prompt)))
    // First occurrence is the exact primary prompt at signed-64 maximum row ID.
    assert.equal(view.text(view.byId('interviews-question-prompt')), prompt)
    countsFor(expected)
    assert.ok(view.text().includes('9223372036854775807'))
    assert.match(view.text(), /not saved/i)
    assert.match(view.text(), /empty saved text/i)
    assert.match(view.text(), /truncated/i)
    noMarkupExecution()
    await exactDownload(data)
    assert.deepEqual(await allDisplayedRows(), expected.map(row => row.record_id),
      'Retain every repeated physical record, including both platforms and rows beyond page one')
    await exactDownload(data)

    // The expected order is independent of the utility: platform/physical row
    // order first encounters primary, empty, Unicode, prefix, space, case, Reddit.
    const exactPrompts = [prompt, '', prompt.replace('é', 'e\u0301'),
      'Interview instruction: ' + prompt, prompt + ' ', prompt.toLowerCase(),
      'Reddit-only question beyond first page']
    const allMembers = []
    for (const [index, exactPrompt] of exactPrompts.entries()) {
      await view.change('interviews-question-select', groupOptions[index].key)
      const expectedMembers = data.records.filter(row => row.payload_kind === 'structured' && row.prompt === exactPrompt)
      assert.equal(view.byId('interviews-first').props.disabled, true, 'Changing questions resets member pagination')
      const promptElement = view.byId('interviews-question-prompt')
      assert.equal(view.text(promptElement), exactPrompt, 'Full prompts remain literal, including the empty string')
      if (exactPrompt === '') assert.ok(promptElement.parent.children.some(node =>
        node.type === 'p' && view.text(node) === view.i18n.global.t('savedInterviews.emptyQuestion')),
      'The empty literal prompt needs its explicit label in the selected-question panel')
      countsFor(expectedMembers)
      assert.deepEqual(await allDisplayedRows(), expectedMembers.map(row => row.record_id))
      allMembers.push(...expectedMembers.map(row => row.record_id))
      assert.deepEqual(sourceText(), fullSources)
      await exactDownload(data)
    }
    assert.equal(allMembers.length, 43)
    assert.equal(new Set(allMembers).size, 43, 'No physical member belongs to two exact-prompt groups')
    assert.ok(groupOptions.some(option => /empty/i.test(option.text)), 'Empty string prompts need an explicit label')
    await view.click('interviews-records-mode')
    assert.equal(view.byId('interviews-first').props.disabled, true)
    assert.deepEqual(await allDisplayedRows(), data.records.map(row => row.record_id),
      'All four ungrouped records remain reachable in canonical record order')
    await exactDownload(data)
  } else {
    const unhealthy = mode.slice('questions-'.length)
    assert.equal(data.records.length, 100)
    assert.equal(data.sources.twitter.returned_count, 100)
    assert.equal(data.sources.twitter.has_more, true)
    assert.equal(data.sources.twitter.coverage, 'partial')
    assert.ok(data.sources.twitter.warnings.includes('row_limit'))
    assert.equal(data.sources.reddit.status, unhealthy)
    assert.equal(data.sources.reddit.returned_count, 0)
    assert.equal(data.sources.reddit.has_more, null)
    assert.equal(data.sources.reddit.coverage, 'unavailable')
    assert.equal(options().length, 1)
    assert.equal(view.text(view.byId('interviews-question-prompt')), 'Limited repeated question')
    countsFor(data.records)
    assert.match(sourceText().twitter, /more.*matching.*rows/i)
    assert.match(sourceText().reddit, /unknown|not known|could not|missing|unreadable/i)
    assert.doesNotMatch(sourceText().reddit, /no matching saved interviews/i)
    assert.doesNotMatch(view.text(), /PRIVATE_CORRUPT_DATABASE_CONTENT|Outside the bounded observation/)
    assert.deepEqual(await allDisplayedRows(), data.records.map(row => row.record_id))
    assert.deepEqual(data.records.map(row => row.row_id), Array.from({ length: 100 }, (_, index) => String(110 - index)))
    assert.deepEqual(sourceText(), fullSources)
    await exactDownload(data)
    await view.click('interviews-records-mode')
    assert.deepEqual(await allDisplayedRows(), data.records.map(row => row.record_id))
  }
  assert.equal(JSON.stringify(data), pristine, 'Browsing must not mutate the full accepted response')
  assert.equal(view.warnings.length, 0, view.warnings.join('\n'))
  noMarkupExecution()
  remainsLocal()
  await view.click('interviews-questions-mode')
  remainsLocal()
  const retainedControls = ['interviews-records-mode', 'interviews-questions-mode',
    'interviews-first', 'interviews-next', 'interviews-download']
    .map(id => view.byId(id).props.onClick)
  const retainedSelection = view.byId('interviews-question-select').props.onChange
  const retainedKey = options().at(-1).props.value
  const downloadCount = view.downloads.length
  view.unmount()
  for (const invoke of retainedControls) invoke()
  retainedSelection({ target: { value: retainedKey } })
  await flush()
  // Vue Router resets its route when its last app unmounts. Retained controls
  // must still leave the disposed view, accepted data, requests and exports alone.
  usesSingleObservation()
  assert.equal(view.root.children.length, 0)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(view.downloads.length, downloadCount)
  assert.equal(JSON.stringify(data), pristine)
  assert.equal(view.warnings.length, 0, view.warnings.join('\n'))
  console.log(`actual Flask/Axios/Vue saved interviews ${mode} passed`)
} finally {
  view.unmount()
}
