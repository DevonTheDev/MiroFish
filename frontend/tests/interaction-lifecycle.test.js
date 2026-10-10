import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import { ref, computed, watch, reactive, effectScope, nextTick } from 'vue'

// Execute each complete, actual SFC setup script with real Vue reactivity.
// Only app/router hooks, DOM listeners and deferred HTTP boundaries are facades.
async function setupCode(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const parsed = compileScript(descriptor, { id: 'interaction-lifecycle' })
  const nodes = parsed.scriptSetupAst.filter(node => node.type !== 'ImportDeclaration')
  const names = nodes.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations.map(item => item.id.name).filter(Boolean))
  return nodes.map(node => descriptor.scriptSetup.content.slice(node.start, node.end)).join('\n')
    + '\n;({' + names.join(',') + '})'
}
const childCode = await setupCode('../src/components/Step5Interaction.vue')
const parentCode = await setupCode('../src/views/InteractionView.vue')
const apiNames = ['getReport', 'getAgentLog', 'getSimulationProfilesRealtime',
  'chatWithReport', 'interviewAgents', 'getSimulation', 'getProject', 'getGraphData']

async function settle() {
  await Promise.resolve(); await nextTick(); await Promise.resolve()
}
const ok = data => ({ success: true, data })
const logs = (text = 'current') => ok({ logs: [
  { action: 'planning_complete', details: { outline: { title: text } } },
  { action: 'section_complete', section_index: 1, details: { content: text } },
] })

function harness(parent = false, initial = {}) {
  const scope = effectScope()
  const props = reactive({ reportId: 'A', simulationId: 'SA', ...initial })
  const route = reactive({ params: { reportId: props.reportId } })
  const calls = Object.fromEntries(apiNames.map(name => [name, []]))
  const api = Object.fromEntries(apiNames.map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, resolve, reject })
  })]))
  const mounted = [], unmounted = [], emitted = [], listeners = new Set()
  const state = scope.run(() => vm.runInNewContext(parent ? parentCode : childCode, {
    ref, computed, watch, nextTick, AbortController, ...api,
    defineProps: () => props, defineEmits: () => (...args) => emitted.push(args),
    useRoute: () => route, useRouter: () => ({ push() {} }),
    useI18n: () => ({ t: (key, params = {}) => key + JSON.stringify(params) }),
    onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn),
    document: { querySelector: () => null, addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn) },
  }))
  let closed = false
  return { state, props, route, calls, emitted, listeners,
    mount: () => mounted.forEach(fn => fn()),
    close: () => { if (!closed) { closed = true; unmounted.forEach(fn => fn()); scope.stop() } },
  }
}

async function loadChild(h, text = 'A') {
  h.calls.getReport.at(-1).resolve(ok({ simulation_id: h.props.simulationId }))
  await settle()
  h.calls.getAgentLog.at(-1).resolve(logs(text))
  h.calls.getSimulationProfilesRealtime.at(-1).resolve(ok({ profiles: [{ username: text, profession: 'Synthetic' }] }))
  await settle()
}

async function reachGraph(h, suffix = 'A') {
  h.calls.getReport.at(-1).resolve(ok({ simulation_id: 'S' + suffix })); await settle()
  h.calls.getSimulation.at(-1).resolve(ok({ project_id: 'P' + suffix })); await settle()
  h.calls.getProject.at(-1).resolve(ok({ project_id: 'P' + suffix, graph_id: 'G' + suffix })); await settle()
  return h.calls.getGraphData.at(-1)
}


test('Step 5 mounting starts each initial read only once', () => {
  const h = harness()
  try {
    h.mount()
    assert.equal(h.calls.getReport.length, 1)
    assert.equal(h.calls.getSimulationProfilesRealtime.length, 1)
    assert.equal(h.listeners.size, 1)
  } finally { h.close() }
  assert.equal(h.listeners.size, 0)
})

