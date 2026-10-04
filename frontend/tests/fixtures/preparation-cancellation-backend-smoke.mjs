// Disposable Flask/graph/model fixtures are owned by the Python integration test.
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
assert.ok(['cancel', 'lost_response', 'finalizing'].includes(scenario))
const root = fileURLToPath(new URL('../../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'miro-preparation-cancel-vite-'))
let proxy, view, service
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.js'), root)
  proxy = await createServer({ ...loaded.config, configFile: false, root, cacheDir, logLevel: 'silent',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, open: false,
      proxy: { ...loaded.config.server.proxy, '/api': { ...loaded.config.server.proxy['/api'], target: backendURL } } },
  })
  await proxy.listen()
  service = productionClient(`http://127.0.0.1:${proxy.httpServer.address().port}`)
  const calls = [], responses = []
  service.interceptors.request.use(config => {
    calls.push({ method: config.method, url: config.url, data: structuredClone(config.data) })
    return config
  })
  service.interceptors.response.use(response => { responses.push(response); return response })
  const moduleApi = filename => {
    let source = readFileSync(new URL('../../src/api/' + filename, import.meta.url), 'utf8')
    const names = [...source.matchAll(/export (?:const|function) ([A-Za-z0-9_]+)/g)].map(match => match[1])
    source = source.replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
    return new Function('service', source + '\nreturn {' + names.join(',') + '};')(service)
  }
  const api = { ...moduleApi('simulation.js'), ...moduleApi('graph.js') }
  let lost = false
  if (scenario === 'lost_response') {
    const cancel = api.cancelPreparation
    api.cancelPreparation = async (...args) => {
      const response = await cancel(...args)
      if (!lost) { lost = true; throw new Error('Synthetic response lost after acceptance') }
      return response
    }
  }
  const makeView = () => build({ manualPlan: true, api, locale: scenario === 'lost_response' ? 'zh' : 'en' })
  view = makeView()
  const control = id => view.find(node => node.props?.['data-testid'] === id)
  const count = url => calls.filter(call => call.url === url).length
  const fixture = async () => (await service.get('/api/fixture/state')).data
  const release = unit => service.post('/api/fixture/release', { unit })
  const waitFor = async (predicate, label, tick = true) => {
    const deadline = Date.now() + 15000
    while (!(await predicate()) && Date.now() < deadline) {
      await pause(20)
      if (tick) { await view.tick(2000); await view.tick(3000) }
      await settle()
    }
    assert.ok(await predicate(), label + '\n' + JSON.stringify({ calls, responses, warnings: view.warnings }).slice(-20000))
  }
  const click = async id => {
    const element = control(id)
    assert.ok(element && !element.props.disabled, id + ' is enabled')
    element.props.onClick()
    await settle()
  }
  const getPlan = () => api.getPreparationPlan('sim_fixture')
  await view.mount('/simulation/sim_fixture')
  await waitFor(() => control('load-cast') && !control('load-cast').props.disabled, 'local plan is ready')
  await click('load-cast')
  await waitFor(() => control('entity-node_b'), 'cast catalog loaded')
  for (const id of ['node_a', 'node_b']) {
    control('entity-' + id).props.onChange({ target: { checked: true } })
    await settle()
  }
  control('profile-mode').props.onChange({ target: { value: 'llm' } })
  await settle()
  await click('prepare-cast')
  await waitFor(async () => (await fixture()).profile_entered, 'first real profile unit is blocked')
  await waitFor(() => control('cancel-preparation') && !control('cancel-preparation').props.disabled, 'owned task can be cancelled')
  const prepared = responses.find(response => response.data?.task_id && response.data?.expected_entities_count === 2)
  assert.ok(prepared?.data.task_id)
  const taskId = prepared.data.task_id
  assert.equal((await fixture()).profiles, 1)

  if (scenario === 'finalizing') {
    const lateClick = control('cancel-preparation').props.onClick
    await release('profile')
    // Do not advance the view's fake polling clock: exercise an actual stale click.
    await waitFor(async () => (await fixture()).final_entered, 'final publication has closed cancel admission', false)
    lateClick()
    await waitFor(() => responses.some(response => response.data?.accepted === false
      && response.data?.preparation_phase === 'finalizing'), 'backend refuses late cancellation')
    assert.equal(count('/api/simulation/prepare/cancel'), 1)
    assert.notEqual(view.state(setupChild).phase, 4)
    assert.ok(!control('cancel-preparation') || control('cancel-preparation').props.disabled)
    await release('final')
    await waitFor(() => view.state(setupChild).phase === 4, 'normal finalization becomes prepared')
    assert.equal((await getPlan()).data.prepared.available, true)
  } else {
    await click('cancel-preparation')
    await waitFor(async () => (await getPlan()).data.preparation_task?.preparation_phase === 'cancelling',
      'accepted cancellation remains owned while current profile finishes')
    const submitted = calls.find(call => call.url === '/api/simulation/prepare/cancel')
    assert.deepEqual(submitted.data, { simulation_id: 'sim_fixture', task_id: taskId })
    assert.equal(count('/api/simulation/prepare/cancel'), 1, 'no automatic cancel retry')
    assert.equal((await fixture()).profiles, 1)
    assert.equal((await fixture()).config, 0)
    assert.ok(!control('cancel-preparation') || control('cancel-preparation').props.disabled)
    assert.notEqual(view.state(setupChild).phase, 4)
    await release('profile')
    await waitFor(async () => (await getPlan()).data.cancellation?.phase === 'cancelled', 'worker drains and records cancellation')
    await waitFor(() => control('preparation-cancellation-status'), 'cancellation is visible in the actual view')
    const plan = (await getPlan()).data
    assert.equal(plan.owner.busy, false)
    assert.equal(plan.can_prepare, false)
    assert.equal(plan.can_reuse, false)
    assert.equal(plan.prepared.available, false)
    assert.equal(plan.cancellation.blocked, true)
    assert.equal((await fixture()).profiles, 1, 'queued second profile never starts')
    assert.equal((await fixture()).config, 0, 'configuration generation never starts')
    assert.equal(count('/api/simulation/prepare/cancel'), 1)
    const repeated = await api.cancelPreparation({ simulation_id: 'sim_fixture', task_id: taskId })
    assert.equal(repeated.data.accepted, true)
    assert.equal(repeated.data.preparation_phase, 'cancelled')
    view.close()
    view = makeView()
    await view.mount('/simulation/sim_fixture')
    await waitFor(() => control('preparation-cancellation-status'), 'reload observes the durable cancellation')
    for (const id of ['prepare-cast', 'reuse-preparation', 'cancel-preparation']) {
      assert.ok(!control(id) || control(id).props.disabled, id + ' remains unavailable after cancellation')
    }
    assert.notEqual(view.state(setupChild).phase, 4)
    assert.equal(count('/api/simulation/prepare'), 1, 'reload does not regenerate')
    if (scenario === 'lost_response') assert.equal(lost, true)
  }
  assert.equal(count('/api/simulation/start'), 0, 'cancellation never starts an execution run')
  assert.deepEqual(view.warnings, [])
  console.log('actual preparation cancellation workflow passed')
} finally {
  if (service) {
    for (const unit of ['profile', 'final']) {
      try { await service.post('/api/fixture/release', { unit }) } catch {}
    }
  }
  view?.close()
  await proxy?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
