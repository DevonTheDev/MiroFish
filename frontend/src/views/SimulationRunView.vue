<template>
  <div class="main-view">
    <!-- Header -->
    <header class="app-header">
      <div class="header-left">
        <div class="brand" @click="router.push('/')">MIROFISH</div>
      </div>
      
      <div class="header-center">
        <div class="view-switcher">
          <button 
            v-for="mode in ['graph', 'split', 'workbench']" 
            :key="mode"
            class="switch-btn"
            :class="{ active: viewMode === mode }"
            @click="viewMode = mode"
          >
            {{ { graph: $t('main.layoutGraph'), split: $t('main.layoutSplit'), workbench: $t('main.layoutWorkbench') }[mode] }}
          </button>
        </div>
      </div>

      <div class="header-right">
        <LanguageSwitcher />
        <div class="step-divider"></div>
        <div class="workflow-step">
          <span class="step-num">Step 3/5</span>
          <span class="step-name">{{ $tm('main.stepNames')[2] }}</span>
        </div>
        <div class="step-divider"></div>
        <span class="status-indicator" :class="statusClass">
          <span class="dot"></span>
          {{ statusText }}
        </span>
      </div>
    </header>

    <!-- Main Content Area -->
    <main class="content-area">
      <!-- Left Panel: Graph -->
      <div class="panel-wrapper left" :style="leftPanelStyle">
        <GraphPanel 
          :graphData="graphData"
          :loading="graphLoading"
          :currentPhase="3"
          :isSimulating="isSimulating"
          @refresh="refreshGraph"
          @toggle-maximize="toggleMaximize('graph')"
        />
      </div>

      <!-- Right Panel: Step3 开始模拟 -->
      <div class="panel-wrapper right" :style="rightPanelStyle">
        <Step3Simulation
          :simulationId="currentSimulationId"
          :maxRounds="maxRounds"
          :minutesPerRound="minutesPerRound"
          :projectData="projectData"
          :graphData="graphData"
          :systemLogs="systemLogs"
          :reportHandoff="reportHandoff"
          @report-run-started="selectReportRun"
          @go-back="handleGoBack"
          @next-step="handleNextStep"
          @add-log="addRunLog"
          @update-status="updateStatus"
        />
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import GraphPanel from '../components/GraphPanel.vue'
import Step3Simulation from '../components/Step3Simulation.vue'
import { getProject, getGraphData } from '../api/graph'
import { getSimulation, getSimulationConfig, stopSimulation, closeSimulationEnv, getEnvStatus } from '../api/simulation'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// Props
const props = defineProps({
  simulationId: String
})

// Layout State
const viewMode = ref('split')

// Data State
const currentSimulationId = computed(() => props.simulationId ?? route.params.simulationId)
// 直接在初始化时从 query 参数获取 maxRounds，确保子组件能立即获取到值
const maxRounds = ref(route.query.maxRounds ? parseInt(route.query.maxRounds) : null)
const minutesPerRound = ref(30) // 默认每轮30分钟
const projectData = ref(null)
const graphData = ref(null)
const graphLoading = ref(false)
const systemLogs = ref([])
const currentStatus = ref('processing') // processing | completed | error

// --- Computed Layout Styles ---
const leftPanelStyle = computed(() => {
  if (viewMode.value === 'graph') return { width: '100%', opacity: 1, transform: 'translateX(0)' }
  if (viewMode.value === 'workbench') return { width: '0%', opacity: 0, transform: 'translateX(-20px)' }
  return { width: '50%', opacity: 1, transform: 'translateX(0)' }
})

const rightPanelStyle = computed(() => {
  if (viewMode.value === 'workbench') return { width: '100%', opacity: 1, transform: 'translateX(0)' }
  if (viewMode.value === 'graph') return { width: '0%', opacity: 0, transform: 'translateX(20px)' }
  return { width: '50%', opacity: 1, transform: 'translateX(0)' }
})

// --- Status Computed ---
const statusClass = computed(() => {
  return currentStatus.value
})

const statusText = computed(() => {
  if (currentStatus.value === 'error') return 'Error'
  if (currentStatus.value === 'completed') return 'Completed'
  return 'Running'
})

const isSimulating = computed(() => currentStatus.value === 'processing')

// An accepted report belongs to this mounted run selection, independently of
// metadata observation. Aborted navigation retires viewContext, not this receipt.
const reportHandoff = shallowRef({})
let reportOwner = null
let reportDeparture = null
const reportNavigationOrder = new WeakMap()
let latestReportNavigation = 0
const validReportId = id => typeof id === 'string' && id.trim().length > 0
const ownsReport = owner => !!owner && owner === reportOwner && owner.active
  && route.name === 'SimulationRun' && owner.id === currentSimulationId.value
  && owner.id === route.params.simulationId
