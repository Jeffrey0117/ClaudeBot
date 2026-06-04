import { create } from 'zustand'
import { setLocale, type Locale } from '../i18n'

type Theme = 'dark' | 'light'

interface SettingsState {
  readonly theme: Theme
  readonly locale: Locale
  toggleTheme: () => void
  toggleLocale: () => void
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: 'light',
  locale: 'zh',

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' as const : 'dark' as const
    applyTheme(next)
    set({ theme: next })
  },

  toggleLocale: () => {
    const next = get().locale === 'zh' ? 'en' as const : 'zh' as const
    setLocale(next)
    set({ locale: next })
  },
}))

// Initialize on load
applyTheme('light')
setLocale('zh')
