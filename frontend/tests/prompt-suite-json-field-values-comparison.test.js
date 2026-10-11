import assert from 'node:assert/strict'
import test from 'node:test'
import { comparePromptSuiteReports, exportPromptSuiteComparison } from '../src/utils/promptSuiteComparison.js'
import { report, rule, item, capturedAt, historicalReport } from './helpers/prompt-field-values-fixture.js'
const compare=(a,b)=>comparePromptSuiteReports(a,b,{capturedAt})
test('v4 pairs reordered mappings and keeps raw reply equality independent',()=>{
 const rules=[rule(),rule('nil','null',null),rule('ready','boolean',false),{name:'items',type:'array'}]
 const left=report(10,[item(rules)],['{"value":0,"nil":null,"ready":false,"items":[]}'])
 const right=report(11,[item([...rules].reverse())],['{ "value":0,"nil":null,"ready":false,"items":[]}'])
 const capture=compare(left,right),result=capture.toReport()
 assert.equal(result.schema_version,4);assert.equal(result.rows[0].same_inputs,true);assert.equal(result.rows[0].check_transition,'retained_match');assert.equal(result.rows[0].reply_equal,false)
 assert.deepEqual(result.comparison.definition.cases[0].required_fields,[...rules].reverse())
 const output=exportPromptSuiteComparison(capture)
 assert.match(output.text,/literal primitive values/)
 left.definition.cases[0].required_fields[0].equals=9;result.comparison.definition.cases[0].required_fields[0].equals=99
 assert.deepEqual(exportPromptSuiteComparison(capture),output)
})
for(const [name,left,right]of [['value',[rule()],[rule('value','number',1)]],['added',[{name:'value',type:'number'}],[rule()]],['removed',[rule()],[{name:'value',type:'number'}]],['null presence',[{name:'value',type:'null'}],[rule('value','null',null)]],['false',[rule('value','boolean',false)],[rule('value','boolean',true)]],['empty',[rule('value','string','')],[rule('value','string',' ')] ]])test(`changed ${name} excludes every paired finding`,()=>{
 const row=compare(report(10,[item(left)],['{}']),report(11,[item(right)],['{}'])).toReport().rows[0]
 assert.equal(row.input_changes.required_fields,true)
 assert.deepEqual([row.same_inputs,row.paired_succeeded,row.check_transition,row.reply_equal,row.request_duration_delta_ms],[false,false,null,null,null])
})
test('v1-v3 equivalent type-only cases compare with v4 in both directions without rewriting sources',()=>{
 for(const version of [1,2,3]){
  const old=historicalReport(version),modern=historicalReport(version,11)
  modern.schema_version=4;modern.definition.schema_version=4
  for(const input of modern.definition.cases){input.check_kind ??= input.expected_text===null?'none':'exact_text';input.required_fields??=null}
  for(const [a,b]of [[old,modern],[modern,old]]){
   const result=compare(a,b).toReport();assert.equal(result.schema_version,4)
   assert.ok(result.rows.every(r=>r.paired_succeeded));assert.equal(result.baseline.schema_version,a.schema_version);assert.equal(result.comparison.schema_version,b.schema_version)
  }
 }
})
test('numeric negative zero compares as normalized zero',()=>{
 const row=compare(report(10,[item([rule('value','number',-0)])]),report(11)).toReport().rows[0]
 assert.equal(row.same_inputs,true);assert.equal(row.check_transition,'retained_match')
})

import { mountSuiteComparison } from './helpers/prompt-suite-comparison-view-fixture.js'
import { reportFile } from './helpers/prompt-field-values-fixture.js'
for(const locale of ['en','zh'])test(`v4 comparison safely previews literals and diagnoses both captured replies offline in ${locale}`,async()=>{
 const view=await mountSuiteComparison({locale})
 try {
  const rules=[rule('value','string','<b>\u202e\u2028'),rule('ready','boolean',false)]
  for(const [side,number,actual]of [['baseline',10,'old'],['comparison',11,'new']]){
   await view.file(side,reportFile(report(number,[item(rules)],[JSON.stringify({value:actual,ready:false})])))
   const preview=view.byId(`comparison-${side}-preview-case-0-required-fields`)
   assert.ok(preview);assert.equal(view.text(preview),'"value": string = "<b>\\u202e\\u2028"\n"ready": boolean = false')
   await view.click(`comparison-${side}-use`)
  }
  await view.click('comparison-run')
  for(const [side,actual]of [['baseline','old'],['comparison','new']]){
   assert.match(view.text(view.byId(`comparison-row-0-${side}-required-fields`)), / = /)
   const failure=view.byId(`comparison-row-0-${side}-failure`);assert.ok(failure);assert.ok(view.text(failure).includes(JSON.stringify(actual)))
  }
  assert.equal(view.all(node=>['b','script'].includes(node.type)||node.props.innerHTML!==undefined).length,0)
  assert.deepEqual(view.warnings,[])
  for(const calls of Object.values(view.requests.calls))assert.equal(calls.length,0)
 }finally{view.unmount()}
})

test('v4 overlap anywhere in the opposite report and nonsucceeded rows exclude paired findings',()=>{
 const left=report(10,[item(),item([rule()],2)],['{"value":0}','{"value":0}'])
 const right=report(11,[item(),item([rule()],3)],['{"value":0}','{"value":0}'])
 right.cases[1].request_id=left.cases[0].request_id;right.cases[1].snapshot.run.request_id=left.cases[0].request_id
 const row=compare(left,right).toReport().rows[0]
 assert.equal(row.request_id_overlap,true)
 assert.deepEqual([row.paired_succeeded,row.check_transition,row.reply_equal,row.request_duration_delta_ms],[false,null,null,null])
 const failed=report(12);failed.status='halted';failed.halt_code='runtime_failed'
 failed.cases[0].status='truncated';failed.cases[0].check='not_evaluated';failed.cases[0].snapshot.run.state='truncated';failed.cases[0].snapshot.run.response.finish_reason='length'
 const excluded=compare(report(),failed).toReport().rows[0]
 assert.equal(excluded.same_inputs,true)
 assert.deepEqual([excluded.paired_succeeded,excluded.check_transition,excluded.reply_equal,excluded.request_duration_delta_ms],[false,null,null,null])
})
