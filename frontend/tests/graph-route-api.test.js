import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/api/graph.js', import.meta.url), 'utf8')
const graphApi = service => vm.runInNewContext(source.replace(/^import .+$/gm, '').replace(/^export /gm, '')
  + '\n;({generateOntology,buildGraph,getTaskStatus,getProject,getGraphData})', { service })

test('graph lifecycle APIs preserve payloads and existing callers while forwarding optional observer signals', async () => {
  const calls = [], api = graphApi(config => { calls.push(config); return Promise.resolve({}) })
  const form = new FormData(), body = { project_id: 'A' }, signal = new AbortController().signal
  form.append('simulation_requirement', 'synthetic')
  await api.generateOntology(form, signal); await api.buildGraph(body, signal); await api.getTaskStatus('task-A', signal)
  await api.getProject('A', signal); await api.getGraphData('GA', signal)
  assert.ok(calls.every(call => call.signal === signal))
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['post', '/api/graph/ontology/generate'], ['post', '/api/graph/build'], ['get', '/api/graph/task/task-A'],
    ['get', '/api/graph/project/A'], ['get', '/api/graph/data/GA'],
  ])
  assert.equal(calls[0].data, form); assert.equal(calls[1].data, body)
  assert.equal(calls[0].headers['Content-Type'], 'multipart/form-data')
  await api.generateOntology(form); await api.buildGraph(body); await api.getTaskStatus('task-A')
  assert.ok(calls.slice(5).every(call => call.signal === undefined))
  assert.equal(calls[5].data, form); assert.equal(calls[6].data, body)
})