const atAcceptedReport = receipt => router.currentRoute.value.name === 'Report'
  && router.currentRoute.value.params.reportId === receipt.reportId
const canOpenReport = (owner, actions) => ownsReport(owner)
  && owner.actions === actions && actions.active && !owner.attempt

const publishReportHandoff = owner => {
  if (owner !== reportOwner) return
  reportHandoff.value = {
    owner, actions: owner.actions, receipt: owner.receipt,
    opening: !!owner.attempt, failed: owner.failed,
    disabled: !owner.active || !owner.actions.active || !!owner.attempt,
    accept: owner.accept, open: owner.actions.open,
  }
}

const openAcceptedReport = async (owner, actions) => {
  if (!canOpenReport(owner, actions) || !owner.receipt || atAcceptedReport(owner.receipt)) return
  const receipt = owner.receipt
  const attempt = { root: null }
  owner.attempt = attempt
  owner.failed = false
  publishReportHandoff(owner)
  // This inert, exact-root guard outlives unmount only while this push is
  // pending. Vue Router can follow an old guard redirect before cancellation.
  const removeRetiredRedirect = router.beforeEach(to => {
    if (attempt.root && to.redirectedFrom === attempt.root
      && (!ownsReport(owner) || reportNavigationOrder.get(attempt.root) < latestReportNavigation)) return false
  })
  try {
    // A fulfilled router promise can still mean abort, cancellation or redirect.
    // Only the committed Report route establishes that this receipt was opened.
    await router.push({ name: 'Report', params: { reportId: receipt.reportId } })
  } catch {
    // Acceptance succeeded. Keep navigation errors separate from generation.
  } finally {
    removeRetiredRedirect()
    if (ownsReport(owner) && owner.actions === actions && actions.active && owner.attempt === attempt) {
      owner.attempt = null
      owner.failed = !atAcceptedReport(receipt)
      publishReportHandoff(owner)
    }
  }
}

const renewReportActions = owner => {
  if (owner.actions) owner.actions.active = false
  const actions = { active: true }
  actions.open = () => openAcceptedReport(owner, actions)
  owner.actions = actions
}

const retireReportRun = () => {
  if (reportOwner) {
    reportOwner.active = false
    reportOwner.actions.active = false
  }
  reportOwner = null
  reportDeparture = null
  reportHandoff.value = {}
}

const selectReportRun = ({ simulationId, run }) => {
  if (!run || simulationId !== currentSimulationId.value || simulationId !== route.params.simulationId
    || route.name !== 'SimulationRun') return
  retireReportRun()
  const owner = { id: simulationId, run, active: true, receipt: null, attempt: null, failed: false }
  reportOwner = owner
  renewReportActions(owner)
  owner.accept = accepted => {
    if (!ownsReport(owner) || owner.receipt || accepted.owner !== owner || accepted.run !== owner.run
      || accepted.simulationId !== owner.id || !validReportId(accepted.reportId)) return
    owner.receipt = Object.freeze({ simulationId: owner.id, reportId: accepted.reportId })
    publishReportHandoff(owner)
    // A response during a pending departure retains its receipt without taking
    // over navigation. Only a later explicit action opens it after recovery.
    if (owner.actions === accepted.actions && owner.actions.active) void openAcceptedReport(owner, owner.actions)
  }
  publishReportHandoff(owner)
}

const suspendReport = to => {
  const owner = reportOwner
  if (!owner) return
  const root = to.redirectedFrom || to
  // A held older guard can redirect after newer navigation began. Vue Router
  // re-enters guards with that old root; it must not become the newest owner.
  if (reportNavigationOrder.has(root) && reportNavigationOrder.get(root) < latestReportNavigation) return false
  if (!reportNavigationOrder.has(root)) reportNavigationOrder.set(root, ++latestReportNavigation)
  if (owner.attempt && !owner.attempt.root && to.name === 'Report' && to.params.reportId === owner.receipt.reportId) {
    owner.attempt.root = root
  }
  reportDeparture = { owner, to: root }
  owner.actions.active = false
  publishReportHandoff(owner)
}

const recoverReport = (to, committed = false) => {
  const departure = reportDeparture
  if (!departure || departure.owner !== reportOwner
    || (departure.to !== (to.redirectedFrom || to) && !(committed && router.currentRoute.value === to))) return
  const owner = reportOwner
  if (ownsReport(owner)) {
    if (owner.attempt) owner.failed = !atAcceptedReport(owner.receipt)
    owner.attempt = null
    reportDeparture = null
    renewReportActions(owner)
    publishReportHandoff(owner)
  } else if (committed) retireReportRun()
}

