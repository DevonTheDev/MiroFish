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
          :graphDownload="graphDownload"
          :graphViewDownload="graphViewDownload"
          @graph-view-capture="acceptGraphViewCapture"
          @graph-view-retired="retireGraphViewCapture"
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
          :graphResult="graphResult"
          :graphData="graphData"
          :systemLogs="systemLogs"
          :simulationHandoff="simulationHandoff"
          @simulation-created="simulationHandoff.accept"
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
import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GraphPanel from '../components/GraphPanel.vue'
import Step1GraphBuild from '../components/Step1GraphBuild.vue'
import Step2EnvSetup from '../components/Step2EnvSetup.vue'
import { generateOntology, getProject, buildGraph, getTaskStatus, getGraphData } from '../api/graph'
import { getPendingUpload, clearPendingUpload } from '../store/pendingUpload'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { hasLoadedGraphShape, createLoadedGraphFile } from '../utils/loadedGraphFile.js'
import { MAX_GRAPH_VIEW_SVG_BYTES } from '../utils/graphViewSvg.js'

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
const graphResult = ref(null)
const systemLogs = ref([])

// The accepted receipt outlives graph observation, but never its selection.
// Each recovery carries only data into a fresh action owner, not old callbacks.
const simulationHandoff = shallowRef({})
let simulationOwner = null
let simulationDeparture = null
const validSimulationId = id => typeof id === 'string' && id.trim().length > 0
const ownsSimulation = owner => owner === simulationOwner && owner.active
  && route.name === 'Process' && currentProjectId.value === owner.projectId
const atAcceptedSimulation = receipt => router.currentRoute.value.name === 'Simulation'
  && router.currentRoute.value.params.simulationId === receipt.simulationId

const publishSimulationHandoff = owner => {
  if (owner !== simulationOwner) return
  simulationHandoff.value = {
    owner, receipt: owner.receipt, opening: owner.opening,
    disabled: !owner.active || owner.opening,
    open: owner.open, accept: owner.accept,
  }
}

const openAcceptedSimulation = async (owner, receipt) => {
  if (!ownsSimulation(owner) || owner.receipt !== receipt || owner.opening || atAcceptedSimulation(receipt)) return
  const attempt = {}
  owner.attempt = attempt
  owner.opening = true
  publishSimulationHandoff(owner)
  try {
    // Vue Router may resolve a failure, reject, or follow a redirect. Only the
    // actual destination establishes success; retired continuations are inert.
    await router.push({ name: 'Simulation', params: { simulationId: receipt.simulationId } })
  } catch {
    // The route recovery hook renews actions if this attempt retired its owner.
    // Navigation failure is separate from the already successful create POST.
  } finally {
    if (ownsSimulation(owner) && owner.attempt === attempt) {
      owner.opening = false
      publishSimulationHandoff(owner)
    }
  }
}

const selectSimulationOwner = (projectId, graphId = null, receipt = null) => {
  if (simulationOwner) simulationOwner.active = false
  const owner = { projectId, graphId, receipt, active: true, opening: false, attempt: null }
  simulationOwner = owner
  simulationDeparture = null
  owner.open = () => { if (owner.receipt) return openAcceptedSimulation(owner, owner.receipt) }
  owner.accept = accepted => {
    if (!ownsSimulation(owner) || owner.receipt || accepted.owner !== owner
      || accepted.projectId !== owner.projectId || accepted.graphId !== owner.graphId
      || projectData.value?.project_id !== owner.projectId || projectData.value?.graph_id !== owner.graphId
      || !validSimulationId(accepted.simulationId) || !['parallel', 'twitter', 'reddit'].includes(accepted.platform)) return
    owner.receipt = Object.freeze({ projectId: owner.projectId, graphId: owner.graphId,
      simulationId: accepted.simulationId, platform: accepted.platform })
    publishSimulationHandoff(owner)
    void openAcceptedSimulation(owner, owner.receipt)
  }
  publishSimulationHandoff(owner)
}

