import type { ResolvedTheme, ThemeSetting } from './types'

export const THEME_STORAGE_KEY = 'osb_theme'

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === 'dark' || value === 'light' || value === 'system'
}

export function hasStoredTheme(): boolean {
  try {
    return isThemeSetting(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return false
  }
}

export function readStoredTheme(): ThemeSetting {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeSetting(raw) ? raw : 'dark'
  } catch {
    return 'dark'
  }
}

export function writeStoredTheme(theme: ThemeSetting): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch { /* 私密模式或禁用存储时忽略 */ }
}

export function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function resolveTheme(setting: ThemeSetting, sys: ResolvedTheme = systemTheme()): ResolvedTheme {
  return setting === 'system' ? sys : setting
}

export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f7f9' : '#0c0f19')
}
