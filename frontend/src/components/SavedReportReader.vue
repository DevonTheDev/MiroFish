<template>
  <div class="saved-reader">
    <div class="find-controls" :aria-label="t('savedReportSearch.label')">
      <label for="report-find">{{ t('savedReportSearch.label') }}</label>
      <textarea id="report-find" data-testid="report-find" rows="2" :value="state.query" :disabled="!searchable" :aria-invalid="String(state.tooLong)" aria-describedby="report-find-note report-find-status" :onInput="actions.input" />
      <div class="find-actions">
        <label class="case-control"><input type="checkbox" data-testid="report-find-case" :checked="state.matchCase" :disabled="!searchable" :onChange="actions.matchCase" />{{ t('savedReportSearch.matchCase') }}</label>
        <button type="button" data-testid="report-find-previous" :disabled="!state.result.matches.length" :onClick="actions.previous">{{ t('savedReportSearch.previous') }}</button>
        <button type="button" data-testid="report-find-next" :disabled="!state.result.matches.length" :onClick="actions.next">{{ t('savedReportSearch.next') }}</button>
        <button type="button" data-testid="report-find-clear" :disabled="!state.query && !state.tooLong" :onClick="actions.clear">{{ t('savedReportSearch.clear') }}</button>
      </div>
      <p id="report-find-note" class="note">{{ t('savedReportSearch.note') }}</p>
      <p id="report-find-status" data-testid="report-find-status" role="status" aria-live="polite" aria-atomic="true">{{ status }}</p>
    </div>
    <template v-if="source.content_available">
      <p v-if="source.markdown_content === ''" class="notice" data-testid="empty-content">{{ t('savedReports.emptyContent') }}</p>
      <pre v-if="state.result.matches.length" data-testid="markdown" tabindex="0" :aria-label="t('savedReports.markdownLabel')"><template v-for="part in parts" :key="part.key"><mark v-if="part.match !== undefined" :ref="element => rememberMatch(part.match, element)" :class="{ current: part.match === state.current }" :aria-current="part.match === state.current ? 'true' : undefined">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></pre>
      <pre v-else data-testid="markdown" tabindex="0" :aria-label="t('savedReports.markdownLabel')">{{ source.markdown_content }}</pre>
    </template>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { boundReportQuery, createReportSearchIndex, findReportPassages } from '../utils/savedReportSearch.js'

const props = defineProps({ source: { type: Object, required: true }, isCurrent: { type: Function, required: true } })
const { t, locale } = useI18n()
const state = shallowRef(null)
const elements = new Map()
let disposed = false
let searchIndex = null
const searchable = computed(() => props.source.content_available && props.source.markdown_content !== '')
function owns(snapshot) {
  // Parent ownership retires callbacks immediately, before a null/replacement
  // prop or unmount reaches this child. State identity also retires older finds.
  return !disposed && state.value === snapshot && props.source === snapshot.source && props.isCurrent(snapshot.source)
}
watch(() => props.source, source => {
  elements.clear()
  searchIndex = null
  state.value = { source, query: '', tooLong: false, matchCase: false, result: { matches: [], more: false }, current: 0 }
}, { immediate: true, flush: 'sync' })
function rememberMatch(index, element) {
  if (element) elements.set(index, element)
  else elements.delete(index)
}
function scrollToCurrent(snapshot) {
  nextTick(() => {
    if (!owns(snapshot)) return
    const element = elements.get(snapshot.current)
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function search(snapshot, changes) {
  if (!owns(snapshot) || !searchable.value) return
  const next = { ...snapshot, ...changes, current: 0 }
  next.result = next.tooLong || !next.query ? { matches: [], more: false }
    : findReportPassages(searchIndex ??= createReportSearchIndex(next.source.markdown_content), next.query, next.matchCase)
  state.value = next
  if (next.result.matches.length) scrollToCurrent(next)
}
function move(snapshot, direction) {
  if (!owns(snapshot) || !snapshot.result.matches.length) return
  const count = snapshot.result.matches.length
  const next = { ...snapshot, current: (snapshot.current + direction + count) % count }
  state.value = next; scrollToCurrent(next)
}
const actions = computed(() => {
  const snapshot = state.value
  return {
    input: event => {
      if (!owns(snapshot)) return
      const bounded = boundReportQuery(event.target.value)
      event.target.value = bounded.query
      search(snapshot, bounded)
    },
    matchCase: event => search(snapshot, { matchCase: event.target.checked }),
    clear: () => search(snapshot, { query: '', tooLong: false }),
    previous: () => move(snapshot, -1), next: () => move(snapshot, 1),
  }
})
const status = computed(() => {
  const snapshot = state.value
  if (!props.source.content_available) return t('savedReportSearch.unavailable')
  if (!searchable.value) return t('savedReportSearch.emptyBody')
  if (snapshot.tooLong) return t('savedReportSearch.tooLong')
  if (!snapshot.query) return t('savedReportSearch.prompt')
  if (!snapshot.result.matches.length) return t('savedReportSearch.noMatches')
  const number = value => new Intl.NumberFormat(locale.value).format(value)
  return t(snapshot.result.more ? 'savedReportSearch.limited' : 'savedReportSearch.count', { current: number(snapshot.current + 1), count: number(snapshot.result.matches.length) })
})
const parts = computed(() => {
  const { source, result } = state.value, parts = []
  let start = 0
  result.matches.forEach((match, index) => {
    if (match.start > start) parts.push({ key: `text-${start}`, text: source.markdown_content.slice(start, match.start) })
    parts.push({ key: `match-${index}`, match: index, text: source.markdown_content.slice(match.start, match.end) })
    start = match.end
  })
  if (start < source.markdown_content.length) parts.push({ key: `text-${start}`, text: source.markdown_content.slice(start) })
  return parts
})
onBeforeUnmount(() => { disposed = true; searchIndex = null; elements.clear() })
</script>

<style scoped>
.find-controls { margin-top: 20px; padding: 16px; border: 1px solid #d7dde5; border-radius: 8px; background: #f8f9fb; }label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; }textarea { box-sizing: border-box; width: 100%; min-height: 44px; resize: vertical; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; color: #202329; background: #fff; }.find-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }.case-control { display: flex; align-items: center; gap: 8px; margin: 0 10px 0 0; min-height: 44px; }input[type=checkbox] { width: 18px; height: 18px; }button { cursor: pointer; border: 1px solid #c8cfd9; border-radius: 7px; padding: 10px 14px; min-height: 44px; font: inherit; font-size: 14px; color: #28323f; background: #fff; }button:hover:enabled { background: #edf1f6; }button:disabled, textarea:disabled, input:disabled { opacity: .55; cursor: not-allowed; }button:focus-visible, textarea:focus-visible, input:focus-visible, pre:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }.note { color: #68707c; font-size: 13px; line-height: 1.6; }.notice { padding: 14px; border-radius: 8px; background: #edf1f6; }[role=status] { margin-bottom: 0; line-height: 1.6; }pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 13px/1.65 monospace; max-height: 720px; overflow-y: auto; tab-size: 4; }mark { background: #fff0a6; color: #202329; }mark.current { background: #254f83; color: #fff; outline: 2px solid #254f83; text-decoration: underline; text-underline-offset: 2px; }
</style>
