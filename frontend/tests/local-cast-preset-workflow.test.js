import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, setupChild, runChild } from './helpers/parent-route-fixture.js'

const limits = { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 }
const entities = ['a', 'b', 'c'].map(uuid => ({ uuid, name: 'Person ' + uuid, entity_type: 'Person', summary: 'Summary', text_truncated: false }))
const plan = (extra = {}) => ({ simulation_id: 'A', mode: 'local', status: 'created', limits,
  owner: { busy: false, reason_code: null, task_id: null }, prepared: { available: false, reason_code: 'prepared_unavailable', info: null }, can_prepare: true, can_reuse: false, ...extra })
const catalog = (extra = {}) => ({ simulation_id: 'A', project_id: 'PA', graph_id: 'GA', entities, limits, eligible_count: entities.length, total_nodes: entities.length, ...extra })
const preset = (extra = {}) => ({ schema_version: 1, kind: 'mirofish_local_cast_preset', project_id: 'PA', graph_id: 'GA', selected_entity_ids: ['c', 'a'], use_llm_for_profiles: true, max_rounds: 1, ...extra })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const control = (h, name) => h.find(node => node.props?.['data-testid'] === name)
const click = async (h, name) => { const button = control(h, name); assert.ok(button, name); assert.ok(!button.props.disabled, name + ' enabled'); button.props.onClick(); await settle() }
const textContent = node => [node.text || '', ...(node.children || []).map(textContent)].join(' ')
async function currentPlan(h, data = plan()) {
  pending(h, 'getPreparationPlan').resolve(ok(data)); await settle()
  pending(h, 'getEnvStatus').resolve(ok({ env_alive: false })); await settle()
  pending(h, 'getSimulation').resolve(ok({ status: 'created' })); await settle()
  if (pending(h, 'getPreparationPlan')) { pending(h, 'getPreparationPlan').resolve(ok(data)); await settle() }
}
async function planned(h, data = plan()) { await h.mount('/simulation/A'); await currentPlan(h, data) }
async function loaded(h, data = catalog()) { await click(h, 'load-cast'); pending(h, 'previewPreparation').resolve(ok(data)); await settle() }
async function select(h, id, checked = true) { control(h, 'entity-' + id).props.onChange({ target: { checked } }); await settle() }
async function rounds(h, value) { assert.ok(control(h, 'draft-maximum-rounds'), 'draft maximum-rounds control'); control(h, 'draft-maximum-rounds').props.onInput({ target: { value: String(value) } }); await settle() }
const file = value => { const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)); return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } }
async function open(h, value) { const input = control(h, 'open-cast-preset'); assert.ok(input, 'Open cast preset file input'); input.props.onChange({ target: { files: [value], value: 'picked.json' } }); await settle() }
async function ready(h, config = { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } }) {
  pending(h, 'prepareSimulation').resolve(ok({ already_prepared: true })); await settle()
  pending(h, 'getSimulationProfilesRealtime').resolve(ok({ profiles: [] })); await settle()
  pending(h, 'getSimulationConfigRealtime').resolve(ok({ status: 'ready', is_generating: false, config_generated: true, config })); await settle()
}
const requestCounts = h => Object.fromEntries(Object.entries(h.requests).map(([name, calls]) => [name, calls.length]))

