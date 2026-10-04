// Python owns real disposable Flask/storage and synthetic graph/model boundaries.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { build, settle, setupChild } from '../helpers/parent-route-fixture.js'
import { productionClient } from '../helpers/readiness-view-fixture.js'

const [backendURL, scenario] = process.argv.slice(2)
assert.match(backendURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['template', 'llm'].includes(scenario))
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-cast-preset-vite-'))
let proxy, view
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
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
  let startReplies = 0
  const start = api.startSimulation
  api.startSimulation = (...args) => start(...args).then(response => { startReplies++; return response })
  const downloads = [], revoked = []
  view = build({ manualPlan: true, api, downloads, revoked, locale: scenario === 'llm' ? 'zh' : 'en' })
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
  const loadCast = async () => {
    await waitFor(() => control('load-cast') && !control('load-cast').props.disabled, 'local plan is actionable')
    await click('load-cast')
    await waitFor(() => control('entity-node_11'), 'current catalog is loaded')
  }
  await view.mount('/simulation/sim_preset_source')
  await loadCast()
  const preview = responses.find(response => response.data?.simulation_id === 'sim_preset_source' && Array.isArray(response.data.entities))
  assert.equal(preview.data.project_id, 'proj_fixture')
  assert.equal(preview.data.graph_id, 'graph_fixture')
  for (const id of ['node_02', 'node_11']) {
    control('entity-' + id).props.onChange({ target: { checked: true } })
    await settle()
  }
  control('profile-mode').props.onChange({ target: { value: scenario } })
  control('draft-maximum-rounds').props.onInput({ target: { value: '2' } })
  await settle()
  const beforeExport = calls.length
  await click('save-cast-preset')
  assert.equal(calls.length, beforeExport, 'export performs no API action')
  assert.equal(downloads.length, 1)
  const bytes = await downloads[0].blob.arrayBuffer()
  const preset = JSON.parse(new TextDecoder().decode(bytes))
  assert.deepEqual(preset, { schema_version: 1, kind: 'mirofish_local_cast_preset',
    project_id: 'proj_fixture', graph_id: 'graph_fixture', selected_entity_ids: ['node_02', 'node_11'],
    use_llm_for_profiles: scenario === 'llm', max_rounds: 2 })
  assert.equal(count('/api/simulation/prepare'), 0)
  assert.equal(count('/api/simulation/start'), 0)

  await view.navigate('/simulation/sim_fixture')
  await loadCast()
  assert.equal(count('/api/simulation/prepare/preview'), 2)
  control('entity-node_00').props.onChange({ target: { checked: true } })
  control('profile-mode').props.onChange({ target: { value: scenario === 'llm' ? 'template' : 'llm' } })
  control('draft-maximum-rounds').props.onInput({ target: { value: '3' } })
  await settle()
  const beforeImport = calls.length
  const file = { size: bytes.byteLength, arrayBuffer: async () => bytes.slice(0) }
  control('open-cast-preset').props.onChange({ target: { files: [file], value: 'cast.json' } })
  await settle()
  await waitFor(() => control('apply-cast-preset') && !control('apply-cast-preset').props.disabled, 'staged preset can be applied')
  assert.deepEqual(Array.from(view.state(setupChild).selectedEntityIds), ['node_00'], 'open preserves current draft')
  assert.equal(view.state(setupChild).localMaxRounds, 3)
  await click('apply-cast-preset')
  assert.deepEqual(Array.from(view.state(setupChild).selectedEntityIds), ['node_02', 'node_11'])
  assert.equal(view.state(setupChild).useLlmProfiles, scenario === 'llm')
  assert.equal(view.state(setupChild).localMaxRounds, 2)
  assert.equal(calls.length, beforeImport, 'opening and applying make no API calls')
  assert.equal(count('/api/simulation/prepare'), 0)
  assert.equal(count('/api/simulation/start'), 0)

  await click('prepare-cast')
  await waitFor(() => view.state(setupChild).phase === 4, 'explicit preparation completes')
  assert.deepEqual(calls.find(call => call.url === '/api/simulation/prepare').data,
    { simulation_id: 'sim_fixture', preparation_mode: 'prepare', selected_entity_ids: ['node_02', 'node_11'],
      use_llm_for_profiles: scenario === 'llm', parallel_profile_count: 1 })
  assert.equal(view.state(setupChild).effectiveLocalRounds, 2)
  view.find(node => node.type === 'button' && String(node.props.class).includes('action-btn primary')).props.onClick()
  await waitFor(() => count('/api/simulation/start') === 1 && startReplies === 1, 'explicit Start reaches the real runner route')
  assert.equal(calls.find(call => call.url === '/api/simulation/start').data.max_rounds, 2)
  assert.equal(count('/api/simulation/prepare'), 1)
  assert.equal(view.router.currentRoute.value.name, 'SimulationRun')
  assert.ok(revoked.length >= 1, 'retired view releases its exported object URL')
  assert.deepEqual(view.warnings, [])
  console.log('actual cast preset workflow passed')
  console.log('actual local preparation workflow passed')
} finally {
  view?.close()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
