import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSuites as mountSuitesView, trialSnapshot, trialRequest, ok, flush } from './helpers/prompt-suites-view-fixture.js'
import { parsePromptSuiteDefinition, parsePromptSuiteReport } from '../src/utils/promptSuites.js'

// Compile and render the production Vue page and real runner. Only the network
// transport and timer boundary are controlled by the existing view fixture.
const mountSuites = options => mountSuitesView({ ...options, cacheHandlers: true })
const labels = {
  en: { pause: 'Pause scheduling', resume: 'Resume scheduling', paused: 'Paused', pending: /Pause requested/, observation: /still.*observ/, saved: /not a saved.*checkpoint/, retry: /Resume scheduling/ },
  zh: { pause: '暂停安排后续用例', resume: '继续安排后续用例', paused: '已暂停', pending: /已请求暂停/, observation: /继续观察/, saved: /不是.*恢复检查点/, retry: /继续安排后续用例/ },
}
const counts = view => Object.fromEntries(Object.entries(view.requests.calls).map(([key, calls]) => [key, calls.length]))
const handler = (view, id) => { const control = view.byId(id); assert.ok(control, `missing control ${id}`); return control.props.onClick }
async function invoke(action) { action({ button: 0, preventDefault() {}, stopPropagation() {} }); await flush() }
async function readiness(view, snapshot = trialSnapshot()) { view.requests.calls.getPromptTrials.at(-1).resolve(ok(snapshot)); await flush() }
async function fill(view, { count = 2, version = 1 } = {}) {
  await view.input('suite-name', 'Captured pause suite')
  for (let index = 0; index < count; index++) {
    if (index) await view.click('suite-add-case')
    for (const [key, value] of Object.entries({ ...trialRequest(), label: `Case ${index + 1}`, user_prompt: `Captured prompt ${index + 1}` })) {
      await view.input(`suite-case-${index}-${key}`, value)
    }
  }
  if (version >= 2) {
    await view.change('suite-case-0-check_enabled', true)
    await view.change('suite-case-0-check_kind', version === 2 ? 'json_object' : 'json_fields')
    if (version === 3) {
      await view.input('suite-case-0-required-field-0-name', 'ok')
      await view.change('suite-case-0-required-field-0-type', 'boolean')
    }
  }
}
async function start(view) { await view.submit('suite-form'); await readiness(view) }
function ownedSnapshot(view, state = 'succeeded', index = view.requests.calls.startPromptTrial.length - 1) {
  const request = view.requests.calls.startPromptTrial[index].args[0], snapshot = trialSnapshot(state)
  snapshot.run.request_id = request.request_id
  snapshot.run.request = Object.fromEntries(Object.keys(trialRequest()).map(key => [key, request[key]]))
  if (snapshot.run.response) snapshot.run.response.content = '{"ok":true}'
  return snapshot
}
async function settlePost(view, state = 'succeeded') {
  view.requests.calls.startPromptTrial.at(-1).resolve(ok(ownedSnapshot(view, state))); await flush()
}
async function exportRun(view) {
  await view.click('suite-export-run')
  return parsePromptSuiteReport(await view.downloads.at(-1).blob.text())
}
function assertPaused(view, locale = 'en') {
  assert.equal(view.byId('suite-scheduling-state').props['data-phase'], 'paused')
  assert.equal(view.text(view.byId('suite-run-status')), labels[locale].paused)
  assert.equal(view.byId('suite-run-report').props['data-status'], 'running')
  assert.equal(view.byId('suite-pause').props.disabled, true)
  assert.equal(view.byId('suite-resume').props.disabled, false)
  assert.equal(view.byId('suite-stop').props.disabled, false)
  assert.equal(view.byId('suite-run').props.disabled, true)
  assert.equal(view.byId('suite-refresh').props.disabled, true)
  assert.equal(view.timers.pending.size, 0)
}
const definitionFile = definition => {
  const text = JSON.stringify(definition)
  return { size: new TextEncoder().encode(text).length, text: async () => text }
}
const runFile = report => {
  const bytes = new TextEncoder().encode(JSON.stringify(report))
  return { size: bytes.length, arrayBuffer: async () => bytes.buffer }
}

