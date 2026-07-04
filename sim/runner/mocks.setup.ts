/**
 * setupFiles для тяжёлой матрицы полигона (sim/vitest.config.ts).
 *
 * ЕДИНСТВЕННОЕ место, где подменяется листовой транспорт мозга Бориса.
 * Всё, что НЕ здесь (rules, write-gate, proposals, state, lessons, outcomes,
 * anomalies, attribution, brain, apply-accepted, learning, report-texts),
 * работает РЕАЛЬНЫМ кодом — полигон судит боевой мозг, а не его копию.
 *
 * Граница мока (почему именно эти модули):
 *  - '@/lib/db/prisma' → in-memory фейк текущего прогона (Proxy → getCtx().fakePrisma);
 *  - direct-client / metrika-client / telegram → фейки читают симулированный мир;
 *  - reports → РЕАЛЬНЫЕ build*Body/parseReportTsv, фейковый только pollReport (TSV из мира);
 *  - llm → РЕАЛЬНЫЙ учёт стоимости, фейковый только callBorisDirectLlm (stub-классификатор
 *    мусора или живой Haiku с дисковым кешем — режим задаёт прогон).
 */

import { vi } from 'vitest'

// prisma: Proxy пересылает КАЖДЫЙ доступ к свойству в фейк-присму ТЕКУЩЕГО
// прогона (getCtx().fakePrisma), поэтому пересоздание SimContext между
// прогонами подхватывается автоматически, без переустановки мока.
vi.mock('@/lib/db/prisma', async () => {
  const { getCtx } = await import('../fakes/context')
  const proxy = new Proxy(
    {},
    {
      get(_target, key: string | symbol) {
        const fake = getCtx().fakePrisma as unknown as Record<string | symbol, unknown>
        return fake[key]
      },
    }
  )
  return { prisma: proxy }
})

vi.mock('@/lib/boris-direct/direct-client', async () => {
  return await import('../fakes/direct-client')
})

vi.mock('@/lib/boris-direct/metrika-client', async () => {
  return await import('../fakes/metrika-client')
})

vi.mock('@/lib/boris-direct/telegram', async () => {
  return await import('../fakes/telegram')
})

vi.mock('@/lib/boris-direct/reports', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/boris-direct/reports')>()
  const { fakePollReport } = await import('../fakes/reports')
  // Реальные конструкторы тел отчётов и парсер TSV; фейковый только опрос.
  return { ...actual, pollReport: fakePollReport }
})

vi.mock('@/lib/boris-direct/llm', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/boris-direct/llm')>()
  const { fakeCallBorisDirectLlm } = await import('../fakes/llm')
  // Реальные computeLlmCostUsd/getLlmBudgetStatus и пр.; фейковый только вызов.
  return { ...actual, callBorisDirectLlm: fakeCallBorisDirectLlm }
})
