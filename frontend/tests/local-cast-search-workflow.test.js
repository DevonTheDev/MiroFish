import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, setupChild, runChild } from './helpers/parent-route-fixture.js'

const limits = { valid: true, max_agents: 3, max_selectable_agents: 3, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 }
const plan = { simulation_id: 'A', mode: 'local', status: 'created', limits,
  owner: { busy: false, reason_code: null, task_id: null }, prepared: { available: false }, can_prepare: true, can_reuse: false }
const entity = (uuid, name, entity_type = 'Person', summary = 'Saved preview', text_truncated = false) => ({ uuid, name, entity_type, summary, text_truncated })
const entities = [entity('b', 'Same name', 'Person', 'second 雪 😀 e\u0301'), entity('a', 'Same name', 'Person', '[.*] <img src=x>  literal', true),
  entity('org', '雪 Association', 'Organization', 'different summary'), entity('unicode', 'Élodie', 'Person', 'tabs\tand\nlines\0'),
  ...Array.from({ length: 20 }, (_, i) => entity('extra_' + i, 'Extra person ' + i))]
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, name) => h.find(node => node.props?.['data-testid'] === name)
const text = node => [node?.text || '', ...(node?.children || []).map(text)].join(' ')
const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => all(child, predicate))]
const rows = h => all(h.host, node => String(node.props?.['data-testid'] || '').startsWith('entity-')).map(node => node.props['data-testid'].slice(7))
const selected = h => Array.from(h.state(setupChild).selectedEntityIds)
const requests = h => Object.fromEntries(Object.entries(h.requests).map(([key, value]) => [key, value.length]))
async function click(h, id) { const node = control(h, id); assert.ok(node, id); assert.ok(!node.props.disabled, id + ' enabled'); node.props.onClick(); await settle() }
async function change(h, id, value) { const node = control(h, id); assert.ok(node, id); node.props.onChange({ target: { value } }); await settle() }
async function search(h, value) { const node = control(h, 'cast-search'); assert.ok(node, 'Find cast input'); node.props.onInput({ target: { value } }); await settle() }
async function select(h, id, checked = true) { const node = control(h, 'entity-' + id); assert.ok(node, id); node.props.onChange({ target: { checked } }); await settle() }
async function currentPlan(h) {
  pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle()
  pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
  pending(h, 'getSimulation').resolve(ok({ status: 'created' })); await settle()
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle() }
}
async function load(h, entries = entities) {
  await click(h, 'load-cast')
  pending(h, 'previewPreparation').resolve(ok({ simulation_id: 'A', project_id: 'PA', graph_id: 'GA', entities: entries, limits, eligible_count: entries.length })); await settle()
}
async function setup(h, entries = entities) { await h.mount('/simulation/A'); await currentPlan(h); await load(h, entries) }

