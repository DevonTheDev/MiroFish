// Guarded Python starts real Flask, the gateway, synthetic models and Neo4j.
import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { mountReadiness, readinessApi, productionClient } from '../helpers/readiness-view-fixture.js'

const [baseURL, scenario] = process.argv.slice(2)
assert.match(baseURL, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
assert.ok(['passed', 'failed', 'cancelled', 'leave', 'cloud'].includes(scenario))
const service = productionClient(baseURL)
const calls = [], replies = []
service.interceptors.request.use(config => {
  calls.push({ method: config.method, url: config.url, data: config.data })
  assert.ok(config.url.startsWith('/api/runtime/'))
  if (config.method === 'post') assert.deepEqual(config.data, {})
  return config
})
service.interceptors.response.use(body => { replies.push(structuredClone(body)); return body })
const view = await mountReadiness({ api: readinessApi(service), timers: { setTimeout, clearTimeout } })
try {
  await view.waitFor(() => scenario === 'cloud'
    ? view.byId('readiness-unavailable')
    : view.byId('readiness-start')?.props.disabled === false)
  assert.ok(calls.length >= 2)
  assert.ok(calls.every(call => call.method === 'get'), 'Mount is purely observational')
  if (scenario === 'cloud') {
    assert.equal(view.byId('readiness-start').props.disabled, true)
    assert.equal(view.byId('readiness-download').props.disabled, true)
  } else {
    await view.click('readiness-start')
    await view.waitFor(() => view.byId('readiness-result'), { timeout: 15000 })
    if (['cancelled', 'leave'].includes(scenario)) {
      const deadline = Date.now() + 15000
      while (!replies.some(reply => reply.data?.kind === 'mirofish_local_readiness' && reply.data.run?.current_step === 'json_output')) {
        assert.ok(Date.now() < deadline, 'The synthetic probe should start within the test budget')
        if (view.byId('readiness-refresh')?.props.disabled === false) await view.click('readiness-refresh')
        await pause(25); await view.flush()
      }
      if (scenario === 'leave') {
        await view.navigate('/report/retired-readiness-view')
        assert.equal(view.byId('readiness-panel'), undefined)
        const before = calls.length
        await pause(1700)
        assert.equal(calls.length, before, 'Leaving retires observation without canceling backend work')
        assert.equal(calls.filter(call => call.method === 'post').length, 1)
      } else await view.click('readiness-stop')
    }
    if (scenario !== 'leave') {
      await view.waitFor(() => view.byId('readiness-download')?.props.disabled === false, { timeout: 20000 })
      const accepted = replies.filter(reply => reply.data?.kind === 'mirofish_local_readiness').at(-1).data
      assert.equal(accepted.run.state, scenario)
      assert.equal(accepted.run.steps.at(-1).state, 'passed')
      assert.match(view.text(), /fixture <literal>/)
      if (scenario === 'passed') assert.ok(accepted.run.steps.every(step => step.state === 'passed'))
      else if (scenario === 'failed') {
        assert.equal(accepted.run.steps.find(step => step.id === 'json_schema').code, 'capability_unsupported')
        assert.equal(accepted.run.steps.find(step => step.id === 'embedding').state, 'passed')
      } else {
        assert.equal(accepted.run.cancel_requested, true)
        assert.ok(accepted.run.steps.some(step => step.code === 'stopped'))
      }
      const before = calls.length
      await view.click('readiness-download')
      assert.equal(calls.length, before, 'Export reuses the accepted terminal snapshot')
      assert.equal(view.downloads.length, 1)
      assert.equal(view.downloads[0].filename, 'local_readiness_check.json')
      assert.deepEqual(JSON.parse(await view.downloads[0].blob.text()), accepted)
      assert.equal(view.revokedUrls.length, 1)
      assert.equal(calls.filter(call => call.method === 'post' && call.url === '/api/runtime/readiness').length, 1)
      assert.equal(calls.filter(call => call.method === 'post' && call.url.endsWith('/cancel')).length, scenario === 'cancelled' ? 1 : 0)
    }
  }
  assert.equal(view.all(node => Object.hasOwn(node.props, 'innerHTML')).length, 0)
  assert.doesNotMatch(JSON.stringify(replies), /PRIVATE/)
  assert.doesNotMatch(view.text(), /PRIVATE/)
  assert.deepEqual(view.warnings, [])
  console.log('actual Flask/Axios/Vue readiness check passed')
} finally {
  view.unmount()
}
