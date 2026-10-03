// Run by guarded Python tests against an actual disposable Flask endpoint.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountRuntime, waitFor } from '../helpers/runtime-view-fixture.js'

const [baseURL, mode] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['local', 'cloud'].includes(mode))
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
const replies = []
service.interceptors.request.use(config => {
  requests.push(config)
  assert.equal(config.method, 'get')
  assert.equal(config.url, '/api/runtime/status')
  return config
})
service.interceptors.response.use(body => {
  replies.push(structuredClone(body))
  return body
})
const source = readFileSync(new URL('../../src/api/runtime.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')
  .replaceAll('export const ', 'const ')
const api = new Function('service', source + '\nreturn { getRuntimeStatus, acceptRuntimeSnapshot };')(service)
const view = await mountRuntime({ api, initialPath: '/runtime', locale: 'en' })
try {
  await waitFor(() => view.byId('results') && view.byId('download').props.disabled !== true)
  assert.equal(requests.length, 1)
  assert.equal(replies[0].success, true)
  const accepted = replies[0].data
  assert.equal(accepted.mode, mode)
  assert.equal(accepted.schema_version, 1)
  assert.equal(accepted.kind, 'mirofish_local_runtime_status')
  if (mode === 'local') {
    assert.equal(accepted.configuration.valid, true)
    assert.equal(accepted.configuration.chat_model, 'fixture <script>literal</script>')
    assert.equal(accepted.configuration.gateway_limits.max_concurrency, 2)
    assert.equal(accepted.gateway.state, 'running')
    assert.equal(accepted.gateway.limits.max_concurrency, 1)
    assert.equal(accepted.gateway.limits.max_output_tokens, 512)
    assert.equal(accepted.gateway.metrics.started_requests, 4)
    assert.equal(accepted.gateway.metrics.succeeded_requests, 3)
    assert.equal(accepted.gateway.metrics.failed_requests, 1)
    assert.equal(accepted.gateway.metrics.timed_out_requests, 0)
    assert.equal(accepted.gateway.metrics.cancelled_requests, 0)
    assert.equal(accepted.gateway.metrics.queued_requests, 0)
    assert.equal(accepted.gateway.metrics.active_requests, 0)
    assert.match(view.text(), /fixture <script>literal<\/script>/)
  } else {
    assert.equal(accepted.configuration, null)
    assert.equal(accepted.gateway.state, 'disabled')
    assert.equal(accepted.gateway.metrics, null)
    assert.doesNotMatch(view.text(), /fixture <script>/)
  }
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_MARKER/)
  assert.doesNotMatch(view.text(), /PRIVATE_MARKER/)
  await view.click('download')
  assert.equal(requests.length, 1, 'Download must reuse the accepted observation')
  assert.equal(view.downloads.length, 1)
  const firstDownload = view.downloads[0]
  assert.equal(firstDownload.filename, 'mirofish-local-runtime-status.json')
  const saved = JSON.parse(await firstDownload.blob.text())
  assert.deepEqual(saved, accepted)
  await view.click('refresh')
  await waitFor(() => requests.length === 2 && replies.length === 2 && view.byId('download').props.disabled !== true)
  assert.equal(replies[1].data.mode, mode)
  assert.notEqual(replies[1].data.observed_at, accepted.observed_at)
  assert.deepEqual(JSON.parse(await firstDownload.blob.text()), saved)
  assert.equal(requests.length, 2)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue runtime monitor passed')
} finally {
  view.unmount()
}
