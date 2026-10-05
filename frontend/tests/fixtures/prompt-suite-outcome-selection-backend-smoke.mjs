// Actual saved captures, preview selection and fresh subset inference through
// Flask, Vite's proxy, Axios, the compiled Vue page and a synthetic local model.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountSuites, trialApi } from '../helpers/prompt-suites-view-fixture.js'
import { parsePromptSuiteDefinition, parsePromptSuiteReport } from '../../src/utils/promptSuites.js'

const [backendURL] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-suite-outcome-selection-vite-'))
let proxy, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const calls = [], logs = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  api.service.interceptors.request.use(config => { calls.push({ method: config.method, url: config.url, data: config.data }); return config })
  view = await mountSuites({ api, timers: { setTimeout, clearTimeout }, cacheHandlers: true, locale: 'zh' })
  await view.waitFor(() => !view.byId('suite-stale'), { timeout: 15000 })
  const original = { schema_version: 3, kind: 'mirofish_local_prompt_suite', name: 'Recorded <outcomes> 雪',
    cases: ['none', 'exact_text', 'json_fields'].map((kind, index) => ({
      case_id: `12345678-1234-4234-9234-123456789ab${index}`, label: `Case ${index + 1}`,
      system_prompt: '\tKeep <b>literal</b>.\r\n', user_prompt: `PROMPT_BODY_PRIVATE: outcome selection ${index} 雪\r\n`,
      temperature: 0.37, max_output_tokens: 128, check_kind: kind, expected_text: kind === 'exact_text' ? '' : null,
      required_fields: kind === 'json_fields' ? [{ name: ' answer ', type: 'string' }, { name: '__proto__', type: 'object' }] : null,
    })) }
  async function exported(kind) {
    await view.click(`suite-export-${kind}`)
    const text = await view.downloads.at(-1).blob.text()
    return kind === 'run' ? parsePromptSuiteReport(text) : parsePromptSuiteDefinition(text)
  }
  async function importRun(source) {
    const blob = new Blob([JSON.stringify(source)], { type: 'application/json' })
    await view.runFile({ name: 'recorded.json', size: blob.size, arrayBuffer: () => blob.arrayBuffer() })
  }
  const raw = JSON.stringify(original), beforeImport = calls.length
  await view.file({ size: new TextEncoder().encode(raw).length, text: async () => raw })
  await view.click('suite-import-use')
  assert.deepEqual(await exported('definition'), original)
  assert.equal(calls.length, beforeImport)
  await view.submit('suite-form')
  await view.waitFor(() => calls.some(call => call.method === 'post'), { timeout: 15000 })
  await view.click('suite-pause')
  await view.waitFor(() => view.byId('suite-scheduling-state')?.props['data-phase'] === 'paused', { timeout: 15000 })
  const paused = await exported('run'), pausedCalls = calls.length
  assert.deepEqual(paused.cases.map(row => row.status), ['succeeded', 'not_attempted', 'not_attempted'])
  await importRun(paused)
  assert.equal(view.text(view.byId('suite-import-selection-count')), '已选择 3/3 个用例')
  assert.equal(view.text(view.byId('suite-import-case-1-status')), view.i18n.global.t('promptSuites.caseStates.not_attempted'))
  await view.click('suite-import-select-attention')
  assert.equal(view.byId('suite-import-case-0-included').props.checked, false)
  assert.equal(view.byId('suite-import-case-1-included').props.checked, true)
  assert.equal(view.byId('suite-import-case-2-included').props.checked, true)
  await view.change('suite-import-case-1-included', false)
  await view.click('suite-import-use')
  const chosen = { ...original, cases: [original.cases[2]] }
  assert.deepEqual(await exported('definition'), chosen)
  assert.deepEqual(await exported('run'), paused)
  assert.equal(view.byId('suite-case-0-included').props.checked, true)
  assert.equal(view.byId('suite-scheduling-state').props['data-phase'], 'paused')
  assert.equal(calls.length, pausedCalls, 'Previewing, selecting and adopting do no runtime work while paused')
  await view.click('suite-resume')
  await view.waitFor(() => view.byId('suite-run-report')?.props['data-status'] === 'completed', { timeout: 35000 })
  const completed = await exported('run'), completedCalls = calls.length
  assert.deepEqual(completed.definition, original)
  assert.equal(completed.run_id, paused.run_id)
  assert.deepEqual(completed.cases.map(row => row.check), ['not_requested', 'mismatched', 'mismatched'])
  assert.deepEqual(await exported('definition'), chosen, 'Finishing the old run retains the chosen future draft')
  assert.equal(calls.filter(call => call.method === 'post').length, 3)

  await importRun(completed)
  const retiredApply = view.byId('suite-import-use').props.onClick
  await view.click('suite-import-select-attention')
  assert.equal(view.text(view.byId('suite-import-selection-count')), '已选择 2/3 个用例')
  assert.equal(view.text(view.byId('suite-import-case-1-status')), view.i18n.global.t('promptSuites.caseStates.succeeded'))
  assert.equal(view.text(view.byId('suite-import-case-2-check')), view.i18n.global.t('promptSuites.jsonFieldsChecks.mismatched'))
  retiredApply({ button: 0, preventDefault() {}, stopPropagation() {} }); await view.flush()
  assert.ok(view.byId('suite-import-preview'), 'Selection changes retire the old Apply callback')
  for (let index = 0; index < 3; index++) await view.change(`suite-import-case-${index}-included`, false)
  assert.equal(view.byId('suite-import-use').props.disabled, true)
  assert.ok(view.byId('suite-import-selection-empty'))
  view.byId('suite-import-use').props.onClick({ button: 0, preventDefault() {}, stopPropagation() {} }); await view.flush()
  assert.deepEqual(await exported('definition'), chosen)
  await view.click('suite-import-select-all')
  assert.equal(view.text(view.byId('suite-import-use')), '将已捕获用例用作草稿')
  await view.click('suite-import-select-attention')
  await view.change('suite-import-case-1-included', false)
  assert.equal(view.text(view.byId('suite-import-use')), '将所选用例用作草稿')
  await view.click('suite-import-use')
  assert.deepEqual(await exported('definition'), chosen)
  assert.deepEqual(await exported('selection'), chosen)
  assert.deepEqual(await exported('run'), completed)
  assert.equal(calls.length, completedCalls, 'Every import/selection/apply/export action stays offline')

  await view.submit('suite-form')
  await view.waitFor(() => view.byId('suite-run-report')?.props['data-status'] === 'completed' &&
    !view.text(view.byId('suite-run-report')).includes(completed.run_id), { timeout: 20000 })
  const fresh = await exported('run')
  assert.deepEqual(fresh.definition, chosen)
  assert.equal(fresh.cases.length, 1)
  assert.equal(fresh.cases[0].case_id, original.cases[2].case_id)
  assert.equal(fresh.cases[0].status, 'succeeded'); assert.equal(fresh.cases[0].check, 'mismatched')
  const historicalIds = new Set([completed.run_id, ...completed.cases.map(row => row.request_id)])
  assert.ok(!historicalIds.has(fresh.run_id)); assert.ok(!historicalIds.has(fresh.cases[0].request_id))
  assert.notEqual(fresh.run_id, fresh.cases[0].request_id)
  const request = fresh.cases[0].snapshot.run.request
  for (const key of ['label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens']) assert.equal(request[key], chosen.cases[0][key])
  assert.equal(fresh.cases[0].snapshot.run.configuration.model, 'fixture-local-chat')
  assert.equal(calls.filter(call => call.method === 'post').length, 4, 'Only the chosen case gets a fresh POST')
  assert.equal(view.all(node => node.type === 'script' || Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.deepEqual(view.warnings, []); assert.deepEqual(logs, [])
  console.log('actual proxy/Flask/gateway/Axios/Vue prompt suites passed')
} finally {
  view?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
