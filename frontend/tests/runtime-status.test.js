import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountRuntime, ok, runtimeSnapshot, flush } from './helpers/runtime-view-fixture.js'

test('Home links to the actual runtime route without making a readiness claim', async () => {
  const view = await mountRuntime({ initialPath: '/' })
  try {
    assert.equal(view.requests.calls.getRuntimeStatus.length, 0)
    assert.match(view.text(), /Simulation workspace/)
    assert.doesNotMatch(view.text(), /Prediction engine on standby|System Status/)
    await view.click('runtime-link')
    assert.equal(view.router.currentRoute.value.path, '/runtime')
    assert.equal(view.requests.calls.getRuntimeStatus.length, 1)
  } finally { view.unmount() }
})

for (const locale of ['en', 'zh']) {
  test(`renders loaded settings, actual policy and honest counter meanings in ${locale}`, async () => {
    const view = await mountRuntime({ locale })
    try {
      assert.equal(view.requests.calls.getRuntimeStatus.length, 1)
      assert.ok(view.byId('refresh').props.disabled)
      assert.ok(view.byId('download').props.disabled)
      view.requests.calls.getRuntimeStatus[0].resolve(ok(runtimeSnapshot()))
      await flush()
      assert.ok(view.byId('snapshot'))
      assert.match(view.text(), /local-chat/)
      assert.match(view.text(view.byId('loaded-max_concurrency')), /2/)
      assert.match(view.text(view.byId('actual-max_concurrency')), /1/)
      assert.match(view.text(view.byId('metric-queued_requests')), /1/)
      assert.match(view.text(), locale === 'en' ? /not model readiness/ : /不代表模型就绪/)
      assert.match(view.text(), locale === 'en' ? /Forwarded requests/ : /已转发请求/)
      assert.match(view.text(view.byId('observed-at')), /2026/)
      assert.deepEqual(view.warnings, [])
    } finally { view.unmount() }
  })
}

for (const locale of ['en', 'zh']) for (const state of ['disabled', 'inherited', 'not_running', 'transitioning', 'starting', 'closing', 'closed', 'failed']) {
  test(`${state} shows unknown unavailable counters rather than fabricated zero in ${locale}`, async () => {
    const view = await mountRuntime({ locale })
    try {
      const data = runtimeSnapshot({ ...(state === 'disabled' ? { mode: 'cloud', configuration: null } : {}),
        gateway: { state, instance_id: null, started_at: null, uptime_seconds: null, limits: null, metrics: null } })
      view.requests.calls.getRuntimeStatus[0].resolve(ok(data)); await flush()
      assert.match(view.text(view.byId('metric-active_requests')), locale === 'en' ? /Unknown/ : /未知/)
      assert.match(view.text(view.byId('actual-max_concurrency')), locale === 'en' ? /Unknown/ : /未知/)
      if (state === 'not_running') assert.match(view.text(), locale === 'en' ? /idle.*not.*readiness/i : /空闲.*不代表模型就绪/)
      if (state === 'inherited') assert.match(view.text(), locale === 'en' ? /another process/ : /其他进程/)
      if (state === 'disabled') { assert.match(view.text(), locale === 'en' ? /Cloud mode/ : /云端模式/); assert.equal(view.byId('configuration'), undefined) }
      assert.deepEqual(view.warnings, [])
    } finally { view.unmount() }
  })
}

test('all runtime copy has matching nonempty English and Chinese keys', () => {
  const locales = ['en', 'zh'].map(locale => JSON.parse(readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), 'utf8')).runtime)
  const entries = (node, path = '') => Object.entries(node).flatMap(([key, value]) => typeof value === 'string'
    ? [[path + key, value]] : entries(value, `${path}${key}.`))
  assert.deepEqual(entries(locales[0]).map(([key]) => key).sort(), entries(locales[1]).map(([key]) => key).sort())
  for (const locale of locales) assert.ok(entries(locale).every(([, value]) => value.trim()))
})

test('turning auto refresh off clears the next observation and manual refresh replaces a pending timer', async () => {
  const view = await mountRuntime()
  try {
    view.requests.calls.getRuntimeStatus[0].resolve(ok(runtimeSnapshot())); await flush()
    await view.change('auto-refresh', true)
    assert.equal(view.timers.pending.size, 1)
    await view.timers.advance(4000)
    await view.click('refresh')
    assert.equal(view.timers.pending.size, 0)
    await view.timers.advance(5000)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 2)
    view.requests.calls.getRuntimeStatus[1].resolve(ok(runtimeSnapshot())); await flush()
    assert.equal(view.timers.pending.size, 1)
    await view.change('auto-refresh', false)
    assert.equal(view.timers.pending.size, 0)
    await view.timers.advance(10000)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 2)
  } finally { view.unmount() }
})

