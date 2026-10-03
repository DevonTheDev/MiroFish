// Guarded Python owns Flask, the inference gateway and synthetic local model.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountTrials, trialApi } from '../helpers/prompt-trials-view-fixture.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['succeeded', 'truncated', 'lost', 'leave', 'cloud', 'empty', 'controls'].includes(scenario))
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-prompt-trial-vite-'))
let proxy, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  assert.ok(loaded?.config.server.proxy['/api'])
  proxy = await createServer({
    ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`

  if (scenario !== 'cloud') {
    // These are supplied browser-like headers, not a native-browser test. The
    // actual configured proxy must retain the distinction for route admission.
    for (const [origin, site] of [['https://example.invalid', 'cross-site'],
      ['http://127.0.0.1:65534', 'same-site']]) {
      const response = await fetch(baseURL + '/api/runtime/trials', {
        headers: { Origin: origin, 'Sec-Fetch-Site': site },
      })
      assert.equal(response.status, 403)
      assert.doesNotMatch(await response.text(), /PROMPT_BODY_PRIVATE|SECRET_/)
    }
  }

  const logs = [], calls = [], replies = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  let lost = false
  api.service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: config.data })
    assert.ok(config.url.startsWith('/api/runtime/trials'))
    return config
  })
  api.service.interceptors.response.use(response => {
    replies.push(structuredClone(response.data))
    assert.equal(response.headers['cache-control'], 'no-store')
    if (scenario === 'lost' && response.config.method === 'post' && !lost) {
      lost = true
      throw new Error('Synthetic lost POST response')
    }
    return response
  })
  view = await mountTrials({ api, timers: { setTimeout, clearTimeout } })
  await view.waitFor(() => replies.some(reply => reply.data?.kind === 'mirofish_local_prompt_trials'), { timeout: 15000 })
  await view.flush()
  assert.ok(calls.length >= 1)
  assert.ok(calls.every(call => call.method === 'get'), 'Mount must only observe')
  if (scenario === 'cloud') {
    assert.equal(view.byId('trial-run').props.disabled, true)
    assert.match(view.text(), /only in local mode/)
  } else {
    async function start(label, prompt) {
      for (const [key, value] of Object.entries({ label, system_prompt: 'Preserve literal text.',
        user_prompt: prompt, temperature: '0.2', max_output_tokens: '128' })) {
        await view.input('trial-' + key, value)
      }
      await view.submit('trial-form')
    }
    const prompt = 'PROMPT_BODY_PRIVATE: first <literal>'
    await start('First <trial>', prompt)
    if (scenario === 'leave') {
      await view.waitFor(() => replies.some(reply => reply.data?.run?.state === 'running'), { timeout: 15000 })
      await view.navigate('/reports')
      const count = calls.length
      await pause(1700)
      assert.equal(calls.length, count, 'Leaving retires observation')
      assert.equal(calls.filter(call => call.method === 'post').length, 1)
    } else {
      await view.waitFor(() => view.byId('trial-download')?.props.disabled === false, { timeout: 20000 })
      const accepted = replies.filter(reply => reply.data?.run?.state !== 'running' && reply.data?.run).at(-1).data
      assert.equal(accepted.run.state, scenario === 'truncated' ? 'truncated' : 'succeeded')
      assert.equal(accepted.run.request.user_prompt, prompt)
      const expectedReply = scenario === 'empty' ? '' : scenario === 'controls' ? '\u0000\u001b[31m exact controls\n' + prompt
        : '<think>literal reasoning</think>\n<script>literal reply</script>\n' + prompt
      assert.equal(accepted.run.response.content, expectedReply)
      assert.deepEqual(accepted.run.response.usage, { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 })
      if (['empty', 'controls'].includes(scenario)) assert.equal(accepted.run.response.refusal, '')
      else {
        assert.match(view.text(), /<think>literal reasoning<\/think>/)
        assert.match(view.text(), /<script>literal reply<\/script>/)
      }
      assert.doesNotMatch(JSON.stringify(replies), /SECRET_/)
      const count = calls.length
      await view.click('trial-download')
      assert.equal(calls.length, count, 'Download uses the accepted observation')
      assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), accepted)
      assert.equal(calls.filter(call => call.method === 'post').length, 1)
      if (scenario === 'lost') {
        assert.equal(lost, true)
        assert.ok(calls.some(call => call.method === 'get' && call.url.endsWith('/' + accepted.run.request_id)))
      }
      if (scenario === 'succeeded') {
        await view.click('trial-pin')
        await start('Second trial', 'PROMPT_BODY_PRIVATE: second response')
        await view.waitFor(() => view.byId('trial-download')?.props.disabled === false &&
          replies.some(reply => reply.data?.run?.request.label === 'Second trial' && reply.data.run.state === 'succeeded'), { timeout: 20000 })
        const second = replies.filter(reply => reply.data?.run?.request.label === 'Second trial' && reply.data.run.state === 'succeeded').at(-1).data
        await view.click('trial-pin')
        await view.change('pin-select-' + accepted.run.request_id, true)
        await view.change('pin-select-' + second.run.request_id, true)
        assert.equal(view.all(node => node.props['data-testid']?.startsWith('comparison-') && node.props['data-testid'] !== 'comparison-download').length, 2)
        const beforeDownload = calls.length
        await view.click('comparison-download')
        assert.equal(calls.length, beforeDownload)
        const comparison = JSON.parse(await view.downloads.at(-1).blob.text())
        assert.deepEqual(comparison.trials, [accepted, second])
        assert.equal(calls.filter(call => call.method === 'post').length, 2)
      }
    }
  }
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(logs, [], 'Dedicated transport does not log private request errors')
  console.log('actual proxy/Flask/gateway/Axios/Vue prompt trials passed')
} finally {
  view?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