const suspendSimulation = to => {
  if (!simulationOwner) return
  simulationDeparture = { owner: simulationOwner, to: to.redirectedFrom || to }
  simulationOwner.active = false
  publishSimulationHandoff(simulationOwner)
}

const recoverSimulation = (to, committed) => {
  const departure = simulationDeparture
  if (!departure || departure.owner !== simulationOwner
    || (departure.to !== (to.redirectedFrom || to) && !(committed && router.currentRoute.value === to))) return
  const owner = simulationOwner
  if (route.name === 'Process' && currentProjectId.value === owner.projectId) {
    selectSimulationOwner(owner.projectId, owner.graphId, owner.receipt)
  } else if (committed) {
    owner.active = false
    simulationOwner = null
    simulationDeparture = null
    simulationHandoff.value = {}
  }
}

// Null/error recovery metadata cannot erase an acknowledged simulation. Valid
// replacement graph data does retire it, including graph A → B → A.
watch(projectData, project => {
  if (!simulationOwner || route.name !== 'Process' || currentProjectId.value !== simulationOwner.projectId
    || project?.project_id !== simulationOwner.projectId
    || !validSimulationId(project.graph_id) || project.graph_id === simulationOwner.graphId) return
  const active = simulationOwner.active
  const departure = simulationDeparture
  selectSimulationOwner(project.project_id, project.graph_id)
  if (!active) {
    simulationOwner.active = false
    simulationDeparture = departure ? { owner: simulationOwner, to: departure.to } : null
    publishSimulationHandoff(simulationOwner)
  }
}, { flush: 'sync' })

// Every route selection has its own identity, including A → B → A.
let viewContext = null
let projectAdoption = null
const ownsView = context => !!context && context.active && context === viewContext
  && route.name === 'Process' && context.id === currentProjectId.value

// A receipt binds a loaded source, not immutable response bytes. Every allowed
// period gets fresh callbacks; the detached JSON is made only on explicit click.
let loadedGraphReceipt = null, graphDownloadOwner = null, graphDownloadResource = null
let graphDownloadDeparture = null, loadedGraphRetained = false
const graphDownloadState = shallowRef({ enabled: false, action: undefined, status: '', error: '' })
const graphDownload = computed(() => ({
  ...graphDownloadState.value,
  status: graphDownloadState.value.status ? t(`graph.download.${graphDownloadState.value.status}`) : '',
  error: graphDownloadState.value.error ? t(`graph.download.${graphDownloadState.value.error}`) : '',
}))
const nonemptyGraphId = value => typeof value === 'string' && value.trim().length > 0
const ownsLoadedGraph = receipt => !!receipt && receipt === loadedGraphReceipt && ownsView(receipt.context)
  && !graphResult.value && projectData.value?.status === 'graph_completed'
  && nonemptyGraphId(receipt.context.id) && nonemptyGraphId(receipt.graphId)
  && projectData.value?.project_id === receipt.context.id
  && projectData.value?.graph_id === receipt.graphId && graphData.value === receipt.source
  && receipt.request.graphId === receipt.graphId
  && receipt.source !== null && typeof receipt.source === 'object'
  && Object.getOwnPropertyDescriptor(receipt.source, 'graph_id')?.value === receipt.graphId
const ownsGraphDownload = owner => !!owner && owner === graphDownloadOwner
  && !graphDownloadDeparture && !graphLoading.value && ownsLoadedGraph(owner.receipt)
  && owner.context === viewContext && owner.epoch === owner.context.graphRequest && !owner.epoch.pending

