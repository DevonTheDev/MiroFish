import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { createServer } from 'node:http'
import axios from 'axios'
import { parse, compileScript } from '@vue/compiler-sfc'
import { effectScope, nextTick, reactive, ref, watch } from 'vue'

const source = await readFile(new URL('../src/components/Step4Report.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const parsed = compileScript(descriptor, { id: 'report-polling-tests' })
const stateNames = new Set(['agentLogs', 'consoleLogs', 'agentLogLine', 'consoleLogLine',
  'reportOutline', 'currentSectionIndex', 'generatedSections', 'expandedContent',
  'expandedLogs', 'collapsedSections', 'isComplete', 'startTime', 'rightPanel', 'logContent'])
const stateCode = parsed.scriptSetupAst.filter(node => node.type === 'VariableDeclaration'
  && node.declarations.some(declaration => stateNames.has(declaration.id.name)))
  .map(node => descriptor.scriptSetup.content.slice(node.start, node.end)).join('\n')
// Execute the actual polling/lifecycle section, excluding unrelated display code.
const pollingStart = descriptor.scriptSetup.content.indexOf('// Polling\n')
assert.ok(pollingStart >= 0)
const code = stateCode + '\n' + descriptor.scriptSetup.content.slice(pollingStart)
  + '\n;({' + [...stateNames].join(',') + '})'

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
}

function harness(reportId = 'A') {
  const scope = effectScope()
  const props = reactive({ reportId })
  const intervals = new Map()
  const agentRequests = [], consoleRequests = [], mounted = [], unmounted = [], emitted = [], warnings = []
  let nextId = 1
  const request = requests => (id, fromLine, signal) => new Promise((resolve, reject) => {
    // Deliberately do not auto-reject on abort: stale replies must also be guarded.
    requests.push({ id, fromLine, signal, resolve, reject })
  })
  const state = scope.run(() => vm.runInNewContext(code, {
    ref, watch, nextTick, props, AbortController,
    getAgentLog: request(agentRequests), getConsoleLog: request(consoleRequests),
    setInterval: (callback, ms) => { const id = nextId++; intervals.set(id, { callback, ms }); return id },
    clearInterval: id => intervals.delete(id),
    onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    emit: (...args) => emitted.push(args), addLog: () => {},
    console: { warn: (...args) => warnings.push(args) },
  }))
  return {
    state, props, agentRequests, consoleRequests, emitted, warnings, intervals,
    mount: () => mounted.forEach(callback => callback()),
    tick: ms => [...intervals.values()].filter(timer => timer.ms === ms).forEach(timer => timer.callback()),
    close: () => { unmounted.forEach(callback => callback()); scope.stop() },
  }
}

const agentReply = (content = 'current', action = 'section_complete') => ({
  success: true, data: { from_line: 0, logs: [{ action, section_index: 1, details: { content } }] },
})
const consoleReply = text => ({ success: true, data: { from_line: 0, logs: [text] } })


test('slow polls never overlap within a log stream or duplicate a cursor', async () => {
  const h = harness()
  try {
    h.mount()
    h.tick(2000); h.tick(2000); h.tick(1500)
    assert.equal(h.agentRequests.length, 1)
    assert.equal(h.consoleRequests.length, 1)
    h.agentRequests[0].resolve(agentReply())
    h.consoleRequests[0].resolve(consoleReply('line'))
    await settle()
    h.tick(2000); h.tick(1500)
    assert.equal(h.agentRequests.length, 2)
    assert.equal(h.agentRequests[1].fromLine, 1)
    assert.equal(h.consoleRequests[1].fromLine, 1)
    assert.equal(h.state.agentLogs.value.length, 1)
  } finally { h.close() }
})

test('report changes reject stale completion and keep the new request busy', async () => {
  const h = harness()
  try {
    const oldAgent = h.agentRequests[0], oldConsole = h.consoleRequests[0]
    h.props.reportId = 'B'
    await settle()
    oldAgent.resolve(agentReply('old', 'report_complete'))
    oldConsole.resolve(consoleReply('old console'))
    await settle()
    assert.equal(h.state.isComplete.value, false)
    assert.equal(h.state.agentLogs.value.length, 0)
    assert.equal(h.state.consoleLogs.value.length, 0)
    assert.equal(h.emitted.length, 0)
    assert.equal(oldAgent.signal?.aborted, true)
    assert.equal(oldConsole.signal?.aborted, true)
    assert.equal(h.agentRequests[1].id, 'B')
    h.tick(2000)
    assert.equal(h.agentRequests.length, 2, 'old finally must not clear the new in-flight slot')
    h.agentRequests[1].resolve(agentReply('new report'))
    await settle()
    assert.equal(h.state.generatedSections.value[1], 'new report')
  } finally { h.close() }
})

test('switching A to B to A cannot admit the first A response', async () => {
  const h = harness()
  try {
    const old = h.agentRequests[0]
    h.props.reportId = 'B'; await settle()
    h.props.reportId = 'A'; await settle()
    old.resolve(agentReply('old A', 'report_complete')); await settle()
    assert.equal(h.state.isComplete.value, false)
    assert.equal(h.state.agentLogs.value.length, 0)
    assert.equal(h.agentRequests.length, 3)
  } finally { h.close() }
})

test('closing the component aborts reads and ignores their late replies', async () => {
  const h = harness()
  const agent = h.agentRequests[0], console = h.consoleRequests[0]
  h.close()
  agent.resolve(agentReply('closed', 'report_complete'))
  console.resolve(consoleReply('closed'))
  await settle()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.state.agentLogs.value.length, 0)
  assert.equal(h.state.consoleLogs.value.length, 0)
  assert.equal(h.emitted.length, 0)
  assert.equal(agent.signal?.aborted, true)
})