// beforeEach observes query-only navigation before component update guards and
// before later beforeEach/beforeResolve guards can hold the newest departure.
const removeReportDeparture = router.beforeEach(to => suspendReport(to))
const removeReportRecovery = router.afterEach((to, _from, failure) => recoverReport(to, !failure))
const removeReportErrorRecovery = router.onError((_error, to) => recoverReport(to))

// A new identity owns every selection, including A → B → A in a reused view.
let viewContext = null
const ownsView = context => !!context && context.active && context === viewContext
  && context.id === currentSimulationId.value && context.id === route.params.simulationId
const canRead = context => ownsView(context) && !context.goingBack

const retireView = (context = viewContext) => {
  if (!context) return
  context.active = false
  context.controller.abort()
  context.graphRequest?.controller.abort()
  context.backController?.abort()
  stopGraphRefresh(context)
}

// --- Helpers ---
const appendLog = msg => {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + new Date().getMilliseconds().toString().padStart(3, '0')
  systemLogs.value.push({ time, msg })
  if (systemLogs.value.length > 200) {
    systemLogs.value.shift()
  }
}

const addLog = (msg, context = viewContext) => {
  if (ownsView(context)) appendLog(msg)
}

// Run outcomes survive aborted departure; metadata observation stays retired.
const addRunLog = msg => {
  if (ownsReport(reportOwner)) appendLog(msg)
}

const updateStatus = (status) => {
  if (!ownsReport(reportOwner)) return
  currentStatus.value = status
}

// --- Layout Methods ---
const toggleMaximize = (target) => {
  if (viewMode.value === target) {
    viewMode.value = 'split'
  } else {
    viewMode.value = target
  }
}

const handleGoBack = async () => {
  const context = viewContext
  if (!canRead(context)) return
  context.goingBack = true
  context.backController = new AbortController()
  const signal = context.backController.signal
  addLog(t('log.preparingGoBack'), context)
  stopGraphRefresh(context)
  context.controller.abort()
  context.graphRequest?.controller.abort()
  graphLoading.value = false

  try {
    const envStatusRes = await getEnvStatus({ simulation_id: context.id }, signal)
    if (!ownsView(context)) return
    if (envStatusRes.success && envStatusRes.data?.env_alive) {
      addLog(t('log.closingSimEnv'), context)
      try {
        await closeSimulationEnv({ simulation_id: context.id, timeout: 10 }, signal)
        if (!ownsView(context)) return
        addLog(t('log.simEnvClosed'), context)
      } catch (closeErr) {
        if (!ownsView(context)) return
        addLog(t('log.closeSimEnvFailed'), context)
        try {
          await stopSimulation({ simulation_id: context.id }, signal)
          if (!ownsView(context)) return
          addLog(t('log.simForceStopSuccess'), context)
        } catch (stopErr) {
          if (!ownsView(context)) return
          addLog(t('log.forceStopFailed', { error: stopErr.message }), context)
        }
      }
    } else if (isSimulating.value) {
      addLog(t('log.stoppingSimProcess'), context)
      try {
        await stopSimulation({ simulation_id: context.id }, signal)
        if (!ownsView(context)) return
        addLog(t('log.simStopped'), context)
      } catch (err) {
        if (!ownsView(context)) return
        addLog(t('log.stopSimFailed', { error: err.message }), context)
      }
    }
  } catch (err) {
    if (!ownsView(context)) return
    addLog(t('log.checkStatusFailed', { error: err.message }), context)
  }
  if (!ownsView(context)) return
  retireView(context)
  router.push({ name: 'Simulation', params: { simulationId: context.id } })
}

const handleNextStep = () => {
  // Report opening is owned by the accepted handoff above.
  addLog(t('log.enterStep4'))
}

// --- Data Logic ---
const loadSimulationData = async (context) => {
  if (!canRead(context)) return
  try {
    addLog(t('log.loadingSimData', { id: context.id }))
    
    // 获取 simulation 信息
    const simRes = await getSimulation(context.id, context.controller.signal)
    if (!canRead(context)) return
    if (simRes.success && simRes.data) {
      const simData = simRes.data
      
      // 获取 simulation config 以获取 minutes_per_round
      try {
        const configRes = await getSimulationConfig(context.id, context.controller.signal)
        if (!canRead(context)) return
        if (configRes.success && configRes.data?.time_config?.minutes_per_round) {
          minutesPerRound.value = configRes.data.time_config.minutes_per_round
          addLog(t('log.timeConfig', { minutes: minutesPerRound.value }))
        }
      } catch (configErr) {
        if (!canRead(context)) return
        addLog(t('log.timeConfigFetchFailed', { minutes: minutesPerRound.value }))
      }
      
      // 获取 project 信息
      if (simData.project_id) {
        const projRes = await getProject(simData.project_id, context.controller.signal)
        if (!canRead(context)) return
        if (projRes.success && projRes.data) {
          projectData.value = projRes.data
          addLog(t('log.projectLoadSuccess', { id: projRes.data.project_id }))
          
          // 获取 graph 数据
          if (projRes.data.graph_id) {
            await loadGraph(projRes.data.graph_id, context)
          }
        }
      }
    } else {
      addLog(t('log.loadSimDataFailed', { error: simRes.error || t('common.unknownError') }))
    }
  } catch (err) {
    if (!canRead(context)) return
    addLog(t('log.loadException', { error: err.message }))
  }
}

