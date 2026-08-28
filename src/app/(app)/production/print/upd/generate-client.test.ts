import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { readFileSync } from 'node:fs'

const {
  mockPrisma,
  mockPrismaDirect,
  mockTx,
  mockRequireRole,
  mockGetNextDocumentNumber,
} = vi.hoisted(() => {
  const tx = {
    order: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      updateManyAndReturn: vi.fn(),
    },
    client: { findUnique: vi.fn(), updateMany: vi.fn() },
    ourLegalEntity: { findMany: vi.fn() },
    updDocument: { create: vi.fn() },
    updDocumentOrder: { createMany: vi.fn() },
    activityLog: { create: vi.fn() },
  }

  return {
    mockTx: tx,
    mockPrisma: {
      order: { findMany: vi.fn() },
      client: { findUnique: vi.fn() },
      ourLegalEntity: { findMany: vi.fn() },
      updDocument: { findUnique: vi.fn(), count: vi.fn() },
      updDocumentOrder: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
    mockPrismaDirect: { $transaction: vi.fn() },
    mockRequireRole: vi.fn(),
    mockGetNextDocumentNumber: vi.fn(),
  }
})

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/db/prisma-direct', () => ({ prismaDirect: mockPrismaDirect }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/upd/document-number', () => ({
  getNextDocumentNumber: mockGetNextDocumentNumber,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { generateAndGetUpdForDate } from './actions'

const SUPPLIER = {
  id: 'seller_1',
  shortName: 'ИП Будни',
  fullName: 'Индивидуальный предприниматель Будни',
  entityType: 'INDIVIDUAL_ENTREPRENEUR' as const,
  inn: '770000000000',
  kpp: null,
  ogrn: '123456789012345',
  legalAddress: 'Москва',
  phone: null,
  email: null,
  bankName: 'Банк',
  bankBic: '044525000',
  bankAccount: '40702810000000000000',
  bankCorrAccount: '30101810000000000000',
  directorName: 'Иванов И.И.',
  directorPosition: 'ИП',
  vatRate: null,
  isActive: true,
}

const VAT_SUPPLIER = {
  ...SUPPLIER,
  vatRate: new Prisma.Decimal('20.00'),
}

type TestSupplier = Omit<typeof SUPPLIER, 'vatRate'> & {
  vatRate: Prisma.Decimal | null
}

const CLIENT_WITHOUT_REQUISITES = {
  id: 'client_1',
  name: 'Покупатель без реквизитов',
  legalName: null,
  inn: null,
  kpp: null,
  ogrn: null,
  legalAddress: null,
  bankName: null,
  bankBic: null,
  bankAccount: null,
  bankCorrAccount: null,
  contractNumber: null,
  contractDate: null,
}

function assignedOrder(supplier: TestSupplier = SUPPLIER) {
  const price = new Prisma.Decimal('350.00')
  return {
    id: 'order_1',
    clientId: 'client_1',
    locationId: 'location_1',
    mealType: 'LUNCH' as const,
    deliveryDate: new Date('2026-08-28T00:00:00.000Z'),
    portions: 10,
    pricePerPortion: price,
    totalPrice: price.mul(10),
    vatRate: supplier.vatRate,
    ourLegalEntityId: supplier.id,
    ourLegalEntity: supplier,
    client: CLIENT_WITHOUT_REQUISITES,
    location: {
      id: 'location_1',
      name: 'Основная точка',
      address: 'Москва',
      deliveryFee: null,
    },
  }
}

function prismaKnownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('transaction failed', {
    code,
    clientVersion: 'test',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockReset()
  mockPrismaDirect.$transaction.mockReset()
  mockPrisma.updDocumentOrder.findMany.mockReset()
  mockRequireRole.mockResolvedValue({ id: 'user_1', role: 'MANAGER' })
  mockPrisma.order.findMany.mockImplementation((args: {
    where: { ourLegalEntityId?: null | { not: null } }
  }) => {
    if (args.where.ourLegalEntityId === null) return Promise.resolve([])
    return Promise.resolve([assignedOrder()])
  })
  mockTx.order.findMany.mockResolvedValue([])
  mockTx.client.findUnique.mockResolvedValue(null)
  mockTx.ourLegalEntity.findMany.mockResolvedValue([])
  mockPrisma.updDocument.findUnique.mockResolvedValue(null)
  mockPrisma.updDocument.count.mockResolvedValue(1)
  mockPrisma.updDocumentOrder.findMany.mockImplementation((args: {
    where: {
      orderId?: { in?: string[] }
      updDocument?: unknown
    }
  }) => {
    if (args.where.updDocument) {
      return Promise.resolve(
        (args.where.orderId?.in ?? []).map((orderId) => ({ orderId })),
      )
    }
    return Promise.resolve([])
  })
  mockGetNextDocumentNumber.mockResolvedValue({
    documentNumber: 'УПД-2026-0001',
    number: 1,
    year: 2026,
  })
  mockTx.updDocument.create.mockResolvedValue({ id: 'upd_1' })
  mockTx.updDocumentOrder.createMany.mockResolvedValue({ count: 1 })
  mockTx.activityLog.create.mockResolvedValue({ id: 'log_1' })
  mockTx.order.updateMany.mockResolvedValue({ count: 0 })
  mockTx.order.updateManyAndReturn.mockResolvedValue([])
  mockTx.client.updateMany.mockResolvedValue({ count: 0 })
  mockPrisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx),
  )
  mockPrismaDirect.$transaction.mockImplementation(
    async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx),
  )
})

