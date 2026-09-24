import { z } from 'zod'
import { LeadLostReason, LeadPipelineStatus, SalesTaskType } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMskDateTimeShort, formatPhoneMask } from '@/lib/utils/format'
import type {
  AddLeadNoteInput,
  AssignLeadInput,
  ChangeLeadStatusInput,
  CompleteTaskResult,
  CreateLeadInput,
  CreateTaskInput,
  LinkLeadToClientInput,
  RescheduleTaskInput,
  SalesActionResult,
  SalesActor,
  UpdateLeadFieldsInput,
} from './types'
import {
  ACTIVE_STATUSES,
  MANUAL_SOURCE_CODES,
  TASK_TYPE_RU,
  isSalesRole,
  leadDisplayName,
} from './labels'
import { toPhoneDigits } from './phone'
import { onLeadCreated } from './on-lead-created'
import { applyPipelineStatus } from './sync-deal-status'
import { suggestStatusAfterTask } from './pipeline-rules'

/**
 * Sprint 8.0 «Продажи»: Core-слой мутаций воронки (проверка SALES_ROLES вручную,
 * Zod, ActivityLog 'SALES_*', без redirect/revalidate). Вызывается из
 * src/app/(app)/sales/actions.ts (web, requireRole), clients/actions.ts
 * (createClient с leadId) и TG-хендлера scope 'sales'.
 *
 * Живёт НЕ в 'use server'-файле: Core принимает actor параметром, а каждый экспорт
 * 'use server'-модуля — потенциально публичный POST-эндпоинт (Next data-security).
 * Ничего не импортирует из src/app/** (нет циклов с clients/actions).
 *
 * Ошибки prisma не глотаем — всплывают в action (как в остальном проекте).
 * Составные записи — массив-формой $transaction (pgbouncer-safe).
 */

// ---------- Общее ----------

const DENIED = { ok: false as const, error: 'Нет прав' }
const LEAD_NOT_FOUND = { ok: false as const, error: 'Заявка не найдена' }
const TASK_NOT_FOUND = { ok: false as const, error: 'Задача не найдена' }
const TASK_CLOSED = { ok: false as const, error: 'Задача уже закрыта' }

/** Окно идемпотентности задач: та же заявка+тип со сроком ±60 сек — это дубль. */
const TASK_DEDUP_WINDOW_MS = 60 * 1000
/** Пометка задач, закрытых вместе с отказом по заявке. */
const LOST_TASK_NOTE = 'закрыто с отказом'

function invalid(error: z.ZodError): { ok: false; error: string } {
  return { ok: false, error: error.issues[0]?.message ?? 'Неверные данные' }
}

/** undefined — «не трогать», '' и null — «очистить». */
function emptyToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined
  return v === null || v === '' ? null : v
}

function decimalToNumber(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v)
}

async function logSales(
  user: SalesActor,
  action: string,
  leadId: string,
  payload?: Prisma.InputJsonObject
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action,
      entityType: 'LandingLead',
      entityId: leadId,
      payload,
    },
  })
}

// ---------- Поля Zod ----------

const leadIdField = z.string({ error: 'Заявка не найдена' }).trim().min(1, 'Заявка не найдена')
const taskIdField = z.string({ error: 'Задача не найдена' }).trim().min(1, 'Задача не найдена')

function optText(max: number, tooLong: string) {
  return z.string({ error: 'Неверное значение' }).trim().max(max, tooLong).nullable().optional()
}

const emailField = z
  .string({ error: 'Неверный email' })
  .trim()
  .max(150, 'Email слишком длинный')
  .refine((v) => v === '' || z.email().safeParse(v).success, 'Неверный email')
  .nullable()
  .optional()

const portionsField = z
  .number({ error: 'Порции — числом' })
  .int('Порции — целым числом')
  .positive('Порций должно быть больше нуля')
  .max(100000, 'Слишком много порций')
  .nullable()
  .optional()

const dealAmountField = z
  .number({ error: 'Сумма — числом' })
  .min(0, 'Сумма не может быть отрицательной')
  .max(1_000_000_000, 'Слишком большая сумма')
  .nullable()
  .optional()

const dueAtField = z.coerce.date({ error: 'Неверная дата' })

const companyField = optText(150, 'Название компании слишком длинное (до 150 символов)')
const addressField = optText(300, 'Адрес слишком длинный (до 300 символов)')
const commentField = optText(2000, 'Комментарий слишком длинный (до 2000 символов)')

