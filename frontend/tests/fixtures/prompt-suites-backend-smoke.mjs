// Guarded Python owns the actual Flask backend, gateway and synthetic model.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountSuites, trialApi } from '../helpers/prompt-suites-view-fixture.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['sequence', 'lost', 'unknown', 'stop', 'leave', 'cloud', 'truncated', 'empty'].includes(scenario))
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-prompt-suite-vite-'))
let proxy, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  assert.ok(loaded?.config.server.proxy['/api'])
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const logs = [], calls = [], replies = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  // Supplied metadata checks the actual local proxy path; this is not a native
  // browser-generated-header or rendered-layout claim.
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  let lostPost = false, lostRead = false
  api.service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: config.data })
    assert.ok(config.url.startsWith('/api/runtime/trials'))
    return config
  })
  api.service.interceptors.response.use(response => {
    replies.push(structuredClone(response.data))
    assert.equal(response.headers['cache-control'], 'no-store')
    if (['lost', 'unknown'].includes(scenario) && response.config.method === 'post' && !lostPost) {
      lostPost = true
      throw new Error('Synthetic lost POST response')
    }
    if (scenario === 'unknown' && lostPost && !lostRead && response.config.method === 'get' &&
      /^\/api\/runtime\/trials\/[a-f0-9-]+$/.test(response.config.url)) {
      lostRead = true
      throw new Error('Synthetic lost exact observation')
    }
    return response
  })
  view = await mountSuites({ api, timers: { setTimeout, clearTimeout } })
  await view.waitFor(() => replies.some(reply => reply.data?.kind === 'mirofish_local_prompt_trials'), { timeout: 15000 })
  await view.flush()
  assert.ok(calls.length >= 1 && calls.every(call => call.method === 'get'), 'Mount is passive')

  const replyFor = prompt => scenario === 'empty' ? '' : '<think>literal reasoning</think>\n<script>literal reply</script>\n' + prompt
  const definition = { schema_version: 1, kind: 'mirofish_local_prompt_suite', name: 'Five captured <cases>',
    cases: Array.from({ length: 5 }, (_, index) => {
      const prompt = `PROMPT_BODY_PRIVATE: case ${index + 1} <literal> 雪`
      return { case_id: `12345678-1234-4234-9234-123456789ab${index}`, label: `Case ${index + 1}`,
        system_prompt: 'Preserve literal text.', user_prompt: prompt, temperature: 0.2,
        max_output_tokens: 128, expected_text: index === 1 ? 'Deliberate mismatch' : index === 2 ? null : replyFor(prompt) }
    }) }
  const raw = JSON.stringify(definition)
  const beforeImport = calls.length
  await view.file({ name: 'suite.json', size: new TextEncoder().encode(raw).length, text: async () => raw })
  assert.ok(view.byId('suite-import-preview'))
  assert.equal(view.byId('suite-name').props.value, '', 'Preview does not replace the draft')
  await view.click('suite-import-use')
  assert.equal(view.byId('suite-name').props.value, definition.name)
  assert.equal(calls.length, beforeImport, 'Definition import performs no inference or reads')
  await view.click('suite-export-definition')
  assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), definition)
  assert.equal(calls.length, beforeImport)

  if (scenario === 'cloud') {
    assert.equal(view.byId('suite-run').props.disabled, true)
    assert.equal(calls.filter(call => call.method === 'post').length, 0)
    assert.match(view.text(), /local mode/)
  } else {
    await view.submit('suite-form')
    await view.waitFor(() => replies.some(reply => reply.data?.run), { timeout: 15000 })
    if (scenario === 'leave') {
      await view.navigate('/reports')
      const count = calls.length
      await pause(3300)
      assert.equal(calls.length, count, 'Retired suite schedules no further requests')
      assert.equal(calls.filter(call => call.method === 'post').length, 1)
    } else {
      if (scenario === 'stop') await view.click('suite-stop')
      const expectedStatus = ['truncated', 'unknown'].includes(scenario) ? 'halted' : scenario === 'stop' ? 'stopped' : 'completed'
      await view.waitFor(() => view.byId('suite-run-report')?.props['data-status'] === expectedStatus, { timeout: 35000 })
      if (scenario === 'unknown') {
        assert.ok(lostPost && lostRead)
        assert.equal(view.byId('suite-result-0').props['data-status'], 'unknown')
        await view.click('suite-reconcile')
        await view.waitFor(() => view.byId('suite-result-0')?.props['data-status'] === 'succeeded', { timeout: 15000 })
        await pause(1700)
        assert.equal(view.byId('suite-run-report').props['data-status'], 'halted', 'Reconciliation does not resume the suite')
      }
      const beforeExport = calls.length
      await view.click('suite-export-run')
      const report = JSON.parse(await view.downloads.at(-1).blob.text())
      assert.equal(calls.length, beforeExport, 'Captured run download performs no requests')
      assert.equal(report.status, expectedStatus)
      assert.deepEqual(report.definition, definition)
      assert.equal(report.cases.length, 5)
      const attempted = ['sequence', 'lost', 'empty'].includes(scenario) ? 5 : 1
      assert.equal(calls.filter(call => call.method === 'post').length, attempted)
      for (let index = 0; index < report.cases.length; index++) {
        const result = report.cases[index]
        if (index >= attempted) {
          assert.equal(result.status, 'not_attempted')
          assert.equal(result.request_id, null)
          assert.equal(result.snapshot, null)
          assert.equal(result.check, 'not_evaluated')
          continue
        }
        assert.equal(result.status, scenario === 'truncated' ? 'truncated' : 'succeeded')
        assert.equal(result.snapshot.run.request.user_prompt, definition.cases[index].user_prompt)
        assert.equal(result.snapshot.run.response.content, replyFor(definition.cases[index].user_prompt))
        assert.equal(result.snapshot.run.configuration.model, 'fixture-local-chat')
        assert.deepEqual(result.snapshot.run.response.usage, { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 })
        assert.equal(result.check, scenario === 'truncated' ? 'not_evaluated' : index === 1 ? 'mismatched' : index === 2 ? 'not_requested' : 'matched')
      }
      if (scenario === 'lost') {
        assert.ok(lostPost)
        assert.ok(calls.some(call => call.method === 'get' && call.url.endsWith('/' + report.cases[0].request_id)))
      }
      assert.doesNotMatch(JSON.stringify(report), /SECRET_/)
      // Draft edits retain the accepted run, including when it halted earlier.
      await view.input('suite-name', 'A later draft')
      await view.input('suite-case-0-user_prompt', 'A future prompt')
      await view.click('suite-export-run')
      assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), report)
      assert.equal(calls.length, beforeExport)
      assert.equal(view.revokedUrls.length, view.downloads.length)
    }
  }
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(logs, [], 'Dedicated transport does not log private errors')
  console.log('actual proxy/Flask/gateway/Axios/Vue prompt suites passed')
} finally {
  view?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
