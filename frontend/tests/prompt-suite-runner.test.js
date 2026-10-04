import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptSuiteRunner } from '../src/utils/promptSuiteRunner.js'
import { exportPromptSuiteReport, summarizePromptSuiteReport } from '../src/utils/promptSuites.js'
import { deferredTrials, fakeTimers, flush, ok, trialRequest, trialSnapshot } from './helpers/prompt-trials-view-fixture.js'

const id = n => `12345678-1234-4234-9234-${String(n).padStart(12, '0')}`
const suite = (length=2) => ({schema_version:1,kind:'mirofish_local_prompt_suite',name:'Checks',cases:Array.from({length},(_,i)=>({case_id:id(i+1),...trialRequest(),label:`Case ${i+1}`,expected_text:i===0?'Hello back':null}))})
function fixture(options={}) {
  const deferred=deferredTrials(), timers=fakeTimers(), changes=[]; let counter=100
  const runner=createPromptSuiteRunner({api:deferred.api,...timers,uuid:()=>id(++counter),now:()=>new Date('2026-10-04T00:00:00Z'),onChange:s=>changes.push(s),...options})
  return {runner,calls:deferred.calls,timers,changes,state:()=>runner.getState()}
}
async function ready(f,definition=suite()) {
  f.runner.start(definition); await flush(); assert.equal(f.calls.getPromptTrials.length,1)
  f.calls.getPromptTrials[0].resolve(ok(trialSnapshot())); await flush()
}
function owned(f,state='running',content='Hello back') {
  const sent=f.calls.startPromptTrial.at(-1).args[0], snapshot=trialSnapshot(state)
  snapshot.run.request_id=sent.request_id
  snapshot.run.request={label:sent.label,system_prompt:sent.system_prompt,user_prompt:sent.user_prompt,temperature:sent.temperature,max_output_tokens:sent.max_output_tokens}
  if(snapshot.run.response) snapshot.run.response.content=content
  if(state==='truncated')snapshot.run.response.finish_reason='length'
  if(state==='refused')snapshot.run.response.finish_reason='content_filter'
  if(['failed','timed_out','cancelled'].includes(state)){snapshot.run.response=null;snapshot.run.error_code=state==='cancelled'?'backend_closing':'request_timeout'}
  return snapshot
}
async function admit(f,state='running',content='Hello back'){f.calls.startPromptTrial.at(-1).resolve(ok(owned(f,state,content)));await flush()}
async function next(f){await f.timers.advance(1500);f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot()));await flush()}