test('changing the interaction context clears all previous report and conversation state', async () => {
  const h = harness()
  try {
    await loadChild(h)
    h.state.chatHistory.value = [{ role: 'user', content: 'old conversation' }]
    h.state.chatHistoryCache.value = { report_agent: [...h.state.chatHistory.value] }
    h.state.selectedAgents.value.add(0)
    h.state.surveyResults.value = [{ answer: 'old survey' }]
    h.state.surveyQuestion.value = 'old question'
    h.state.selectAgent(h.state.profiles.value[0], 0)
    h.props.reportId = 'B'; h.props.simulationId = 'SB'; await settle()
    assert.equal(h.state.reportOutline.value, null)
    assert.equal(Object.keys(h.state.generatedSections.value).length, 0)
    assert.equal(h.state.profiles.value.length, 0)
    assert.equal(h.state.chatHistory.value.length, 0)
    assert.equal(Object.keys(h.state.chatHistoryCache.value).length, 0)
    assert.equal(h.state.surveyResults.value.length, 0)
    assert.equal(h.state.selectedAgents.value.size, 0)
    assert.equal(h.state.surveyQuestion.value, '')
    assert.equal(h.state.selectedAgent.value, null)
    await loadChild(h, 'B')
    assert.equal(h.state.generatedSections.value[1], 'B')
    assert.equal(h.state.profiles.value[0].username, 'B')
  } finally { h.close() }
})

test('old report metadata cannot start a log read for the new context', async () => {
  const h = harness()
  try {
    const old = h.calls.getReport[0]
    h.props.reportId = 'B'; h.props.simulationId = 'SB'; await settle()
    old.resolve(ok({})); await settle()
    assert.equal(h.calls.getAgentLog.length, 0)
    assert.equal(old.args[1]?.aborted, true)
  } finally { h.close() }
})

test('late log and profile results are rejected after A to B to A', async () => {
  const h = harness()
  try {
    h.calls.getReport[0].resolve(ok({})); await settle()
    const oldLog = h.calls.getAgentLog[0], oldProfile = h.calls.getSimulationProfilesRealtime[0]
    h.props.reportId = 'B'; h.props.simulationId = 'SB'; await settle()
    h.props.reportId = 'A'; h.props.simulationId = 'SA'; await settle()
    oldLog.resolve(logs('stale A'))
    oldProfile.resolve(ok({ profiles: [{ username: 'stale A' }] })); await settle()
    assert.equal(h.state.reportOutline.value, null)
    assert.equal(h.state.profiles.value.length, 0)
    assert.equal(oldLog.args[2]?.aborted, true)
  } finally { h.close() }
})

test('clearing IDs and unmounting aborts reads and ignores late failures', async () => {
  const h = harness()
  h.mount()
  const oldReport = h.calls.getReport[0], oldProfile = h.calls.getSimulationProfilesRealtime[0]
  h.props.reportId = null; h.props.simulationId = null; await settle()
  const emittedCount = h.emitted.length
  h.close()
  oldReport.reject(new Error('old report failure'))
  oldProfile.reject(new Error('old profile failure')); await settle()
  assert.equal(h.emitted.length, emittedCount)
  assert.equal(oldReport.args[1]?.aborted, true)
  assert.equal(oldProfile.args[2]?.aborted, true)
  assert.equal(h.listeners.size, 0)
})

test('an old chat reply cannot enter a new report or unlock its pending request', async () => {
  const h = harness()
  try {
    h.state.chatInput.value = 'question A'; const oldSend = h.state.sendMessage()
    const old = h.calls.chatWithReport[0]
    h.props.reportId = 'B'; h.props.simulationId = 'SB'; await settle()
    h.state.chatInput.value = 'question B'; const newSend = h.state.sendMessage()
    assert.equal(h.calls.chatWithReport.length, 2)
    old.resolve(ok({ response: 'answer A' })); await oldSend; await settle()
    assert.equal(h.state.isSending.value, true)
    assert.deepEqual(Array.from(h.state.chatHistory.value, msg => msg.content), ['question B'])
    assert.equal(old.args[1]?.aborted, true)
    h.calls.chatWithReport[1].resolve(ok({ response: 'answer B' })); await newSend
    assert.deepEqual(Array.from(h.state.chatHistory.value, msg => msg.content), ['question B', 'answer B'])
  } finally { h.close() }
})

