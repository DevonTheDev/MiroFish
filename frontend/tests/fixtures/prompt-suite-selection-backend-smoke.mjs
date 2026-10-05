// Selected editor cases alone reach the actual guarded local inference route.
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
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-suite-selection-vite-'))
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
    await view.file({ name: 'chosen.json', size: new TextEncoder().encode(raw).length, text: async () => raw })
    await view.click('suite-import-use')
  }
  const exportFile = async kind => {
    await view.click('suite-export-' + kind)
    return await view.downloads.at(-1).blob.text()
  }
  const original = { schema_version: 3, kind: 'mirofish_local_prompt_suite', name: 'Chosen <variants> 雪',
    cases: Array.from({ length: 3 }, (_, index) => ({
      case_id: `12345678-1234-4234-9234-123456789ab${index}`, label: `Case ${index + 1}`,
      system_prompt: 'Keep literal inputs.', user_prompt: `PROMPT_BODY_PRIVATE: selected ${index} 雪`,
      temperature: 0.2, max_output_tokens: 128,
      check_kind: 'none', expected_text: null, required_fields: null,
    })) }
  view = await mount()
  const beforeEdit = calls.length
  assert.ok(calls.every(call => call.method === 'get'))
  await use(JSON.stringify(original))
  for (let index = 0; index < 3; index++) assert.equal(view.byId(`suite-case-${index}-included`).props.checked, true)
  await view.change('suite-case-1-included', false)
  await view.input('suite-case-1-user_prompt', '')
  await view.input('suite-case-1-max_output_tokens', '9999')
  await view.click('suite-case-2-move-up')
  await view.click('suite-case-1-move-up')
  assert.equal(view.byId('suite-case-2-included').props.checked, false)
  assert.equal(view.byId('suite-export-definition').props.disabled, true)
  assert.equal(view.byId('suite-export-selection').props.disabled, false)
  assert.equal(view.byId('suite-run').props.disabled, false, 'Invalid excluded case does not block the chosen valid cases')
  assert.equal(view.byId('suite-cap-warning'), undefined, 'Excluded output request does not exceed selection budget')
  const chosenRaw = await exportFile('selection')
  const chosen = parsePromptSuiteDefinition(chosenRaw)
  assert.deepEqual(chosen, { ...original, cases: [original.cases[2], original.cases[0]] })
  assert.equal(view.downloads.at(-1).filename, 'local_prompt_suite_selection.json')
  assert.equal(calls.length, beforeEdit, 'Selecting, editing and exporting do no runtime work')

  await view.submit('suite-form')
  await view.waitFor(() => calls.some(call => call.method === 'post'), { timeout: 15000 })
  await view.click('suite-pause')
  await view.waitFor(() => view.byId('suite-scheduling-state')?.props['data-phase'] === 'paused', { timeout: 15000 })
  await view.click('suite-export-run')
  const paused = acceptPromptSuiteReport(JSON.parse(await view.downloads.at(-1).blob.text()))
  assert.deepEqual(paused.definition, chosen)
  assert.equal(paused.cases.length, 2)
  assert.equal(paused.cases[0].status, 'succeeded')
  const beforeChange = calls.length
  await view.change('suite-case-0-included', false)
  await view.change('suite-case-1-included', false)
  assert.equal(view.byId('suite-export-selection').props.disabled, true)
  assert.equal(view.byId('suite-run').props.disabled, true)
  assert.equal(view.byId('suite-resume').props.disabled, false)
  await pause(1700)
  assert.equal(calls.length, beforeChange)
  await view.click('suite-resume')
  await view.waitFor(() => view.byId('suite-run-report')?.props['data-status'] === 'completed', { timeout: 35000 })
  await view.click('suite-export-run')
  const completed = acceptPromptSuiteReport(JSON.parse(await view.downloads.at(-1).blob.text()))
  assert.deepEqual(completed.definition, chosen)
  assert.equal(completed.run_id, paused.run_id)
  assert.deepEqual(completed.cases[0], paused.cases[0])
  assert.equal(completed.cases.length, 2)
  assert.equal(new Set(completed.cases.map(item => item.request_id)).size, 2)
  for (const [index, result] of completed.cases.entries()) {
    assert.equal(result.status, 'succeeded')
    assert.equal(result.snapshot.run.request.user_prompt, chosen.cases[index].user_prompt)
    assert.equal(result.snapshot.run.request.max_output_tokens, 128)
  }
  assert.equal(calls.filter(call => call.method === 'post').length, 2)
  const afterRun = calls.length
  await view.input('suite-case-2-user_prompt', original.cases[1].user_prompt)
  await view.input('suite-case-2-max_output_tokens', '128')
  assert.deepEqual(parsePromptSuiteDefinition(await exportFile('definition')),
    { ...original, cases: [original.cases[2], original.cases[0], original.cases[1]] })
  assert.equal(calls.length, afterRun, 'Full draft remains independently exportable with no included cases')
  view.unmount()

  view = await mount()
  const beforeFreshImport = calls.length
  await use(chosenRaw)
  assert.equal(view.byId('suite-case-0-included').props.checked, true)
  assert.equal(view.byId('suite-case-1-included').props.checked, true)
  assert.equal(view.byId('suite-case-2-included'), undefined)
  assert.equal(await exportFile('selection'), chosenRaw)
  assert.equal(await exportFile('definition'), chosenRaw)
  assert.equal(calls.length, beforeFreshImport)
  assert.equal(calls.filter(call => call.method === 'post').length, 2)
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(logs, [])
  console.log('actual proxy/Flask/gateway/Axios/Vue prompt suites passed')
} finally {
  view?.unmount()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
