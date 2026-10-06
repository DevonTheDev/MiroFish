import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Process from '../views/MainView.vue'
import SimulationView from '../views/SimulationView.vue'
import SimulationRunView from '../views/SimulationRunView.vue'
import ReportView from '../views/ReportView.vue'
import InteractionView from '../views/InteractionView.vue'
import SavedActivityView from '../views/SavedActivityView.vue'
import SavedActivityRoundsView from '../views/SavedActivityRoundsView.vue'
import SimulationComparisonView from '../views/SimulationComparisonView.vue'
import RuntimeStatusView from '../views/RuntimeStatusView.vue'
import PromptTrialsView from '../views/PromptTrialsView.vue'
import PromptSuitesView from '../views/PromptSuitesView.vue'
import PromptSuiteComparisonView from '../views/PromptSuiteComparisonView.vue'
import PromptExamplesView from '../views/PromptExamplesView.vue'
import SavedReportsView from '../views/SavedReportsView.vue'

import RunCapturesView from '../views/RunCapturesView.vue'

const routes = [
  {
    path: '/simulation/:simulationId/activity/rounds',
    name: 'SavedActivityRounds',
    component: SavedActivityRoundsView
  },
  {
    path: '/prompt-examples',
    name: 'PromptExamples',
    component: PromptExamplesView
  },
  {
    path: '/prompt-suite-comparison',
    name: 'PromptSuiteComparison',
    component: PromptSuiteComparisonView
  },
  {
    path: '/prompt-suites',
    name: 'PromptSuites',
    component: PromptSuitesView
  },
  {
    path: '/prompt-trials',
    name: 'PromptTrials',
    component: PromptTrialsView
  },
  {
    path: '/captures',
    name: 'RunCaptures',
    component: RunCapturesView
  },
  {
    path: '/reports',
    name: 'SavedReports',
    component: SavedReportsView
  },
  {
    path: '/runtime',
    name: 'RuntimeStatus',
    component: RuntimeStatusView
  },
  {
    path: '/simulation/:simulationId/activity',
    name: 'SavedActivity',
    component: SavedActivityView
  },
  {
    path: '/compare',
    name: 'SimulationComparison',
    component: SimulationComparisonView
  },
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/process/:projectId',
    name: 'Process',
    component: Process,
    props: true
  },
  {
    path: '/simulation/:simulationId',
    name: 'Simulation',
    component: SimulationView,
    props: true
  },
  {
    path: '/simulation/:simulationId/start',
    name: 'SimulationRun',
    component: SimulationRunView,
    props: true
  },
  {
    path: '/report/:reportId',
    name: 'Report',
    component: ReportView,
    props: true
  },
  {
    path: '/interaction/:reportId',
    name: 'Interaction',
    component: InteractionView,
    props: true
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
