import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db/prisma'

const CLAIM_LEASE_MS = 15 * 60 * 1000
const MAX_ACQUIRE_ATTEMPTS = 4

type PersistedMultipartDeliveryClaim = {
  version: 1
  state: 'SENDING' | 'FAILED' | 'SENT'
  token: string
  messages: string[]
  nextPartIndex: number
  claimedAt: string
  lastError?: string
}

export interface AcquiredMultipartDeliveryClaim {
  status: 'acquired'
  key: string
  token: string
  messages: string[]
  nextPartIndex: number
  rawValue: string
}

export type MultipartDeliveryClaimResult =
  | AcquiredMultipartDeliveryClaim
  | { status: 'in_progress' }
  | { status: 'already_sent' }

export type MultipartDeliveryResumeResult =
  | MultipartDeliveryClaimResult
  | { status: 'no_claim' }

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'P2002'
}

function parsePersistedClaim(value: string): PersistedMultipartDeliveryClaim | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null

    const candidate = parsed as Partial<PersistedMultipartDeliveryClaim>
    if (
      candidate.version !== 1
      || !['SENDING', 'FAILED', 'SENT'].includes(candidate.state ?? '')
      || typeof candidate.token !== 'string'
      || !Array.isArray(candidate.messages)
      || !candidate.messages.every((message) => typeof message === 'string')
      || !Number.isInteger(candidate.nextPartIndex)
      || (candidate.nextPartIndex ?? -1) < 0
      || (
        candidate.state !== 'SENT'
        && (candidate.nextPartIndex ?? 0) > candidate.messages.length
      )
      || typeof candidate.claimedAt !== 'string'
      || !Number.isFinite(Date.parse(candidate.claimedAt))
    ) {
      return null
    }

    return candidate as PersistedMultipartDeliveryClaim
  } catch {
    return null
  }
}

function serializeClaim(claim: PersistedMultipartDeliveryClaim): string {
  return JSON.stringify(claim)
}

function toAcquiredClaim(
  key: string,
  persisted: PersistedMultipartDeliveryClaim,
  rawValue: string,
): AcquiredMultipartDeliveryClaim {
  return {
    status: 'acquired',
    key,
    token: persisted.token,
    messages: persisted.messages,
    nextPartIndex: persisted.nextPartIndex,
    rawValue,
  }
}

function makeSendingClaim(
  messages: string[],
  nextPartIndex: number,
  now: Date,
): PersistedMultipartDeliveryClaim {
  return {
    version: 1,
    state: 'SENDING',
    token: randomUUID(),
    messages,
    nextPartIndex,
    claimedAt: now.toISOString(),
  }
}

async function compareAndSwap(
  claim: AcquiredMultipartDeliveryClaim,
  next: PersistedMultipartDeliveryClaim,
): Promise<string> {
  const nextRawValue = serializeClaim(next)
  const result = await prisma.setting.updateMany({
    where: { key: claim.key, value: claim.rawValue },
    data: { value: nextRawValue },
  })

  if (result.count !== 1) {
    throw new Error(`Multipart delivery claim conflict: ${claim.key}`)
  }

  return nextRawValue
}

export async function acquireMultipartDeliveryClaim(
  key: string,
  messages: string[],
  now: Date = new Date(),
): Promise<MultipartDeliveryClaimResult> {
  const initial = makeSendingClaim(messages, 0, now)
  const initialRawValue = serializeClaim(initial)

  try {
    await prisma.setting.create({ data: { key, value: initialRawValue } })
    return toAcquiredClaim(key, initial, initialRawValue)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
  }

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const currentRow = await prisma.setting.findUnique({
      where: { key },
      select: { value: true },
    })
    if (!currentRow) {
      // The row may have been deleted between the unique conflict and read.
      try {
        await prisma.setting.create({ data: { key, value: initialRawValue } })
        return toAcquiredClaim(key, initial, initialRawValue)
      } catch (error) {
        if (!isUniqueConflict(error)) throw error
        continue
      }
    }

    const current = parsePersistedClaim(currentRow.value)
    if (current?.state === 'SENT') return { status: 'already_sent' }

    if (
      current?.state === 'SENDING'
      && now.getTime() - Date.parse(current.claimedAt) < CLAIM_LEASE_MS
    ) {
      return { status: 'in_progress' }
    }

    const resumable = current !== null && current.messages.length > 0
    const takeover = makeSendingClaim(
      resumable ? current.messages : messages,
      resumable ? current.nextPartIndex : 0,
      now,
    )
    const takeoverRawValue = serializeClaim(takeover)
    const swapped = await prisma.setting.updateMany({
      where: { key, value: currentRow.value },
      data: { value: takeoverRawValue },
    })
    if (swapped.count === 1) {
      return toAcquiredClaim(key, takeover, takeoverRawValue)
    }
  }

  return { status: 'in_progress' }
}