// ---------- Заявки ----------

const createLeadSchema = z.object({
  name: z
    .string({ error: 'Укажи имя' })
    .trim()
    .min(1, 'Укажи имя')
    .max(150, 'Имя слишком длинное (до 150 символов)'),
  phone: z.string({ error: 'Укажи телефон' }).trim().min(1, 'Укажи телефон').max(50, 'Неверный телефон'),
  company: companyField,
  email: emailField,
  portionsHint: portionsField,
  address: addressField,
  comment: commentField,
  sourceCode: z.enum(MANUAL_SOURCE_CODES, { error: 'Выбери источник' }),
})

export async function createLeadCore(
  user: SalesActor,
  input: CreateLeadInput
): Promise<SalesActionResult<{ id: string }>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = createLeadSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data

  const digits = toPhoneDigits(d.phone)
  if (!digits) return { ok: false, error: 'Неверный телефон' }

  // Дубль: активная (не закрытая, не архивная) заявка с тем же номером — без окна по дате.
  const duplicate = await prisma.landingLead.findFirst({
    where: { phoneDigits: digits, pipelineStatus: { in: ACTIVE_STATUSES }, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (duplicate) return { ok: false, error: 'duplicate', duplicateLeadId: duplicate.id }

  const lead = await prisma.landingLead.create({
    data: {
      formType: 'manual',
      source: d.sourceCode,
      name: d.name,
      phone: formatPhoneMask(digits),
      phoneDigits: digits,
      company: emptyToNull(d.company) ?? null,
      email: emptyToNull(d.email) ?? null,
      portionsHint: d.portionsHint ?? null,
      address: emptyToNull(d.address) ?? null,
      comment: emptyToNull(d.comment) ?? null,
      assignedToId: user.id,
    },
    select: { id: true },
  })

  await onLeadCreated({ leadId: lead.id, source: 'manual', actorUserId: user.id })
  await logSales(user, 'SALES_LEAD_CREATED', lead.id, { name: d.name, sourceCode: d.sourceCode })
  return { ok: true, data: { id: lead.id } }
}

const updateLeadSchema = z.object({
  leadId: leadIdField,
  name: optText(150, 'Имя слишком длинное (до 150 символов)'),
  phone: optText(50, 'Неверный телефон'),
  company: companyField,
  email: emailField,
  portionsHint: portionsField,
  address: addressField,
  comment: commentField,
  dealAmount: dealAmountField,
})

const FIELD_RU = {
  name: 'Имя',
  phone: 'Телефон',
  company: 'Компания',
  email: 'Email',
  portionsHint: 'Порций',
  address: 'Адрес',
  comment: 'Комментарий',
  dealAmount: 'Сумма сделки',
} as const

type LeadField = keyof typeof FIELD_RU

export async function updateLeadFieldsCore(
  user: SalesActor,
  input: UpdateLeadFieldsInput
): Promise<SalesActionResult> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = updateLeadSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data

  const lead = await prisma.landingLead.findUnique({
    where: { id: d.leadId },
    select: {
      id: true,
      name: true,
      phone: true,
      phoneDigits: true,
      company: true,
      email: true,
      portionsHint: true,
      address: true,
      comment: true,
      dealAmount: true,
    },
  })
  if (!lead) return LEAD_NOT_FOUND

  const data: Prisma.LandingLeadUpdateInput = {}
  const changed: Partial<Record<LeadField, string | number | null>> = {}

  // Имя очистить нельзя: пустое значение = «не трогать» (у заявок с сайта имени может не быть).
  if (d.name && d.name !== lead.name) {
    data.name = d.name
    changed.name = d.name
  }

  // Телефон обязателен: при передаче — только валидный, храним маску + цифры.
  if (d.phone !== undefined) {
    const digits = toPhoneDigits(d.phone)
    if (!digits) return { ok: false, error: 'Неверный телефон' }
    const phone = formatPhoneMask(digits)
    if (digits !== lead.phoneDigits || phone !== lead.phone) {
      data.phone = phone
      data.phoneDigits = digits
      changed.phone = phone
    }
  }

  for (const key of ['company', 'email', 'address', 'comment'] as const) {
    const value = emptyToNull(d[key])
    if (value !== undefined && value !== lead[key]) {
      data[key] = value
      changed[key] = value
    }
  }

  if (d.portionsHint !== undefined && d.portionsHint !== lead.portionsHint) {
    data.portionsHint = d.portionsHint
    changed.portionsHint = d.portionsHint
  }

  if (d.dealAmount !== undefined && d.dealAmount !== decimalToNumber(lead.dealAmount)) {
    data.dealAmount = d.dealAmount
    changed.dealAmount = d.dealAmount
  }

  const keys = Object.keys(changed) as LeadField[]
  if (keys.length === 0) return { ok: true, data: undefined }

  data.lastActivityAt = new Date()
  await prisma.$transaction([
    prisma.landingLead.update({ where: { id: lead.id }, data, select: { id: true } }),
    prisma.salesActivity.create({
      data: {
        leadId: lead.id,
        kind: 'NOTE',
        text: `Обновлены поля: ${keys.map((k) => FIELD_RU[k]).join(', ')}`,
        meta: { fields: keys },
        authorId: user.id,
      },
    }),
  ])
  await logSales(user, 'SALES_LEAD_UPDATED', lead.id, { changed })
  return { ok: true, data: undefined }
}

const changeStatusSchema = z.object({
  leadId: leadIdField,
  status: z.enum(LeadPipelineStatus, { error: 'Неверная стадия' }),
  lostReason: z.enum(LeadLostReason, { error: 'Неверная причина отказа' }).nullable().optional(),
  lostComment: optText(500, 'Комментарий к отказу слишком длинный (до 500 символов)'),
  dealAmount: dealAmountField,
})

export async function changeLeadStatusCore(
  user: SalesActor,
  input: ChangeLeadStatusInput
): Promise<SalesActionResult<{ status: LeadPipelineStatus; changed: boolean }>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = changeStatusSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data
  if (d.status === 'LOST' && !d.lostReason) return { ok: false, error: 'Укажи причину отказа' }

  const lead = await prisma.landingLead.findUnique({ where: { id: d.leadId }, select: { id: true } })
  if (!lead) return LEAD_NOT_FOUND

  const now = new Date()
  const isLost = d.status === 'LOST'
  const result = await applyPipelineStatus(lead.id, d.status, {
    authorId: user.id,
    lostReason: isLost ? d.lostReason : undefined,
    lostComment: isLost ? emptyToNull(d.lostComment) : undefined,
    dealAmount: d.status === 'WON' ? d.dealAmount : undefined,
    now,
  })

  // Отказ закрывает все открытые задачи: напоминать по закрытой заявке незачем.
  // Заметку менеджера не затираем — пометку дописываем (контекст пригодится,
  // если заявку вернут в работу).
  let closedTasks = 0
  if (isLost) {
    const openTasks = await prisma.salesTask.findMany({
      where: { leadId: lead.id, doneAt: null },
      select: { id: true, note: true },
    })
    const results = await prisma.$transaction(
      openTasks.map((t) =>
        prisma.salesTask.updateMany({
          where: { id: t.id, doneAt: null },
          data: { doneAt: now, note: t.note?.trim() ? `${t.note}\n— ${LOST_TASK_NOTE}` : LOST_TASK_NOTE },
        })
      )
    )
    closedTasks = results.reduce((sum, r) => sum + r.count, 0)
  }

  if (result.changed || closedTasks > 0) {
    await logSales(user, 'SALES_STATUS_CHANGED', lead.id, {
      from: result.from,
      to: result.to,
      lostReason: isLost ? (d.lostReason ?? null) : null,
      dealAmount: d.status === 'WON' ? (d.dealAmount ?? null) : null,
      closedTasks,
    })
  }
  return { ok: true, data: { status: result.to, changed: result.changed } }
}

