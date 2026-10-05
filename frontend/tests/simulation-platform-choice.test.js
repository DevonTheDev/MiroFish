import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'
import axios from 'axios'
import { build, ok, settle, textContent } from './helpers/simulation-platform-fixture.js'
import { build as setupBuild, setupChild, settle as setupSettle } from './helpers/parent-route-fixture.js'

const choices = { parallel: [true, true], twitter: [true, false], reddit: [false, true] }
const creation = h => h.control('create-simulation')
async function navigateResponse(h, request, data, path) {
  const navigated = new Promise(resolve => { const remove = h.router.afterEach(to => { if (to.path === path) { remove(); resolve() } }) })
  request.resolve(ok(data)); await navigated; await settle()
}
const select = async (h, value) => { h.control('simulation-platform').props.onChange({ target: { value } }); await settle() }
const panels = h => ['twitter', 'reddit'].filter(mode => h.control('platform-status-' + mode))
const actions = [
  { id: 't1', platform: 'twitter', agent_name: 'Synthetic', action_type: 'CREATE_POST', action_args: { content: 'Plaza event' } },
  { id: 'r1', platform: 'reddit', agent_name: 'Synthetic', action_type: 'CREATE_POST', action_args: { content: 'Community event' } },
]
async function start(h, platform) { await h.mount('/simulation/A/start'); h.pending('startSimulation').resolve(ok({ platform, runner_status: 'running' })); await settle() }