test('ordinary draft exports, stages and applies without API calls, then explicit prepare preserves final round flow', async () => {
  const downloads = [], revoked = []
  const h = build({ manualPlan: true, locale: 'en', downloads, revoked }); try {
    await planned(h); await loaded(h)
    await select(h, 'c'); await select(h, 'a')
    control(h, 'profile-mode').props.onChange({ target: { value: 'llm' } }); await settle()
    await rounds(h, 1)
    const before = requestCounts(h)
    await click(h, 'save-cast-preset')
    assert.equal(downloads.length, 1)
    const saved = JSON.parse(await downloads[0].blob.text())
    assert.deepEqual(saved, preset())
    await select(h, 'c', false); await select(h, 'a', false); await select(h, 'b')
    await rounds(h, 4)
    await open(h, file(saved))
    assert.deepEqual(Array.from(h.state(setupChild).selectedEntityIds), ['b'], 'opening only stages')
    assert.ok(textContent(control(h, 'cast-preset-preview')).includes('c'))
    await click(h, 'apply-cast-preset')
    assert.deepEqual(Array.from(h.state(setupChild).selectedEntityIds), ['c', 'a'])
    assert.equal(h.state(setupChild).useLlmProfiles, true)
    assert.equal(h.state(setupChild).localMaxRounds, 1)
    assert.deepEqual(requestCounts(h), before, 'file operations have no API side effects')
    await click(h, 'prepare-cast')
    assert.deepEqual(JSON.parse(JSON.stringify(pending(h, 'prepareSimulation').args[0])), { simulation_id: 'A', preparation_mode: 'prepare', selected_entity_ids: ['c', 'a'], use_llm_for_profiles: true, parallel_profile_count: 1 })
    await ready(h)
    assert.equal(control(h, 'maximum-rounds').props.value, 1)
    const navigated = new Promise(resolve => { const remove = h.router.afterEach(to => { if (to.name === 'SimulationRun') { remove(); resolve() } }) })
    h.find(node => String(node.props?.class).includes('action-btn primary')).props.onClick(); await navigated; await settle()
    assert.equal(h.child(runChild).props.maxRounds, 1)
    assert.equal(h.calls('startSimulation')[0].args[0].max_rounds, 1)
    assert.equal(revoked.length, 1)
  } finally { h.close() }
})

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const heldFile = hold => ({ size: 100, arrayBuffer: () => hold.promise })
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).buffer
const choices = h => ({ ids: Array.from(h.state(setupChild).selectedEntityIds), llm: h.state(setupChild).useLlmProfiles, rounds: h.state(setupChild).localMaxRounds })

for (const late of ['success', 'failure']) test('next file retires previous file ' + late + ' and its captured apply, clear and save callbacks', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b')
    await open(h, file(preset()))
    const staleApply = control(h, 'apply-cast-preset').props.onClick
    const staleClear = control(h, 'clear-cast-preset').props.onClick
    const staleSave = control(h, 'save-cast-preset').props.onClick
    const first = deferred()
    await open(h, heldFile(first))
    await open(h, file(preset({ selected_entity_ids: ['a'], max_rounds: 2, use_llm_for_profiles: false })))
    if (late === 'success') first.resolve(bytes(preset()))
    else first.reject(new Error('PRIVATE /path/credential'))
    await settle()
    staleApply(); staleClear(); staleSave(); await settle()
    assert.equal(h.downloads.length, 0)
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 5 })
    assert.deepEqual(Array.from(h.state(setupChild).presetCandidate.selected_entity_ids), ['a'])
    assert.equal(h.state(setupChild).presetError, '')
    await click(h, 'apply-cast-preset')
    assert.deepEqual(choices(h), { ids: ['a'], llm: false, rounds: 2 })
  } finally { h.close() }
})

for (const action of ['clear', 'refresh', 'catalog', 'navigate', 'unmount']) test(action + ' retires pending file reads and rendered callbacks', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await open(h, file(preset()))
    const staleApply = control(h, 'apply-cast-preset').props.onClick
    const staleSave = control(h, 'save-cast-preset').props.onClick
    const staleOpen = control(h, 'open-cast-preset').props.onChange
    const old = deferred()
    await open(h, heldFile(old))
    if (action === 'clear') await click(h, 'clear-cast-preset')
    if (action === 'refresh') { await click(h, 'refresh-plan'); pending(h, 'getPreparationPlan').resolve(ok(plan())); await settle(); await loaded(h) }
    if (action === 'catalog') await loaded(h, catalog({ graph_id: 'GB' }))
    if (action === 'navigate') {
      await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await currentPlan(h); await loaded(h)
    }
    if (action === 'unmount') h.close()
    old.resolve(bytes(preset())); await settle()
    staleApply(); staleSave(); staleOpen({ target: { files: [file(preset())], value: 'old.json' } }); await settle()
    assert.equal(h.downloads.length, 0)
    assert.equal(h.state(setupChild).presetCandidate, null)
    assert.equal(h.state(setupChild).presetError, '')
    assert.equal(h.state(setupChild).presetReading, false)
    assert.equal(h.calls('prepareSimulation').length, 0)
    assert.deepEqual(Array.from(h.state(setupChild).selectedEntityIds), action === 'clear' || action === 'unmount' ? ['b'] : [])
  } finally { h.close() }
})