// A child owns one exact completed drawing. The parent owns all actions and
// resources, including synchronous retirement before child props are delivered.
let graphViewCapture = null, graphViewDownloadBinding = null, graphViewDownloadResource = null
const graphViewDownloadState = shallowRef({ enabled: false, action: undefined, status: '', error: '', retained: false })
const graphViewDownload = computed(() => ({
  ...graphViewDownloadState.value,
  status: [graphViewDownloadState.value.retained ? t('graph.viewDownload.retained') : '',
    graphViewDownloadState.value.status ? t(`graph.viewDownload.${graphViewDownloadState.value.status}`) : ''].filter(Boolean).join(' '),
  error: graphViewDownloadState.value.error ? t(`graph.viewDownload.${graphViewDownloadState.value.error}`) : '',
}))
const readyGraphViewCapture = capture => {
  try { return !!capture && typeof capture.isReady === 'function' && typeof capture.capture === 'function' && capture.isReady() === true }
  catch { return false }
}
const ownsGraphViewDownload = binding => !!binding && binding === graphViewDownloadBinding
  && binding.capture === graphViewCapture && ownsGraphDownload(binding.owner)
  && binding.capture.source === binding.owner.receipt.source

const releaseGraphViewDownload = (resource = graphViewDownloadResource) => {
  if (!resource) return
  if (graphViewDownloadResource === resource) graphViewDownloadResource = null
  const link = resource.link, url = resource.url
  resource.link = null; resource.url = null
  try { link?.remove() } catch { /* Still release only this SVG attempt's URL. */ }
  try { if (url) URL.revokeObjectURL(url) } catch { /* Reentry cannot release a newer attempt. */ }
}
const retireGraphViewDownload = (clearCapture = false) => {
  graphViewDownloadBinding = null
  graphViewDownloadState.value = { enabled: false, action: undefined, status: '', error: '', retained: false }
  if (clearCapture) graphViewCapture = null
  releaseGraphViewDownload()
}
const downloadGraphView = binding => {
  if (!ownsGraphViewDownload(binding)) return
  if (!readyGraphViewCapture(binding.capture)) {
    if (ownsGraphViewDownload(binding)) graphViewDownloadState.value = { ...graphViewDownloadState.value, error: 'invalid' }
    return
  }
  const previous = graphViewDownloadResource, resource = { url: null, link: null }
  graphViewDownloadResource = resource
  releaseGraphViewDownload(previous)
  const owns = () => graphViewDownloadResource === resource && ownsGraphViewDownload(binding)
  const ready = () => {
    if (!owns()) return false
    if (!readyGraphViewCapture(binding.capture)) throw Object.assign(new Error('Unavailable graph frame'), { code: 'invalid' })
    return owns()
  }
  try {
    if (!ready()) return
    graphViewDownloadState.value = { ...graphViewDownloadState.value, status: '', error: '' }
    const body = binding.capture.capture()
    if (!ready()) return
    if (typeof body !== 'string' || !body) throw Object.assign(new Error('Invalid graph view'), { code: 'invalid' })
    if (body.length > MAX_GRAPH_VIEW_SVG_BYTES || new TextEncoder().encode(body).byteLength > MAX_GRAPH_VIEW_SVG_BYTES) {
      throw Object.assign(new Error('Graph view exceeds the byte limit'), { code: 'too_large' })
    }
    if (!ready()) return
    const blob = new Blob([body], { type: 'image/svg+xml;charset=utf-8' })
    if (!ready()) return
    resource.url = URL.createObjectURL(blob)
    if (!ready()) return
    resource.link = document.createElement('a')
    if (!ready()) return
    resource.link.href = resource.url
    if (!ready()) return
    resource.link.download = 'mirofish-graph-view.svg'
    if (!ready()) return
    document.body.appendChild(resource.link)
    if (!ready()) return
    resource.link.click()
    if (!ready()) return
    const link = resource.link; resource.link = null; link.remove()
    if (!ready()) return
    graphViewDownloadState.value = { ...graphViewDownloadState.value, status: 'started' }
  } catch (cause) {
    if (owns()) graphViewDownloadState.value = { ...graphViewDownloadState.value,
      error: cause?.code === 'too_large' ? 'tooLarge' : cause?.code === 'invalid' ? 'invalid' : 'failed' }
    releaseGraphViewDownload(resource)
  } finally {
    if (!owns()) releaseGraphViewDownload(resource)
  }
}
const publishGraphViewDownload = () => {
  const owner = graphDownloadOwner, capture = graphViewCapture
  if (!ownsGraphDownload(owner) || capture?.source !== owner.receipt.source || !readyGraphViewCapture(capture)) return
  if (graphViewDownloadBinding?.owner === owner && graphViewDownloadBinding.capture === capture) return
  retireGraphViewDownload()
  if (capture !== graphViewCapture || !ownsGraphDownload(owner) || !readyGraphViewCapture(capture)) return
  const binding = { owner, capture }
  graphViewDownloadBinding = binding
  graphViewDownloadState.value = { enabled: true, action: () => downloadGraphView(binding),
    status: '', error: '', retained: loadedGraphRetained }
}
const acceptGraphViewCapture = capture => {
  // Keep a matching new drawing during a refresh or reused-route suspension;
  // eligibility recovery will bind it to a fresh settled parent action owner.
  if (!ownsLoadedGraph(loadedGraphReceipt) || capture?.source !== loadedGraphReceipt.source || !readyGraphViewCapture(capture)) return
  if (graphViewCapture !== capture) {
    graphViewCapture = capture
    retireGraphViewDownload()
  }
  if (graphViewCapture === capture) publishGraphViewDownload()
}
const retireGraphViewCapture = capture => {
  if (graphViewCapture !== capture) return
  graphViewCapture = null
  retireGraphViewDownload()
}

