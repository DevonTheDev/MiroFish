import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'
import axios from 'axios'
async function api(service) {
  const source = await readFile(new URL('../src/api/simulation.js', import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .+$/gm, '').replace(/^export const /gm, 'const ')
    + '\n;({getPreparationPlan,previewPreparation,prepareSimulation})', { service })
}
test('planning helpers preserve explicit request bodies and optional cancellation', async () => {
  const calls = [], signal = new AbortController().signal
  const client = await api({ get: (url, options) => calls.push({ url, ...options }), post: (url, data, options) => calls.push({ url, data, ...options }) })
  const preview = { simulation_id: 'A' }, reuse = { simulation_id: 'A', preparation_mode: 'reuse' }
  await client.getPreparationPlan('A', signal); await client.previewPreparation(preview, signal); await client.prepareSimulation(reuse, signal)
  assert.deepEqual(calls.map(call => call.url), ['/api/simulation/A/prepare/plan', '/api/simulation/prepare/preview', '/api/simulation/prepare'])
  assert.ok(calls.every(call => call.signal === signal)); assert.equal(calls[1].data, preview); assert.equal(calls[2].data, reuse)
  await client.getPreparationPlan('A'); await client.previewPreparation(preview); assert.ok(calls.slice(3).every(call => call.signal === undefined))
})
for (const method of ['getPreparationPlan', 'previewPreparation']) test('real Axios cancels ' + method + ' observation', { timeout: 5000 }, async t => {
  let arrived, disconnected
  const arrival = new Promise(resolve => { arrived = resolve }), departure = new Promise(resolve => { disconnected = resolve })
  const server = createServer((request, response) => { response.on('close', disconnected); arrived(request.url) })
  const controller = new AbortController()
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const client = await api(axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 1000 }))
  const request = client[method](method === 'getPreparationPlan' ? 'A' : { simulation_id: 'A' }, controller.signal)
  const rejected = assert.rejects(request, error => axios.isCancel(error))
  assert.equal(await arrival, method === 'getPreparationPlan' ? '/api/simulation/A/prepare/plan' : '/api/simulation/prepare/preview')
  controller.abort(); await rejected; await departure
})
