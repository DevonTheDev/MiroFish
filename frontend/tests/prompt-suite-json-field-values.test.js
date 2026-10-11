import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as suites from '../src/utils/promptSuites.js'
import { comparePromptSuiteReports, exportPromptSuiteComparison } from '../src/utils/promptSuiteComparison.js'
import * as examples from '../src/utils/promptExamples.js'
import { rule, item, definition, report, historicalReport, capturedAt, reviewedAt } from './helpers/prompt-field-values-fixture.js'
const accept = rules => suites.acceptPromptSuiteDefinition(definition([item(rules)]))
const evaluate = (rules,content,status='succeeded') => suites.evaluatePromptSuiteCheck(item(rules),status,content)
const literal = (type,value) => rule('value',type,value)
const failure = (rules,content,status='succeeded') => suites.getPromptSuiteCheckFailure(item(rules),status,content)

test('v4 admits detached primitive literals and ordered type-only rules without adding placeholders',()=>{
 const rules=[literal('string',''),rule('n','number',-0),rule('b','boolean',false),rule('nil','null',null),{name:'obj',type:'object'},{name:'arr',type:'array'}]
 const source=definition([item(rules)]),admitted=suites.acceptPromptSuiteDefinition(source)
 assert.equal(admitted.schema_version,4)
 assert.deepEqual(admitted.cases[0].required_fields,rules.map(r=>({...r,...(r.type==='number'?{equals:0}:{})})))
 assert.equal(Object.is(admitted.cases[0].required_fields[1].equals,-0),false)
 assert.deepEqual(Object.keys(admitted.cases[0].required_fields[0]),['name','type','equals'])
 assert.deepEqual(Object.keys(admitted.cases[0].required_fields[4]),['name','type'])
 source.cases[0].required_fields[0].equals='mutated'
 assert.equal(admitted.cases[0].required_fields[0].equals,'')
 assert.deepEqual(suites.parsePromptSuiteDefinition(suites.exportPromptSuiteDefinition(admitted)),admitted)
 for(const version of [1,2,3,5]) assert.throws(()=>suites.acceptPromptSuiteDefinition({...source,schema_version:version}))
})

test('v4 rejects inherited assertions, non-own required keys, unknown keys and sparse rules',()=>{
 const invalid=[Object.assign(Object.create({equals:0}),{name:'value',type:'number'}),Object.assign(Object.create({name:'value'}),{type:'number',equals:0}),
  Object.assign(Object.create({type:'number'}),{name:'value',equals:0}),{...rule(),extra:0},{...rule(),[Symbol('extra')]:0},null]
 for(const value of invalid)assert.throws(()=>accept([value]))
 assert.throws(()=>accept(new Array(1)))
 assert.throws(()=>accept([rule(),rule()]))
 const legacy=definition([item([Object.assign(Object.create({equals:0}),{name:'value',type:'number'})])],3)
 assert.doesNotThrow(()=>suites.acceptPromptSuiteDefinition(legacy),'legacy inherited property admission stays unchanged')
})

for(const [type,values] of [['string',[null,0,false,{},[],undefined,Symbol('x'),()=>0,1n]],['number',[null,'0',false,NaN,Infinity,-Infinity]],['boolean',[0,'false',null]],['null',['null',false,0]],['object',[{}]],['array',[[]]]])
 test(`v4 rejects invalid ${type} equals primitives`,()=>{for(const value of values)assert.throws(()=>accept([{name:'value',type,equals:value}]))})

for(const [type,value,other] of [['string','','x'],['string','false','False'],['number',0,1],['boolean',false,true],['null',null,'null']])
 test(`literal ${type} ${JSON.stringify(value)} never becomes a truthiness check`,()=>{
  const rules=[literal(type,value)]
  assert.equal(evaluate(rules,JSON.stringify({value,extra:{ok:true}})),'matched')
  for(const content of ['{}',JSON.stringify({value:other}),JSON.stringify({value:[value]})])assert.equal(evaluate(rules,content),'mismatched')
 })

test('string matching preserves whitespace, Unicode spelling and escape content',()=>{
 for(const value of ['',' ',' A ','\r\n\t','"\\','🦙','Å','A\u030a']){
  assert.doesNotThrow(()=>accept([literal('string',value)]))
  assert.equal(evaluate([literal('string',value)],JSON.stringify({value})),'matched')
  assert.equal(evaluate([literal('string',value)],JSON.stringify({value:value+' '})),'mismatched')
 }
 assert.equal(evaluate([literal('string','Å')],'{"value":"A\\u030a"}'),'mismatched')
 assert.doesNotThrow(()=>accept([literal('string','🦙'.repeat(500))]))
 for(const value of ['🦙'.repeat(501),'\0','\u000b','\u007f','\ud800','\udfff'])assert.throws(()=>accept([literal('string',value)]))
})

