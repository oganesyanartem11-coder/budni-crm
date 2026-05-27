/**
 * 7.12: пуш-уведомление о новой проде-ошибке всем ADMIN'ам в личку Telegram.
 *
 * Best-effort: ловим всё. Зовётся из trackError только при создании новой
 * записи (или escalation до fatal). Дубли уже погашены дедупом по fingerprint.
 */

import type { ErrorLog } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { sendTelegramMessage } from '@/lib/telegram/send'
import { escapeHtml } from '@/lib/telegram/notify'

const ADMIN_PANEL_BASE = 'https://budni-crm.vercel.app'

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

export async function notifyTelegramOnNewError(record: ErrorLog): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: {
        role: { in: ['ADMIN', 'ADMIN_PRO'] },
        isActive: true,
        telegramChatId: { not: null },
      },
      select: { id: true, telegramChatId: true },
    })

    if (admins.length === 0) {
      console.warn('[errors:notify] no admins with telegramChatId, skip')
      return
    }

    // Извлекаем top stack line из полного стека для краткого preview.
    let stackTopLine = '<no-stack>'
    if (record.stack) {
      const firstAtLine = record.stack
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('at '))
      if (firstAtLine) stackTopLine = firstAtLine
    }

    const levelEmoji =
      record.level === 'fatal' ? '🔥' : record.level === 'warn' ? '⚠️' : '🚨'

    const text = [
      `${levelEmoji} <b>Новая ошибка на проде</b>`,
      `${escapeHtml(record.environment)} · ${escapeHtml(record.level)}`,
      '',
      escapeHtml(truncate(record.message, 200)),
      '',
      `URL: ${record.url ? escapeHtml(record.url) : '—'}`,
      `Stack (top): <code>${escapeHtml(truncate(stackTopLine, 200))}</code>`,
      '',
      `Fingerprint: <code>${escapeHtml(record.fingerprint)}</code>`,
      `<a href="${ADMIN_PANEL_BASE}/settings/errors/${record.id}">Открыть в админке</a>`,
    ].join('\n')

    await Promise.allSettled(
      admins.map((a) =>
        sendTelegramMessage(a.telegramChatId as string, text, { parseMode: 'HTML' })
      )
    )
  } catch (err) {
    // Полное проглатывание — tracker не должен падать из-за TG.
    console.error('[errors:notify] failed (swallowed):', err)
  }
}
