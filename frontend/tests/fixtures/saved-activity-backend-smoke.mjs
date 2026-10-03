// Run by the guarded Python suite with a disposable actual Flask listener.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountSavedActivity, waitFor } from '../helpers/saved-activity-view-fixture.js'

const baseURL = process.argv[2]
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const observed = []
service.interceptors.request.use(config => {
  observed.push(config)
  assert.equal(config.method, 'get')
  assert.equal(config.url, '/api/simulation/sim_right/saved-actions')
  return config
})
const wrappers = readFileSync(new URL('../../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const api = new Function('service', wrappers + '\nreturn { getSavedActivity };')(service)
const view = await mountSavedActivity({
  api, initialPath: '/simulation/sim_right/activity?limit=1', locale: 'en',
})
try {
  await waitFor(() => view.byId('results') && /^[a-f0-9]{64}$/.test(view.router.currentRoute.value.query.revision || ''))
  const originalRevision = view.router.currentRoute.value.query.revision
  assert.match(view.text(view.byId('matched-count')), /\b4\b/)
  assert.ok(view.byId('action-row-twitter:1'))
  assert.doesNotMatch(view.text(), /CONFIG_ONLY_PRIVATE_MARKER/)

  await view.click('next')
  await waitFor(() => view.byId('results') && view.byId('action-row-twitter:2'))
  assert.equal(view.router.currentRoute.value.query.revision, originalRevision)
  assert.equal(Number(view.router.currentRoute.value.query.offset), 1)
  await view.click('next')
  await waitFor(() => view.byId('error'))
  assert.match(view.text(view.byId('error')), /changed|refresh/i)
  assert.equal(view.byId('results'), undefined)
  assert.ok(!view.byId('download') || view.byId('download').props.disabled)

  await view.click('refresh')
  await waitFor(() => view.byId('results') && view.router.currentRoute.value.query.revision !== originalRevision)
  assert.equal(Number(view.router.currentRoute.value.query.offset || 0), 0)
  assert.match(view.text(view.byId('matched-count')), /\b5\b/)
  const refreshedRevision = view.router.currentRoute.value.query.revision
  await view.change('platform', 'twitter')
  await view.change('agent-id', '0')
  await view.change('round-num', '3')
  await view.change('action-type', 'CREATE_POST')
  assert.ok(!view.byId('download') || view.byId('download').props.disabled)
  await view.click('apply')
  await waitFor(() => view.byId('results') && view.byId('action-row-twitter:5'))
  assert.match(view.text(view.byId('matched-count')), /\b1\b/)
  assert.equal(view.router.currentRoute.value.query.revision, refreshedRevision)
  assert.match(view.text(), /late saved action <script>literal<\/script>/)
  assert.ok(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length === 0)
  await view.click('download')
  assert.equal(view.downloads.length, 1)
  const file = view.downloads[0]
  const exported = JSON.parse(await file.blob.text())
  assert.match(file.filename, /\.json$/)
  assert.equal(exported.format_version, 1)
  assert.equal(exported.simulation_id, 'sim_right')
  assert.equal(exported.source_revision, refreshedRevision)
  assert.equal(exported.offset, 0)
  assert.equal(exported.limit, 1)
  assert.equal(exported.matched_count, 1)
  assert.equal(exported.returned_count, 1)
  assert.equal(exported.actions.length, 1)
  assert.equal(exported.actions[0].agent_id, '0')
  assert.equal(exported.actions[0].round_num, '3')
  assert.equal(exported.actions[0].success, false)
  assert.equal(JSON.parse(exported.actions[0].details_json).action_args.text,
    'late saved action <script>literal</script>')
  assert.doesNotMatch(JSON.stringify(exported), /CONFIG_ONLY_PRIVATE_MARKER/)
  await view.input('agent-id', '1')
  assert.ok(view.revokedUrls.includes(file.url))
  assert.equal(view.byId('download').props.disabled, true)
  assert.ok(observed.length >= 5)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue saved activity passed')
} finally {
  view.unmount()
}
