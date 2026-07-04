import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Конфиг ТЯЖЁЛОЙ матрицы полигона (sim/**\/*.simtest.ts).
 * Отделён от корневого vitest.config.ts, чтобы npm test оставался быстрым:
 * матрица гоняет реальный мозг Бориса по десяткам сценариев × зёрен.
 * Запуск: npm run sim:calibrate / sim:baseline (см. package.json).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
  test: {
    environment: 'node',
    include: ['sim/**/*.simtest.ts'],
    exclude: ['node_modules/**'],
    // Единая граница мока транспорта мозга (реальный мозг, фейковые двери).
    setupFiles: ['sim/runner/mocks.setup.ts'],
    // Матрица долгая: один test() может крутить сотни симуло-дней.
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Прогоны пишут результаты на диск — параллелизм файлов не нужен.
    fileParallelism: false,
  },
  root: path.resolve(__dirname, '..'),
})
