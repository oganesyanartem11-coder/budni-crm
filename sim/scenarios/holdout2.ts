/**
 * HOLDOUT-2 (Цикл 2.0) — СВЕЖИЙ проверочный набор, собранный ПОСЛЕ всех разборов.
 *
 * holdout-1 (H01–H06) засвечен разборами по ходу цикла → финал по нему нечестен.
 * HOLDOUT-2 не участвовал ни в одном замере/тюнинге и прогоняется РОВНО ОДИН РАЗ
 * в самом конце (sim/runner/holdout2.simtest.ts). Никакой мозг под него не
 * правился. Отдельный файл — чтобы физически не смешивался с buildCatalog.
 *
 * Состав: знакомые типы с НОВЫМИ параметрами/зёрнами (свежий мусор, внутри-
 * групповой раскол в другой группе, инверсия CTR/CR, смена режима) + ДВА
 * НЕЗНАКОМЫХ типа, которых не было ни в тюнинге, ни в holdout-1:
 *   HB4 «перекос устройств» — сигнал device-skew (инъекция среза Метрики),
 *       проверяет диагноз DEVICE_SKEW «Прозрения» на обобщение;
 *   HB5 «мёртвая группа» — вся группа беззаявочная (экстремальный раскол),
 *       которого по составу не было: пофразный биддинг должен увести ВСЮ группу
 *       в минимум, не приняв её за ядро.
 *
 * Движок мира НЕ трогали. Детерминизм — mulberry32 от (baseSeed, порядковый).
 */

import type { PhraseSpec, ReasonCode, ScenarioConfig } from '../types'
import {
  BASE_CONVERSION_LAG,
  BASE_WEEKDAY_DEMAND,
  BASE_YCLID_LOSS,
  clamp,
  jitter,
  jitterInt,
  keywordIdOf,
  makeAds,
  makeCpcByTv,
  makePhraseSet,
  makeTargetQuery,
  makeTrashTail,
  mulberry32,
  round4,
  TARGET_QUERY_VARIATIONS,
  type Rng,
} from './builders'

const WD = [...BASE_WEEKDAY_DEMAND] as ScenarioConfig['weekdayDemand']

/** Базовые умолчания калибровки (без draw'ов RNG). */
function base(
  id: string,
  name: string,
  days: number,
  rng: Rng,
  phrases: PhraseSpec[],
  extra: Partial<ScenarioConfig>
): ScenarioConfig {
  return {
    id,
    name,
    set: 'holdout',
    days,
    quarantineUntilDay: 0,
    phrases,
    queries: [makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[1], [keywordIdOf(0)], { share: 0.05 })],
    ads: makeAds(rng),
    events: [],
    weekdayDemand: WD,
    conversionLagDays: { ...BASE_CONVERSION_LAG },
    yclidLossRate: BASE_YCLID_LOSS,
    cpcByTv: makeCpcByTv(rng),
    expectations: { causeCodes: {}, anomalies: [], notes: 'holdout-2' },
    ...extra,
  }
}

/** HB1. Свежий мусорный хвост (срез C пула, другой джиттер). */
function hb1(rng: Rng): ScenarioConfig {
  const phrases = makePhraseSet(rng, [0, 1, 2, 3, 12, 13, 14, 20, 21, 28, 29])
  const trash = makeTrashTail(rng, [30, 31, 32, 39, 40, 41, 42, 43, 44, 45, 46], phrases, {
    shareBase: 0.12,
    sharePct: 0.3,
  })
  const causeCodes: Record<string, ReasonCode> = {}
  const top = [...trash].sort((a, b) => b.share - a.share).slice(0, 4)
  for (const t of top) causeCodes[`query:${t.query}`] = 'STRUCTURAL_TRASH'
  return base('HB1', 'Свежий мусор (срез C)', 21, rng, phrases, {
    queries: [...trash, makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[2], [keywordIdOf(1)], { share: 0.05 })],
    expectations: {
      causeCodes,
      anomalies: [],
      notes: 'Мусорный хвост из среза C пула (похудение/детские/посуда/бренды), новый джиттер — ' +
        'проверка минусовки по окну на незнакомых текстах.',
    },
  })
}