test('passive refresh is read-only and never polls unowned work',async()=>{
  const f=fixture();f.runner.refresh();await flush();f.calls.getPromptTrials[0].resolve(ok(trialSnapshot('running')));await flush();await f.timers.advance(1000000)
  assert.equal(f.calls.startPromptTrial.length,0);assert.equal(f.calls.getPromptTrial.length,0);assert.equal(f.state().latest.run.state,'running');assert.equal(f.state().busy,false)
})
test('five sequential cases freeze inputs, wait once between admissions and capture exact checks',async()=>{
  const f=fixture(),d=suite(5);d.cases[1].expected_text='';d.cases[2].expected_text='Å';d.cases[3].expected_text='UPPER'
  await ready(f,d);d.cases[4].user_prompt='MUTATED';
  for(const [index,reply] of ['Hello back','','A\u030a','upper','literal\u0000<think>'].entries()){
    assert.equal(f.calls.startPromptTrial.length,index+1);assert.equal(f.calls.startPromptTrial[index].args[0].user_prompt,'Hello')
    await admit(f,'succeeded',reply)
    if(index<4){assert.equal(f.state().busy,true);assert.equal(f.timers.pending.size,1);await f.timers.advance(1499);assert.equal(f.calls.getPromptTrials.length,index+1);await f.timers.advance(1);assert.equal(f.calls.getPromptTrials.length,index+2);f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot()));await flush()}
  }
  const state=f.state();assert.equal(state.report.status,'completed');assert.equal(state.busy,false);assert.equal(f.calls.getPromptTrial.length,0)
  assert.deepEqual(state.report.cases.map(r=>r.check),['matched','matched','mismatched','mismatched','not_requested']);assert.equal(new Set(f.calls.startPromptTrial.map(c=>c.args[0].request_id)).size,5)
  assert.deepEqual(summarizePromptSuiteReport(state.report),{total:5,attempted:5,succeeded:5,evaluated:4,matched:2,mismatched:2,not_requested:1,not_evaluated:0})
  assert.equal(JSON.parse(exportPromptSuiteReport(state.report)).cases[4].snapshot.run.response.content,'literal\u0000<think>')
})
for(const [name,change,code] of [['running',s=>s.run=trialSnapshot('running').run,'backend_running'],['unavailable',s=>{s.available=false;s.unavailable_code='backend_closing'},'backend_unavailable'],['cap',s=>s.limits.max_output_tokens=127,'loaded_cap']])test(`initial ${name} refuses every POST`,async()=>{
  const f=fixture(),d=suite();d.cases[0].max_output_tokens=64;f.runner.start(d);await flush();const data=trialSnapshot();change(data);f.calls.getPromptTrials[0].resolve(ok(data));await flush();assert.equal(f.calls.startPromptTrial.length,0);assert.equal(f.state().error_code,code);assert.equal(f.state().report,null)
})
test('every next admission rechecks backend and all captured loaded caps',async()=>{
  for(const type of ['busy','cap']){const f=fixture();await ready(f);await admit(f,'succeeded');await f.timers.advance(1500);const data=trialSnapshot(type==='busy'?'running':null);if(type==='cap')data.limits.max_output_tokens=64;f.calls.getPromptTrials.at(-1).resolve(ok(data));await flush();assert.equal(f.calls.startPromptTrial.length,1);assert.equal(f.state().report.status,'halted');assert.equal(f.state().report.cases[1].status,'not_attempted')}
})
for(const state of ['truncated','refused','failed','timed_out','cancelled'])test(`${state} halts without evaluating or scheduling next case`,async()=>{
  const f=fixture();await ready(f);await admit(f,state);await f.timers.advance(100000);assert.equal(f.state().report.status,'halted');assert.equal(f.state().report.halt_code,'runtime_failed');assert.equal(f.state().report.cases[0].check,'not_evaluated');assert.equal(f.state().report.cases[1].status,'not_attempted');assert.equal(f.calls.startPromptTrial.length,1);assert.doesNotThrow(()=>exportPromptSuiteReport(f.state().report))
})
for(const [status,code] of [[400,'invalid_request'],[403,'local_mode_required'],[403,'local_browser_required'],[409,'already_running'],[409,'request_conflict']])test(`definitive ${code} halts with no reconciliation or retries`,async()=>{
  const f=fixture();await ready(f);f.calls.startPromptTrial[0].reject({response:{status,data:{success:false,error_code:code,error:'PRIVATE'}}});await flush();await f.timers.advance(100000);assert.equal(f.calls.getPromptTrial.length,0);assert.equal(f.state().report.cases[0].status,'rejected');assert.equal(f.state().report.halt_code,'admission_rejected');assert.doesNotMatch(JSON.stringify(f.state()),/PRIVATE/)
})
for(const state of ['running','succeeded'])test(`lost POST reconciles exact ID ${state} without replay`,async()=>{
  const f=fixture();await ready(f);f.calls.startPromptTrial[0].reject(new Error('PRIVATE'));await flush();assert.equal(f.calls.getPromptTrial.length,1);assert.equal(f.calls.getPromptTrial[0].args[0],f.calls.startPromptTrial[0].args[0].request_id)
  f.calls.getPromptTrial[0].resolve(ok(owned(f,state)));await flush();assert.equal(f.state().report.cases[0].status,state);assert.equal(f.calls.startPromptTrial.length,1);assert.doesNotMatch(JSON.stringify(f.state()),/PRIVATE/)
})
for(const kind of ['read failure','no run','different ID','different input','bad schema','changed fingerprint'])test(`${kind} halts and explicit reconciliation never resumes later cases`,async()=>{
  const f=fixture();await ready(f);await admit(f);await f.timers.advance(1500)
  if(kind==='read failure')f.calls.getPromptTrial[0].reject(new Error('PRIVATE'))
  else {const data=owned(f,'succeeded');if(kind==='no run')data.run=null;if(kind==='different ID')data.run.request_id=id(500);if(kind==='different input')data.run.request.user_prompt='PRIVATE';if(kind==='bad schema')data.schema_version=7;if(kind==='changed fingerprint')data.run.fingerprint='b'.repeat(64);f.calls.getPromptTrial[0].resolve(ok(data))}
  await flush();await f.timers.advance(100000);assert.equal(f.state().report.cases[0].status,'unknown');assert.equal(f.state().report.status,'halted');assert.equal(f.calls.getPromptTrial.length,1);assert.doesNotMatch(JSON.stringify(f.state()),/PRIVATE/)
  f.runner.reconcile();await flush();f.calls.getPromptTrial[1].resolve(ok(owned(f,'succeeded')));await flush();await f.timers.advance(100000);assert.equal(f.state().report.cases[0].status,'succeeded');assert.equal(f.state().report.status,'halted');assert.equal(f.calls.startPromptTrial.length,1);assert.equal(f.state().report.cases[1].status,'not_attempted')
})
for(const phase of ['initial','post','reconcile','poll','between','next-read'])test(`Stop during ${phase} is sticky and only observes the admitted case`,async()=>{
  const f=fixture();
  if(phase==='initial'){f.runner.start(suite());await flush();f.runner.stop();f.calls.getPromptTrials[0].resolve(ok(trialSnapshot()));await flush();assert.equal(f.calls.startPromptTrial.length,0);assert.equal(f.state().busy,false);return}
  await ready(f)
  if(phase==='post'){f.runner.stop();await admit(f)}
  if(phase==='reconcile'){f.calls.startPromptTrial[0].reject(new Error());await flush();f.runner.stop();f.calls.getPromptTrial[0].resolve(ok(owned(f)));await flush()}
  if(phase==='poll'){await admit(f);await f.timers.advance(1500);f.runner.stop();f.calls.getPromptTrial[0].resolve(ok(owned(f)));await flush()}
  if(['between','next-read'].includes(phase)){await admit(f,'succeeded');if(phase==='next-read'){await f.timers.advance(1500);f.runner.stop();f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot()));await flush()}else f.runner.stop()}
  if(['post','reconcile','poll'].includes(phase)){await f.timers.advance(1500);f.calls.getPromptTrial.at(-1).resolve(ok(owned(f,'succeeded')));await flush()}
  await f.timers.advance(100000);assert.equal(f.calls.startPromptTrial.length,1);assert.equal(f.state().report.status,'stopped');assert.equal(f.state().report.stop_requested,true);assert.equal(f.state().report.cases[1].status,'not_attempted');assert.equal(f.timers.pending.size,0)
})
for(const phase of ['initial','post','reconcile','poll','between','next-read'])test(`dispose during ${phase} aborts observation and retires all stale actions`,async()=>{
  const f=fixture();let call,result
  if(phase==='initial'){f.runner.start(suite());await flush();call=f.calls.getPromptTrials[0];result=trialSnapshot()}
  else {await ready(f);call=f.calls.startPromptTrial[0];result=owned(f,'succeeded');if(phase==='reconcile'){call.reject(new Error());await flush();call=f.calls.getPromptTrial[0]}if(phase==='poll'){await admit(f);await f.timers.advance(1500);call=f.calls.getPromptTrial[0]}if(['between','next-read'].includes(phase)){await admit(f,'succeeded');if(phase==='next-read'){await f.timers.advance(1500);call=f.calls.getPromptTrials.at(-1);result=trialSnapshot()}else call=null}}
  f.runner.dispose();const saved=f.state();if(call){assert.equal(call.signal.aborted,true);call.resolve(ok(result))}await flush();f.runner.start(suite());f.runner.refresh();f.runner.reconcile();f.runner.stop();await f.timers.advance(100000);assert.deepEqual(f.state(),saved);assert.equal(f.timers.pending.size,0);assert.equal(saved.phase,'disposed')
})
test('polling is bounded and never overlaps requests or resumes automatically',async()=>{
  const f=fixture();await ready(f);await admit(f)
  for(let i=0;i<60;i++){await f.timers.advance(1500);assert.equal(f.calls.getPromptTrial.length,i+1);await f.timers.advance(100000);assert.equal(f.calls.getPromptTrial.length,i+1);f.calls.getPromptTrial[i].resolve(ok(owned(f)));await flush()}
  assert.equal(f.state().report.halt_code,'observation_limit');assert.equal(f.state().report.cases[0].status,'unknown');await f.timers.advance(100000);assert.equal(f.calls.getPromptTrial.length,60)
})
test('detached callback/state/report cannot change captured input or checks',async()=>{
  const f=fixture();await ready(f);f.state().report.definition.cases[0].user_prompt='PRIVATE';f.changes.at(-1).report.cases[0].request_id=id(7);await admit(f,'succeeded');assert.equal(f.state().report.definition.cases[0].user_prompt,'Hello');assert.equal(f.state().report.cases[0].check,'matched')
})
test('onChange Stop or dispose is honored before the first POST',async()=>{
  for(const action of ['stop','dispose']){let runner;const f=fixture({onChange:s=>{if(s.phase==='submitting')runner[action]()}});runner=f.runner;await ready(f);assert.equal(f.calls.startPromptTrial.length,0);assert.equal(f.timers.pending.size,0)}
})
test('duplicate Run cannot race and a new explicit Run replaces only after readiness succeeds',async()=>{
  const f=fixture();await ready(f,suite(1));f.runner.start(suite());await flush();assert.equal(f.calls.getPromptTrials.length,1);await admit(f,'succeeded');const previous=f.state().report
  f.runner.start(suite());await flush();f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot('running')));await flush();assert.deepEqual(f.state().report,previous)
  f.runner.start(suite());await flush();f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot()));await flush();assert.notEqual(f.state().report.run_id,previous.run_id);assert.notEqual(f.calls.startPromptTrial[1].args[0].request_id,f.calls.startPromptTrial[0].args[0].request_id)
})

