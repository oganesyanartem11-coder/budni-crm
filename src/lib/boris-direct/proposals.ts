/**
 * Память предложений Бориса-Директа владельцу (BorisDirectProposal).
 *
 * Жизненный цикл: createProposal (дедуп по PENDING + cooldown после отказа) →
 * сообщение в чат Директа с кнопками bdir:accept/<id> и bdir:reject/<id> →
 * decideProposal по клику (атомарный claim от двойного тапа) →
 * ПРИМЕНЕНИЕ принятого делает дневной цикл мозга, НЕ колбэк:
 * мозг берёт getAcceptedUnapplied(), применяет и зовёт markProposalApplied().
 *
 * «Применено» фиксируем флагом payload.applied=true (отдельного поля в модели
 * нет, миграция уже зафиксирована; статус ACCEPTED сохраняет семантику решения
 * владельца, CANCELLED не используем — это отмена, а не применение).
 */

import { InlineKeyboard } from 'grammy'
import type { BorisDirectProposal, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  MICRO,
  PROPOSAL_COOLDOWN_DAYS,
  PROPOSAL_TRIGGER_SHIFT,
  PROPOSAL_TTL_DAYS,
} from './config'
import { setAutoNegativesEnabled } from './state'
import { recordOwnerDecision } from './learning'
import { sendToDirectChat } from './telegram'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ProposalInput {
  type: string
  topicKey: string
  payload: unknown
  argument: string
  question: string
  triggerMetric?: string
  triggerValue?: number
}

// Минимальный HTML-эскейп под parseMode='HTML' (динамика в сообщениях).
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/** Короткая человекочитаемая шапка предложения по типу. */
export function formatProposalSummary(type: string, payload: unknown): string {
  const p = asRecord(payload)
  switch (type) {
    case 'minus_words': {
      const words = Array.isArray(p.words) ? p.words.map(String) : []
      const head = words.slice(0, 5).join(', ')
      const tail = words.length > 5 ? '…' : ''
      return `Минус-фразы: ${words.length} шт${head ? `: ${head}${tail}` : ''}`
    }
    case 'budget': {
      const rub =
        typeof p.dailyBudgetRub === 'number'
          ? p.dailyBudgetRub
          : typeof p.amountMicro === 'number'
            ? p.amountMicro / MICRO
            : null
      return rub !== null ? `Дневной бюджет: ${rub} ₽` : 'Дневной бюджет'
    }
    case 'lift_minus_gate':
      return 'Снять гейт спорных минусов'
    case 'device_skew':
      return `Корректировка по устройству: ${typeof p.device === 'string' ? p.device : ''} (слив без заявок)`.trim()
    case 'schedule_waste':
      return 'Расписание показов (расход в мёртвое время)'
    case 'audience_waste':
      return `Корректировка по демографии: ${typeof p.segment === 'string' ? p.segment : ''}`.trim()
    case 'group_minus_gap':
      return `Перенос минуса на уровень групп: ${typeof p.negative === 'string' ? `«${p.negative}»` : ''}`.trim()
    default:
      return type
  }
}

/**
 * Относительный сдвиг метрики-триггера. old=0 — особый случай: любой ненулевой
 * new считаем бесконечным сдвигом, new=0 — нулевым.
 */
function relativeShift(newValue: number, oldValue: number): number {
  if (oldValue === 0) return newValue === 0 ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(newValue - oldValue) / Math.abs(oldValue)
}

/**
 * Создать предложение владельцу.
 *
 * Дедуп/cooldown по topicKey:
 *  1. уже висит PENDING → не дублируем;
 *  2. последний отказ ещё в cooldown → молчим, КРОМЕ случая когда
 *     метрика-триггер сдвинулась на ≥PROPOSAL_TRIGGER_SHIFT — тогда можно
 *     вернуться раньше (аргумент со ссылкой на изменение пишет вызывающий).
 *
 * Ошибка отправки в чат НЕ откатывает создание: предложение остаётся PENDING,
 * владелец увидит его при следующем касании (console.error, без ретраев тут).
 */
