import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Sprint 8.0 «Продажи»: Core-мутации воронки. prisma — мок; hook onLeadCreated —
 * мок (свой тест в on-lead-created.test.ts); трекер ошибок — мок.
 */

const { mockPrisma, mockOnLeadCreated } = vi.hoisted(() => {
  const mockPrisma = {
    landingLead: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    salesTask: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    salesActivity: { create: vi.fn() },
    activityLog: { create: vi.fn() },
    client: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    // Массив-форма: элементы — уже промисы моков.
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  }
  return { mockPrisma, mockOnLeadCreated: vi.fn() }
})

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/errors/tracker', () => ({ trackError: vi.fn() }))
vi.mock('./on-lead-created', () => ({ onLeadCreated: mockOnLeadCreated }))

import {
  changeLeadStatusCore,
  completeTaskCore,
  createLeadCore,
  createTaskCore,
  rescheduleTaskCore,
} from './core'
import type { SalesActor } from './types'

const PRO: SalesActor = { id: 'u-pro', role: 'ADMIN_PRO' }
const MANAGER: SalesActor = { id: 'u-man', role: 'MANAGER' }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops))
  mockPrisma.landingLead.update.mockResolvedValue({ id: 'lead-1' })
  mockPrisma.salesActivity.create.mockResolvedValue({ id: 'act-1' })
  mockPrisma.activityLog.create.mockResolvedValue({ id: 'log-1' })
  mockOnLeadCreated.mockResolvedValue({ ok: true, taskId: 'task-auto' })
})

describe('createLeadCore', () => {
  const input = { name: 'Иван', phone: '8 (999) 123-45-67', sourceCode: 'manual-phone' }

  it('без роли продаж → «Нет прав», в БД не ходим', async () => {
    const r = await createLeadCore(MANAGER, input)
    expect(r).toEqual({ ok: false, error: 'Нет прав' })
    expect(mockPrisma.landingLead.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.landingLead.create).not.toHaveBeenCalled()
  })

  it('активная заявка с тем же номером → error duplicate + duplicateLeadId, не создаём', async () => {
    mockPrisma.landingLead.findFirst.mockResolvedValue({ id: 'lead-old' })
    const r = await createLeadCore(PRO, input)
    expect(r).toEqual({ ok: false, error: 'duplicate', duplicateLeadId: 'lead-old' })
    // Дубль ищем по нормализованным цифрам среди активных неархивных.
    const where = mockPrisma.landingLead.findFirst.mock.calls[0][0].where
    expect(where.phoneDigits).toBe('79991234567')
    expect(where.archivedAt).toBeNull()
    expect(where.pipelineStatus.in).toEqual(['NEW', 'IN_PROGRESS', 'PROPOSAL_SENT', 'TRIAL', 'CONTRACT'])
    expect(mockPrisma.landingLead.create).not.toHaveBeenCalled()
  })

  it('неверный телефон → ошибка по-русски', async () => {
    const r = await createLeadCore(PRO, { ...input, phone: '12345' })
    expect(r).toEqual({ ok: false, error: 'Неверный телефон' })
  })

  it('успех → formType manual, маска+цифры, hook manual c actor, ActivityLog', async () => {
    mockPrisma.landingLead.findFirst.mockResolvedValue(null)
    mockPrisma.landingLead.create.mockResolvedValue({ id: 'lead-new' })
    const r = await createLeadCore(PRO, { ...input, company: '', email: '' })
    expect(r).toEqual({ ok: true, data: { id: 'lead-new' } })
    const data = mockPrisma.landingLead.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      formType: 'manual',
      source: 'manual-phone',
      phoneDigits: '79991234567',
      phone: '+7 (999) 123-45-67',
      company: null,
      email: null,
      assignedToId: 'u-pro',
    })
    expect(mockOnLeadCreated).toHaveBeenCalledWith({ leadId: 'lead-new', source: 'manual', actorUserId: 'u-pro' })
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'SALES_LEAD_CREATED',
      entityType: 'LandingLead',
      entityId: 'lead-new',
    })
  })
})