test('explicit reconciliation can observe an unresolved running case to terminal without resuming',async()=>{
  const f=fixture();await ready(f);f.calls.startPromptTrial[0].reject(new Error('lost'));await flush();f.calls.getPromptTrial[0].reject(new Error('lost read'));await flush()
  f.runner.refresh();await flush();f.calls.getPromptTrials.at(-1).resolve(ok(trialSnapshot()));await flush()
  f.runner.reconcile();await flush();f.calls.getPromptTrial.at(-1).resolve(ok(owned(f)));await flush();assert.equal(f.state().busy,true)
  await f.timers.advance(1500);f.calls.getPromptTrial.at(-1).resolve(ok(owned(f,'succeeded')));await flush();await f.timers.advance(100000)
  assert.equal(f.state().report.cases[0].status,'succeeded');assert.equal(f.state().report.cases[1].status,'not_attempted');assert.equal(f.state().report.status,'halted');assert.equal(f.calls.startPromptTrial.length,1);assert.equal(f.state().busy,false);assert.doesNotThrow(()=>exportPromptSuiteReport(f.state().report))
})

test('malformed successful POST halts, while malformed admission errors receive exact-ID reconciliation',async()=>{
  const f=fixture();await ready(f);f.calls.startPromptTrial[0].resolve({success:true,data:{endpoint:'PRIVATE'}});await flush()
  assert.equal(f.state().report.halt_code,'invalid_observation');assert.equal(f.calls.getPromptTrial.length,0);assert.equal(f.state().report.cases[0].status,'unknown')
  const g=fixture();await ready(g);g.calls.startPromptTrial[0].reject({response:{status:409,data:{success:false,error_code:{toString:null}}}});await flush()
  assert.equal(g.calls.getPromptTrial.length,1);assert.equal(g.calls.startPromptTrial.length,1)
})

