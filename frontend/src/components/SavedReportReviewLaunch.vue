<template>
  <div class="review-launch">
    <button type="button" data-testid="review-report" :disabled="!eligible || busy" :onClick="launchAction">{{ t('savedReportReview.launch') }}</button>
    <RouterLink to="/report-review">{{ t('savedReportReview.return') }}</RouterLink>
    <p v-if="message" role="status" data-testid="review-capture-status">{{ t(`savedReportReview.${message}`) }}</p>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { reviewStore } from '../store/savedReportReview.js'

const props = defineProps({ source: { type: Object, required: true }, isCurrent: { type: Function, required: true } })
const { t } = useI18n(), router = useRouter()
const owner = shallowRef(null), busy = shallowRef(false), message = shallowRef('')
let disposed = false, attempt = null
function retire() {
  const old = attempt; attempt = null; old?.cancel()
  busy.value = false; message.value = ''
}
watch(() => props.source, source => { retire(); owner.value = { source, retired: false } }, { immediate: true, flush: 'sync' })
watch(() => props.isCurrent(props.source), current => {
  if (current) return
  if (owner.value) owner.value.retired = true
  retire()
}, { flush: 'sync' })
const current = owned => !disposed && owned === owner.value && !owned.retired && props.source === owned.source && props.isCurrent(owned.source)
const eligible = computed(() => current(owner.value) && props.source.status === 'completed' && props.source.content_available === true)
const launchAction = computed(() => {
  const owned = owner.value
  return async () => {
    if (!current(owned) || owned.source.status !== 'completed' || !owned.source.content_available || busy.value) return
    busy.value = true; message.value = 'capturing'
    const operation = reviewStore.beginCapture(owned.source, () => current(owned))
    attempt = operation
    try {
      const candidate = await operation.promise
      if (!candidate || reviewStore.state.value.candidate !== candidate) return
      // Parent ownership ends at staging. Router retirement may now safely
      // unmount this source without retiring the detached staged candidate.
      if (reviewStore.handoffCandidate(candidate)) await router.push('/report-review')
    } catch { if (attempt === operation && current(owned)) message.value = 'captureFailed' }
    finally { if (attempt === operation) { busy.value = false; attempt = null } }
  }
})
onBeforeUnmount(() => { disposed = true; retire() })
</script>

<style scoped>
.review-launch { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 16px; }.review-launch button { min-height: 44px; padding: 10px 16px; border: 1px solid #c8cfd9; border-radius: 7px; background: #fff; color: #28323f; font: inherit; cursor: pointer; }.review-launch button:disabled { opacity: .5; cursor: not-allowed; }.review-launch a { color: #394555; }.review-launch p { flex-basis: 100%; margin: 0; }.review-launch button:focus-visible, .review-launch a:focus-visible { outline: 3px solid #5b8bc9; outline-offset: 3px; }
</style>
