/**
 * Публичная поверхность модуля Командного Бориса (Спринт 7.16.C).
 *
 * Внешние вызывающие импортируют отсюда. Внутренние файлы (personality,
 * частные helpers) остаются деталями реализации.
 */

export type {
  TeamChannel,
  TeamEventInput,
  ClientOrderAggregate,
  ToneSummary,
  DayContext,
  WeekContext,
  EventContext,
  TeamPostResult,
} from './types'

export { buildDayContext, buildWeekContext } from './context-builder'
export { formatTeamPost } from './ai-formatter'
export { logBorisEvent } from './event-log'