for (const [mode, flags] of Object.entries(choices)) test('actual creation control sends exact ' + mode + ' flags and navigates', async () => {
  const h = build(); try {
    await h.mount()
    assert.equal(h.control('simulation-platform').props.value, 'parallel')
    await select(h, mode)
    const click = creation(h).props.onClick
    click(); click(); await settle()
    assert.equal(h.calls('createSimulation').length, 1)
    const request = h.pending('createSimulation')
    assert.deepEqual(JSON.parse(JSON.stringify(request.args[0])), { project_id: 'A', graph_id: 'GA', enable_twitter: flags[0], enable_reddit: flags[1] })
    assert.ok(request.signal instanceof AbortSignal)
    assert.equal(h.control('simulation-platform').props.disabled, true)
    assert.equal(creation(h).props.disabled, true)
    await select(h, mode === 'twitter' ? 'reddit' : 'twitter')
    assert.equal(h.control('simulation-platform').props.value, mode)
    await navigateResponse(h, request, { simulation_id: 'new-' + mode }, '/simulation/new-' + mode)
    assert.equal(h.router.currentRoute.value.path, '/simulation/new-' + mode)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test('literal platform choices are accessible and translated in ' + locale, async () => {
  const h = build({ locale }); try {
    await h.mount()
    assert.ok(h.control('simulation-platform').props['aria-label'])
    assert.match(h.text(), locale === 'en' ? /Both.*Info Plaza.*Topic Community/ : /两个平台.*信息广场.*话题社区/)
    assert.match(h.text(), /Twitter/); assert.match(h.text(), /Reddit/)
    assert.doesNotMatch(h.text(), /step1\./)
  } finally { h.close() }
})

test('invalid platform input and invalid graph or phase cannot create a simulation', async () => {
  const h = build(); try {
    await h.mount(); await select(h, 'invalid')
    assert.equal(h.control('simulation-platform').props.value, 'parallel')
    const click = creation(h).props.onClick
    h.sourceProps.currentPhase = 1; await settle(); click(); await settle()
    assert.equal(h.calls('createSimulation').length, 0)
    h.sourceProps.currentPhase = 2; h.sourceProps.projectData = { project_id: 'A', graph_id: '' }; await settle()
    assert.equal(creation(h).props.disabled, true); creation(h).props.onClick(); await settle()
    assert.equal(h.calls('createSimulation').length, 0)
  } finally { h.close() }
})

for (const rejected of [false, true]) test('creation A → B → A retires old handlers and ' + (rejected ? 'errors' : 'responses'), async () => {
  const h = build(); try {
    await h.mount(); await select(h, 'twitter')
    const oldClick = creation(h).props.onClick, oldSelect = h.control('simulation-platform').props.onChange
    oldClick(); await settle(); const old = h.pending('createSimulation')
    await h.navigate('/process/B'); await h.navigate('/process/A')
    assert.ok(old.signal.aborted)
    oldClick(); oldSelect({ target: { value: 'reddit' } }); await settle()
    assert.equal(h.calls('createSimulation').length, 1)
    assert.equal(h.control('simulation-platform').props.value, 'parallel')
    creation(h).props.onClick(); await settle()
    const current = h.pending('createSimulation')
    if (rejected) old.reject(new Error('stale creation'))
    else old.resolve(ok({ simulation_id: 'stale' }))
    await settle()
    assert.equal(h.router.currentRoute.value.path, '/process/A')
    assert.equal(creation(h).props.disabled, true)
    assert.deepEqual(h.alerts, [])
    await navigateResponse(h, current, { simulation_id: 'current' }, '/simulation/current')
    assert.equal(h.router.currentRoute.value.path, '/simulation/current')
  } finally { h.close() }
})

test('graph replacement alone retires captured creation and selection callbacks', async () => {
  const h = build(); try {
    await h.mount(); const oldClick = creation(h).props.onClick
    oldClick(); await settle(); const old = h.pending('createSimulation')
    h.sourceProps.projectData = { project_id: 'A', graph_id: 'new-graph' }; await settle()
    oldClick(); old.resolve(ok({ simulation_id: 'stale' })); await settle()
    assert.ok(old.signal.aborted); assert.equal(h.calls('createSimulation').length, 1)
    creation(h).props.onClick(); await settle()
    assert.equal(h.pending('createSimulation').args[0].graph_id, 'new-graph')
  } finally { h.close() }
})

for (const rejected of [false, true]) test('unmount retires a late create ' + (rejected ? 'failure' : 'success'), async () => {
  const h = build(); await h.mount(); const oldClick = creation(h).props.onClick
  oldClick(); await settle(); const request = h.pending('createSimulation'); h.close(); const pathAfterUnmount = h.router.currentRoute.value.path; oldClick()
  if (rejected) request.reject(new Error('old'))
  else request.resolve(ok({ simulation_id: 'orphan' }))
  await settle()
  assert.ok(request.signal.aborted); assert.equal(h.calls('createSimulation').length, 1)
  assert.equal(h.router.currentRoute.value.path, pathAfterUnmount); assert.deepEqual(h.alerts, [])
})

test('current creation failure permits an explicit retry with captured choice', async () => {
  const h = build(); try {
    await h.mount(); await select(h, 'reddit'); creation(h).props.onClick(); await settle()
    h.pending('createSimulation').reject(new Error('offline')); await settle()
    assert.equal(creation(h).props.disabled, false); assert.equal(h.alerts.length, 1)
    creation(h).props.onClick(); await settle(); assert.equal(h.calls('createSimulation').length, 2)
    assert.equal(h.pending('createSimulation').args[0].enable_twitter, false)
  } finally { h.close() }
})

for (const mode of Object.keys(choices)) test('auto start captures ' + mode + ' through status/detail and report transition', async () => {
  const h = build(); try {
    await start(h, mode)
    const request = h.calls('startSimulation')[0]
    assert.deepEqual(JSON.parse(JSON.stringify(request.args[0])), { simulation_id: 'A', platform: 'auto', force: true, enable_graph_memory_update: true, max_rounds: 7 })
    const expected = mode === 'parallel' ? ['twitter', 'reddit'] : [mode]
    assert.deepEqual(panels(h), expected)
    assert.equal(h.text().includes('Info Plaza'), expected.includes('twitter'))
    assert.equal(h.text().includes('Topic Community'), expected.includes('reddit'))
    await h.tick(2000); h.pending('getRunStatus').resolve(ok({ runner_status: 'running', twitter_completed: true, reddit_completed: true, twitter_current_round: 2, reddit_current_round: 4 })); await settle()
    assert.deepEqual(panels(h), expected)
    assert.equal(h.state('Step3Simulation.vue').phase, 1, 'platform completion is not authoritative')
    await h.tick(3000); h.pending('getRunStatusDetail').resolve(ok({ all_actions: actions })); await settle()
    assert.deepEqual(panels(h), expected)
    for (const platform of ['twitter', 'reddit']) assert.equal(!!h.control('platform-actions-' + platform), expected.includes(platform))
    const text = h.text()
    assert.equal(text.includes('Plaza event'), expected.includes('twitter'))
    assert.equal(text.includes('Community event'), expected.includes('reddit'))
    assert.doesNotMatch(h.logs.join(' '), /dual-platform|parallel simulation/i)
    await h.tick(2000); h.pending('getRunStatus').resolve(ok({ runner_status: 'completed' })); await settle()
    assert.equal(h.state('Step3Simulation.vue').phase, 2)
    const report = h.control('generate-report'); assert.equal(report.props.disabled, false)
    report.props.onClick(); report.props.onClick(); await settle()
    assert.equal(h.calls('generateReport').length, 1)
    assert.equal(h.pending('generateReport').args[0].simulation_id, 'A')
    await navigateResponse(h, h.pending('generateReport'), { report_id: 'report-' + mode }, '/report/report-' + mode)
    assert.equal(h.router.currentRoute.value.path, '/report/report-' + mode)
  } finally { h.close() }
})

for (const platform of [undefined, null, '', 'auto', 'invalid', 0]) test('successful start with unknown metadata ' + JSON.stringify(platform) + ' remains observable without claiming selection', async () => {
  const h = build(); try {
    await start(h, platform)
    assert.deepEqual(panels(h), [])
    assert.match(h.text(), /Selected platform details unavailable/)
    assert.equal(h.intervals.size, 2)
    await h.tick(2000); h.pending('getRunStatus').resolve(ok({ platform: 'reddit', runner_status: 'completed' })); await settle()
    assert.deepEqual(panels(h), [])
    h.control('generate-report').props.onClick(); await settle()
    assert.equal(h.calls('generateReport').length, 1)
  } finally { h.close() }
})

test('route A → B → A cannot carry a prior mode or late start into a new run', async () => {
  const h = build(); try {
    await h.mount('/simulation/A/start'); const old = h.pending('startSimulation')
    await h.navigate('/simulation/B/start'); h.pending('startSimulation').resolve(ok({ platform: 'reddit' })); await settle()
    assert.deepEqual(panels(h), ['reddit'])
    await h.navigate('/simulation/A/start'); assert.deepEqual(panels(h), [])
    old.resolve(ok({ platform: 'twitter' })); await settle(); assert.deepEqual(panels(h), [])
    assert.ok(old.signal.aborted)
    h.pending('startSimulation').resolve(ok({ platform: 'parallel' })); await settle()
    assert.deepEqual(panels(h), ['twitter', 'reddit'])
  } finally { h.close() }
})

test('same-ID restart isolates mode and retires captured report callback', async () => {
  const h = build(); try {
    await start(h, 'twitter'); await h.tick(2000); h.pending('getRunStatus').resolve(ok({ runner_status: 'completed' })); await settle()
    const oldReport = h.control('generate-report').props.onClick
    h.state('Step3Simulation.vue').doStartSimulation(); await settle(); assert.deepEqual(panels(h), [])
    h.pending('startSimulation').resolve(ok({ platform: 'reddit' })); await settle()
    await h.tick(2000); h.pending('getRunStatus').resolve(ok({ platform: 'twitter', runner_status: 'completed' })); await settle()
    oldReport(); await settle(); assert.equal(h.calls('generateReport').length, 0)
    assert.deepEqual(panels(h), ['reddit'])
    h.control('generate-report').props.onClick(); await settle(); assert.equal(h.calls('generateReport').length, 1)
  } finally { h.close() }
})

for (const locale of ['en', 'zh']) test('single-platform preparation renders optional CSV topics and neutral wording in ' + locale, async () => {
  const h = setupBuild({ locale, disableTransitions: true }); try {
    await h.mount('/simulation/A')
    h.calls('prepareSimulation').at(-1).resolve(ok({ already_prepared: true })); await setupSettle()
    h.calls('getSimulationProfilesRealtime').at(-1).resolve(ok({ profiles: [
      { name: 'Twitter person', username: 'one', bio: 'Bio', persona: 'Persona' },
      { name: 'Legacy person', interested_topics: 'science' },
      { name: 'Array person', interested_topics: ['topic'] },
    ] })); await setupSettle()
    h.calls('getSimulationConfigRealtime').at(-1).resolve(ok({ status: 'ready', is_generating: false, config_generated: true,
      config: { twitter_config: {}, time_config: { total_simulation_hours: 1, minutes_per_round: 30 } } })); await setupSettle()
    assert.equal(h.state(setupChild).totalTopicsCount, 1)
    const text = textContent(h.host)
    assert.doesNotMatch(text, /Dual-Platform|Dual-World|双平台|双世界/)
    assert.match(text, locale === 'en' ? /Selected Platform/ : /所选平台/)
    h.state(setupChild).selectProfile(h.state(setupChild).profiles[1]); await setupSettle()
    assert.equal(h.find(node => node.props?.class === 'topics-grid'), undefined)
  } finally { h.close() }
})

async function apiWith(service) {
  const source = await readFile(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ') + '\n;({createSimulation})', { service })
}
test('create API preserves body identity and optional signal including legacy callers', async () => {
  const calls = [], api = await apiWith({ post: (...args) => { calls.push(args); return Promise.resolve({}) } })
  const body = { project_id: 'A', enable_twitter: false, enable_reddit: true }, signal = new AbortController().signal
  await api.createSimulation(body, signal); await api.createSimulation(body)
  assert.equal(calls.length, 2); assert.equal(calls[0][0], '/api/simulation/create')
  assert.equal(calls[0][1], body); assert.equal(calls[0][2]?.signal, signal)
  assert.equal(calls[1][1], body); assert.equal(calls[1][2]?.signal, undefined)
})

test('real Axios transports exact creation JSON and aborts observation without another mutation', { timeout: 5000 }, async t => {
  const received = []; let arrival
  const arrived = new Promise(resolve => { arrival = resolve })
  const server = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk
    received.push({ method: request.method, url: request.url, body: JSON.parse(body) }); arrival(); })
  const controller = new AbortController()
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const api = await apiWith(axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000 }))
  const body = { project_id: 'A', graph_id: 'G', enable_twitter: true, enable_reddit: false }
  const pending = api.createSimulation(body, controller.signal)
  const rejected = assert.rejects(pending, error => axios.isCancel(error))
  await arrived; controller.abort(); await rejected
  assert.deepEqual(received, [{ method: 'POST', url: '/api/simulation/create', body }])
})

