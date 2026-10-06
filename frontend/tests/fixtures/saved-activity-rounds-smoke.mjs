// Driven only by the guarded Python fixture's disposable Flask server.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { mountSavedActivity, waitFor } from '../helpers/saved-activity-view-fixture.js'

const baseURL = process.argv[2]
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
const loggedErrors = []
const locale = { value: 'en' }
const index = readFileSync(new URL('../../src/api/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('import.meta.env', 'buildEnvironment')
  .replace('export default service', 'return service')
const service = new Function('axios', 'i18n', 'buildEnvironment', 'console', index)(
  axios, { global: { locale } }, { VITE_API_BASE_URL: baseURL },
  { ...console, error: (...args) => loggedErrors.push(args) },
)
service.defaults.proxy = false
service.defaults.maxRedirects = 0
service.defaults.timeout = 5000
const requests = [], responses = [], conflicts = [], cancellations = []
service.interceptors.request.use(config => {
  assert.equal(config.method, 'get', 'The workflow may only read saved sources')
  assert.match(config.url, /^\/api\/simulation\/sim_(right|legacy|partial|empty|missing)\/saved-action(s|-rounds)$/)
  requests.push({ url: config.url, params: { ...config.params } })
  return config
})
service.interceptors.response.use(envelope => {
  responses.push(envelope)
  return envelope
}, cause => {
  if (axios.isCancel(cause)) cancellations.push(cause)
  else conflicts.push({ status: cause.response?.status, envelope: cause.response?.data,
    url: cause.config?.url, params: { ...cause.config?.params } })
  return Promise.reject(cause)
})
const wrappers = readFileSync(new URL('../../src/api/simulation.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replaceAll('export const ', 'const ')
const api = new Function('service', wrappers + '\nreturn { getSavedActivity, getSavedActivityRounds };')(service)
const view = await mountSavedActivity({ api,
  initialPath: '/simulation/sim_right/activity?platform=twitter&q=Round&agent_id=0&round_num=3&action_type=CREATE_POST&outcome=failed&limit=1',
})
const huge = '9'.repeat(65)
const last = (simulation, order) => responses.findLast(item =>
  item.data?.simulation_id === simulation && item.data.order === order)?.data
const currentQuery = () => ({ ...view.router.currentRoute.value.query })
async function roundsReady(simulation = 'sim_right') {
  await waitFor(() => view.byId('rounds-results') &&
    view.router.currentRoute.value.params.simulationId === simulation &&
    /^[a-f0-9]{64}$/.test(view.router.currentRoute.value.query.revision || ''))
}
async function recordsReady(id) {
  await waitFor(() => view.byId('results') && view.byId('action-row-' + id))
}
function countControl(round, outcome, expected) {
  const control = view.byId(`round-${round}-${outcome}`)
  assert.ok(control, `Missing round ${round} ${outcome} count`)
  assert.equal(view.text(control).trim(), String(expected))
  return control
}
function assertDrillQuery(round, outcome, revision, platform = 'twitter') {
  assert.equal(view.router.currentRoute.value.name, 'SavedActivity')
  assert.deepEqual(currentQuery(), {
    ...(platform ? { platform } : {}), round_num: round,
    ...(outcome ? { outcome } : {}), offset: '0', limit: '50', revision,
  })
}
async function backToOverview() {
  await view.back()
  await roundsReady()
}
try {
  await recordsReady('twitter:6')
  await waitFor(() => view.byId('activity-rounds-entry'))
  const initialRevision = view.router.currentRoute.value.query.revision
  assert.match(initialRevision, /^[a-f0-9]{64}$/)
  await view.click('activity-rounds-entry')
  await roundsReady()
  assert.equal(view.router.currentRoute.value.name, 'SavedActivityRounds')
  assert.deepEqual(currentQuery(), { platform: 'twitter', revision: initialRevision })
  const accepted = last('sim_right', 'round_ascending')
  assert.deepEqual(accepted.filters, { platform: 'twitter', round_from: null, round_to: null })
  assert.equal(accepted.source_revision, initialRevision)
  assert.equal(accepted.matched_count, 8)
  assert.equal(accepted.round_count, 5)
  assert.deepEqual(accepted.outcomes, { success: 4, failed: 2, unknown: 2 })
  assert.deepEqual(accepted.rounds, [
    { round_num: '0', count: 1, outcomes: { success: 0, failed: 1, unknown: 0 }, drilldown_supported: true },
    { round_num: '1', count: 1, outcomes: { success: 1, failed: 0, unknown: 0 }, drilldown_supported: true },
    { round_num: '2', count: 2, outcomes: { success: 2, failed: 0, unknown: 0 }, drilldown_supported: true },
    { round_num: '3', count: 3, outcomes: { success: 1, failed: 1, unknown: 1 }, drilldown_supported: true },
    { round_num: huge, count: 1, outcomes: { success: 0, failed: 0, unknown: 1 }, drilldown_supported: false },
  ])
  assert.match(view.text(view.byId('rounds-matched-count')), /\b8\b/)
  assert.match(view.text(view.byId('rounds-round-count')), /\b5\b/)
  for (const [outcome, count] of [['total', 3], ['success', 1], ['failed', 1], ['unknown', 1]]) {
    assert.equal(Boolean(countControl('3', outcome, count).props.disabled), false)
  }
  assert.equal(Boolean(countControl(huge, 'total', 1).props.disabled), true)
  assert.match(view.text(view.byId('round-row-' + huge)), new RegExp(huge))
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.doesNotMatch(view.text(), /SYNTHETIC_PRIVATE_MARKER/)

  await view.click('rounds-download')
  assert.equal(view.downloads.length, 1)
  const download = view.downloads[0]
  assert.match(download.filename, /sim_right.*round.*\.json$/)
  assert.deepEqual(JSON.parse(await download.blob.text()), { format_version: 1, ...accepted })

  for (const [outcome, recordId, success] of [
    ['failed', 'twitter:6', false], ['success', 'twitter:5', true], ['unknown', 'twitter:7', null],
  ]) {
    await view.click(`round-3-${outcome}`)
    await recordsReady(recordId)
    assertDrillQuery('3', outcome, initialRevision)
    const records = last('sim_right', 'source_record')
    assert.equal(records.source_revision, initialRevision)
    assert.equal(records.matched_count, 1)
    assert.deepEqual(records.actions.map(row => row.record_id), [recordId])
    assert.equal(records.actions[0].success, success)
    if (outcome === 'failed') {
      assert.match(view.text(), /Round failure <script>literal<\/script>/)
      assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
      assert.ok(view.revokedUrls.includes(download.url), 'Leaving overview retires its download URL')
    }
    await backToOverview()
  }
  await view.click('round-0-total')
  await recordsReady('twitter:1')
  assertDrillQuery('0', null, initialRevision)
  await backToOverview()

  // The Python fixture appends through the actual logger immediately before
  // this total drill request. Neither overview nor drill may accept old data.
  await view.click('round-3-total')
  await waitFor(() => view.byId('error'))
  assertDrillQuery('3', null, initialRevision)
  assert.equal(view.byId('results'), undefined)
  assert.equal(view.byId('download').props.disabled, true)
  assert.equal(conflicts.at(-1).status, 409)
  assert.equal(conflicts.at(-1).envelope.error_code, 'sources_changed')
  await view.back()
  await waitFor(() => view.byId('rounds-error'))
  assert.equal(view.byId('rounds-results'), undefined)
  assert.equal(view.byId('rounds-download').props.disabled, true)
  assert.equal(conflicts.at(-1).status, 409)
  assert.equal(conflicts.at(-1).envelope.error_code, 'sources_changed')
  await view.click('rounds-refresh')
  await roundsReady()
  const refreshed = last('sim_right', 'round_ascending')
  assert.notEqual(refreshed.source_revision, initialRevision)
  assert.equal(view.router.currentRoute.value.query.revision, refreshed.source_revision)
  assert.deepEqual(refreshed.filters, accepted.filters)
  assert.equal(refreshed.matched_count, 9)
  assert.deepEqual(refreshed.outcomes, { success: 4, failed: 3, unknown: 2 })
  assert.equal(requests.at(-1).params.revision, undefined, 'Refresh drops the old source acknowledgement')
  await view.click('round-3-total')
  await recordsReady('twitter:9')
  assertDrillQuery('3', null, refreshed.source_revision)
  assert.deepEqual(last('sim_right', 'source_record').actions.map(row => row.record_id),
    ['twitter:5', 'twitter:6', 'twitter:7', 'twitter:9'])
  await backToOverview()
  await view.click('rounds-download')
  const refreshedDownload = view.downloads.at(-1)
  await view.input('round-from', '0003')
  assert.equal(view.byId('rounds-results'), undefined, 'Draft edits retire the accepted overview')
  assert.equal(view.byId('rounds-download').props.disabled, true)
  assert.ok(view.revokedUrls.includes(refreshedDownload.url))
  await view.input('round-to', '0003')
  await view.click('rounds-apply')
  await roundsReady()
  assert.deepEqual(currentQuery(), { platform: 'twitter', round_from: '3', round_to: '3',
    revision: refreshed.source_revision })
  const bounded = last('sim_right', 'round_ascending')
  assert.equal(bounded.matched_count, 4)
  assert.deepEqual(bounded.rounds, [
    { round_num: '3', count: 4, outcomes: { success: 1, failed: 2, unknown: 1 }, drilldown_supported: true },
  ])
  await view.click('rounds-download')
  assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), { format_version: 1, ...bounded })

  await view.navigate('/simulation/sim_legacy/activity/rounds')
  await roundsReady('sim_legacy')
  const legacy = last('sim_legacy', 'round_ascending')
  assert.equal(legacy.availability, 'complete')
  assert.equal(legacy.matched_count, 3)
  assert.deepEqual(legacy.outcomes, { success: 1, failed: 1, unknown: 1 })
  await view.click('round-2-unknown')
  await recordsReady('legacy:3')
  assertDrillQuery('2', 'unknown', legacy.source_revision, null)
  assert.deepEqual(last('sim_legacy', 'source_record').actions.map(row => row.record_id), ['legacy:3'])
  await view.back()
  await roundsReady('sim_legacy')
  await view.change('rounds-platform', 'reddit')
  await view.click('rounds-apply')
  await roundsReady('sim_legacy')
  const reddit = last('sim_legacy', 'round_ascending')
  assert.equal(reddit.source_revision, legacy.source_revision)
  assert.equal(reddit.matched_count, 1)
  assert.deepEqual(reddit.filters, { platform: 'reddit', round_from: null, round_to: null })
  await view.click('round-2-success')
  await recordsReady('legacy:2')
  assertDrillQuery('2', 'success', legacy.source_revision, 'reddit')

  for (const [simulation, availability, count, totals] of [
    ['sim_partial', 'partial', 1, { success: 0, failed: 1, unknown: 0 }],
    ['sim_empty', 'complete', 0, { success: 0, failed: 0, unknown: 0 }],
    ['sim_missing', 'unavailable', null, { success: null, failed: null, unknown: null }],
  ]) {
    await view.navigate(`/simulation/${simulation}/activity/rounds`)
    await roundsReady(simulation)
    const observation = last(simulation, 'round_ascending')
    assert.equal(observation.availability, availability)
    assert.equal(observation.matched_count, count)
    assert.deepEqual(observation.outcomes, totals)
    assert.match(view.byId('rounds-availability').props.class, new RegExp(`\\b${availability}\\b`))
    if (simulation === 'sim_partial') {
      assert.equal(observation.platform_availability.reddit, 'unavailable')
      assert.ok(observation.warnings.length > 0)
      assert.ok(view.byId('round-row-0'))
    } else {
      assert.equal(observation.round_count, 0)
      assert.deepEqual(observation.rounds, [])
      assert.ok(view.byId('rounds-empty'))
      assert.match(view.text(view.byId('rounds-matched-count')), count === null ? /—/ : /\b0\b/)
    }
    await view.click('rounds-download')
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), { format_version: 1, ...observation })
  }
  await view.navigate('/simulation/sim_empty/activity/rounds?platform=reddit')
  await roundsReady('sim_empty')
  const absentPlatform = last('sim_empty', 'round_ascending')
  assert.equal(absentPlatform.availability, 'unavailable')
  assert.equal(absentPlatform.matched_count, null)
  assert.deepEqual(absentPlatform.outcomes, { success: null, failed: null, unknown: null })
  assert.match(view.text(view.byId('rounds-matched-count')), /—/)
  const requestsBeforeLocale = requests.length
  locale.value = 'zh'
  view.i18n.global.locale.value = 'zh'
  await view.flush()
  const chinese = JSON.parse(readFileSync(new URL('../../../locales/zh.json', import.meta.url), 'utf8'))
  assert.ok(view.text().includes(chinese.savedActivityRounds.title))
  assert.equal(requests.length, requestsBeforeLocale, 'Locale changes do not rescan accepted sources')
  await view.navigate('/simulation/sim_right/activity/rounds?platform=twitter')
  await roundsReady()
  assert.ok(view.text().includes(chinese.savedActivityRounds.title))
  assert.match(view.text(view.byId('round-row-' + huge)), new RegExp(huge))
  assert.equal(last('sim_right', 'round_ascending').source_revision, refreshed.source_revision)
  await view.click('round-3-failed')
  await recordsReady('twitter:6')
  assertDrillQuery('3', 'failed', refreshed.source_revision)
  assert.match(view.text(), /Round failure <script>literal<\/script>/)
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.equal(conflicts.length, 2)
  assert.ok(loggedErrors.length >= 2, 'Production Axios observed the expected conflicts')
  assert.ok(requests.length >= 17)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue saved activity rounds passed')
} finally {
  view.unmount()
}
