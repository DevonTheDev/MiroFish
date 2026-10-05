// Python owns real Flask/gateway and an explicitly gated synthetic model.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountTrials, trialApi } from '../helpers/prompt-trials-view-fixture.js'
import { parsePromptTrialFile } from '../../src/utils/promptTrialFiles.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['cancel', 'cancel_lost'].includes(scenario))
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-trial-cancel-vite-'))
let proxy, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const calls = [], replies = [], logs = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  api.service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: config.data })
    return config
  })
  let lost = false
  api.service.interceptors.response.use(response => {
    replies.push(structuredClone(response.data))
    assert.equal(response.headers['cache-control'], 'no-store')
    if (scenario === 'cancel_lost' && response.config.url.endsWith('/cancel') && !lost) {
      lost = true
      throw new Error('Synthetic lost cancellation acknowledgement')
    }
    return response
  })
  view = await mountTrials({ api, initialPath: '/prompt-trials', timers: { setTimeout, clearTimeout }, cacheHandlers: true })
  await view.waitFor(() => view.byId('trial-run')?.props.disabled === false, { timeout: 15000 })
  assert.ok(calls.every(call => call.method === 'get'))
  async function start(label, prompt) {
    for (const [key, value] of Object.entries({ label, system_prompt: 'Preserve literal text.',
      user_prompt: prompt, temperature: '0.2', max_output_tokens: '128' })) await view.input('trial-' + key, value)
    await view.submit('trial-form')
  }
  await start('Stop this <trial>', 'PROMPT_BODY_PRIVATE: stopped request')
  await view.waitFor(() => view.byId('trial-stop'), { timeout: 15000 })
  const accepted = replies.find(reply => reply.data?.run?.request.label === 'Stop this <trial>').data
  assert.equal(accepted.run.state, 'running')
  assert.match(accepted.run.instance_id, /^[a-f0-9-]{36}$/)
  // Wait for the real provider to enter its gate, not an arbitrary timing guess.
  const until = Date.now() + 5000
  while (!(await (await fetch(backendURL + '/__test_trial_model/entered')).json()).entered) {
    assert.ok(Date.now() < until, 'Synthetic provider did not receive the trial')
    await pause(10)
  }
  await view.waitFor(() => view.byId('trial-stop'), { timeout: 5000 })
  await view.click('trial-stop')
  await view.waitFor(() => view.byId('trial-download')?.props.disabled === false, { timeout: 15000 })
  const stopCalls = calls.filter(call => call.url.endsWith('/cancel'))
  assert.equal(stopCalls.length, 1)
  assert.equal(stopCalls[0].url, `/api/runtime/trials/${accepted.run.request_id}/cancel`)
  assert.deepEqual(JSON.parse(JSON.stringify(stopCalls[0].data)),
    { instance_id: accepted.run.instance_id, fingerprint: accepted.run.fingerprint })
  assert.equal(calls.filter(call => call.method === 'post' && call.url === '/api/runtime/trials').length, 1)
  assert.ok(!view.byId('trial-stop'))
  assert.match(view.text(), /Cancelled/)
  assert.match(view.text(), /model server may continue/i)
  const count = calls.length
  await view.click('trial-download')
  const exported = await view.downloads.at(-1).blob.text()
  const cancelled = JSON.parse(exported)
  assert.equal(calls.length, count)
  assert.equal(cancelled.run.request_id, accepted.run.request_id)
  assert.equal(cancelled.run.instance_id, accepted.run.instance_id)
  assert.equal(cancelled.run.state, 'cancelled')
  assert.equal(cancelled.run.error_code, 'user_cancelled')
  assert.equal(cancelled.run.response, null)
  assert.equal(cancelled.run.cleanup.state, 'succeeded')
  assert.deepEqual(parsePromptTrialFile(exported).snapshots[0], cancelled)
  await view.click('trial-pin')
  assert.ok(view.byId(`pin-item-${accepted.run.request_id}`))
  assert.equal(calls.length, count)
  if (scenario === 'cancel_lost') {
    assert.ok(lost)
    assert.ok(calls.some(call => call.method === 'get' && call.url === `/api/runtime/trials/${accepted.run.request_id}`))
  }
  await fetch(backendURL + '/__test_trial_model/release', { method: 'POST' })
  await start('After stop', 'PROMPT_BODY_PRIVATE: later explicit request')
  await view.waitFor(() => view.byId('trial-download')?.props.disabled === false, { timeout: 15000 })
  await view.click('trial-download')
  const later = JSON.parse(await view.downloads.at(-1).blob.text())
  assert.equal(later.run.state, 'succeeded')
  assert.notEqual(later.run.instance_id, accepted.run.instance_id)
  assert.notEqual(later.run.request_id, accepted.run.request_id)
  assert.equal(calls.filter(call => call.method === 'post').length, 3)
  assert.doesNotMatch(JSON.stringify(replies), /SECRET_/)
  assert.deepEqual(logs, [])
  assert.deepEqual(view.warnings, [])
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  console.log('actual proxy/Flask/gateway/Axios/Vue prompt trials passed')
} finally {
  view?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