describe('generateAndGetUpdForDate — client scope', () => {
  it('выпускает только выбранного клиента и сохраняет пустые реквизиты покупателя', async () => {
    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
      where: {
        deliveryDate: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lte: new Date('2026-08-28T23:59:59.999Z'),
        },
        status: {
          in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
        },
        ourLegalEntityId: { not: null },
        clientId: 'client_1',
      },
      include: { client: true, location: true, ourLegalEntity: true },
    })
    expect(result).toMatchObject({
      ok: true,
      data: { createdCount: 1, reusedCount: 0, conflicts: [] },
    })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledTimes(2)
    expect(mockPrismaDirect.$transaction.mock.calls.map((call) => call[1])).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      undefined,
    ])
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()

    const createArgs = mockTx.updDocument.create.mock.calls[0][0]
    expect(createArgs.data.buyerSnapshot).toMatchObject({
      clientName: 'Покупатель без реквизитов',
      legalName: null,
      inn: null,
      kpp: null,
      ogrn: null,
      legalAddress: null,
      bankName: null,
      bankBic: null,
      bankAccount: null,
      bankCorrAccount: null,
      contractNumber: null,
      contractDateIso: null,
    })
  })

  it('дозаполняет пустой snapshot продавца из сохранённого default клиента', async () => {
    mockTx.order.findMany.mockResolvedValue([{ id: 'order_1' }])
    mockTx.client.findUnique.mockResolvedValue({
      defaultOurLegalEntityId: VAT_SUPPLIER.id,
      defaultOurLegalEntity: VAT_SUPPLIER,
    })
    mockTx.order.updateManyAndReturn.mockResolvedValue([{ id: 'order_1' }])
    mockPrisma.order.findMany.mockImplementation((args: {
      where: { ourLegalEntityId?: null | { not: null } }
    }) => args.where.ourLegalEntityId === null
      ? Promise.resolve([])
      : Promise.resolve([assignedOrder(VAT_SUPPLIER)]))

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(result).toMatchObject({ ok: true, data: { createdCount: 1 } })
    expect(mockTx.order.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: { in: ['order_1'] },
        clientId: 'client_1',
        deliveryDate: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lte: new Date('2026-08-28T23:59:59.999Z'),
        },
        status: {
          in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
        },
        ourLegalEntityId: null,
      },
      data: {
        ourLegalEntityId: VAT_SUPPLIER.id,
        vatRate: VAT_SUPPLIER.vatRate,
      },
      select: { id: true },
    })
    expect(mockTx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPD_ORDER_SELLER_ASSIGNED',
        entityType: 'Client',
        entityId: 'client_1',
      }),
    })
  })

  it('использует единственное активное наше юрлицо и сохраняет его клиенту', async () => {
    mockTx.order.findMany.mockResolvedValue([{ id: 'order_1' }])
    mockTx.client.findUnique.mockResolvedValue({
      defaultOurLegalEntityId: null,
      defaultOurLegalEntity: null,
    })
    mockTx.ourLegalEntity.findMany.mockResolvedValue([VAT_SUPPLIER])
    mockTx.order.updateManyAndReturn.mockResolvedValue([{ id: 'order_1' }])
    mockTx.client.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.order.findMany.mockImplementation((args: {
      where: { ourLegalEntityId?: null | { not: null } }
    }) => args.where.ourLegalEntityId === null
      ? Promise.resolve([])
      : Promise.resolve([assignedOrder(VAT_SUPPLIER)]))

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(result).toMatchObject({ ok: true, data: { createdCount: 1 } })
    expect(mockTx.ourLegalEntity.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true, shortName: true, isActive: true, vatRate: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 2,
    })
    expect(mockTx.client.updateMany).toHaveBeenCalledWith({
      where: { id: 'client_1', defaultOurLegalEntityId: null },
      data: { defaultOurLegalEntityId: VAT_SUPPLIER.id },
    })
    expect(mockTx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPD_ORDER_SELLER_ASSIGNED',
        payload: expect.objectContaining({ source: 'sole_active' }),
      }),
    })
  })

  it('не выбирает продавца произвольно, если активных наших юрлиц несколько', async () => {
    mockTx.order.findMany.mockResolvedValue([{ id: 'order_1' }])
    mockTx.client.findUnique.mockResolvedValue({
      defaultOurLegalEntityId: null,
      defaultOurLegalEntity: null,
    })
    mockTx.ourLegalEntity.findMany.mockResolvedValue([
      VAT_SUPPLIER,
      { ...VAT_SUPPLIER, id: 'seller_2', shortName: 'ООО Второе' },
    ])

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockTx.ourLegalEntity.findMany).toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      error: 'У клиента не выбрано наше юрлицо: доступно несколько активных — выберите нужное в карточке клиента',
    })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockTx.order.updateManyAndReturn).not.toHaveBeenCalled()
    expect(mockTx.updDocument.create).not.toHaveBeenCalled()
  })

  it('возвращает понятную ошибку, когда у клиента нечего выпускать и нет готовых УПД', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    mockPrisma.updDocument.count.mockResolvedValue(0)

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(result).toEqual({
      ok: false,
      error: 'За выбранный день у клиента нет заказов, подходящих для формирования УПД',
    })
    expect(mockTx.updDocument.create).not.toHaveBeenCalled()
  })

  it('выполняет всю подготовку на tx-клиенте с Serializable isolation', async () => {
    mockTx.order.findMany.mockResolvedValue([{ id: 'order_1' }])
    mockTx.client.findUnique.mockResolvedValue({
      defaultOurLegalEntityId: null,
      defaultOurLegalEntity: null,
    })
    mockTx.ourLegalEntity.findMany.mockResolvedValue([VAT_SUPPLIER])
    mockTx.order.updateManyAndReturn.mockResolvedValue([{ id: 'order_1' }])
    mockPrisma.order.findMany.mockResolvedValue([])

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(result).toMatchObject({ ok: true, data: { reusedCount: 1 } })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockTx.order.findMany).toHaveBeenCalled()
    expect(mockTx.client.findUnique).toHaveBeenCalled()
    expect(mockTx.ourLegalEntity.findMany).toHaveBeenCalled()
    expect(mockTx.order.updateManyAndReturn).toHaveBeenCalled()
    expect(mockTx.client.updateMany).toHaveBeenCalled()
    expect(mockTx.activityLog.create).toHaveBeenCalled()
    expect(mockPrisma.client.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.ourLegalEntity.findMany).not.toHaveBeenCalled()
  })

  it('повторяет всю Serializable preparation после P2034 и переиспользует текущий УПД', async () => {
    const conflict = prismaKnownError('P2034')
    mockPrismaDirect.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(
        async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx),
      )
    mockPrisma.order.findMany.mockResolvedValue([])
    mockPrisma.updDocument.count.mockResolvedValue(1)

    await expect(
      generateAndGetUpdForDate('2026-08-28', 'client_1'),
    ).resolves.toEqual({
      ok: true,
      data: {
        date: '2026-08-28',
        createdCount: 0,
        reusedCount: 1,
        conflicts: [],
      },
    })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledTimes(2)
    expect(mockPrismaDirect.$transaction.mock.calls.map((call) => call[1])).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ])
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('пробрасывает P2034 после трёх preparation attempts', async () => {
    const conflict = prismaKnownError('P2034')
    mockPrismaDirect.$transaction.mockRejectedValue(conflict)

    await expect(
      generateAndGetUpdForDate('2026-08-28', 'client_1'),
    ).rejects.toBe(conflict)
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledTimes(3)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('не повторяет preparation после ошибки не P2034', async () => {
    const unavailable = prismaKnownError('P1001')
    mockPrismaDirect.$transaction.mockRejectedValue(unavailable)

    await expect(
      generateAndGetUpdForDate('2026-08-28', 'client_1'),
    ).rejects.toBe(unavailable)
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledOnce()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('сохраняет issuance P2002 contract на direct transaction', async () => {
    const uniqueConflict = prismaKnownError('P2002')
    mockPrismaDirect.$transaction
      .mockImplementationOnce(
        async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx),
      )
      .mockRejectedValueOnce(uniqueConflict)

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(result).toEqual({
      ok: true,
      data: {
        date: '2026-08-28',
        createdCount: 0,
        reusedCount: 1,
        conflicts: [
          {
            orderId: 'order_1',
            reason: 'Гонка при создании УПД (P2002)',
          },
        ],
      },
    })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledTimes(2)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('не меняет default и не пишет audit, если eligibility recheck не обновил ни одного заказа', async () => {
    const missingOrders = [{ id: 'order_1' }]
    const clientWithoutDefault = {
      defaultOurLegalEntityId: null,
      defaultOurLegalEntity: null,
    }
    mockTx.order.findMany.mockResolvedValue(missingOrders)
    mockTx.client.findUnique.mockResolvedValue(clientWithoutDefault)
    mockTx.ourLegalEntity.findMany.mockResolvedValue([VAT_SUPPLIER])
    mockTx.order.updateManyAndReturn.mockResolvedValue([])
    mockPrisma.order.findMany.mockImplementation((args: {
      where: { ourLegalEntityId?: null | { not: null } }
    }) => args.where.ourLegalEntityId === null
      ? Promise.resolve(missingOrders)
      : Promise.resolve([]))
    mockPrisma.client.findUnique.mockResolvedValue(clientWithoutDefault)
    mockPrisma.ourLegalEntity.findMany.mockResolvedValue([VAT_SUPPLIER])
    mockTx.order.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.updDocument.count.mockResolvedValue(0)

    await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockTx.client.updateMany).not.toHaveBeenCalled()
    expect(mockTx.activityLog.create).not.toHaveBeenCalled()
  })

  it('повторно проверяет всю eligibility и логирует только фактически обновлённые ID', async () => {
    const missingOrders = [{ id: 'order_1' }, { id: 'order_2' }]
    const clientWithDefault = {
      defaultOurLegalEntityId: VAT_SUPPLIER.id,
      defaultOurLegalEntity: VAT_SUPPLIER,
    }
    mockTx.order.findMany.mockResolvedValue(missingOrders)
    mockTx.client.findUnique.mockResolvedValue(clientWithDefault)
    mockTx.order.updateManyAndReturn.mockResolvedValue([{ id: 'order_2' }])
    mockPrisma.order.findMany.mockImplementation((args: {
      where: { ourLegalEntityId?: null | { not: null } }
    }) => args.where.ourLegalEntityId === null
      ? Promise.resolve(missingOrders)
      : Promise.resolve([]))
    mockPrisma.client.findUnique.mockResolvedValue(clientWithDefault)
    mockTx.order.updateMany.mockResolvedValue({ count: 1 })

    await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockTx.order.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: { in: ['order_1', 'order_2'] },
        clientId: 'client_1',
        deliveryDate: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lte: new Date('2026-08-28T23:59:59.999Z'),
        },
        status: {
          in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
        },
        ourLegalEntityId: null,
      },
      data: {
        ourLegalEntityId: VAT_SUPPLIER.id,
        vatRate: VAT_SUPPLIER.vatRate,
      },
      select: { id: true },
    })
    expect(mockTx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPD_ORDER_SELLER_ASSIGNED',
        payload: expect.objectContaining({
          orderIds: ['order_2'],
          assignedCount: 1,
        }),
      }),
    })
  })

  it('не разрешает PDF, если current-day УПД покрывает только часть eligible заказов', async () => {
    const secondOrder = {
      ...assignedOrder(),
      id: 'order_2',
      mealType: 'DINNER' as const,
    }
    mockPrisma.order.findMany.mockResolvedValue([
      assignedOrder(),
      secondOrder,
    ])
    mockPrisma.updDocumentOrder.findMany
      .mockResolvedValueOnce([{ orderId: 'order_2' }])
      .mockResolvedValueOnce([{ orderId: 'order_1' }])
    mockPrisma.updDocument.count.mockResolvedValue(1)

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockTx.updDocument.create).toHaveBeenCalled()
    expect(mockPrisma.updDocumentOrder.findMany).toHaveBeenLastCalledWith({
      where: {
        orderId: { in: ['order_1', 'order_2'] },
        updDocument: {
          clientId: 'client_1',
          deliveryDate: {
            gte: new Date('2026-08-28T00:00:00.000Z'),
            lte: new Date('2026-08-28T23:59:59.999Z'),
          },
        },
      },
      select: { orderId: true },
    })
    expect(result).toEqual({
      ok: false,
      error: 'УПД сформирован не полностью. Заказов без УПД за выбранный день: 1. Аннулируйте или исправьте старый УПД и повторите формирование.',
    })
  })

  it('возвращает error, если все группы связаны с другими УПД, а текущих документов нет', async () => {
    mockPrisma.updDocumentOrder.findMany.mockResolvedValue([
      { orderId: 'order_1' },
    ])
    mockPrisma.updDocument.count.mockResolvedValue(0)

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockPrisma.updDocument.count).toHaveBeenCalledWith({
      where: {
        clientId: 'client_1',
        deliveryDate: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lte: new Date('2026-08-28T23:59:59.999Z'),
        },
      },
    })
    expect(result).toEqual({
      ok: false,
      error: 'Не удалось сформировать УПД за выбранный день: нет доступных заказов или готовых документов',
    })
    expect(mockTx.updDocument.create).not.toHaveBeenCalled()
  })

  it('разрешает повторную печать существующих УПД без повторного выпуска', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    mockPrisma.updDocument.count.mockResolvedValue(2)

    const result = await generateAndGetUpdForDate('2026-08-28', 'client_1')

    expect(mockPrisma.updDocument.count).toHaveBeenCalledWith({
      where: {
        clientId: 'client_1',
        deliveryDate: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lte: new Date('2026-08-28T23:59:59.999Z'),
        },
      },
    })
    expect(result).toEqual({
      ok: true,
      data: {
        date: '2026-08-28',
        createdCount: 0,
        reusedCount: 2,
        conflicts: [],
      },
    })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockTx.updDocument.create).not.toHaveBeenCalled()
  })
})