test('survey records the submitted question and refuses duplicate submissions', async () => {
  const h = harness()
  try {
    await loadChild(h)
    h.state.selectedAgents.value.add(0); h.state.surveyQuestion.value = 'Original question'
    const pending = h.state.submitSurvey()
    h.state.surveyQuestion.value = 'Edited while waiting'
    const duplicate = h.state.submitSurvey()
    assert.equal(h.calls.interviewAgents.length, 1)
    await duplicate
    h.calls.interviewAgents[0].resolve(ok({ results: { reddit_0: { response: 'Original answer' } } }))
    await pending
    assert.equal(h.state.surveyResults.value[0].question, 'Original question')
    assert.equal(h.state.surveyResults.value[0].answer, 'Original answer')
  } finally { h.close() }
})

test('changing chat target keeps an in-flight reply in its original conversation', async () => {
  const h = harness()
  try {
    await loadChild(h)
    h.state.chatInput.value = 'report question'; const pending = h.state.sendMessage()
    h.state.toggleAgentDropdown()
    h.state.selectAgent(h.state.profiles.value[0], 0)
    h.calls.chatWithReport[0].resolve(ok({ response: 'report answer' })); await pending
    assert.equal(h.state.chatHistory.value.length, 0)
    h.state.selectReportAgentChat()
    assert.deepEqual(Array.from(h.state.chatHistory.value, msg => msg.content), ['report question', 'report answer'])
  } finally { h.close() }
})

test('parent view rejects an old report before loading its simulation', async () => {
  const h = harness(true)
  try {
    h.mount(); const old = h.calls.getReport[0]
    h.route.params.reportId = 'B'; await settle()
    old.resolve(ok({ simulation_id: 'SA' })); await settle()
    assert.equal(h.calls.getSimulation.length, 0)
    assert.equal(h.state.simulationId.value, null)
    assert.equal(old.args[1]?.aborted, true)
    h.calls.getReport.at(-1).resolve(ok({ simulation_id: 'SB' })); await settle()
    assert.equal(h.calls.getSimulation[0].args[0], 'SB')
  } finally { h.close() }
})

test('parent navigation clears old project/graph and rejects stale graph completion', async () => {
  const h = harness(true)
  try {
    h.mount(); const oldGraph = await reachGraph(h)
    h.route.params.reportId = 'B'; await settle()
    assert.equal(h.state.projectData.value, null)
    assert.equal(h.state.simulationId.value, null)
    oldGraph.resolve(ok({ nodes: [{ name: 'old graph' }] })); await settle()
    assert.equal(h.state.graphData.value, null)
    const newGraph = await reachGraph(h, 'B')
    newGraph.resolve(ok({ nodes: [{ name: 'new graph' }] })); await settle()
    assert.equal(h.state.graphData.value.nodes[0].name, 'new graph')
  } finally { h.close() }
})

test('parent unmount aborts its chain and rejects late data', async () => {
  const h = harness(true)
  h.mount(); const old = h.calls.getReport[0]
  h.close()
  old.resolve(ok({ simulation_id: 'SA' })); await settle()
  assert.equal(h.state.simulationId.value, null)
  assert.equal(h.calls.getSimulation.length, 0)
  assert.equal(old.args[1]?.aborted, true)
})


test('Step 5 waits for a complete report/simulation pair before fetching data', async () => {
  const h = harness(false, { simulationId: null })
  try {
    h.mount()
    assert.equal(h.calls.getReport.length, 0)
    assert.equal(h.calls.getSimulationProfilesRealtime.length, 0)
    h.props.simulationId = 'SA'; await settle()
    assert.equal(h.calls.getReport.length, 1)
    assert.equal(h.calls.getSimulationProfilesRealtime.length, 1)
  } finally { h.close() }
})


