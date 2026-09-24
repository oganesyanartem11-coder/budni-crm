import type { Prisma, UserRole } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getMskDayEnd } from '@/lib/utils/msk-window'
import { ACTIVE_STATUSES, SALES_ROLES, type LeadFilter } from '@/lib/sales/labels'
import { sortLeadsForList } from '@/lib/sales/pipeline-rules'
import type {
  ClientOption,
  LeadDetail,
  LeadListItem,
  LeadPrefill,
  SalesAssignee,
  SalesToday,
} from '@/lib/sales/types'

/**
 * Sprint 8.0 «Продажи»: чтение воронки (только сервер: страницы /sales*, actions).
 * Явные select → DTO из types.ts (Decimal → number, Json → объект|null), без N+1.
 * Границы «сегодня» — МСК-сутки через msk-window (сервер на Vercel в UTC).
 */

const TASKS_LIMIT = 100
const NO_NEXT_STEP_LIMIT = 50
const LEADS_LIMIT = 200

const taskSelect = {
  id: true,
  type: true,
  title: true,
  dueAt: true,
  note: true,
  assigneeId: true,
} satisfies Prisma.SalesTaskSelect

const todayTaskSelect = {
  ...taskSelect,
  lead: { select: { id: true, name: true, company: true, phone: true } },
} satisfies Prisma.SalesTaskSelect

/** Задачи «Сегодня» показываем только по живым заявкам (активная стадия, не архив). */
const liveLeadWhere = {
  archivedAt: null,
  pipelineStatus: { in: ACTIVE_STATUSES },
} satisfies Prisma.LandingLeadWhereInput

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Блок «Сегодня»: просроченные / на сегодня (МСК-сутки) / активные без открытых задач. */
export async function getSalesToday(now: Date = new Date()): Promise<SalesToday> {
  const dayEnd = getMskDayEnd(now)
  const overdueWhere = {
    doneAt: null,
    dueAt: { lt: now },
    lead: liveLeadWhere,
  } satisfies Prisma.SalesTaskWhereInput
  const todayWhere = {
    doneAt: null,
    dueAt: { gte: now, lte: dayEnd },
    lead: liveLeadWhere,
  } satisfies Prisma.SalesTaskWhereInput
  const noNextStepWhere = {
    ...liveLeadWhere,
    tasks: { none: { doneAt: null } },
  } satisfies Prisma.LandingLeadWhereInput

  const [overdue, today, noNextStep] = await Promise.all([
    prisma.salesTask.findMany({
      where: overdueWhere,
      orderBy: { dueAt: 'asc' },
      take: TASKS_LIMIT,
      select: todayTaskSelect,
    }),
    prisma.salesTask.findMany({
      where: todayWhere,
      orderBy: { dueAt: 'asc' },
      take: TASKS_LIMIT,
      select: todayTaskSelect,
    }),
    prisma.landingLead.findMany({
      where: noNextStepWhere,
      orderBy: { lastActivityAt: 'desc' },
      take: NO_NEXT_STEP_LIMIT,
      select: { id: true, name: true, company: true, phone: true, pipelineStatus: true, lastActivityAt: true },
    }),
  ])

  // Счётчики точные: если упёрлись в лимит выборки — досчитываем count-запросом.
  const [overdueCount, todayCount, noNextStepCount] = await Promise.all([
    overdue.length < TASKS_LIMIT ? overdue.length : prisma.salesTask.count({ where: overdueWhere }),
    today.length < TASKS_LIMIT ? today.length : prisma.salesTask.count({ where: todayWhere }),
    noNextStep.length < NO_NEXT_STEP_LIMIT
      ? noNextStep.length
      : prisma.landingLead.count({ where: noNextStepWhere }),
  ])

  return {
    overdue,
    today,
    noNextStep,
    counts: { overdue: overdueCount, today: todayCount, noNextStep: noNextStepCount },
  }
}

function filterWhere(filter: LeadFilter): Prisma.LandingLeadWhereInput {
  switch (filter) {
    case 'new':
      return { pipelineStatus: 'NEW', archivedAt: null }
    case 'in_progress':
      return { pipelineStatus: 'IN_PROGRESS', archivedAt: null }
    case 'proposal':
      return { pipelineStatus: 'PROPOSAL_SENT', archivedAt: null }
    case 'trial':
      return { pipelineStatus: 'TRIAL', archivedAt: null }
    case 'contract':
      return { pipelineStatus: 'CONTRACT', archivedAt: null }
    case 'closed':
      return { pipelineStatus: { in: ['WON', 'LOST'] }, archivedAt: null }
    case 'archive':
      return { archivedAt: { not: null } }
    case 'active':
    default:
      return { pipelineStatus: { in: ACTIVE_STATUSES }, archivedAt: null }
  }
}

