import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { trackError } from '@/lib/errors/tracker'
import { ACTIVE_STATUSES } from './labels'

/**
 * Sprint 8.0 «Продажи»: дубли заявок по телефону (сайт шлёт phone_digits).
 * Все функции best effort и НИКОГДА не бросают: вызываются из /api/leads/intake,
 * где ответ сайту не должен зависеть от истории воронки.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Окно поиска активной заявки с тем же номером. */
export const DUPLICATE_WINDOW_DAYS = 30

/**
 * Самая свежая активная (стадия ∈ ACTIVE_STATUSES, не в архиве) заявка с тем же
 * phoneDigits, созданная за последние `withinDays` дней. Ошибка чтения → null.
 */
export async function findActiveLeadByPhone(
  phoneDigits: string,
  opts: { excludeId?: string; withinDays?: number; now?: Date } = {}
): Promise<{ id: string } | null> {
  if (!phoneDigits) return null
  const now = opts.now ?? new Date()
  const withinDays = opts.withinDays ?? DUPLICATE_WINDOW_DAYS
  try {
    return await prisma.landingLead.findFirst({
      where: {
        phoneDigits,
        pipelineStatus: { in: ACTIVE_STATUSES },
        archivedAt: null,
        createdAt: { gte: new Date(now.getTime() - withinDays * DAY_MS) },
        ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
  } catch (error) {
    await trackError({ error, level: 'warn', extra: { source: 'sales/findActiveLeadByPhone' } })
    return null
  }
}

/**
 * Повторная отправка формы тем же человеком, пока его заявка ещё активна
 * (ретрай в окне доставки): отметка в истории + «оживление» заявки в списке.
 */
export async function recordRepeatSubmission(
  leadId: string,
  meta?: Record<string, unknown>,
  now: Date = new Date()
): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.salesActivity.create({
        data: {
          leadId,
          kind: 'DUPLICATE',
          text: 'Повторная заявка с сайта',
          meta: meta ? (meta as Prisma.InputJsonObject) : undefined,
        },
      }),
      prisma.landingLead.update({ where: { id: leadId }, data: { lastActivityAt: now }, select: { id: true } }),
    ])
  } catch (error) {
    await trackError({ error, level: 'warn', extra: { source: 'sales/recordRepeatSubmission', leadId } })
  }
}

/**
 * Новая заявка с номером, по которому уже есть активная: обе карточки получают
 * пометку-ссылку друг на друга; старая поднимается в списке (lastActivityAt).
 */
export async function linkDuplicateLeads(
  newLeadId: string,
  existingLeadId: string,
  now: Date = new Date()
): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.salesActivity.create({
        data: {
          leadId: newLeadId,
          kind: 'DUPLICATE',
          text: 'Повтор: уже есть активная заявка с этим номером',
          meta: { duplicateOfLeadId: existingLeadId },
        },
      }),
      prisma.salesActivity.create({
        data: {
          leadId: existingLeadId,
          kind: 'DUPLICATE',
          text: 'Повторная заявка с сайта (новая карточка)',
          meta: { newLeadId },
        },
      }),
      prisma.landingLead.update({
        where: { id: existingLeadId },
        data: { lastActivityAt: now },
        select: { id: true },
      }),
    ])
  } catch (error) {
    await trackError({
      error,
      level: 'warn',
      extra: { source: 'sales/linkDuplicateLeads', newLeadId, existingLeadId },
    })
  }
}
