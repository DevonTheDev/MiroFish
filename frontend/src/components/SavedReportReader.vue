<template>
  <div class="saved-reader">
    <div class="copy-controls">
      <button type="button" data-testid="copy-saved-markdown" :disabled="!searchable || savedReportClipboardBusy" :onClick="copyAction">{{ t('savedReportCopy.label') }}</button>
      <p data-testid="copy-saved-markdown-status" role="status" aria-live="polite" aria-atomic="true">{{ copyMessage }}</p>
    </div>
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
    <div class="heading-controls">
      <label for="report-heading">{{ t('savedReportHeadings.label') }}</label>
      <div class="heading-actions">
        <select id="report-heading" data-testid="report-heading" :value="selection.heading === null ? '' : String(selection.heading.lineStart)" :disabled="!headingOwner.index.headings.length" aria-describedby="report-heading-note report-heading-status" :onChange="headingActions.select">
          <option value="">{{ t('savedReportHeadings.choose') }}</option>
          <option v-for="heading in headingOwner.index.headings" :key="heading.lineStart" :value="String(heading.lineStart)">{{ headingLabel(heading) }}</option>
        </select>
        <button type="button" data-testid="report-heading-jump" :disabled="selection.heading === null" :onClick="headingActions.jump">{{ t('savedReportHeadings.jump') }}</button>
      </div>
      <p id="report-heading-note" class="note">{{ t('savedReportHeadings.note') }}</p>
      <p id="report-heading-status" data-testid="report-heading-status" role="status" aria-live="polite" aria-atomic="true">{{ headingStatus }}</p>
    </div>
    <template v-if="source.content_available">
      <p v-if="source.markdown_content === ''" class="notice" data-testid="empty-content">{{ t('savedReports.emptyContent') }}</p>
      <template v-for="render in rendered" :key="'literal-body'">
        <pre data-testid="markdown" tabindex="0" :aria-label="t('savedReports.markdownLabel')"><template v-for="part in render.parts" :key="part.key"><component :is="part.match === undefined ? 'span' : 'mark'" :ref="part.remember" :class="{ current: part.match !== undefined && part.match === state.current }" :aria-current="part.match !== undefined && part.match === state.current ? 'true' : undefined"><template v-for="piece in part.children" :key="piece.key"><span v-if="piece.heading" class="report-heading-target" :data-heading-offset="piece.heading.lineStart" :ref="piece.remember" tabindex="-1" role="heading" :aria-level="piece.heading.level" :aria-label="headingLabel(piece.heading)">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></component></template></pre>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch, nextTick, onBeforeUpdate, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { indexReportHeadings, segmentReportText } from '../utils/savedReportHeadings.js'
import { boundReportQuery, createReportSearchIndex, findReportPassages } from '../utils/savedReportSearch.js'
import { acquireSavedReportClipboard, savedReportClipboardBusy } from '../utils/savedReportClipboard.js'