/** HB2. Внутри-групповой раскол в G2 (не G1, как в T25), другое соотношение. */
function hb2(rng: Rng): ScenarioConfig {
  const conv = [12, 13] // G2-конвертеры
  const burners = [15, 16, 17] // G2-горелки
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of conv) over[pi] = { trueCr: round4(clamp(jitter(rng, 0.07, 0.1), 0.06, 0.08)), demandPerDay: clamp(jitterInt(rng, 85, 0.15), 65, 110) }
  for (const pi of burners) over[pi] = { trueCr: round4(clamp(jitter(rng, 0.001, 0.5), 0.0003, 0.002)), demandPerDay: clamp(jitterInt(rng, 85, 0.15), 65, 110) }
  const phrases = makePhraseSet(rng, [12, 13, 14, 15, 16, 17], over)
  const causeCodes: Record<string, ReasonCode> = {}
  for (const pi of conv) causeCodes[`keyword:${keywordIdOf(pi)}`] = 'PROVEN_CONVERTER_VOLUME'
  for (const pi of burners) causeCodes[`keyword:${keywordIdOf(pi)}`] = 'TAIL_MIN_TV'
  return base('HB2', 'Раскол в G2', 21, rng, phrases, {
    expectations: {
      causeCodes,
      anomalies: [],
      notes: 'Внутри-групповой раскол в ДРУГОЙ группе (G2 Стройки), другое соотношение конвертеры/' +
        'горелки — обобщение пофразного биддинга за пределы T25.',
    },
  })
}

/** HB3. Смена режима: G8 теряет экономику с дня 10 (memory-сценарий, свежий). */
function hb3(rng: Rng): ScenarioConfig {
  const phrases = makePhraseSet(rng, [0, 1, 12, 13, 20, 21, 22, 28, 29])
  return base('HB3', 'Смена режима G8', 22, rng, phrases, {
    events: [{ kind: 'regime_change', day: 10, adGroupId: 'G8', newCrMultiplier: 0.1 }],
    expectations: {
      causeCodes: { [`keyword:${keywordIdOf(20)}`]: 'TAIL_MIN_TV' },
      anomalies: [],
      notes: 'С дня 10 группа G8 (склады) теряет конверсию (×0.1) — бывшие конвертеры становятся ' +
        'горелками. Проверка перестройки: пофразный биддирг обязан увести их в минимум к финалу.',
    },
  })
}

/** HB4 (НЕЗНАКОМЫЙ тип). Перекос устройств: мобайл с объёмом и 0 заявок. */
function hb4(rng: Rng): ScenarioConfig {
  const phrases = makePhraseSet(rng, [0, 1, 2, 12, 13, 20, 28])
  return base('HB4', 'Перекос устройств (мобайл 0 заявок)', 21, rng, phrases, {
    diagnostics: {
      deviceStats: [
        { device: 'PC', visits: 60, goalReaches: 5, bounceRate: 0.1 },
        { device: 'Smartphones', visits: 40, goalReaches: 0, bounceRate: 0.55 },
      ],
    },
    expectations: {
      causeCodes: { campaign: 'DEVICE_SKEW' },
      anomalies: [],
      notes: 'НЕЗНАКОМЫЙ тип: мобайл набирает объём (40 визитов) и 0 заявок при конвертящем ' +
        'десктопе, понижающей корректировки нет. Проверка диагноза DEVICE_SKEW «Прозрения» на ' +
        'обобщение — такого сигнала не было ни в тюнинге, ни в holdout-1.',
    },
  })
}

/** HB5 (НЕЗНАКОМЫЙ тип). Мёртвая группа: ВСЯ группа беззаявочная. */
function hb5(rng: Rng): ScenarioConfig {
  const dead = [20, 21, 22, 23] // вся G8 — горелки
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of dead) over[pi] = { trueCr: round4(clamp(jitter(rng, 0.001, 0.5), 0.0003, 0.002)), demandPerDay: clamp(jitterInt(rng, 80, 0.15), 60, 110) }
  const phrases = makePhraseSet(rng, [0, 1, 12, 13, 20, 21, 22, 23], over)
  const causeCodes: Record<string, ReasonCode> = {}
  for (const pi of dead) causeCodes[`keyword:${keywordIdOf(pi)}`] = 'TAIL_MIN_TV'
  return base('HB5', 'Мёртвая группа (вся беззаявочная)', 21, rng, phrases, {
    expectations: {
      causeCodes,
      anomalies: [],
      notes: 'НЕЗНАКОМЫЙ состав: ВСЯ группа G8 — горелки (клики есть, заявок нет). Пофразный ' +
        'биддинг обязан увести ВСЕ её фразы в минимум; групповой подход мог бы держать их на входе, ' +
        'если CTR группы случайно выше среднего.',
    },
  })
}

/** HOLDOUT-2: детерминирован по baseSeed, зёрна независимы по порядковому номеру. */
export function buildHoldout2(baseSeed: number): ScenarioConfig[] {
  const builders = [hb1, hb2, hb3, hb4, hb5]
  return builders.map((build, ordinal) => {
    const mixed = Math.imul(baseSeed ^ 0x51ed270b, 0x2545f491) ^ Math.imul(ordinal + 7, 0x9e3779b1)
    return build(mulberry32(mixed >>> 0))
  })
}
