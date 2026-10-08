import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // 每個測試檔會啟動一個記憶體 PGlite（約 1～3 秒）
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