test('an old survey reply cannot replace new results or unlock a newer survey', async () => {
  const h = harness()
  try {
    await loadChild(h)
    h.state.selectedAgents.value.add(0); h.state.surveyQuestion.value = 'A question'
    const oldPending = h.state.submitSurvey(), old = h.calls.interviewAgents[0]
    h.props.reportId = 'B'; h.props.simulationId = 'SB'; await settle()
    await loadChild(h, 'B')
    h.state.selectedAgents.value.add(0); h.state.surveyQuestion.value = 'B question'
    const currentPending = h.state.submitSurvey()
    old.resolve(ok({ results: { reddit_0: { response: 'A answer' } } })); await oldPending
    assert.equal(h.state.isSurveying.value, true)
    assert.equal(h.state.surveyResults.value.length, 0)
    assert.equal(old.args[1]?.aborted, true)
    h.calls.interviewAgents[1].resolve(ok({ results: { reddit_0: { response: 'B answer' } } }))
    await currentPending
    assert.equal(h.state.surveyResults.value[0].agent_name, 'B')
    assert.equal(h.state.surveyResults.value[0].question, 'B question')
    assert.equal(h.state.surveyResults.value[0].answer, 'B answer')
  } finally { h.close() }
})

for (const fail of [false, true]) {
  test(`closing Step 5 ignores pending chat/survey ${fail ? 'errors' : 'successes'}`, async () => {
    const h = harness()
    await loadChild(h)
    h.state.chatInput.value = 'question'; const chat = h.state.sendMessage()
    h.state.selectedAgents.value.add(0); h.state.surveyQuestion.value = 'survey'
    const survey = h.state.submitSurvey()
    const chatCall = h.calls.chatWithReport[0], surveyCall = h.calls.interviewAgents[0]
    h.close(); const count = h.emitted.length
    if (fail) {
      chatCall.reject(new Error('late failure')); surveyCall.reject(new Error('late failure'))
    } else {
      chatCall.resolve(ok({ response: 'late answer' }))
      surveyCall.resolve(ok({ results: { reddit_0: { response: 'late survey' } } }))
    }
    await Promise.all([chat, survey])
    assert.equal(h.state.chatHistory.value.length, 1)
    assert.equal(h.state.surveyResults.value.length, 0)
    assert.equal(h.emitted.length, count)
    assert.equal(chatCall.args[1]?.aborted, true)
    assert.equal(surveyCall.args[1]?.aborted, true)
  })
}

test('an agent reply uses captured identity when another agent is selected', async () => {
  const h = harness()
  try {
    await loadChild(h)
    h.state.selectAgent({ username: 'Alice' }, 0)
    h.state.chatInput.value = 'Alice question'; const pending = h.state.sendMessage()
    h.state.selectAgent({ username: 'Bob' }, 1)
    h.calls.interviewAgents[0].resolve(ok({ result: { results: {
      reddit_0: { response: 'Alice answer' }, reddit_1: { response: 'Bob answer' },
    } } })); await pending
    assert.equal(h.state.chatHistory.value.length, 0)
    h.state.selectAgent({ username: 'Alice' }, 0)
    assert.deepEqual(Array.from(h.state.chatHistory.value, msg => msg.content), ['Alice question', 'Alice answer'])
    assert.ok(h.emitted.some(([, msg]) => msg === 'log.agentReplied{"name":"Alice"}'))
  } finally { h.close() }
})

test('survey tab navigation preserves the original chat cache', async () => {
  const h = harness()
  try {
    await loadChild(h)
    h.state.selectAgent({ username: 'Alice' }, 0)
    h.state.chatHistory.value = [{ role: 'user', content: 'Alice history' }]
    h.state.selectSurveyTab()
    h.state.selectReportAgentChat()
    assert.equal(h.state.chatHistory.value.length, 0)
    h.state.selectAgent({ username: 'Alice' }, 0)
    assert.equal(h.state.chatHistory.value[0].content, 'Alice history')
  } finally { h.close() }
})

