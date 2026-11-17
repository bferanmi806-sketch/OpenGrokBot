import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// 整页渲染的 App 测试在 CI 的小 runner 上偶尔要一秒多才就绪；默认 1 秒的等待在那里不够用
configure({ asyncUtilTimeout: 3000 })

// isolate: false 下多个测试文件共用一个 jsdom：先卸载组件（让卸载钩子还看得到当前用例的 fetch 桩），再把全局状态复原
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.lang = ''
  delete document.documentElement.dataset.desktop
  location.hash = ''
})
