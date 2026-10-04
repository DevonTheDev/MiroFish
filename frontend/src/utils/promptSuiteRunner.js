import { acceptPromptTrialInputs, acceptPromptTrialRequest, acceptPromptTrialSnapshot, getPromptTrial, getPromptTrials,
  samePromptTrialRequest, startPromptTrial } from '../api/promptTrials.js'
import { acceptPromptSuiteDefinition, evaluatePromptSuiteCheck } from './promptSuites.js'

const copy = value => JSON.parse(JSON.stringify(value))
const definitiveAdmission = { invalid_request: 400, local_mode_required: 403, local_browser_required: 403, already_running: 409, request_conflict: 409 }
const POLL_MS = 1500
const MAX_POLLS = 60

// The controller owns all continuations. The injected transport still passes through
// the real snapshot admission; test APIs cannot accidentally bypass identity checks.
export function createPromptSuiteRunner(options = {}) {
  const api = options.api ?? { getPromptTrials, getPromptTrial, startPromptTrial }
  const later = options.setTimeout ?? globalThis.setTimeout, cancel = options.clearTimeout ?? globalThis.clearTimeout
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID()), now = options.now ?? (() => new Date())
  const state = { phase: 'idle', busy: false, latest: null, latest_stale: true, error_code: null, report: null }
  let disposed = false, generation = 0, request = null, timer = null, active = null
  const usedIds = new Set()
  const stamp = () => new Date(now()).toISOString()
  const getState = () => copy(state)
  const emit = () => { if (!disposed) options.onChange?.(getState()) }
  const alive = expected => !disposed && generation === expected
  const owned = expected => alive(expected) && active !== null && active.generation === expected
  const current = token => alive(token.generation) && request === token && !token.controller.signal.aborted
  function clearTimer() { if (timer !== null) cancel(timer); timer = null }

  async function issue(method, args, phase, expected, maySend = () => true) {
    if (!alive(expected) || request !== null) return { retired: true }
    const token = { generation: expected, controller: new AbortController() }
    request = token; state.phase = phase; state.busy = true; emit()
    try {
      if (!current(token)) return { retired: true }
      if (!maySend()) return { cancelled: true }
      const envelope = await api[method](...args, token.controller.signal)
      return current(token) ? { envelope } : { retired: true }
    } catch (failure) {
      return current(token) ? { failure } : { retired: true }
    } finally { if (current(token)) request = null }
  }

  function idle(error = null) {
    state.busy = false; state.phase = 'idle'; state.error_code = error; emit()
  }
  function finish(status, code = null) {
    clearTimer()
    if (state.report) {
      state.report.status = status; state.report.finished_at = stamp(); state.report.halt_code = code
      state.report.stop_requested = active?.stop ?? state.report.stop_requested
    }
    if (active) active.automatic = false
    idle(code)
  }
  function unknown(code) {
    const row = state.report.cases[active.index]
    row.status = 'unknown'; row.check = 'not_evaluated'; row.error_code = code
    state.latest_stale = true
    finish('halted', code)
  }
  function latest(result) {
    if (Object.hasOwn(result, 'failure')) return 'read_failed'
    try {
      state.latest = acceptPromptTrialSnapshot(result.envelope); state.latest_stale = false
      return null
    } catch { state.latest_stale = true; return 'invalid_observation' }
  }
  function readiness(definition) {
    if (!state.latest.available) return 'backend_unavailable'
    if (state.latest.run?.state === 'running') return 'backend_running'
    if (definition.cases.some(item => item.max_output_tokens > state.latest.limits.max_output_tokens)) return 'loaded_cap'
    return null
  }
  function freshId() {
    const value = uuid()
    if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) || usedIds.has(value)) throw new Error('Invalid identity')
    usedIds.add(value)
    return value
  }
  function schedule(expected, observeOwned) {
    if (!owned(expected) || request !== null) return
    clearTimer()
    if (!observeOwned && active.stop) { finish('stopped'); return }
    if (observeOwned && active.polls >= MAX_POLLS) { unknown('observation_limit'); return }
    state.phase = 'waiting'; state.busy = true
    timer = later(() => {
      timer = null
      if (!owned(expected) || request !== null) return
      if (observeOwned) { active.polls++; observe(expected) }
      else if (active.stop) finish('stopped')
      else continueRun(expected)
    }, POLL_MS)
    emit()
  }
  function acceptOwned(envelope) {
    let snapshot
    try { snapshot = acceptPromptTrialSnapshot(envelope) } catch { return 'invalid_observation' }
    const owner = active.owner
    if (!snapshot.run || snapshot.run.request_id !== owner.request.request_id || !samePromptTrialRequest(snapshot.run.request, owner.request) ||
      (owner.fingerprint !== null && owner.fingerprint !== snapshot.run.fingerprint)) return 'identity_mismatch'
    owner.fingerprint = snapshot.run.fingerprint
    const row = state.report.cases[active.index], item = active.definition.cases[active.index]
    row.snapshot = snapshot; row.status = snapshot.run.state; row.error_code = null
    row.check = evaluatePromptSuiteCheck(item, row.status, snapshot.run.response?.content)
    state.latest = copy(snapshot); state.latest_stale = false; state.error_code = null
    return null
  }
  function afterObservation(expected) {
    if (!owned(expected)) return
    const row = state.report.cases[active.index]
    if (row.status === 'running') { schedule(expected, true); return }
    active.owner = null
    if (!active.automatic) { idle(); return }
    if (row.status !== 'succeeded') { finish('halted', 'runtime_failed'); return }
    if (active.stop) { finish('stopped'); return }
    if (active.index === active.definition.cases.length - 1) { finish('completed'); return }
    schedule(expected, false)
  }
  async function observe(expected, explicit = false) {
    if (!owned(expected) || !active.owner) return
    const result = await issue('getPromptTrial', [active.owner.request.request_id], explicit ? 'reconciling' : 'observing', expected)
    if (!owned(expected) || result.retired) return
    if (Object.hasOwn(result, 'failure')) { unknown('read_failed'); return }
    const code = acceptOwned(result.envelope)
    if (code) { unknown(code); return }
    afterObservation(expected)
  }
  async function submit(expected) {
    if (!owned(expected) || active.stop) { if (owned(expected)) finish('stopped'); return }
    const index = active.index, row = state.report.cases[index]
    active.owner = { request: active.requests[index], fingerprint: null }; active.polls = 0
    row.request_id = active.owner.request.request_id; row.status = 'submitting'
    state.latest_stale = true
    const result = await issue('startPromptTrial', [active.owner.request], 'submitting', expected, () => owned(expected) && !active.stop)
    if (!owned(expected) || result.retired) return
    if (result.cancelled) {
      row.request_id = null; row.status = 'not_attempted'; active.owner = null; finish('stopped'); return
    }
    if (Object.hasOwn(result, 'failure')) {
      const failure = result.failure, code = failure?.response?.data?.error_code
      if (failure?.response?.data?.success === false && typeof code === 'string' && Object.hasOwn(definitiveAdmission, code) && failure.response.status === definitiveAdmission[code]) {
        row.status = 'rejected'; row.error_code = 'admission_rejected'; active.owner = null; finish('halted', 'admission_rejected'); return
      }
      // Only an uncertain transport outcome gets one exact-ID reconciliation.
      // It never replays the POST or adopts whatever happens to be latest.
      await observe(expected)
      return
    }
    const code = acceptOwned(result.envelope)
    if (code) { unknown(code); return }
    afterObservation(expected)
  }
  async function continueRun(expected) {
    if (!owned(expected) || active.stop) return
    state.latest_stale = true
    const result = await issue('getPromptTrials', [], 'checking', expected)
    if (!owned(expected) || result.retired) return
    const code = latest(result)
    if (active.stop) { finish('stopped'); return }
    const blocked = code ?? readiness(active.definition)
    if (blocked) { finish('halted', blocked); return }
    active.index++
    await submit(expected)
  }
  async function refresh() {
    if (disposed || state.busy) return false
    const expected = ++generation
    // A passive refresh retires observation ownership, but leaves the captured report.
    // Reconciliation reconstructs ownership from that report if still unresolved.
    active = null; clearTimer(); state.latest_stale = true; state.error_code = null
    const result = await issue('getPromptTrials', [], 'refreshing', expected)
    if (!alive(expected) || result.retired) return false
    const code = latest(result); idle(code)
    return code === null
  }
  async function start(source) {
    if (disposed || state.busy) return false
    let definition
    try {
      definition = acceptPromptSuiteDefinition(source)
      definition.cases.forEach(item => {
        if (item.required_fields) { item.required_fields.forEach(Object.freeze); Object.freeze(item.required_fields) }
        Object.freeze(item)
      })
      Object.freeze(definition.cases); Object.freeze(definition)
    } catch { state.error_code = 'invalid_definition'; emit(); return false }
    const expected = ++generation
    active = { generation: expected, definition, stop: false, automatic: true, index: 0, owner: null, polls: 0, requests: null, captured: false }
    clearTimer(); state.latest_stale = true; state.error_code = null
    const result = await issue('getPromptTrials', [], 'checking', expected)
    if (!owned(expected) || result.retired) return false
    const code = latest(result)
    if (active.stop) { active = null; idle(); return false }
    const blocked = code ?? readiness(definition)
    if (blocked) { active = null; idle(blocked); return false }
    let runId
    try {
      runId = freshId()
      active.requests = definition.cases.map(item => Object.freeze(acceptPromptTrialRequest({ request_id: freshId(), ...acceptPromptTrialInputs(item) })))
    } catch { active = null; idle('invalid_identity'); return false }
    state.report = { schema_version: definition.schema_version, kind: 'mirofish_local_prompt_suite_run', run_id: runId, definition, started_at: stamp(), finished_at: null,
      status: 'running', stop_requested: false, halt_code: null,
      cases: definition.cases.map(item => ({ case_id: item.case_id, request_id: null, status: 'not_attempted', check: 'not_evaluated', snapshot: null, error_code: null })) }
    active.captured = true
    await submit(expected)
    return true
  }
  function stop() {
    if (disposed || !active || !state.busy || active.stop) return
    active.stop = true
    if (active.captured) state.report.stop_requested = true
    if (active.captured && !active.owner && request === null) finish('stopped')
    else emit()
  }
  async function reconcile() {
    if (disposed || state.busy || !state.report) return false
    const index = state.report.cases.findIndex(row => row.status === 'unknown')
    if (index < 0) return false
    const expected = ++generation, row = state.report.cases[index], definition = state.report.definition
    active = { generation: expected, definition, index, stop: state.report.stop_requested, automatic: false, captured: true, polls: 0,
      owner: { request: Object.freeze(acceptPromptTrialRequest({ request_id: row.request_id, ...acceptPromptTrialInputs(definition.cases[index]) })),
        fingerprint: row.snapshot?.run.fingerprint ?? null } }
    await observe(expected, true)
    return true
  }
  function dispose() {
    if (disposed) return
    disposed = true; generation++; clearTimer(); request?.controller.abort(); request = null; active = null
    state.phase = 'disposed'; state.busy = false
  }
  return { refresh, start, stop, reconcile, dispose, getState }
}
