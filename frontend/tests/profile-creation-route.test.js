import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, setupChild, setupView } from './helpers/parent-route-fixture.js'

// Exercise the real compiled Step 2 script/template, Vue router and locale files.
// The existing fixture supplies finite HTTP replies and manual timers; its
// transition facade avoids browser animation APIs. No profile helper is mocked.
const copy = value => JSON.parse(JSON.stringify(value))
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, id) => h.find(node => node.props?.['data-testid'] === id)
const hasClass = (node, value) => String(node.props?.class ?? '').split(/\s+/).includes(value)
const textContent = node => !node || node.type === '#comment' ? ''
  : [node.text || '', ...(node.children || []).map(textContent)].join(' ').replace(/\s+/g, ' ').trim()
const modal = h => h.find(node => hasClass(node, 'profile-modal'))
const start = h => h.find(node => node.type === 'button' && hasClass(node, 'action-btn') && hasClass(node, 'primary'))
const counts = h => Object.fromEntries(Object.entries(h.requests).map(([name, calls]) => [name, calls.length]))
const fixture = (locale = 'en', local = true) => build({ manualPlan: local, locale, disableTransitions: true })
const profile = (name, generation_provenance) => ({ user_id: 0, name, username: name,
  bio: 'Biography for ' + name, persona: 'Persona for ' + name, entity_type: 'Person',
  ...(generation_provenance === undefined ? {} : { generation_provenance }) })
const savedPlan = id => ({ simulation_id: id, mode: 'local', status: 'ready',
  limits: { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 },
  owner: { busy: false, reason_code: null, task_id: null },
  prepared: { available: true, info: { profiles_count: 2, configured_rounds: 2 } }, can_prepare: false, can_reuse: true })
const config = () => ({ status: 'ready', is_generating: false, config_generated: true,
  config: { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } } })
async function click(h, id) {
  const button = control(h, id)
  assert.ok(button && !button.props.disabled, id + ' enabled')
  button.props.onClick(); await settle()
}
async function plan(h, id = 'A', data = savedPlan(id)) {
  pending(h, 'getPreparationPlan').resolve(ok(data)); await settle()
  if (pending(h, 'getEnvStatus')) {
    pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
    pending(h, 'getSimulation').resolve(ok({ status: 'ready' })); await settle()
  }
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(data)); await settle() }
}
async function reuse(h) {
  await click(h, 'reuse-preparation')
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  return pending(h, 'getSimulationProfilesRealtime')
}
async function finish(h, rows) {
  pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: rows })); await settle()
  pending(h, 'getSimulationConfigRealtime').resolve(ok(config())); await settle()
}
async function saved(h, rows, id = 'A') {
  await h.mount('/simulation/' + id); await plan(h, id); await reuse(h); await finish(h, rows)
}
async function open(h, name) {
  const card = h.find(node => hasClass(node, 'profile-card') && textContent(node).includes('@' + name))
  assert.ok(card, 'profile card for ' + name)
  card.props.onClick(); await settle()
  assert.ok(modal(h), 'profile modal opened')
  assert.ok(textContent(modal(h)).includes('Biography for ' + name))
  assert.ok(textContent(modal(h)).includes('Persona for ' + name))
}
async function close(h) {
  h.find(node => hasClass(node, 'close-btn')).props.onClick(); await settle()
  assert.equal(modal(h), undefined)
  assert.equal(h.state(setupChild).selectedProfile, null)
}