test('number equality follows documented JSON decoding and normalizes negative zero',()=>{
 for(const [expected,token] of [[3,'3'],[3,'3.0'],[3,'3e0'],[0,'-0'],[-0,'0'],[9007199254740992,'9007199254740993'],[1,'1.0000000000000001'],[0,'1e-400']]){
  const admitted=accept([literal('number',expected)])
  assert.equal(evaluate(admitted.cases[0].required_fields,`{"value":${token}}`),'matched')
  assert.deepEqual(suites.parsePromptSuiteDefinition(suites.exportPromptSuiteDefinition(admitted)),admitted)
 }
 assert.equal(evaluate([literal('number',0.1)],'{"value":0.2}'),'mismatched')
})

test('literal rules retain strict whole-object reply parser and inclusive byte/depth limits',()=>{
 const rules=[literal('number',0)]
 for(const content of ['```json\n{"value":0}\n```','\ufeff{"value":0}','{"value":0}x','{"value":0,"v\\u0061lue":0}',
  '{"value":0,"extra":1e999}','{"value":0,"extra":"\\ud800"}','[]','null'])assert.equal(evaluate(rules,content),'mismatched',content)
 const body='{"value":0,"padding":""}'
 const bounded='{"value":0,"padding":"'+'x'.repeat(65536-body.length)+'"}'
 assert.equal(Buffer.byteLength(bounded),65536);assert.equal(evaluate(rules,bounded),'matched');assert.equal(evaluate(rules,bounded+' '),'mismatched')
 const nested=depth=>' {"value":0,"extra":'+'['.repeat(depth)+'0'+']'.repeat(depth)+'}'
 assert.equal(evaluate(rules,nested(15)),'matched');assert.equal(evaluate(rules,nested(16)),'mismatched')
})

test('definition/report parsing keeps duplicate detection, bounds, ignored projection and replay',()=>{
 const source=definition(),raw=JSON.stringify(source)
 assert.throws(()=>suites.parsePromptSuiteDefinition(raw.replace('"equals":0','"equals":0,"equ\\u0061ls":0')))
 assert.throws(()=>suites.parsePromptSuiteDefinition(raw.replace('"name":"value"','"name":"value","n\\u0061me":"value"')))
 assert.deepEqual(suites.parsePromptSuiteDefinition(' '.repeat(131072-Buffer.byteLength(raw))+raw),suites.acceptPromptSuiteDefinition(source))
 assert.throws(()=>suites.parsePromptSuiteDefinition(' '.repeat(131073-Buffer.byteLength(raw))+raw))
 const original=report(),written=suites.exportPromptSuiteReport(original)
 assert.deepEqual(suites.parsePromptSuiteReport(written),suites.acceptPromptSuiteReport(original))
 assert.deepEqual(suites.parsePromptSuiteReport(' '.repeat(1048576-Buffer.byteLength(written))+written),suites.acceptPromptSuiteReport(original))
 assert.throws(()=>suites.parsePromptSuiteReport(' '.repeat(1048577-Buffer.byteLength(written))+written))
 const forged=structuredClone(original);forged.cases[0].check='mismatched';assert.throws(()=>suites.acceptPromptSuiteReport(forged))
 forged.cases[0].check='matched';forged.definition.cases[0].required_fields[0].equals=1;assert.throws(()=>suites.acceptPromptSuiteReport(forged))
 assert.throws(()=>suites.acceptPromptSuiteReport({...original,schema_version:3}))
 const ignored=JSON.stringify(original).replace('"snapshot":{','"snapshot":{"ignoredNumber":1e999,"ignoredText":"\\ud800",')
 assert.deepEqual(suites.parsePromptSuiteReport(ignored),suites.acceptPromptSuiteReport(original))
})

