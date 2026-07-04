import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    // sim/**/*.test.ts — быстрые юнит-тесты полигона Бориса-Директа (без сети).
    // Тяжёлая матрица полигона живёт в *.simtest.ts и сюда НЕ входит —
    // запускается отдельным конфигом sim/vitest.config.ts (npm run sim:*).
    include: ['src/**/*.test.ts', 'sim/**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**', 'dist/**'],
  },
})