const addNoteSchema = z.object({
  leadId: leadIdField,
  text: z
    .string({ error: 'Пустая заметка' })
    .trim()
    .min(1, 'Пустая заметка')
    .max(1000, 'Заметка слишком длинная (до 1000 символов)'),
})

export async function addLeadNoteCore(user: SalesActor, input: AddLeadNoteInput): Promise<SalesActionResult> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = addNoteSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data

  const lead = await prisma.landingLead.findUnique({ where: { id: d.leadId }, select: { id: true } })
  if (!lead) return LEAD_NOT_FOUND

  await prisma.$transaction([
    prisma.salesActivity.create({ data: { leadId: lead.id, kind: 'NOTE', text: d.text, authorId: user.id } }),
    prisma.landingLead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() }, select: { id: true } }),
  ])
  await logSales(user, 'SALES_NOTE_ADDED', lead.id, { text: d.text })
  return { ok: true, data: undefined }
}

// ---------- Задачи ----------

const createTaskSchema = z.object({
  leadId: leadIdField,
  type: z.enum(SalesTaskType, { error: 'Неверный тип задачи' }),
  title: optText(150, 'Название задачи слишком длинное (до 150 символов)'),
  dueAt: dueAtField,
  note: optText(500, 'Комментарий к задаче слишком длинный (до 500 символов)'),
})