test('invalid definitions and broken UUID sources send no inference',async()=>{
  const f=fixture();f.runner.start({...suite(),endpoint:'PRIVATE'});await flush();assert.equal(f.calls.getPromptTrials.length,0);assert.equal(f.state().error_code,'invalid_definition')
  for(const uuid of [()=> 'bad',()=>id(999)]){const g=fixture({uuid});g.runner.start(suite());await flush();g.calls.getPromptTrials[0].resolve(ok(trialSnapshot()));await flush();assert.equal(g.calls.startPromptTrial.length,0);assert.equal(g.state().error_code,'invalid_identity')}
})

test('partial submitting, active, stopped and unknown reports export captured state without reads',async()=>{
  const f=fixture();await ready(f);assert.equal(JSON.parse(exportPromptSuiteReport(f.state().report)).cases[0].status,'submitting');await admit(f);assert.equal(JSON.parse(exportPromptSuiteReport(f.state().report)).cases[0].status,'running');f.runner.stop();await f.timers.advance(1500);f.calls.getPromptTrial[0].reject(new Error());await flush();const saved=JSON.parse(exportPromptSuiteReport(f.state().report));assert.equal(saved.status,'halted');assert.equal(saved.stop_requested,true);assert.equal(saved.cases[0].status,'unknown');assert.equal(saved.cases[0].snapshot.run.state,'running');assert.equal(f.calls.getPromptTrials.length,1);assert.equal(f.calls.getPromptTrial.length,1)
})

