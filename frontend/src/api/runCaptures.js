import service from './index'

// Capture writes are explicit, single requests. Never retry a mutation here.
export const previewRunCapture = (simulationId, signal) => service.get('/api/run-captures/preview', { params: { simulation_id: simulationId }, signal })
export const getRunCaptures = ({ offset = 0, limit = 20 } = {}, signal) => service.get('/api/run-captures/records', { params: { offset, limit }, signal })
export const getRunCapture = (captureId, signal) => service.get(`/api/run-captures/records/${encodeURIComponent(captureId)}`, { signal })
export const saveRunCapture = (captureId, { simulation_id, source_revision, label, note }, signal) => service.post(`/api/run-captures/records/${encodeURIComponent(captureId)}`, { simulation_id, source_revision, label, note }, { signal })
export const compareRunCaptures = (left, right, signal) => service.get('/api/run-captures/compare', { params: { left, right }, signal })

// Explicit SQLite rollback recovery only; no mutation retry or new captures.
export const recoverRunCaptureStore = signal => service.post('/api/run-captures/recover', {}, { signal })
