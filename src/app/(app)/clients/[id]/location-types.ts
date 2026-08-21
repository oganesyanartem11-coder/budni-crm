import type { ClientContact, ClientLocation } from '@prisma/client'
import type { Serialized } from '@/lib/utils/serialize'

export type LocationDeliveryMode = 'IN_HOUSE' | 'EXTERNAL' | 'UNASSIGNED'

export type LocationDeliveryContact = Pick<
  ClientContact,
  | 'id'
  | 'clientId'
  | 'locationId'
  | 'isPrimaryForDelivery'
  | 'name'
  | 'phone'
  | 'notes'
  | 'sortOrder'
  | 'createdAt'
>

/**
 * ClientLocation crosses the RSC boundary through serialize(), so every Prisma
 * Decimal is a number in the client. The explicit Delivery 2 fields keep this
 * UI type usable while prisma generate is running in a parallel workstream.
 */
export type SerializedLocation = Serialized<ClientLocation> & {
  defaultDeliveryMode: LocationDeliveryMode | null
  deliveryInstructions: string | null
  latitude: number | null
  longitude: number | null
  geofenceRadiusM: number
  geofenceEnabled: boolean
  coordinatesSource: string | null
  coordinatesUpdatedAt: Date | string | null
  deliveryContacts: LocationDeliveryContact[]
}

export const DELIVERY_MODE_LABELS: Record<LocationDeliveryMode, string> = {
  IN_HOUSE: 'Наш курьер',
  EXTERNAL: 'InDrive',
  UNASSIGNED: 'Не назначено',
}

export type CoordinateInputResult =
  | { ok: true; value: number | null }
  | { ok: false }

export function resolveLocationDeliveryMode(
  mode: LocationDeliveryMode | null | undefined,
  assignedCourierId: string | null | undefined,
): LocationDeliveryMode {
  if (mode) return mode
  return assignedCourierId ? 'IN_HOUSE' : 'EXTERNAL'
}

export function parseCoordinateInput(input: string): CoordinateInputResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(trimmed)) {
    return { ok: false }
  }

  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? { ok: true, value } : { ok: false }
}
