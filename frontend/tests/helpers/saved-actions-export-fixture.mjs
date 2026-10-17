import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { mountSavedActivity } from './saved-activity-view-fixture.js'

const require = createRequire(process.env.MIRO_TEST_TOOLCHAIN ? path.join(process.env.MIRO_TEST_TOOLCHAIN, 'package.json') : import.meta.url)
export const Vue = require('vue')
const { parse: parseJavaScript } = require('@babel/parser')
const source = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8')
export const messages = JSON.parse(readFileSync(new URL('../../../locales/en.json', import.meta.url), 'utf8'))
export const revision = 'a'.repeat(64), simulationId = 'sim_export'
export const bytes = value => new TextEncoder().encode(JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')) + '\n')
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export async function settle() { for (let index = 0; index < 12; index++) { await Promise.resolve(); await Vue.nextTick() } }
export const text = node => (node?.text ?? '') + (node?.children ?? []).map(text).join(' ')
export function envelope(count = 1) {
  return {
    format: 'mirofish-saved-actions', version: 1, simulation_id: simulationId, source_revision: revision, observed_at: '2026-10-17T00:00:00+00:00',
    context: { status: 'completed', created_at: null, updated_at: null, started_at: null, completed_at: null, requested_rounds: '1', last_saved_round: '0' },
    availability: 'complete', sources: ['twitter'], platform_coverage: { twitter: { enabled: true, availability: 'complete', source: 'twitter', recorded_actions: count }, reddit: { enabled: false, availability: 'unavailable', source: null, recorded_actions: null } }, warnings: [],
    order: 'source_record', scope: 'all_saved_actions', truncated: false, record_count: count,
    actions: Array.from({ length: count }, (_, index) => ({ record_id: `twitter:${index + 1}`, platform: 'twitter', agent_id: '9007199254740993', round_num: '0', agent_name: null, timestamp: null, action_type: 'CREATE_POST', success: null, details_json: '{"agent_id":9007199254740993,"text":"\\ud83c\\udf31"}' }))
  }
}
export function page(id = simulationId, status = 'completed') {
  const data = envelope(); data.simulation_id = id; data.context.status = status
  return { simulation_id: id, source_revision: revision, observed_at: data.observed_at, context: data.context, availability: 'complete', platform_availability: { twitter: 'complete', reddit: 'unavailable' }, warnings: [], filters: { platform: null, agent_id: null, round_num: null, action_type: null, q: null, case_sensitive: false, outcome: null }, order: 'source_record', offset: 0, limit: 50, returned_count: 1, matched_count: 2, has_more: true, actions: data.actions.map(row => ({ ...row, match_preview: null })) }
}
function evaluate(code, imports = {}, globals = {}, result) {
  const ast = parseJavaScript(code, { sourceType: 'module' })
  const context = { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController, setTimeout, clearTimeout, URL, console, ...globals }
  const exports = []
  for (const statement of ast.program.body.slice().reverse()) {
    if (statement.type === 'ImportDeclaration') {
      const dependency = imports[statement.source.value]
      assert.ok(dependency, `explicit module boundary for ${statement.source.value}`)
      for (const specifier of statement.specifiers) context[specifier.local.name] = specifier.type === 'ImportDefaultSpecifier' ? dependency.default : dependency[specifier.imported.name]
      code = code.slice(0, statement.start) + code.slice(statement.end)
    } else if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      const declaration = statement.declaration
      if (declaration.type === 'VariableDeclaration') exports.push(...declaration.declarations.map(item => item.id.name))
      else exports.push(declaration.id.name)
      code = code.slice(0, statement.start) + code.slice(declaration.start)
    } else if (statement.type === 'ExportDefaultDeclaration') {
      code = code.slice(0, statement.start) + 'const component = ' + code.slice(statement.declaration.start)
    }
  }
  return vm.runInNewContext(code + `\n;${result ?? `({${exports.join(',')}})`}`, context)
}
const boundedJson = evaluate(source('utils/boundedJson.js'))
export const validation = evaluate(source('utils/savedActionsExport.js'), { './boundedJson.js': boundedJson })
export function transport(fetch, options = {}) {
  const defaults = { baseURL: 'https://example.invalid/base/', timeout: 0, ...options.defaults }
  return evaluate(source('api/savedActionsExport.js'), {
    './index': { default: { defaults } }, '../i18n': { default: { global: { locale: { value: options.language ?? 'en' } } } },
    '../utils/boundedJson.js': boundedJson, '../utils/savedActionsExport.js': validation
  }, { fetch, ...options.globals }).getSavedActionsExport
}
export function response(payload, options = {}) {
  const chunks = options.chunks ?? [bytes(payload)], state = { reads: 0, cancelled: 0, released: 0 }
  const reader = { async read() { const index = state.reads++; if (options.read) return options.read(index); return index < chunks.length ? { value: chunks[index], done: false } : { done: true } }, cancel() { state.cancelled++; return Promise.resolve() }, releaseLock() { state.released++ } }
  return { state, status: options.status ?? 200, ok: (options.status ?? 200) < 300, headers: new Headers({ 'Content-Type': 'application/json', ...options.headers }), body: options.noReader ? {} : { getReader: () => reader } }
}
export async function mounted(options = {}) {
  const requests = [], pageRequests = [], hooks = options.hooks ?? {}
  const api = {
    getSavedActivity(...args) { pageRequests.push(args); return Promise.resolve({ success: true, data: options.page?.(...args) ?? page(args[0], options.status) }) },
    getSavedActionsExport(...args) { const pending = deferred(); requests.push({ ...pending, args }); return options.exportApi ? options.exportApi(...args) : pending.promise }
  }
  const h = await mountSavedActivity({ api, initialPath: options.initialPath ?? `/simulation/${simulationId}/activity?revision=${revision}`, locale: options.locale ?? 'en', downloadHooks: hooks })
  return { ...h, requests, pageRequests, hooks, revoked: h.revokedUrls, close: h.unmount }
}
