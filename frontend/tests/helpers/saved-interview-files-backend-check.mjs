// Guarded Python supplies disposable SQLite/Flask. The production Axios client,
// compiled Vue scripts/templates, router, Blob and File byte reads are real.
// The custom renderer is an interaction host, not native-browser validation.
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountSavedInterviews, waitFor, flush } from './saved-interviews-view-fixture.js'

const [baseURL, mode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['files-roundtrip', 'files-filtered', 'files-states', 'files-missing', 'files-unreadable'].includes(mode))
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
let localRoute = false, localReads = null
service.interceptors.request.use(config => {
  requests.push(config)
  assert.equal(localRoute, false, 'Opening/reviewing a local interview file must never call the backend')
  assert.equal(config.method, 'get')
  assert.equal(config.baseURL, baseURL)
  assert.match(config.url, /^\/api\/simulation\/sim_(saved|unknown|empty|corrupt)\/saved-interviews$/)
  assert.ok(config.signal instanceof AbortSignal)
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
  return target[name] ?? (() => assert.fail(`Interview file review invoked unrelated API ${String(name)}`))
} })
const initialPath = mode === 'files-states' ? '/simulation/sim_unknown/interviews'
  : '/simulation/sim_saved/interviews' + (mode === 'files-filtered' ? '?platform=twitter&agent_id=9223372036854775807' : '')
const view = await mountSavedInterviews({ api, initialPath, locale: 'en' })
const event = () => ({ preventDefault() {}, stopPropagation() {} })
const rowIds = () => view.all(node => String(node.props['data-testid'] ?? '').startsWith('interview-row-'))
  .map(node => node.props['data-testid'].slice('interview-row-'.length))
