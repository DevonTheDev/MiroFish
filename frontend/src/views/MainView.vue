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
          <span class="step-num">Step {{ currentStep }}/5</span>
          <span class="step-name">{{ $tm('main.stepNames')[currentStep - 1] }}</span>
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
          :currentPhase="currentPhase"
          @refresh="refreshGraph"
          @toggle-maximize="toggleMaximize('graph')"
        />
      </div>

      <!-- Right Panel: Step Components -->
      <div class="panel-wrapper right" :style="rightPanelStyle">
        <!-- Step 1: 图谱构建 -->
        <Step1GraphBuild 
          v-if="currentStep === 1"
          :currentPhase="currentPhase"
          :projectData="projectData"
          :ontologyProgress="ontologyProgress"
          :buildProgress="buildProgress"
          :graphData="graphData"
          :systemLogs="systemLogs"
          @next-step="handleNextStep"
        />
        <!-- Step 2: 环境搭建 -->
        <Step2EnvSetup
          v-else-if="currentStep === 2"
          :projectData="projectData"
          :graphData="graphData"
          :systemLogs="systemLogs"
          @go-back="handleGoBack"
          @next-step="handleNextStep"
          @add-log="addLog"
        />
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GraphPanel from '../components/GraphPanel.vue'
import Step1GraphBuild from '../components/Step1GraphBuild.vue'
import Step2EnvSetup from '../components/Step2EnvSetup.vue'
import { generateOntology, getProject, buildGraph, getTaskStatus, getGraphData } from '../api/graph'
import { getPendingUpload, clearPendingUpload } from '../store/pendingUpload'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'

const route = useRoute()
const router = useRouter()
const { t, tm } = useI18n()

// Layout State
const viewMode = ref('split') // graph | split | workbench

// Step State
const currentStep = ref(1) // 1: 图谱构建, 2: 环境搭建, 3: 开始模拟, 4: 报告生成, 5: 深度互动
const stepNames = computed(() => tm('main.stepNames'))

// Data State
const currentProjectId = computed(() => route.params.projectId)
const loading = ref(false)
const graphLoading = ref(false)
const error = ref('')
const projectData = ref(null)
const graphData = ref(null)
const currentPhase = ref(-1) // -1: Upload, 0: Ontology, 1: Build, 2: Complete
const ontologyProgress = ref(null)
const buildProgress = ref(null)
const systemLogs = ref([])

// Every route selection has its own identity, including A → B → A.
let viewContext = null
let projectAdoption = null
const ownsView = context => !!context && context.active && context === viewContext
  && route.name === 'Process' && context.id === currentProjectId.value

const resetProjectState = () => {
  currentStep.value = 1
  loading.value = false
  graphLoading.value = false
  error.value = ''
  projectData.value = null
  graphData.value = null
  currentPhase.value = -1
  ontologyProgress.value = null
  buildProgress.value = null
  systemLogs.value = []
}

const retireView = (context = viewContext) => {
  if (!context) return
  context.active = false
  // Abort HTTP observers only; already accepted server work may continue.
  context.controller.abort()
  context.graphRequest?.controller.abort()
  stopPolling(context)
  if (context === viewContext) resetProjectState()
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
  if (error.value) return 'error'
  if (currentPhase.value >= 2) return 'completed'
  return 'processing'
})

const statusText = computed(() => {
  if (error.value) return 'Error'
  if (currentPhase.value >= 2) return 'Ready'
  if (currentPhase.value === 1) return 'Building Graph'
  if (currentPhase.value === 0) return 'Generating Ontology'
  return 'Initializing'
})

// --- Helpers ---
const addLog = (msg, context = viewContext) => {
  if (!ownsView(context)) return
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + new Date().getMilliseconds().toString().padStart(3, '0')
  systemLogs.value.push({ time, msg })
  // Keep last 100 logs
  if (systemLogs.value.length > 100) {
    systemLogs.value.shift()
  }
}

// --- Layout Methods ---
const toggleMaximize = (target) => {
  if (viewMode.value === target) {
    viewMode.value = 'split'
  } else {
    viewMode.value = target
  }
}

const handleNextStep = (params = {}) => {
  if (currentStep.value < 5) {
    currentStep.value++
    addLog(t('log.enterStep', { step: currentStep.value, name: stepNames.value[currentStep.value - 1] }))
    
    // 如果是从 Step 2 进入 Step 3，记录模拟轮数配置
    if (currentStep.value === 3 && params.maxRounds) {
      addLog(t('log.customSimRounds', { rounds: params.maxRounds }))
    }
  }
}

const handleGoBack = () => {
  if (currentStep.value > 1) {
    currentStep.value--
    addLog(t('log.returnToStep', { step: currentStep.value, name: stepNames.value[currentStep.value - 1] }))
  }
}

