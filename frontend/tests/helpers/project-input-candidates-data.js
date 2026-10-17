import { readFileSync } from 'node:fs'
import vm from 'node:vm'

export const row = (id = 'project_A', patch = {}) => ({ project_id: id, name: 'Saved project', name_truncated: false,
  status: 'failed', created_at: '2026-10-17T11:00:00', updated_at: null, scenario_excerpt: 'Scenario', scenario_truncated: false, ...patch })
export const envelope = (items = [row()], patch = {}) => ({ success: true, data: { items, examined_entries: items.length,
  returned: items.length, metadata_bytes_budgeted: 300 * items.length, budget_deferred: 0,
  skipped: { unsafe: 0, missing: 0, too_large: 0, invalid: 0, changed: 0, unreadable: 0 }, stop_reason: 'end', directory_changed: false,
  partial: false, limits: { entries: 256, rows: 50, metadata_file_bytes: 1048576, metadata_total_bytes: 8388608 }, ...patch } })
export function adapter(fetch) {
  const source = readFileSync(new URL('../../src/api/projectInputCandidates.js', import.meta.url), 'utf8')
  return vm.runInNewContext(source.replace(/^import .*$/gm, '').replace(/export /g, '').replace('import.meta.env', 'environment')
    + '\n;({ getProjectInputCandidates, validateProjectInputCandidates })', {
    TextEncoder, TextDecoder, Uint8Array, AbortController, Set, i18n: { global: { locale: { value: 'zh' } } },
    environment: { VITE_API_BASE_URL: 'https://selected.example/' }, fetch,
    console: { error() { throw new Error('Raw response logging is forbidden') }, warn() { throw new Error('Raw response logging is forbidden') } },
  })
}
