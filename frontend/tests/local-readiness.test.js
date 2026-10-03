import assert from 'node:assert/strict'
import test from 'node:test'
import { mountReadiness, readinessSnapshot, readinessApi, runId, nextRunId } from './helpers/readiness-view-fixture.js'
import { ok, flush } from './helpers/runtime-view-fixture.js'

test('actual runtime parent mounts a passive readiness panel and only explicit Run starts checks', async () => {
  const view = await mountReadiness()
  try {
    assert.ok(view.byId('readiness-panel'), 'the actual parent must render the readiness panel')
    assert.equal(view.readiness.getLocalReadiness.length, 1)
    view.readiness.getLocalReadiness[0].resolve(ok(readinessSnapshot())); await flush()
    await view.click('refresh'); await view.change('auto-refresh', true); await view.timers.advance(10000)
    assert.equal(view.readiness.startLocalReadiness.length, 0)
    assert.equal(view.readiness.getLocalReadiness.length, 1)
    await view.click('readiness-start')
    assert.equal(view.readiness.startLocalReadiness.length, 1)
    assert.deepEqual(view.readiness.startLocalReadiness[0].args.slice(0, -1), [])
    view.readiness.startLocalReadiness[0].resolve(ok(readinessSnapshot('running'))); await flush()
    assert.match(view.text(view.byId('readiness-result')), /Running/)
  } finally { view.unmount() }
})

test('projection strips private fields and rejects unknown step codes', () => {
  const api = readinessApi()
  assert.equal(typeof api.acceptReadinessSnapshot, 'function', 'readiness observations need a strict projection')
  const data = readinessSnapshot('passed')
  data.secret = 'PRIVATE'; data.run.configuration.password = 'PRIVATE'; data.run.steps[0].response = 'PRIVATE'
  const accepted = api.acceptReadinessSnapshot(ok(data))
  assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE/)
  data.run.steps[0].code = 'SECRET_ERROR'
  assert.throws(() => api.acceptReadinessSnapshot(ok(data)))
})

async function idle(view) { view.readiness.getLocalReadiness.at(-1).resolve(ok(readinessSnapshot())); await flush() }
async function running(view) {
  await idle(view); await view.click('readiness-start')
  view.readiness.startLocalReadiness.at(-1).resolve(ok(readinessSnapshot('running'))); await flush()
}
for (const locale of ['en', 'zh']) test(`cloud mode remains passive and disabled in ${locale}`, async () => {
  const v = await mountReadiness({ locale })
  try {
    v.readiness.getLocalReadiness[0].resolve(ok(readinessSnapshot(null, { mode: 'cloud', available: false, unavailable_code: 'local_mode_required' }))); await flush()
    assert.ok(v.byId('readiness-start').props.disabled)
    assert.match(v.text(), locale === 'en' ? /only in local mode/ : /仅在本地模式下可用/)
    await v.timers.advance(1000000)
    assert.equal(v.readiness.getLocalReadiness.length, 1); assert.equal(v.readiness.startLocalReadiness.length, 0)
    assert.deepEqual(v.warnings, [])
  } finally { v.unmount() }
})

test('stop retires an older GET whose late pass cannot replace stopping or unlock another start', async () => {
  const v = await mountReadiness()
  try {
    await running(v); await v.timers.advance(1500)
    const old = v.readiness.getLocalReadiness[1]
    await v.click('readiness-stop'); assert.ok(old.signal.aborted)
    assert.equal(v.readiness.cancelLocalReadiness[0].args[0], runId)
    v.readiness.cancelLocalReadiness[0].resolve(ok(readinessSnapshot('stopping'))); await flush()
    old.resolve(ok(readinessSnapshot('passed'))); await flush()
    assert.match(v.text(v.byId('readiness-state')), /Stopping remaining checks/)
    for (const id of ['readiness-stop', 'readiness-start', 'readiness-download']) assert.ok(v.byId(id).props.disabled)
    assert.match(v.text(), /current bounded operation/)
    await v.timers.advance(1500)
    v.readiness.getLocalReadiness[2].resolve(ok(readinessSnapshot('cancelled'))); await flush()
    assert.equal(v.byId('readiness-stop'), undefined); assert.equal(v.byId('readiness-start').props.disabled, false)
    assert.equal(v.timers.pending.size, 0)
  } finally { v.unmount() }
})

