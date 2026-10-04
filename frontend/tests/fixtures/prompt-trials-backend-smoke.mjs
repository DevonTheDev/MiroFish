// Guarded Python owns Flask, the inference gateway and synthetic local model.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountTrials, trialApi } from '../helpers/prompt-trials-view-fixture.js'
import { mountSuites } from '../helpers/prompt-suites-view-fixture.js'
import { parsePromptSuiteDefinition, acceptPromptSuiteReport } from '../../src/utils/promptSuites.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['succeeded', 'truncated', 'lost', 'leave', 'cloud', 'empty', 'controls', 'reopen', 'reopen_offline', 'reopen_single',
  'suite_builder', 'suite_builder_imported', 'suite_builder_offline'].includes(scenario))
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
  const mount = scenario.startsWith('suite_builder') ? mountSuites : mountTrials
  view = await mount({ api, initialPath: '/prompt-trials', timers: { setTimeout, clearTimeout }, cacheHandlers: true })
  await view.waitFor(() => replies.some(reply => reply.data?.kind === 'mirofish_local_prompt_trials'), { timeout: 15000 })
  await view.flush()
  assert.ok(calls.length >= 1)
  assert.ok(calls.every(call => call.method === 'get'), 'Mount must only observe')
  if (scenario === 'cloud') {
    assert.equal(view.byId('trial-run').props.disabled, true)
    assert.match(view.text(), /only in local mode/)
  } else {
    async function start(label, prompt, settings = {}) {
      for (const [key, value] of Object.entries({ label, system_prompt: 'Preserve literal text.',
        user_prompt: prompt, temperature: '0.2', max_output_tokens: '128', ...settings })) {
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
      const singleBlob = view.downloads.at(-1).blob
      assert.equal(calls.length, count, 'Download uses the accepted observation')
      assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), accepted)
      assert.equal(calls.filter(call => call.method === 'post').length, 1)
      if (scenario === 'lost') {
        assert.equal(lost, true)
        assert.ok(calls.some(call => call.method === 'get' && call.url.endsWith('/' + accepted.run.request_id)))
      }
      if (['succeeded', 'reopen', 'reopen_offline', 'reopen_single',
        'suite_builder', 'suite_builder_imported', 'suite_builder_offline'].includes(scenario)) {
        await view.click('trial-pin')
        await start('Second trial', 'PROMPT_BODY_PRIVATE: second response', scenario.startsWith('suite_builder')
          ? { system_prompt: ' \t\n', temperature: '0.7', max_output_tokens: '64' } : {})
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
        if (scenario.startsWith('suite_builder')) {
          if (scenario === 'suite_builder_imported') {
            const savedBlob = view.downloads.at(-1).blob
            view.unmount()
            view = await mountSuites({ api, initialPath: '/prompt-trials', timers: { setTimeout, clearTimeout }, cacheHandlers: true })
            await view.waitFor(() => view.byId('trial-download')?.props.disabled === false)
            const control = view.byId('trial-import-file')
            await control.props.onChange({ target: { files: [{ name: '<captured trials>.json', size: savedBlob.size,
              arrayBuffer: () => savedBlob.arrayBuffer() }], value: 'selected' } })
            await view.waitFor(() => view.byId('trial-import-preview'))
            await view.click('trial-import-add')
            assert.match(view.text(), /historical/i)
          }
          if (scenario === 'suite_builder_offline') {
            await proxy.close(); proxy = null
            await view.click('trial-refresh')
            await view.waitFor(() => view.byId('trial-error'))
            assert.equal(view.byId('trial-run').props.disabled, true)
          }
          const beforeBuild = calls.length
          await view.input('trial-suite-name', 'Reusable <literal> trials 雪')
          // Selection order differs deliberately: the definition follows displayed pin order.
          await view.change('trial-suite-select-' + second.run.request_id, true)
          await view.change('trial-suite-select-' + accepted.run.request_id, true)
          await view.click('trial-suite-build')
          assert.ok(view.byId('trial-suite-preview'))
          await view.click('trial-suite-download')
          const definitionText = await view.downloads.at(-1).blob.text()
          const definition = parsePromptSuiteDefinition(definitionText)
          assert.equal(definition.name, 'Reusable <literal> trials 雪')
          assert.equal(definition.schema_version, 1)
          assert.deepEqual(definition.cases.map(({ case_id, expected_text, ...inputs }) => {
            assert.equal(expected_text, null, 'Recorded replies never become expected answers')
            assert.ok(![accepted.run.request_id, second.run.request_id].includes(case_id))
            return inputs
          }), [accepted.run.request, second.run.request])
          assert.notEqual(definition.cases[0].case_id, definition.cases[1].case_id)
          assert.doesNotMatch(definitionText, /fixture-local-chat|fingerprint|request_id|<think>/)
          await view.click('trial-suite-download')
          assert.equal(await view.downloads.at(-1).blob.text(), definitionText)
          assert.equal(calls.length, beforeBuild, 'Selection, Build and download perform no runtime work')
          if (scenario !== 'suite_builder_offline') {
            const repliesBeforeNavigation = replies.length
            await view.navigate('/prompt-suites')
            await view.waitFor(() => replies.length > repliesBeforeNavigation)
            await view.flush()
            const beforeImport = calls.length
            await view.file({ name: 'prompt_suite.definition.json', size: new TextEncoder().encode(definitionText).length,
              text: async () => definitionText })
            assert.ok(view.byId('suite-import-preview'))
            assert.equal(view.byId('suite-name').props.value, '', 'Preview alone does not adopt inputs')
            await view.click('suite-import-use')
            assert.equal(view.byId('suite-name').props.value, definition.name)
            assert.equal(calls.length, beforeImport, 'Import and adoption do not run the suite')
            assert.equal(view.byId('suite-run').props.disabled, false)
            await view.submit('suite-form')
            await view.waitFor(() => view.byId('suite-run-report')?.props['data-status'] === 'completed', { timeout: 25000 })
            await view.click('suite-export-run')
            const report = acceptPromptSuiteReport(JSON.parse(await view.downloads.at(-1).blob.text()))
            assert.deepEqual(report.definition, definition)
            assert.ok(report.cases.every(row => row.status === 'succeeded' && row.check === 'not_requested'))
            assert.ok(report.cases.every(row => ![accepted.run.request_id, second.run.request_id].includes(row.request_id)))
            assert.equal(calls.filter(call => call.method === 'post').length, 4)
            assert.deepEqual(report.cases.map(row => row.snapshot.run.request), [accepted.run.request, second.run.request])
          } else assert.equal(calls.filter(call => call.method === 'post').length, 2)
        }
        if (scenario.startsWith('reopen')) {
          const savedBlob = scenario === 'reopen_single' ? singleBlob : view.downloads.at(-1).blob
          view.unmount()
          let offlineReads = 0
          if (scenario === 'reopen_offline') {
            await proxy.close(); proxy = null
            view = await mountTrials({ api: { ...api,
              getPromptTrials: async () => { offlineReads++; throw new Error('Synthetic offline backend') },
              getPromptTrial: async () => assert.fail('Import resumed a historical request'),
              startPromptTrial: async () => assert.fail('Offline import started inference'),
            } })
            await view.waitFor(() => view.byId('trial-error'))
            assert.equal(offlineReads, 1)
          } else {
            view = await mountTrials({ api, timers: { setTimeout, clearTimeout } })
            await view.waitFor(() => view.byId('trial-download')?.props.disabled === false)
          }
          const expectedComparison = scenario === 'reopen_single'
            ? { ...comparison, trials: [accepted, replies.at(-1).data] } : comparison
          const beforeImport = calls.length
          const control = view.byId('trial-import-file')
          assert.ok(control, 'Saved trial files need an explicit import control')
          await control.props.onChange({ target: { files: [{ name: '<saved comparison>.json',
            size: savedBlob.size, arrayBuffer: () => savedBlob.arrayBuffer() }], value: 'selected' } })
          await view.waitFor(() => view.byId('trial-import-preview'))
          assert.equal(view.byId('pin-item-' + accepted.run.request_id), undefined, 'Preview does not add pins')
          assert.equal(view.byId('trial-user_prompt').props.value, '', 'Preview does not alter the draft')
          await view.click('trial-import-add')
          if (scenario === 'reopen_single') {
            assert.equal(view.byId('pin-item-' + second.run.request_id), undefined)
            await view.click('trial-pin') // Compare the reopened file with the current live observation.
          }
          for (const saved of [accepted, second]) {
            assert.ok(view.byId('pin-item-' + saved.run.request_id))
            await view.change('pin-select-' + saved.run.request_id, true)
          }
          assert.equal(calls.length, beforeImport, 'Reopening and comparing use only captured bytes')
          assert.match(view.text(), /historical/i)
          await view.click('comparison-download')
          assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), expectedComparison)
          await view.click('pin-reuse-' + accepted.run.request_id)
          assert.equal(view.byId('trial-user_prompt').props.value, accepted.run.request.user_prompt)
          assert.equal(calls.length, beforeImport, 'Reuse only populates the draft')
          if (scenario === 'reopen_offline') {
            assert.equal(view.byId('trial-run').props.disabled, true, 'Historical available=true cannot enable Run')
            assert.equal(offlineReads, 1)
          } else {
            await view.submit('trial-form')
            await view.waitFor(() => view.byId('trial-download')?.props.disabled === false &&
              calls.filter(call => call.method === 'post').length === 3, { timeout: 20000 })
            const current = replies.filter(reply => reply.data?.run?.state === 'succeeded').at(-1).data
            assert.notEqual(current.run.request_id, accepted.run.request_id)
            assert.notEqual(current.run.request_id, second.run.request_id)
            assert.deepEqual(current.run.request, accepted.run.request)
            assert.equal(current.run.configuration.model, 'fixture-local-chat')
            assert.equal(current.run.response.content, accepted.run.response.content)
          }
        }
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
