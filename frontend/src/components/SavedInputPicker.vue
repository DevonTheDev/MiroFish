<template>
  <div class="saved-input-picker" data-testid="saved-input-picker">
    <button ref="opener" type="button" data-testid="saved-input-open" :aria-expanded="opened"
      aria-controls="saved-input-region" :disabled="!controls.open" :onClick="controls.open">{{ $t('savedInputs.open') }}</button>
    <section v-if="opened" id="saved-input-region" aria-labelledby="saved-input-heading" :aria-busy="busy">
      <div class="saved-input-heading">
        <h3 id="saved-input-heading" ref="heading" tabindex="-1">{{ $t('savedInputs.open') }}</h3>
        <button type="button" data-testid="saved-input-refresh" :disabled="busy" :onClick="controls.refresh">{{ $t('savedInputs.refresh') }}</button>
        <button type="button" data-testid="saved-input-close" :onClick="controls.close">{{ $t('common.close') }}</button>
      </div>
      <p>{{ $t('savedInputs.candidateNote') }}</p>
      <p v-if="busy" role="status" data-testid="saved-input-loading">{{ $t('savedInputs.loading') }}</p>
      <div v-else-if="failed" role="alert" data-testid="saved-input-error">
        <p>{{ $t('savedInputs.failed') }}</p>
        <button type="button" data-testid="saved-input-retry" :onClick="controls.refresh">{{ $t('savedInputs.retry') }}</button>
      </div>
      <template v-else-if="observation">
        <p v-if="observation.partial" role="status" data-testid="saved-input-partial">{{ $t(rows.length ? 'savedInputs.partial' : 'savedInputs.partialEmpty', { count: rows.length }) }}</p>
        <p v-else-if="!rows.length" role="status" data-testid="saved-input-empty">{{ $t('savedInputs.empty') }}</p>
        <p v-else role="status">{{ $t('savedInputs.found', { count: rows.length }) }}</p>
        <p v-if="observation.directory_changed" data-testid="saved-input-directory-changed">{{ $t('savedInputs.directoryChanged') }}</p>
        <details class="saved-input-limits">
          <summary>{{ $t('savedInputs.scanDetails') }}</summary>
          <p>{{ $t('savedInputs.limitNote', { entries: observation.limits.entries, rows: observation.limits.rows }) }}</p>
          <p>{{ $t('savedInputs.stop.' + observation.stop_reason) }}</p>
          <p>{{ $t('savedInputs.scanCounts', { examined: observation.examined_entries, bytes: observation.metadata_bytes_budgeted, deferred: observation.budget_deferred }) }}</p>
          <ul>
            <li v-for="reason in skipReasons" :key="reason">{{ $t('savedInputs.skip.' + reason) }}: {{ observation.skipped[reason] }}</li>
          </ul>
        </details>
        <ul class="saved-input-rows" data-testid="saved-input-rows">
          <li v-for="entry in rows" :key="entry.row.project_id">
            <button type="button" class="saved-input-row" data-testid="saved-input-row" :data-project-id="entry.row.project_id"
              :aria-pressed="selected === entry.row" :onClick="entry.select">
              <strong>{{ entry.row.name || $t('savedInputs.unnamed') }}</strong>
              <span>{{ entry.row.project_id }}</span>
              <span>{{ $t('savedInputs.status.' + entry.row.status) }}</span>
              <span v-if="entry.row.updated_at || entry.row.created_at">
                {{ $t(entry.row.updated_at ? 'savedInputs.updated' : 'savedInputs.created') }}: {{ entry.row.updated_at || entry.row.created_at }}
                <span v-if="withoutZone(entry.row.updated_at || entry.row.created_at)">({{ $t('savedInputs.noTimeZone') }})</span>
              </span>
              <span v-else>{{ $t('savedInputs.noDate') }}</span>
              <span v-if="entry.row.name_truncated">{{ $t('savedInputs.nameTruncated') }}</span>
            </button>
          </li>
        </ul>
        <div v-if="selected" class="saved-input-detail" data-testid="saved-input-detail">
          <h4>{{ $t('savedInputs.scenario') }}</h4>
          <p data-testid="saved-input-scenario">{{ selected.scenario_excerpt || $t('savedInputs.noScenario') }}</p>
          <p v-if="selected.scenario_truncated">{{ $t('savedInputs.scenarioTruncated') }}</p>
          <ProjectInputRecipeDownload :project-id="selected.project_id" :selection="downloadSelection" />
        </div>
      </template>
    </section>
  </div>
</template>

<script setup>
import { ref, shallowRef, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getProjectInputCandidates } from '../api/projectInputCandidates'
import ProjectInputRecipeDownload from './ProjectInputRecipeDownload.vue'

