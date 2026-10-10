// Existing real Flask/Axios bridge + compiled production Vue/Router host.
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import axios from 'axios'
import { mountWorkflow, waitFor, flush } from './saved-interview-comparison-workflow-fixture.js'
import { readSavedInterviewFile } from '../../src/utils/savedInterviewFiles.js'

const [baseURL, mode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/); assert.equal(mode, 'windows')
const storage = process.env.MIRO_TEST_WINDOW_STORAGE
assert.equal(basename(storage), 'sim_saved'); assert.ok(storage.includes('/saved roots ?#%/'))
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
const expectedErrors = []
const service = new Function('axios', 'i18n', 'buildEnvironment', 'console', index)(axios,
  { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error: (...args) => expectedErrors.push(args) })
service.defaults.proxy = false; service.defaults.maxRedirects = 0; service.defaults.timeout = 5000
const requests = [], responses = []
let offline = false
service.interceptors.request.use(config => {
  assert.equal(offline, false, 'No API reads after exported files enter local review')
  assert.equal(config.method, 'get'); assert.equal(config.baseURL, baseURL)
  assert.equal(config.url, '/api/simulation/sim_saved/saved-interviews')
  requests.push(config); return config
})
service.interceptors.response.use(value => { responses.push(value.data); return value })
const wrapper = readFileSync(new URL('../../src/api/savedInterviews.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')
const api = new Function('service', wrapper + '\nreturn { getSavedInterviews };')(service)
const h = await mountWorkflow({ api, initialPath: '/simulation/sim_saved/interviews' })
async function settled(count) { await waitFor(() => responses.length === count && h.byId('interviews-results')) }
async function download(expected, control = 'interviews-download') {
  const before = requests.length; await h.click(control)
  const saved = h.downloads.at(-1)
  assert.equal(await saved.blob.text(), JSON.stringify(expected, null, 2) + '\n')
  const file = new File([await saved.blob.arrayBuffer()], saved.filename, { type: 'application/json' })
  assert.deepEqual(await readSavedInterviewFile(file), expected)
  assert.equal(requests.length, before); return file
}
async function select(file, control) {
  const target = { files: [file], value: 'selected' }
  h.byId(control).props.onChange({ target }); await waitFor(() => h.byId(control === 'interviews-file-input' ? 'interviews-file-preview' : 'interview-compare-preview'))
  assert.equal(target.value, '')
}
function context(control, data) {
  const text = h.text(h.byId(control))
  assert.ok(text.includes(data.window.before_row)); assert.ok(text.includes(data.window.source_revision))
}
try {
  await settled(1); const v1 = responses[0]; assert.equal(v1.version, 1)
  const v1File = await download(v1)
  await h.change('interviews-platform', 'twitter'); await h.input('interviews-agent-id', '0')
  await h.click('interviews-apply'); await settled(2)
  assert.equal(responses[1].version, 2); assert.equal(responses[1].window.before_row, null)
  assert.equal(responses[1].records.length, 100)
  await h.click('interviews-next'); await h.input('interviews-search', 'reply 190')
  const staleDownload = h.byId('interviews-download').props.onClick
  const staleOlder = h.byId('interviews-older').props.onClick
  await h.click('interviews-older'); staleOlder(); staleDownload(); await settled(3)
  assert.equal(responses[2].window.before_row, '106'); assert.equal(responses[2].records.length, 100)
  assert.equal(h.downloads.length, 1); assert.equal(requests.length, 3)
  await h.click('interviews-older'); await settled(4)
  const older = responses[3]; assert.equal(older.window.before_row, '6')
  assert.deepEqual(older.records.map(r => r.row_id), ['5', '4', '3', '2', '1'])
  assert.equal(h.byId('interviews-older').props.disabled, true)
  await h.click('interviews-questions-mode')
  const oldOption = h.byId('interviews-question-select').children.find(n => n.type === 'option' && h.text(n).includes('Old unique question'))
  assert.ok(oldOption); await h.change('interviews-question-select', oldOption.props.value)
  await h.input('interviews-search', 'reply 1')
  assert.ok(h.text().includes('<literal> saved reply 1 雪'))
  const olderFile = await download(older)
  await h.back(); await settled(5); assert.equal(responses[4].window.before_row, '106')
  await h.forward(); await settled(6); assert.deepEqual(responses[5].records, older.records)
  await h.click('interviews-refresh'); await settled(7); assert.equal(responses[6].window.before_row, null)
  await h.click('interviews-older'); await waitFor(() => h.byId('interviews-error'))
  assert.match(h.text(h.byId('interviews-error')), /changed/i)
  await flush(); assert.equal(requests.length, 8); assert.equal(expectedErrors.length, 1)
  assert.equal(h.byId('interviews-download').props.disabled, true)
  await h.click('interviews-refresh'); await settled(8); assert.equal(requests.length, 9)
  assert.equal(responses[7].window.before_row, null)
  assert.notEqual(responses[7].window.source_revision, older.window.source_revision)

  // Retire only disposable fixture storage after both files were exported.
  renameSync(storage, join(dirname(storage), 'sim_saved_retired')); assert.equal(existsSync(storage), false)
  offline = true
  await h.navigate('/interview-files'); await select(olderFile, 'interviews-file-input')
  context('interviews-file-window', older); await h.click('interviews-file-open')
  context('interviews-window', older)
  await h.input('interviews-search', 'reply 1'); assert.ok(h.text().includes('<literal> saved reply 1 雪'))
  await download(older)
  await h.navigate('/interview-files/compare')
  await select(v1File, 'interview-compare-file-input'); await h.click('interview-compare-accept-left')
  await select(olderFile, 'interview-compare-file-input'); context('interview-compare-preview-window', older)
  await h.click('interview-compare-accept-right'); context('interview-compare-right-window', older)
  const option = h.byId('interview-compare-question-select').children.find(n => n.type === 'option' && h.text(n).includes('Old unique question'))
  assert.ok(option); await h.change('interview-compare-question-select', option.props.value)
  await h.input('interview-compare-right-search', 'reply 1')
  assert.ok(h.text(h.byId('interview-compare-right-side')).includes('<literal> saved reply 1 雪'))
  await download(v1, 'interview-compare-left-download'); await download(older, 'interview-compare-right-download')
  assert.equal(requests.length, 9); assert.deepEqual(h.forbiddenCalls, []); assert.deepEqual(h.warnings, [])
  console.log('actual Flask/Axios/Vue saved interviews windows passed; exported older rows remain local after storage removal')
} finally { h.unmount() }