describe('generateAndGetUpdForDate — batch scope', () => {
  it('сохраняет batch generation без clientId и выпускает через direct transaction', async () => {
    const result = await generateAndGetUpdForDate('2026-08-28')

    expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
      where: {
        deliveryDate: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lte: new Date('2026-08-28T23:59:59.999Z'),
        },
        status: {
          in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
        },
        ourLegalEntityId: { not: null },
      },
      include: { client: true, location: true, ourLegalEntity: true },
    })
    expect(result).toEqual({
      ok: true,
      data: {
        date: '2026-08-28',
        createdCount: 1,
        reusedCount: 0,
        conflicts: [],
      },
    })
    expect(mockPrismaDirect.$transaction).toHaveBeenCalledOnce()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.updDocument.count).not.toHaveBeenCalled()
  })
})

describe('UpdClientButton conflict feedback', () => {
  it('показывает warning с числом конфликтов до PDF redirect', () => {
    const source = readFileSync(
      new URL('../../../orders/orders-list.tsx', import.meta.url),
      'utf8',
    )
    const successBranch = source.indexOf('if (!result.ok)')
    const warning = source.indexOf('toast.warning', successBranch)
    const redirect = source.indexOf('win.location.href = pdfHref', successBranch)

    expect(successBranch).toBeGreaterThan(-1)
    expect(warning).toBeGreaterThan(successBranch)
    expect(warning).toBeLessThan(redirect)
    expect(source.slice(warning, redirect)).toContain(
      'result.data.conflicts.length',
    )
  })
})
