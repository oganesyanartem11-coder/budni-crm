import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    clientLocation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  assignCourierToLocation,
  createLocation,
  updateLocation,
  type LocationFormData,
} from './actions'

const ADMIN = { id: 'u_admin', role: 'ADMIN' as const }

const baseForm = {
  name: 'Стройка №1',
  address: 'ул. Ленина, 1',
  packaging: 'INDIVIDUAL' as const,
  tags: [],
}

const existingLocation = (overrides: Record<string, unknown> = {}) => ({
  id: 'loc_1',
  clientId: 'c1',
  defaultDeliveryMode: 'EXTERNAL' as const,
  assignedCourierId: null,
  latitude: null,
  longitude: null,
  geofenceRadiusM: 1000,
  geofenceEnabled: false,
  coordinatesSource: null,
  deliveryContacts: [],
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(ADMIN)
  mockPrisma.clientLocation.create.mockResolvedValue({ id: 'loc_1' })
  mockPrisma.clientLocation.findUnique.mockResolvedValue(existingLocation())
  mockPrisma.clientLocation.update.mockResolvedValue({ id: 'loc_1', clientId: 'c1' })
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'COURIER', isActive: true })
})

describe('location delivery fee compatibility', () => {
  it('persists a numeric deliveryFee on create', async () => {
    const result = await createLocation('c1', { ...baseForm, deliveryFee: 500 })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data.deliveryFee).toBe(500)
  })

  it.each([null, undefined])('maps create deliveryFee=%s to null', async (deliveryFee) => {
    const result = await createLocation('c1', { ...baseForm, deliveryFee })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data.deliveryFee).toBeNull()
  })

  it('rejects a negative deliveryFee', async () => {
    const result = await createLocation('c1', { ...baseForm, deliveryFee: -10 })

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })

  it('keeps deliveryFee update and explicit clearing behavior', async () => {
    await updateLocation('loc_1', { ...baseForm, deliveryFee: 750.5 })
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data.deliveryFee).toBe(750.5)

    mockPrisma.clientLocation.update.mockClear()
    await updateLocation('loc_1', { ...baseForm, deliveryFee: null })
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data.deliveryFee).toBeNull()
  })
})

describe('location delivery assignment', () => {
  it('accepts an active COURIER for IN_HOUSE', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      defaultDeliveryMode: 'IN_HOUSE',
      assignedCourierId: 'courier_1',
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'courier_1' },
      select: { role: true, isActive: true },
    })
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        defaultDeliveryMode: 'IN_HOUSE',
        assignedCourierId: 'courier_1',
      }),
    )
  })

  it.each([
    [{ role: 'COURIER', isActive: false }, 'inactive courier'],
    [{ role: 'MANAGER', isActive: true }, 'non-courier'],
    [null, 'missing courier'],
  ])('rejects IN_HOUSE with %s (%s)', async (courier, _label) => {
    mockPrisma.user.findUnique.mockResolvedValue(courier)

    const result = await createLocation('c1', {
      ...baseForm,
      defaultDeliveryMode: 'IN_HOUSE',
      assignedCourierId: 'user_1',
    })

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })

  it.each(['EXTERNAL', 'UNASSIGNED'] as const)('%s clears an injected courier id', async (mode) => {
    const result = await createLocation('c1', {
      ...baseForm,
      defaultDeliveryMode: mode,
      assignedCourierId: 'must_be_ignored',
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ defaultDeliveryMode: mode, assignedCourierId: null }),
    )
  })

  it('resolves a legacy create with assignedCourierId to IN_HOUSE', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      assignedCourierId: 'courier_1',
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ defaultDeliveryMode: 'IN_HOUSE', assignedCourierId: 'courier_1' }),
    )
  })

  it('resolves a legacy create without a courier to EXTERNAL', async () => {
    const result = await createLocation('c1', baseForm)

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ defaultDeliveryMode: 'EXTERNAL', assignedCourierId: null }),
    )
  })

  it('preserves assignment when a legacy update omits both new assignment fields', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({ defaultDeliveryMode: 'IN_HOUSE', assignedCourierId: 'courier_old' }),
    )

    const result = await updateLocation('loc_1', baseForm)

    expect(result.ok).toBe(true)
    const data = mockPrisma.clientLocation.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('defaultDeliveryMode')
    expect(data).not.toHaveProperty('assignedCourierId')
  })

  it.each(['EXTERNAL', 'UNASSIGNED'] as const)('update to %s clears the courier', async (mode) => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({ defaultDeliveryMode: 'IN_HOUSE', assignedCourierId: 'courier_old' }),
    )

    const result = await updateLocation('loc_1', {
      ...baseForm,
      defaultDeliveryMode: mode,
      assignedCourierId: 'must_be_ignored',
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ defaultDeliveryMode: mode, assignedCourierId: null }),
    )
  })

  it('legacy assignCourierToLocation sets IN_HOUSE for a courier', async () => {
    const result = await assignCourierToLocation('loc_1', 'courier_1')

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'loc_1' },
        data: { assignedCourierId: 'courier_1', defaultDeliveryMode: 'IN_HOUSE' },
      }),
    )
  })

  it('legacy assignCourierToLocation maps null to EXTERNAL', async () => {
    const result = await assignCourierToLocation('loc_1', null)

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'loc_1' },
        data: { assignedCourierId: null, defaultDeliveryMode: 'EXTERNAL' },
      }),
    )
  })

  it('legacy assignCourierToLocation still rejects an inactive/non-courier user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', isActive: true })

    const result = await assignCourierToLocation('loc_1', 'manager_1')

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.update).not.toHaveBeenCalled()
  })
})