// --- Data Logic ---

const initProject = async (context) => {
  if (!ownsView(context)) return
  addLog('Project view initialized.', context)
  if (context.id === 'new') {
    await handleNewProject(context)
  } else {
    await loadProject(context)
  }
}

const handleNewProject = async (context) => {
  if (!ownsView(context)) return
  const pending = getPendingUpload()
  if (!pending.isPending || pending.files.length === 0) {
    error.value = 'No pending files found.'
    addLog('Error: No pending files found for new project.', context)
    return
  }

  try {
    loading.value = true
    currentPhase.value = 0
    ontologyProgress.value = { message: 'Uploading and analyzing docs...' }
    addLog('Starting ontology generation: Uploading files...', context)

    const formData = new FormData()
    pending.files.forEach(f => formData.append('files', f))
    formData.append('simulation_requirement', pending.simulationRequirement)

    const res = await generateOntology(formData, context.controller.signal)
    if (!ownsView(context)) return
    if (res.success) {
      // The route watcher consumes this handoff once, after navigation commits.
      // It owns the only build path; the retired upload never starts another one.
      projectAdoption = { context, id: res.data.project_id, data: res.data, pending }
      await router.replace({ name: 'Process', params: { projectId: res.data.project_id } })
      if (!ownsView(context)) return
      projectAdoption = null
      error.value = 'Project navigation was interrupted.'
      addLog(error.value, context)
    } else {
      error.value = res.error || 'Ontology generation failed'
      addLog(`Error generating ontology: ${error.value}`, context)
    }
  } catch (err) {
    if (!ownsView(context)) return
    projectAdoption = null
    error.value = err.message
    addLog(`Exception in handleNewProject: ${err.message}`, context)
  } finally {
    if (ownsView(context)) loading.value = false
  }
}

const loadProject = async (context) => {
  if (!ownsView(context)) return
  try {
    loading.value = true
    addLog(`Loading project ${context.id}...`, context)
    const res = await getProject(context.id, context.controller.signal)
    if (!ownsView(context)) return
    if (res.success) {
      projectData.value = res.data
      updatePhaseByStatus(res.data.status)
      addLog(`Project loaded. Status: ${res.data.status}`, context)

      if (res.data.status === 'ontology_generated' && !res.data.graph_id) {
        await startBuildGraph(context)
      } else if (res.data.status === 'graph_building' && res.data.graph_build_task_id) {
        currentPhase.value = 1
        startPollingTask(res.data.graph_build_task_id, context)
      } else if (res.data.status === 'graph_completed' && res.data.graph_id) {
        currentPhase.value = 2
        await loadGraph(res.data.graph_id, context)
      }
    } else {
      error.value = res.error
      addLog(`Error loading project: ${res.error}`, context)
    }
  } catch (err) {
    if (!ownsView(context)) return
    error.value = err.message
    addLog(`Exception in loadProject: ${err.message}`, context)
  } finally {
    if (ownsView(context)) loading.value = false
  }
}

const updatePhaseByStatus = (status) => {
  switch (status) {
    case 'created':
    case 'ontology_generated': currentPhase.value = 0; break;
    case 'graph_building': currentPhase.value = 1; break;
    case 'graph_completed': currentPhase.value = 2; break;
    case 'failed': error.value = 'Project failed'; break;
  }
}

const startBuildGraph = async (context) => {
  if (!ownsView(context)) return
  try {
    currentPhase.value = 1
    buildProgress.value = { progress: 0, message: 'Starting build...' }
    addLog('Initiating graph build...', context)

    const res = await buildGraph({ project_id: context.id }, context.controller.signal)
    if (!ownsView(context)) return
    if (res.success) {
      if (res.data.reused && res.data.graph_id) {
        currentPhase.value = 2
        buildProgress.value = null
        const projectRes = await getProject(context.id, context.controller.signal)
        if (!ownsView(context)) return
        if (projectRes.success) projectData.value = projectRes.data
        await loadGraph(res.data.graph_id, context)
        return
      }

      addLog(`Graph build task started. Task ID: ${res.data.task_id}`, context)
      startPollingTask(res.data.task_id, context)
    } else {
      error.value = res.error
      addLog(`Error starting build: ${res.error}`, context)
    }
  } catch (err) {
    if (!ownsView(context)) return
    error.value = err.message
    addLog(`Exception in startBuildGraph: ${err.message}`, context)
  }
}

const stopPolling = (context) => {
  if (context?.pollTimer != null) {
    clearInterval(context.pollTimer)
    context.pollTimer = null
  }
}