/** Цифры телефона из поискового запроса: «8 999 …» → «7999…» (как хранится phoneDigits). */
function searchDigits(q: string): string | null {
  let digits = q.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`
  return digits.length >= 3 ? digits : null
}

function searchWhere(q: string | undefined): Prisma.LandingLeadWhereInput | null {
  const term = q?.trim()
  if (!term) return null
  const or: Prisma.LandingLeadWhereInput[] = [
    { name: { contains: term, mode: 'insensitive' } },
    { company: { contains: term, mode: 'insensitive' } },
    { comment: { contains: term, mode: 'insensitive' } },
    { phone: { contains: term } },
  ]
  const digits = searchDigits(term)
  if (digits) or.push({ phoneDigits: { contains: digits } })
  return { OR: or }
}

/** Список заявок по фильтру + поиск; сортировка на сервере; лимит 200; без N+1. */
export async function getLeads(args: { filter: LeadFilter; q?: string; now?: Date }): Promise<LeadListItem[]> {
  const now = args.now ?? new Date()
  const search = searchWhere(args.q)
  const where: Prisma.LandingLeadWhereInput = search
    ? { AND: [filterWhere(args.filter), search] }
    : filterWhere(args.filter)

  const rows = await prisma.landingLead.findMany({
    where,
    orderBy: { lastActivityAt: 'desc' },
    take: LEADS_LIMIT,
    select: {
      id: true,
      name: true,
      company: true,
      phone: true,
      formType: true,
      source: true,
      pipelineStatus: true,
      lastActivityAt: true,
      createdAt: true,
      archivedAt: true,
      tasks: { where: { doneAt: null }, orderBy: { dueAt: 'asc' }, take: 1, select: taskSelect },
    },
  })

  const items: LeadListItem[] = rows.map(({ tasks, ...lead }) => ({ ...lead, nextTask: tasks[0] ?? null }))
  return sortLeadsForList(items, now)
}

/** Карточка заявки или null. */
export async function getLeadById(id: string): Promise<LeadDetail | null> {
  const lead = await prisma.landingLead.findUnique({
    where: { id },
    select: {
      id: true,
      formType: true,
      name: true,
      phone: true,
      phoneDigits: true,
      source: true,
      company: true,
      email: true,
      portionsHint: true,
      address: true,
      comment: true,
      answers: true,
      utmSource: true,
      utmCampaign: true,
      utmTerm: true,
      pipelineStatus: true,
      dealStatus: true,
      dealAmount: true,
      lostReason: true,
      lostComment: true,
      wonAt: true,
      lostAt: true,
      archivedAt: true,
      lastActivityAt: true,
      createdAt: true,
      client: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      tasks: { where: { doneAt: null }, orderBy: { dueAt: 'asc' }, select: taskSelect },
      activities: {
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { id: true, kind: true, text: true, meta: true, authorId: true, createdAt: true },
      },
    },
  })
  if (!lead) return null

  const { tasks, activities, dealAmount, answers, ...rest } = lead
  return {
    ...rest,
    dealAmount: dealAmount === null ? null : Number(dealAmount),
    answers: asRecord(answers),
    openTasks: tasks,
    activities: activities.map((a) => ({ ...a, meta: asRecord(a.meta) })),
  }
}

/** Активные клиенты для привязки (поиск по имени, лимит 20). */
export async function getClientsForLink(q?: string): Promise<ClientOption[]> {
  const term = q?.trim()
  return prisma.client.findMany({
    where: { isActive: true, ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}) },
    orderBy: { name: 'asc' },
    take: 20,
    select: { id: true, name: true },
  })
}

/** Активные пользователи SALES_ROLES ∪ MANAGER — для селекта «Ответственный». */
export async function getSalesAssignees(): Promise<SalesAssignee[]> {
  const roles = Array.from(new Set<UserRole>([...SALES_ROLES, 'MANAGER']))
  return prisma.user.findMany({
    where: { isActive: true, role: { in: roles } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, role: true },
  })
}

/** Минимум заявки для /clients/new?leadId=. */
export async function getLeadPrefill(id: string): Promise<LeadPrefill | null> {
  return prisma.landingLead.findUnique({
    where: { id },
    select: { id: true, name: true, company: true, phone: true },
  })
}