describe('location coordinates and geofence', () => {
  it.each([
    [{ latitude: 55.75 }, 'one coordinate only'],
    [{ latitude: null, longitude: 37.61 }, 'mixed null/value pair'],
    [{ latitude: 90.0000001, longitude: 37.61 }, 'latitude out of range'],
    [{ latitude: 55.75, longitude: 180.0000001 }, 'longitude out of range'],
    [{ latitude: Number.NaN, longitude: 37.61 }, 'non-finite latitude'],
    [{ latitude: 55.75, longitude: Number.POSITIVE_INFINITY }, 'non-finite longitude'],
    [{ geofenceRadiusM: 99 }, 'radius below range'],
    [{ geofenceRadiusM: 5001 }, 'radius above range'],
  ])('rejects invalid coordinates: %s (%s)', async (fields, _label) => {
    const result = await createLocation('c1', { ...baseForm, ...fields })

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })

  it('defaults radius to 1000 and geofence to false', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      latitude: null,
      longitude: null,
      geofenceRadiusM: 1000,
      geofenceEnabled: false,
      coordinatesSource: null,
    })

    expect(result.ok).toBe(true)
    const data = mockPrisma.clientLocation.create.mock.calls[0][0].data
    expect(data).toEqual(
      expect.objectContaining({ geofenceRadiusM: 1000, geofenceEnabled: false }),
    )
    expect(data).not.toHaveProperty('coordinatesUpdatedAt')
    expect(data).not.toHaveProperty('coordinatesUpdatedById')
  })

  it('rejects enabling a geofence without coordinates', async () => {
    const result = await createLocation('c1', { ...baseForm, geofenceEnabled: true })

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })

  it('persists a valid coordinate pair with server-controlled actor provenance', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      latitude: 55.7558,
      longitude: 37.6173,
      geofenceRadiusM: 750,
      geofenceEnabled: true,
      coordinatesSource: 'MANUAL',
      coordinatesUpdatedById: 'u_spoof',
    } as LocationFormData & { coordinatesUpdatedById: string })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        latitude: 55.7558,
        longitude: 37.6173,
        geofenceRadiusM: 750,
        geofenceEnabled: true,
        coordinatesSource: 'MANUAL',
        coordinatesUpdatedAt: expect.any(Date),
        coordinatesUpdatedById: ADMIN.id,
      }),
    )
  })

  it('updates coordinate metadata from the authenticated actor', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({ latitude: 55.7, longitude: 37.6 }),
    )

    const result = await updateLocation('loc_1', {
      ...baseForm,
      latitude: 55.8,
      longitude: 37.7,
      coordinatesSource: 'MAP_PIN',
      coordinatesUpdatedById: 'u_spoof',
    } as LocationFormData & { coordinatesUpdatedById: string })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        latitude: 55.8,
        longitude: 37.7,
        coordinatesSource: 'MAP_PIN',
        coordinatesUpdatedAt: expect.any(Date),
        coordinatesUpdatedById: ADMIN.id,
      }),
    )
  })

  it('does not rewrite coordinate provenance when the modal resubmits unchanged values', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({
        latitude: 55.7,
        longitude: 37.6,
        geofenceRadiusM: 1000,
        geofenceEnabled: false,
        coordinatesSource: 'MANUAL',
      }),
    )

    const result = await updateLocation('loc_1', {
      ...baseForm,
      latitude: 55.7,
      longitude: 37.6,
      geofenceRadiusM: 1000,
      geofenceEnabled: false,
      coordinatesSource: 'MANUAL',
    })

    expect(result.ok).toBe(true)
    const data = mockPrisma.clientLocation.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('coordinatesUpdatedAt')
    expect(data).not.toHaveProperty('coordinatesUpdatedById')
  })

  it('allows enabling a geofence while preserving existing coordinates', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({ latitude: 55.7, longitude: 37.6 }),
    )

    const result = await updateLocation('loc_1', { ...baseForm, geofenceEnabled: true })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data.geofenceEnabled).toBe(true)
  })

  it('does not reset coordinate fields for a legacy update', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({ latitude: 55.7, longitude: 37.6, geofenceEnabled: true }),
    )

    const result = await updateLocation('loc_1', baseForm)

    expect(result.ok).toBe(true)
    const data = mockPrisma.clientLocation.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('latitude')
    expect(data).not.toHaveProperty('longitude')
    expect(data).not.toHaveProperty('geofenceRadiusM')
    expect(data).not.toHaveProperty('geofenceEnabled')
    expect(data).not.toHaveProperty('coordinatesUpdatedAt')
    expect(data).not.toHaveProperty('coordinatesUpdatedById')
  })

  it('rejects delivery instructions longer than 2000 characters', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      deliveryInstructions: 'x'.repeat(2001),
    })

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })
})