for (const locale of ['en', 'zh']) test('local cast search has literal accessible controls and preview scope in ' + locale, async () => {
  const h = build({ manualPlan: true, locale }); try {
    await h.mount('/simulation/A'); assert.equal(control(h, 'cast-search'), undefined)
    await currentPlan(h); assert.equal(control(h, 'cast-search'), undefined)
    await load(h)
    const input = control(h, 'cast-search'), count = control(h, 'cast-visible-count')
    assert.equal(input.type, 'input'); assert.equal(input.props.type, 'search'); assert.equal(Number(input.props.maxlength), 256)
    assert.ok(h.find(node => node.type === 'label' && node.props.for === input.props.id))
    assert.ok(input.props['aria-describedby'].split(' ').includes('cast-search-hint'))
    assert.equal(count.props.role, 'status'); assert.equal(count.props['aria-live'], 'polite')
    assert.match(text(count), /24.*24/)
    assert.equal(control(h, 'cast-clear-filters').props.disabled, true)
    assert.match(text(control(h, 'cast-search-hint')), locale === 'en' ? /loaded.*preview.*256/i : /已加载.*预览.*256/)
    await search(h, '[.*] <img src=x>')
    assert.deepEqual(rows(h), ['a']); assert.ok(text(h.host).includes('[.*] <img src=x>'))
    assert.ok(text(h.host).includes(locale === 'en' ? 'Preview text shortened' : '预览文本已缩短'))
    assert.equal(all(h.host, node => ['img', 'script', 'iframe'].includes(node.type) || node.props?.innerHTML).length, 0)
    assert.doesNotMatch(text(h.host), /localPlan\./); assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test('literal query searches each loaded field with original Unicode and whitespace', async () => {
  const h = build({ manualPlan: true }); try {
    await setup(h)
    const original = JSON.stringify(h.state(setupChild).catalog), before = requests(h)
    for (const [query, expected] of [
      ['sAmE NaMe', ['b', 'a']], ['ORG', ['org']], ['Organization', ['org']], ['SECOND 雪 😀', ['b']],
      ['[.*]', ['a']], ['.*', ['a']], ['  ', ['a']], ['Same name Person', []],
      ['ÉLODIE', ['unicode']], ['é', ['unicode']], ['e\u0301', ['b']], ['Elodie', []],
      ['tabs\tand\nlines\0', ['unicode']], ['\0', ['unicode']], ['not in saved previews', []],
    ]) { await search(h, query); assert.deepEqual(rows(h), expected, JSON.stringify(query)) }
    assert.equal(JSON.stringify(h.state(setupChild).catalog), original)
    assert.deepEqual(selected(h), []); assert.deepEqual(requests(h), before)
  } finally { h.close() }
})

test('query bound matches the search input and never clips or changes selected IDs', async () => {
  const h = build({ manualPlan: true }); try {
    await setup(h, [entity('bound', 'x'.repeat(256)), entity('emoji', '😀'.repeat(128))])
    await select(h, 'emoji'); const before = requests(h)
    await search(h, 'x'.repeat(256)); assert.deepEqual(rows(h), ['bound'])
    await search(h, 'x'.repeat(257)); assert.equal(control(h, 'cast-search').props.value, 'x'.repeat(256))
    await search(h, '😀'.repeat(128)); assert.deepEqual(rows(h), ['emoji'])
    await search(h, '😀'.repeat(129)); assert.equal(control(h, 'cast-search').props.value, '😀'.repeat(128))
    for (const value of [null, 1, {}, ['x']]) { await search(h, value); assert.equal(control(h, 'cast-search').props.value, '😀'.repeat(128)) }
    assert.deepEqual(selected(h), ['emoji']); assert.deepEqual(requests(h), before)
  } finally { h.close() }
})

test('all query/type/selected-only intersections retain selection order and accurate hidden counts', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await setup(h); await select(h, 'org'); await select(h, 'a'); await select(h, 'b')
    const before = requests(h)
    const everyId = entities.map(row => row.uuid), personIds = everyId.filter(id => id !== 'org')
    const intersections = [
      ['', '', everyId, ['org', 'a', 'b']], ['', 'Same', ['b', 'a'], ['a', 'b']], ['', '雪', ['b', 'org'], ['org', 'b']], ['', 'absent', [], []],
      ['Person', '', personIds, ['a', 'b']], ['Person', 'Same', ['b', 'a'], ['a', 'b']], ['Person', '雪', ['b'], ['b']], ['Person', 'absent', [], []],
      ['Organization', '', ['org'], ['org']], ['Organization', 'Same', [], []], ['Organization', '雪', ['org'], ['org']], ['Organization', 'absent', [], []],
    ]
    for (const only of [false, true]) for (const [type, query, allIds, selectedIds] of intersections) {
      await change(h, 'cast-view', only ? 'selected' : 'all'); await change(h, 'cast-filter', type); await search(h, query)
      const expected = only ? selectedIds : allIds
      assert.deepEqual(rows(h), expected, JSON.stringify({ only, type, query }))
      assert.deepEqual(selected(h), ['org', 'a', 'b'])
      const hidden = 3 - expected.filter(id => ['org', 'a', 'b'].includes(id)).length
      if (hidden) assert.match(text(control(h, 'cast-hidden-selected')), new RegExp('^\\s*' + hidden + ' selected'))
      else assert.equal(control(h, 'cast-hidden-selected'), undefined)
      assert.match(text(control(h, 'cast-visible-count')), new RegExp(expected.length + ' of 24'))
    }
    await click(h, 'cast-clear-filters')
    assert.equal(control(h, 'cast-search').props.value, ''); assert.equal(control(h, 'cast-filter').props.value, ''); assert.equal(control(h, 'cast-view').props.value, 'all')
    assert.deepEqual(rows(h), entities.map(row => row.uuid)); assert.deepEqual(selected(h), ['org', 'a', 'b'])
    assert.equal(control(h, 'entity-extra_0').props.disabled, true)
    await change(h, 'cast-view', 'selected'); assert.deepEqual(rows(h), ['org', 'a', 'b'])
    await select(h, 'a', false); assert.deepEqual(rows(h), ['org', 'b']); assert.deepEqual(selected(h), ['org', 'b'])
    await change(h, 'cast-view', 'all'); assert.equal(control(h, 'entity-extra_0').props.disabled, false)
    assert.deepEqual(requests(h), before)
  } finally { h.close() }
})

test('empty catalog, no selection and no matches have distinct states', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await setup(h, []); assert.ok(control(h, 'cast-empty')); assert.equal(control(h, 'cast-no-selection'), undefined)
    await load(h); await change(h, 'cast-view', 'selected')
    assert.ok(control(h, 'cast-no-selection')); assert.equal(control(h, 'cast-empty'), undefined)
    await change(h, 'cast-view', 'all'); await select(h, 'a'); await search(h, 'absent')
    assert.ok(control(h, 'cast-no-matches')); assert.equal(control(h, 'cast-no-selection'), undefined)
    await change(h, 'cast-view', 'selected'); assert.ok(control(h, 'cast-no-matches')); assert.deepEqual(selected(h), ['a'])
  } finally { h.close() }
})

