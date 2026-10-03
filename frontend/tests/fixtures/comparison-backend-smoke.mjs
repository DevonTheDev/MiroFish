// Invoked by the guarded Python test with a disposable actual Flask server.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountComparison, waitFor } from '../helpers/comparison-view-fixture.js'

const baseURL = process.argv[2]
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)

// Execute the application's real Axios client and interceptors. Only Vite's
// build environment and language context are supplied by this Node test host.
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', index)(
  axios, { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL },
)
// Node transport has inherited proxy handling that the browser transport does
// not. Keep this test's disposable traffic explicitly loopback-only.
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const methods = []
service.interceptors.request.use(config => {
  methods.push(config.method)
  assert.equal(config.method, 'get')
  return config
})
const wrappers = readFileSync(new URL('../../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const api = new Function('service', wrappers + '\nreturn { getComparisonCandidates, compareSavedSimulations };')(service)
const view = await mountComparison({ api, initialPath: '/compare?left=sim_left&right=sim_right', locale: 'en' })
try {
  await waitFor(() => view.byId('results'))
  assert.match(view.text(view.byId('metric-recorded_actions')), /2.*4.*\+2/)
  assert.match(view.text(), /Scenario sim_left/)
  assert.match(view.text(), /fixture-local-model/)
  assert.doesNotMatch(view.text(), /SYNTHETIC_PRIVATE_MARKER/)
  await view.click('swap')
  await waitFor(() => view.byId('results'))
  assert.equal(view.router.currentRoute.value.query.left, 'sim_right')
  assert.match(view.text(view.byId('metric-recorded_actions')), /4.*2.*-2/)
  await view.change('right-select', 'sim_empty')
  await waitFor(() => view.byId('results'))
  assert.match(view.text(view.byId('metric-recorded_actions')), /4.*—.*—/)
  assert.ok(methods.length >= 4)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue comparison passed')
} finally {
  view.unmount()
}
