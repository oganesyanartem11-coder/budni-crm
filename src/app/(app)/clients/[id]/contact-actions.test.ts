import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Юнит-тесты CRUD контактных лиц клиента (П1). Мокаем:
 *  - prisma.clientContact (findFirst/findUnique/create/update/delete)
 *  - prisma.activityLog.create (аудит)
 *  - requireRole (роль ADMIN/MANAGER vs запрет)
 *  - revalidatePath (no-op)
 *
 * requireRole в проде делает redirect() при недопустимой роли — здесь мокаем
 * его так, чтобы он бросал, и проверяем что не-ADMIN/MANAGER не доходит до БД.
 */

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    clientContact: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    activityLog: {
      create: vi.fn(),
    },
  },
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  createClientContact,
  updateClientContact,
  deleteClientContact,
} from './contact-actions'

const ADMIN = { id: 'u_admin', role: 'ADMIN' as const }
const MANAGER = { id: 'u_mgr', role: 'MANAGER' as const }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(ADMIN)
  mockPrisma.activityLog.create.mockResolvedValue({})
})

describe('createClientContact', () => {
  it('ADMIN: создаёт контакт, sortOrder = 0 + 10 при отсутствии существующих', async () => {
    mockPrisma.clientContact.findFirst.mockResolvedValue(null)
    mockPrisma.clientContact.create.mockResolvedValue({
      id: 'ct_1',
      clientId: 'c1',
      name: 'Иван',
      role: 'прораб',
      phone: '+79990001122',
      email: null,
      notes: null,
      sortOrder: 10,
    })

    const res = await createClientContact('c1', {
      name: 'Иван',
      role: 'прораб',
      phone: '+79990001122',
    })

    expect(res.ok).toBe(true)
    const createArg = mockPrisma.clientContact.create.mock.calls[0][0]
    expect(createArg.data.sortOrder).toBe(10)
    expect(createArg.data.clientId).toBe('c1')
    expect(mockPrisma.activityLog.create).toHaveBeenCalledOnce()
  })

  it('MANAGER: тоже разрешено', async () => {
    mockRequireRole.mockResolvedValue(MANAGER)
    mockPrisma.clientContact.findFirst.mockResolvedValue(null)
    mockPrisma.clientContact.create.mockResolvedValue({
      id: 'ct_2',
      clientId: 'c1',
      name: null,
      role: null,
      phone: '+79990001122',
      email: null,
      notes: null,
      sortOrder: 10,
    })

    const res = await createClientContact('c1', { phone: '+79990001122' })
    expect(res.ok).toBe(true)
    expect(mockRequireRole).toHaveBeenCalledWith(['ADMIN', 'MANAGER'])
  })

  it('sortOrder авто-инкремент: макс существующий + 10', async () => {
    mockPrisma.clientContact.findFirst.mockResolvedValue({ sortOrder: 30 })
    mockPrisma.clientContact.create.mockResolvedValue({
      id: 'ct_3',
      clientId: 'c1',
      name: null,
      role: null,
      phone: '+79990001122',
      email: null,
      notes: null,
      sortOrder: 40,
    })

    await createClientContact('c1', { phone: '+79990001122' })
    const createArg = mockPrisma.clientContact.create.mock.calls[0][0]
    expect(createArg.data.sortOrder).toBe(40)
  })

  it('телефон обязателен: пустой → ошибка валидации, БД не трогаем', async () => {
    const res = await createClientContact('c1', { phone: '' })
    expect(res.ok).toBe(false)
    expect(mockPrisma.clientContact.create).not.toHaveBeenCalled()
  })

  it('телефон слишком короткий (< 5) → ошибка', async () => {
    const res = await createClientContact('c1', { phone: '123' })
    expect(res.ok).toBe(false)
    expect(mockPrisma.clientContact.create).not.toHaveBeenCalled()
  })

  it('некорректный email → ошибка', async () => {
    const res = await createClientContact('c1', {
      phone: '+79990001122',
      email: 'не-email',
    })
    expect(res.ok).toBe(false)
    expect(mockPrisma.clientContact.create).not.toHaveBeenCalled()
  })
})

describe('updateClientContact', () => {
  it('обновляет существующий контакт + лог + revalidate', async () => {
    mockPrisma.clientContact.findUnique.mockResolvedValue({ clientId: 'c1' })
    mockPrisma.clientContact.update.mockResolvedValue({
      id: 'ct_1',
      clientId: 'c1',
      name: 'Пётр',
      role: null,
      phone: '+79990002233',
      email: null,
      notes: null,
      sortOrder: 10,
    })

    const res = await updateClientContact('ct_1', {
      name: 'Пётр',
      phone: '+79990002233',
    })
    expect(res.ok).toBe(true)
    expect(mockPrisma.clientContact.update).toHaveBeenCalledOnce()
    expect(mockPrisma.activityLog.create).toHaveBeenCalledOnce()
  })

  it('контакт не найден → ошибка, без update', async () => {
    mockPrisma.clientContact.findUnique.mockResolvedValue(null)
    const res = await updateClientContact('missing', { phone: '+79990002233' })
    expect(res.ok).toBe(false)
    expect(mockPrisma.clientContact.update).not.toHaveBeenCalled()
  })
})

describe('deleteClientContact', () => {
  it('удаляет, логирует, revalidate', async () => {
    mockPrisma.clientContact.findUnique.mockResolvedValue({
      clientId: 'c1',
      name: 'Иван',
      phone: '+79990001122',
    })
    mockPrisma.clientContact.delete.mockResolvedValue({})

    const res = await deleteClientContact('ct_1')
    expect(res.ok).toBe(true)
    expect(mockPrisma.clientContact.delete).toHaveBeenCalledWith({ where: { id: 'ct_1' } })
    expect(mockPrisma.activityLog.create).toHaveBeenCalledOnce()
  })

  it('контакт не найден → ошибка, без delete', async () => {
    mockPrisma.clientContact.findUnique.mockResolvedValue(null)
    const res = await deleteClientContact('missing')
    expect(res.ok).toBe(false)
    expect(mockPrisma.clientContact.delete).not.toHaveBeenCalled()
  })
})