for (const phase of ['loading', 'planning', 'preparing']) test(phase + ' disables view controls and captured edits', async () => {
  const h = build({ manualPlan: true }); try {
    await setup(h); await select(h, 'a'); await search(h, 'Same')
    const searchInput = control(h, 'cast-search').props.onInput, viewChange = control(h, 'cast-view').props.onChange
    const clear = control(h, 'cast-clear-filters').props.onClick
    if (phase === 'loading') await click(h, 'load-cast')
    if (phase === 'planning') { h.state(setupChild).planLoading = true; await settle() }
    if (phase === 'preparing') await click(h, 'prepare-cast')
    for (const id of ['cast-search', 'cast-view', 'cast-filter', 'cast-clear-filters']) assert.equal(control(h, id).props.disabled, true, id)
    searchInput({ target: { value: 'different' } }); viewChange({ target: { value: 'selected' } }); clear(); await settle()
    assert.equal(control(h, 'cast-search').props.value, 'Same'); assert.equal(control(h, 'cast-view').props.value, 'all'); assert.deepEqual(selected(h), ['a'])
  } finally { h.close() }
})

for (const reset of ['catalog', 'refresh', 'route']) test(reset + ' restores empty filters with fresh entity type options', async () => {
  const h = build({ manualPlan: true }); try {
    await setup(h); await select(h, 'a'); await search(h, 'Same'); await change(h, 'cast-filter', 'Person'); await change(h, 'cast-view', 'selected')
    const oldSearch = control(h, 'cast-search').props.onInput, oldView = control(h, 'cast-view').props.onChange, oldClear = control(h, 'cast-clear-filters').props.onClick
    if (reset === 'refresh') { await click(h, 'refresh-plan'); pending(h, 'getPreparationPlan').resolve(ok(plan)); await settle() }
    if (reset === 'route') { await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await currentPlan(h) }
    await load(h, [entity('new', 'New event', 'Event')])
    assert.equal(control(h, 'cast-search').props.value, ''); assert.equal(control(h, 'cast-filter').props.value, ''); assert.equal(control(h, 'cast-view').props.value, 'all')
    assert.deepEqual(selected(h), []); assert.deepEqual(rows(h), ['new'])
    assert.deepEqual(all(control(h, 'cast-filter'), node => node.type === 'option').map(node => node.props.value), ['', 'Event'])
    if (reset !== 'catalog') {
      await search(h, 'New'); oldSearch({ target: { value: 'stale' } }); oldView({ target: { value: 'selected' } }); oldClear(); await settle()
      assert.equal(control(h, 'cast-search').props.value, 'New'); assert.equal(control(h, 'cast-view').props.value, 'all')
    }
  } finally { h.close() }
})