/**
 * Возобновляет только уже сохранённую доставку. Новый claim не создаётся:
 * это позволяет дослать durable multipart, даже если актуальная выборка пуста,
 * не закрывая пустой день навсегда состоянием SENT.
 */
export async function resumeMultipartDeliveryClaim(
  key: string,
  now: Date = new Date(),
): Promise<MultipartDeliveryResumeResult> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const currentRow = await prisma.setting.findUnique({
      where: { key },
      select: { value: true },
    })
    if (!currentRow) return { status: 'no_claim' }

    const current = parsePersistedClaim(currentRow.value)
    if (!current || current.messages.length === 0) {
      return current?.state === 'SENT'
        ? { status: 'already_sent' }
        : { status: 'no_claim' }
    }
    if (current.state === 'SENT') return { status: 'already_sent' }
    if (
      current.state === 'SENDING'
      && now.getTime() - Date.parse(current.claimedAt) < CLAIM_LEASE_MS
    ) {
      return { status: 'in_progress' }
    }

    const takeover = makeSendingClaim(
      current.messages,
      current.nextPartIndex,
      now,
    )
    const takeoverRawValue = serializeClaim(takeover)
    const swapped = await prisma.setting.updateMany({
      where: { key, value: currentRow.value },
      data: { value: takeoverRawValue },
    })
    if (swapped.count === 1) {
      return toAcquiredClaim(key, takeover, takeoverRawValue)
    }
  }

  return { status: 'in_progress' }
}

export async function markMultipartDeliveryPartSent(
  claim: AcquiredMultipartDeliveryClaim,
  partIndex: number,
): Promise<AcquiredMultipartDeliveryClaim> {
  if (partIndex !== claim.nextPartIndex || partIndex >= claim.messages.length) {
    throw new Error(`Invalid multipart delivery part index: ${partIndex}`)
  }

  const current = parsePersistedClaim(claim.rawValue)
  if (current?.state !== 'SENDING' || current.token !== claim.token) {
    throw new Error(`Invalid multipart delivery claim state: ${claim.key}`)
  }

  const next: PersistedMultipartDeliveryClaim = {
    ...current,
    nextPartIndex: partIndex + 1,
  }
  const rawValue = await compareAndSwap(claim, next)
  return toAcquiredClaim(claim.key, next, rawValue)
}

export async function completeMultipartDeliveryClaim(
  claim: AcquiredMultipartDeliveryClaim,
): Promise<void> {
  const current = parsePersistedClaim(claim.rawValue)
  if (current?.state !== 'SENDING' || current.token !== claim.token) {
    throw new Error(`Invalid multipart delivery claim state: ${claim.key}`)
  }
  if (
    current.nextPartIndex !== current.messages.length
    || claim.nextPartIndex !== claim.messages.length
  ) {
    throw new Error(`Multipart delivery claim has unsent parts: ${claim.key}`)
  }

  await compareAndSwap(claim, {
    ...current,
    state: 'SENT',
    messages: [],
    nextPartIndex: claim.messages.length,
  })
}

export async function failMultipartDeliveryClaim(
  claim: AcquiredMultipartDeliveryClaim,
  error: string,
): Promise<void> {
  const current = parsePersistedClaim(claim.rawValue)
  if (current?.state !== 'SENDING' || current.token !== claim.token) {
    throw new Error(`Invalid multipart delivery claim state: ${claim.key}`)
  }

  await compareAndSwap(claim, {
    ...current,
    state: 'FAILED',
    lastError: error.slice(0, 1_000),
  })
}