const releaseGraphDownload = (resource = graphDownloadResource) => {
  if (!resource) return
  if (graphDownloadResource === resource) graphDownloadResource = null
  const link = resource.link, url = resource.url
  resource.link = null; resource.url = null
  try { link?.remove() } catch { /* Still release only this attempt's URL. */ }
  try { if (url) URL.revokeObjectURL(url) } catch { /* Cleanup cannot disturb a newer attempt. */ }
}
const retireGraphDownload = (clearSource = false) => {
  graphDownloadOwner = null
  graphDownloadState.value = { enabled: false, action: undefined, status: '', error: '' }
  if (clearSource) { loadedGraphReceipt = null; loadedGraphRetained = false }
  retireGraphViewDownload(clearSource)
  releaseGraphDownload()
}
const downloadLoadedGraph = owner => {
  if (!ownsGraphDownload(owner)) return
  const previous = graphDownloadResource, resource = { url: null, link: null }
  graphDownloadResource = resource
  releaseGraphDownload(previous)
  const owns = () => graphDownloadResource === resource && ownsGraphDownload(owner)
  try {
    if (!owns()) return
    graphDownloadState.value = { ...graphDownloadState.value, error: '' }
    const body = createLoadedGraphFile(owner.receipt.source, {
      projectId: owner.context.id, graphId: owner.receipt.graphId, downloadedAt: new Date().toISOString(),
    })
    if (!owns()) return
    const blob = new Blob([body], { type: 'application/json;charset=utf-8' })
    if (!owns()) return
    resource.url = URL.createObjectURL(blob)
    if (!owns()) return
    resource.link = document.createElement('a')
    if (!owns()) return
    resource.link.href = resource.url
    if (!owns()) return
    resource.link.download = 'mirofish-loaded-graph.json'
    if (!owns()) return
    document.body.appendChild(resource.link)
    if (!owns()) return
    resource.link.click()
    if (!owns()) return
    const link = resource.link; resource.link = null; link.remove()
    if (!owns()) return
    graphDownloadState.value = { ...graphDownloadState.value, status: loadedGraphRetained ? 'retained' : 'started' }
  } catch (cause) {
    if (owns()) graphDownloadState.value = { ...graphDownloadState.value,
      error: cause?.code === 'too_large' ? 'tooLarge' : cause?.code === 'invalid' ? 'invalid' : 'failed' }
    releaseGraphDownload(resource)
  } finally {
    if (!owns()) releaseGraphDownload(resource)
  }
}
const publishGraphDownload = () => {
  // The source may predate a failed refresh; actions belong to its latest
  // settled read epoch, never the request that originally supplied the source.
  if (graphDownloadDeparture || graphLoading.value || !ownsLoadedGraph(loadedGraphReceipt)
    || viewContext.graphRequest?.pending) return
  const owner = { context: viewContext, receipt: loadedGraphReceipt, epoch: viewContext.graphRequest }
  graphDownloadOwner = owner
  graphDownloadState.value = { enabled: true, action: () => downloadLoadedGraph(owner),
    status: loadedGraphRetained ? 'retained' : '', error: '' }
  publishGraphViewDownload()
}
const suspendGraphDownload = to => {
  graphDownloadDeparture = { to: to.redirectedFrom || to }
  retireGraphDownload()
}
const recoverGraphDownload = (to, committed) => {
  const departure = graphDownloadDeparture
  if (!departure || (departure.to !== (to.redirectedFrom || to)
    && !(committed && router.currentRoute.value === to))) return
  graphDownloadDeparture = null
  publishGraphDownload()
}
// Only outer/source and binding changes retire ownership. Valid nested edits
// remain current values for the next click; there is no deep mutation watcher.
watch([graphData, () => projectData.value?.project_id, () => projectData.value?.graph_id,
  () => projectData.value?.status, graphResult], () => retireGraphDownload(true), { flush: 'sync' })

