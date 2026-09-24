import type { LandingLeadDealStatus, LeadLostReason, LeadPipelineStatus, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { trackError } from '@/lib/errors/tracker'
import { formatMoney } from '@/lib/utils/format'
import {
  LOST_REASON_RU,
  PIPELINE_STATUS_RU,
  dealStatusToPipeline,
  pipelineToDealStatus,
} from './labels'

/**
 * Sprint 8.0 «Продажи»: синхронизация стадии воронки ↔ dealStatus.
 *
 * Направление 1 (CRM → Борис): applyPipelineStatus — единая смена стадии из
 * Core; пишет и pipelineStatus, и dealStatus (его читают Борис-Директ и
 * офлайн-конверсии). Направление 2 (Борис → CRM): syncPipelineFromDealStatus —
 * после того как Борис записал dealStatus, двигает стадию, НЕ трогая dealStatus
 * (поэтому взаимной рекурсии нет).
 */

export interface ApplyPipelineExtra {
  authorId?: string | null
  lostReason?: LeadLostReason | null
  lostComment?: string | null
  dealAmount?: number | null
  /** Хвост текста активности, напр. ' (через Telegram)'. */
  note?: string
  now?: Date
}

/** «Стал клиентом · 120 000 ₽/мес» */
function wonText(dealAmount: number | null | undefined): string {
  return `Стал клиентом${typeof dealAmount === 'number' ? ` · ${formatMoney(dealAmount)}/мес` : ''}`
}

/** «Отказ: Дорого — нашли дешевле» */
function lostText(reason: LeadLostReason | null | undefined, comment: string | null | undefined): string {
  const head = reason ? `Отказ: ${LOST_REASON_RU[reason]}` : 'Отказ'
  return comment ? `${head} — ${comment}` : head
}

/**
 * Единая смена стадии. WON/LOST пишут ОДНО событие своего вида (WON/LOST, в meta
 * откуда пришли), остальные — STATUS_CHANGE «Стадия: X → Y». Та же стадия:
 * пишем только изменившиеся доп. поля (сумма для WON, причина/комментарий для
 * LOST); нечего менять → ничего не пишем, changed:false. changed — «что-то
 * записали». Бросает, если заявки нет (Core проверяет это раньше).
 */
export async function applyPipelineStatus(
  leadId: string,
  status: LeadPipelineStatus,
  extra: ApplyPipelineExtra = {}
): Promise<{ changed: boolean; from: LeadPipelineStatus; to: LeadPipelineStatus }> {
  const now = extra.now ?? new Date()
  const lead = await prisma.landingLead.findUnique({
    where: { id: leadId },
    select: { pipelineStatus: true, wonAt: true, dealAmount: true, lostReason: true, lostComment: true },
  })
  if (!lead) throw new Error('Заявка не найдена')

  const from = lead.pipelineStatus
  const to = status
  const note = extra.note ?? ''
  // null для суммы = «не указали» (не стираем сохранённую раньше).
  const amount = typeof extra.dealAmount === 'number' ? extra.dealAmount : undefined
  const authorId = extra.authorId ?? null

  const data: Prisma.LandingLeadUpdateInput = { lastActivityAt: now }
  let activity: Prisma.SalesActivityUncheckedCreateInput

  if (from === to) {
    if (to === 'WON') {
      const current = lead.dealAmount === null ? null : Number(lead.dealAmount)
      if (amount === undefined || amount === current) return { changed: false, from, to }
      data.dealAmount = amount
      activity = {
        leadId,
        kind: 'WON',
        text: `Сумма сделки: ${formatMoney(amount)}/мес${note}`,
        meta: { from, to, dealAmount: amount },
        authorId,
      }
    } else if (to === 'LOST') {
      const reason = extra.lostReason ?? lead.lostReason
      const comment = extra.lostComment === undefined ? lead.lostComment : extra.lostComment
      if (reason === lead.lostReason && comment === lead.lostComment) return { changed: false, from, to }
      data.lostReason = reason
      data.lostComment = comment
      activity = {
        leadId,
        kind: 'LOST',
        text: `${lostText(reason, comment)}${note}`,
        meta: { from, to, lostReason: reason },
        authorId,
      }
    } else {
      return { changed: false, from, to }
    }
  } else {
    data.pipelineStatus = to
    data.dealStatus = pipelineToDealStatus(to)
    if (to === 'WON') {
      data.wonAt = lead.wonAt ?? now
      data.lostAt = null
      data.lostReason = null
      data.lostComment = null
      if (amount !== undefined) data.dealAmount = amount
      const shownAmount = amount ?? (lead.dealAmount === null ? null : Number(lead.dealAmount))
      activity = {
        leadId,
        kind: 'WON',
        text: `${wonText(shownAmount)}${note}`,
        meta: { from, to, dealAmount: shownAmount },
        authorId,
      }
    } else if (to === 'LOST') {
      const reason = extra.lostReason ?? null
      const comment = extra.lostComment ?? null
      data.lostAt = now
      data.lostReason = reason
      data.lostComment = comment
      data.wonAt = null
      activity = {
        leadId,
        kind: 'LOST',
        text: `${lostText(reason, comment)}${note}`,
        meta: { from, to, lostReason: reason },
        authorId,
      }
    } else {
      // Движение по активным стадиям (в т.ч. возврат из WON/LOST): итоги сделки сбрасываем.
      data.wonAt = null
      data.lostAt = null
      data.lostReason = null
      data.lostComment = null
      activity = {
        leadId,
        kind: 'STATUS_CHANGE',
        text: `Стадия: ${PIPELINE_STATUS_RU[from]} → ${PIPELINE_STATUS_RU[to]}${note}`,
        meta: { from, to },
        authorId,
      }
    }
  }

  await prisma.$transaction([
    prisma.landingLead.update({ where: { id: leadId }, data, select: { id: true } }),
    prisma.salesActivity.create({ data: activity }),
  ])
  return { changed: true, from, to }
}

// Кто двинул стадию — в родительном падеже для «(через …)».
const VIA_GENITIVE: Record<string, string> = {
  'Борис-Директ': 'Бориса-Директ',
}

/**
 * Борис-Директ записал dealStatus («Борис, сделка …») → двигаем стадию воронки
 * по dealStatusToPipeline (WON/LOST — всегда, IN_PROGRESS — только из NEW,
 * NONE — без изменений). dealStatus НЕ пишем (его уже записал Борис). Никогда не
 * бросает: ответ Бориса в чат важнее истории воронки.
 */
export async function syncPipelineFromDealStatus(
  leadId: string,
  dealStatus: LandingLeadDealStatus,
  opts: { authorLabel?: string } = {}
): Promise<void> {
  try {
    const lead = await prisma.landingLead.findUnique({
      where: { id: leadId },
      select: { pipelineStatus: true, wonAt: true },
    })
    if (!lead) return
    const from = lead.pipelineStatus
    const to = dealStatusToPipeline(dealStatus, from)
    if (!to) return

    const now = new Date()
    const data: Prisma.LandingLeadUpdateInput = { pipelineStatus: to, lastActivityAt: now }
    if (to === 'WON') {
      data.wonAt = lead.wonAt ?? now
      data.lostAt = null
      data.lostReason = null
      data.lostComment = null
    } else if (to === 'LOST') {
      data.lostAt = now
      data.wonAt = null
    }

    const via = opts.authorLabel ? ` (через ${VIA_GENITIVE[opts.authorLabel] ?? opts.authorLabel})` : ''
    await prisma.$transaction([
      prisma.landingLead.update({ where: { id: leadId }, data, select: { id: true } }),
      prisma.salesActivity.create({
        data: {
          leadId,
          kind: 'STATUS_CHANGE',
          text: `Стадия: ${PIPELINE_STATUS_RU[from]} → ${PIPELINE_STATUS_RU[to]}${via}`,
          meta: { from, to, dealStatus, via: opts.authorLabel ?? null },
        },
      }),
    ])
  } catch (error) {
    await trackError({
      error,
      level: 'warn',
      extra: { source: 'sales/syncPipelineFromDealStatus', leadId, dealStatus },
    })
  }
}