export async function createTaskCore(
  user: SalesActor,
  input: CreateTaskInput
): Promise<SalesActionResult<{ taskId: string; leadId: string; dueAt: Date; deduplicated: boolean }>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = createTaskSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data

  const lead = await prisma.landingLead.findUnique({
    where: { id: d.leadId },
    select: { id: true, archivedAt: true },
  })
  if (!lead) return LEAD_NOT_FOUND
  if (lead.archivedAt) return { ok: false, error: 'Заявка в архиве' }

  // Идемпотентность (двойной тап в TG, повторный сабмит): открытая задача той же
  // заявки и типа со сроком ±60 сек — возвращаем её, новую не создаём.
  const dueMs = d.dueAt.getTime()
  const existing = await prisma.salesTask.findFirst({
    where: {
      leadId: lead.id,
      type: d.type,
      doneAt: null,
      dueAt: { gte: new Date(dueMs - TASK_DEDUP_WINDOW_MS), lte: new Date(dueMs + TASK_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, dueAt: true },
  })
  if (existing) {
    return { ok: true, data: { taskId: existing.id, leadId: lead.id, dueAt: existing.dueAt, deduplicated: true } }
  }

  const title = emptyToNull(d.title) ?? TASK_TYPE_RU[d.type]
  const [task] = await prisma.$transaction([
    prisma.salesTask.create({
      data: {
        leadId: lead.id,
        type: d.type,
        title,
        dueAt: d.dueAt,
        note: emptyToNull(d.note) ?? null,
        assigneeId: user.id,
        createdById: user.id,
      },
      select: { id: true, dueAt: true },
    }),
    prisma.salesActivity.create({
      data: {
        leadId: lead.id,
        kind: 'TASK_CREATED',
        text: `Задача: ${TASK_TYPE_RU[d.type]} — ${formatMskDateTimeShort(d.dueAt)}`,
        meta: { type: d.type, title, dueAt: d.dueAt.toISOString() },
        authorId: user.id,
      },
    }),
    prisma.landingLead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() }, select: { id: true } }),
  ])
  await logSales(user, 'SALES_TASK_CREATED', lead.id, {
    taskId: task.id,
    type: d.type,
    dueAt: d.dueAt.toISOString(),
  })
  return { ok: true, data: { taskId: task.id, leadId: lead.id, dueAt: task.dueAt, deduplicated: false } }
}

export async function completeTaskCore(
  user: SalesActor,
  taskId: string
): Promise<SalesActionResult<CompleteTaskResult>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsedId = taskIdField.safeParse(taskId)
  if (!parsedId.success) return invalid(parsedId.error)

  const task = await prisma.salesTask.findUnique({
    where: { id: parsedId.data },
    select: {
      id: true,
      type: true,
      title: true,
      doneAt: true,
      leadId: true,
      lead: { select: { name: true, company: true, phone: true, pipelineStatus: true, archivedAt: true } },
    },
  })
  if (!task) return TASK_NOT_FOUND

  const now = new Date()
  let alreadyDone = task.doneAt !== null
  if (!alreadyDone) {
    // Атомарный claim: параллельный клик (web + TG) закроет задачу ровно один раз.
    const claimed = await prisma.salesTask.updateMany({
      where: { id: task.id, doneAt: null },
      data: { doneAt: now },
    })
    alreadyDone = claimed.count === 0
    if (!alreadyDone) {
      await prisma.$transaction([
        prisma.salesActivity.create({
          data: {
            leadId: task.leadId,
            kind: 'TASK_DONE',
            text: `Выполнено: ${task.title}`,
            meta: { taskId: task.id, type: task.type },
            authorId: user.id,
          },
        }),
        prisma.landingLead.update({ where: { id: task.leadId }, data: { lastActivityAt: now }, select: { id: true } }),
      ])
      await logSales(user, 'SALES_TASK_DONE', task.leadId, { taskId: task.id, type: task.type })
    }
  }

  const otherOpenTasksCount = await prisma.salesTask.count({
    where: { leadId: task.leadId, doneAt: null, id: { not: task.id } },
  })
  const suggestedStatus =
    alreadyDone || task.lead.archivedAt ? null : suggestStatusAfterTask(task.type, task.lead.pipelineStatus)

  return {
    ok: true,
    data: {
      leadId: task.leadId,
      leadLabel: leadDisplayName(task.lead),
      task: { id: task.id, type: task.type, title: task.title },
      alreadyDone,
      hasOtherOpenTasks: otherOpenTasksCount > 0,
      otherOpenTasksCount,
      suggestedStatus,
    },
  }
}