const jsonSuite = (length = 2) => {
  const definition = suite(length); definition.schema_version = 2
  definition.cases.forEach(item => { item.check_kind = 'json_object'; item.expected_text = null })
  return definition
}

test('v2 runs freeze explicit checks, preserve report version and send only existing trial request fields', async () => {
  const f = fixture(), definition = jsonSuite(5)
  definition.cases[2].check_kind = 'exact_text'; definition.cases[2].expected_text = '{}'
  definition.cases[3].check_kind = 'exact_text'; definition.cases[3].expected_text = ''
  definition.cases[4].check_kind = 'none'
  await ready(f, definition)
  assert.equal(f.state().report.schema_version, 2)
  assert.equal(JSON.parse(exportPromptSuiteReport(f.state().report)).cases[0].check, 'not_evaluated')
  definition.cases[0].check_kind = 'none'; definition.cases[1].user_prompt = 'MUTATED'
  for (const [index, content] of [' { "ok": true } ', '{"duplicate":1,"duplicate":2}', '{ }', '', 'anything'].entries()) {
    const sent = f.calls.startPromptTrial[index].args[0]
    assert.deepEqual(Object.keys(sent), ['request_id', 'label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens'])
    assert.equal(sent.user_prompt, 'Hello')
    await admit(f, 'succeeded', content)
    if (index < 4) await next(f)
  }
  const saved = JSON.parse(exportPromptSuiteReport(f.state().report))
  assert.equal(saved.schema_version, 2); assert.equal(saved.definition.schema_version, 2)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.definition.cases[0].check_kind, 'json_object')
  assert.deepEqual(saved.cases.map(row => row.check), ['matched', 'mismatched', 'mismatched', 'matched', 'not_requested'])
  assert.deepEqual(saved.cases.map(row => row.snapshot.run.response.content),
    [' { "ok": true } ', '{"duplicate":1,"duplicate":2}', '{ }', '', 'anything'])
  assert.equal(f.calls.getPromptTrial.length, 0)
})

for (const status of ['truncated', 'refused', 'failed', 'timed_out', 'cancelled']) test(`v2 JSON checks remain unevaluated for ${status}`, async () => {
  const f = fixture(); await ready(f, jsonSuite()); await admit(f, status, '{}')
  const saved = JSON.parse(exportPromptSuiteReport(f.state().report))
  assert.equal(saved.schema_version, 2)
  assert.equal(saved.cases[0].check, 'not_evaluated')
  assert.equal(saved.cases[1].status, 'not_attempted')
  assert.equal(saved.status, 'halted')
  assert.equal(f.calls.startPromptTrial.length, 1)
})

test('v2 explicit reconciliation evaluates captured JSON mode without admitting later cases', async () => {
  const f = fixture(); await ready(f, jsonSuite())
  f.calls.startPromptTrial[0].reject(new Error('lost response')); await flush()
  f.calls.getPromptTrial[0].reject(new Error('lost observation')); await flush()
  assert.equal(f.state().report.cases[0].check, 'not_evaluated')
  f.runner.reconcile(); await flush()
  f.calls.getPromptTrial[1].resolve(ok(owned(f, 'succeeded', '{}'))); await flush(); await f.timers.advance(100000)
  const saved = JSON.parse(exportPromptSuiteReport(f.state().report))
  assert.equal(saved.schema_version, 2)
  assert.equal(saved.cases[0].check, 'matched')
  assert.equal(saved.cases[1].status, 'not_attempted')
  assert.equal(saved.status, 'halted')
  assert.equal(f.calls.startPromptTrial.length, 1)
})
