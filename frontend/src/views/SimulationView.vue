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
          <span class="step-num">Step 2/5</span>
          <span class="step-name">{{ $tm('main.stepNames')[1] }}</span>
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
        <div v-if="runtimeMode === 'local' && !graphData && !graphLoading" class="local-graph-placeholder">
          <p>{{ $t('localPlan.graphHint') }}</p>
          <button data-testid="refresh-local-graph" type="button" :disabled="!projectData?.graph_id" :onClick="viewActions.refreshGraph">{{ $t('graph.refreshGraph') }}</button>
        </div>
        <GraphPanel v-else
          :graphData="graphData"
          :loading="graphLoading"
          :currentPhase="2"
          @refresh="refreshGraph"
          @toggle-maximize="toggleMaximize('graph')"
        />
      </div>

      <!-- Right Panel: Step2 环境搭建 -->
      <div class="panel-wrapper right" :style="rightPanelStyle">
        <Step2EnvSetup
          :simulationId="currentSimulationId"
          :cleanupReady="cleanupReady"
          :projectData="projectData"
          :graphData="graphData"
          :systemLogs="systemLogs"
          @go-back="handleGoBack"
          @next-step="handleNextStep"
          @add-log="addLog"
          @update-status="updateStatus"
          @runtime-mode="updateRuntimeMode"
        />
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import GraphPanel from '../components/GraphPanel.vue'
import Step2EnvSetup from '../components/Step2EnvSetup.vue'
import { getProject, getGraphData } from '../api/graph'
import { getSimulation, stopSimulation, getEnvStatus, closeSimulationEnv } from '../api/simulation'
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
const projectData = ref(null)
const graphData = ref(null)
const graphLoading = ref(false)
const systemLogs = ref([])
const viewActions = ref({})
const cleanupReady = ref(false)
const runtimeMode = ref('unknown')
const currentStatus = ref('planning') // processing | completed | error

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
  return t('localPlan.status.' + ({ error: 'error', completed: 'ready', cancelled: 'cancelled', processing: 'preparing', idle: 'idle', blocked: 'blocked' }[currentStatus.value] || 'planning'))
})

// A new identity owns every selection, including A → B → A in a reused view.
let viewContext = null
const ownsView = context => !!context && context.active && context === viewContext
  && context.id === currentSimulationId.value && context.id === route.params.simulationId

const retireView = (context = viewContext) => {
  if (!context) return
  context.active = false
  context.controller.abort()
  context.graphRequest?.controller.abort()
}

// --- Helpers ---
const addLog = (msg, context = viewContext) => {
  if (!ownsView(context)) return
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + new Date().getMilliseconds().toString().padStart(3, '0')
  systemLogs.value.push({ time, msg })
  if (systemLogs.value.length > 100) {
    systemLogs.value.shift()
  }
}

const updateStatus = (status) => {
  if (!ownsView(viewContext)) return
  currentStatus.value = status
}

const updateRuntimeMode = mode => {
  const context = viewContext
  if (!ownsView(context) || !['local', 'cloud'].includes(mode)) return
  runtimeMode.value = mode
  if (mode === 'cloud' && projectData.value?.graph_id && !context.graphRequest) loadGraph(projectData.value.graph_id, context)
}

// --- Layout Methods ---
const toggleMaximize = (target) => {
  if (viewMode.value === target) {
    viewMode.value = 'split'
  } else {
    viewMode.value = target
  }
}

const handleGoBack = () => {
  const context = viewContext
  if (!ownsView(context)) return
  const projectId = projectData.value?.project_id
  retireView(context)
  router.push(projectId ? { name: 'Process', params: { projectId } } : '/')
}

const handleNextStep = (params = {}) => {
  const context = viewContext
  if (!ownsView(context)) return
  addLog(t('log.enterStep3'), context)
  if (params.maxRounds) {
    addLog(t('log.customRoundsConfig', { rounds: params.maxRounds }), context)
  } else {
    addLog(t('log.useAutoRounds'), context)
  }
  const routeParams = { name: 'SimulationRun', params: { simulationId: context.id } }
  if (params.maxRounds) routeParams.query = { maxRounds: params.maxRounds }
  // Retire cleanup before navigation can mount a new run of the same simulation.
  retireView(context)
  router.push(routeParams)
}

// --- Data Logic ---

