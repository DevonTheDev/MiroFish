import { createI18n } from 'vue-i18n'
import languages from '../../../locales/languages.json'

const localeFiles = import.meta.glob('../../../locales/!(languages).json', { eager: true })

const messages = {}
const availableLocales = []

for (const path in localeFiles) {
  const key = path.match(/\/([^/]+)\.json$/)[1]
  if (languages[key]) {
    messages[key] = localeFiles[path].default
    availableLocales.push({ key, label: languages[key].label })
  }
}

let savedLocale = 'zh'
try {
  const storedLocale = localStorage.getItem('locale')
  if (availableLocales.some(locale => locale.key === storedLocale)) {
    savedLocale = storedLocale
  }
} catch {
  // Browser storage is optional; keep the existing default when unavailable.
}

const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: 'zh',
  messages
})

if (typeof document !== 'undefined') {
  document.documentElement.lang = savedLocale
}

export { availableLocales }
export default i18n