const wording = {
  en: {
    heading: 'Recorded creation route',
    note: 'This record does not establish field-by-field origin, completeness, or quality.',
    length: 'The provider reported an output-length limit for the accepted response.',
    model_json: ['Model response parsed', 'Accepted through JSON parsing; defaults and formatting may still have been applied'],
    model_recovered_json: ['Model JSON recovered', 'Accepted through the existing JSON recovery path; defaults and formatting may still have been applied'],
    model_partial_fields: ['Model fields recovered', 'Accepted after extracting available fields from an unparseable response; other values may come from defaults'],
    rule_requested: ['Rule-based template', 'Created through the selected template path'],
    rule_fallback: ['Rule-based fallback', 'Created by rules after the model-generation attempts did not produce an accepted profile'],
    basic_fallback: ['Basic fallback profile', 'Created from entity information after profile preparation encountered an error'],
    unknown: ['Unknown / legacy', 'No supported creation-route record is available for this profile']
  },
  zh: {
    heading: '记录的创建路径',
    note: '此记录不能说明每个字段的来源、内容完整性或质量。',
    length: '提供方报告：已接受的响应达到了输出长度限制。',
    model_json: ['模型响应已解析', '通过 JSON 解析接受；仍可能应用了默认值和格式处理'],
    model_recovered_json: ['模型 JSON 已恢复', '通过现有的 JSON 恢复路径接受；仍可能应用了默认值和格式处理'],
    model_partial_fields: ['模型字段已提取', '从无法解析的响应中提取可用字段后接受；其他值可能来自默认值'],
    rule_requested: ['规则模板', '通过所选模板路径创建'],
    rule_fallback: ['规则回退', '模型生成尝试未能产生可接受的人设后，通过规则创建'],
    basic_fallback: ['基础回退人设', '人设准备遇到错误后，根据实体信息创建'],
    unknown: ['未知／旧版', '此人设没有受支持的创建路径记录']
  }
}
function assertRoute(h, locale, route, length = false) {
  const words = wording[locale]
  assert.equal(textContent(control(h, 'profile-creation-route')),
    [words.heading, ...words[route], ...(length ? [words.length] : []), words.note].join(' '))
}
const modelRoutes = ['model_json', 'model_recovered_json', 'model_partial_fields']
const ruleRoutes = ['rule_requested', 'rule_fallback', 'basic_fallback']
const validCases = [
  ...modelRoutes.flatMap(route => [false, true].map(length => ({ route, length,
    record: { version: 1, route, provider_reported_length: length } }))),
  ...ruleRoutes.map(route => ({ route, length: false, record: { version: 1, route } })),
  { route: 'unknown', length: false, record: undefined }
]