test('literal editor admits only one strict typed scalar within independent limits',()=>{
 assert.equal(typeof suites.parsePromptSuiteFieldLiteral,'function')
 for(const [raw,type,expected]of [[' "" ','string',''],['false','boolean',false],['-0','number',0],['null','null',null],['3e0','number',3],['" Å "','string',' Å ']])
  assert.deepEqual(suites.parsePromptSuiteFieldLiteral(raw,type),expected)
 for(const raw of ['',' ','"partial','0 1','```0```','{}','[]','[0]','NaN','1e999','\ufeff0','"\\ud800"','"\\u0000"'])assert.throws(()=>suites.parsePromptSuiteFieldLiteral(raw,'number'))
 assert.throws(()=>suites.parsePromptSuiteFieldLiteral('false','string'))
 assert.equal(suites.parsePromptSuiteFieldLiteral(' '.repeat(4095)+'0','number'),0)
 assert.throws(()=>suites.parsePromptSuiteFieldLiteral(' '.repeat(4096)+'0','number'))
 assert.throws(()=>suites.parsePromptSuiteFieldLiteral(JSON.stringify('🦙'.repeat(501)),'string'))
})

test('one first-failure path produces safe display-only diagnostics without false runtime failures',()=>{
 assert.equal(typeof suites.getPromptSuiteCheckFailure,'function')
 const rules=[literal('number',0),rule('ready','boolean',false)]
 for(const status of ['not_attempted','submitting','running','rejected','unknown','truncated','refused','failed','timed_out','cancelled']){
  assert.equal(evaluate(rules,'no',status),'not_evaluated');assert.equal(failure(rules,'no',status),null)
 }
 assert.deepEqual(failure(rules,'no'),{code:'invalid_object',params:{}})
 assert.deepEqual(failure(rules,'{}'),{code:'missing_field',params:{name:'"value"'}})
 assert.deepEqual(failure(rules,'{"value":"0"}'),{code:'type_mismatch',params:{name:'"value"',expectedType:'number',actualType:'string'}})
 assert.deepEqual(failure(rules,'{"value":1}'),{code:'literal_mismatch',params:{name:'"value"',expected:'0',actual:'1'}})
 assert.equal(failure(rules,'{"value":0,"ready":false}'),null)
 assert.equal(failure([{name:'value',type:'number'}],'{}'),null,'no new diagnostics for legacy type-only rules')
 assert.deepEqual(failure([literal('string','ok')],JSON.stringify({value:'x'.repeat(501)})),{code:'literal_mismatch_long_string',params:{name:'"value"',expected:'"ok"'}})
 const literalValue='<b>\u202e\u2028\u2066🦙'
 const formatted=suites.formatPromptSuiteRequiredFields(item([literal('string',literalValue),{name:'items',type:'array'}]))
 assert.equal(formatted,'"value": string = "<b>\\u202e\\u2028\\u2066🦙"\n"items": array')
 assert.equal(failure([literal('string','ok')],JSON.stringify({value:literalValue})).params.actual,'"<b>\\u202e\\u2028\\u2066🦙"')
})

const goldens=JSON.parse(readFileSync(new URL('./fixtures/prompt-field-values-legacy-goldens.json',import.meta.url),'utf8'))
for(const version of [1,2,3])test(`v${version} fixed definition/report/comparison/review/JSONL/draft bytes stay identical`,()=>{
 const source=historicalReport(version),capture=examples.capturePromptExampleSource(source),target=' {" value ":" Å ","ready":false} '
 const approval=examples.approvePromptExampleTarget(capture,source.definition.cases[2].case_id,target,{reviewedAt})
 const bundle=examples.exportPromptExamples(examples.buildPromptExamples(capture,[approval],{capturedAt}))
 const comparison=exportPromptSuiteComparison(comparePromptSuiteReports(source,historicalReport(version,11),{capturedAt}))
 const actual={definition:suites.exportPromptSuiteDefinition(source.definition),report:suites.exportPromptSuiteReport(source),comparisonJson:comparison.json_text,comparisonText:comparison.text,
  review:bundle.review_json_text,jsonl:bundle.jsonl_text,draft:examples.exportPromptExampleDraft(examples.capturePromptExampleDraft(capture,source.definition.cases.map((item,index)=>({case_id:item.case_id,target_text:index===2?target:''})),{capturedAt})).draft_json_text}
 assert.deepEqual(actual,goldens[version])
})

test('diagnostics escape DEL and C1 from a parsed actual string',()=>{
 assert.deepEqual(failure([literal('string','ok')],'{"value":"\u007f\u0085\u009f"}'),
  {code:'literal_mismatch',params:{name:'"value"',expected:'"ok"',actual:'"\\u007f\\u0085\\u009f"'}})
})