for (const [label, input, code] of [
  ['malformed JSON', () => file('{'), 'invalid_preset'],
  ['duplicate JSON keys', () => file(JSON.stringify(preset()).replace('"schema_version":1', '"schema_version":1,"schema_version":1')), 'invalid_preset'],
  ['extra metadata', () => file(preset({ simulation_id: 'A' })), 'invalid_preset'],
  ['duplicate entities', () => file(preset({ selected_entity_ids: ['a', 'a'] })), 'invalid_preset'],
  ['malformed UTF-8', () => ({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }), 'invalid_utf8'],
  ['declared oversized file', () => ({ size: 256 * 1024 + 1, arrayBuffer: () => { assert.fail('must reject before reading') } }), 'file_too_large'],
  ['actual oversized bytes', () => ({ size: 1, arrayBuffer: async () => new Uint8Array(256 * 1024 + 1).buffer }), 'file_too_large'],
  ['read rejection', () => ({ size: 100, arrayBuffer: async () => { throw new Error('PRIVATE token /path') } }), 'read_failed'],
]) test(label + ' retires old candidate and preserves current draft', async () => {
  const h = build({ manualPlan: true, locale: 'en' }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await open(h, file(preset()))
    const staleApply = control(h, 'apply-cast-preset').props.onClick
    const before = requestCounts(h)
    await open(h, input())
    staleApply(); await settle()
    assert.equal(h.state(setupChild).presetCandidate, null)
    assert.equal(h.state(setupChild).presetError, 'localCastPreset.errors.' + code)
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 5 })
    assert.equal(control(h, 'apply-cast-preset'), undefined)
    assert.ok(!textContent(h.host).includes('PRIVATE'))
    assert.deepEqual(requestCounts(h), before)
  } finally { h.close() }
})

for (const [label, source, code] of [
  ['project mismatch', preset({ project_id: 'PB' }), 'identity_mismatch'],
  ['graph mismatch', preset({ graph_id: 'GB' }), 'identity_mismatch'],
  ['missing entity', preset({ selected_entity_ids: ['missing'] }), 'selection_unavailable'],
  ['round limit', preset({ max_rounds: 6 }), 'round_limit_exceeded'],
]) test(label + ' remains a visible incompatible preview and cannot partially apply', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await open(h, file(source))
    assert.ok(control(h, 'cast-preset-preview'))
    assert.equal(h.state(setupChild).presetCompatibility.error, 'localCastPreset.errors.' + code)
    assert.equal(control(h, 'apply-cast-preset').props.disabled, true)
    control(h, 'apply-cast-preset').props.onClick(); await settle()
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 5 })
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

for (const change of ['agents', 'rounds', 'invalid']) test('apply revalidates ' + change + ' limits changed after file admission', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await open(h, file(preset({ max_rounds: 3 })))
    const apply = control(h, 'apply-cast-preset').props.onClick
    h.state(setupChild).localPlan = plan({ limits: change === 'agents' ? { ...limits, max_agents: 1, max_selectable_agents: 1 }
      : change === 'rounds' ? { ...limits, max_rounds: 2 } : { ...limits, valid: false } }); await settle()
    assert.equal(control(h, 'apply-cast-preset').props.disabled, true)
    apply(); await settle()
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 5 })
  } finally { h.close() }
})

test('live edits retain the file preview and apply atomically replaces all three draft choices', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await open(h, file(preset()))
    await select(h, 'b'); await rounds(h, 4)
    assert.ok(control(h, 'cast-preset-preview'))
    await click(h, 'apply-cast-preset')
    assert.deepEqual(choices(h), { ids: ['c', 'a'], llm: true, rounds: 1 })
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

for (const state of ['busy', 'prepared', 'cleanup', 'error', 'unknown', 'cloud']) test(state + ' context blocks captured apply', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await open(h, file(preset()))
    const apply = control(h, 'apply-cast-preset').props.onClick
    const setup = h.state(setupChild)
    if (state === 'busy') setup.localPlan = plan({ owner: { busy: true }, can_prepare: false })
    if (state === 'prepared') setup.localPlan = plan({ prepared: { available: true }, can_prepare: false })
    if (state === 'cleanup') h.child(setupChild).props.cleanupReady = false
    if (state === 'error') setup.planError = 'localPlan.requestError'
    if (state === 'unknown' || state === 'cloud') setup.runtimeMode = state
    await settle(); apply(); await settle()
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 5 })
    assert.equal(h.calls('prepareSimulation').length, 0)
  } finally { h.close() }
})

