<template>
  <div class="not-found-page">
    <header class="app-header">
      <RouterLink :to="{ name: 'Home' }" class="brand">MIROFISH</RouterLink>
      <LanguageSwitcher />
    </header>
    <main>
      <section class="panel" aria-labelledby="not-found-title">
        <h1 id="not-found-title">{{ t('notFound.title') }}</h1>
        <p>{{ t('notFound.description') }}</p>
        <nav class="recovery-links" :aria-label="t('notFound.navigation')">
          <RouterLink :to="{ name: 'Home' }" data-testid="not-found-home">{{ t('notFound.home') }}</RouterLink>
          <RouterLink :to="{ name: 'SavedSimulations' }" data-testid="not-found-simulations">{{ t('notFound.savedSimulations') }}</RouterLink>
        </nav>
      </section>
    </main>
  </div>
</template>

<script setup>
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'

const { t } = useI18n()
</script>

<style scoped>
.not-found-page { min-height: 100vh; background: #f8f9fb; color: #202329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app-header { min-height: 72px; padding: 0 36px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { color: #18181b; font-weight: 800; letter-spacing: 2px; font-size: 22px; text-decoration: none; }
main { max-width: 760px; margin: 0 auto; padding: 40px 24px 60px; }
.panel { background: #fff; border: 1px solid #e1e5eb; border-radius: 12px; padding: 24px; }
h1 { font-size: clamp(26px, 4vw, 36px); margin-bottom: 16px; }
p { line-height: 1.6; color: #59616d; }
.recovery-links { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 24px; }
a { color: #394555; }
a:focus-visible { outline: 2px solid #405fbd; outline-offset: 3px; }
@media (max-width: 600px) { .app-header { padding: 16px; } main { padding: 28px 16px; } .panel { padding: 18px; } }
</style>