const rescheduleSchema = z.object({ taskId: taskIdField, dueAt: dueAtField })

export async function rescheduleTaskCore(
  user: SalesActor,
  input: RescheduleTaskInput
): Promise<SalesActionResult<{ leadId: string; title: string; dueAt: Date }>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = rescheduleSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data

  const task = await prisma.salesTask.findUnique({
    where: { id: d.taskId },
    select: { id: true, leadId: true, title: true, dueAt: true, doneAt: true },
  })
  if (!task) return TASK_NOT_FOUND
  if (task.doneAt) return TASK_CLOSED

  // notifiedAt=null — cron напомнит заново к новому сроку.
  const moved = await prisma.salesTask.updateMany({
    where: { id: task.id, doneAt: null },
    data: { dueAt: d.dueAt, notifiedAt: null },
  })
  if (moved.count === 0) return TASK_CLOSED

  await prisma.$transaction([
    prisma.salesActivity.create({
      data: {
        leadId: task.leadId,
        kind: 'TASK_RESCHEDULED',
        text: `Перенос: ${formatMskDateTimeShort(task.dueAt)} → ${formatMskDateTimeShort(d.dueAt)}`,
        meta: { taskId: task.id, from: task.dueAt.toISOString(), to: d.dueAt.toISOString() },
        authorId: user.id,
      },
    }),
    prisma.landingLead.update({ where: { id: task.leadId }, data: { lastActivityAt: new Date() }, select: { id: true } }),
  ])
  await logSales(user, 'SALES_TASK_RESCHEDULED', task.leadId, {
    taskId: task.id,
    from: task.dueAt.toISOString(),
    to: d.dueAt.toISOString(),
  })
  return { ok: true, data: { leadId: task.leadId, title: task.title, dueAt: d.dueAt } }
}

export async function deleteTaskCore(user: SalesActor, taskId: string): Promise<SalesActionResult<{ leadId: string }>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsedId = taskIdField.safeParse(taskId)
  if (!parsedId.success) return invalid(parsedId.error)

  const task = await prisma.salesTask.findUnique({
    where: { id: parsedId.data },
    select: { id: true, leadId: true, title: true, type: true, doneAt: true },
  })
  if (!task) return TASK_NOT_FOUND
  if (task.doneAt) return TASK_CLOSED

  const removed = await prisma.salesTask.deleteMany({ where: { id: task.id, doneAt: null } })
  if (removed.count === 0) return TASK_CLOSED

  await prisma.$transaction([
    prisma.salesActivity.create({
      data: {
        leadId: task.leadId,
        kind: 'TASK_DELETED',
        text: `Удалена задача: ${task.title}`,
        meta: { taskId: task.id, type: task.type },
        authorId: user.id,
      },
    }),
    prisma.landingLead.update({ where: { id: task.leadId }, data: { lastActivityAt: new Date() }, select: { id: true } }),
  ])
  await logSales(user, 'SALES_TASK_DELETED', task.leadId, { taskId: task.id, title: task.title })
  return { ok: true, data: { leadId: task.leadId } }
}

// ---------- Архив / клиент / ответственный ----------

