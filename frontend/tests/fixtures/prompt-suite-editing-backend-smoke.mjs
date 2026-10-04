// Actual editor -> exact definition -> fresh editor -> local API execution.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { mountSuites, trialApi } from '../helpers/prompt-suites-view-fixture.js'
import { parsePromptSuiteDefinition, acceptPromptSuiteReport } from '../../src/utils/promptSuites.js'

const [backendURL] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-suite-editing-vite-'))
let proxy, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const logs = [], calls = [], replies = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => logs.push(args)]))
  const api = trialApi({ baseURL, logger })
  api.service.defaults.headers.common.Origin = baseURL
  api.service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  api.service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: config.data })
    return config
  })
  api.service.interceptors.response.use(response => { replies.push(response.data); return response })
  const mount = async () => {
    const old = replies.length
    const next = await mountSuites({ api, timers: { setTimeout, clearTimeout }, cacheHandlers: true })
    await next.waitFor(() => replies.length > old, { timeout: 15000 })
    await next.flush()
    return next
  }
  const use = async raw => {
    await view.file({ name: 'edited-suite.json', size: new TextEncoder().encode(raw).length, text: async () => raw })
    await view.click('suite-import-use')
  }
  const exportDefinition = async () => {
    await view.click('suite-export-definition')
    return await view.downloads.at(-1).blob.text()
  }
  const replyFor = prompt => '<think>literal reasoning</think>\n<script>literal reply</script>\n' + prompt
  const original = { schema_version: 3, kind: 'mirofish_local_prompt_suite', name: 'Reordered <variants> 雪', cases: [
    { case_id: '12345678-1234-4234-9234-123456789ab0', label: 'First',
      system_prompt: 'Keep literal text.', user_prompt: 'PROMPT_BODY_PRIVATE: first', temperature: 0.2,
      max_output_tokens: 128, check_kind: 'exact_text', expected_text: replyFor('PROMPT_BODY_PRIVATE: first'), required_fields: null },
    { case_id: '12345678-1234-4234-9234-123456789ab1', label: '<schema> 雪',
      system_prompt: '  ', user_prompt: 'PROMPT_BODY_PRIVATE: second', temperature: 0.3,
      max_output_tokens: 80, check_kind: 'json_fields', expected_text: null,
      required_fields: [{ name: 'answer', type: 'string' }] },
  ] }
  view = await mount()
  const beforeEdit = calls.length
  assert.ok(calls.every(call => call.method === 'get'))
  await use(JSON.stringify(original))
  await view.click('suite-case-1-duplicate')
  let edited = parsePromptSuiteDefinition(await exportDefinition())
  const copyId = edited.cases[2].case_id
  assert.equal(edited.schema_version, 3)
  assert.ok(!original.cases.some(item => item.case_id === copyId))
  assert.deepEqual({ ...edited.cases[2], case_id: original.cases[1].case_id }, original.cases[1])
  await view.input('suite-case-2-label', 'Variant <copy> 雪')
  await view.input('suite-case-2-user_prompt', 'PROMPT_BODY_PRIVATE: variant')
  await view.input('suite-case-2-required-field-0-name', 'variant')
  await view.click('suite-case-2-move-up')
  await view.click('suite-case-1-move-up')
  const raw = await exportDefinition()
  edited = parsePromptSuiteDefinition(raw)
  assert.deepEqual(edited.cases.map(item => item.case_id), [copyId, ...original.cases.map(item => item.case_id)])
  assert.deepEqual(edited.cases[2], original.cases[1], 'Duplicate rules never share mutable ownership')
  assert.deepEqual(edited.cases[0].required_fields, [{ name: 'variant', type: 'string' }])
  assert.equal(calls.length, beforeEdit, 'Editing and export make no runtime requests')
  assert.equal(await exportDefinition(), raw, 'Repeated exports keep IDs and exact bytes')
  view.unmount()

  // Fresh import runs the exported order only after the explicit Run action.
  view = await mount()
  const beforeImport = calls.length
  await use(raw)
  assert.equal(await exportDefinition(), raw)
  assert.equal(calls.length, beforeImport)
  await view.submit('suite-form')
  await view.waitFor(() => calls.some(call => call.method === 'post'), { timeout: 15000 })
  await view.click('suite-pause')
  await view.waitFor(() => view.byId('suite-scheduling-state')?.props['data-phase'] === 'paused', { timeout: 15000 })
  await view.click('suite-export-run')
  const paused = acceptPromptSuiteReport(JSON.parse(await view.downloads.at(-1).blob.text()))
  assert.deepEqual(paused.definition, edited)
  assert.equal(paused.cases[0].status, 'succeeded')
  assert.equal(paused.cases[0].check, 'mismatched')
  const beforePausedEdit = calls.length
  await view.click('suite-case-1-duplicate')
  await view.click('suite-case-3-move-up')
  const future = parsePromptSuiteDefinition(await exportDefinition())
  assert.equal(future.cases.length, 4)
  await view.click('suite-export-run')
  assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), paused)
  await pause(1800)
  assert.equal(calls.length, beforePausedEdit, 'Paused draft organization never schedules a request')
  await view.click('suite-resume')
  await view.waitFor(() => view.byId('suite-run-report')?.props['data-status'] === 'completed', { timeout: 35000 })
  await view.click('suite-export-run')
  const completed = acceptPromptSuiteReport(JSON.parse(await view.downloads.at(-1).blob.text()))
  assert.deepEqual(completed.definition, edited, 'Resuming uses the captured three-case definition')
  assert.equal(completed.run_id, paused.run_id)
  assert.deepEqual(completed.cases[0], paused.cases[0])
  assert.deepEqual(completed.cases.map(item => item.check), ['mismatched', 'matched', 'mismatched'])
  assert.equal(new Set(completed.cases.map(item => item.request_id)).size, 3)
  for (const [index, result] of completed.cases.entries()) {
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(result.snapshot.run.request, {
      label: edited.cases[index].label, system_prompt: edited.cases[index].system_prompt,
      user_prompt: edited.cases[index].user_prompt, temperature: edited.cases[index].temperature,
      max_output_tokens: edited.cases[index].max_output_tokens,
    })
  }
  assert.equal(calls.filter(call => call.method === 'post').length, 3)
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(logs, [])
  assert.equal(view.revokedUrls.length, view.downloads.length)
  console.log('actual proxy/Flask/gateway/Axios/Vue prompt suites passed')
} finally {
  view?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
