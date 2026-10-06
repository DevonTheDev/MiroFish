// Python owns disposable Flask/storage and synthetic graph/model boundaries.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { build, settle, setupView, setupChild } from '../helpers/parent-route-fixture.js'
import { productionClient } from '../helpers/readiness-view-fixture.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['template', 'llm', 'reuse', 'reuse_failed', 'cloud',
  'reuse_profile_outage', 'reuse_profile_unsuccessful', 'reuse_profile_missing_data'].includes(scenario))
const reuse = scenario.startsWith('reuse')
const profileFailure = scenario.startsWith('reuse_profile_')
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-local-planner-vite-'))
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
  const service = productionClient(baseURL), calls = [], responses = []
  service.defaults.headers.common.Origin = baseURL
  service.defaults.headers.common['Sec-Fetch-Site'] = 'same-origin'
  service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: structuredClone(config.data) })
    return config
  })
  service.interceptors.response.use(envelope => { responses.push(envelope); return envelope })
  const moduleApi = filename => {
    let source = readFileSync(new URL('../../src/api/' + filename, import.meta.url), 'utf8')
    const names = [...source.matchAll(/export (?:const|function) ([A-Za-z0-9_]+)/g)].map(match => match[1])
    source = source.replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
    return new Function('service', source + '\nreturn {' + names.join(',') + '};')(service)
  }
  const api = { ...moduleApi('simulation.js'), ...moduleApi('graph.js') }
  const originalStart = api.startSimulation
  let startReplies = 0
  api.startSimulation = (...args) => originalStart(...args).then(response => { startReplies++; return response })
  view = build({ manualPlan: true, api, locale: scenario === 'llm' ? 'zh' : 'en' })
  const control = id => view.find(node => node.props?.['data-testid'] === id)
  const count = url => calls.filter(call => call.url === url).length
  const waitFor = async (predicate, label) => {
    const until = Date.now() + 15000
    while (!predicate() && Date.now() < until) {
      await pause(20)
      await view.tick(2000)
      await view.tick(3000)
      await settle()
    }
    assert.ok(predicate(), label + '\n' + JSON.stringify({ calls, responses, warnings: view.warnings }).slice(-16000))
  }
  const click = async id => {
    const element = control(id)
    assert.ok(element, id)
    assert.ok(!element.props.disabled, id + ' enabled')
    element.props.onClick()
    await settle()
  }
  await view.mount('/simulation/sim_fixture')
  if (scenario === 'cloud') {
    await waitFor(() => count('/api/simulation/prepare') === 1, 'cloud automatically prepares once')
    const submitted = calls.find(call => call.url === '/api/simulation/prepare').data
    assert.deepEqual(submitted, { simulation_id: 'sim_fixture', use_llm_for_profiles: true, parallel_profile_count: 5 })
    assert.equal(count('/api/simulation/prepare/preview'), 0)
  } else {
    const action = reuse ? 'reuse-preparation' : 'load-cast'
    await waitFor(() => control(action) && !control(action).props.disabled, 'local plan is actionable')
    assert.equal(count('/api/simulation/prepare'), 0, 'mount never prepares local models')
    assert.equal(count('/api/simulation/prepare/preview'), 0, 'mount never previews local graph')
    assert.ok(!calls.some(call => call.url.startsWith('/api/graph/data/')), 'local parent does not initialize graph implicitly')
    if (reuse) {
      await click('reuse-preparation')
      await waitFor(() => count('/api/simulation/prepare') === 1, 'explicit reuse posted')
      assert.deepEqual(calls.find(call => call.url === '/api/simulation/prepare').data,
        { simulation_id: 'sim_fixture', preparation_mode: 'reuse' })
      assert.equal(count('/api/simulation/prepare/preview'), 0)
    } else {
      await click('load-cast')
      await waitFor(() => control('entity-node_11'), 'bounded graph catalog arrives')
      assert.equal(count('/api/simulation/prepare/preview'), 1)
      const preview = responses.find(response => Array.isArray(response.data?.entities))
      assert.equal(preview.data.eligible_count, 12)
      assert.equal(preview.data.limits.max_agents, 2)
      assert.equal(count('/api/simulation/prepare'), 0)
      assert.ok(control('prepare-cast').props.disabled)
      for (const id of ['node_02', 'node_11']) {
        control('entity-' + id).props.onChange({ target: { checked: true } })
        await settle()
      }
      if (scenario === 'llm') {
        control('profile-mode').props.onChange({ target: { value: 'llm' } })
        await settle()
      }
      assert.ok(control('entity-node_00').props.disabled, 'loaded cap blocks selecting a third entity')
      await click('prepare-cast')
      await waitFor(() => count('/api/simulation/prepare') === 1, 'selected preparation posted')
      const submitted = calls.find(call => call.url === '/api/simulation/prepare').data
      assert.deepEqual(submitted, { simulation_id: 'sim_fixture', preparation_mode: 'prepare',
        selected_entity_ids: ['node_02', 'node_11'], use_llm_for_profiles: scenario === 'llm', parallel_profile_count: 1 })
    }
  }
  if (profileFailure) {
    await waitFor(() => view.state(setupChild).planError || view.state(setupChild).phase === 4,
      'final profile read reaches a terminal observation')
    assert.equal(view.state(setupChild).phase, 0, 'failed final profiles must not complete setup')
    assert.equal(view.state(setupView).currentStatus, 'error')
    assert.equal(view.state(setupChild).planError, 'localPlan.requestError')
    assert.equal(view.state(setupChild).localPlan.prepared.available, true)
    assert.equal(count('/api/simulation/sim_fixture/config/realtime'), 0)
    const blockedStart = view.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
    assert.equal(blockedStart.props.disabled, true)
    blockedStart.props.onClick(); await settle()
    assert.equal(count('/api/simulation/start'), 0)
    assert.equal(view.router.currentRoute.value.name, 'Simulation')
    await view.tick(2000); await view.tick(3000)
    assert.equal(count('/api/simulation/sim_fixture/profiles/realtime'), 1, 'no automatic retry')
    assert.equal(control('reuse-preparation').props.disabled, true)
    await click('refresh-plan')
    await waitFor(() => control('reuse-preparation') && !control('reuse-preparation').props.disabled, 'Refresh plan restores explicit reuse')
    assert.equal(count('/api/simulation/prepare'), 1, 'refresh never submits preparation')
    await click('reuse-preparation')
    await waitFor(() => count('/api/simulation/prepare') === 2, 'explicit second reuse posted')
    assert.ok(calls.filter(call => call.url === '/api/simulation/prepare').every(call =>
      JSON.stringify(call.data) === JSON.stringify({ simulation_id: 'sim_fixture', preparation_mode: 'reuse' })))
    assert.equal(count('/api/simulation/prepare/preview'), 0)
  }
  await waitFor(() => view.state(setupChild).phase === 4, 'authoritative prepared config loads')
  if (profileFailure) {
    assert.equal(view.state(setupChild).profiles.length, 2, 'retry displays the saved cast')
    assert.equal(count('/api/simulation/sim_fixture/profiles/realtime'), 2)
    assert.equal(count('/api/simulation/sim_fixture/config/realtime'), 1)
  }
  if (scenario !== 'cloud') {
    assert.ok(!calls.some(call => call.url.startsWith('/api/graph/data/')), 'prepare/reuse does not need parent graph rendering')
    const rounds = control('maximum-rounds')
    assert.equal(Number(rounds.props.min), 1)
    assert.equal(Number(rounds.props.max), reuse ? 1 : 3)
    if (!reuse) {
      rounds.props.onInput({ target: { value: '2' } })
      await settle()
    }
    assert.equal(view.state(setupChild).effectiveLocalRounds, reuse ? 1 : 2)
  }
  const start = view.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary'))
  assert.ok(start && !start.props.disabled, 'Start is enabled after final config')
  start.props.onClick()
  await waitFor(() => count('/api/simulation/start') === 1 && startReplies === 1, 'actual router reaches Step3 start')
  assert.equal(view.router.currentRoute.value.name, 'SimulationRun')
  const submittedStart = calls.find(call => call.url === '/api/simulation/start').data
  if (scenario === 'cloud') assert.ok(!Object.hasOwn(submittedStart, 'max_rounds'))
  else assert.equal(submittedStart.max_rounds, reuse ? 1 : 2)
  assert.equal(count('/api/simulation/prepare'), profileFailure ? 2 : 1)
  assert.deepEqual(view.warnings, [])
  console.log('actual local preparation workflow passed')
} finally {
  view?.close()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