const projection = (extra = {}) => ({ simulation_id: 'A', task_id: 'task-A', status: 'processing', progress: 10,
  message: '', progress_detail: {}, already_prepared: false, preparation_phase: 'preparing', can_cancel: true, cancellation_requested: false, ...extra })
test('retained draft exports during preparation and cancellation while apply and stale round changes remain blocked', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await rounds(h, 2); await open(h, file(preset()))
    const apply = control(h, 'apply-cast-preset').props.onClick
    const editRounds = control(h, 'draft-maximum-rounds').props.onInput
    await click(h, 'prepare-cast')
    pending(h, 'prepareSimulation').resolve(ok({ task_id: 'task-A', preparation_task: projection() })); await settle()
    apply(); editRounds({ target: { value: '1' } }); await settle()
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 2 })
    assert.equal(control(h, 'apply-cast-preset').props.disabled, true)
    await click(h, 'save-cast-preset')
    assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), preset({ selected_entity_ids: ['b'], use_llm_for_profiles: false, max_rounds: 2 }))
    await click(h, 'cancel-preparation')
    pending(h, 'cancelPreparation').resolve(ok({ accepted: true, ...projection({ preparation_phase: 'cancelling', can_cancel: false, cancellation_requested: true }) })); await settle()
    await h.tick(2000)
    pending(h, 'getPrepareStatus').resolve(ok(projection({ status: 'cancelled', preparation_phase: 'cancelled', can_cancel: false, cancellation_requested: true }))); await settle()
    apply(); editRounds({ target: { value: '1' } }); await settle()
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 2 })
    assert.equal(control(h, 'apply-cast-preset').props.disabled, true)
    await click(h, 'save-cast-preset')
    assert.deepEqual(JSON.parse(await h.downloads[1].blob.text()), JSON.parse(await h.downloads[0].blob.text()))
    assert.equal(h.calls('prepareSimulation').length, 1)
    assert.equal(h.calls('startSimulation').length, 0)
    assert.equal(h.revoked.length, 1)
  } finally { h.close() }
  assert.equal(h.revoked.length, 2)
})

test('ready retained choices export but saved reuse and legacy catalogs cannot invent a selection or graph binding', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'a'); await click(h, 'prepare-cast'); await ready(h)
    await click(h, 'save-cast-preset')
    assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()).selected_entity_ids, ['a'])
    assert.equal(h.calls('prepareSimulation').length, 1)
  } finally { h.close() }
  const reused = build({ manualPlan: true }); try {
    await planned(reused, plan({ can_prepare: false, can_reuse: true, prepared: { available: true, info: { profiles_count: 2 } } }))
    assert.equal(control(reused, 'save-cast-preset').props.disabled, true)
    assert.equal(control(reused, 'open-cast-preset').props.disabled, true)
    await click(reused, 'reuse-preparation'); await ready(reused)
    assert.equal(control(reused, 'save-cast-preset').props.disabled, true)
  } finally { reused.close() }
  const legacy = build({ manualPlan: true }); try {
    await planned(legacy); await loaded(legacy, catalog({ project_id: undefined, graph_id: undefined })); await select(legacy, 'a')
    // Parent metadata is deliberately plausible; it must never grant preset authority.
    legacy.child(setupChild).props.projectData = { project_id: 'PA', graph_id: 'GA' }; await settle()
    assert.equal(control(legacy, 'save-cast-preset').props.disabled, true)
    assert.equal(control(legacy, 'open-cast-preset').props.disabled, true)
    await click(legacy, 'prepare-cast')
    assert.equal(legacy.calls('prepareSimulation').length, 1, 'legacy ordinary prepare still works')
  } finally { legacy.close() }
})

test('downloads revoke object URLs on replacement, file changes, refresh and unmount', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'a')
    await click(h, 'save-cast-preset'); await click(h, 'save-cast-preset')
    assert.equal(h.downloads.length, 2); assert.equal(h.revoked.length, 1); assert.equal(h.objectUrls.size, 1)
    await open(h, file(preset()))
    assert.equal(h.revoked.length, 2); assert.equal(h.objectUrls.size, 0)
    await click(h, 'save-cast-preset'); await click(h, 'clear-cast-preset')
    assert.equal(h.revoked.length, 3)
    await click(h, 'save-cast-preset'); await click(h, 'refresh-plan')
    assert.equal(h.revoked.length, 4)
    pending(h, 'getPreparationPlan').resolve(ok(plan())); await settle(); await loaded(h); await select(h, 'b')
    await click(h, 'save-cast-preset')
  } finally { h.close() }
  assert.equal(h.revoked.length, 5); assert.equal(h.objectUrls.size, 0)
})