for (const result of ['running', 'idle', 'failure']) test(`lost start reconciles ${result} without retrying POST`, async () => {
  const v = await mountReadiness()
  try {
    await idle(v); await v.click('readiness-start')
    v.readiness.startLocalReadiness[0].reject(new Error('SECRET')); await flush()
    assert.equal(v.readiness.getLocalReadiness.length, 2); assert.ok(v.byId('readiness-start').props.disabled)
    const reconcile = v.readiness.getLocalReadiness[1]
    if (result === 'failure') reconcile.reject(new Error('SECRET_RECONCILE'))
    else reconcile.resolve(ok(readinessSnapshot(result === 'running' ? 'running' : null)))
    await flush()
    assert.equal(v.readiness.startLocalReadiness.length, 1)
    assert.match(v.text(v.byId('readiness-notice')), result === 'running' ? /passive refresh found this active check/ : /No active check could be confirmed/)
    assert.doesNotMatch(v.text(), /SECRET/)
    if (result !== 'running') { await v.timers.advance(100000); assert.equal(v.readiness.getLocalReadiness.length, 2) }
  } finally { v.unmount() }
})

test('already-running safely adopts the shared run without repeating POST', async () => {
  const v = await mountReadiness()
  try {
    await idle(v); await v.click('readiness-start')
    const data = readinessSnapshot('running'); data.run.id = nextRunId; data.prompt = 'PRIVATE'
    v.readiness.startLocalReadiness[0].reject({ response: { status: 409, data: { success: false, error_code: 'already_running', error: 'RAW_SECRET', data } } }); await flush()
    assert.match(v.text(v.byId('readiness-notice')), /Another check is already active/)
    assert.equal(v.readiness.getLocalReadiness.length, 1); assert.equal(v.readiness.startLocalReadiness.length, 1)
    await v.click('readiness-stop'); assert.equal(v.readiness.cancelLocalReadiness[0].args[0], nextRunId)
    assert.doesNotMatch(v.text(), /PRIVATE|RAW_SECRET/)
  } finally { v.unmount() }
})

test('lost stop cannot adopt a different run during reconciliation', async () => {
  const v = await mountReadiness()
  try {
    await running(v); await v.click('readiness-stop')
    v.readiness.cancelLocalReadiness[0].reject(new Error('lost')); await flush()
    const data = readinessSnapshot('passed'); data.run.id = nextRunId
    v.readiness.getLocalReadiness[1].resolve(ok(data)); await flush()
    assert.match(v.text(v.byId('readiness-state')), /^Running$/)
    assert.match(v.text(v.byId('readiness-notice')), /stop request could not be confirmed/)
    assert.ok(v.byId('readiness-download').props.disabled); assert.equal(v.timers.pending.size, 0)
    assert.equal(v.readiness.cancelLocalReadiness.length, 1)
  } finally { v.unmount() }
})

test('active GET polling is single-flight with a delay after settlement and none after terminal', async () => {
  const v = await mountReadiness()
  try {
    await running(v); await v.timers.advance(1499); assert.equal(v.readiness.getLocalReadiness.length, 1)
    await v.timers.advance(1); assert.equal(v.readiness.getLocalReadiness.length, 2)
    await v.timers.advance(100000); assert.equal(v.readiness.getLocalReadiness.length, 2)
    v.readiness.getLocalReadiness[1].resolve(ok(readinessSnapshot('running'))); await flush()
    await v.timers.advance(1499); assert.equal(v.readiness.getLocalReadiness.length, 2)
    await v.timers.advance(1); assert.equal(v.readiness.getLocalReadiness.length, 3)
    v.readiness.getLocalReadiness[2].resolve(ok(readinessSnapshot('passed'))); await flush()
    await v.timers.advance(100000); assert.equal(v.readiness.getLocalReadiness.length, 3)
  } finally { v.unmount() }
})

test('automatic observation has a finite bound and does not claim backend work stopped', async () => {
  let count = 0
  const v = await mountReadiness({ api: { getLocalReadiness: async () => { count++; return ok(readinessSnapshot('running')) } } })
  try {
    await v.timers.advance(1000000)
    assert.ok(count > 1 && count <= 241); assert.equal(v.timers.pending.size, 0)
    assert.match(v.text(v.byId('readiness-notice')), /does not stop backend work/)
    assert.equal(v.readiness.cancelLocalReadiness.length, 0)
    assert.match(v.text(v.byId('readiness-state')), /^Running$/)
  } finally { v.unmount() }
})

