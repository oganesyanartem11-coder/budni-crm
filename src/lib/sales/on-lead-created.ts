import { prisma } from '@/lib/db/prisma'
import { trackError } from '@/lib/errors/tracker'
import { formTypeLabel, sourceLabel } from './labels'
import { nextContactSlot } from './time'

/**
 * Sprint 8.0 «Продажи»: единый hook «заявка появилась» для всех точек входа
 * (сайт /api/leads/intake, «Борис, звонок …», ручное создание в /sales/new).
 * Пишет событие INCOMING в историю, ставит авто-задачу «Связаться» на ближайший
 * рабочий слот и поднимает заявку в списке. Никогда не бросает наружу.
 */

export type LeadCreatedSource = 'site' | 'boris_call' | 'manual'

export interface OnLeadCreatedResult {
  ok: boolean
  /** id авто-задачи «Связаться», если создана. */
  taskId?: string
}

/** Текст события INCOMING в истории заявки. */
export function incomingText(
  source: LeadCreatedSource,
  lead: { formType: string; source: string | null }
): string {
  if (source === 'boris_call') return 'Звонок (через Бориса)'
  if (source === 'manual') return 'Заведена вручную'
  const src = sourceLabel(lead.source)
  // FORM_TYPE_RU для сайта уже с префиксом «Сайт: …» — не повторяем его после «Заявка с сайта:».
  const form = formTypeLabel(lead.formType).replace(/^Сайт:\s*/, '')
  return `Заявка с сайта: ${form}${src ? ` · ${src}` : ''}`
}

export async function onLeadCreated(args: {
  leadId: string
  source: LeadCreatedSource
  actorUserId?: string | null
  now?: Date
}): Promise<OnLeadCreatedResult> {
  const now = args.now ?? new Date()
  const actor = args.actorUserId ?? null
  try {
    const lead = await prisma.landingLead.findUnique({
      where: { id: args.leadId },
      select: { id: true, formType: true, source: true },
    })
    if (!lead) throw new Error(`заявка ${args.leadId} не найдена`)

    // Массив-форма транзакции — pgbouncer-safe (interactive через pooler падает).
    const [task] = await prisma.$transaction([
      prisma.salesTask.create({
        data: {
          leadId: lead.id,
          type: 'CALL',
          title: 'Связаться',
          dueAt: nextContactSlot(now),
          assigneeId: actor,
          createdById: actor,
        },
        select: { id: true },
      }),
      prisma.salesActivity.create({
        data: { leadId: lead.id, kind: 'INCOMING', text: incomingText(args.source, lead), authorId: actor },
      }),
      prisma.landingLead.update({ where: { id: lead.id }, data: { lastActivityAt: now }, select: { id: true } }),
    ])
    return { ok: true, taskId: task.id }
  } catch (error) {
    await trackError({ error, level: 'error', extra: { source: 'sales/onLeadCreated', leadId: args.leadId } })
    return { ok: false }
  }
}

/**
 * Ближайшая (по dueAt) открытая задача заявки — для кнопки «✅ Связался» при
 * лечащем ретрае intake, где hook повторно не зовём. Ошибка → null.
 */
export async function findFirstOpenTaskId(leadId: string): Promise<string | null> {
  try {
    const task = await prisma.salesTask.findFirst({
      where: { leadId, doneAt: null },
      orderBy: { dueAt: 'asc' },
      select: { id: true },
    })
    return task?.id ?? null
  } catch (error) {
    await trackError({ error, level: 'warn', extra: { source: 'sales/findFirstOpenTaskId', leadId } })
    return null
  }
}
