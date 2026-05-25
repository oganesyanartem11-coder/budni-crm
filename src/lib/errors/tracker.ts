/**
 * 7.12: in-house аналог Sentry. NPM-пакетов @sentry/* мы не используем —
 * sentry.io режет RU IP, поэтому едем сами.
 *
 * Контракт:
 * - `trackError` НИКОГДА не throw. Любая внутренняя ошибка — console.error и return.
 *   Это критично, чтобы onRequestError не зациклился (его триггерит ошибка → tracker
 *   ошибся → снова вызов tracker → …).
 * - В development НЕ пишем в БД (локалку не загрязняем); только console.error.
 * - Дедуп по fingerprint = SHA-256(message + stackTop + url).slice(0,16).
 *   Дубль → increment count + update lastSeenAt; новый → создать запись и алертить.
 * - Escalation: если существующий level !== 'fatal', а новый === 'fatal' — алертить
 *   повторно (но запись остаётся той же, по fingerprint).
 *
 * 7.12 cleanup: см. cleanup-activity-log cron — удаляет resolved старше 30 дней.
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db/prisma'

export type ErrorLevel = 'error' | 'warn' | 'fatal'

export interface TrackErrorInput {
  error: Error | unknown
  request?: { url?: string; method?: string }
  user?: { id: string; role: string }
  level?: ErrorLevel
  extra?: Record<string, unknown>
}

interface NormalizedError {
  message: string
  stack: string | null
  stackTopLine: string
}

const FRAMEWORK_STACK_PREFIXES = [
  'at <anonymous>',
  'at process.',
  'at async Promise.all',
  'at Object.<anonymous>',
]

function isFrameworkOrNodeModulesFrame(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  if (trimmed.includes('node_modules')) return true
  if (trimmed.includes('node:internal')) return true
  if (trimmed.includes('node:async_hooks')) return true
  for (const p of FRAMEWORK_STACK_PREFIXES) {
    if (trimmed.startsWith(p)) return true
  }
  return false
}

function normalize(input: Error | unknown): NormalizedError {
  if (input instanceof Error) {
    const message = input.message || String(input)
    const stack = typeof input.stack === 'string' ? input.stack : null
    let stackTopLine = '<no-stack>'
    if (stack) {
      // Стек начинается с самой строки "Error: …" — нужны только "at …" строки.
      const lines = stack
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('at '))
      const firstUserFrame = lines.find((l) => !isFrameworkOrNodeModulesFrame(l))
      stackTopLine = firstUserFrame ?? lines[0] ?? '<no-stack>'
    }
    return { message, stack, stackTopLine }
  }
  // Не-Error: оборачиваем как лучше можем.
  const message =
    typeof input === 'string'
      ? input
      : (() => {
          try {
            return JSON.stringify(input)
          } catch {
            return String(input)
          }
        })()
  return { message, stack: null, stackTopLine: '<no-stack>' }
}

function fingerprintOf(message: string, stackTopLine: string, url: string | undefined): string {
  return createHash('sha256')
    .update(message + '|' + stackTopLine + '|' + (url ?? ''))
    .digest('hex')
    .slice(0, 16)
}

function getEnvironment(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development'
}

export async function trackError(input: TrackErrorInput): Promise<void> {
  try {
    const env = getEnvironment()
    const { message, stack, stackTopLine } = normalize(input.error)
    const url = input.request?.url
    const method = input.request?.method
    const level: ErrorLevel = input.level ?? 'error'
    const fingerprint = fingerprintOf(message, stackTopLine, url)

    // В development — НЕ писать в БД (важно, см. контракт сверху).
    if (env === 'development' || env === 'test') {
      console.error(
        `[errors:tracker] dev/test, skip DB write fingerprint=${fingerprint} level=${level}: ${message}`
      )
      if (stack) console.error(stack)
      return
    }

    const payloadJson = input.extra && Object.keys(input.extra).length > 0 ? input.extra : null

    // Сначала пробуем найти существующую запись по fingerprint — нужна для escalation.
    const existing = await prisma.errorLog.findUnique({
      where: { fingerprint },
      select: { id: true, level: true },
    })

    if (!existing) {
      // Новая ошибка: создаём + алертим в Telegram.
      const created = await prisma.errorLog.create({
        data: {
          fingerprint,
          message: message.slice(0, 1000),
          stack: stack ? stack.slice(0, 8000) : null,
          url: url ? url.slice(0, 500) : null,
          method: method ?? null,
          userId: input.user?.id ?? null,
          userRole: input.user?.role ?? null,
          environment: env,
          level,
          payload: payloadJson as never,
        },
      })

      try {
        const { notifyTelegramOnNewError } = await import('./notify')
        await notifyTelegramOnNewError(created)
      } catch (notifyErr) {
        console.error('[errors:tracker] notify failed (swallowed):', notifyErr)
      }
      return
    }

    // Существующая: increment count + update lastSeenAt.
    // Escalation: если уровень растёт до fatal — поднимаем уровень и алертим повторно.
    const shouldEscalate = existing.level !== 'fatal' && level === 'fatal'
    const updated = await prisma.errorLog.update({
      where: { fingerprint },
      data: {
        count: { increment: 1 },
        lastSeenAt: new Date(),
        ...(shouldEscalate ? { level: 'fatal' } : {}),
        // Снимаем resolved, если ошибка снова появилась.
        resolvedAt: null,
        resolvedBy: null,
      },
    })

    if (shouldEscalate) {
      try {
        const { notifyTelegramOnNewError } = await import('./notify')
        await notifyTelegramOnNewError(updated)
      } catch (notifyErr) {
        console.error('[errors:tracker] escalation notify failed (swallowed):', notifyErr)
      }
    }
  } catch (err) {
    // КРИТИЧНО: никогда не throw. Иначе onRequestError зациклит tracker.
    try {
      console.error('[errors:tracker] internal failure (swallowed):', err)
    } catch {
      // глушим даже console — на всякий случай.
    }
  }
}
