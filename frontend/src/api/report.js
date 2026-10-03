import service from './index'

/** Browse saved metadata without starting generation or observing runtime. */
export const getSavedReports = (params = {}, signal) => {
  const query = Object.fromEntries(['q', 'status', 'offset', 'limit', 'revision']
    .filter(key => params[key] !== undefined).map(key => [key, params[key]]))
  return service.get('/api/report/library/records', { params: query, signal })
}

/** Capture saved Markdown; revision belongs to this report's metadata. */
export const getSavedReport = (reportId, params = {}, signal) => {
  return service.get(`/api/report/library/records/${encodeURIComponent(reportId)}`, {
    params: params.revision === undefined ? {} : { revision: params.revision }, signal,
  })
}

/**
 * 开始报告生成
 * @param {Object} data - { simulation_id, force_regenerate? }
 * @param {AbortSignal} [signal] - Cancel HTTP observation, not report generation
 */
export const generateReport = (data, signal) => {
  return service.post('/api/report/generate', data, { signal })
}

/**
 * 获取报告生成状态
 * @param {string} reportId
 */
export const getReportStatus = (reportId) => {
  return service.get(`/api/report/generate/status`, { params: { report_id: reportId } })
}

/**
 * 获取 Agent 日志（增量）
 * @param {string} reportId
 * @param {number} fromLine - 从第几行开始获取
 * @param {AbortSignal} [signal] - Optional cancellation for a closed/replaced view
 */
export const getAgentLog = (reportId, fromLine = 0, signal) => {
  return service.get(`/api/report/${reportId}/agent-log`, { params: { from_line: fromLine }, signal })
}

/**
 * 获取控制台日志（增量）
 * @param {string} reportId
 * @param {number} fromLine - 从第几行开始获取
 * @param {AbortSignal} [signal] - Optional cancellation for a closed/replaced view
 */
export const getConsoleLog = (reportId, fromLine = 0, signal) => {
  return service.get(`/api/report/${reportId}/console-log`, { params: { from_line: fromLine }, signal })
}

/**
 * 获取报告详情
 * @param {string} reportId
 * @param {AbortSignal} [signal] - Optional view cancellation
 */
export const getReport = (reportId, signal) => {
  return service.get(`/api/report/${reportId}`, { signal })
}

/**
 * 与 Report Agent 对话
 * @param {Object} data - { simulation_id, message, chat_history? }
 * @param {AbortSignal} [signal] - Cancels the HTTP request, not server inference
 */
export const chatWithReport = (data, signal) => {
  return service.post('/api/report/chat', data, { signal })
}