test('hidden selections round-trip in presets and explicit preparation/Start with original ordered IDs', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await setup(h); await search(h, '[.*]'); await select(h, 'a'); await search(h, 'second'); await select(h, 'b')
    control(h, 'profile-mode').props.onChange({ target: { value: 'llm' } }); control(h, 'draft-maximum-rounds').props.onInput({ target: { value: '2' } }); await settle()
    const before = requests(h)
    await click(h, 'save-cast-preset')
    const saved = JSON.parse(await h.downloads[0].blob.text())
    assert.deepEqual(saved, { schema_version: 1, kind: 'mirofish_local_cast_preset', project_id: 'PA', graph_id: 'GA', selected_entity_ids: ['a', 'b'], use_llm_for_profiles: true, max_rounds: 2 })
    await click(h, 'cast-clear-filters'); await select(h, 'a', false); await select(h, 'b', false); await select(h, 'org'); await search(h, 'absent')
    const bytes = new TextEncoder().encode(JSON.stringify(saved))
    control(h, 'open-cast-preset').props.onChange({ target: { value: 'cast.json', files: [{ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }] } }); await settle()
    await click(h, 'apply-cast-preset')
    assert.deepEqual(selected(h), ['a', 'b']); assert.equal(control(h, 'cast-search').props.value, 'absent'); assert.deepEqual(rows(h), [])
    assert.match(text(control(h, 'cast-hidden-selected')), /2 selected/)
    await click(h, 'cast-clear-filters'); await change(h, 'cast-view', 'selected'); assert.deepEqual(rows(h), ['a', 'b'])
    await search(h, 'second'); assert.deepEqual(rows(h), ['b']); assert.deepEqual(requests(h), before)
    await click(h, 'prepare-cast')
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'prepareSimulation').args[0])), { simulation_id: 'A', preparation_mode: 'prepare', selected_entity_ids: ['a', 'b'], use_llm_for_profiles: true, parallel_profile_count: 1 })
    pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
    pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [] })); await settle()
    pending(h, 'getSimulationConfigRealtime').resolve(ok({ status: 'ready', is_generating: false, config_generated: true, config: { time_config: { total_simulation_hours: 2, minutes_per_round: 30 } } })); await settle()
    const navigated = new Promise(resolve => { const remove = h.router.afterEach(to => { if (to.name === 'SimulationRun') { remove(); resolve() } }) })
    h.find(node => String(node.props?.class).includes('action-btn primary')).props.onClick(); await navigated; await settle()
    assert.equal(h.child(runChild).props.maxRounds, 2); assert.equal(h.calls('startSimulation')[0].args[0].max_rounds, 2)
    assert.equal(h.calls('prepareSimulation').length, 1); assert.equal(h.calls('previewPreparation').length, 1); assert.equal(h.calls('getGraphData').length, 0)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})
