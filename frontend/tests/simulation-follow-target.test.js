import assert from 'node:assert/strict'
import test from 'node:test'
import { build, settle, ok, runView, runChild } from './helpers/parent-route-fixture.js'

// Real Vue/Router render the actual parent and Step3 compiled scripts/templates.
// HTTP, timers, transitions and unrelated visual boundaries remain fixture-owned.
const fixture = () => build({ locale: 'en', disableTransitions: true, assertNoWarnings: true })
const pending = (h, name) => h.calls(name).findLast(call => !call.settled && !call.signal?.aborted)
const text = node => node ? (node.text || '') + (node.children || [])
  .filter(child => child.type !== '#comment').map(text).join('') : ''
const followLabel = h => h.find(node => node.type === 'span' && node.props.class === 'follow-label')
const response = (runner_status, platform) => ok({ runner_status, platform })

// Model the persisted producer row after the API adds its platform. The target
// enters through the completed run's real final-detail refresh, never setupState.
async function completedFollow(h, platform, actionArgs) {
  const row = { round: 1, timestamp: '2026-10-16T12:00:00', platform,
    agent_id: 1, agent_name: 'Maya Patel', action_type: 'FOLLOW',
    action_args: { follow_id: 7, ...actionArgs }, result: null, success: true }
  await h.mount('/simulation/A/start')
  assert.ok(pending(h, 'startSimulation'), 'actual run child requests startup')
  pending(h, 'startSimulation').resolve(response('running', platform)); await settle()
  await h.tick(3000)
  const preview = pending(h, 'getRunStatusDetail')
  assert.ok(preview, 'the running view has an in-flight detail observation')
  await h.tick(2000)
  pending(h, 'getRunStatus').resolve(response('completed', platform)); await settle()
  assert.equal(h.state(runView).currentStatus, 'completed')
  assert.equal(h.state(runChild).phase, 2)
  assert.equal(h.intervals.size, 0, 'completion retires observation timers')
  assert.equal(preview.signal.aborted, true)
  assert.equal(h.calls('getRunStatusDetail').length, 1, 'final refresh waits for the retired preview')
  preview.resolve(ok({ all_actions: [] })); await settle()
  const finalDetail = pending(h, 'getRunStatusDetail')
  assert.ok(finalDetail, 'completion requests its fresh final snapshot')
  assert.notEqual(finalDetail, preview)
  assert.equal(finalDetail.args[0], 'A')
  assert.equal(h.calls('getRunStatusDetail').length, 2)
  assert.equal(followLabel(h), undefined, 'the FOLLOW card is absent before the final response')
  finalDetail.resolve(ok({ all_actions: [row] })); await settle()
  assert.ok(followLabel(h), 'the actual completed-run FOLLOW card renders')
  assert.equal(h.state(runChild).allActions.length, 1)
  assert.equal(h.state(runChild).allActions[0].platform, platform)
  assert.equal(h.state(runChild).allActions[0].action_args.follow_id, 7)
  assert.equal(h.calls('startSimulation').length, 1)
  assert.equal(h.calls('stopSimulation').length, 0)
  assert.equal(h.calls('generateReport').length, 0)
}

async function assertTarget(platform, actionArgs, expected, inspect) {
  const h = fixture()
  try {
    await completedFollow(h, platform, actionArgs)
    // The sole baseline witness must reach this exact assertion and report
    // Followed @User versus Followed @Alex Chen, not fail during collection/setup.
    assert.equal(text(followLabel(h)), 'Followed @' + expected)
    inspect?.(h)
    await h.tick(2000); await h.tick(3000)
    assert.equal(h.calls('getRunStatusDetail').length, 2)
    assert.equal(h.state(runView).currentStatus, 'completed')
    assert.equal(text(followLabel(h)), 'Followed @' + expected, 'final target remains visible after completion')
  } finally { h.close() }
}

for (const platform of ['twitter', 'reddit']) {
  test(`${platform} completed FOLLOW renders the canonical target name`, { timeout: 5000 }, async () => {
    await assertTarget(platform, { target_user_name: 'Alex Chen' }, 'Alex Chen')
  })
}

test('canonical FOLLOW name takes precedence over both legacy aliases', { timeout: 5000 }, async () => {
  await assertTarget('twitter', { target_user_name: 'Alex Chen', target_user: 'Older Name', user_id: 42 }, 'Alex Chen')
})

test('legacy FOLLOW target_user retains precedence over user_id', { timeout: 5000 }, async () => {
  await assertTarget('reddit', { target_user: 'Older Name', user_id: 42 }, 'Older Name')
})

test('legacy FOLLOW user_id remains the next fallback', { timeout: 5000 }, async () => {
  await assertTarget('twitter', { user_id: 42 }, '42')
})

test('FOLLOW without a supported name keeps User instead of the relationship ID', { timeout: 5000 }, async () => {
  await assertTarget('reddit', {}, 'User')
})

test('an empty canonical FOLLOW name preserves the legacy fallback', { timeout: 5000 }, async () => {
  await assertTarget('twitter', { target_user_name: '', target_user: 'Older Name' }, 'Older Name')
})

test('HTML-looking FOLLOW names render as literal text without an injected node', { timeout: 5000 }, async () => {
  const name = '<img src="x" onerror="alert(1)">Alex & Chen'
  await assertTarget('reddit', { target_user_name: name }, name, h => {
    assert.equal(h.find(node => node.type === 'img'), undefined)
    assert.equal(followLabel(h).props.innerHTML, undefined, 'the host receives text, never an HTML assignment')
    assert.equal(followLabel(h).children.length, 0, 'the interpolated label contains no child element')
  })
})