for (const locale of ['en', 'zh']) {
  test(locale + ': each recorded route renders its exact static explanation and accepted length observation', async () => {
    const h = fixture(locale)
    const rows = validCases.map((entry, index) => profile('route-' + index, entry.record))
    try {
      await saved(h, rows)
      const before = counts(h)
      assert.equal(start(h).props.disabled, false)
      for (const [index, entry] of validCases.entries()) {
        await open(h, 'route-' + index)
        assertRoute(h, locale, entry.route, entry.length)
        await close(h)
        await open(h, 'route-' + index)
        assertRoute(h, locale, entry.route, entry.length)
        await close(h)
      }
      assert.deepEqual(counts(h), before, 'display, close and reopen make no requests')
      assert.equal(h.state(setupChild).phase, 4)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.equal(start(h).props.disabled, false)
      assert.equal(h.intervals.size, 0)
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}

const invalidCases = [
  ['absent', undefined], ['null', null], ['blank', ''], ['array', []], ['boolean', true], ['number', 1],
  ['CSV text is not an API object', '{"version":1,"route":"rule_requested"}'],
  ['empty object', {}], ['boolean version', { version: true, route: 'rule_requested' }],
  ['string version', { version: '1', route: 'rule_requested' }],
  ['unsupported version', { version: 2, route: 'rule_requested' }],
  ['fractional version', { version: 1.5, route: 'rule_requested' }],
  ['missing route', { version: 1 }], ['non-string route', { version: 1, route: ['rule_requested'] }],
  ['prototype name route', { version: 1, route: '__proto__' }],
  ['raw route', { version: 1, route: '<img src=x onerror=PRIVATE_METADATA>' }],
  ...modelRoutes.flatMap(route => [
    ['missing length for ' + route, { version: 1, route }],
    ['null length for ' + route, { version: 1, route, provider_reported_length: null }],
    ['numeric length for ' + route, { version: 1, route, provider_reported_length: 1 }],
    ['string length for ' + route, { version: 1, route, provider_reported_length: 'false' }],
    ['extra key for ' + route, { version: 1, route, provider_reported_length: true, finish_reason: 'PRIVATE_METADATA' }]
  ]),
  ...ruleRoutes.flatMap(route => [
    ['length on ' + route, { version: 1, route, provider_reported_length: false }],
    ['extra key for ' + route, { version: 1, route, message: 'PRIVATE_METADATA' }]
  ])
]

for (const locale of ['en', 'zh']) {
  test(locale + ': absent, malformed and unsupported metadata stays unknown without hiding profile content', async () => {
    const h = fixture(locale)
    const rows = invalidCases.map(([_case, record], index) => profile('invalid-' + index, record))
    rows.push(profile('valid-neighbor', { version: 1, route: 'rule_requested' }))
    try {
      await saved(h, rows)
      const before = counts(h)
      for (let index = 0; index < invalidCases.length; index++) {
        await open(h, 'invalid-' + index)
        assertRoute(h, locale, 'unknown')
        assert.ok(!textContent(h.host).includes('PRIVATE_METADATA'), invalidCases[index][0])
        assert.equal(start(h).props.disabled, false)
        await close(h)
      }
      await open(h, 'valid-neighbor'); assertRoute(h, locale, 'rule_requested')
      assert.deepEqual(counts(h), before)
      assert.equal(h.state(setupChild).profiles.length, rows.length)
      assert.equal(h.state(setupView).currentStatus, 'completed')
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  })
}

test('saved preparation reopens in a fresh view with its own routes despite the default profile mode', async () => {
  const rows = [profile('saved-model', { version: 1, route: 'model_partial_fields', provider_reported_length: true }),
    profile('saved-legacy')]
  for (const locale of ['en', 'zh']) {
    const h = fixture(locale)
    try {
      await saved(h, copy(rows))
      assert.equal(h.state(setupChild).useLlmProfiles, false, 'saved request selections are not reconstructed')
      await open(h, 'saved-model'); assertRoute(h, locale, 'model_partial_fields', true)
      h.state(setupChild).useLlmProfiles = true; await settle()
      assertRoute(h, locale, 'model_partial_fields', true)
      await close(h); await open(h, 'saved-legacy'); assertRoute(h, locale, 'unknown')
      assert.equal(h.calls('getSimulationProfilesRealtime').length, 1)
      assert.equal(h.calls('getSimulationProfilesRealtime')[0].args[0], 'A')
      assert.deepEqual(copy(h.calls('prepareSimulation')[0].args[0]), { simulation_id: 'A', preparation_mode: 'reuse' })
      assert.deepEqual(h.warnings, [])
    } finally { h.close() }
  }
})

test('changing language while the modal is open translates the same recorded snapshot without requests', async () => {
  const h = fixture()
  try {
    await saved(h, [profile('language', { version: 1, route: 'model_json', provider_reported_length: true })])
    await open(h, 'language'); assertRoute(h, 'en', 'model_json', true)
    const selected = h.state(setupChild).selectedProfile, before = counts(h)
    h.i18n.global.locale.value = 'zh'; await settle()
    assertRoute(h, 'zh', 'model_json', true)
    assert.equal(h.state(setupChild).selectedProfile, selected)
    assert.deepEqual(counts(h), before)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('an open preview keeps its selected content and route when final rows replace the same user ID', async () => {
  const h = fixture('en', false)
  try {
    await h.mount('/simulation/A')
    pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A' })); await settle()
    await h.tick(3000)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [profile('preview', {
      version: 1, route: 'model_recovered_json', provider_reported_length: true
    })] })); await settle()
    await open(h, 'preview')
    const selected = h.state(setupChild).selectedProfile
    await h.tick(2000)
    pending(h, 'getPrepareStatus').resolve(ok({ status: 'ready' })); await settle()
    await finish(h, [profile('final', { version: 1, route: 'basic_fallback' })])
    assert.equal(h.state(setupChild).selectedProfile, selected)
    assert.equal(h.state(setupChild).profiles[0].name, 'final')
    assert.ok(textContent(modal(h)).includes('Biography for preview'))
    assert.ok(!textContent(modal(h)).includes('Biography for final'))
    assertRoute(h, 'en', 'model_recovered_json', true)
    await close(h); await open(h, 'final'); assertRoute(h, 'en', 'basic_fallback')
    assert.equal(h.state(setupView).currentStatus, 'completed')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('an existing selection reset clears the modal and rejects late preview metadata from another simulation', async () => {
  const h = fixture('en', false)
  try {
    await h.mount('/simulation/A')
    pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A' })); await settle()
    await h.tick(3000)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [profile('A-selected', {
      version: 1, route: 'model_json', provider_reported_length: true
    })] })); await settle()
    await open(h, 'A-selected'); assertRoute(h, 'en', 'model_json', true)
    await h.tick(3000)
    const old = pending(h, 'getSimulationProfilesRealtime')
    await h.navigate('/simulation/B')
    assert.equal(h.state(setupChild).selectedProfile, null)
    assert.equal(modal(h), undefined)
    assert.equal(h.state(setupChild).profiles.length, 0)
    pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
    await finish(h, [profile('B-current', { version: 1, route: 'rule_fallback' })])
    await open(h, 'B-current'); assertRoute(h, 'en', 'rule_fallback')
    old.resolve(ok({ profiles: [profile('A-late', { version: 1, route: 'model_partial_fields', provider_reported_length: true })] }))
    await settle()
    assert.equal(old.signal.aborted, true)
    assert.equal(h.state(setupChild).profiles[0].name, 'B-current')
    assert.equal(h.state(setupChild).selectedProfile.name, 'B-current')
    assertRoute(h, 'en', 'rule_fallback')
    assert.ok(!textContent(modal(h)).includes('A-late'))
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('retired final profile metadata cannot replace reopened A after A to B to A', async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A'); await plan(h)
    const old = await reuse(h)
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await plan(h)
    await reuse(h); await finish(h, [profile('current-A', { version: 1, route: 'rule_requested' })])
    await open(h, 'current-A'); assertRoute(h, 'en', 'rule_requested')
    const selected = h.state(setupChild).selectedProfile, before = counts(h)
    old.resolve(ok({ profiles: [profile('retired-A', { version: 1, route: 'model_json', provider_reported_length: true })] }))
    await settle()
    assert.equal(old.signal.aborted, true)
    assert.equal(h.state(setupChild).selectedProfile, selected)
    assert.equal(h.state(setupChild).profiles[0].name, 'current-A')
    assertRoute(h, 'en', 'rule_requested')
    assert.deepEqual(counts(h), before)
    assert.equal(h.state(setupView).currentStatus, 'completed')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('unknown metadata leaves the existing Cancel preparation task pair and Start block unchanged', async () => {
  const h = fixture()
  const task = { simulation_id: 'A', task_id: 'task-A', status: 'processing', progress: 30,
    message: '', progress_detail: {}, already_prepared: false, preparation_phase: 'preparing',
    can_cancel: true, cancellation_requested: false }
  const activePlan = { ...savedPlan('A'), status: 'preparing',
    owner: { busy: true, reason_code: 'preparation_busy', task_id: 'task-A' },
    prepared: { available: false, reason_code: 'prepared_unavailable', info: null },
    can_prepare: false, can_reuse: false, preparation_task: task,
    cancellation: { blocked: false, phase: null, task_id: null, reason_code: null } }
  try {
    await h.mount('/simulation/A'); await plan(h, 'A', activePlan)
    await h.tick(3000)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [profile('cancel-preview', {
      version: 1, route: 'rule_requested', provider_reported_length: true
    })] })); await settle()
    const before = counts(h)
    await open(h, 'cancel-preview'); assertRoute(h, 'en', 'unknown')
    assert.deepEqual(counts(h), before)
    assert.equal(start(h).props.disabled, true)
    assert.equal(h.calls('prepareSimulation').length, 0)
    await click(h, 'cancel-preparation')
    assert.equal(h.calls('cancelPreparation').length, 1)
    const request = pending(h, 'cancelPreparation')
    assert.deepEqual(copy(request.args[0]), { simulation_id: 'A', task_id: 'task-A' })
    request.resolve(ok({ accepted: true, ...task, preparation_phase: 'cancelling', can_cancel: false,
      cancellation_requested: true })); await settle()
    assert.equal(h.state(setupChild).cancellationBlocked, true)
    assert.equal(start(h).props.disabled, true)
    assert.equal(h.calls('cancelPreparation').length, 1)
    assertRoute(h, 'en', 'unknown')
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('unknown metadata does not bypass final-read failure or alter explicit Refresh and Reuse recovery', async () => {
  const h = fixture()
  try {
    await h.mount('/simulation/A'); await plan(h); await reuse(h)
    pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [profile('legacy')] })); await settle()
    await open(h, 'legacy'); assertRoute(h, 'en', 'unknown')
    pending(h, 'getSimulationConfigRealtime').resolve({ success: true }); await settle()
    assertRoute(h, 'en', 'unknown')
    assert.equal(h.state(setupView).currentStatus, 'error')
    assert.equal(start(h).props.disabled, true)
    const before = counts(h)
    await close(h)
    assert.deepEqual(counts(h), before)
    await click(h, 'refresh-plan'); await plan(h); await reuse(h)
    await finish(h, [profile('legacy')])
    await open(h, 'legacy'); assertRoute(h, 'en', 'unknown')
    assert.equal(h.state(setupView).currentStatus, 'completed')
    assert.equal(start(h).props.disabled, false)
    assert.equal(h.calls('prepareSimulation').length, 2)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})