const options = () => view.byId('interviews-question-select').children.filter(node => node.type === 'option')
const noAcceptedResult = () => {
  assert.equal(Boolean(view.byId('interviews-results')), false)
  assert.ok(!view.byId('interviews-download') || view.byId('interviews-download').props.disabled)
}
function remainsLocal() {
  assert.equal(localRoute, true)
  assert.equal(view.router.currentRoute.value.name, 'SavedInterviewFiles')
  assert.equal(view.router.currentRoute.value.fullPath, '/interview-files')
  assert.deepEqual(view.router.currentRoute.value.query, {})
  assert.equal(requests.length, localReads, 'File staging, review, grouping, pagination, clear, and export must be entirely local')
  assert.equal(observations.length, localReads)
}
function noMarkupExecution() {
  assert.equal(view.all(node => ['script', 'img', 'iframe'].includes(node.type) || node.props.innerHTML).length, 0)
}
function sourceText(platform) {
  const section = view.byId(`interviews-source-${platform}`)
  const summary = section.children.find(node => String(node.props.class ?? '').includes('source-summary'))
  assert.ok(summary, `${platform} source context must remain visible`)
  return view.text(summary)
}
async function liveAccepted(count) {
  await waitFor(() => observations.length === count && view.byId('interviews-results'))
  assert.equal(view.router.currentRoute.value.name, 'SavedInterviews')
  assert.equal(Boolean(view.byId('interviews-download').props.disabled), false)
  return observations.at(-1)
}
async function exactDownload(data) {
  const before = requests.length, downloadCount = view.downloads.length
  await view.click('interviews-download')
  assert.equal(view.downloads.length, downloadCount + 1)
  const downloaded = view.downloads.at(-1)
  assert.match(downloaded.filename, new RegExp(`^${data.simulation_id}.*interviews.*\\.json$`))
  assert.equal(await downloaded.blob.text(), JSON.stringify(data, null, 2) + '\n',
    'Re-download must retain the original full bare observation, including metadata and records outside the selected group/page')
  assert.deepEqual(JSON.parse(await downloaded.blob.text()), data)
  await flush()
  assert.equal(requests.length, before, 'Export must not refetch')
  if (localRoute) remainsLocal()
  return downloaded
}
async function openFilesRoute() {
  // First feature assertion lets the baseline fail after an actual accepted API
  // response and download, demonstrating the missing user entry point.
  const entry = view.byId('interviews-files-link')
  assert.ok(entry, 'Saved interviews needs its local saved-file reopening entry point')
  assert.equal(entry.props.href, '/interview-files')
  localReads = requests.length; localRoute = true
  await view.navigate(entry.props.href)
  remainsLocal()
  noAcceptedResult()
  assert.ok(view.byId('interviews-file-input'))
  assert.equal(Boolean(view.byId('interviews-form')), false)
  assert.equal(Boolean(view.byId('interviews-refresh')), false)
}
async function selectFile(file) {
  assert.ok(file instanceof File, 'The input must contain actual File bytes, not a pre-parsed observation object')
  const input = view.byId('interviews-file-input')
  assert.ok(input, 'File route needs a native file selection control')
  assert.equal(input.props.type, 'file')
  await input.props.onChange({ target: { files: [file], value: file.name } })
  await flush()
  await waitFor(() => view.byId('interviews-file-preview') || view.byId('interviews-file-error'))
  remainsLocal()
}
async function stage(downloaded, name = '<img onerror=alert(1)> Café 雪 interview.json', acceptedName = null) {
  const bytes = await downloaded.blob.arrayBuffer()
  const file = new File([bytes], name, { type: 'application/json' })
  assert.equal(await file.text(), await downloaded.blob.text())
  await selectFile(file)
  assert.equal(Boolean(view.byId('interviews-file-error')), false,
    'The app must accept its own actual backend-derived JSON export')
  const preview = view.byId('interviews-file-preview')
  assert.ok(preview, 'A successful read must stage a preview before explicit acceptance')
  assert.ok(view.text(preview).includes(name), 'The filename must remain literal in preview')
  assert.match(view.text(preview), /unverified historical file/i)
  assert.match(view.text(preview), /not authenticity, current source status or completeness/i)
  assert.ok(view.byId('interviews-file-open'))
  if (acceptedName === null) noAcceptedResult()
  else {
    assert.ok(view.byId('interviews-results'), 'Staging a replacement retains the explicitly accepted observation')
    assert.ok(view.text(view.byId('interviews-file-name')).includes(acceptedName),
      'Reading a new file cannot silently replace the accepted filename')
  }
  noMarkupExecution()
  remainsLocal()
  return file
}
async function accept(data, name) {
  await view.click('interviews-file-open')
  assert.ok(view.byId('interviews-results'))
  assert.equal(Boolean(view.byId('interviews-file-preview')), false)
  assert.equal(Boolean(view.byId('interviews-download').props.disabled), false)
  assert.ok(view.text(view.byId('interviews-file-name')).includes(name))
  assert.ok(view.text().includes(data.simulation_id))
  assert.ok(view.text().includes(data.observed_at))
  assert.match(view.text(), /unverified historical file/i)
  assert.match(view.text(), /not authenticity, current source status or completeness/i)
  assert.match(view.text(), /Recorded simulation:/)
  assert.match(view.text(), /Recorded filters:/)
  assert.match(view.text(), /Recorded observation time:/)
  assert.doesNotMatch(view.text(), /reads? (?:the )?current.*(?:databases|SQLite)/i)
  noMarkupExecution()
  remainsLocal()
}
async function allRows() {
  if (!view.byId('interviews-first').props.disabled) await view.click('interviews-first')
  const found = rowIds()
  let pages = 1
  while (!view.byId('interviews-next').props.disabled) {
    assert.ok(pages++ < 8, 'The bounded observation cannot exceed eight pages')
    await view.click('interviews-next')
    found.push(...rowIds())
  }
  remainsLocal()
  return found
}
async function reopen(downloaded, data) {
  await openFilesRoute()
  const file = await stage(downloaded)
  await accept(data, file.name)
  await exactDownload(data)
  return file
}

