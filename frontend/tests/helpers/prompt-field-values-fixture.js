import { trialRequest, trialSnapshot } from './prompt-trials-view-fixture.js'
import { acceptPromptTrialInputs } from '../../src/api/promptTrials.js'
import { evaluatePromptSuiteCheck } from '../../src/utils/promptSuites.js'
export const id = number => `12345678-1234-4234-9234-${String(number).padStart(12, '0')}`
export const capturedAt = '2026-10-04T01:00:01Z'
export const reviewedAt = '2026-10-04T01:00:00Z'
export const rule = (name = 'value', type = 'number', equals = 0) => ({ name, type, equals })
export const item = (rules = [rule()], number = 1) => ({ case_id: id(number), ...trialRequest(), check_kind: 'json_fields', expected_text: null, required_fields: rules })
export const definition = (cases = [item()], version = 4) => ({ schema_version: version, kind: 'mirofish_local_prompt_suite', name: 'Literal expectations 🦙', cases })
export function report(run = 10, inputs = [item()], replies = ['{"value":0}'], version = 4) {
 return { schema_version: version, kind: 'mirofish_local_prompt_suite_run', run_id: id(run), definition: definition(inputs, version),
  started_at: '2026-10-03T12:59:59Z', finished_at: '2026-10-03T13:00:00Z', status: 'completed', stop_requested: false, halt_code: null,
  cases: inputs.map((input, index) => {
   const snapshot = trialSnapshot('succeeded')
   snapshot.run.request_id = id(run * 100 + index); snapshot.run.request = acceptPromptTrialInputs(input); snapshot.run.response.content = replies[index]
   return { case_id: input.case_id, request_id: snapshot.run.request_id, status: 'succeeded', check: evaluatePromptSuiteCheck(input, 'succeeded', replies[index]), snapshot, error_code: null }
  }) }
}
export function historicalReport(version, run = 10) {
 const inputs = [null, '', 'Å\r\n'].map((value,index) => ({ case_id:id(index+1), ...trialRequest(),
  ...(version >= 2 ? {check_kind: index === 0 ? 'none' : index === 1 ? 'exact_text' : version === 3 ? 'json_fields' : 'json_object'} : {}),
  expected_text: version === 1 ? value : index === 1 ? '' : null,
  ...(version === 3 ? {required_fields:index === 2 ? [{name:' value ',type:'string'},{name:'ready',type:'boolean'}] : null} : {}) }))
 return report(run,inputs,['anything','',version === 1 ? 'Å\r\n' : version === 3 ? '{" value ":" Å ","ready":false}' : '{}'],version)
}
export const definitionFile = source => { const text=JSON.stringify(source);return {size:new TextEncoder().encode(text).length,text:async()=>text} }
export const reportFile = source => { const bytes=new TextEncoder().encode(JSON.stringify(source));return {size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer} }
