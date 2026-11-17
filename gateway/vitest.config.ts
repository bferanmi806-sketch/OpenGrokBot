import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Windows runner 上连续做 SQLite VACUUM 备份时偶尔超过默认的 5 秒上限
    testTimeout: 15_000,
  },
})