const startPollingTask = (taskId, context) => {
  if (!ownsView(context)) return
  stopPolling(context)
  const task = { id: taskId, inFlight: false, terminal: false }
  context.task = task
  context.pollTimer = setInterval(() => pollTaskStatus(task, context), 2000)
  pollTaskStatus(task, context)
}

const pollTaskStatus = async (task, context) => {
  const ownsTask = () => ownsView(context) && context.task === task
  if (!ownsTask() || task.terminal || task.inFlight) return
  task.inFlight = true
  try {
    const res = await getTaskStatus(task.id, context.controller.signal)
    if (!ownsTask() || task.terminal) return
    if (res.success) {
      const result = res.data
      if (result.message && result.message !== buildProgress.value?.message) {
        addLog(result.message, context)
      }
      buildProgress.value = { progress: result.progress || 0, message: result.message }

      if (result.status === 'completed') {
        // Claim the terminal transition before starting any final reads.
        task.terminal = true
        stopPolling(context)
        addLog('Graph build task completed.', context)
        currentPhase.value = 2
        const projRes = await getProject(context.id, context.controller.signal)
        if (!ownsTask()) return
        if (projRes.success && projRes.data.graph_id) {
          projectData.value = projRes.data
          await loadGraph(projRes.data.graph_id, context)
        }
      } else if (result.status === 'failed') {
        task.terminal = true
        stopPolling(context)
        error.value = result.error
        addLog(`Graph build task failed: ${result.error}`, context)
      }
    }
  } catch (err) {
    if (ownsTask()) console.error(err)
  } finally {
    if (ownsTask()) task.inFlight = false
  }
}

const loadGraph = async (graphId, context) => {
  if (!ownsView(context)) return
  context.graphRequest?.controller.abort()
  const request = { controller: new AbortController() }
  context.graphRequest = request
  const ownsRequest = () => ownsView(context) && context.graphRequest === request
  graphLoading.value = true
  addLog(`Loading full graph data: ${graphId}`, context)
  try {
    const res = await getGraphData(graphId, request.controller.signal)
    if (!ownsRequest()) return
    if (res.success) {
      graphData.value = res.data
      addLog('Graph data loaded successfully.', context)
    } else {
      addLog(`Failed to load graph data: ${res.error}`, context)
    }
  } catch (err) {
    if (ownsRequest()) addLog(`Exception loading graph: ${err.message}`, context)
  } finally {
    if (ownsRequest()) graphLoading.value = false
  }
}

const refreshGraph = () => {
  const context = viewContext
  if (ownsView(context) && projectData.value?.graph_id) {
    addLog('Manual graph refresh triggered.', context)
    loadGraph(projectData.value.graph_id, context)
  }
}

const selectProject = (id, recovering = false) => {
  const adoption = !recovering && projectAdoption?.context === viewContext && viewContext?.active
    && projectAdoption.id === id ? projectAdoption : null
  retireView()
  projectAdoption = null
  viewContext = null
  resetProjectState()
  if (!id || route.name !== 'Process') return
  const context = { id, active: true, controller: new AbortController(), graphRequest: null, task: null, pollTimer: null }
  viewContext = context
  if (recovering && id === 'new') {
    // Aborted upload observation may already have created a server project.
    // Never silently replay that POST after a canceled navigation.
    error.value = 'Upload observation was interrupted. Return home to start the upload again.'
    addLog(error.value, context)
  } else if (adoption) {
    const pending = getPendingUpload()
    if (pending.files === adoption.pending.files && pending.simulationRequirement === adoption.pending.simulationRequirement) {
      clearPendingUpload()
    }
    projectData.value = adoption.data
    addLog(`Ontology generated successfully for project ${id}`, context)
    startBuildGraph(context)
  } else {
    initProject(context)
  }
}

watch(currentProjectId, id => selectProject(id), { immediate: true, flush: 'sync' })

onBeforeRouteLeave(to => {
  if (viewContext) viewContext.departure = to.redirectedFrom || to
  retireView()
})
// A leave may abort, redirect, throw, or lose to a newer navigation. Recover
// only its exact failed attempt or a route that has actually become current.
const recoverSelectedProject = (to, committed = false) => {
  const context = viewContext
  if (context && !context.active && route.name === 'Process'
    && currentProjectId.value === context.id
    && (context.departure === (to.redirectedFrom || to)
      || (committed && router.currentRoute.value === to))) {
    selectProject(context.id, true)
  }
}
const removeRouteRecovery = router.afterEach((to, _from, failure) => {
  recoverSelectedProject(to, !failure)
})
const removeRouteErrorRecovery = router.onError((err, to) => {
  recoverSelectedProject(to)
  console.error(err)
})
onBeforeUnmount(() => {
  removeRouteRecovery()
  removeRouteErrorRecovery()
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

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #666;
  font-weight: 500;
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