const props = defineProps({ homeAvailable: { type: Function, required: true } })
const router = useRouter()
const opened = ref(false)
const busy = ref(false)
const failed = ref(false)
const observation = shallowRef(null)
const rows = shallowRef([])
const selected = shallowRef(null)
const selectionOwner = shallowRef(null)
const controls = shallowRef({})
const opener = ref(null)
const heading = ref(null)
const skipReasons = ['unsafe', 'missing', 'too_large', 'invalid', 'changed', 'unreadable']
// Truthy mismatch is intentional: the existing downloader permits absent
// selection. A null getter would let a stale projectId prop rearm it.
const revokedSelection = Object.freeze({ project_id: null })
let active = true
let generation = null
let request = null
let closedToken = null
let focusToken = null
const available = () => active && props.homeAvailable() === true && router.currentRoute.value.name === 'Home'
const owns = target => Boolean(target) && available() && opened.value && generation === target
  && router.currentRoute.value === target.route
const ownsRequest = token => request === token && owns(token.generation)
const ownsClosed = token => Boolean(token) && available() && !opened.value && closedToken === token
  && router.currentRoute.value === token.route
const withoutZone = value => !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)

const retire = () => {
  generation = null
  closedToken = null
  focusToken = null
  selectionOwner.value = null
  selected.value = null
  rows.value = []
  observation.value = null
  opened.value = false
  controls.value = {}
  failed.value = false
  busy.value = false
  const previous = request
  request = null
  previous?.controller.abort()
}
const downloadSelection = () => {
  const owner = selectionOwner.value
  return owner && owns(owner.generation) && selected.value === owner.row
    && rows.value.some(entry => entry.row === owner.row) ? owner.row : revokedSelection
}
const select = (target, row) => {
  if (!owns(target) || busy.value || !rows.value.some(entry => entry.row === row)) return
  // Re-selecting even the same ID has a fresh authority object.
  selectionOwner.value = null
  selected.value = row
  selectionOwner.value = { generation: target, row }
}
const load = async target => {
  if (!owns(target)) return
  const token = { generation: target, controller: new AbortController() }
  request = token
  busy.value = true
  try {
    const result = await getProjectInputCandidates(token.controller.signal)
    if (!ownsRequest(token)) return
    observation.value = result
    rows.value = Object.freeze(result.items.map(row => Object.freeze({ row, select: () => select(target, row) })))
  } catch {
    if (ownsRequest(token)) failed.value = true
  } finally {
    if (ownsRequest(token)) { busy.value = false; request = null }
  }
}
const begin = (route, focusHeading = false) => {
  retire()
  if (!available() || router.currentRoute.value !== route) return
  const target = { route }
  generation = target
  opened.value = true
  controls.value = {
    refresh: () => { if (owns(target) && !busy.value) begin(route) },
    close: () => close(target),
  }
  if (focusHeading) {
    const token = {}
    focusToken = token
    nextTick(() => {
      if (focusToken === token && owns(target) && heading.value?.isConnected) heading.value.focus()
    })
  }
  return load(target)
}
const armClosed = () => {
  if (!available()) return
  const token = { route: router.currentRoute.value }
  closedToken = token
  controls.value = { open: () => { if (ownsClosed(token)) return begin(token.route, true) } }
  return token
}
const close = target => {
  if (!owns(target)) return
  retire()
  const token = armClosed()
  focusToken = token
  nextTick(() => {
    if (focusToken === token && ownsClosed(token) && opener.value?.isConnected) opener.value.focus()
  })
}
// loading changes synchronously before Vue's v-if teardown. The generation is
// permanently retired even if Start fails and availability returns before render.
watch([() => props.homeAvailable(), () => router.currentRoute.value], () => {
  retire()
  armClosed()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { active = false; retire() })
</script>

<style scoped>
.saved-input-picker { margin-top: 12px; font-size: 0.82rem; line-height: 1.5; min-width: 0; }
.saved-input-picker button { padding: 8px 12px; cursor: pointer; }
.saved-input-picker button:disabled { cursor: default; }
.saved-input-picker button:focus-visible, .saved-input-picker summary:focus-visible,
.saved-input-picker h3:focus { outline: 2px solid currentColor; outline-offset: 3px; }
.saved-input-picker section { margin-top: 12px; padding: 12px; border: 1px solid #c9cdd2; }
.saved-input-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.saved-input-heading h3 { flex: 1 1 10rem; margin: 0; }
.saved-input-rows { list-style: none; padding: 0; display: grid; gap: 8px; }
.saved-input-row { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left; gap: 3px; }
.saved-input-row[aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: -2px; }
.saved-input-picker p, .saved-input-row span, .saved-input-row strong { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.saved-input-detail { padding-top: 10px; border-top: 1px solid #c9cdd2; }
.saved-input-limits summary { cursor: pointer; }
@media (max-width: 480px) { .saved-input-picker section { padding: 8px; } }
</style>
