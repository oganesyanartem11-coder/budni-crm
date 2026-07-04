/**
 * SimContext — единая шина одного прогона полигона Бориса-Директа.
 *
 * Через неё общаются фейки транспорта (fakes/*): фейк-присма пишет сюда
 * createdAt по виртуальным часам, фейк-клиент Директа читает мир и пишет
 * CapturedAction, фейк-отчёты и фейк-метрика читают наблюдаемое по дням
 * (days), фейк-телеграм складывает алерты.
 *
 * Правда мира (world.truthClicks и пр.) фейками НЕ читается — только
 * наблюдаемые проекции и текущее видимое состояние кампании (ставки,
 * минусы, остановки, тег Метрики).
 *
 * Время: виртуальные дни, день 0 = понедельник 6 июля 2026 (МСК).
 * «Момент» дня n — МСК-полдень: Date.UTC(2026,6,6,9,0,0) + n×сутки
 * (09:00 UTC = 12:00 МСК). Так createdAt фейк-присмы всегда попадает
 * внутрь нужного МСК-дня для оконных выборок мозга (mskDayStartUtc).
 */

import type {
  CapturedAction,
  DayObservables,
  PolicyName,
  WorldState,
} from '../types'
import type { WorldEngine } from '../engine/api'
import { createFakePrisma, type FakePrisma } from './prisma'

export type { FakePrisma } from './prisma'

const DAY_MS = 24 * 60 * 60 * 1000
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** МСК-полдень дня 0 (понедельник 2026-07-06 12:00 МСК = 09:00 UTC). */
export const SIM_DAY0_NOON_UTC_MS = Date.UTC(2026, 6, 6, 9, 0, 0)

/** Начало МСК-дня 0 как UTC-момент (2026-07-06T00:00+03:00). */
const DAY0_MSK_MIDNIGHT_UTC_MS = SIM_DAY0_NOON_UTC_MS - 12 * 60 * 60 * 1000

/** Виртуальный день n → «МСК-полдень» этого дня (UTC-момент). */
export function dayToDate(day: number): Date {
  return new Date(SIM_DAY0_NOON_UTC_MS + day * DAY_MS)
}

/** Произвольный момент → номер виртуального МСК-дня, в который он попадает. */
export function dateToDay(date: Date): number {
  return Math.floor((date.getTime() - DAY0_MSK_MIDNIGHT_UTC_MS) / DAY_MS)
}

/** Виртуальный день n → 'YYYY-MM-DD' по МСК (формат Метрики и Reports API). */
export function dayToMskString(day: number): string {
  return new Date(dayToDate(day).getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' (МСК-день) → номер виртуального дня. */
export function mskStringToDay(mskDay: string): number {
  return dateToDay(new Date(`${mskDay}T12:00:00+03:00`))
}

/** Алерт, пойманный фейк-телеграмом (kind='tg') или иным фейком. */
export interface SimAlert {
  day: number
  kind: string
  text: string
}

export interface SimContextOptions {
  engine: WorldEngine
  world: WorldState
  policy: PolicyName
  llmMode: 'live' | 'stub'
  /** Сколько ПЕРВЫХ poll'ов отчётов вернуть pending (0 = отчёт готов сразу). */
  reportDelayPolls?: number
}

export class SimContext {
  /** Движок мира — фейк-клиент зовёт его мутаторы (setBid и пр.). */
  readonly engine: WorldEngine
  /** Состояние мира текущего прогона (фейки читают только наблюдаемую часть). */
  readonly world: WorldState
  /** Чья политика гоняется — проставляется в CapturedAction.by. */
  readonly policy: PolicyName
  /** 'live' = настоящий LLM с дисковым кешем; 'stub' = эвристика без сети. */
  readonly llmMode: 'live' | 'stub'
  /** МСК-полдень дня 0 — базовая точка виртуального времени. */
  readonly baseDate: Date

  /** Наблюдаемое по дням: раннер пушит результат engine.advanceDay(). */
  days: DayObservables[] = []
  /** Все write-действия, пойманные фейк-клиентом Директа. */
  captured: CapturedAction[] = []
  /** Сообщения фейк-телеграма и прочие алерты прогона. */
  alerts: SimAlert[] = []
  /** Оставшееся число poll'ов отчётов, которым отвечать pending. */
  reportDelayPolls: number
  /** Виртуальное «сегодня» (день по МСК) — источник createdAt фейк-присмы. */
  clockDay = 0
  /** In-memory Prisma прогона (см. sim/fakes/prisma.ts) — раннер подменяет ею @/lib/db/prisma. */
  readonly fakePrisma: FakePrisma

  private readonly initialReportDelayPolls: number

  constructor(opts: SimContextOptions) {
    this.engine = opts.engine
    this.world = opts.world
    this.policy = opts.policy
    this.llmMode = opts.llmMode
    this.baseDate = new Date(SIM_DAY0_NOON_UTC_MS)
    this.reportDelayPolls = opts.reportDelayPolls ?? 0
    this.initialReportDelayPolls = this.reportDelayPolls
    // Часы фейк-присмы — этот же контекст (currentDate по clockDay).
    this.fakePrisma = createFakePrisma(this)
  }

  /** Текущий виртуальный момент (МСК-полдень дня clockDay). */
  currentDate(): Date {
    return dayToDate(this.clockDay)
  }

  /**
   * Сброс накопителей прогона (days/captured/alerts/часы/задержка отчётов/
   * таблицы фейк-присмы). Мир НЕ пересоздаётся — новый мир делает раннер
   * через engine.createWorld и новый SimContext.
   */
  reset(): void {
    this.days = []
    this.captured = []
    this.alerts = []
    this.clockDay = 0
    this.reportDelayPolls = this.initialReportDelayPolls
    this.fakePrisma.$reset()
  }
}

/**
 * Singleton текущего прогона: раннер ставит simContext.current перед прогоном
 * и снимает после. Фейки, обязанные держать сигнатуры реальных модулей
 * (без параметра ctx), достают контекст через getCtx().
 */
export const simContext = { current: null as SimContext | null }

export function getCtx(): SimContext {
  if (!simContext.current) {
    throw new Error(
      '[sim/fakes] SimContext не установлен: раннер обязан присвоить simContext.current ' +
        'до запуска мозга/фейков (см. sim/fakes/context.ts)'
    )
  }
  return simContext.current
}
