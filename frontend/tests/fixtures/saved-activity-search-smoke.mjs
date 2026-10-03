// Driven by guarded Python tests over an actual disposable Flask endpoint.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountSavedActivity, waitFor } from '../helpers/saved-activity-view-fixture.js'

const baseURL = process.argv[2]
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const requests = []
service.interceptors.request.use(config => {
  requests.push(config)
  assert.equal(config.method, 'get')
  assert.equal(config.url, '/api/simulation/sim_right/saved-actions')
  return config
})
const wrappers = readFileSync(new URL('../../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const api = new Function('service', wrappers + '\nreturn { getSavedActivity };')(service)
const view = await mountSavedActivity({ api, initialPath: '/simulation/sim_right/activity?limit=1' })
const phrase = '[topic]+ STRASSE'
async function applyAndWait(recordId) {
  await view.click('apply')
  await waitFor(() => view.byId('results') && view.byId('action-row-' + recordId))
}
async function setCase(checked) {
  const control = view.byId('case-sensitive')
  assert.ok(control, 'case-sensitive search control is required')
  control.props.onChange({ target: { checked } })
  await view.flush()
}
try {
  await waitFor(() => view.byId('results') && /^[a-f0-9]{64}$/.test(view.router.currentRoute.value.query.revision || ''))
  const revision = view.router.currentRoute.value.query.revision
  assert.ok(view.byId('search-phrase'), 'saved activity needs a phrase search control')
  await view.input('search-phrase', phrase)
  assert.equal(view.byId('download').props.disabled, true)
  await applyAndWait('twitter:5')
  assert.match(view.text(view.byId('matched-count')), /\b3\b/)
  assert.match(view.text(), /Discuss \[topic\]\+ Straße <script>literal<\/script>/)
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.equal(view.router.currentRoute.value.query.q, phrase)
  assert.equal(view.router.currentRoute.value.query.revision, revision)

  await view.click('next')
  await waitFor(() => view.byId('action-row-twitter:6'))
  assert.equal(view.router.currentRoute.value.query.offset, '1')
  assert.equal(view.router.currentRoute.value.query.q, phrase)
  await setCase(true)
  await applyAndWait('twitter:6')
  assert.equal(view.router.currentRoute.value.query.offset, '0')
  assert.equal(view.router.currentRoute.value.query.case_sensitive, 'true')
  assert.match(view.text(view.byId('matched-count')), /\b1\b/)

  await setCase(false)
  await view.change('outcome', 'failed')
  await applyAndWait('twitter:5')
  assert.match(view.text(view.byId('matched-count')), /\b1\b/)
  await view.change('outcome', 'unknown')
  await view.change('platform', 'twitter')
  await view.input('agent-id', '0')
  await view.input('round-num', '4')
  await view.input('action-type', 'CREATE_POST')
  await applyAndWait('twitter:7')
  assert.match(view.text(view.byId('matched-count')), /\b1\b/)
  assert.match(view.text(), /\[topic\]\+ Straße unknown/)
  assert.doesNotMatch(view.text(), /CONFIG_ONLY_PRIVATE_MARKER/)
  assert.equal(view.router.currentRoute.value.query.revision, revision)
  await view.click('download')
  assert.equal(view.downloads.length, 1)
  const download = view.downloads[0]
  const report = JSON.parse(await download.blob.text())
  assert.deepEqual(report.filters, {
    platform: 'twitter', agent_id: '0', round_num: '4', action_type: 'CREATE_POST',
    q: phrase, case_sensitive: false, outcome: 'unknown',
  })
  assert.equal(report.source_revision, revision)
  assert.equal(report.matched_count, 1)
  assert.equal(report.returned_count, 1)
  assert.equal(report.actions[0].success, null)
  assert.equal(report.actions[0].match_preview, '[topic]+ Straße unknown')
  assert.equal(JSON.parse(report.actions[0].details_json).result.note, '[topic]+ Straße unknown')
  assert.equal(report.actions[0].agent_id, '0')
  assert.equal(report.actions[0].round_num, '4')
  await view.input('search-phrase', 'next search')
  assert.ok(view.revokedUrls.includes(download.url))
  assert.equal(view.byId('results'), undefined)
  assert.equal(view.byId('download').props.disabled, true)
  assert.ok(requests.length >= 6)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue activity search passed')
} finally {
  view.unmount()
}