export async function createProposal(
  input: ProposalInput
): Promise<{ created: boolean; reason?: 'pending_exists' | 'cooldown' }> {
  const pending = await prisma.borisDirectProposal.findFirst({
    where: { topicKey: input.topicKey, status: 'PENDING' },
    select: { id: true },
  })
  if (pending) return { created: false, reason: 'pending_exists' }

  const now = new Date()
  const lastRejected = await prisma.borisDirectProposal.findFirst({
    where: { topicKey: input.topicKey, status: 'REJECTED' },
    orderBy: { decidedAt: 'desc' },
  })
  if (lastRejected?.cooldownUntil && lastRejected.cooldownUntil > now) {
    const oldValue =
      lastRejected.triggerValue === null ? null : Number(lastRejected.triggerValue)
    const shiftEnough =
      input.triggerValue !== undefined &&
      oldValue !== null &&
      relativeShift(input.triggerValue, oldValue) >= PROPOSAL_TRIGGER_SHIFT
    if (!shiftEnough) return { created: false, reason: 'cooldown' }
    // Сдвиг ≥ порога — cooldown снимается, идём создавать.
  }

  const proposal = await prisma.borisDirectProposal.create({
    data: {
      type: input.type,
      topicKey: input.topicKey,
      payload: input.payload as Prisma.InputJsonValue,
      argument: input.argument,
      question: input.question,
      triggerMetric: input.triggerMetric ?? null,
      triggerValue: input.triggerValue ?? null,
    },
  })

  const text =
    `💡 <b>ПРЕДЛОЖЕНИЕ</b>\n` +
    `${escapeHtml(formatProposalSummary(input.type, input.payload))}\n` +
    `\n` +
    `<b>АРГУМЕНТ</b>\n${escapeHtml(input.argument)}\n` +
    `\n` +
    `<b>ВОПРОС</b>\n${escapeHtml(input.question)}`

  const keyboard = new InlineKeyboard()
    .text('✅ Да', `bdir:accept:${proposal.id}`)
    .text('❌ Нет', `bdir:reject:${proposal.id}`)

  const sent = await sendToDirectChat(text, { replyMarkup: keyboard })
  if (!sent.ok) {
    // Предложение остаётся PENDING — не теряем, просто не доехало сообщение.
    console.error(
      `[boris-direct/proposals] отправка предложения ${proposal.id} не удалась: ${sent.error}`
    )
  }

  return { created: true }
}

/**
 * Решение владельца по кнопке. Атомарный claim через updateMany по
 * status=PENDING (образец boris/executor.ts) — двойной клик не решит дважды.
 *
 * ВАЖНО: применение принятого к Директу (заливка минусов и т.п.) делает
 * дневной цикл мозга, не этот колбэк — summaryText для accept так и говорит.
 */
export async function decideProposal(
  id: string,
  action: 'accept' | 'reject'
): Promise<{ ok: boolean; summaryText: string }> {
  const now = new Date()
  const data: Prisma.BorisDirectProposalUpdateManyMutationInput =
    action === 'accept'
      ? { status: 'ACCEPTED', decidedAt: now }
      : {
          status: 'REJECTED',
          decidedAt: now,
          cooldownUntil: new Date(now.getTime() + PROPOSAL_COOLDOWN_DAYS * DAY_MS),
        }

  const claim = await prisma.borisDirectProposal.updateMany({
    where: { id, status: 'PENDING' },
    data,
  })
  if (claim.count === 0) {
    return { ok: false, summaryText: 'Это предложение уже решено.' }
  }

  const proposal = await prisma.borisDirectProposal.findUnique({ where: { id } })
  const summary = proposal
    ? escapeHtml(formatProposalSummary(proposal.type, proposal.payload))
    : 'предложение'

  // Спец-обработка по типу.
  if (proposal?.type === 'minus_words') {
    await recordOwnerDecision(id, action === 'accept')
  }
  if (proposal?.type === 'lift_minus_gate' && action === 'accept') {
    await setAutoNegativesEnabled(true)
    // Гейт снят прямо здесь — мозгу применять нечего, помечаем сразу.
    await markProposalApplied(id)
    return {
      ok: true,
      summaryText:
        'Гейт снят — спорные минусы беру в автономию. Вернуть в любой момент: "Борис, верни гейт".',
    }
  }

  if (action === 'accept') {
    return {
      ok: true,
      summaryText: `Принято: ${summary}. Применю на ближайшем тике и отчитаюсь.`,
    }
  }
  return {
    ok: true,
    summaryText:
      `Отклонено: ${summary}. Тему не поднимаю ${PROPOSAL_COOLDOWN_DAYS} дней — ` +
      `вернусь раньше, только если метрика сдвинется на ${Math.round(PROPOSAL_TRIGGER_SHIFT * 100)}%.`,
  }
}

/** PENDING старше PROPOSAL_TTL_DAYS → EXPIRED. Возвращает число протухших. */
export async function expireStaleProposals(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PROPOSAL_TTL_DAYS * DAY_MS)
  const result = await prisma.borisDirectProposal.updateMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    data: { status: 'EXPIRED' },
  })
  return result.count
}

/**
 * Принятые владельцем, но ещё не применённые мозгом предложения.
 * «Применено» = payload.applied === true (см. шапку файла).
 */
export async function getAcceptedUnapplied(): Promise<BorisDirectProposal[]> {
  const rows = await prisma.borisDirectProposal.findMany({
    where: { status: 'ACCEPTED' },
    orderBy: { decidedAt: 'asc' },
  })
  return rows.filter((row) => asRecord(row.payload).applied !== true)
}

/**
 * Мозг применил принятое предложение → ставим payload.applied=true.
 * Не-объектный payload оборачиваем в { value } чтобы не потерять данные.
 */
export async function markProposalApplied(id: string): Promise<void> {
  const row = await prisma.borisDirectProposal.findUnique({ where: { id } })
  if (!row) return
  const base =
    typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : { value: row.payload }
  await prisma.borisDirectProposal.update({
    where: { id },
    data: { payload: { ...base, applied: true } as Prisma.InputJsonValue },
  })
}
