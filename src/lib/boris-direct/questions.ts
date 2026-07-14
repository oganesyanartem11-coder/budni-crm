/**
 * ПАМЯТЬ ВОПРОСОВ (спринт 14.07, фундамент спринта 2 — рассуждающего контура).
 *
 * Аудит 14.07: выход недельного консилиума (5 гипотез) НИКУДА не сохранялся —
 * уходил только в Telegram, поэтому Борис не мог вернуться к своим же гипотезам и
 * проверить их (петли «гипотеза→проверка→вывод» не было — ядро жалобы владельца).
 *
 * Здесь — только ХРАНЕНИЕ + API поверх BorisDirectSnapshot (без миграций):
 *  - kind='consilium'      — текст гипотез недели со статусом open;
 *  - kind='analyst_questions' — список вопросов { id, question, status, check,
 *    result, даты }. Один снапшот держит весь список (документ): читаем последний,
 *    мутируем, пишем новый.
 *
 * LLM-ПОТРЕБИТЕЛЕЙ ЗДЕСЬ НЕТ (это спринт 2). Функции чистые по отношению к
 * решениям мозга: ни ставок, ни минусов, ни вердиктов не трогают.
 */

import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import { ANALYST_QUESTIONS_KEEP } from './config'

const CONSILIUM_KIND = 'consilium'
const QUESTIONS_KIND = 'analyst_questions'

export type QuestionStatus = 'open' | 'checking' | 'confirmed' | 'refuted'

/**
 * Машинная спецификация проверки из БЕЛОГО СПИСКА (спринт «Аналитик»): следующий
 * process-тик читает её и исполняет соответствующую read-only функцию. Ключ обязан
 * быть из реестра (analyst-checks.ts) — иначе исполнитель тихо пропускает. Хранится
 * как opaque-форма, чтобы questions.ts не зависел от реестра проверок.
 */
export interface AnalystCheckSpec {
  key: string
  params: Record<string, unknown>
}

export interface AnalystQuestion {
  id: string
  /** Сам вопрос/гипотеза («что изменилось, что это объясняет»). */
  question: string
  status: QuestionStatus
  /** Как дёшево проверить (детерминированная проверка для след. тика). */
  check: string
  /** Итог проверки (null, пока open/checking). */
  result: string | null
  createdMsk: string
  updatedMsk: string
  /** Тема (антизацикливание: одну тему не поднимаем повторно ANALYST_QUESTION_COOLDOWN_DAYS дней). */
  topicKey?: string
  /** Машинная проверка для следующего тика (белый список). Нет — вопрос без проверки. */
  checkSpec?: AnalystCheckSpec
  /** МСК-день, когда вопрос эскалирован владельцу (защита от повторной эскалации). */
  escalatedMsk?: string
}

/** Дата → МСК-день 'YYYY-MM-DD' (UTC+3). Локальный, чтобы не тянуть brain.ts. */
function toMskDay(date: Date): string {
  const msk = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  return msk.toISOString().slice(0, 10)
}

async function saveSnapshot(kind: string, tickDate: Date, payload: unknown): Promise<void> {
  await prisma.borisDirectSnapshot.create({
    data: {
      tickDate,
      kind,
      payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
    },
  })
}

async function latestPayload<T>(kind: string): Promise<T | null> {
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: { kind },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
  })
  return snap ? (snap.payload as unknown as T) : null
}

// ---------- Консилиум ----------

export interface PersistConsiliumInput {
  text: string
  from: string
  to: string
  now?: Date
}

/**
 * Персист гипотез недельного консилиума (kind='consilium', статус open). Пустой
 * текст (LLM упал/пусто) НЕ пишем — хранить нечего. Ошибку глотает вызывающий.
 */
export async function persistConsilium(input: PersistConsiliumInput): Promise<void> {
  if (!input.text || input.text.trim().length === 0) return
  const now = input.now ?? new Date()
  await saveSnapshot(CONSILIUM_KIND, now, {
    text: input.text.trim(),
    from: input.from,
    to: input.to,
    status: 'open',
    createdMsk: toMskDay(now),
  })
}

// ---------- Вопросы-аналитика ----------

function isActive(q: AnalystQuestion): boolean {
  return q.status === 'open' || q.status === 'checking'
}

