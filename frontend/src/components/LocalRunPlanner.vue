<template>
  <section class="local-planner" aria-labelledby="local-plan-title">
    <div class="planner-heading">
      <h2 id="local-plan-title">{{ $t('localPlan.title') }}</h2>
      <button data-testid="refresh-plan" type="button" :disabled="busy || waiting" @click="$emit('refresh')">{{ $t('localPlan.refresh') }}</button>
    </div>
    <p v-if="waiting" role="status">{{ $t('localPlan.waiting') }}</p>
    <p v-else-if="checking" role="status">{{ $t('localPlan.checking') }}</p>
    <p v-if="error" class="planner-error" role="alert">{{ $t(error) }}</p>
    <template v-if="plan?.mode === 'local'">
      <p v-if="limitsValid" class="limits">{{ $t('localPlan.limits', { agents: plan.limits.max_agents, selectable: plan.limits.max_selectable_agents, rounds: plan.limits.max_rounds, concurrency: plan.limits.max_concurrency }) }}</p>
      <p v-else class="planner-error">{{ $t('localPlan.invalidLimits') }}</p>
      <div v-if="cancellationStatus" data-testid="preparation-cancellation-status" role="status" aria-live="polite" aria-atomic="true">
        <p>{{ $t(cancellationStatus) }}</p>
        <p v-if="cancellationBlocked" class="hint">{{ $t('localPlan.cancelledHint') }}</p>
      </div>
      <template v-if="showCancel">
        <p id="preparation-cancel-hint" class="hint">{{ $t('localPlan.cancelHint') }}</p>
        <button data-testid="cancel-preparation" type="button" :disabled="!canCancel" aria-describedby="preparation-cancel-hint"
          :onClick="cancelAction">{{ $t(cancelRetry ? 'localPlan.cancelRetry' : 'localPlan.cancel') }}</button>
      </template>
      <p v-if="plan.owner?.busy" role="status">{{ $t(plan.owner.reason_code === 'preparation_busy' && plan.owner.task_id ? 'localPlan.observing' : 'localPlan.busyError') }}</p>
      <template v-if="!cancellationBlocked && plan.prepared?.available">
        <p>{{ $t('localPlan.saved', { count: plan.prepared.info?.profiles_count ?? '—' }) }}</p>
        <p class="hint">{{ $t('localPlan.savedHint') }}</p>
        <button v-if="!complete" data-testid="reuse-preparation" type="button" :disabled="!canReuse" @click="$emit('reuse')">{{ $t('localPlan.reuse') }}</button>
      </template>
      <template v-else-if="!complete && !cancellationBlocked">
        <p class="hint">{{ $t('localPlan.loadHint') }}</p>
        <button data-testid="load-cast" type="button" :disabled="!canPrepare" @click="$emit('load')">{{ $t(loadingCast ? 'localPlan.loading' : 'localPlan.load') }}</button>
        <p v-if="limitsValid && !plan.can_prepare && !plan.owner?.busy" class="hint">{{ $t('localPlan.savedError') }}</p>
        <template v-if="catalogLoaded">
          <label class="cast-search" for="cast-search">{{ $t('localPlan.search') }}</label>
          <input id="cast-search" data-testid="cast-search" type="search" :maxlength="searchLimit" :value="searchQuery"
            :disabled="busy" aria-describedby="cast-search-hint cast-visible-count" @input="$emit('search', $event.target.value)">
          <p id="cast-search-hint" data-testid="cast-search-hint" class="hint">{{ $t('localPlan.searchHint', { limit: searchLimit }) }}</p>
          <div class="cast-toolbar">
            <label>{{ $t('localPlan.filter') }}
              <select data-testid="cast-filter" :value="typeFilter" :disabled="busy" @change="$emit('filter', $event.target.value)">
                <option value="">{{ $t('localPlan.allTypes') }}</option>
                <option v-for="type in types" :key="type" :value="type">{{ type }}</option>
              </select>
            </label>
            <label>{{ $t('localPlan.view') }}
              <select data-testid="cast-view" :value="selectedOnly ? 'selected' : 'all'" :disabled="busy" @change="$emit('view', $event.target.value === 'selected')">
                <option value="all">{{ $t('localPlan.allCast') }}</option>
                <option value="selected">{{ $t('localPlan.selectedOnly') }}</option>
              </select>
            </label>
            <button data-testid="cast-clear-filters" type="button" :disabled="busy || !(typeFilter || searchQuery || selectedOnly)" @click="$emit('clear-filters')">{{ $t('localPlan.clearFilters') }}</button>
            <span>{{ $t('localPlan.selected', { count: selectedIds.length, cap: plan.limits.max_selectable_agents }) }}</span>
          </div>
          <p id="cast-visible-count" data-testid="cast-visible-count" role="status" aria-live="polite">{{ $t('localPlan.visible', { count: filteredEntities.length, total: entities.length }) }}</p>
          <p v-if="hiddenSelectedCount" data-testid="cast-hidden-selected" class="hint">{{ $t('localPlan.hiddenSelected', { count: hiddenSelectedCount }) }}</p>
          <p v-if="!entities.length" data-testid="cast-empty">{{ $t('localPlan.empty') }}</p>
          <p v-else-if="selectedOnly && !selectedIds.length" data-testid="cast-no-selection">{{ $t('localPlan.noSelection') }}</p>
          <p v-else-if="!filteredEntities.length" data-testid="cast-no-matches">{{ $t('localPlan.noMatches') }}</p>
          <div class="cast-list">
            <label v-for="entity in filteredEntities" :key="entity.uuid" class="cast-item">
              <input type="checkbox" :data-testid="'entity-' + entity.uuid" :checked="selectedIds.includes(entity.uuid)"
                :disabled="busy || (!selectedIds.includes(entity.uuid) && selectedIds.length >= plan.limits.max_selectable_agents)"
                @change="$emit('select', entity.uuid, $event.target.checked)">
              <span class="cast-text"><strong>{{ entity.name }}</strong> <span>{{ entity.entity_type }}</span>
                <small class="entity-id">{{ entity.uuid }}</small><span class="entity-summary">{{ entity.summary }}</span>
                <small v-if="entity.text_truncated">{{ $t('localPlan.truncated') }}</small>
              </span>
            </label>
          </div>
          <label class="profile-choice">{{ $t('localPlan.profileMode') }}
            <select data-testid="profile-mode" :value="useLlm ? 'llm' : 'template'" :disabled="busy" @change="$emit('profile-mode', $event.target.value === 'llm')">
              <option value="template">{{ $t('localPlan.template') }}</option>
              <option value="llm">{{ $t('localPlan.llm') }}</option>
            </select>
          </label>
          <p class="hint">{{ $t(useLlm ? 'localPlan.llmHint' : 'localPlan.templateHint') }}</p>
          <p class="hint">{{ $t('localPlan.configModelHint') }}</p>
          <label class="profile-choice" for="draft-maximum-rounds">{{ $t('localPlan.maximumRounds') }}</label>
          <input id="draft-maximum-rounds" data-testid="draft-maximum-rounds" type="number" min="1" step="1"
            :max="plan.limits.max_rounds" :value="maxRounds" :disabled="!canPrepare" :onInput="roundsAction">
          <p class="hint">{{ $t('localPlan.roundsHint', { cap: plan.limits.max_rounds }) }}</p>
          <p v-if="!roundsValid" class="planner-error">{{ $t('localPlan.invalidRounds') }}</p>
          <button data-testid="prepare-cast" type="button" :disabled="!canPrepare || !selectedIds.length || !roundsValid" @click="$emit('prepare')">{{ $t('localPlan.prepare') }}</button>
        </template>
      </template>
      <p v-if="complete" role="status">{{ $t('localPlan.ready') }}</p>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ plan: Object, checking: Boolean, waiting: Boolean, busy: Boolean, error: String,
  limitsValid: Boolean, canPrepare: Boolean, canReuse: Boolean, loadingCast: Boolean, catalogLoaded: Boolean,
  entities: { type: Array, default: () => [] }, selectedIds: { type: Array, default: () => [] },
  searchQuery: { type: String, default: '' }, selectedOnly: Boolean, searchLimit: Number,
  typeFilter: String, useLlm: Boolean, maxRounds: Number, roundsValid: Boolean, roundsAction: Function, complete: Boolean, cancellationStatus: String,
  cancellationBlocked: Boolean, showCancel: Boolean, canCancel: Boolean, cancelRetry: Boolean, cancelAction: Function })