// Returning from Step 3 keeps the existing graceful-close/force-stop policy.
const checkAndStopRunningSimulation = async (context) => {
  if (!ownsView(context)) return
  try {
    const envStatusRes = await getEnvStatus({ simulation_id: context.id }, context.controller.signal)
    if (!ownsView(context)) return
    if (envStatusRes.success && envStatusRes.data?.env_alive) {
      addLog(t('log.detectedSimEnvRunning'), context)
      try {
        const closeRes = await closeSimulationEnv({ simulation_id: context.id, timeout: 10 }, context.controller.signal)
        if (!ownsView(context)) return
        if (closeRes.success) {
          addLog(t('log.simEnvClosed'), context)
        } else {
          addLog(t('log.closeSimEnvFailedWithError', { error: t('localPlan.requestError') }), context)
          await forceStopSimulation(context)
        }
      } catch (closeErr) {
        if (!ownsView(context)) return
        addLog(t('log.closeSimEnvException', { error: t('localPlan.requestError') }), context)
        await forceStopSimulation(context)
      }
    } else {
      const simRes = await getSimulation(context.id, context.controller.signal)
      if (!ownsView(context)) return
      if (simRes.success && simRes.data?.status === 'running') {
        addLog(t('log.detectedSimRunning'), context)
        await forceStopSimulation(context)
      }
    }
  } catch (err) {
    if (ownsView(context)) console.warn('检查模拟状态失败:', err)
  }
}

const forceStopSimulation = async (context) => {
  if (!ownsView(context)) return
  try {
    const stopRes = await stopSimulation({ simulation_id: context.id }, context.controller.signal)
    if (!ownsView(context)) return
    if (stopRes.success) {
      addLog(t('log.simForceStopSuccess'), context)
    } else {
      addLog(t('log.forceStopSimFailed', { error: t('localPlan.requestError') }), context)
    }
  } catch (err) {
    if (ownsView(context)) addLog(t('log.forceStopSimException', { error: t('localPlan.requestError') }), context)
  }
}

const loadSimulationData = async (context) => {
  if (!ownsView(context)) return
  try {
    addLog(t('log.loadingSimData', { id: context.id }))

    // 获取 simulation 信息
    const simRes = await getSimulation(context.id, context.controller.signal)
    if (!ownsView(context)) return
    if (simRes.success && simRes.data) {
      const simData = simRes.data

      // 获取 project 信息
      if (simData.project_id) {
        const projRes = await getProject(simData.project_id, context.controller.signal)
        if (!ownsView(context)) return
        if (projRes.success && projRes.data) {
          projectData.value = projRes.data
          addLog(t('log.projectLoadSuccess', { id: projRes.data.project_id }))
          
          // 获取 graph 数据
          if (runtimeMode.value === 'cloud' && projRes.data.graph_id) {
            await loadGraph(projRes.data.graph_id, context)
          }
        }
      }
    } else {
      addLog(t('log.loadSimDataFailed', { error: t('localPlan.requestError') }))
    }
  } catch (err) {
    if (!ownsView(context)) return
    addLog(t('log.loadException', { error: t('localPlan.requestError') }))
  }
}

const loadGraph = async (graphId, context) => {
  if (!ownsView(context)) return
  context.graphRequest?.controller.abort()
  const request = { controller: new AbortController() }
  context.graphRequest = request
  const ownsRequest = () => ownsView(context) && context.graphRequest === request
  graphLoading.value = true
  try {
    const res = await getGraphData(graphId, request.controller.signal)
    if (!ownsRequest()) return
    if (res.success) {
      graphData.value = res.data
      addLog(t('log.graphDataLoadSuccess'), context)
    }
  } catch (err) {
    if (ownsRequest()) addLog(t('log.graphLoadFailed', { error: t('localPlan.requestError') }), context)
  } finally {
    if (ownsRequest()) graphLoading.value = false
  }
}

const refreshGraph = () => {
  const context = viewContext
  if (ownsView(context) && projectData.value?.graph_id) {
    loadGraph(projectData.value.graph_id, context)
  }
}

watch(currentSimulationId, id => {
  retireView()
  viewContext = null
  viewActions.value = {}
  projectData.value = null
  graphData.value = null
  graphLoading.value = false
  systemLogs.value = []
  currentStatus.value = 'planning'
  cleanupReady.value = false
  runtimeMode.value = 'unknown'
  if (!id) return
  const context = { id, active: true, controller: new AbortController(), graphRequest: null }
  viewContext = context
  viewActions.value = { refreshGraph: () => { if (ownsView(context)) refreshGraph() } }
  addLog(t('log.simViewInit'), context)
  checkAndStopRunningSimulation(context).then(() => {
    if (ownsView(context)) {
      cleanupReady.value = true
      loadSimulationData(context)
    }
  })
}, { immediate: true, flush: 'sync' })

onBeforeRouteLeave(() => retireView())
onBeforeUnmount(() => retireView())
</script>

<style scoped>
.local-graph-placeholder { padding: 24px; font-size: 13px; line-height: 1.6; color: #555; }
.local-graph-placeholder button { border: 1px solid #ccc; padding: 8px 16px; background: white; border-radius: 5px; cursor: pointer; }
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

.brand {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 1px;
  cursor: pointer;
}

.header-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
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
