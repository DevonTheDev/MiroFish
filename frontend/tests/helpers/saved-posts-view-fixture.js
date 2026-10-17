// Prepared only: the future finite gate compiles real Vue scripts/templates,
// mounts through the production router, and substitutes deferred GET APIs.
import assert from 'node:assert/strict'
import { mountSavedActivity, flush, ok } from './saved-activity-view-fixture.js'
export { flush, ok }
export const path = '/simulation/sim_A/posts'
export const maxId = '9223372036854775807'
export const event = () => ({ preventDefault() {}, stopPropagation() {} })
export const post = (post_id = '1', changes = {}) => ({ post_id, user_id: '0', original_post_id: null, content: 'saved post text', quote_content: null, created_at: 'raw saved time', ...changes })
export const comment = (comment_id = '1', post_id = '1', changes = {}) => ({ comment_id, post_id, user_id: '0', content: 'saved comment', created_at: null, ...changes })
export function page(rows = [post()], changes = {}) {
  const offset = changes.offset ?? 0
  return { state: rows.length ? 'available' : offset ? 'out_of_range' : 'empty', reason: null, offset, limit: 25, count: rows.length, has_more: false, rows, ...changes }
}
export const unavailable = (reason, changes = {}) => page([], { state: 'unavailable', reason, count: null, has_more: null, ...changes })
export const metadata = (changes = {}) => ({ state: 'available', reason: null, status: 'completed', partial: false, warning: null, ...changes })
export function list(changes = {}) {
  return { simulation_id: 'sim_A', platform: 'twitter', post_id: null, observed_at: '2026-10-17T12:00:00+00:00', metadata: metadata(), database: { state: 'available', reason: null }, posts: page(), post: null, comments: null, ...changes }
}
export function detail(post_id = '1', changes = {}) {
  return list({ post_id, posts: null, post: { state: 'available', reason: null, row: post(post_id) }, comments: page([comment('1', post_id)]), ...changes })
}
export const fullPage = (offset = 0, changes = {}) => page(Array.from({ length: 25 }, (_, index) => post(String(1000000 - offset - index))), { offset, has_more: true, ...changes })
export const catalog = () => ({ candidates: [{ simulation_id: 'sim_A', project_id: 'project_A', scenario: 'Saved fixture', status: 'completed', created_at: null, updated_at: null }], skipped_records: 0 })
export async function resolve(call, data) { assert.ok(call, 'missing allocated API call'); call.resolve(ok(data)); await flush() }
export async function reject(call, code = 'posts_unavailable') { assert.ok(call, 'missing allocated API call'); call.reject({ response: { data: { success: false, error_code: code, error: 'Safe refusal.' } } }); await flush() }
export async function setup(t, initialPath = path + '?platform=twitter', locale = 'en', expected = { list: 1 }) {
  const names = ['getSavedPosts', 'getSavedPost', 'getComparisonCandidates', 'getSavedActivity', 'getSavedActivityRounds', 'getSavedActivityAgents', 'getSimulationHistory', 'getSavedActionsExport']
  const calls = Object.fromEntries(names.map(name => [name, []]))
  const api = Object.fromEntries(names.map(name => [name, (...args) => new Promise((resolve, reject) => calls[name].push({ args, signal: args.at(-1), resolve, reject }))]))
  const h = await mountSavedActivity({ api, initialPath, locale, viewPaths: ['views/SavedPostsView.vue', 'views/SavedSimulationsView.vue'] })
  let unmounted = false
  const original = h.unmount
  h.unmount = () => { if (!unmounted) { unmounted = true; original() } }
  t.after(() => {
    h.unmount()
    assert.deepEqual(Object.fromEntries(names.map(name => [name, calls[name].length])), {
      getSavedPosts: expected.list ?? 0, getSavedPost: expected.detail ?? 0,
      getComparisonCandidates: expected.catalog ?? 0, getSavedActivity: 0,
      getSavedActivityRounds: 0, getSavedActivityAgents: 0, getSimulationHistory: 0, getSavedActionsExport: 0,
    }, 'source-accounted API allocation changed')
    assert.deepEqual(h.warnings, [], 'compiled Vue or locale warning')
  })
  return { h, calls, api }
}