defineEmits(['refresh', 'load', 'select', 'filter', 'search', 'view', 'clear-filters', 'profile-mode', 'prepare', 'reuse'])
const types = computed(() => [...new Set(props.entities.map(entity => entity.entity_type))].sort())
const filteredEntities = computed(() => {
  const byId = new Map(props.entities.map(entity => [entity.uuid, entity]))
  const source = props.selectedOnly ? props.selectedIds.map(id => byId.get(id)).filter(Boolean) : props.entities
  const query = props.searchQuery.toLowerCase()
  return source.filter(entity => (!props.typeFilter || entity.entity_type === props.typeFilter)
    && (!query || [entity.name, entity.uuid, entity.entity_type, entity.summary].some(value => value.toLowerCase().includes(query))))
})
const hiddenSelectedCount = computed(() => {
  const visibleIds = new Set(filteredEntities.value.map(entity => entity.uuid))
  return props.selectedIds.filter(id => !visibleIds.has(id)).length
})
</script>

<style scoped>
.local-planner { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 20px; color: #222; min-width: 0; }
.planner-heading, .cast-toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
h2 { font-size: 18px; margin: 0; } p { font-size: 13px; line-height: 1.6; }
button, select, input[type="search"] { border: 1px solid #bbb; border-radius: 5px; background: #fff; padding: 9px 12px; max-width: 100%; font: inherit; }
button { cursor: pointer; } button:disabled, select:disabled, input:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #ff5722; outline-offset: 3px; }
.hint { color: #555; } .planner-error { color: #a22; } .limits { background: #f7f7f7; padding: 10px; }
.cast-toolbar { margin: 16px 0 10px; font-size: 12px; } .cast-list { max-height: 320px; overflow: auto; }
.cast-search { display: block; margin: 16px 0 6px; font-size: 12px; } input[type="search"] { width: 100%; box-sizing: border-box; }
.cast-item { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-bottom: 1px solid #eee; }
.cast-text { min-width: 0; overflow-wrap: anywhere; font-size: 13px; } .entity-id, .entity-summary { display: block; margin-top: 4px; color: #666; }
.profile-choice { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 20px; font-size: 13px; }
</style>
