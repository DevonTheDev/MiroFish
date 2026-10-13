import { computed, shallowRef } from 'vue'

// A submitted clipboard write cannot be cancelled. Keep one owner across reader
// replacement and unmount until that operation settles; never queue or time out.
const active = shallowRef(null)
export const savedReportClipboardBusy = computed(() => active.value !== null)

export function acquireSavedReportClipboard() {
  if (active.value !== null) return null
  const token = {}
  active.value = token
  return () => { if (active.value === token) active.value = null }
}
