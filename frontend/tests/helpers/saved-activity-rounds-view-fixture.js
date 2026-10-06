import { mountSavedActivity, deferredApi, flush, ok } from './saved-activity-view-fixture.js'
export { mountSavedActivity, deferredApi, flush, ok }
export const revision = 'a'.repeat(64), newRevision = 'b'.repeat(64)
export const round = (round_num = '0', overrides = {}) => ({ round_num, count: 3, outcomes: { success: 1, failed: 1, unknown: 1 }, drilldown_supported: round_num.length <= 64, ...overrides })
export const overview = (overrides = {}) => ({ simulation_id: 'sim_A', source_revision: revision, observed_at: '2026-10-06T09:00:00Z', context: { status: 'completed', created_at: '2026-10-01T09:00:00Z', updated_at: null, started_at: null, completed_at: null, requested_rounds: '20', last_saved_round: '0' }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'unavailable' }, warnings: [], filters: { platform: null, round_from: null, round_to: null }, order: 'round_ascending', matched_count: 3, round_count: 1, outcomes: { success: 1, failed: 1, unknown: 1 }, rounds: [round()], ...overrides })
export function overviewRows(rows, overrides = {}) {
  const outcomes = { success: 0, failed: 0, unknown: 0 }
  for (const row of rows) for (const key of Object.keys(outcomes)) outcomes[key] += row.outcomes[key]
  return overview({ rounds: rows, round_count: rows.length, matched_count: rows.reduce((total, row) => total + row.count, 0), outcomes, ...overrides })
}
export async function setup(t, initialPath = '/simulation/sim_A/activity/rounds', locale = 'en') {
  const d = deferredApi(), h = await mountSavedActivity({ api: d.api, initialPath, locale })
  t.after(() => h.unmount()); return { ...d, h }
}
export async function resolve(call, data = overview()) { call.resolve(ok(data)); await flush() }