for (const stage of ['simulation', 'project']) {
  test(`parent rejects stale ${stage} data before continuing its chain`, async () => {
    const h = harness(true)
    try {
      h.mount()
      h.calls.getReport[0].resolve(ok({ simulation_id: 'SA' })); await settle()
      if (stage === 'project') {
        h.calls.getSimulation[0].resolve(ok({ project_id: 'PA' })); await settle()
      }
      const old = stage === 'simulation' ? h.calls.getSimulation[0] : h.calls.getProject[0]
      h.route.params.reportId = 'B'; await settle()
      old.resolve(ok({ project_id: 'PA', graph_id: 'GA' })); await settle()
      assert.equal(h.state.projectData.value, null)
      assert.equal(h.calls.getGraphData.length, 0)
      if (stage === 'simulation') assert.equal(h.calls.getProject.length, 0)
      assert.equal(old.args[1]?.aborted, true)
    } finally { h.close() }
  })
}

test('repeated graph refresh keeps the latest response and its loading ownership', async () => {
  const h = harness(true)
  try {
    h.mount(); const first = await reachGraph(h)
    h.state.refreshGraph(); const latest = h.calls.getGraphData.at(-1)
    first.resolve(ok({ nodes: [{ name: 'first' }] })); await settle()
    assert.equal(first.args[1]?.aborted, true)
    assert.equal(h.state.graphLoading.value, true)
    assert.equal(h.state.graphData.value, null)
    latest.resolve(ok({ nodes: [{ name: 'latest' }] })); await settle()
    assert.equal(h.state.graphLoading.value, false)
    assert.equal(h.state.graphData.value.nodes[0].name, 'latest')
  } finally { h.close() }
})

test('parent A to B to A and empty routes reject stale metadata without extra mount reads', async () => {
  const h = harness(true)
  try {
    h.mount(); assert.equal(h.calls.getReport.length, 1)
    const first = h.calls.getReport[0]
    h.route.params.reportId = 'B'; await settle()
    h.route.params.reportId = 'A'; await settle()
    first.resolve(ok({ simulation_id: 'old SA' })); await settle()
    assert.equal(h.state.simulationId.value, null)
    h.route.params.reportId = null; await settle()
    const count = h.state.systemLogs.value.length
    h.calls.getReport.at(-1).reject(new Error('old error')); await settle()
    assert.equal(h.calls.getReport.length, 3)
    assert.equal(h.state.systemLogs.value.length, count)
    assert.equal(h.state.graphLoading.value, false)
  } finally { h.close() }
})

async function apiModule(path, names, service) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .+$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ') + '\n;({' + names.join(',') + '})', { service })
}

test('interaction API helpers preserve bodies, platform defaults and optional cancellation signals', async () => {
  const calls = []
  const service = options => { calls.push(options); return Promise.resolve({}) }
  service.get = (url, options = {}) => service({ url, method: 'get', ...options })
  service.post = (url, data, options = {}) => service({ url, method: 'post', data, ...options })
  const report = await apiModule('../src/api/report.js', ['getReport', 'chatWithReport'], service)
  const simulation = await apiModule('../src/api/simulation.js', ['getSimulation', 'getSimulationProfilesRealtime', 'interviewAgents'], service)
  const graph = await apiModule('../src/api/graph.js', ['getProject', 'getGraphData'], service)
  const signal = new AbortController().signal
  const payload = { simulation_id: 'S', message: 'sample' }
  await report.getReport('R', signal); await report.chatWithReport(payload, signal)
  await simulation.getSimulation('S', signal)
  await simulation.getSimulationProfilesRealtime('S', 'reddit', signal)
  await simulation.interviewAgents(payload, signal)
  await graph.getProject('P', signal); await graph.getGraphData('G', signal)
  assert.ok(calls.every(call => call.signal === signal))
  assert.deepEqual(calls.map(call => call.url), ['/api/report/R', '/api/report/chat', '/api/simulation/S',
    '/api/simulation/S/profiles/realtime', '/api/simulation/interview/batch', '/api/graph/project/P', '/api/graph/data/G'])
  assert.equal(calls[1].data, payload); assert.equal(calls[4].data, payload)
  assert.equal(calls[3].params.platform, 'reddit')
  await simulation.getSimulationProfilesRealtime('S')
  assert.equal(Object.keys(calls.at(-1).params).length, 0)
  assert.equal(calls.at(-1).signal, undefined)
  await report.getReport('R'); await graph.getGraphData('G')
  assert.equal(calls.at(-1).signal, undefined)
})


