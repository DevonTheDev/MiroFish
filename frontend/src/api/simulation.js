import service from './index'

/**
 * 创建模拟
 * @param {Object} data - { project_id, graph_id?, enable_twitter?, enable_reddit? }
 */
// Abort cancels HTTP observation only; it does not delete a created simulation.
export const createSimulation = (data, signal) => {
  return service.post('/api/simulation/create', data, { signal })
}

/**
 * 准备模拟环境（异步任务）
 * @param {Object} data - { simulation_id, entity_types?, use_llm_for_profiles?, parallel_profile_count?, force_regenerate? }
 * @param {AbortSignal} [signal] - Cancel HTTP observation, not backend preparation
 */
export const prepareSimulation = (data, signal) => {
  return service.post('/api/simulation/prepare', data, { signal })
}

// An explicit mutation of this exact preparation task. Never automatically retry.
// Aborting the HTTP request only stops observation of the cancellation response.
export const cancelPreparation = (data, signal) => {
  return service.post('/api/simulation/prepare/cancel', data, { signal })
}

// Passive observation never initializes graph memory or starts preparation.
export const getPreparationPlan = (simulationId, signal) => {
  return service.get(`/api/simulation/${encodeURIComponent(simulationId)}/prepare/plan`, { signal })
}

// Explicitly connects to graph memory and loads the eligible cast.
export const previewPreparation = (data, signal) => {
  return service.post('/api/simulation/prepare/preview', data, { signal })
}

/**
 * 查询准备任务进度
 * @param {Object} data - { task_id?, simulation_id? }
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getPrepareStatus = (data, signal) => {
  return service.post('/api/simulation/prepare/status', data, { signal })
}

/**
 * 获取模拟状态
 * @param {string} simulationId
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getSimulation = (simulationId, signal) => {
  return service.get(`/api/simulation/${simulationId}`, { signal })
}

/**
 * 获取模拟的 Agent Profiles
 * @param {string} simulationId
 * @param {string} [platform] - 'reddit' | 'twitter'（省略时由后端根据模拟配置自动选择）
 */
export const getSimulationProfiles = (simulationId, platform) => {
  const params = platform ? { platform } : {}
  return service.get(`/api/simulation/${simulationId}/profiles`, { params })
}

/**
 * 实时获取生成中的 Agent Profiles
 * @param {string} simulationId
 * @param {string} [platform] - 'reddit' | 'twitter'（省略时由后端根据模拟配置自动选择）
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getSimulationProfilesRealtime = (simulationId, platform, signal) => {
  const params = platform ? { platform } : {}
  return service.get(`/api/simulation/${simulationId}/profiles/realtime`, { params, signal })
}

/**
 * 获取模拟配置
 * @param {string} simulationId
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getSimulationConfig = (simulationId, signal) => {
  return service.get(`/api/simulation/${simulationId}/config`, { signal })
}

/**
 * 实时获取生成中的模拟配置
 * @param {string} simulationId
 * @param {AbortSignal} [signal] - Optional view cancellation
 * @returns {Promise} 返回配置信息，包含元数据和配置内容
 */
export const getSimulationConfigRealtime = (simulationId, signal) => {
  return service.get(`/api/simulation/${simulationId}/config/realtime`, { signal })
}

/**
 * 列出所有模拟
 * @param {string} projectId - 可选，按项目ID过滤
 */
export const listSimulations = (projectId) => {
  const params = projectId ? { project_id: projectId } : {}
  return service.get('/api/simulation/list', { params })
}

/**
 * 启动模拟
 * @param {Object} data - { simulation_id, platform?, max_rounds?, enable_graph_memory_update? }
 * @param {AbortSignal} [signal] - Cancel HTTP observation, not backend work
 */
export const startSimulation = (data, signal) => {
  return service.post('/api/simulation/start', data, { signal })
}

/**
 * 停止模拟
 * @param {Object} data - { simulation_id }
 * @param {AbortSignal} [signal] - Cancel HTTP observation, not backend work
 */
