import { mountSavedActivity, deferredApi, flush, ok } from './saved-activity-view-fixture.js'
export { flush, ok }
export const revision = 'a'.repeat(64), newRevision = 'b'.repeat(64)
export const pair = (agent_id = '0', platform = 'twitter', changes = {}) => ({ platform, agent_id, count: 3, outcomes: { success: 1, failed: 1, unknown: 1 }, drilldown_supported: typeof agent_id === 'string' && agent_id.length <= 64, ...changes })
export const overview = (changes = {}) => ({ simulation_id: 'sim_A', source_revision: revision, observed_at: '2026-10-17T12:00:00Z', context: { status: 'completed', created_at: '2026-10-01T09:00:00Z', updated_at: null, started_at: null, completed_at: null, requested_rounds: '20', last_saved_round: '0' }, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'complete' }, warnings: [], filters: { platform: null }, order: 'failed_desc_total_desc_platform_agent', matched_count: 3, pair_count: 1, outcomes: { success: 1, failed: 1, unknown: 1 }, agents: [pair()], ...changes })
export function overviewRows(agents, changes = {}) {
  const outcomes = { success: 0, failed: 0, unknown: 0 }
  for (const row of agents) for (const name of Object.keys(outcomes)) outcomes[name] += row.outcomes[name]
  return overview({ agents, pair_count: agents.length, matched_count: agents.reduce((count, row) => count + row.count, 0), outcomes, ...changes })
}
export function records(changes = {}) {
  return { simulation_id: 'sim_A', source_revision: revision, observed_at: 'now', context: overview().context, availability: 'complete', platform_availability: overview().platform_availability, warnings: [], filters: { platform: null, agent_id: null, round_num: null, action_type: null, q: null, case_sensitive: false, outcome: null }, order: 'source_record', offset: 0, limit: 50, returned_count: 0, matched_count: 0, has_more: false, actions: [], ...changes }
}
export async function setup(t, initialPath = '/simulation/sim_A/activity/agents', locale = 'en') {
  const d = deferredApi(), h = await mountSavedActivity({ api: d.api, initialPath, locale })
  t.after(() => h.unmount()); return { ...d, h }
}
export async function resolve(call, data = overview()) { call.resolve(ok(data)); await flush() }
