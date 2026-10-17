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
          <span class="step-num">Step 4/5</span>
          <span class="step-name">{{ $tm('main.stepNames')[3] }}</span>
        </div>
        <div class="step-divider"></div>
        <span class="status-indicator" :class="statusClass">
          <span class="dot"></span>
          {{ statusText }}
        </span>
      </div>
    </header>

    <section
      v-if="metadataStatus === 'loading' || metadataStatus === 'unavailable'"
      class="graph-metadata-panel"
      data-testid="graph-metadata"
      :aria-busy="metadataStatus === 'loading'"
    >
      <div
        data-testid="graph-metadata-message"
        :role="metadataStatus === 'unavailable' ? 'alert' : 'status'"
        :aria-live="metadataStatus === 'unavailable' ? 'assertive' : 'polite'"
        aria-atomic="true"
      >
        <p class="graph-metadata-title">
          {{ $t(metadataStatus === 'loading' ? 'graph.reportMetadataLoading' : 'graph.reportMetadataUnavailable') }}
        </p>
        <p v-if="metadataStatus === 'unavailable'" class="graph-metadata-hint">
          {{ $t('graph.reportMetadataHint') }}
        </p>
      </div>
      <!-- Bind the route callback directly, without a cached ref lookup. -->
      <button
        type="button"
        class="graph-metadata-retry"
        data-testid="retry-graph-metadata"
        :disabled="metadataStatus === 'loading'"
        v-on="{ click: retryMetadata }"
      >{{ $t('graph.reportMetadataRetry') }}</button>
    </section>

    <!-- Main Content Area -->
    <main class="content-area">
      <!-- Left Panel: Graph -->
      <div class="panel-wrapper left" :style="leftPanelStyle">
        <div
          class="report-graph-content"
          data-testid="report-graph-content"
          :hidden="metadataStatus !== 'ready'"
        >
          <GraphPanel 
            :graphData="graphData"
            :loading="graphLoading"
            :currentPhase="4"
            :isSimulating="false"
            @refresh="refreshGraph"
            @toggle-maximize="toggleMaximize('graph')"
          />
        </div>
      </div>

      <!-- Right Panel: Step4 报告生成 -->
      <div class="panel-wrapper right" :style="rightPanelStyle">
        <Step4Report
          :reportId="currentReportId"
          :simulationId="simulationId"
          :systemLogs="systemLogs"
          @add-log="addLog"
          @update-status="updateStatus"
        />
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GraphPanel from '../components/GraphPanel.vue'
import Step4Report from '../components/Step4Report.vue'
import { getProject, getGraphData } from '../api/graph'
import { getSimulation } from '../api/simulation'
import { getReport } from '../api/report'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

// Props
const props = defineProps({
  reportId: String
})

// Layout State - 默认切换到工作台视角
const viewMode = ref('workbench')

// Data State
const currentReportId = ref(route.params.reportId)
const simulationId = ref(null)
const projectData = ref(null)
const graphData = ref(null)
const graphLoading = ref(false)
const metadataStatus = ref('idle') // idle | loading | unavailable | ready
const retryMetadata = ref(null)
const systemLogs = ref([])
const currentStatus = ref('processing') // processing | completed | error

// Each selected report owns its entire metadata/graph chain, including A → B → A.
let viewContext = null
const ownsView = context => !!context && context.active && context === viewContext
  && context.id === currentReportId.value && context.id === route.params.reportId

const retireView = () => {
  if (!viewContext) return
  viewContext.active = false
  viewContext.controller.abort()
}

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
  if (currentStatus.value === 'cancelled') return t('step4.cancelled')
  if (currentStatus.value === 'cancelling') return t('step4.cancelling')
  if (currentStatus.value === 'error') return 'Error'
  if (currentStatus.value === 'completed') return 'Completed'
  return 'Generating'
})

// --- Helpers ---
const addLog = (msg, context = viewContext) => {
  if (!ownsView(context)) return
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + new Date().getMilliseconds().toString().padStart(3, '0')
  systemLogs.value.push({ time, msg })
  if (systemLogs.value.length > 200) {
    systemLogs.value.shift()
  }
}

