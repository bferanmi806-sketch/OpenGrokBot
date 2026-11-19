import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    // 网关默认只听 127.0.0.1；/auth 是启动日志里那条登录链接
    proxy: {
      '/api': 'http://127.0.0.1:4747',
      '/auth': 'http://127.0.0.1:4747',
      '/ws': { target: 'ws://127.0.0.1:4747', ws: true },
      // 电脑屏幕（noVNC 页面 + 它的 WebSocket）也经网关；本机电脑的截屏流在 /screen
      '/vnc': { target: 'http://127.0.0.1:4747', ws: true },
      '/screen': { target: 'http://127.0.0.1:4747', ws: true },
      // routine 的 webhook：面板复制出来的地址在 dev 下也能直接用
      '/hooks': 'http://127.0.0.1:4747',
      '/oauth': 'http://127.0.0.1:4747',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-markdown', test: /node_modules[\\/](react-markdown|remark-|micromark|mdast-|unist-|hast-|vfile|unified|bail|trough|devlop|property-information|space-separated-tokens|comma-separated-tokens|estree-util|html-url-attributes|is-plain-obj|ccount|escape-string-regexp|markdown-table|zwitch|longest-streak|decode-named-character-reference|character-entities)/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    isolate: false,
    setupFiles: './src/test-setup.ts',
    // jsdom 渲染吃 CPU：机器被别的进程占满时，一个本该几毫秒的渲染测试也跑过 5 秒。
    // 放宽的只是时间上限，断言错了照样立刻失败
    testTimeout: 15_000,
  },
})
