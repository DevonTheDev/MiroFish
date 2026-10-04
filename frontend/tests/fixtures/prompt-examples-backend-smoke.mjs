// Python owns only disposable local inference fixtures. Review/export starts
// after the proxy closes and all HTTP/fetch/socket entry points are forbidden.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountSuites, trialApi } from '../helpers/prompt-suites-view-fixture.js'
import { mountPromptExamplesApp } from '../helpers/prompt-examples-view-fixture.js'
import { parsePromptSuiteReport } from '../../src/utils/promptSuites.js'

const [backendURL, scenario, outputPath] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['completed', 'truncated'].includes(scenario))
const truncated = scenario === 'truncated'
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-prompt-examples-vite-'))
let proxy, suites, examples
const restored = []
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const logs = [], calls = [], replies = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  api.service.interceptors.request.use(config => { calls.push({ method: config.method, url: config.url }); return config })
  api.service.interceptors.response.use(response => { replies.push(structuredClone(response.data)); return response })
  suites = await mountSuites({ api, timers: { setTimeout, clearTimeout }, cacheHandlers: true })
  await suites.waitFor(() => replies.some(reply => reply.data?.kind === 'mirofish_local_prompt_trials'), { timeout: 15000 })
  const definition = { schema_version: 3, kind: 'mirofish_local_prompt_suite', name: 'Review captured examples',
    cases: Array.from({ length: 3 }, (_, index) => ({
      case_id: `12345678-1234-4234-9234-123456789ab${index}`, label: `Case ${index + 1}`,
      system_prompt: index === 0 ? '' : index === 1 ? ' \t ' : 'Unselected system prompt',
      user_prompt: index === 2 ? 'UNSELECTED_EXAMPLE_MUST_NOT_EXPORT' : `PROMPT_BODY_PRIVATE: example ${index + 1} <literal> 雪`,
      temperature: 0.2, max_output_tokens: 128, check_kind: 'json_fields', expected_text: null,
      required_fields: [{ name: 'ok', type: 'boolean' }],
    })) }
  const text = JSON.stringify(definition)
  await suites.file({ name: 'suite.json', size: new TextEncoder().encode(text).length, text: async () => text })
  await suites.click('suite-import-use')
  await suites.submit('suite-form')
  await suites.waitFor(() => suites.byId('suite-run-report')?.props['data-status'] === (truncated ? 'halted' : 'completed'), { timeout: 35000 })
  await suites.click('suite-export-run')
  const raw = await suites.downloads.at(-1).blob.text()
  const source = parsePromptSuiteReport(raw)
  assert.equal(source.cases[0].status, truncated ? 'truncated' : 'succeeded')
  assert.equal(source.cases[1].status, truncated ? 'not_attempted' : 'succeeded')
  assert.equal(calls.filter(call => call.method === 'post').length, truncated ? 1 : 3)
  suites.unmount(); suites = null
  await proxy.close(); proxy = null

  const reject = () => { throw new Error('Offline reviewed examples attempted network') }
  for (const [target, key] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net.Socket.prototype, 'connect'], [globalThis, 'fetch']]) {
    const previous = target[key]; target[key] = reject; restored.push(() => { target[key] = previous })
  }
  examples = await mountPromptExamplesApp({ locale: truncated ? 'zh' : 'en', cacheHandlers: true,
    api: { getPromptTrials: reject, getPromptTrial: reject, startPromptTrial: reject } })
  const count = calls.length
  const file = new Blob([raw], { type: 'application/json' })
  await examples.file({ name: '<captured run>.json', size: file.size, arrayBuffer: () => file.arrayBuffer() })
  assert.ok(examples.byId('examples-preview'))
  assert.ok(!examples.byId('examples-accepted'))
  await examples.click('examples-use')
  assert.ok(examples.byId('examples-accepted'))
  for (let i = 0; i < 3; i++) assert.equal(examples.byId(`examples-row-${i}-target`).props.value, '')
  assert.equal(examples.byId('examples-build').props.disabled, true, 'Recorded outcomes never auto-approve examples')

  const targets = [truncated ? '{"ok":false}' : source.cases[0].snapshot.run.response.content, '{"ok":true}\n']
  if (truncated) {
    assert.ok(!examples.byId('examples-row-0-copy') || examples.byId('examples-row-0-copy').props.disabled)
    await examples.input('examples-row-0-target', targets[0])
  } else {
    await examples.click('examples-row-0-copy')
    assert.equal(examples.byId('examples-row-0-target').props.value, targets[0])
    assert.equal(examples.byId('examples-build').props.disabled, true, 'Copy is draft-only')
  }
  await examples.click('examples-row-0-approve')
  await examples.input('examples-row-1-target', targets[1])
  await examples.click('examples-row-1-approve')
  await examples.click('examples-build')
  assert.ok(examples.byId('examples-bundle'))
  await examples.click('examples-export-jsonl')
  const jsonl = await examples.downloads.at(-1).blob.text()
  await examples.click('examples-export-review')
  const reviewText = await examples.downloads.at(-1).blob.text()
  const review = JSON.parse(reviewText)
  const lines = jsonl.trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(review.examples.length, 2)
  assert.equal(review.source_summary.run_id, source.run_id)
  for (let index = 0; index < 2; index++) {
    const item = definition.cases[index]
    const expected = [...(item.system_prompt === '' ? [] : [{ role: 'system', content: item.system_prompt }]),
      { role: 'user', content: item.user_prompt }, { role: 'assistant', content: targets[index] }]
    assert.deepEqual(lines[index], { messages: expected })
    assert.deepEqual(review.examples[index].messages, expected)
    assert.deepEqual(review.examples[index].source_input, source.definition.cases[index])
    assert.deepEqual(review.examples[index].source_row, source.cases[index])
    assert.equal(review.examples[index].captured_reply_equal, truncated ? null : index === 0)
    assert.equal(review.examples[index].target_check, truncated || index === 1 ? 'matched' : 'mismatched')
  }
  assert.doesNotMatch(jsonl + reviewText, /UNSELECTED_EXAMPLE_MUST_NOT_EXPORT|unused-test-key|127\.0\.0\.1/)
  assert.equal(examples.all(node => node.type === 'script' || Object.hasOwn(node.props, 'innerHTML')).length, 0)
  await examples.click('examples-export-jsonl')
  assert.equal(await examples.downloads.at(-1).blob.text(), jsonl)
  assert.equal(examples.revokedUrls.length, examples.downloads.length)
  assert.equal(examples.removedAnchors.length, examples.downloads.length)
  assert.equal(calls.length, count)
  assert.deepEqual(examples.warnings, [])
  assert.deepEqual(logs, [])
  await writeFile(outputPath, JSON.stringify({ jsonl, review: reviewText }))
  console.log('actual suite replies reviewed and exported offline')
} finally {
  examples?.unmount()
  for (const restore of restored.reverse()) restore()
  suites?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
