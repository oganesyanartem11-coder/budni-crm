/**
 * Контракт движка мира (реализует sim/engine/world.ts). Зафиксирован до
 * реализации, чтобы фейки/оракул/раннер строились параллельно.
 *
 * Модель дня: advanceDay(world) генерит день day (показы→клики→визиты→заявки
 * с лагом), учитывая ТЕКУЩИЕ ставки/минусы/остановки мира, применяет события
 * расписания (WorldEvent) и возвращает наблюдаемую проекцию DayObservables.
 * Мутаторы вызываются фейк-клиентом МЕЖДУ днями (решения дня N действуют
 * с дня N+1). Правда копится в world.truthClicks — её читают только
 * оракул/скорер.
 *
 * Детерминизм: вся случайность — из seeded RNG (mulberry32) внутри world;
 * Date/Math.random в движке ЗАПРЕЩЕНЫ.
 */

import type { DayObservables, ScenarioConfig, WorldState } from '../types'

export interface WorldEngine {
  createWorld(config: ScenarioConfig, seed: number): WorldState
  /** Сгенерировать СЛЕДУЮЩИЙ день (world.day инкрементируется) и вернуть наблюдаемое. */
  advanceDay(world: WorldState): DayObservables
  /** Мутаторы (эффект со следующего дня). Ставка клампится движком к аукциону, не к потолку — потолок держит Борис. */
  setBid(world: WorldState, keywordId: number, bidMicro: number): void
  /** Полный список минус-фраз кампании (КАМПЕЙН-ЛЕВЕЛ: режет запросы всех групп по вхождению слов). */
  setNegatives(world: WorldState, negatives: string[]): void
  suspendCampaign(world: WorldState): void
  suspendKeywords(world: WorldState, keywordIds: number[]): void
  setMetricaTag(world: WorldState, value: 'YES' | 'NO'): void
  /** Итоги правды на текущий момент (для экономики скорера). */
  getTotals(world: WorldState): { spendRub: number; trueLeads: number; observedLeads: number }
  /** Минусует ли данный список данный запрос (единая семантика для мира и оракула). */
  negativesMatch(negatives: string[], query: string): boolean
}