describe('createTaskCore — идемпотентность', () => {
  const due = new Date('2026-09-25T07:00:00Z')

  it('открытая задача того же типа со сроком ±60 сек → возвращаем её, create не зовём', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ id: 'lead-1', archivedAt: null })
    mockPrisma.salesTask.findFirst.mockResolvedValue({ id: 'task-9', dueAt: due })
    const r = await createTaskCore(PRO, { leadId: 'lead-1', type: 'CALL', dueAt: due.toISOString() })
    expect(r).toEqual({ ok: true, data: { taskId: 'task-9', leadId: 'lead-1', dueAt: due, deduplicated: true } })
    expect(mockPrisma.salesTask.create).not.toHaveBeenCalled()
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled()
    const where = mockPrisma.salesTask.findFirst.mock.calls[0][0].where
    expect(where.dueAt.gte.getTime()).toBe(due.getTime() - 60_000)
    expect(where.dueAt.lte.getTime()).toBe(due.getTime() + 60_000)
  })

  it('нет такой → создаём (title по умолчанию из типа), история + лог', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ id: 'lead-1', archivedAt: null })
    mockPrisma.salesTask.findFirst.mockResolvedValue(null)
    mockPrisma.salesTask.create.mockResolvedValue({ id: 'task-new', dueAt: due })
    const r = await createTaskCore(PRO, { leadId: 'lead-1', type: 'SEND_PROPOSAL', dueAt: due })
    expect(r).toEqual({ ok: true, data: { taskId: 'task-new', leadId: 'lead-1', dueAt: due, deduplicated: false } })
    expect(mockPrisma.salesTask.create.mock.calls[0][0].data).toMatchObject({
      title: 'Отправить КП',
      assigneeId: 'u-pro',
      createdById: 'u-pro',
    })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data.text).toMatch(/^Задача: Отправить КП — /)
  })

  it('архивная заявка → ошибка', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ id: 'lead-1', archivedAt: new Date() })
    const r = await createTaskCore(PRO, { leadId: 'lead-1', type: 'CALL', dueAt: due })
    expect(r).toEqual({ ok: false, error: 'Заявка в архиве' })
  })

  it('неверная дата → ошибка по-русски', async () => {
    const r = await createTaskCore(PRO, { leadId: 'lead-1', type: 'CALL', dueAt: 'не дата' })
    expect(r).toEqual({ ok: false, error: 'Неверная дата' })
  })
})

describe('completeTaskCore', () => {
  const taskRow = (over: Record<string, unknown> = {}) => ({
    id: 'task-1',
    type: 'SEND_PROPOSAL',
    title: 'Отправить КП',
    doneAt: null,
    leadId: 'lead-1',
    lead: { name: 'Иван', company: 'ООО Стройка', phone: '+7 (999) 123-45-67', pipelineStatus: 'IN_PROGRESS', archivedAt: null },
    ...over,
  })

  it('первое выполнение → claim, история, лог, подсказка стадии вперёд', async () => {
    mockPrisma.salesTask.findUnique.mockResolvedValue(taskRow())
    mockPrisma.salesTask.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.salesTask.count.mockResolvedValue(2)
    const r = await completeTaskCore(PRO, 'task-1')
    expect(r).toEqual({
      ok: true,
      data: {
        leadId: 'lead-1',
        leadLabel: 'ООО Стройка',
        task: { id: 'task-1', type: 'SEND_PROPOSAL', title: 'Отправить КП' },
        alreadyDone: false,
        hasOtherOpenTasks: true,
        otherOpenTasksCount: 2,
        suggestedStatus: 'PROPOSAL_SENT',
      },
    })
    expect(mockPrisma.salesTask.updateMany.mock.calls[0][0].where).toEqual({ id: 'task-1', doneAt: null })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data).toMatchObject({
      kind: 'TASK_DONE',
      text: 'Выполнено: Отправить КП',
    })
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data.action).toBe('SALES_TASK_DONE')
  })

  it('повторный вызов (задача уже выполнена) → alreadyDone, ничего не пишем', async () => {
    mockPrisma.salesTask.findUnique.mockResolvedValue(taskRow({ doneAt: new Date() }))
    mockPrisma.salesTask.count.mockResolvedValue(0)
    const r = await completeTaskCore(PRO, 'task-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.alreadyDone).toBe(true)
    expect(r.data.suggestedStatus).toBeNull()
    expect(mockPrisma.salesTask.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.salesActivity.create).not.toHaveBeenCalled()
    expect(mockPrisma.landingLead.update).not.toHaveBeenCalled()
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled()
  })

  it('гонка: параллельно уже закрыли (claim count 0) → alreadyDone без записи истории', async () => {
    mockPrisma.salesTask.findUnique.mockResolvedValue(taskRow())
    mockPrisma.salesTask.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.salesTask.count.mockResolvedValue(0)
    const r = await completeTaskCore(PRO, 'task-1')
    expect(r.ok && r.data.alreadyDone).toBe(true)
    expect(mockPrisma.salesActivity.create).not.toHaveBeenCalled()
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled()
  })

  it('звонок на стадии «КП отправлено» → подсказки нет (не откатываем)', async () => {
    mockPrisma.salesTask.findUnique.mockResolvedValue(
      taskRow({ type: 'CALL', lead: { name: null, company: null, phone: '+7 (999) 000-00-00', pipelineStatus: 'PROPOSAL_SENT', archivedAt: null } })
    )
    mockPrisma.salesTask.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.salesTask.count.mockResolvedValue(0)
    const r = await completeTaskCore(PRO, 'task-1')
    expect(r.ok && r.data.suggestedStatus).toBeNull()
    expect(r.ok && r.data.leadLabel).toBe('+7 (999) 000-00-00')
  })

  it('нет задачи → «Задача не найдена»', async () => {
    mockPrisma.salesTask.findUnique.mockResolvedValue(null)
    expect(await completeTaskCore(PRO, 'nope')).toEqual({ ok: false, error: 'Задача не найдена' })
  })

  it('без роли → «Нет прав»', async () => {
    expect(await completeTaskCore(MANAGER, 'task-1')).toEqual({ ok: false, error: 'Нет прав' })
    expect(mockPrisma.salesTask.findUnique).not.toHaveBeenCalled()
  })
})

