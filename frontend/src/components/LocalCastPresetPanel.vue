<template>
  <section class="cast-preset-panel" aria-labelledby="cast-preset-title">
    <h2 id="cast-preset-title">{{ $t('localCastPreset.title') }}</h2>
    <p>{{ $t('localCastPreset.scope') }}</p>
    <p v-if="!catalogReady" class="hint">{{ $t('localCastPreset.loadFirst') }}</p>
    <p v-else class="binding">{{ $t('localCastPreset.binding', { project: projectId, graph: graphId }) }}</p>
    <div class="preset-controls">
      <button data-testid="save-cast-preset" type="button" :disabled="!canSave" :onClick="actions.save">{{ $t('localCastPreset.save') }}</button>
      <label>{{ $t('localCastPreset.open') }}
        <input data-testid="open-cast-preset" type="file" accept=".json,application/json" :disabled="!canOpen" :onChange="actions.open">
      </label>
      <button v-if="reading || candidate || error" data-testid="clear-cast-preset" type="button" :onClick="actions.clear">{{ $t('localCastPreset.clear') }}</button>
    </div>
    <p class="hint">{{ $t('localCastPreset.fileHint') }}</p>
    <p v-if="reading" role="status">{{ $t('localCastPreset.reading') }}</p>
    <p v-if="error" class="error" role="alert">{{ $t(error) }}</p>
    <div v-if="candidate" data-testid="cast-preset-preview" class="preset-preview">
      <h3>{{ $t('localCastPreset.preview') }}</h3>
      <dl>
        <dt>{{ $t('localCastPreset.project') }}</dt><dd>{{ candidate.project_id }}</dd>
        <dt>{{ $t('localCastPreset.graph') }}</dt><dd>{{ candidate.graph_id }}</dd>
        <dt>{{ $t('localPlan.profileMode') }}</dt><dd>{{ $t(candidate.use_llm_for_profiles ? 'localPlan.llm' : 'localPlan.template') }}</dd>
        <dt>{{ $t('localPlan.maximumRounds') }}</dt><dd>{{ candidate.max_rounds }}</dd>
      </dl>
      <p>{{ $t('localCastPreset.selection', { count: candidate.selected_entity_ids.length }) }}</p>
      <ol class="preset-ids"><li v-for="id in candidate.selected_entity_ids" :key="id">{{ id }}</li></ol>
      <p v-if="compatibilityError" class="error" role="alert">{{ $t(compatibilityError) }}</p>
      <p v-else role="status">{{ $t(canApply ? 'localCastPreset.compatible' : 'localCastPreset.applyUnavailable') }}</p>
      <button data-testid="apply-cast-preset" type="button" :disabled="!canApply" :onClick="actions.apply">{{ $t('localCastPreset.apply') }}</button>
    </div>
    <p v-if="applied" role="status">{{ $t('localCastPreset.applied') }}</p>
    <p class="hint">{{ $t('localCastPreset.retainedDraft') }}</p>
  </section>
</template>

<script setup>
defineProps({ catalogReady: Boolean, projectId: String, graphId: String, canSave: Boolean, canOpen: Boolean,
  reading: Boolean, candidate: Object, error: String, compatibilityError: String, canApply: Boolean, applied: Boolean,
  actions: { type: Object, required: true } })
</script>

<style scoped>
.cast-preset-panel { margin-top: 16px; padding: 20px; background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; min-width: 0; }
h2 { margin: 0; font-size: 18px; } h3 { font-size: 15px; } p, label, dt, dd, li { font-size: 13px; line-height: 1.6; }
.preset-controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.preset-controls label { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; min-width: 0; }
input { max-width: 100%; } button { padding: 9px 12px; background: #fff; border: 1px solid #bbb; border-radius: 5px; cursor: pointer; }
button:disabled, input:disabled { opacity: .5; cursor: default; } button:focus-visible, input:focus-visible { outline: 2px solid #ff5722; outline-offset: 3px; }
.hint { color: #555; } .error { color: #a22; } .binding, dd, .preset-ids { overflow-wrap: anywhere; }
.preset-preview { padding: 12px; margin-top: 12px; border: 1px solid #ddd; border-radius: 5px; }
dl { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: 6px 12px; } dd { margin: 0; }
.preset-ids { max-height: 160px; overflow: auto; }
</style>