test('invalid configuration uses fixed issue wording and literal model strings', async () => {
  const view = await mountRuntime()
  try {
    const data = runtimeSnapshot()
    data.configuration.valid = false
    data.configuration.chat_model = '<img src=x onerror=alert(1)>'
    data.configuration.chat_endpoint = null
    data.configuration.issues = [{ field: 'chat_endpoint', code: 'invalid_local_endpoint' }, { field: 'SECRET_FIELD', code: 'SECRET_ERROR' }]
    view.requests.calls.getRuntimeStatus[0].resolve(ok(data)); await flush()
    assert.match(view.text(), /<img src=x onerror=alert\(1\)>/)
    assert.match(view.text(), /Configuration needs attention/)
    assert.match(view.text(), /Invalid local endpoint/)
    assert.doesNotMatch(view.text(), /SECRET_FIELD|SECRET_ERROR/)
    assert.equal(view.all(node => node.type === 'img').length, 0)
    assert.equal(view.all(node => node.props.innerHTML).length, 0)
  } finally { view.unmount() }
})

test('failed refresh keeps a dated stale snapshot and disables export until recovery', async () => {
  const view = await mountRuntime()
  try {
    view.requests.calls.getRuntimeStatus[0].resolve(ok(runtimeSnapshot())); await flush()
    await view.click('refresh')
    assert.ok(view.byId('download').props.disabled)
    view.requests.calls.getRuntimeStatus[1].reject(new Error('SECRET_ERROR /private/path')); await flush()
    assert.ok(view.byId('snapshot'))
    assert.match(view.text(view.byId('stale')), /Stale/)
    assert.match(view.text(view.byId('observed-at')), /2026/)
    assert.ok(view.byId('download').props.disabled)
    assert.doesNotMatch(view.text(), /SECRET_ERROR|private\/path/)
    await view.click('refresh')
    view.requests.calls.getRuntimeStatus[2].resolve(ok(runtimeSnapshot())); await flush()
    assert.equal(view.byId('stale'), undefined)
    assert.equal(view.byId('download').props.disabled, false)
  } finally { view.unmount() }
})

test('manual and opt-in automatic refresh are single-flight with five seconds after settlement', async () => {
  const view = await mountRuntime()
  try {
    const refresh = view.byId('refresh').props.onClick
    refresh(); refresh(); await flush()
    await view.change('auto-refresh', true)
    await view.timers.advance(15000)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 1)
    view.requests.calls.getRuntimeStatus[0].resolve(ok(runtimeSnapshot())); await flush()
    await view.timers.advance(4999)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 1)
    await view.timers.advance(1)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 2)
    refresh(); await view.timers.advance(15000)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 2)
    view.requests.calls.getRuntimeStatus[1].reject(new Error('failure')); await flush()
    await view.timers.advance(5000)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 3)
    await view.change('auto-refresh', false)
    view.requests.calls.getRuntimeStatus[2].resolve(ok(runtimeSnapshot())); await flush()
    await view.timers.advance(20000)
    assert.equal(view.requests.calls.getRuntimeStatus.length, 3)
  } finally { view.unmount() }
})

for (const settle of ['resolve', 'reject']) {
  test(`retired ${settle} cannot replace a remount, unlock it or resurrect auto refresh`, async () => {
    const view = await mountRuntime()
    try {
      await view.change('auto-refresh', true)
      const old = view.requests.calls.getRuntimeStatus[0]
      await view.navigate('/')
      assert.equal(old.signal.aborted, true)
      await view.navigate('/runtime')
      old[settle](settle === 'resolve' ? ok(runtimeSnapshot({ mode: 'cloud', configuration: null })) : new Error('secret'))
      await flush(); await view.timers.advance(20000)
      assert.equal(view.requests.calls.getRuntimeStatus.length, 2)
      assert.ok(view.byId('refresh').props.disabled)
      assert.equal(view.byId('snapshot'), undefined)
      const current = view.requests.calls.getRuntimeStatus[1]
      view.unmount()
      assert.equal(current.signal.aborted, true)
      current.resolve(ok(runtimeSnapshot())); await flush(); await view.timers.advance(20000)
      assert.equal(view.requests.calls.getRuntimeStatus.length, 2)
    } finally { if (view.root.children.length) view.unmount() }
  })
}

test('JSON download is fixed, allowlisted, immutable after acceptance and revokes its object URL', async () => {
  const view = await mountRuntime()
  try {
    const data = runtimeSnapshot()
    data.credential = 'PRIVATE_ROOT'
    data.configuration.api_key = 'PRIVATE_CONFIG'
    data.gateway.metrics.prompt = 'PRIVATE_METRIC'
    view.requests.calls.getRuntimeStatus[0].resolve(ok(data)); await flush()
    data.configuration.chat_model = 'MUTATED_AFTER_ACCEPT'
    await view.click('download')
    assert.equal(view.downloads.length, 1)
    const { blob, filename, url } = view.downloads[0]
    assert.equal(filename, 'mirofish-local-runtime-status.json')
    assert.equal(blob.type, 'application/json')
    const content = await blob.text()
    assert.doesNotMatch(content, /PRIVATE_|MUTATED_AFTER_ACCEPT/)
    assert.equal(JSON.parse(content).configuration.chat_model, 'local-chat')
    assert.deepEqual(view.revokedUrls, [url])
  } finally { view.unmount() }
})
