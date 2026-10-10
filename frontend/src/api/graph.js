import service from './index'

/**
 * 生成本体（上传文档和模拟需求）
 * @param {Object} data - 包含files, simulation_requirement, project_name等
 * @param {AbortSignal} [signal] - Optional view observation cancellation
 * @returns {Promise}
 */
export function generateOntology(formData, signal) {
  return service({
    url: '/api/graph/ontology/generate',
    method: 'post',
    data: formData,
    signal,
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  })
}

/**
 * 构建图谱
 * @param {Object} data - 包含project_id, graph_name等
 * @param {AbortSignal} [signal] - Optional view observation cancellation
 * @returns {Promise}
 */
export function buildGraph(data, signal) {
  return service({
    url: '/api/graph/build',
    method: 'post',
    data,
    signal
  })
}

/**
 * 查询任务状态
 * @param {String} taskId - 任务ID
 * @param {AbortSignal} [signal] - Optional view observation cancellation
 * @returns {Promise}
 */
export function getTaskStatus(taskId, signal) {
  return service({
    url: `/api/graph/task/${taskId}`,
    method: 'get',
    signal
  })
}

/**
 * 获取图谱数据
 * @param {String} graphId - 图谱ID
 * @param {AbortSignal} [signal] - Optional view cancellation
 * @returns {Promise}
 */
export function getGraphData(graphId, signal) {
  return service({
    url: `/api/graph/data/${graphId}`,
    method: 'get',
    signal
  })
}

/**
 * 获取项目信息
 * @param {String} projectId - 项目ID
 * @param {AbortSignal} [signal] - Optional view cancellation
 * @returns {Promise}
 */
export function getProject(projectId, signal) {
  return service({
    url: `/api/graph/project/${projectId}`,
    method: 'get',
    signal
  })
}