export interface CreateQuestionInput {
  question: string
  check: string
  now?: Date
  topicKey?: string
  checkSpec?: AnalystCheckSpec
}

/**
 * Добавить вопрос-гипотезу (статус open). Дописывает к последнему снапшоту, не
 * теряя прежние; держит последние ANALYST_QUESTIONS_KEEP (прунинг документа-снапшота,
 * старейшие вытесняются). id детерминирован по дню+индексу (без Date.now/random).
 */
export async function createQuestion(input: CreateQuestionInput): Promise<void> {
  const now = input.now ?? new Date()
  const day = toMskDay(now)
  const existing = (await latestPayload<AnalystQuestion[]>(QUESTIONS_KIND)) ?? []
  const q: AnalystQuestion = {
    id: `q_${day}_${existing.length}`,
    question: input.question,
    status: 'open',
    check: input.check,
    result: null,
    createdMsk: day,
    updatedMsk: day,
    ...(input.topicKey ? { topicKey: input.topicKey } : {}),
    ...(input.checkSpec ? { checkSpec: input.checkSpec } : {}),
  }
  const next = [...existing, q]
  const pruned = next.length > ANALYST_QUESTIONS_KEEP ? next.slice(next.length - ANALYST_QUESTIONS_KEEP) : next
  await saveSnapshot(QUESTIONS_KIND, now, pruned)
}

/**
 * Обновить статус/результат вопроса по id (open→checking→confirmed/refuted).
 * Неизвестный id → снапшот НЕ пишем (нечего менять).
 */
export async function updateQuestion(
  id: string,
  patch: { status?: QuestionStatus; result?: string; escalatedMsk?: string },
  now: Date = new Date()
): Promise<void> {
  const existing = (await latestPayload<AnalystQuestion[]>(QUESTIONS_KIND)) ?? []
  const idx = existing.findIndex((q) => q.id === id)
  if (idx === -1) return
  const day = toMskDay(now)
  const updated = existing.map((q, i) =>
    i === idx
      ? {
          ...q,
          status: patch.status ?? q.status,
          result: patch.result !== undefined ? patch.result : q.result,
          ...(patch.escalatedMsk !== undefined ? { escalatedMsk: patch.escalatedMsk } : {}),
          updatedMsk: day,
        }
      : q
  )
  await saveSnapshot(QUESTIONS_KIND, now, updated)
}

/** Активные вопросы (open/checking) из последнего снапшота. */
export async function getActiveQuestions(): Promise<AnalystQuestion[]> {
  const existing = (await latestPayload<AnalystQuestion[]>(QUESTIONS_KIND)) ?? []
  return existing.filter(isActive)
}

/**
 * ВЕСЬ последний список вопросов, включая закрытые (confirmed/refuted). Нужен для
 * cooldown тем (учитывает и отклонённые темы) и для скана назначенных проверок.
 */
export async function getLatestQuestions(): Promise<AnalystQuestion[]> {
  return (await latestPayload<AnalystQuestion[]>(QUESTIONS_KIND)) ?? []
}

/** Разница в целых МСК-днях между двумя 'YYYY-MM-DD' (b − a). */
function dayDiff(a: string, b: string): number {
  const ad = Date.parse(`${a}T00:00:00Z`)
  const bd = Date.parse(`${b}T00:00:00Z`)
  if (!Number.isFinite(ad) || !Number.isFinite(bd)) return Number.POSITIVE_INFINITY
  return Math.round((bd - ad) / (24 * 60 * 60 * 1000))
}

/**
 * Тема на антизацикливающем cooldown? Чистая: тема считается «занятой», если ЛЮБОЙ
 * вопрос с таким topicKey создан менее чем `days` дней назад (граница days —
 * исключительна: ровно N дней назад уже можно). Пустой topicKey — никогда не на
 * cooldown (вопрос без темы). Как cooldown отказов предложений (PROPOSAL_COOLDOWN_DAYS).
 */
export function isTopicOnCooldown(
  questions: AnalystQuestion[],
  topicKey: string,
  todayMsk: string,
  days: number
): boolean {
  if (!topicKey) return false
  for (const q of questions) {
    if (q.topicKey !== topicKey) continue
    if (dayDiff(q.createdMsk, todayMsk) < days) return true
  }
  return false
}