async function setArchived(user: SalesActor, leadId: string, archived: boolean): Promise<SalesActionResult> {
  if (!isSalesRole(user.role)) return DENIED
  const parsedId = leadIdField.safeParse(leadId)
  if (!parsedId.success) return invalid(parsedId.error)

  const lead = await prisma.landingLead.findUnique({
    where: { id: parsedId.data },
    select: { id: true, archivedAt: true },
  })
  if (!lead) return LEAD_NOT_FOUND
  // Повтор (уже в архиве / уже вернули) — успех без изменений.
  if ((lead.archivedAt !== null) === archived) return { ok: true, data: undefined }

  const now = new Date()
  await prisma.$transaction([
    prisma.landingLead.update({
      where: { id: lead.id },
      data: { archivedAt: archived ? now : null, lastActivityAt: now },
      select: { id: true },
    }),
    prisma.salesActivity.create({
      data: {
        leadId: lead.id,
        kind: archived ? 'ARCHIVED' : 'UNARCHIVED',
        text: archived ? 'В архиве' : 'Вернули из архива',
        authorId: user.id,
      },
    }),
  ])
  await logSales(user, archived ? 'SALES_LEAD_ARCHIVED' : 'SALES_LEAD_UNARCHIVED', lead.id)
  return { ok: true, data: undefined }
}

export async function archiveLeadCore(user: SalesActor, leadId: string): Promise<SalesActionResult> {
  return setArchived(user, leadId, true)
}

export async function unarchiveLeadCore(user: SalesActor, leadId: string): Promise<SalesActionResult> {
  return setArchived(user, leadId, false)
}

const linkClientSchema = z.object({
  leadId: leadIdField,
  clientId: z.string({ error: 'Клиент не найден' }).trim().min(1, 'Клиент не найден'),
})

export async function linkLeadToClientCore(
  user: SalesActor,
  input: LinkLeadToClientInput
): Promise<SalesActionResult<{ clientId: string; clientName: string }>> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = linkClientSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const d = parsed.data

  const lead = await prisma.landingLead.findUnique({
    where: { id: d.leadId },
    select: { id: true, clientId: true, pipelineStatus: true },
  })
  if (!lead) return LEAD_NOT_FOUND
  const client = await prisma.client.findUnique({ where: { id: d.clientId }, select: { id: true, name: true } })
  if (!client) return { ok: false, error: 'Клиент не найден' }

  const result = { ok: true as const, data: { clientId: client.id, clientName: client.name } }
  if (lead.clientId === client.id && lead.pipelineStatus === 'WON') return result

  const now = new Date()
  if (lead.clientId !== client.id) {
    await prisma.$transaction([
      prisma.landingLead.update({
        where: { id: lead.id },
        data: { clientId: client.id, lastActivityAt: now },
        select: { id: true },
      }),
      prisma.salesActivity.create({
        data: {
          leadId: lead.id,
          kind: 'CLIENT_LINKED',
          text: `Привязан к клиенту: ${client.name}`,
          meta: { clientId: client.id },
          authorId: user.id,
        },
      }),
    ])
  }
  // Сумму сделки не передаём — могла быть сохранена раньше (диалог «Стал клиентом»).
  await applyPipelineStatus(lead.id, 'WON', { authorId: user.id, now })
  await logSales(user, 'SALES_CLIENT_LINKED', lead.id, { clientId: client.id, clientName: client.name })
  return result
}

const assignSchema = z.object({
  leadId: leadIdField,
  userId: z.string({ error: 'Неверный пользователь' }).trim().nullable().optional(),
})

export async function assignLeadCore(user: SalesActor, input: AssignLeadInput): Promise<SalesActionResult> {
  if (!isSalesRole(user.role)) return DENIED
  const parsed = assignSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const leadId = parsed.data.leadId
  const userId = parsed.data.userId || null

  const lead = await prisma.landingLead.findUnique({
    where: { id: leadId },
    select: { id: true, assignedToId: true },
  })
  if (!lead) return LEAD_NOT_FOUND

  if (userId) {
    const assignee = await prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true, role: true },
    })
    if (!assignee || !assignee.isActive || !(isSalesRole(assignee.role) || assignee.role === 'MANAGER')) {
      return { ok: false, error: 'Этого пользователя нельзя назначить ответственным' }
    }
  }
  if (lead.assignedToId === userId) return { ok: true, data: undefined }

  await prisma.landingLead.update({ where: { id: lead.id }, data: { assignedToId: userId }, select: { id: true } })
  await logSales(user, 'SALES_LEAD_ASSIGNED', lead.id, { from: lead.assignedToId, to: userId })
  return { ok: true, data: undefined }
}