export const stopSimulation = (data, signal) => {
  return service.post('/api/simulation/stop', data, { signal })
}

/**
 * 获取模拟运行实时状态
 * @param {string} simulationId
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getRunStatus = (simulationId, signal) => {
  return service.get(`/api/simulation/${simulationId}/run-status`, { signal })
}

/**
 * 获取模拟运行详细状态（包含最近动作）
 * @param {string} simulationId
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getRunStatusDetail = (simulationId, signal) => {
  return service.get(`/api/simulation/${simulationId}/run-status/detail`, { signal })
}

/**
 * 获取模拟中的帖子
 * @param {string} simulationId
 * @param {string} [platform] - 'reddit' | 'twitter'（省略时由后端根据模拟配置自动选择）
 * @param {number} limit - 返回数量
 * @param {number} offset - 偏移量
 */
export const getSimulationPosts = (simulationId, platform, limit = 50, offset = 0) => {
  const params = { limit, offset }
  if (platform) params.platform = platform
  return service.get(`/api/simulation/${simulationId}/posts`, { params })
}

/**
 * 获取模拟时间线（按轮次汇总）
 * @param {string} simulationId
 * @param {number} startRound - 起始轮次
 * @param {number} endRound - 结束轮次
 */
export const getSimulationTimeline = (simulationId, startRound = 0, endRound = null) => {
  const params = { start_round: startRound }
  if (endRound !== null) {
    params.end_round = endRound
  }
  return service.get(`/api/simulation/${simulationId}/timeline`, { params })
}

/**
 * 获取Agent统计信息
 * @param {string} simulationId
 */
export const getAgentStats = (simulationId) => {
  return service.get(`/api/simulation/${simulationId}/agent-stats`)
}

/**
 * 获取模拟动作历史
 * @param {string} simulationId
 * @param {Object} params - { limit, offset, platform, agent_id, round_num }
 */
export const getSimulationActions = (simulationId, params = {}) => {
  return service.get(`/api/simulation/${simulationId}/actions`, { params })
}

/**
 * 关闭模拟环境（优雅退出）
 * @param {Object} data - { simulation_id, timeout? }
 * @param {AbortSignal} [signal] - Cancel HTTP observation, not backend shutdown
 */
export const closeSimulationEnv = (data, signal) => {
  return service.post('/api/simulation/close-env', data, { signal })
}

/**
 * 获取模拟环境状态
 * @param {Object} data - { simulation_id }
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getEnvStatus = (data, signal) => {
  return service.post('/api/simulation/env-status', data, { signal })
}

/**
 * 批量采访 Agent
 * @param {Object} data - { simulation_id, interviews: [{ agent_id, prompt }] }
 * @param {AbortSignal} [signal] - Cancels the HTTP request, not server inference
 */
export const interviewAgents = (data, signal) => {
  return service.post('/api/simulation/interview/batch', data, { signal })
}

/**
 * 获取历史模拟列表（带项目详情）
 * 用于首页历史项目展示
 * @param {number} limit - 返回数量限制
 */
export const getSimulationHistory = (limit = 20) => {
  return service.get('/api/simulation/history', { params: { limit } })
}

/** List saved simulation metadata without starting or modifying a run. */
export const getComparisonCandidates = (signal) => {
  return service.get('/api/simulation/comparison/candidates', { signal })
}

/** Compare each simulation's latest saved run; differences are right minus left. */
export const compareSavedSimulations = (left, right, signal) => {
  return service.get('/api/simulation/comparison', { params: { left, right }, signal })
}

/** Read one page of the latest saved activity; abort cancels HTTP observation only. */
export const getSavedActivity = (simulationId, params = {}, signal) => {
  const allowed = ['platform', 'agent_id', 'round_num', 'action_type', 'q', 'case_sensitive', 'outcome', 'offset', 'limit', 'revision']
  const query = Object.fromEntries(allowed.filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]]))
  return service.get(`/api/simulation/${encodeURIComponent(simulationId)}/saved-actions`, { params: query, signal })
}
