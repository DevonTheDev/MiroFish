import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptPromptSuiteDefinition, parsePromptSuiteDefinition, exportPromptSuiteDefinition, acceptPromptSuiteReport, exportPromptSuiteReport, summarizePromptSuiteReport } from '../src/utils/promptSuites.js'
import { trialRequest, trialSnapshot, ok } from './helpers/prompt-trials-view-fixture.js'
import { acceptPromptTrialSnapshot } from '../src/api/promptTrials.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const definition = () => ({ schema_version: 1, kind: 'mirofish_local_prompt_suite', name: 'Exact checks', cases: [{ case_id: id(1), ...trialRequest(), expected_text: null }] })
const report = () => {
  const suite = definition(), snapshot = acceptPromptTrialSnapshot(ok(trialSnapshot('succeeded')))
  return { schema_version: 1, kind: 'mirofish_local_prompt_suite_run', run_id: id(9), definition: suite, started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
    cases: [{ case_id: id(1), request_id: snapshot.run.request_id, status: 'succeeded', check: 'not_requested', snapshot, error_code: null }] }
}

test('definitions round trip offline and detach literal Unicode inputs', () => {
  const source = definition(); source.name = '🦙'.repeat(80); source.cases[0].expected_text = '<think> Å\r\n🦙\t </think>'
  const accepted = acceptPromptSuiteDefinition(source), parsed = parsePromptSuiteDefinition(exportPromptSuiteDefinition(source))
  assert.deepEqual(parsed, accepted); source.cases[0].user_prompt = 'changed'
  assert.equal(accepted.cases[0].user_prompt, 'Hello'); assert.equal(accepted.cases[0].expected_text, '<think> Å\r\n🦙\t </think>')
})
for (const expected of [null, '', '🦙'.repeat(500)]) test(`expected_text preserves ${expected === null ? 'null' : expected.length} exactly`, () => {
  const source = definition(); source.cases[0].expected_text = expected
  assert.equal(parsePromptSuiteDefinition(JSON.stringify(source)).cases[0].expected_text, expected)
})
for (const [name, mutate] of [
  ['version', d => d.schema_version = 2], ['kind', d => d.kind = 'mirofish_local_prompt_suite_run'], ['unknown root', d => d.endpoint = 'http://private'],
  ['blank name', d => d.name = ' '], ['long name', d => d.name = '🦙'.repeat(81)], ['name format control', d => d.name = 'a\u202e'],
  ['empty cases', d => d.cases = []], ['six cases', d => d.cases = Array.from({length:6},(_,i)=>({...d.cases[0],case_id:id(i)}))],
  ['duplicate id', d => d.cases.push({...d.cases[0]})], ['bad id', d => d.cases[0].case_id = 'id'], ['uppercase id', d => d.cases[0].case_id = 'ABCDEFAB-1234-4234-9234-123456789abc'],
  ['unknown case', d => d.cases[0].request_id = id(8)], ['missing field', d => delete d.cases[0].expected_text], ['nested field', d => d.cases[0].user_prompt = {}],
  ['large expected', d => d.cases[0].expected_text = '🦙'.repeat(501)], ['expected NUL', d => d.cases[0].expected_text = '\0'], ['expected surrogate', d => d.cases[0].expected_text = '\ud800'],
  ['prompt surrogate', d => d.cases[0].user_prompt = '\udfff'], ['bad cap', d => d.cases[0].max_output_tokens = 513], ['nonfinite', d => d.cases[0].temperature = Infinity],
  ['blank prompt', d => d.cases[0].user_prompt = '\ufeff'], ['long system', d => d.cases[0].system_prompt = 'a'.repeat(1001)], ['label control', d => d.cases[0].label = 'a\n'],
]) test(`definition rejects ${name} with a safe error`, () => {
  const source=definition(); mutate(source); assert.throws(()=>acceptPromptSuiteDefinition(source), /^Error: Invalid prompt suite definition$/)
})
for (const source of [
  '{"schema_version":1,"schema_version":1}', '{"name":"first","na\\u006de":"second"}',
  '{"cases":[{"label":"one","label":"two"}]}', '{"__proto__":{},"__proto__":{}}',
  '['.repeat(20000)+']'.repeat(20000), '{"x":NaN}', '{"x":Infinity}', '{"x":undefined}', '{"x":1,}', 'null', '\ufeff{}',
  ' '.repeat(128*1024)+'{}', '🦙'.repeat(33000),
]) test(`JSON rejects duplicate, malformed, deep or oversized data: ${source.slice(0,25)}`, () => {
  assert.throws(()=>parsePromptSuiteDefinition(source), /^Error: Invalid prompt suite definition$/)
})

test('captured report projects snapshots, detaches and derives exact summary', () => {
  const source=report(); source.cases[0].snapshot.secret='PRIVATE'; source.cases[0].snapshot.run.configuration.key='PRIVATE'
  const accepted=acceptPromptSuiteReport(source), saved=JSON.parse(exportPromptSuiteReport(source))
  assert.deepEqual(saved,accepted); assert.doesNotMatch(JSON.stringify(saved),/PRIVATE/)
  source.cases[0].snapshot.run.response.content='mutated'; assert.equal(saved.cases[0].snapshot.run.response.content,'Hello back')
  assert.deepEqual(summarizePromptSuiteReport(saved),{total:1,attempted:1,succeeded:1,evaluated:0,matched:0,mismatched:0,not_requested:1,not_evaluated:0})
})
for(const mutate of [r=>r.cases[0].request_id=id(42),r=>r.cases[0].check='matched',r=>r.cases[0].snapshot.run.request.user_prompt='different',r=>r.cases[0].error_code='PRIVATE',r=>r.halt_code='PRIVATE',r=>r.status='unknown',r=>r.definition.kind='wrong',r=>r.cases.push({...r.cases[0]}),r=>r.secret='private']) test('captured report rejects forged identity, state, check or fields',()=>{
  const source=report(); mutate(source); assert.throws(()=>exportPromptSuiteReport(source),/Invalid prompt suite report/)
})
test('captured exact empty and Unicode output checks preserve actual reply and never normalize',()=>{
  for(const [expected,reply,check] of [['','','matched'],['Å','A\u030a','mismatched'],['x','x\n','mismatched'],['x','<think>x</think>','mismatched'],['A','a','mismatched']]){
    const source=report(); source.definition.cases[0].expected_text=expected; source.cases[0].snapshot.run.response.content=reply; source.cases[0].check=check
    assert.equal(JSON.parse(exportPromptSuiteReport(source)).cases[0].snapshot.run.response.content,reply)
  }
})

test('sparse case arrays are rejected by pure admission',()=>{
  const source=definition();source.cases=new Array(1)
  assert.throws(()=>acceptPromptSuiteDefinition(source),/Invalid prompt suite definition/)
  const saved=report();saved.cases=new Array(1)
  assert.throws(()=>acceptPromptSuiteReport(saved),/Invalid prompt suite report/)
})

test('import byte limit counts UTF-8 and rejects oversized whitespace before parsing',()=>{
  const source=JSON.stringify(definition()),atLimit=source+' '.repeat(128*1024-new TextEncoder().encode(source).length)
  assert.deepEqual(parsePromptSuiteDefinition(atLimit),definition())
  assert.throws(()=>parsePromptSuiteDefinition(atLimit+' '),/Invalid prompt suite definition/)
})