test('same-target metadata refresh preserves selection and the owned creation request', async () => {
  const h = build(); try {
    await h.mount(); await select(h, 'reddit'); creation(h).props.onClick(); await settle()
    const request = h.pending('createSimulation')
    h.sourceProps.projectData = { project_id: 'A', graph_id: 'GA', ontology: { entity_types: [] } }; await settle()
    assert.equal(request.signal.aborted, false)
    assert.equal(h.control('simulation-platform').props.value, 'reddit')
    assert.equal(creation(h).props.disabled, true)
    await navigateResponse(h, request, { simulation_id: 'same-target' }, '/simulation/same-target')
  } finally { h.close() }
})

test('run platform selection is independent of route query hints', async () => {
  const h = build(); try {
    await h.mount('/simulation/A/start?platform=reddit&enable_twitter=false')
    assert.equal(h.pending('startSimulation').args[0].platform, 'auto')
    h.pending('startSimulation').resolve(ok({ platform: 'twitter' })); await settle()
    assert.deepEqual(panels(h), ['twitter'])
    await h.navigate('/simulation/A/start?platform=parallel')
    assert.equal(h.calls('startSimulation').length, 1)
    assert.deepEqual(panels(h), ['twitter'])
  } finally { h.close() }
})

for (const mode of Object.keys(choices)) test('accepted Stop preserves captured ' + mode + ' mode when stop response omits metadata', async () => {
  const h = build(); try {
    await start(h, mode)
    h.state('Step3Simulation.vue').handleStopSimulation(); await settle()
    h.pending('stopSimulation').resolve(ok({ runner_status: 'stopped' })); await settle()
    assert.deepEqual(panels(h), mode === 'parallel' ? ['twitter', 'reddit'] : [mode])
    assert.equal(h.state('Step3Simulation.vue').phase, 2)
    assert.equal(h.control('generate-report').props.disabled, false)
  } finally { h.close() }
})
