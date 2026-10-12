import assert from 'node:assert/strict'
import test from 'node:test'
import { build as buildParent, settle, ok, graphView } from './helpers/parent-route-fixture.js'

const view = 'views/NotFoundView.vue'
const build = (options = {}) => buildParent({ locale: 'en', extraViews: [view], ...options })
const text = node => [node.text ?? '', ...(node.children ?? []).filter(child => child.type !== '#comment').map(text)].join(' ')
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const calls = h => Object.fromEntries(Object.entries(h.requests).map(([name, entries]) => [name, entries.length]))
const click = node => node.props.onClick({ button: 0, preventDefault() {} })
async function travel(h, direction) {
  const changed = new Promise(resolve => { const remove = h.router.afterEach(() => { remove(); resolve() }) })
  h.router[direction](); await changed; await settle()
}

for (const locale of ['en', 'zh']) test(`${locale} unknown URL renders recovery without displaying location details or requesting data`, async () => {
  const h = build({ locale })
  try {
    const url = '/private-unknown/deep?private-query=secret&private-query=again#private-anchor'
    await h.mount(url)
    assert.equal(h.router.currentRoute.value.name, 'NotFound')
    assert.equal(h.router.currentRoute.value.fullPath, url)
    assert.equal(h.router.currentRoute.value.matched.length, 1)
    assert.match(text(h.find(node => node.type === 'h1')), locale === 'en' ? /Page not found/ : /未找到页面/)
    assert.match(text(control(h, 'not-found-home')), locale === 'en' ? /Home/ : /首页/)
    assert.match(text(control(h, 'not-found-simulations')), locale === 'en' ? /Saved simulations/ : /已保存的模拟/)
    assert.doesNotMatch(text(h.host), /private-|secret|notFound\./)
    assert.equal(control(h, 'not-found-home').props.href, '/')
    assert.equal(control(h, 'not-found-simulations').props.href, '/simulations')
    assert.deepEqual(Object.keys(h.requests), [])
    assert.equal(h.intervals.size, 0)
    assert.equal(h.pushes.length, 1, 'the fallback does not redirect or retry navigation')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('all existing named routes preserve their params, query, hash and component props for missing record IDs', () => {
  const h = build()
  const routes = [
    ['/simulations', 'SavedSimulations'],
    ['/interview-files/compare', 'SavedInterviewComparison'],
    ['/report-files', 'SavedReportFiles'],
    ['/activity-files', 'SavedActivityFiles'],
    ['/interview-files', 'SavedInterviewFiles'],
    ['/capture-files', 'RunCaptureFiles'],
    ['/simulation/missing/interviews', 'SavedInterviews', { simulationId: 'missing' }],
    ['/simulation/missing/activity/rounds', 'SavedActivityRounds', { simulationId: 'missing' }],
    ['/prompt-examples', 'PromptExamples'],
    ['/prompt-suite-comparison', 'PromptSuiteComparison'],
    ['/prompt-suites', 'PromptSuites'],
    ['/prompt-trials', 'PromptTrials'],
    ['/captures', 'RunCaptures'],
    ['/reports', 'SavedReports'],
    ['/runtime', 'RuntimeStatus'],
    ['/simulation/missing/activity', 'SavedActivity', { simulationId: 'missing' }],
    ['/compare', 'SimulationComparison'],
    ['/', 'Home'],
    ['/process/missing', 'Process', { projectId: 'missing' }, true],
    ['/simulation/missing', 'Simulation', { simulationId: 'missing' }, true],
    ['/simulation/missing/start', 'SimulationRun', { simulationId: 'missing' }, true],
    ['/report/missing', 'Report', { reportId: 'missing' }, true],
    ['/interaction/missing', 'Interaction', { reportId: 'missing' }, true],
  ]
  try {
    assert.deepEqual(h.router.getRoutes().map(route => route.name).filter(name => name !== 'NotFound').sort(), routes.map(row => row[1]).sort())
    for (const [path, name, params = {}, props = false] of routes) {
      const fullPath = path + '?keep=one&keep=two&flag#section'
      const route = h.router.resolve(fullPath)
      assert.equal(route.name, name)
      assert.equal(route.fullPath, fullPath)
      assert.equal(route.matched.length, 1)
      assert.deepEqual(route.params, params)
      assert.deepEqual(route.query, { keep: ['one', 'two'], flag: null })
      assert.equal(route.hash, '#section')
      assert.equal(route.matched[0].props.default, props)
      assert.equal(h.router.resolve({ name, params, query: route.query, hash: route.hash }).fullPath, fullPath)
    }
    const encoded = h.router.resolve('/simulation/missing%2Frecord/start?maxRounds=7#run')
    assert.equal(encoded.name, 'SimulationRun')
    assert.equal(encoded.params.simulationId, 'missing/record')
    assert.equal(encoded.fullPath, '/simulation/missing%2Frecord/start?maxRounds=7#run')
    assert.equal(h.router.resolve('/SIMULATIONS/').name, 'SavedSimulations')
  } finally { h.close() }
})

test('unknown top-level, incomplete and extra-segment paths select only the fallback', () => {
  const h = build()
  try {
    for (const path of ['/typo', '/typo/deep', '/simulation', '/process/', '/report', '/simulation/missing/typo', '/reports/extra', '/%3Cscript%3E']) {
      const route = h.router.resolve(path)
      assert.equal(route.name, 'NotFound', path)
      assert.equal(route.matched.length, 1, path)
      assert.equal(route.fullPath, path)
      assert.equal(route.redirectedFrom, undefined)
    }
  } finally { h.close() }
})

test('the loaded fallback follows a locale change without navigating or requesting data', async () => {
  const h = build()
  try {
    await h.mount('/unknown?keep=yes#here')
    h.i18n.global.locale.value = 'zh'; await settle()
    assert.match(text(h.host), /未找到页面/)
    assert.match(text(control(h, 'not-found-simulations')), /已保存的模拟/)
    h.i18n.global.locale.value = 'en'; await settle()
    assert.match(text(h.host), /Page not found/)
    assert.equal(h.router.currentRoute.value.fullPath, '/unknown?keep=yes#here')
    assert.equal(h.pushes.length, 1)
    assert.deepEqual(calls(h), {})
  } finally { h.close() }
})

for (const [id, name, destination] of [['home', 'Home', '/'], ['simulations', 'SavedSimulations', '/simulations']]) {
  test(`explicit ${name} recovery preserves Back and Forward history with repeated clicks`, async () => {
    const h = build()
    try {
      const unknown = '/unknown?keep=one&keep=two#original'
      await h.mount(unknown)
      const link = control(h, 'not-found-' + id)
      await Promise.all([click(link), click(link)]); await settle()
      assert.equal(h.router.currentRoute.value.name, name)
      assert.equal(h.router.currentRoute.value.fullPath, destination)
      await travel(h, 'back')
      assert.equal(h.router.currentRoute.value.fullPath, unknown)
      assert.equal(h.router.currentRoute.value.name, 'NotFound')
      assert.ok(control(h, 'not-found-' + id))
      await travel(h, 'forward')
      assert.equal(h.router.currentRoute.value.name, name)
      assert.equal(h.router.currentRoute.value.fullPath, destination)
      // Destination pages are existing boundaries here; their data behavior is
      // covered by their own view suites, not attributed to the fallback.
      assert.deepEqual(calls(h), {})
    } finally { h.close() }
  })
}

test('repeated unknown navigation reuses the page without retaining location text or starting work', async () => {
  const h = build()
  try {
    await h.mount('/first-private?token=first#first')
    const original = h.child(view)
    for (const location of ['/second-private/deep?token=second#second', '/second-private/deep?token=third#third', '/first-private?token=first#first']) {
      await h.navigate(location)
      assert.equal(h.router.currentRoute.value.fullPath, location)
      assert.equal(h.child(view), original)
      assert.doesNotMatch(text(h.host), /private|token|first|second|third/)
    }
    assert.equal(h.pushes.length, 4)
    assert.deepEqual(calls(h), {})
    assert.equal(h.intervals.size, 0)
  } finally { h.close() }
})

for (const running of [false, true]) test(`leaving the ${running ? 'run' : 'setup'} route for an unknown page retires its pending observations`, async () => {
  const h = build()
  try {
    await h.mount('/simulation/missing' + (running ? '/start' : ''))
    const pending = h.calls(running ? 'getSimulation' : 'getEnvStatus')[0]
    assert.ok(pending, 'the valid route retains its existing workflow')
    const before = calls(h)
    await h.navigate('/unknown?private=detail')
    assert.equal(pending.signal.aborted, true)
    assert.equal(h.intervals.size, 0)
    pending.reject(new Error('private late resource failure')); await settle()
    assert.equal(h.router.currentRoute.value.name, 'NotFound')
    assert.match(text(h.host), /Page not found/)
    assert.doesNotMatch(text(h.host), /private|failure/)
    assert.deepEqual(calls(h), before)
  } finally { h.close() }
})

test('leaving a pending project for the fallback cannot continue a graph build after its reply', async () => {
  const h = build({ graphRoute: true })
  try {
    await h.mount('/process/missing')
    const pending = h.calls('getProject')[0]
    await h.navigate('/unknown')
    const before = calls(h)
    pending.resolve(ok({ project_id: 'missing', status: 'ontology_generated' })); await settle()
    assert.equal(pending.signal.aborted, true)
    assert.equal(h.intervals.size, 0)
    assert.equal(h.router.currentRoute.value.name, 'NotFound')
    assert.deepEqual(calls(h), before)
    assert.equal(h.calls('buildGraph').length, 0)
    assert.equal(h.instances[graphView].length, 1)
  } finally { h.close() }
})

test('a canceled explicit recovery stays usable without automatic navigation retries', async () => {
  const h = build()
  try {
    await h.mount('/unknown?keep=yes#here')
    const remove = h.router.beforeEach(to => to.name === 'Home' ? false : undefined)
    await click(control(h, 'not-found-home')); await settle()
    assert.equal(h.router.currentRoute.value.fullPath, '/unknown?keep=yes#here')
    assert.equal(h.pushes.length, 2)
    assert.ok(control(h, 'not-found-home'))
    remove()
    await click(control(h, 'not-found-home')); await settle()
    assert.equal(h.router.currentRoute.value.name, 'Home')
    assert.equal(h.pushes.length, 3)
    assert.deepEqual(calls(h), {})
  } finally { h.close() }
})