for (const locale of ['en', 'zh']) test(`pause controls distinguish an accepted case from parked scheduling in ${locale}`, async () => {
  const view = await mountSuites({ locale })
  try {
    await readiness(view); await fill(view)
    assert.ok(view.byId('suite-pause'), 'the actual page must render a Pause scheduling control')
    assert.equal(view.text(view.byId('suite-pause')), labels[locale].pause)
    assert.equal(view.text(view.byId('suite-resume')), labels[locale].resume)
    assert.equal(view.byId('suite-pause').props.disabled, true)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.match(view.text(), labels[locale].saved)
    await start(view)
    const activePost = view.requests.calls.startPromptTrial[0]
    await view.click('suite-pause')
    const pending = view.byId('suite-scheduling-state')
    assert.equal(pending.props['data-phase'], 'pause_pending')
    assert.match(view.text(pending), labels[locale].pending)
    assert.match(view.text(pending), labels[locale].observation)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.equal(view.byId('suite-stop').props.disabled, false)
    assert.equal(activePost.signal.aborted, false)
    await settlePost(view, 'running')
    await view.timers.advance(1500)
    const observation = view.requests.calls.getPromptTrial.at(-1)
    assert.equal(observation.args[0], activePost.args[0].request_id)
    observation.resolve(ok(ownedSnapshot(view))); await flush()
    assertPaused(view, locale)
    const before = counts(view)
    await view.timers.advance(100000)
    assert.deepEqual(counts(view), before)
    const report = await exportRun(view)
    assert.equal(report.status, 'running'); assert.equal(report.finished_at, null)
    assert.equal(report.cases[0].status, 'succeeded'); assert.equal(report.cases[1].status, 'not_attempted')
    assert.equal(report.cases[1].request_id, null)
    assert.equal(Object.hasOwn(report, 'pause_requested'), false)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const version of [1, 2, 3]) test(`paused v${version} export stays valid and resume uses captured cases after draft edits`, async () => {
  const view = await mountSuites()
  try {
    await readiness(view); await fill(view, { version }); await start(view); await settlePost(view)
    await view.click('suite-pause'); assertPaused(view)
    const saved = await exportRun(view)
    assert.equal(saved.schema_version, version)
    await view.input('suite-name', 'Draft changed while paused')
    await view.input('suite-case-1-user_prompt', 'New draft prompt must never be submitted')
    await view.input('suite-case-1-max_output_tokens', 1)
    await view.click('suite-export-definition')
    assert.equal(parsePromptSuiteDefinition(await view.downloads.at(-1).blob.text()).cases[1].max_output_tokens, 1)
    assert.deepEqual((await exportRun(view)).definition, saved.definition)
    const resume = handler(view, 'suite-resume'), before = counts(view)
    await invoke(resume); await invoke(resume)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.equal(view.byId('suite-pause').props.disabled, false)
    await view.timers.advance(1499)
    assert.deepEqual(counts(view), before)
    await view.timers.advance(1)
    assert.equal(view.requests.calls.getPromptTrials.length, before.getPromptTrials + 1)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    await readiness(view)
    const request = view.requests.calls.startPromptTrial[1].args[0]
    assert.equal(request.user_prompt, saved.definition.cases[1].user_prompt)
    assert.equal(request.max_output_tokens, 128)
    assert.notEqual(request.request_id, saved.cases[0].request_id)
    await settlePost(view)
    const completed = await exportRun(view)
    assert.equal(completed.run_id, saved.run_id); assert.deepEqual(completed.definition, saved.definition)
    assert.equal(completed.status, 'completed')
    assert.equal(!!view.byId('suite-scheduling-state'), false)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.equal(view.byId('suite-refresh').props.disabled, false)
    assert.deepEqual(view.warnings, [])
  } finally { view.unmount() }
})

for (const phase of ['between_case', 'resuming']) test(`Pause waits for ${phase} readiness without starting the next case`, async () => {
  const view = await mountSuites()
  try {
    await readiness(view); await fill(view); await start(view); await settlePost(view)
    if (phase === 'resuming') { await view.click('suite-pause'); await view.click('suite-resume') }
    await view.timers.advance(1500)
    const read = view.requests.calls.getPromptTrials.at(-1)
    await view.click('suite-pause')
    assert.equal(view.byId('suite-scheduling-state').props['data-phase'], 'pause_pending')
    assert.match(view.text(view.byId('suite-scheduling-state')), /Waiting for the current request to settle/)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.equal(view.byId('suite-result-0').props['data-status'], 'succeeded')
    assert.equal(view.byId('suite-result-1').props['data-status'], 'not_attempted')
    read.resolve(ok(trialSnapshot())); await flush()
    assertPaused(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    await view.click('suite-resume'); await view.timers.advance(1500)
    assert.notEqual(view.requests.calls.getPromptTrials.at(-1), read)
    await readiness(view); await settlePost(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 2)
    assert.equal(view.byId('suite-run-report').props['data-status'], 'completed')
  } finally { view.unmount() }
})

test('Pause during an uncertain POST keeps exact-request reconciliation visible before parking', async () => {
  const view = await mountSuites()
  try {
    await readiness(view); await fill(view); await start(view); await view.click('suite-pause')
    const post = view.requests.calls.startPromptTrial[0]
    post.reject(new Error('PRIVATE UNCERTAIN POST')); await flush()
    const read = view.requests.calls.getPromptTrial.at(-1)
    assert.equal(read.args[0], post.args[0].request_id)
    assert.equal(view.byId('suite-scheduling-state').props['data-phase'], 'pause_pending')
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.doesNotMatch(view.text(), /PRIVATE UNCERTAIN POST/)
    read.resolve(ok(ownedSnapshot(view))); await flush()
    assertPaused(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    assert.equal((await exportRun(view)).cases[0].status, 'succeeded')
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) for (const failure of ['read_failed', 'invalid_observation', 'backend_unavailable', 'backend_running', 'loaded_cap']) {
  test(`paused ${failure} keeps an explicit resume retry available in ${locale}`, async () => {
    const view = await mountSuites({ locale })
    try {
      await readiness(view); await fill(view); await start(view); await settlePost(view); await view.click('suite-pause')
      const saved = await exportRun(view)
      await view.click('suite-resume'); await view.timers.advance(1500)
      const read = view.requests.calls.getPromptTrials.at(-1), snapshot = trialSnapshot()
      if (failure === 'read_failed') read.reject(new Error('PRIVATE RESUME ERROR'))
      else if (failure === 'invalid_observation') read.resolve(ok({}))
      else {
        if (failure === 'backend_unavailable') { snapshot.available = false; snapshot.unavailable_code = 'backend_closing' }
        if (failure === 'backend_running') snapshot.run = trialSnapshot('running').run
        if (failure === 'loaded_cap') snapshot.limits.max_output_tokens = 64
        read.resolve(ok(snapshot))
      }
      await flush(); assertPaused(view, locale)
      assert.match(view.text(view.byId('suite-error')), labels[locale].retry)
      assert.doesNotMatch(view.text(), /PRIVATE RESUME ERROR|promptSuites\./)
      assert.equal(view.requests.calls.startPromptTrial.length, 1)
      assert.deepEqual(await exportRun(view), saved)
      await view.click('suite-resume'); await view.timers.advance(1500); await readiness(view)
      assert.equal(view.requests.calls.startPromptTrial.length, 2)
      assert.equal(!!view.byId('suite-error'), false)
      await settlePost(view)
      assert.equal(view.byId('suite-run-report').props['data-status'], 'completed')
      assert.deepEqual(view.warnings, [])
    } finally { view.unmount() }
  })
}

test('Stop while paused retires resume without admitting another case', async () => {
  const view = await mountSuites()
  try {
    await readiness(view); await fill(view); await start(view); await settlePost(view); await view.click('suite-pause')
    const resume = handler(view, 'suite-resume'), before = counts(view)
    await view.click('suite-stop'); await invoke(resume); await view.timers.advance(100000)
    assert.deepEqual(counts(view), before)
    const report = await exportRun(view)
    assert.equal(report.status, 'stopped'); assert.equal(report.stop_requested, true)
    assert.equal(report.cases[1].status, 'not_attempted')
    assert.equal(view.byId('suite-run').props.disabled, false)
    assert.equal(view.byId('suite-refresh').props.disabled, false)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    assert.equal(!!view.byId('suite-scheduling-state'), false)
  } finally { view.unmount() }
})

test('definition and report imports edit a paused draft without replacing or restarting its capture', async () => {
  const view = await mountSuites()
  try {
    await readiness(view); await fill(view); await start(view); await settlePost(view); await view.click('suite-pause')
    const saved = await exportRun(view), before = counts(view)
    const replacement = { ...saved.definition, name: 'Imported separate draft', cases: [saved.definition.cases[1]] }
    await view.file(definitionFile(replacement)); await view.click('suite-import-use')
    assert.equal(view.byId('suite-name').props.value, replacement.name)
    assert.deepEqual(await exportRun(view), saved); assertPaused(view)
    await view.runFile(runFile(saved))
    assert.match(view.text(view.byId('suite-import-provenance')), /Running/)
    await view.click('suite-import-use')
    assert.equal(view.byId('suite-name').props.value, saved.definition.name)
    assert.deepEqual(counts(view), before)
    assert.deepEqual(await exportRun(view), saved); assertPaused(view)
    await view.click('suite-resume'); await view.timers.advance(1500); await readiness(view); await settlePost(view)
    assert.equal(view.requests.calls.startPromptTrial.length, 2)
    assert.equal((await exportRun(view)).run_id, saved.run_id)
  } finally { view.unmount() }
})

for (const outcome of ['completed', 'stopped']) test(`retained handlers from a ${outcome} run cannot control a newer run`, async () => {
  const view = await mountSuites()
  try {
    await readiness(view); await fill(view); await start(view)
    const oldPause = handler(view, 'suite-pause')
    await settlePost(view); await view.click('suite-pause')
    const oldResume = handler(view, 'suite-resume'), oldRun = await exportRun(view)
    if (outcome === 'stopped') await view.click('suite-stop')
    else { await view.click('suite-resume'); await view.timers.advance(1500); await readiness(view); await settlePost(view) }
    await start(view)
    const newRun = await exportRun(view)
    assert.notEqual(newRun.run_id, oldRun.run_id)
    await invoke(oldPause)
    assert.equal(!!view.byId('suite-scheduling-state'), false)
    assert.equal(view.byId('suite-pause').props.disabled, false)
    await settlePost(view); await view.click('suite-pause')
    const before = counts(view)
    await invoke(oldResume); await view.timers.advance(100000)
    assert.deepEqual(counts(view), before); assertPaused(view)
    assert.equal((await exportRun(view)).run_id, newRun.run_id)
  } finally { view.unmount() }
})

for (const phase of ['paused', 'resume_delay', 'resume_readiness']) test(`navigation disposes ${phase} controls and ignores their late work`, async () => {
  const view = await mountSuites()
  let unmounted = false
  try {
    await readiness(view); await fill(view); await start(view)
    const oldPause = handler(view, 'suite-pause')
    await settlePost(view); await view.click('suite-pause')
    const oldResume = handler(view, 'suite-resume')
    if (phase !== 'paused') await view.click('suite-resume')
    if (phase === 'resume_readiness') await view.timers.advance(1500)
    const pending = phase === 'resume_readiness' ? view.requests.calls.getPromptTrials.at(-1) : null
    await view.navigate('/'); assert.equal(view.timers.pending.size, 0)
    if (pending) { assert.equal(pending.signal.aborted, true); pending.resolve(ok(trialSnapshot())) }
    await invoke(oldPause); await invoke(oldResume); await view.timers.advance(100000)
    assert.equal(view.requests.calls.startPromptTrial.length, 1)
    await view.navigate('/prompt-suites'); await readiness(view)
    assert.equal(!!view.byId('suite-run-report'), false)
    assert.equal(view.byId('suite-resume').props.disabled, true)
    await fill(view); await start(view); await settlePost(view); await view.click('suite-pause')
    await invoke(oldPause); await invoke(oldResume); assertPaused(view)
    const currentResume = handler(view, 'suite-resume'), before = counts(view)
    view.unmount(); unmounted = true
    await invoke(currentResume); await view.timers.advance(100000)
    assert.equal(view.timers.pending.size, 0); assert.deepEqual(counts(view), before)
  } finally { if (!unmounted) view.unmount() }
})
