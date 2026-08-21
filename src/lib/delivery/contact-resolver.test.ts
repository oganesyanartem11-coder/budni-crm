import { describe, expect, it } from 'vitest'
import { resolveDeliveryContact, type DeliveryContactCandidate } from './contact-resolver'

const BASE_DATE = new Date('2026-08-07T09:00:00.000Z')

function contact(
  overrides: Partial<DeliveryContactCandidate> = {},
): DeliveryContactCandidate {
  return {
    id: 'contact-1',
    clientId: 'client-1',
    locationId: null,
    isPrimaryForDelivery: false,
    name: 'Общий контакт',
    phone: '+7 999 000-00-00',
    notes: null,
    sortOrder: 10,
    createdAt: BASE_DATE,
    ...overrides,
  }
}

const input = {
  clientId: 'client-1',
  locationId: 'location-1',
  legacy: { name: 'Legacy', phone: '+7 900 000-00-00' },
}

describe('resolveDeliveryContact', () => {
  it('prefers the primary contact of the target location', () => {
    const result = resolveDeliveryContact({
      ...input,
      contacts: [
        contact({ id: 'client-contact' }),
        contact({
          id: 'location-fallback',
          locationId: 'location-1',
          name: 'Запасной',
          sortOrder: 1,
        }),
        contact({
          id: 'location-primary',
          locationId: 'location-1',
          isPrimaryForDelivery: true,
          name: 'Основной',
          sortOrder: 20,
        }),
      ],
    })

    expect(result).toMatchObject({
      contactId: 'location-primary',
      name: 'Основной',
      source: 'LOCATION_PRIMARY',
    })
  })

  it('falls back to the first sorted location contact', () => {
    const result = resolveDeliveryContact({
      ...input,
      contacts: [
        contact({ id: 'later', locationId: 'location-1', sortOrder: 20 }),
        contact({ id: 'first', locationId: 'location-1', sortOrder: 10 }),
      ],
    })

    expect(result?.contactId).toBe('first')
    expect(result?.source).toBe('LOCATION')
  })

  it('uses a client-wide contact when the location has none', () => {
    const result = resolveDeliveryContact({
      ...input,
      contacts: [
        contact({ id: 'later', sortOrder: 20 }),
        contact({ id: 'first', sortOrder: 10 }),
      ],
    })

    expect(result?.contactId).toBe('first')
    expect(result?.source).toBe('CLIENT')
  })

  it('uses legacy fields when normalized contacts are absent', () => {
    expect(resolveDeliveryContact({ ...input, contacts: [] })).toEqual({
      contactId: null,
      name: 'Legacy',
      phone: '+7 900 000-00-00',
      notes: null,
      source: 'LEGACY',
    })
  })

  it('ignores contacts from another client or location', () => {
    const result = resolveDeliveryContact({
      ...input,
      contacts: [
        contact({
          id: 'wrong-client',
          clientId: 'client-2',
          locationId: 'location-1',
          isPrimaryForDelivery: true,
        }),
        contact({
          id: 'wrong-location',
          locationId: 'location-2',
          isPrimaryForDelivery: true,
        }),
      ],
    })

    expect(result?.source).toBe('LEGACY')
  })

  it('returns null when every source is empty', () => {
    expect(
      resolveDeliveryContact({
        clientId: 'client-1',
        locationId: 'location-1',
        contacts: [],
        legacy: { name: null, phone: null },
      }),
    ).toBeNull()
  })
})
