// Python owns disposable Flask/gateway/model fixtures. This script uses the
// actual suite editor exports, then forbids network while comparing the files.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountSuites, trialApi } from '../helpers/prompt-suites-view-fixture.js'
import { mountSuiteComparison } from '../helpers/prompt-suite-comparison-view-fixture.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['completed', 'truncated', 'json_completed', 'json_truncated'].includes(scenario))
const jsonChecks = scenario.startsWith('json_'), truncated = scenario.endsWith('truncated')
const caseCount = jsonChecks ? 4 : 3
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-suite-comparison-vite-'))
let proxy, suites, comparison
const restored = []
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const calls = [], logs = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  api.service.interceptors.request.use(config => { calls.push({ method: config.method, url: config.url }); return config })
  suites = await mountSuites({ api, timers: { setTimeout, clearTimeout } })
  await suites.waitFor(() => suites.byId('suite-run')?.props.disabled === true && !suites.byId('suite-stale'), { timeout: 15000 })
  let definition = { schema_version: 1, kind: 'mirofish_local_prompt_suite', name: 'Model comparison <literal>',
    cases: Array.from({ length: caseCount }, (_, index) => index + 1).map(number => ({ case_id: `12345678-1234-4234-9234-123456789ab${number}`,
      label: `Case ${number}`, system_prompt: 'Reply literally.', user_prompt: `PROMPT_BODY_PRIVATE case ${number}`,
      temperature: 0.2, max_output_tokens: 128, expected_text: (jsonChecks ? number === 4 : number < 3) ? 'yes' : null })) }
  const definitionText = JSON.stringify(definition)
  await suites.file({ name: 'suite.json', size: new TextEncoder().encode(definitionText).length, text: async () => definitionText })
  await suites.click('suite-import-use')
  await suites.click('suite-export-definition')
  assert.deepEqual(JSON.parse(await suites.downloads.at(-1).blob.text()), definition, 'Import preserves v1')
  if (jsonChecks) {
    const original = structuredClone(definition)
    for (let index = 0; index < 3; index++) {
      await suites.change(`suite-case-${index}-check_enabled`, true)
      await suites.change(`suite-case-${index}-check_kind`, 'json_object')
    }
    await suites.click('suite-export-definition')
    definition = JSON.parse(await suites.downloads.at(-1).blob.text())
    assert.deepEqual(definition, { ...original, schema_version: 2,
      cases: original.cases.map((item, index) => ({ ...item, check_kind: index < 3 ? 'json_object' : 'exact_text' })) })
    assert.equal(calls.filter(call => call.method === 'post').length, 0, 'Editing does not infer')
  }
  async function runAndExport(status, previousId = null) {
    await suites.submit('suite-form')
    await suites.waitFor(() => suites.byId('suite-run-report')?.props['data-status'] === status &&
      suites.text(suites.byId('suite-run-report')).includes('Model comparison') &&
      (previousId === null || !suites.text(suites.byId('suite-run-report')).includes(previousId)), { timeout: 40000 })
    await suites.click('suite-export-run')
    const content = await suites.downloads.at(-1).blob.text()
    const report = JSON.parse(content)
    assert.notEqual(report.run_id, previousId)
    return { content, report }
  }
  const baseline = await runAndExport('completed')
  assert.deepEqual(baseline.report.definition, definition)
  assert.equal(baseline.report.schema_version, jsonChecks ? 2 : 1)
  assert.equal(baseline.report.cases[0].check, 'mismatched')
  assert.equal(baseline.report.cases[1].check, 'matched')
  await api.service.post('/api/fixture/comparison-config')
  await suites.click('suite-refresh')
  await suites.waitFor(() => !suites.byId('suite-stale') && suites.byId('suite-run').props.disabled === false, { timeout: 15000 })
  const candidate = await runAndExport(truncated ? 'halted' : 'completed', baseline.report.run_id)
  assert.equal(candidate.report.cases[0].snapshot.run.configuration.model, 'fixture-candidate')
  assert.equal(baseline.report.cases[0].snapshot.run.configuration.model, 'fixture-baseline')
  assert.equal(calls.filter(call => call.method === 'post' && call.url === '/api/runtime/trials').length,
    caseCount + (truncated ? 1 : caseCount))
  if (jsonChecks) {
    assert.equal(baseline.report.cases[2].check, 'matched')
    assert.equal(baseline.report.cases[3].check, 'matched')
    assert.equal(candidate.report.cases[0].check, truncated ? 'not_evaluated' : 'matched')
    if (!truncated) {
      assert.equal(candidate.report.cases[1].check, 'mismatched', 'Overflow fails format check')
      assert.equal(candidate.report.cases[2].check, 'matched', 'Different JSON formatting remains valid')
    }
  }
  assert.deepEqual(suites.warnings, [])
  suites.unmount(); suites = null
  await proxy.close(); proxy = null

  // Compile/mount/import/compare/download after real inference is over and the
  // proxy is gone. Any accidental HTTP/fetch/socket path is a test failure.
  const reject = () => { throw new Error('Offline report comparison attempted network') }
  for (const [target, key] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net.Socket.prototype, 'connect'], [globalThis, 'fetch']]) {
    const previous = target[key]; target[key] = reject; restored.push(() => { target[key] = previous })
  }
  comparison = await mountSuiteComparison({ locale: truncated ? 'zh' : 'en',
    api: { getPromptTrials: reject, getPromptTrial: reject, startPromptTrial: reject } })
  const count = calls.length
  for (const [side, source] of [['baseline', baseline], ['comparison', candidate]]) {
    const blob = new Blob([source.content], { type: 'application/json' })
    await comparison.file(side, { name: `${side}.json`, size: blob.size, arrayBuffer: () => blob.arrayBuffer() })
    assert.ok(comparison.byId(`comparison-${side}-preview`))
    assert.ok(!comparison.byId(`comparison-${side}-accepted`), 'Preview alone does not accept a report')
    await comparison.click(`comparison-${side}-use`)
  }
  assert.ok(!comparison.byId('comparison-result'), 'Import does not compare automatically')
  await comparison.click('comparison-run')
  assert.ok(comparison.byId('comparison-result'))
  await comparison.click('comparison-export-json')
  const jsonText = await comparison.downloads.at(-1).blob.text()
  const captured = JSON.parse(jsonText)
  assert.deepEqual(captured.baseline, baseline.report)
  assert.deepEqual(captured.comparison, candidate.report)
  assert.equal(captured.schema_version, jsonChecks ? 2 : 1)
  assert.equal(captured.summary.shared, caseCount)
  assert.equal(captured.summary.paired_succeeded, truncated ? 0 : caseCount)
  assert.equal(captured.summary.evaluated_pairs, truncated ? 0 : jsonChecks ? 4 : 2)
  assert.equal(captured.summary.gained_matches, truncated ? 0 : 1)
  assert.equal(captured.summary.lost_matches, truncated ? 0 : 1)
  if (jsonChecks) {
    assert.ok(captured.rows.every(row => Object.hasOwn(row, 'check_transition') && !Object.hasOwn(row, 'exact_transition')))
    assert.equal(captured.rows[2].reply_equal, truncated ? null : false)
    assert.equal(captured.summary.retained_matches, truncated ? 0 : 2)
  }
  for (let index = 0; index < caseCount; index++) {
    assert.equal(captured.rows[index].case_id, definition.cases[index].case_id)
    const expected = !truncated
      ? candidate.report.cases[index].snapshot.run.request_duration_ms - baseline.report.cases[index].snapshot.run.request_duration_ms
      : null
    assert.equal(captured.rows[index].request_duration_delta_ms, expected)
  }
  assert.doesNotMatch(jsonText, /SECRET_|127\.0\.0\.1|https?:\/\//)
  assert.equal(comparison.all(node => node.type === 'script' || Object.hasOwn(node.props, 'innerHTML')).length, 0)
  await comparison.click('comparison-export-txt')
  assert.ok((await comparison.downloads.at(-1).blob.text()).includes(captured.captured_at))
  await comparison.click('comparison-export-json')
  assert.equal(await comparison.downloads.at(-1).blob.text(), jsonText)
  assert.equal(comparison.revokedUrls.length, comparison.downloads.length)
  assert.equal(comparison.removedAnchors.length, comparison.downloads.length)
  assert.deepEqual(comparison.warnings, [])
  assert.equal(calls.length, count)
  assert.deepEqual(logs, [])
  console.log('actual suite exports imported and compared offline')
} finally {
  comparison?.unmount()
  for (const restore of restored.reverse()) restore()
  suites?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