try {
  const data = await liveAccepted(1)
  const original = JSON.stringify(data)
  const downloaded = await exactDownload(data)
  console.log(`Actual SQLite/Flask/Axios export prepared: ${mode}, ${data.records.length} physical records`)

  if (mode === 'files-roundtrip') {
    assert.equal(data.records.length, 46)
    assert.equal(data.availability, 'partial')
    assert.deepEqual(data.records.map(row => row.record_id), [
      'twitter:9223372036854775807', ...Array.from({ length: 40 }, (_, i) => `twitter:${42 - i}`),
      'twitter:-9223372036854775808', 'reddit:4', 'reddit:3', 'reddit:2', 'reddit:1',
    ])
    const surrogate = data.records.find(row => row.prompt === 'Escaped lone surrogate: \ud800')
    assert.ok(surrogate, 'The actual endpoint must preserve JSON-escaped lone surrogates')
    assert.equal(surrogate.response, 'Saved \udfff reply')
    assert.ok((await downloaded.blob.text()).includes('\\ud800'))
    await openFilesRoute()
    assert.equal(requests[0].signal.aborted, true)
    assert.ok(view.revokedUrls.includes(downloaded.url))
    await stage(downloaded)
    const cancelledOpen = view.byId('interviews-file-open').props.onClick
    await view.click('interviews-file-cancel')
    cancelledOpen(event()); await flush()
    assert.equal(Boolean(view.byId('interviews-file-preview')), false)
    noAcceptedResult(); remainsLocal()
    const file = await stage(downloaded)
    await accept(data, file.name)
    assert.deepEqual(await allRows(), data.records.map(row => row.record_id))
    await view.click('interviews-first')
    assert.ok(view.text().includes('<img src=x onerror=alert(1)>{broken'))
    assert.match(view.text(), /not saved/i)
    assert.match(view.text(), /empty saved text/i)
    assert.match(view.text(), /truncated/i)
    assert.ok(data.records.some(row => row.payload_kind === 'missing' && row.warnings.includes('missing_payload')))
    assert.ok(data.records.some(row => row.payload_kind === 'raw' && row.warnings.includes('invalid_json')))
    assert.ok(data.records.some(row => row.payload_kind === 'raw' && row.warnings.includes('payload_truncated')))
    const sourceSummaries = ['twitter', 'reddit'].map(sourceText)
    await view.click('interviews-questions-mode')
    const prompt = '<script>File question & literal</script>\nCafé 雪 🐟'
    const exactPrompts = [prompt, 'Escaped lone surrogate: \ud800', '',
      prompt.replace('é', 'e\u0301'), prompt + ' ', prompt.toLowerCase(), 'Reddit-only question']
    const groupKeys = options().map(option => option.props.value)
    assert.equal(groupKeys.length, exactPrompts.length)
    assert.match(view.text(view.byId('interviews-question-ungrouped')), /\b4\b/)
    for (const [i, exactPrompt] of exactPrompts.entries()) {
      await view.change('interviews-question-select', groupKeys[i])
      const expected = data.records.filter(row => row.payload_kind === 'structured' && row.prompt === exactPrompt)
      assert.equal(view.text(view.byId('interviews-question-prompt')), exactPrompt)
      assert.equal(view.byId('interviews-first').props.disabled, true)
      assert.deepEqual(await allRows(), expected.map(row => row.record_id))
      for (const platform of ['twitter', 'reddit']) {
        const count = expected.filter(row => row.platform === platform).length
        assert.match(view.text(view.byId(`interviews-question-counts-${platform}`)), new RegExp(`\\b${count}\\b`))
      }
      assert.deepEqual(['twitter', 'reddit'].map(sourceText), sourceSummaries)
      await exactDownload(data)
    }
    assert.equal(data.records.filter(row => row.prompt === prompt).length, 35)
    await view.click('interviews-records-mode')
    assert.deepEqual(await allRows(), data.records.map(row => row.record_id))
    const oldExport = await exactDownload(data)
    const oldDownload = view.byId('interviews-download').props.onClick
    const oldMode = view.byId('interviews-questions-mode').props.onClick
    const downloadCount = view.downloads.length
    await selectFile(new File(['{"version":1,broken'], 'invalid.json', { type: 'application/json' }))
    assert.ok(view.byId('interviews-file-error'))
    assert.equal(Boolean(view.byId('interviews-file-preview')), false)
    assert.ok(view.byId('interviews-results'), 'An invalid replacement preserves the previous accepted observation')
    assert.ok(view.text(view.byId('interviews-file-name')).includes(file.name))
    assert.ok(view.revokedUrls.includes(oldExport.url))
    oldDownload(event()); oldMode(event()); await flush()
    assert.equal(view.downloads.length, downloadCount)
    assert.equal(view.byId('interviews-records-mode').props['aria-pressed'], true)
    remainsLocal()
    await exactDownload(data)
    const replaced = await stage(downloaded, 'Reopened original.json', file.name)
    await accept(data, replaced.name)
    const lastFile = await exactDownload(data)
    const fileDownload = view.byId('interviews-download').props.onClick
    localRoute = false
    await view.navigate(initialPath)
    const fresh = await liveAccepted(2)
    assert.equal(requests.length, 2, 'Returning explicitly to live observations performs one fresh read')
    assert.deepEqual(fresh.records, data.records)
    assert.ok(view.revokedUrls.includes(lastFile.url))
    assert.equal(Boolean(view.byId('interviews-file-name')), false)
    const beforeStale = view.downloads.length
    fileDownload(event()); await flush()
    assert.equal(view.downloads.length, beforeStale, 'A retained file download cannot export after returning to live')
    await exactDownload(fresh)
    await openFilesRoute()
    assert.equal(Boolean(view.byId('interviews-file-name')), false)
    assert.equal(Boolean(view.byId('interviews-file-preview')), false,
      'Returning to the file route cannot restore a previously accepted in-memory file')
  } else if (mode === 'files-filtered') {
    assert.deepEqual(data.filters, { platform: 'twitter', agent_id: '9223372036854775807' })
    assert.equal(data.records.length, 1)
    assert.equal(data.records[0].agent_id, '9223372036854775807')
    assert.equal(data.sources.reddit.status, 'not_requested')
    assert.equal(data.limits.response_bytes_per_platform, 4186112)
    await reopen(downloaded, data)
    assert.ok(view.text().includes('9223372036854775807'))
    assert.ok(view.text().includes('Selected Twitter reply'))
    assert.doesNotMatch(view.text(), /Unselected Twitter reply|Unselected Reddit reply/)
    assert.match(sourceText('reddit'), /not requested/i)
    await view.click('interviews-questions-mode')
    assert.equal(options().length, 1)
    assert.equal(view.text(view.byId('interviews-question-prompt')), 'Exact maximum ID')
    assert.deepEqual(await allRows(), [data.records[0].record_id])
    await exactDownload(data)
    const retainedDownload = view.byId('interviews-download').props.onClick
    const count = view.downloads.length
    await view.click('interviews-file-clear')
    retainedDownload(event()); await flush()
    noAcceptedResult(); remainsLocal()
    assert.equal(view.downloads.length, count)
    assert.equal(Boolean(view.byId('interviews-file-name')), false)
  } else if (mode === 'files-states') {
    let current = data, saved = downloaded
    for (const [i, simulationId] of ['sim_unknown', 'sim_empty', 'sim_corrupt'].entries()) {
      if (i > 0) {
        localRoute = false
        await view.navigate(`/simulation/${simulationId}/interviews`)
        current = await liveAccepted(i + 1)
        saved = await exactDownload(current)
      }
      assert.equal(current.simulation_id, simulationId)
      await reopen(saved, current)
      assert.deepEqual(rowIds(), [])
      if (simulationId === 'sim_unknown') {
        assert.equal(current.availability, 'unavailable')
        assert.ok(Object.values(current.sources).every(source => source.status === 'missing' && source.has_more === null))
        assert.match(view.text(view.byId('interviews-availability')), /unavailable/i)
        assert.doesNotMatch(view.text(), /(?:no|zero) matching (?:saved )?interviews/i)
      } else if (simulationId === 'sim_empty') {
        assert.equal(current.availability, 'complete')
        assert.ok(Object.values(current.sources).every(source => source.status === 'available' && source.has_more === false))
        assert.match(sourceText('twitter'), /file records zero matching interviews.*observation time/i)
        assert.match(sourceText('reddit'), /file records zero matching interviews.*observation time/i)
      } else {
        assert.equal(current.availability, 'partial')
        assert.equal(current.sources.reddit.status, 'unreadable')
        assert.match(sourceText('reddit'), /unreadable/i)
        assert.doesNotMatch(sourceText('reddit'), /(?:no|zero) matching (?:saved )?interviews/i)
        assert.doesNotMatch(view.text(), /PRIVATE_CORRUPT_DATABASE_CONTENT/)
      }
      await view.click('interviews-questions-mode')
      assert.equal(options().length, 0)
      await exactDownload(current)
    }
  } else {
    const unhealthy = mode.slice('files-'.length)
    assert.equal(data.records.length, 100)
    assert.equal(data.availability, 'partial')
    assert.deepEqual(data.records.map(row => row.row_id), Array.from({ length: 100 }, (_, i) => String(110 - i)))
    assert.equal(data.sources.twitter.has_more, true)
    assert.ok(data.sources.twitter.warnings.includes('row_limit'))
    assert.equal(data.sources.reddit.status, unhealthy)
    assert.equal(data.sources.reddit.has_more, null)
    await reopen(downloaded, data)
    assert.match(sourceText('twitter'), /additional matching rows were omitted at observation time/i)
    assert.match(sourceText('twitter'), /cannot establish whether those rows are still available/i)
    assert.match(sourceText('reddit'), /unknown|not known|could not|missing|unreadable/i)
    assert.doesNotMatch(view.text(), /PRIVATE_CORRUPT_DATABASE_CONTENT|Outside exported observation/)
    assert.deepEqual(await allRows(), data.records.map(row => row.record_id))
    await exactDownload(data)
    await view.click('interviews-questions-mode')
    assert.equal(options().length, 1)
    assert.equal(view.text(view.byId('interviews-question-prompt')), 'Limited saved question')
    assert.deepEqual(await allRows(), data.records.map(row => row.record_id))
    await exactDownload(data)
  }
  assert.equal(JSON.stringify(data), original, 'The backend observation must not be mutated by file review')
  noMarkupExecution()
  assert.deepEqual(view.warnings, [])
  if (localRoute) remainsLocal()
  console.log(`actual Flask/Axios/Vue saved interviews ${mode} passed; ${requests.length} explicit live GET reads; zero file-route reads`)
} finally {
  view.unmount()
}