describe('changeLeadStatusCore', () => {
  it('LOST без причины → «Укажи причину отказа»', async () => {
    const r = await changeLeadStatusCore(PRO, { leadId: 'lead-1', status: 'LOST' })
    expect(r).toEqual({ ok: false, error: 'Укажи причину отказа' })
  })

  it('LOST с причиной → стадия+dealStatus, событие LOST, открытые задачи закрыты', async () => {
    mockPrisma.landingLead.findUnique
      .mockResolvedValueOnce({ id: 'lead-1' }) // проверка существования в Core
      .mockResolvedValueOnce({ pipelineStatus: 'TRIAL', wonAt: null, dealAmount: null, lostReason: null, lostComment: null })
    mockPrisma.salesTask.findMany.mockResolvedValue([
      { id: 'task-1', note: null },
      { id: 'task-2', note: '40 порций, КП до пятницы' },
    ])
    mockPrisma.salesTask.updateMany.mockResolvedValue({ count: 1 })
    const r = await changeLeadStatusCore(PRO, {
      leadId: 'lead-1',
      status: 'LOST',
      lostReason: 'EXPENSIVE',
      lostComment: 'нашли дешевле',
    })
    expect(r).toEqual({ ok: true, data: { status: 'LOST', changed: true } })
    const data = mockPrisma.landingLead.update.mock.calls[0][0].data
    expect(data).toMatchObject({ pipelineStatus: 'LOST', dealStatus: 'LOST', lostReason: 'EXPENSIVE', wonAt: null })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data).toMatchObject({
      kind: 'LOST',
      text: 'Отказ: Дорого — нашли дешевле',
    })
    // Заметку менеджера не затираем — пометку дописываем.
    expect(mockPrisma.salesTask.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'task-1', doneAt: null },
      data: { note: 'закрыто с отказом' },
    })
    expect(mockPrisma.salesTask.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: 'task-2', doneAt: null },
      data: { note: '40 порций, КП до пятницы\n— закрыто с отказом' },
    })
  })
})

describe('rescheduleTaskCore', () => {
  it('закрытую задачу не переносим', async () => {
    mockPrisma.salesTask.findUnique.mockResolvedValue({
      id: 'task-1',
      leadId: 'lead-1',
      title: 'Позвонить',
      dueAt: new Date(),
      doneAt: new Date(),
    })
    const r = await rescheduleTaskCore(PRO, { taskId: 'task-1', dueAt: new Date() })
    expect(r).toEqual({ ok: false, error: 'Задача уже закрыта' })
    expect(mockPrisma.salesTask.updateMany).not.toHaveBeenCalled()
  })

  it('перенос → dueAt + сброс notifiedAt, история «Перенос: …»', async () => {
    const oldDue = new Date('2026-09-24T07:00:00Z')
    const newDue = new Date('2026-09-25T07:00:00Z')
    mockPrisma.salesTask.findUnique.mockResolvedValue({
      id: 'task-1',
      leadId: 'lead-1',
      title: 'Позвонить',
      dueAt: oldDue,
      doneAt: null,
    })
    mockPrisma.salesTask.updateMany.mockResolvedValue({ count: 1 })
    const r = await rescheduleTaskCore(PRO, { taskId: 'task-1', dueAt: newDue.toISOString() })
    expect(r).toEqual({ ok: true, data: { leadId: 'lead-1', title: 'Позвонить', dueAt: newDue } })
    expect(mockPrisma.salesTask.updateMany.mock.calls[0][0].data).toEqual({ dueAt: newDue, notifiedAt: null })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data.text).toMatch(/^Перенос: .+ → .+$/)
  })
})