const updateStatus = (status) => {
  if (!ownsView(viewContext)) return
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

// --- Data Logic ---
const requireMetadata = (response, relation) => {
  const data = response?.data
  if (response?.success !== true || !data || typeof data !== 'object' || Array.isArray(data)
    || typeof data[relation] !== 'string' || !data[relation].trim()) {
    throw new Error(response?.error || t('graph.reportMetadataUnavailable'))
  }
  return data
}

const loadReportData = async (context) => {
  if (!ownsView(context) || context.metadataPending || metadataStatus.value === 'ready') return
  context.metadataPending = true
  metadataStatus.value = 'loading'
  try {
    addLog(t('log.loadReportData', { id: context.id }), context)

    const reportRes = await getReport(context.id, context.controller.signal)
    if (!ownsView(context)) return
    const reportData = requireMetadata(reportRes, 'simulation_id')
    simulationId.value = reportData.simulation_id

    const simRes = await getSimulation(reportData.simulation_id, context.controller.signal)
    if (!ownsView(context)) return
    const simData = requireMetadata(simRes, 'project_id')

    const projRes = await getProject(simData.project_id, context.controller.signal)
    if (!ownsView(context)) return
    const project = requireMetadata(projRes, 'graph_id')
    projectData.value = project
    addLog(t('log.projectLoadSuccess', { id: project.project_id }), context)
    metadataStatus.value = 'ready'
    await loadGraph(project.graph_id, context)
  } catch (err) {
    if (!ownsView(context)) return
    metadataStatus.value = 'unavailable'
    addLog(t('log.loadException', { error: err.message }), context)
  } finally {
    context.metadataPending = false
  }
}

const loadGraph = async (graphId, context) => {
  if (!ownsView(context)) return
  graphLoading.value = true
  
  try {
    const res = await getGraphData(graphId, context.controller.signal)
    if (!ownsView(context)) return
    if (res.success) {
      graphData.value = res.data
      addLog(t('log.graphDataLoadSuccess'), context)
    }
  } catch (err) {
    if (ownsView(context)) addLog(t('log.graphLoadFailed', { error: err.message }), context)
  } finally {
    if (ownsView(context)) graphLoading.value = false
  }
}

const refreshGraph = () => {
  if (ownsView(viewContext) && projectData.value?.graph_id) {
    loadGraph(projectData.value.graph_id, viewContext)
  }
}

// Watch route params
watch(() => route.params.reportId, (newId) => {
  retireView()
  currentReportId.value = newId
  simulationId.value = null
  projectData.value = null
  graphData.value = null
  graphLoading.value = false
  metadataStatus.value = 'idle'
  retryMetadata.value = null
  systemLogs.value = []
  currentStatus.value = 'processing'
  viewContext = newId ? { id: newId, active: true, metadataPending: false, controller: new AbortController() } : null
  if (viewContext) {
    const context = viewContext
    retryMetadata.value = () => loadReportData(context)
    loadReportData(context)
  }
}, { immediate: true })

onMounted(() => {
  addLog(t('log.reportViewInit'))
})

onBeforeUnmount(retireView)
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

.status-indicator.processing .dot { background: #FF9800; animation: pulse 1s infinite; }
.status-indicator.completed .dot { background: #4CAF50; }
.status-indicator.error .dot { background: #F44336; }

@keyframes pulse { 50% { opacity: 0.5; } }

.graph-metadata-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  flex-shrink: 0;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid #EAEAEA;
  background: #F8F9FA;
  color: #333;
}

.graph-metadata-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.graph-metadata-hint {
  margin: 4px 0 0;
  font-size: 13px;
}

.graph-metadata-retry {
  border: 1px solid #666;
  border-radius: 4px;
  padding: 8px 12px;
  background: #FFF;
  color: #333;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.graph-metadata-retry:focus-visible {
  outline: 2px solid #2563EB;
  outline-offset: 2px;
}

.graph-metadata-retry:disabled {
  opacity: 0.6;
  cursor: wait;
}

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

.report-graph-content {
  height: 100%;
}

.report-graph-content[hidden] {
  display: none;
}

.panel-wrapper.left {
  border-right: 1px solid #EAEAEA;
}
</style>