for (const phase of ['get', 'start', 'stop', 'reconcile']) test(`navigation retires ${phase}; late reply cannot alter remount`, async () => {
  const v = await mountReadiness()
  try {
    let old = v.readiness.getLocalReadiness[0]
    if (phase !== 'get') {
      await idle(v); await v.click('readiness-start'); old = v.readiness.startLocalReadiness[0]
      if (phase === 'stop') { old.resolve(ok(readinessSnapshot('running'))); await flush(); await v.click('readiness-stop'); old = v.readiness.cancelLocalReadiness[0] }
      if (phase === 'reconcile') { old.reject(new Error('lost')); await flush(); old = v.readiness.getLocalReadiness[1] }
    }
    await v.navigate('/'); assert.ok(old.signal.aborted); await v.navigate('/runtime')
    old.resolve(ok(readinessSnapshot('passed'))); await flush()
    assert.equal(v.byId('readiness-result'), undefined); assert.ok(v.byId('readiness-start').props.disabled)
    v.readiness.getLocalReadiness.at(-1).resolve(ok(readinessSnapshot())); await flush()
    assert.equal(v.byId('readiness-start').props.disabled, false); assert.equal(v.timers.pending.size, 0)
  } finally { v.unmount() }
})

test('terminal export is detached, fixed-name and literal and performs no requests', async () => {
  const v = await mountReadiness()
  try {
    const data = readinessSnapshot('passed'); data.run.configuration.chat_model = '<img src=x onerror=alert(1)>'
    data.raw = 'SECRET'; data.run.steps[0].prompt = 'SECRET'; data.run.configuration.password = 'SECRET'
    v.readiness.getLocalReadiness[0].resolve(ok(data)); await flush(); data.run.configuration.chat_model = 'MUTATED'
    assert.match(v.text(), /<img src=x onerror=alert\(1\)>/)
    assert.equal(v.all(node => node.type === 'img' || node.props.innerHTML).length, 0)
    await v.click('readiness-download'); assert.equal(v.downloads[0].filename, 'local_readiness_check.json')
    const content = await v.downloads[0].blob.text(); assert.doesNotMatch(content, /SECRET|MUTATED/)
    assert.equal(JSON.parse(content).run.configuration.chat_model, '<img src=x onerror=alert(1)>')
    assert.deepEqual(v.revokedUrls, [v.downloads[0].url]); assert.equal(v.readiness.getLocalReadiness.length, 1)
    assert.equal(v.readiness.startLocalReadiness.length, 0)
  } finally { v.unmount() }
})

for (const [name, mutate] of [
  ['schema', d => { d.schema_version = 2 }], ['date', d => { d.observed_at = '2026-02-31T13:00:00Z' }],
  ['run id', d => { d.run.id = '/PRIVATE' }], ['run state', d => { d.run.state = 'PRIVATE' }],
  ['extra step', d => { d.run.steps.push(d.run.steps[0]) }], ['step order', d => { d.run.steps.reverse() }],
  ['step code', d => { d.run.steps[0].code = 'PRIVATE' }], ['step state', d => { d.run.steps[0].state = 'PRIVATE' }],
  ['elapsed', d => { d.run.elapsed_ms = Infinity }], ['duration', d => { d.run.steps[0].duration_ms = -1 }],
  ['dimensions', d => { d.run.configuration.embedding_dimensions = true }], ['budget', d => { d.run.budget.overall_ms = 300001 }],
  ['model control', d => { d.run.configuration.chat_model = 'PRIVATE\u202e' }], ['model cloud', d => { d.run.configuration.chat_model = 'llama:cloud' }],
  ['false pass', d => { d.run.steps[0].state = 'failed' }], ['unfinished terminal', d => { d.run.finished_at = null }],
  ['omitted code', d => { delete d.unavailable_code }], ['omitted run', d => { delete d.run }],
]) test(`invalid ${name} cannot render or enable export`, async () => {
  const v = await mountReadiness()
  try {
    const data = readinessSnapshot('passed'); mutate(data); v.readiness.getLocalReadiness[0].resolve(ok(data)); await flush()
    assert.equal(v.byId('readiness-result'), undefined)
    assert.ok(v.byId('readiness-start').props.disabled); assert.ok(v.byId('readiness-download').props.disabled)
    assert.match(v.text(v.byId('readiness-error')), /Could not read a valid check result/); assert.doesNotMatch(v.text(), /PRIVATE/)
  } finally { v.unmount() }
})
