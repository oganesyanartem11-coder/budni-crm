// Баррель тематических файлов доктрины. Каждый items/<theme>.json — массив
// СЫРЫХ карточек (валидируются в loader.ts). Добавляя тему — добавь import сюда
// и вставь спред в RAW_DOCTRINE. Статические импорты (а не FS-чтение) — чтобы
// файлы попадали в бандл serverless-функций Vercel.

import auction from './auction.json'
import trafficVolume from './traffic-volume.json'
import qualityCtr from './quality-ctr.json'
import keywordsMatch from './keywords-match.json'
import negativeKeywords from './negative-keywords.json'
import autotargeting from './autotargeting.json'
import strategies from './strategies.json'
import payPerConversion from './pay-per-conversion.json'
import budgets from './budgets.json'
import moderation from './moderation.json'
import metrikaGoals from './metrika-goals.json'
import metrikaAttribution from './metrika-attribution.json'

/** Сырые карточки из всех тематических файлов (валидация — в loader). */
export const RAW_DOCTRINE: unknown[] = [
  ...auction,
  ...trafficVolume,
  ...qualityCtr,
  ...keywordsMatch,
  ...negativeKeywords,
  ...autotargeting,
  ...strategies,
  ...payPerConversion,
  ...budgets,
  ...moderation,
  ...metrikaGoals,
  ...metrikaAttribution,
]
