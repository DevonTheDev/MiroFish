import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountRuntime, runtimeSnapshot, ok } from './runtime-view-fixture.js'

export const stepIds = ['configuration', 'dependencies', 'database', 'gateway', 'json_output', 'json_schema', 'tool_call', 'embedding', 'cleanup']
export const runId = '12345678-1234-4234-9234-123456789abc'
export const nextRunId = '12345678-1234-4234-9234-123456789abd'
export function readinessSnapshot(state = null, overrides = {}) {
  const active = ['running', 'stopping'].includes(state)
  return {
    schema_version: 1, kind: 'mirofish_local_readiness', observed_at: '2026-10-03T13:00:00Z',
    mode: 'local', available: true, unavailable_code: null,
    run: state === null ? null : {
      id: runId, state, started_at: '2026-10-03T12:59:59Z', finished_at: active ? null : '2026-10-03T13:00:00Z',
      elapsed_ms: 1000, current_step: active ? 'database' : null, cancel_requested: state === 'stopping' || state === 'cancelled',
      budget: { overall_ms: 300000, model_step_ms: 60000, database_step_ms: 10000, gateway_step_ms: 5000, cleanup_ms: 10000 },
      configuration: { chat_model: 'local-chat', embedding_model: 'local-embedding', embedding_dimensions: 768 },
      steps: stepIds.map((id, i) => ({ id, state: active ? i < 2 ? 'passed' : i === 2 ? 'running' : 'pending' : 'passed', code: active && i >= 2 ? null : 'ok', duration_ms: active && i >= 2 ? null : 100 })),
    }, ...overrides,
  }
}
export function readinessApi(service) {
  const source = readFileSync(new URL('../../src/api/runtime.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
  return new Function('service', source + '\nreturn { getRuntimeStatus, acceptRuntimeSnapshot, getLocalReadiness: typeof getLocalReadiness === "function" ? getLocalReadiness : undefined, startLocalReadiness: typeof startLocalReadiness === "function" ? startLocalReadiness : undefined, cancelLocalReadiness: typeof cancelLocalReadiness === "function" ? cancelLocalReadiness : undefined, acceptReadinessSnapshot: typeof acceptReadinessSnapshot === "function" ? acceptReadinessSnapshot : undefined, readinessStepIds: typeof readinessStepIds !== "undefined" ? readinessStepIds : [] };')(service)
}
export function deferredReadiness() {
  const calls = { getLocalReadiness: [], startLocalReadiness: [], cancelLocalReadiness: [] }
  const api = Object.fromEntries(Object.keys(calls).map(name => [name, (...args) => new Promise((resolve, reject) => {
    calls[name].push({ args, signal: args.at(-1), resolve, reject })
  })]))
  return { calls, api }
}
export async function mountReadiness(options = {}) {
  const requests = deferredReadiness()
  const view = await mountRuntime({ includeReadiness: true, ...options,
    api: { ...readinessApi(), getRuntimeStatus: async () => ok(runtimeSnapshot()), ...requests.api, ...options.api } })
  return { ...view, readiness: requests.calls }
}
export function productionClient(baseURL) {
  const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment').replace('export default service', 'return service')
  const client = new Function('axios', 'i18n', 'buildEnvironment', 'console', index)(axios,
    { global: { locale: { value: 'en' } } }, { VITE_API_BASE_URL: baseURL }, { error() {} })
  client.defaults.proxy = false; client.defaults.maxRedirects = 0
  return client
}