describe('primary location delivery contact', () => {
  const contact = {
    name: ' Анна ',
    phone: '+7 (999) 123-45-67',
    notes: ' Позвонить заранее ',
  }

  it('creates a location-scoped primary contact atomically with the location', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      deliveryContact: { ...contact, clientId: 'other_client' },
    } as LocationFormData & { deliveryContact: typeof contact & { clientId: string } })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.create.mock.calls[0][0].data.deliveryContacts).toEqual({
      create: expect.objectContaining({
        clientId: 'c1',
        isPrimaryForDelivery: true,
        name: 'Анна',
        phone: '+7 (999) 123-45-67',
        notes: 'Позвонить заранее',
      }),
    })
  })

  it('rejects an invalid contact phone', async () => {
    const result = await createLocation('c1', {
      ...baseForm,
      deliveryContact: { name: 'Анна', phone: '123' },
    })

    expect(result.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })

  it('updates the existing primary contact for this location', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(
      existingLocation({ deliveryContacts: [{ id: 'contact_1' }] }),
    )

    const result = await updateLocation('loc_1', {
      ...baseForm,
      deliveryContact: { ...contact, clientId: 'other_client' },
    } as LocationFormData & { deliveryContact: typeof contact & { clientId: string } })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data.deliveryContacts).toEqual({
      update: {
        where: { id: 'contact_1' },
        data: expect.objectContaining({
          clientId: 'c1',
          isPrimaryForDelivery: true,
          name: 'Анна',
          phone: '+7 (999) 123-45-67',
          notes: 'Позвонить заранее',
        }),
      },
    })
  })

  it('creates the primary contact on update when none exists', async () => {
    const result = await updateLocation('loc_1', {
      ...baseForm,
      deliveryContact: contact,
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.clientLocation.update.mock.calls[0][0].data.deliveryContacts).toEqual({
      create: expect.objectContaining({ clientId: 'c1', isPrimaryForDelivery: true }),
    })
  })

  it.each([null, { name: '', phone: '', notes: '' }])(
    'removes the existing primary contact when the form is blank/null (%s)',
    async (deliveryContact) => {
      mockPrisma.clientLocation.findUnique.mockResolvedValue(
        existingLocation({ deliveryContacts: [{ id: 'contact_1' }] }),
      )

      const result = await updateLocation('loc_1', { ...baseForm, deliveryContact })

      expect(result.ok).toBe(true)
      expect(mockPrisma.clientLocation.update.mock.calls[0][0].data.deliveryContacts).toEqual({
        delete: { id: 'contact_1' },
      })
    },
  )

  it('rejects a missing location before attempting contact persistence', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue(null)

    const result = await updateLocation('missing', {
      ...baseForm,
      deliveryContact: contact,
    })

    expect(result).toEqual({ ok: false, error: 'Точка не найдена' })
    expect(mockPrisma.clientLocation.update).not.toHaveBeenCalled()
  })
})

describe('action error boundaries', () => {
  it('returns a useful generic result for a create persistence failure', async () => {
    mockPrisma.clientLocation.create.mockRejectedValue(new Error('database unavailable'))

    const result = await createLocation('c1', baseForm)

    expect(result).toEqual({ ok: false, error: 'Не удалось создать точку' })
  })

  it('does not mask an auth/redirect exception', async () => {
    const redirectError = new Error('NEXT_REDIRECT')
    mockRequireRole.mockRejectedValue(redirectError)

    await expect(createLocation('c1', baseForm)).rejects.toBe(redirectError)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })
})

// The coordinate actor is intentionally absent from the public form contract.
// @ts-expect-error coordinatesUpdatedById is server-controlled
const typedActorSpoof: LocationFormData = { ...baseForm, coordinatesUpdatedById: 'u_spoof' }
void typedActorSpoof
