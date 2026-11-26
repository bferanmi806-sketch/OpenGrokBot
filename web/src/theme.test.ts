import { afterEach, describe, expect, it } from 'vitest'
import { THEME_STORAGE_KEY, applyTheme, hasStoredTheme, readStoredTheme, resolveTheme, writeStoredTheme } from './theme'

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY)
  delete document.documentElement.dataset.theme
})

describe('theme helpers', () => {
  it('defaults to dark and persists valid theme choices in localStorage', () => {
    expect(hasStoredTheme()).toBe(false)
    expect(readStoredTheme()).toBe('dark')
    writeStoredTheme('light')
    expect(hasStoredTheme()).toBe(true)
    expect(readStoredTheme()).toBe('light')
    writeStoredTheme('system')
    expect(readStoredTheme()).toBe('system')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'unknown')
    expect(hasStoredTheme()).toBe(false)
    expect(readStoredTheme()).toBe('dark')
  })

  it('resolves system theme and applies data-theme on documentElement', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('system', 'light')).toBe('light')
    expect(resolveTheme('system', 'dark')).toBe('dark')

    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
    try {
      applyTheme('light')
      expect(document.documentElement.dataset.theme).toBe('light')
      expect(meta.getAttribute('content')).toBe('#f6f7f9')
      applyTheme('dark')
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(meta.getAttribute('content')).toBe('#0c0f19')
    } finally {
      meta.remove()
    }
  })
})