test('parent IDs drive the child without mixed-context requests during route replacement', async () => {
  const parent = harness(true)
  const child = harness(false, { reportId: parent.state.currentReportId.value, simulationId: null })
  const stop = watch(() => [parent.state.currentReportId.value, parent.state.simulationId.value], ([reportId, simulationId]) => {
    child.props.reportId = reportId; child.props.simulationId = simulationId
  }, { immediate: true })
  try {
    parent.mount(); child.mount()
    assert.equal(child.calls.getReport.length, 0)
    const oldGraph = await reachGraph(parent)
    assert.equal(child.calls.getReport.length, 1)
    await loadChild(child)
    child.state.chatInput.value = 'old question'; const pending = child.state.sendMessage()
    const oldChat = child.calls.chatWithReport[0]
    parent.route.params.reportId = 'B'; await settle()
    assert.equal(child.props.reportId, 'B')
    assert.equal(child.props.simulationId, null)
    assert.equal(child.state.profiles.value.length, 0)
    assert.equal(child.calls.getReport.length, 1, 'must wait for new simulation metadata')
    oldGraph.resolve(ok({ nodes: [{ name: 'stale' }] }))
    oldChat.resolve(ok({ response: 'stale' })); await pending
    await reachGraph(parent, 'B')
    assert.equal(child.calls.getReport.length, 2)
    assert.equal(child.calls.getSimulationProfilesRealtime.at(-1).args[0], 'SB')
    await loadChild(child, 'B')
    assert.equal(child.state.generatedSections.value[1], 'B')
    assert.equal(child.state.chatHistory.value.length, 0)
    assert.equal(parent.state.graphData.value, null)
  } finally { stop(); parent.close(); child.close() }
})

for (const returnToA of [false, true]) {
  test(`same-simulation report chat binds captured ID and rejects stale replies${returnToA ? ' after A to B to A' : ''}`, async () => {
    const h = harness()
    try {
      h.state.chatInput.value = 'question A'
      const oldSend = h.state.sendMessage(), old = h.calls.chatWithReport[0]
      assert.equal(old.args[0].report_id, 'A')
      assert.equal(old.args[0].simulation_id, 'SA')
      h.props.reportId = 'B'; await settle()
      if (returnToA) { h.props.reportId = 'A'; await settle() }
      const visible = returnToA ? 'A' : 'B'
      h.state.chatInput.value = 'current question'
      const currentSend = h.state.sendMessage(), current = h.calls.chatWithReport[1]
      assert.equal(current.args[0].report_id, visible)
      assert.equal(current.args[0].simulation_id, 'SA')
      assert.equal(old.args[0].report_id, 'A')
      assert.equal(old.args[1]?.aborted, true)
      assert.equal(current.args[0].chat_history.length, 0)
      old.resolve(ok({ response: 'stale answer A' })); await oldSend; await settle()
      assert.equal(h.state.isSending.value, true)
      assert.deepEqual(Array.from(h.state.chatHistory.value, msg => msg.content), ['current question'])
      current.resolve(ok({ response: 'current answer' })); await currentSend
      assert.deepEqual(Array.from(h.state.chatHistory.value, msg => msg.content), ['current question', 'current answer'])
    } finally { h.close() }
  })
}