const loadGraph = async (graphId, context) => {
  if (!canRead(context)) return
  context.graphRequest?.controller.abort()
  const request = { controller: new AbortController() }
  context.graphRequest = request
  const ownsRequest = () => canRead(context) && context.graphRequest === request
  if (!isSimulating.value) graphLoading.value = true
  try {
    const res = await getGraphData(graphId, request.controller.signal)
    if (!ownsRequest()) return
    if (res.success) {
      graphData.value = res.data
      if (!isSimulating.value) addLog(t('log.graphDataLoadSuccess'), context)
    }
  } catch (err) {
    if (ownsRequest()) addLog(t('log.graphLoadFailed', { error: err.message }), context)
  } finally {
    if (ownsRequest()) graphLoading.value = false
  }
}

const refreshGraph = () => {
  const context = viewContext
  if (canRead(context) && projectData.value?.graph_id) {
    loadGraph(projectData.value.graph_id, context)
  }
}

const startGraphRefresh = (context = viewContext) => {
  if (!canRead(context) || !isSimulating.value || context.graphTimer !== null) return
  addLog(t('log.graphRealtimeRefreshStart'), context)
  context.graphTimer = setInterval(() => {
    if (canRead(context)) refreshGraph()
  }, 30000)
}

const stopGraphRefresh = (context = viewContext) => {
  if (context?.graphTimer !== null && context?.graphTimer !== undefined) {
    clearInterval(context.graphTimer)
    context.graphTimer = null
    addLog(t('log.graphRealtimeRefreshStop'), context)
  }
}

watch(currentSimulationId, id => {
  retireReportRun()
  retireView()
  viewContext = null
  projectData.value = null
  graphData.value = null
  graphLoading.value = false
  systemLogs.value = []
  currentStatus.value = 'processing'
  // Query-only navigation keeps this run's settings; a new selection reads its own query.
  maxRounds.value = route.query.maxRounds ? parseInt(route.query.maxRounds) : null
  minutesPerRound.value = 30
  if (!id) return
  const context = { id, active: true, controller: new AbortController(), graphRequest: null, goingBack: false, backController: null, graphTimer: null }
  viewContext = context
  addLog(t('log.simRunViewInit'), context)
  if (maxRounds.value) addLog(t('log.customRounds', { rounds: maxRounds.value }), context)
  loadSimulationData(context)
  startGraphRefresh(context)
}, { immediate: true, flush: 'sync' })

watch(isSimulating, running => {
  if (running) startGraphRefresh()
  else stopGraphRefresh()
})

onBeforeRouteLeave(to => {
  if (suspendReport(to) === false) return false
  retireView()
})
onBeforeUnmount(() => {
  retireReportRun()
  removeReportDeparture()
  removeReportRecovery()
  removeReportErrorRecovery()
  retireView()
})
</script>

<style scoped>
.main-view {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #FFF;
  overflow: hidden;
  font-family: 'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif;
}

/* Header */
.app-header {
  height: 60px;
  border-bottom: 1px solid #EAEAEA;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: #FFF;
  z-index: 100;
  position: relative;
}

.header-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.brand {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 1px;
  cursor: pointer;
}

.view-switcher {
  display: flex;
  background: #F5F5F5;
  padding: 4px;
  border-radius: 6px;
  gap: 4px;
}

.switch-btn {
  border: none;
  background: transparent;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  color: #666;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.switch-btn.active {
  background: #FFF;
  color: #000;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.workflow-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.step-num {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: #999;
}

.step-name {
  font-weight: 700;
  color: #000;
}

.step-divider {
  width: 1px;
  height: 14px;
  background-color: #E0E0E0;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #666;
  font-weight: 500;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #CCC;
}

.status-indicator.processing .dot { background: #FF5722; animation: pulse 1s infinite; }
.status-indicator.completed .dot { background: #4CAF50; }
.status-indicator.error .dot { background: #F44336; }

@keyframes pulse { 50% { opacity: 0.5; } }

/* Content */
.content-area {
  flex: 1;
  display: flex;
  position: relative;
  overflow: hidden;
}

.panel-wrapper {
  height: 100%;
  overflow: hidden;
  transition: width 0.4s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.3s ease, transform 0.3s ease;
  will-change: width, opacity, transform;
}

.panel-wrapper.left {
  border-right: 1px solid #EAEAEA;
}
</style>