test('clearing a report ID resets state and stops pending work', async () => {
  const h = harness()
  try {
    h.agentRequests[0].resolve(agentReply()); await settle()
    assert.equal(h.state.agentLogs.value.length, 1)
    h.props.reportId = null; await settle()
    assert.equal(h.intervals.size, 0)
    assert.equal(h.state.agentLogs.value.length, 0)
    assert.equal(h.state.agentLogLine.value, 0)
    h.consoleRequests[0].resolve(consoleReply('old')); await settle()
    assert.equal(h.state.consoleLogs.value.length, 0)
  } finally { h.close() }
})

test('a failed current request releases its slot for retry', async () => {
  const h = harness()
  try {
    h.agentRequests[0].reject(new Error('synthetic error')); await settle()
    h.tick(2000)
    assert.equal(h.agentRequests.length, 2)
    assert.equal(h.agentRequests[1].fromLine, 0)
    assert.equal(h.warnings.length, 1)
  } finally { h.close() }
})

test('normal completion stops timers but lets the final console reply finish', async () => {
  const h = harness()
  try {
    h.agentRequests[0].resolve(agentReply('done', 'report_complete')); await settle()
    h.consoleRequests[0].resolve(consoleReply('final diagnostic')); await settle()
    assert.equal(h.state.isComplete.value, true)
    assert.equal(h.intervals.size, 0)
    assert.equal(h.state.consoleLogs.value[0], 'final diagnostic')
    assert.deepEqual(h.emitted, [['update-status', 'completed']])
  } finally { h.close() }
})

async function logApi(service) {
  const source = await readFile(new URL('../src/api/report.js', import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .+$/gm, '')
    .replace(/^export const /gm, 'const ') + '\n;({getAgentLog, getConsoleLog})', { service })
}

test('log API helpers forward AbortSignal without changing cursor parameters', async () => {
  const calls = []
  const api = await logApi({ get: (url, options) => { calls.push({ url, options }); return Promise.resolve({}) } })
  const controller = new AbortController()
  await api.getAgentLog('A', 12, controller.signal)
  await api.getConsoleLog('A', 8, controller.signal)
  assert.equal(calls[0].url, '/api/report/A/agent-log')
  assert.equal(calls[0].options.params.from_line, 12)
  assert.equal(calls[1].url, '/api/report/A/console-log')
  assert.equal(calls[1].options.params.from_line, 8)
  assert.ok(calls.every(call => call.options.signal === controller.signal))
  await api.getAgentLog('A')
  assert.equal(calls[2].options.params.from_line, 0)
  assert.equal(calls[2].options.signal, undefined)
})

test('a canceled old request neither warns nor releases the replacement slot', async () => {
  const h = harness()
  try {
    const old = h.agentRequests[0]
    h.props.reportId = 'B'; await settle()
    old.reject(new Error('synthetic cancellation')); await settle()
    h.tick(2000)
    assert.equal(h.agentRequests.length, 2)
    assert.equal(h.warnings.length, 0)
  } finally { h.close() }
})

test('mounting after an already-complete reply cannot restart polling', async () => {
  const h = harness()
  try {
    h.agentRequests[0].resolve(agentReply('done', 'report_complete')); await settle()
    h.mount()
    h.tick(2000); h.tick(1500)
    assert.equal(h.intervals.size, 0)
    assert.equal(h.agentRequests.length, 1)
    assert.equal(h.consoleRequests.length, 1)
  } finally { h.close() }
})

test('the real Axios transport cancels a pending loopback log read', { timeout: 5000 }, async t => {
  let received, closed
  const arrival = new Promise(resolve => { received = resolve })
  const disconnected = new Promise(resolve => { closed = resolve })
  const server = createServer((request, response) => {
    response.on('close', closed)
    received(request.url)
    // Keep the response pending until the client cancels it.
  })
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const api = await logApi(axios.create({
    baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000,
  }))
  const pending = api.getAgentLog('cancel-me', 0, controller.signal)
  assert.equal(await arrival, '/api/report/cancel-me/agent-log?from_line=0')
  controller.abort()
  await assert.rejects(pending, { code: 'ERR_CANCELED' })
  await disconnected
})
