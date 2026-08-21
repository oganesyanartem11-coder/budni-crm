export type DeliveryContactSource =
  | 'LOCATION_PRIMARY'
  | 'LOCATION'
  | 'CLIENT'
  | 'LEGACY'

export interface DeliveryContactCandidate {
  id: string
  clientId: string
  locationId: string | null
  isPrimaryForDelivery: boolean
  name: string | null
  phone: string
  notes: string | null
  sortOrder: number
  createdAt: Date
}

export interface ResolvedDeliveryContact {
  contactId: string | null
  name: string | null
  phone: string | null
  notes: string | null
  source: DeliveryContactSource
}

interface ResolveDeliveryContactInput {
  clientId: string
  locationId: string
  contacts: readonly DeliveryContactCandidate[]
  legacy: {
    name: string | null
    phone: string | null
  }
}

function compareContacts(
  left: DeliveryContactCandidate,
  right: DeliveryContactCandidate,
): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  )
}

function toResolved(
  contact: DeliveryContactCandidate,
  source: Exclude<DeliveryContactSource, 'LEGACY'>,
): ResolvedDeliveryContact {
  return {
    contactId: contact.id,
    name: contact.name,
    phone: contact.phone,
    notes: contact.notes,
    source,
  }
}

/**
 * Resolves the courier-facing contact from already-loaded client contacts.
 * Callers can load contacts in one parent query, avoiding an N+1 query per stop.
 */
export function resolveDeliveryContact(
  input: ResolveDeliveryContactInput,
): ResolvedDeliveryContact | null {
  const eligible = input.contacts.filter(
    (contact) =>
      contact.clientId === input.clientId &&
      (contact.locationId === input.locationId || contact.locationId === null),
  )

  const locationContacts = eligible
    .filter((contact) => contact.locationId === input.locationId)
    .toSorted(compareContacts)

  const primary = locationContacts.find(
    (contact) => contact.isPrimaryForDelivery,
  )
  if (primary) return toResolved(primary, 'LOCATION_PRIMARY')

  const locationFallback = locationContacts[0]
  if (locationFallback) return toResolved(locationFallback, 'LOCATION')

  const clientFallback = eligible
    .filter((contact) => contact.locationId === null)
    .toSorted(compareContacts)[0]
  if (clientFallback) return toResolved(clientFallback, 'CLIENT')

  const legacyName = input.legacy.name?.trim() || null
  const legacyPhone = input.legacy.phone?.trim() || null
  if (!legacyName && !legacyPhone) return null

  return {
    contactId: null,
    name: legacyName,
    phone: legacyPhone,
    notes: null,
    source: 'LEGACY',
  }
}
