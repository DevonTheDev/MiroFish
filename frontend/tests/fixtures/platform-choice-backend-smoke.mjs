// Python supplies disposable Flask/storage and explicit graph/model/process
// boundaries. Actual Step1, Step2, Step3 SFCs and API modules execute here.
// The graph-building parent is controlled, then its completed creation route
// is remounted in the real setup/run router harness. No native browser layout.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { build as buildCreation, textContent } from '../helpers/simulation-platform-fixture.js'
import { build, settle, setupChild, runChild } from '../helpers/parent-route-fixture.js'
import { productionClient } from '../helpers/readiness-view-fixture.js'
import { buildSurvey } from '../helpers/platform-survey-fixture.js'

const [backendURL, platform, scenario = 'workflow'] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['twitter', 'reddit', 'parallel'].includes(platform))
const enabled = platform === 'parallel' ? ['twitter', 'reddit'] : [platform]
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-platform-choice-vite-'))
let proxy, creation, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  assert.ok(loaded?.config.server.proxy['/api'])
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    // SFCs run in the compiled harness; this server handles only API proxy
    // traffic. Avoid an unused optimizer writing its cache during teardown.
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  assert.equal(proxy.environments.client.depsOptimizer, undefined,
    'The API-only fixture must not start dependency optimization')
  const baseURL = `http://127.0.0.1:${proxy.httpServer.address().port}`
  const service = productionClient(baseURL), calls = [], responses = []
  service.defaults.headers.common.Origin = baseURL
  service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: structuredClone(config.data), signal: config.signal })
    return config
  })
  service.interceptors.response.use(envelope => { responses.push(envelope); return envelope }, error => {
    responses.push(error.response?.data ?? { error: error.message })
    return Promise.reject(error)
  })
  const moduleApi = filename => {
    let source = readFileSync(new URL('../../src/api/' + filename, import.meta.url), 'utf8')
    const names = [...source.matchAll(/export (?:const|function) ([A-Za-z0-9_]+)/g)].map(match => match[1])
    source = source.replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
    return new Function('service', source + '\nreturn {' + names.join(',') + '};')(service)
  }
  const api = { ...moduleApi('simulation.js'), ...moduleApi('graph.js'), ...moduleApi('report.js') }
  const count = url => calls.filter(call => call.url === url).length
  const waitFor = async (predicate, label, tick = false) => {
    const until = Date.now() + 15000
    while (!predicate() && Date.now() < until) {
      await pause(20)
      if (tick && view) { await view.tick(2000); await view.tick(3000) }
      await settle()
    }
    assert.ok(predicate(), label + '\n' + JSON.stringify({ calls, responses, warnings: view?.warnings }).slice(-14000))
  }
  if (scenario === 'survey') {
    // Only report reads are synthetic here. Profile reads and survey submission
    // use production Axios → Flask → runner → IPC → actual single scripts.
    view = buildSurvey({ ...api, getReport: async () => ({ success: true, data: { simulation_id: 'sim_single' } }),
      getAgentLog: async () => ({ success: true, data: { logs: [] } }) })
    await waitFor(() => view.state().profiles.length === 2, 'actual default profiles load into Step5')
    const surveyTab = view.find(node => node.type === 'button' && /survey/i.test(textContent(node)))
    assert.ok(surveyTab, 'actual survey tab control')
    surveyTab.props.onClick()
    await settle()
    const checkboxes = view.all(node => node.type === 'input' && node.props.type === 'checkbox')
    assert.equal(checkboxes.length, 2)
    checkboxes.forEach(node => node.props.onChange())
    const question = view.find(node => node.props.class === 'survey-input')
    assert.ok(question)
    question.props['onUpdate:modelValue']('What happened?')
    await settle()
    const submit = view.find(node => node.props.class === 'survey-submit-btn')
    assert.ok(submit && !submit.props.disabled)
    submit.props.onClick(); submit.props.onClick()
    await waitFor(() => view.state().surveyResults.length === 2, 'actual single-script replies reach survey results')
    assert.equal(count('/api/simulation/interview/batch'), 1)
    assert.deepEqual(calls.find(call => call.url === '/api/simulation/interview/batch').data, {
      simulation_id: 'sim_single', interviews: [0, 1].map(agent_id => ({ agent_id, prompt: 'What happened?' })),
    })
    assert.deepEqual(Array.from(view.state().surveyResults, item => item.answer), [0, 1].map(id => `${platform} reply from ${id}`))
    const payload = responses.find(response => response.data?.result?.results).data.result
    assert.equal(payload.platform, platform)
    assert.deepEqual(payload.platforms, [platform])
    assert.deepEqual(Object.keys(payload.results).sort(), [`${platform}_0`, `${platform}_1`])
    const rendered = view.all(node => node.props.class === 'result-answer').map(node => node.props.innerHTML)
    assert.equal(rendered.length, 2)
    for (const [index, html] of rendered.entries()) assert.ok(html.includes(`${platform} reply from ${index}`))
    assert.deepEqual(view.warnings, [])
    console.log('actual single platform survey workflow passed')
  } else {
  creation = buildCreation({ api })
  creation.sourceProps.projectData = { project_id: 'proj_fixture', graph_id: 'graph_fixture' }
  await creation.mount('/process/proj_fixture')
  assert.equal(creation.control('simulation-platform').props.value, 'parallel')
  creation.control('simulation-platform').props.onChange({ target: { value: platform } })
  await settle()
  const create = creation.control('create-simulation').props.onClick
  create(); create()
  await waitFor(() => creation.router.currentRoute.value.name === 'Simulation', 'Step1 creation navigates to saved simulation')
  assert.equal(count('/api/simulation/create'), 1)
  const submittedCreate = calls.find(call => call.url === '/api/simulation/create')
  assert.deepEqual(submittedCreate.data, { project_id: 'proj_fixture', graph_id: 'graph_fixture',
    enable_twitter: enabled.includes('twitter'), enable_reddit: enabled.includes('reddit') })
  assert.ok(submittedCreate.signal instanceof AbortSignal)
  const simulationId = creation.router.currentRoute.value.params.simulationId
  assert.match(simulationId, /^sim_/)
  assert.deepEqual(creation.warnings, [])
  assert.deepEqual(creation.alerts, [])
  creation.close()

  // Continue from exactly the route returned by the actual Step1 create call.
  // Existing parent harness includes production SimulationView/RunView and router.
  view = build({ manualPlan: true, api, locale: 'en', disableTransitions: true })
  const control = id => view.find(node => node.props?.['data-testid'] === id)
  const click = async id => {
    const element = control(id)
    assert.ok(element && !element.props.disabled, id + ' enabled')
    element.props.onClick()
    await settle()
  }
  await view.mount('/simulation/' + simulationId)
  await waitFor(() => control('load-cast') && !control('load-cast').props.disabled, 'local plan is actionable')
  assert.equal(count('/api/simulation/prepare'), 0)
  await click('load-cast')
  await waitFor(() => control('entity-node_01'), 'bounded graph catalog arrives')
  for (const id of ['node_00', 'node_01']) control('entity-' + id).props.onChange({ target: { checked: true } })
  control('profile-mode').props.onChange({ target: { value: 'llm' } })
  await settle()
  await click('prepare-cast')
  await waitFor(() => view.state(setupChild).phase === 4, 'prepared configuration loads', true)
  assert.deepEqual(calls.find(call => call.url === '/api/simulation/prepare').data, {
    simulation_id: simulationId, preparation_mode: 'prepare', selected_entity_ids: ['node_00', 'node_01'],
    use_llm_for_profiles: true, parallel_profile_count: 1,
  })
  const profiles = view.state(setupChild).profiles
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0].bio, 'Platform fixture bio 雪')
  assert.ok(profiles[0].persona.includes('Platform fixture persona <literal>'))
  const preview = responses.findLast(response => response.data?.file_exists && response.data?.profiles?.length === 2)
  assert.equal(preview.data.platform, platform === 'twitter' ? 'twitter' : 'reddit')
  const profileCard = view.find(node => node.props?.class === 'profile-card')
  profileCard.props.onClick()
  await settle()
  assert.ok(textContent(view.host).includes('Platform fixture bio 雪'))
  assert.ok(textContent(view.host).includes('Platform fixture persona <literal>'))
  const config = view.state(setupChild).simulationConfig
  for (const name of ['twitter', 'reddit']) assert.equal(!!config[name + '_config'], enabled.includes(name))
  control('maximum-rounds').props.onInput({ target: { value: '2' } })
  await settle()
  const start = view.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
  assert.ok(start && !start.props.disabled)
  start.props.onClick()
  await waitFor(() => responses.some(response => response.data?.runner_status === 'running') && view.instances[runChild], 'Step3 receives resolved start')
  assert.equal(view.router.currentRoute.value.name, 'SimulationRun')
  assert.deepEqual(calls.find(call => call.url === '/api/simulation/start').data, {
    simulation_id: simulationId, platform: 'auto', force: true, enable_graph_memory_update: true, max_rounds: 2,
  })
  const accepted = responses.find(response => response.data?.runner_status === 'running' && response.data?.platform)
  assert.equal(accepted.data.platform, platform)
  const panels = () => ['twitter', 'reddit'].filter(name => control('platform-status-' + name))
  assert.deepEqual(panels(), enabled)
  assert.equal(view.state(runChild).phase, 1, 'per-platform completion flags cannot complete the run')
  await view.tick(3000)
  await waitFor(() => enabled.every(name => control('platform-actions-' + name)), 'persisted actions reach actual selected action panels')
  assert.deepEqual(['twitter', 'reddit'].filter(name => control('platform-actions-' + name)), enabled)
  for (const name of ['twitter', 'reddit']) assert.equal(textContent(view.host).includes(name + ' synthetic action'), enabled.includes(name))
  await waitFor(() => view.state(runChild).phase === 2, 'authoritative completed status enables report', true)
  assert.deepEqual(panels(), enabled, 'status responses without mode preserve accepted start selection')
  const report = control('generate-report')
  assert.ok(report && !report.props.disabled)
  report.props.onClick(); report.props.onClick()
  await waitFor(() => view.router.currentRoute.value.name === 'Report', 'accepted real report route preserves navigation')
  assert.equal(count('/api/report/generate'), 1)
  assert.deepEqual(calls.find(call => call.url === '/api/report/generate').data, { simulation_id: simulationId, force_regenerate: true })
  assert.match(view.router.currentRoute.value.params.reportId, /^report_/)
  const reportResponse = responses.find(response => response.data?.task_id && response.data?.report_id)
  assert.ok(reportResponse, 'real report route creates a task')
  let reportTask
  const reportDeadline = Date.now() + 5000
  do {
    reportTask = await service.post('/api/report/generate/status', { task_id: reportResponse.data.task_id })
    if (reportTask.data.status === 'completed') break
    assert.notEqual(reportTask.data.status, 'failed')
    await pause(10)
  } while (Date.now() < reportDeadline)
  assert.equal(reportTask.data.status, 'completed', 'actual report worker saved output and completed task')
  const savedReport = await api.getReport(view.router.currentRoute.value.params.reportId)
  assert.equal(savedReport.data.simulation_id, simulationId)
  assert.equal(savedReport.data.status, 'completed')
  assert.equal(savedReport.data.markdown_content, 'Synthetic report model boundary')
  assert.equal(count('/api/simulation/start'), 1)
  assert.equal(count('/api/simulation/prepare'), 1)
  assert.equal(count('/api/simulation/stop'), 0, 'report transition keeps the completed environment')
  assert.deepEqual(view.warnings, [])
  console.log('actual platform choice workflow passed')
  }
} finally {
  creation?.close()
  view?.close()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
