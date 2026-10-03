// Invoked by Python against a disposable actual Flask service and saved logs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountRunCaptures, runCapturesApi, waitFor } from '../helpers/run-captures-view-fixture.js'

const [baseURL, mode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
const source = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', source)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 8000
const wrappers = readFileSync(new URL('../../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const existing = new Function('service', wrappers + '\nreturn { getComparisonCandidates };')(service)
const api = { ...runCapturesApi(service), ...existing }
if (mode === 'lost-response') {
  const save = api.saveRunCapture
  let lose = true
  api.saveRunCapture = async (...args) => {
    const response = await save(...args)
    if (lose) { lose = false; throw new Error('Synthetic response loss after commit') }
    return response
  }
}
const left = 'a'.repeat(32), right = 'b'.repeat(32)
const uuid = id => () => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
async function saveCapture(id, label) {
  const view = await mountRunCaptures({ api, initialPath: '/captures?simulation=sim_left', crypto: { randomUUID: uuid(id) } })
  try {
    await view.click('preview')
    await waitFor(() => view.byId('preview-observation'))
    await view.input('label', label)
    await view.input('note', 'Literal <script>note</script>\nRecorded attempts, including failure')
    await view.click('save')
    await waitFor(() => view.byId('saved-capture'))
    assert.match(view.text(), /Saved run status/)
    assert.ok(view.text().includes(label))
    assert.doesNotMatch(view.text(), /SYNTHETIC_PRIVATE_MARKER/)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
}
await saveCapture(left, 'Before rerun')
await service.post('/__test/rerun')
await saveCapture(right, 'After rerun')
await service.post('/__test/remove-originals')
if (mode === 'recovery') await service.post('/__test/crash-writer')
const view = await mountRunCaptures({ api, initialPath: `/captures?left=${left}&right=${right}&capture=${left}` })
try {
  if (mode === 'recovery') {
    await waitFor(() => view.byId('recover-store'))
    assert.equal(view.byId('comparison'), undefined)
    await view.click('recover-store')
  }
  await waitFor(() => view.byId('comparison') && !view.byId('download-capture').props.disabled)
  const row = view.text(view.byId('metric-recorded_actions'))
  assert.match(row, mode === 'partial' ? /2.*5.*—/ : /2.*5.*\+3/)
  assert.match(view.text(), /Before rerun/)
  assert.match(view.text(), /After rerun/)
  assert.match(view.text(), /which model actually ran/)
  assert.equal(view.all(node => node.type === 'script').length, 0)
  await view.click('download-capture')
  await view.click('download-comparison')
  const saved = JSON.parse(await view.downloads[0].blob.text())
  const pair = JSON.parse(await view.downloads[1].blob.text())
  assert.equal(saved.capture_id, left)
  assert.equal(saved.observation.summary.metrics.recorded_actions, 2)
  assert.equal(pair.left.capture_id, left)
  assert.equal(pair.right.capture_id, right)
  assert.equal(pair.left.observation.summary.simulation_id, pair.right.observation.summary.simulation_id)
  assert.equal(pair.differences.recorded_actions, mode === 'partial' ? null : 3)
  assert.equal(pair.differences.platforms.reddit.recorded_actions, null)
  assert.equal(view.downloads[0].filename, 'mirofish-run-capture.json')
  assert.equal(view.downloads[1].filename, 'mirofish-run-capture-comparison.json')
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue saved run captures passed')
} finally { view.unmount() }
