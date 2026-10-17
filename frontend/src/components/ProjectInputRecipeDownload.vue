<template>
  <div class="input-recipe-download">
    <button type="button" data-testid="download-input-recipe" :disabled="!controls.action || busy"
      aria-describedby="input-recipe-download-note" :onClick="controls.action">{{ $t('inputRecipe.download') }}</button>
    <p id="input-recipe-download-note">{{ $t('inputRecipe.downloadNote') }}</p>
    <p v-if="error" data-testid="input-recipe-download-error" role="alert">{{ $t(error) }}</p>
    <p v-if="requested" data-testid="input-recipe-download-status" role="status">{{ $t('inputRecipe.downloadRequested') }}</p>
  </div>
</template>

<script setup>
import { ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getProjectInputRecipe } from '../api/projectInputRecipe'
import { parseInputRecipeBytes, RECIPE_DOWNLOAD_FILENAME } from '../utils/projectInputRecipe.js'

const props = defineProps({ projectId: String, selection: Function })
const router = useRouter()
const controls = shallowRef({})
const busy = ref(false)
const error = ref('')
const requested = ref(false)
let active = true
let owner = null
let request = null

const cleanup = token => {
  if (!token) return
  if (token.timer !== null) { clearTimeout(token.timer); token.timer = null }
  if (token.anchor) { token.anchor.remove(); token.anchor = null }
  if (token.url) { URL.revokeObjectURL(token.url); token.url = null }
}
const retire = () => {
  owner = null
  const previous = request
  request = null
  previous?.controller.abort()
  cleanup(previous)
  controls.value = {}
  busy.value = false
  error.value = ''
  requested.value = false
}
const owns = target => active && owner === target && router.currentRoute.value === target.route
  && props.projectId === target.projectId && props.selection?.() === target.selection
const ownsRequest = token => request === token && owns(token.owner)

const download = async target => {
  if (!owns(target) || busy.value) return
  cleanup(request)
  const token = { owner: target, controller: new AbortController(), url: null, anchor: null, timer: null }
  request = token
  busy.value = true
  requested.value = false
  error.value = ''
  try {
    const bytes = await getProjectInputRecipe(target.projectId, token.controller.signal)
    if (!ownsRequest(token)) return
    parseInputRecipeBytes(bytes)
    const blob = new Blob([bytes], { type: 'application/json;charset=utf-8' })
    if (!ownsRequest(token)) return
    token.url = URL.createObjectURL(blob)
    if (!ownsRequest(token)) return
    token.anchor = document.createElement('a')
    token.anchor.href = token.url
    token.anchor.download = RECIPE_DOWNLOAD_FILENAME
    if (!ownsRequest(token)) return
    document.body.appendChild(token.anchor)
    if (!ownsRequest(token)) return
    token.anchor.click()
    if (ownsRequest(token)) requested.value = true
  } catch (failure) {
    if (ownsRequest(token)) error.value = failure?.status === 409 ? 'inputRecipe.captureChanged'
      : failure?.status === 413 ? 'inputRecipe.tooLarge' : 'inputRecipe.downloadFailed'
  } finally {
    if (token.anchor) { token.anchor.remove(); token.anchor = null }
    if (ownsRequest(token)) {
      busy.value = false
      if (token.url) token.timer = setTimeout(() => cleanup(token), 1000)
    } else cleanup(token)
  }
}

watch([() => props.projectId, () => props.selection?.(), () => router.currentRoute.value], () => {
  retire()
  if (!active || !props.projectId || props.projectId === 'new') return
  const selected = props.selection?.()
  if (selected && selected.project_id !== props.projectId) return
  const target = { projectId: props.projectId, selection: selected, route: router.currentRoute.value }
  owner = target
  controls.value = { action: () => download(target) }
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { active = false; retire() })
</script>

<style scoped>
.input-recipe-download { padding: 10px 0; font-size: 0.8rem; }
.input-recipe-download button { padding: 8px 12px; cursor: pointer; }
.input-recipe-download p { max-width: 52rem; margin: 6px 0; line-height: 1.5; }
</style>
