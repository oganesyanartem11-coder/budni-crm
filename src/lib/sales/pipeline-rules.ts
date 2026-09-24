import type { LeadPipelineStatus, SalesTaskType } from '@prisma/client'
import { PIPELINE_STEPS, isActiveStatus } from './labels'
import type { LeadListItem } from './types'

/**
 * Sprint 8.0 «Продажи»: чистые правила воронки (без I/O) — отдельно от Core и
 * queries, чтобы тестировать без моков prisma.
 */

function stepIndex(status: LeadPipelineStatus): number {
  return (PIPELINE_STEPS as readonly LeadPipelineStatus[]).indexOf(status)
}

/**
 * Куда логично сдвинуть стадию после выполненной задачи. Только вперёд по
 * степперу и только для активной заявки: «Отправить КП» → КП отправлено,
 * «Пробный день» → Пробный день, звонок/письмо/встреча — «В работе», но лишь из
 * «Новая». Иначе null (не откатываем Договор в КП и т.п.).
 */
export function suggestStatusAfterTask(
  type: SalesTaskType,
  current: LeadPipelineStatus
): LeadPipelineStatus | null {
  if (!isActiveStatus(current)) return null
  let target: LeadPipelineStatus | null = null
  switch (type) {
    case 'SEND_PROPOSAL':
      target = 'PROPOSAL_SENT'
      break
    case 'TRIAL':
      target = 'TRIAL'
      break
    case 'CALL':
    case 'WRITE':
    case 'MEETING':
      target = current === 'NEW' ? 'IN_PROGRESS' : null
      break
    default:
      target = null
  }
  if (!target) return null
  return stepIndex(target) > stepIndex(current) ? target : null
}

/**
 * Порядок списка /sales: сначала с просроченной задачей (самые старые сроки
 * выше), затем с будущей задачей (ближайшие выше), затем без задач (свежая
 * активность выше). Не мутирует вход.
 */
export function sortLeadsForList<T extends Pick<LeadListItem, 'id' | 'lastActivityAt' | 'nextTask'>>(
  items: T[],
  now: Date
): T[] {
  const rank = (item: T): number => {
    if (!item.nextTask) return 2
    return item.nextTask.dueAt.getTime() < now.getTime() ? 0 : 1
  }
  return [...items].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra < 2) {
      const diff = a.nextTask!.dueAt.getTime() - b.nextTask!.dueAt.getTime()
      if (diff !== 0) return diff
    } else {
      const diff = b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
      if (diff !== 0) return diff
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