for (const locale of ['en', 'zh']) test('actual ' + locale + ' controls explain scope, compatibility and fresh generation', async () => {
  const h = build({ manualPlan: true, locale }); try {
    await planned(h)
    assert.equal(control(h, 'open-cast-preset').props.disabled, true)
    assert.ok(textContent(h.host).includes(locale === 'en' ? 'First choose Load cast' : '请先点击“加载角色”'))
    await loaded(h); await open(h, file(preset()))
    const text = textContent(h.host)
    for (const value of locale === 'en' ? ['Save cast preset', 'Open cast preset', 'Apply cast preset', 'does not freeze graph facts', 'fresh generation', 'Compatible with the loaded cast', 'configuration generation still uses the model']
      : ['保存角色预设', '打开角色预设', '应用角色预设', '不会冻结图谱事实', '重新生成', '与已加载角色和当前限制兼容', '模拟配置生成仍然需要调用模型']) assert.ok(text.includes(value), value)
    assert.ok(!text.includes('localCastPreset.'))
  } finally { h.close() }
})

for (const late of ['success', 'failure']) test('same-binding catalog replacement retires late file ' + late + ' and exact old candidate callbacks', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'b'); await open(h, file(preset()))
    const oldApply = control(h, 'apply-cast-preset').props.onClick
    const oldSave = control(h, 'save-cast-preset').props.onClick
    const oldRead = deferred()
    await open(h, heldFile(oldRead))
    await loaded(h)
    await select(h, 'b')
    await open(h, file(preset({ selected_entity_ids: ['b'], max_rounds: 2 })))
    if (late === 'success') oldRead.resolve(bytes(preset()))
    else oldRead.reject(new Error('PRIVATE old failure'))
    await settle(); oldApply(); oldSave(); await settle()
    assert.equal(h.downloads.length, 0)
    assert.deepEqual(choices(h), { ids: ['b'], llm: false, rounds: 5 })
    assert.equal(h.state(setupChild).presetError, '')
    assert.deepEqual(Array.from(h.state(setupChild).presetCandidate.selected_entity_ids), ['b'])
    await click(h, 'apply-cast-preset')
    assert.deepEqual(choices(h), { ids: ['b'], llm: true, rounds: 2 })
  } finally { h.close() }
})

for (const late of ['success', 'failure']) test('scope A to B to A rejects a late file ' + late + ' after the replacement candidate is accepted', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h)
    const oldRead = deferred()
    await open(h, heldFile(oldRead))
    await h.navigate('/simulation/B'); await h.navigate('/simulation/A'); await currentPlan(h); await loaded(h)
    await open(h, file(preset({ selected_entity_ids: ['b'], max_rounds: 2 })))
    if (late === 'success') oldRead.resolve(bytes(preset()))
    else oldRead.reject(new Error('PRIVATE old failure'))
    await settle()
    assert.equal(h.state(setupChild).presetError, '')
    assert.deepEqual(Array.from(h.state(setupChild).presetCandidate.selected_entity_ids), ['b'])
    await click(h, 'apply-cast-preset')
    assert.deepEqual(choices(h), { ids: ['b'], llm: true, rounds: 2 })
  } finally { h.close() }
})

test('invalid draft maximum disables preparation and export until the user corrects it', async () => {
  const h = build({ manualPlan: true }); try {
    await planned(h); await loaded(h); await select(h, 'a')
    const prepare = control(h, 'prepare-cast').props.onClick
    for (const value of ['', '0', '-1', '1.5', '6', 'Infinity']) {
      await rounds(h, value)
      assert.equal(control(h, 'prepare-cast').props.disabled, true)
      assert.equal(control(h, 'save-cast-preset').props.disabled, true)
      prepare(); await settle()
      assert.equal(h.calls('prepareSimulation').length, 0)
    }
    await rounds(h, 1)
    assert.equal(control(h, 'prepare-cast').props.disabled, false)
    await click(h, 'save-cast-preset')
    assert.equal(JSON.parse(await h.downloads[0].blob.text()).max_rounds, 1)
  } finally { h.close() }
})