const resetProjectState = () => {
  retireGraphDownload(true)
  currentStep.value = 1
  loading.value = false
  graphLoading.value = false
  error.value = ''
  projectData.value = null
  graphData.value = null
  currentPhase.value = -1
  ontologyProgress.value = null
  buildProgress.value = null
  graphResult.value = null
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
  if (graphResult.value) return t(graphResult.value.loading ? 'step1.loadingGraphResult' : 'step1.graphResultNeedsRetry')
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
        // Active builds can already have a graph ID. Reconcile the current
        // project before choosing its task observer or completed graph.
        const projectRes = await getProject(context.id, context.controller.signal)
        if (!ownsView(context)) return
        if (!projectRes.success) throw new Error(projectRes.error || 'Failed to load project')
        const project = projectRes.data
        projectData.value = project
        if (project?.status === 'graph_completed' && project.graph_id) {
          currentPhase.value = 2
          buildProgress.value = null
          await loadGraph(project.graph_id, context)
        } else if (project?.status === 'graph_building' && project.graph_build_task_id) {
          startPollingTask(project.graph_build_task_id, context)
        } else {
          throw new Error(project?.error || (project?.status === 'failed'
            ? 'Project failed'
            : 'Unable to resume graph build. Reload the project to check its current state.'))
        }
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
        // A terminal task is not proof that its saved project can be loaded.
        // Keep setup gated even if the building project already had a graph ID.
        graphResult.value = { loading: true, retry: () => loadCompletedGraphResult(task, context) }
        await loadCompletedGraphResult(task, context)
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

const loadCompletedGraphResult = async (task, context) => {
  const ownsResult = () => ownsView(context) && context.task === task && task.terminal
  if (!ownsResult() || task.resultInFlight || task.resultAccepted) return
  task.resultInFlight = true
  graphResult.value.loading = true
  error.value = ''
  try {
    // Recovery is a read of this saved project, never another build request.
    const res = await getProject(context.id, context.controller.signal)
    if (!ownsResult()) return
    const project = res?.data
    if (!res?.success || project?.project_id !== context.id || project.status !== 'graph_completed'
      || typeof project.graph_id !== 'string' || !project.graph_id.trim()) {
      throw new Error(res?.error || 'Completed graph result is unavailable for this project.')
    }
    task.resultAccepted = true
    projectData.value = project
    graphResult.value = null
    currentPhase.value = 2
    // A valid saved result permits setup while the preview loads independently.
    await loadGraph(project.graph_id, context)
  } catch (err) {
    if (!ownsResult()) return
    graphResult.value.loading = false
    error.value = t('step1.graphResultUnavailable')
    addLog(`Unable to load completed graph result: ${err.message}`, context)
  } finally {
    if (ownsResult()) task.resultInFlight = false
  }
}

const loadGraph = async (graphId, context) => {
  if (!ownsView(context)) return
  context.graphRequest?.controller.abort()
  const request = { controller: new AbortController(), graphId, pending: true }
  context.graphRequest = request
  retireGraphDownload()
  const ownsRequest = () => ownsView(context) && context.graphRequest === request
  graphLoading.value = true
  addLog(`Loading full graph data: ${graphId}`, context)
  let failed = true
  try {
    const res = await getGraphData(graphId, request.controller.signal)
    if (!ownsRequest()) return
    if (res.success) {
      graphData.value = res.data
      failed = false
      const receipt = Object.freeze({ context, request, graphId, source: graphData.value })
      loadedGraphRetained = false
      loadedGraphReceipt = receipt
      if (!ownsLoadedGraph(receipt) || !hasLoadedGraphShape(receipt.source, graphId)) {
        loadedGraphReceipt = null
        graphDownloadState.value = { ...graphDownloadState.value, error: 'invalid' }
      }
      addLog('Graph data loaded successfully.', context)
    } else {
      addLog(`Failed to load graph data: ${res.error}`, context)
    }
  } catch (err) {
    if (ownsRequest()) addLog(`Exception loading graph: ${err.message}`, context)
  } finally {
    if (ownsRequest()) {
      request.pending = false
      graphLoading.value = false
      if (failed && ownsLoadedGraph(loadedGraphReceipt)) {
        loadedGraphRetained = true
      }
      publishGraphDownload()
    }
  }
}

const refreshGraph = () => {
  const context = viewContext
  if (ownsView(context) && !graphResult.value && projectData.value?.graph_id) {
    addLog('Manual graph refresh triggered.', context)
    loadGraph(projectData.value.graph_id, context)
  }
}

const selectProject = (id, recovering = false) => {
  const retained = recovering && simulationOwner?.projectId === id ? simulationOwner : null
  const adoption = !recovering && projectAdoption?.context === viewContext && viewContext?.active
    && projectAdoption.id === id ? projectAdoption : null
  retireView()
  projectAdoption = null
  viewContext = null
  resetProjectState()
  selectSimulationOwner(id, retained?.graphId, retained?.receipt)
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
  suspendGraphDownload(to)
  suspendSimulation(to)
  if (viewContext) viewContext.departure = to.redirectedFrom || to
  retireView()
})
// Reused Process updates retire only simulation actions. Graph observation
// still follows its existing route-selection lifecycle. Global beforeEach runs
// before this hook, so a fresh click before this hook is new navigation intent.
onBeforeRouteUpdate(to => {
  suspendGraphDownload(to)
  suspendSimulation(to)
  // If an earlier leave already retired observation, this newer update now
  // owns its recovery too. Do not retire otherwise-current graph observation.
  if (viewContext && !viewContext.active) viewContext.departure = to.redirectedFrom || to
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
// Reused-route navigation can wait in a global guard before its update hook.
// This observer suspends exports only; existing reads/build/handoff stay owned.
const removeGraphDownloadNavigation = router.beforeEach((to, from) => {
  if (from.name === 'Process') suspendGraphDownload(to)
})
const removeRouteRecovery = router.afterEach((to, _from, failure) => {
  recoverSelectedProject(to, !failure)
  recoverSimulation(to, !failure)
  recoverGraphDownload(to, !failure)
})
const removeRouteErrorRecovery = router.onError((err, to) => {
  recoverSelectedProject(to)
  recoverSimulation(to, false)
  recoverGraphDownload(to, false)
  console.error(err)
})
onBeforeUnmount(() => {
  if (simulationOwner) simulationOwner.active = false
  simulationOwner = null
  simulationDeparture = null
  simulationHandoff.value = {}
  removeGraphDownloadNavigation()
  graphDownloadDeparture = null
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