const props = defineProps({ source: { type: Object, required: true }, isCurrent: { type: Function, required: true } })
const { t, locale } = useI18n()
const state = shallowRef(null)
const copyOwner = shallowRef(null), copyStatus = shallowRef('')
const elements = new Map(), headingElements = new Map()
const headingOwner = shallowRef(null), selection = shallowRef(null), renderEpoch = shallowRef({})
let selectionGeneration = 0, navigationIntent = 0, focusGeneration = 0
const focusDocument = typeof document === 'undefined' ? null : document
const observeFocus = () => { focusGeneration++ }
focusDocument?.addEventListener('focusin', observeFocus, true)
let disposed = false
let searchIndex = null
const searchable = computed(() => props.source.content_available && props.source.markdown_content !== '')
function owns(snapshot) {
  // Parent ownership retires callbacks immediately, before a null/replacement
  // prop or unmount reaches this child. State identity also retires older finds.
  return !disposed && state.value === snapshot && props.source === snapshot.source && props.isCurrent(snapshot.source)
}
watch(() => props.source, source => {
  elements.clear(); headingElements.clear(); navigationIntent++
  renderEpoch.value = {}
  headingOwner.value = { source, index: source.content_available ? indexReportHeadings(source.markdown_content) : { headings: [], more: false } }
  selection.value = { owner: headingOwner.value, heading: null, generation: ++selectionGeneration }
  searchIndex = null
  copyOwner.value = { source }; copyStatus.value = ''
  state.value = { source, query: '', tooLong: false, matchCase: false, result: { matches: [], more: false }, current: 0 }
}, { immediate: true, flush: 'sync' })
watch(() => props.isCurrent(props.source), current => {
  if (current) return
  // Parent retirement can precede the next prop/unmount render. Retire the
  // owner itself so a transient return to the same values cannot revive it.
  navigationIntent++; elements.clear(); headingElements.clear()
  headingOwner.value = { source: props.source, index: { headings: [], more: false } }
  selection.value = { owner: headingOwner.value, heading: null, generation: ++selectionGeneration }
  renderEpoch.value = {}
}, { flush: 'sync' })
function ownsCopy(owner) {
  // Search and locale changes do not retire the accepted body. Parent ownership
  // does retire it immediately, including before a committed route unmounts us.
  return !disposed && copyOwner.value === owner && props.source === owner.source && props.isCurrent(owner.source)
}
async function copyMarkdown(owner) {
  if (!ownsCopy(owner)) return
  const markdown = owner.source.markdown_content
  if (!owner.source.content_available || markdown === '') return
  const release = acquireSavedReportClipboard()
  if (!release) return
  const feedback = status => { if (ownsCopy(owner)) copyStatus.value = status }
  try {
    if (!ownsCopy(owner)) return
    feedback('pending')
    // Acquire the shared lock before any host getter can reenter. Do not await
    // before writeText: it must run in this explicit click's activation stack.
    const navigator = globalThis.navigator
    if (!ownsCopy(owner)) return
    const clipboard = navigator?.clipboard
    if (!ownsCopy(owner)) return
    const writeText = clipboard?.writeText
    if (!ownsCopy(owner)) return
    if (typeof writeText !== 'function') { feedback('unavailable'); return }
    await Reflect.apply(writeText, clipboard, [markdown])
    feedback('success')
  } catch { feedback('failed') }
  finally { release() }
}
const copyAction = computed(() => {
  const owner = copyOwner.value
  return () => copyMarkdown(owner)
})
const copyMessage = computed(() => ownsCopy(copyOwner.value) && copyStatus.value ? t(`savedReportCopy.${copyStatus.value}`) : '')
function ownsHeading(snapshot) {
  return !disposed && selection.value === snapshot && headingOwner.value === snapshot.owner
    && props.source === snapshot.owner.source && props.isCurrent(snapshot.owner.source)
}
function ownsRender(render) {
  return !disposed && rendered.value[0] === render && headingOwner.value === render.owner
    && props.source === render.owner.source && props.isCurrent(render.owner.source)
}
function rememberElement(render, map, key) {
  let registered = null
  return element => {
    if (!ownsRender(render)) return
    if (element) { registered = element; map.set(key, element) }
    else if (map.get(key) === registered) { map.delete(key); registered = null }
  }
}
function scrollToCurrent(snapshot, intent) {
  nextTick(() => {
    if (!owns(snapshot) || navigationIntent !== intent) return
    const element = elements.get(snapshot.current)
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function jumpHeading(snapshot) {
  if (!ownsHeading(snapshot) || !snapshot.heading) return
  const intent = ++navigationIntent, focus = focusGeneration, render = rendered.value[0]
  const target = headingElements.get(snapshot.heading.lineStart)
  const current = () => ownsHeading(snapshot) && snapshot.generation === selectionGeneration
    && navigationIntent === intent && ownsRender(render) && headingElements.get(snapshot.heading.lineStart) === target
  nextTick(() => {
    if (!current() || focusGeneration !== focus || typeof target?.focus !== 'function') return
    target.focus({ preventScroll: true })
    // focus is synchronous and can reenter controls or the parent. Our own
    // focusin is intentional; after focus use all identities AND activeElement.
    if (!current() || focusDocument?.activeElement !== target) return
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
// Optional external intent; the reader alone owns target lookup and DOM focus.
// Selection changes invalidate the old render, so resolve the target only after
// the owned replacement render has registered its refs.
function jumpToHeading(source, lineStart, isCurrent = () => true) {
  const owner = headingOwner.value
  if (disposed || props.source !== source || owner.source !== source || !props.isCurrent(source) || !isCurrent()) return false
  const heading = owner.index.headings.find(item => item.lineStart === lineStart)
  if (!heading) return false
  const snapshot = { owner, heading, generation: ++selectionGeneration }
  const intent = ++navigationIntent, focus = focusGeneration
  selection.value = snapshot
  const current = () => isCurrent() && ownsHeading(snapshot) && selectionGeneration === snapshot.generation && navigationIntent === intent
  nextTick(() => {
    if (!current() || focusGeneration !== focus) return
    const render = rendered.value[0], target = headingElements.get(lineStart)
    const ownsTarget = () => current() && ownsRender(render) && headingElements.get(lineStart) === target
    if (!ownsTarget() || typeof target?.focus !== 'function') return
    target.focus({ preventScroll: true })
    if (!ownsTarget() || focusDocument?.activeElement !== target) return
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return true
}
defineExpose({ jumpToHeading })

const headingActions = computed(() => {
  const snapshot = selection.value
  return {
    select: event => {
      if (!ownsHeading(snapshot)) return
      const heading = snapshot.owner.index.headings.find(item => String(item.lineStart) === event.target.value) ?? null
      navigationIntent++
      selection.value = { owner: snapshot.owner, heading, generation: ++selectionGeneration }
    },
    jump: () => jumpHeading(snapshot),
  }
})
function headingLabel(heading) {
  const number = value => new Intl.NumberFormat(locale.value).format(value)
  return t('savedReportHeadings.entry', { level: number(heading.level), line: number(heading.line), title: heading.label })
}
const headingStatus = computed(() => {
  const { source, index } = headingOwner.value
  if (!source.content_available) return t('savedReportHeadings.unavailable')
  if (source.markdown_content === '') return t('savedReportHeadings.empty')
  if (!index.headings.length) return t('savedReportHeadings.none')
  return index.more ? t('savedReportHeadings.limited') : ''
})
function search(snapshot, changes) {
  if (!owns(snapshot) || !searchable.value) return
  const intent = ++navigationIntent
  const next = { ...snapshot, ...changes, current: 0 }
  next.result = next.tooLong || !next.query ? { matches: [], more: false }
    : findReportPassages(searchIndex ??= createReportSearchIndex(next.source.markdown_content), next.query, next.matchCase)
  state.value = next
  if (next.result.matches.length) scrollToCurrent(next, intent)
}
function move(snapshot, direction) {
  if (!owns(snapshot) || !snapshot.result.matches.length) return
  const intent = ++navigationIntent
  const count = snapshot.result.matches.length
  const next = { ...snapshot, current: (snapshot.current + direction + count) % count }
  state.value = next; scrollToCurrent(next, intent)
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
// A new token on every component render owns its ref callbacks, even when
// Vue reuses a node. Old registration/null callbacks cannot touch the new map.
const rendered = computed(() => {
  const render = { epoch: renderEpoch.value, owner: headingOwner.value, parts: [] }
  const { source, result } = state.value
  render.parts = segmentReportText(source.markdown_content ?? '', result.matches, render.owner.index.headings)
  for (const part of render.parts) {
    if (part.match !== undefined) part.remember = rememberElement(render, elements, part.match)
    for (const piece of part.children) if (piece.heading) piece.remember = rememberElement(render, headingElements, piece.heading.lineStart)
  }
  return [render]
})
onBeforeUpdate(() => { renderEpoch.value = {}; elements.clear(); headingElements.clear() })
onBeforeUnmount(() => {
  disposed = true; navigationIntent++; selectionGeneration++; searchIndex = null
  elements.clear(); headingElements.clear()
  focusDocument?.removeEventListener('focusin', observeFocus, true)
})
</script>

<style scoped>
.heading-controls { margin-top: 20px; }.heading-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }.heading-actions select { flex: 1 1 240px; min-width: 0; max-width: 100%; box-sizing: border-box; min-height: 44px; padding: 10px; border: 1px solid #c8cfd9; border-radius: 7px; background: #fff; color: #202329; font: inherit; }.heading-actions select:focus-visible, .report-heading-target:focus { outline: 3px solid #5b8bc9; outline-offset: 3px; }.heading-actions select:disabled { opacity: .55; }.report-heading-target:focus { background: #edf1f6; color: #202329; }
.copy-controls { margin-top: 16px; }.copy-controls p:empty { margin: 0; }
.find-controls { margin-top: 20px; padding: 16px; border: 1px solid #d7dde5; border-radius: 8px; background: #f8f9fb; }label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; }textarea { box-sizing: border-box; width: 100%; min-height: 44px; resize: vertical; border: 1px solid #c8cfd9; border-radius: 6px; padding: 10px; font: inherit; color: #202329; background: #fff; }.find-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }.case-control { display: flex; align-items: center; gap: 8px; margin: 0 10px 0 0; min-height: 44px; }input[type=checkbox] { width: 18px; height: 18px; }button { cursor: pointer; border: 1px solid #c8cfd9; border-radius: 7px; padding: 10px 14px; min-height: 44px; font: inherit; font-size: 14px; color: #28323f; background: #fff; }button:hover:enabled { background: #edf1f6; }button:disabled, textarea:disabled, input:disabled { opacity: .55; cursor: not-allowed; }button:focus-visible, textarea:focus-visible, input:focus-visible, pre:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }.note { color: #68707c; font-size: 13px; line-height: 1.6; }.notice { padding: 14px; border-radius: 8px; background: #edf1f6; }[role=status] { margin-bottom: 0; line-height: 1.6; }pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 13px/1.65 monospace; max-height: 720px; overflow-y: auto; tab-size: 4; }mark { background: #fff0a6; color: #202329; }mark.current { background: #254f83; color: #fff; outline: 2px solid #254f83; text-decoration: underline; text-underline-offset: 2px; }
</style>
