import { prisma } from '@/lib/db/prisma'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import type { PriceChangeLevel } from '@prisma/client'

const APP_URL =
  process.env.TELEGRAM_APP_BASE_URL?.trim()?.replace(/\/$/, '') ??
  'https://budni-crm.vercel.app'

export async function notifyInvoiceAlert(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: {
        include: {
          matchedIngredient: { select: { name: true, isVegetable: true } },
        },
      },
    },
  })
  if (!invoice) return

  // Определить maxLevel
  const order: PriceChangeLevel[] = ['LOW', 'NEW', 'MEDIUM', 'HIGH']
  let maxLevel: PriceChangeLevel = 'LOW'
  for (const line of invoice.lines) {
    if (order.indexOf(line.priceChangeLevel) > order.indexOf(maxLevel)) {
      maxLevel = line.priceChangeLevel
    }
  }

  if (maxLevel === 'LOW') {
    // Без алёрта — но запишем что уровень был.
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { alertLevelSent: 'LOW' },
    })
    return
  }

  // 7.14B-2: «Первая приёмка» — все строки имеют priceChangeLevel === 'NEW'.
  // Это значит, что от этого поставщика (или для этих позиций) у нас нет
  // истории — сравнение цен невозможно, нужен отдельный шаблон сообщения.
  const allNew =
    invoice.lines.length > 0 &&
    invoice.lines.every((l) => l.priceChangeLevel === 'NEW')

  const levelEmoji: Record<PriceChangeLevel, string> = {
    LOW: '🟢',
    MEDIUM: '🟡',
    HIGH: '🔴',
    NEW: '🆕',
  }

  const lines: string[] = []

  if (allNew) {
    lines.push(`📦 <b>Первая приёмка от ${escapeHtml(invoice.supplierName)}</b>`)
    if (invoice.totalAmount) {
      lines.push(`Сумма: ${Number(invoice.totalAmount).toLocaleString('ru-RU')} ₽`)
    }
    lines.push('')
    lines.push(
      '🆕 Сравнение цен недоступно — это первая поставка от этого поставщика'
    )

    // Овощи всё ещё интересны для воскресной проверки.
    const vegLines = invoice.lines.filter(
      (l) => l.matchedIngredient?.isVegetable === true
    )
    if (vegLines.length > 0) {
      lines.push('')
      lines.push('🥬 Проверить на рынке в воскресенье:')
      for (const l of vegLines) {
        const newPrice = l.pricePerKgNormalized
          ? `${Number(l.pricePerKgNormalized).toLocaleString('ru-RU')} ₽`
          : '—'
        lines.push(`  ${escapeHtml(l.matchedIngredient!.name)} — ${newPrice}`)
      }
    }

    lines.push('')
    lines.push(`Подробнее: ${APP_URL}/invoices/${invoiceId}`)
  } else {
    // Top-5 по |Δ%| (симметрично рост/падение).
    const top5 = [...invoice.lines]
      .filter((l) => l.priceChangePercent !== null)
      .sort(
        (a, b) =>
          Math.abs(Number(b.priceChangePercent)) -
          Math.abs(Number(a.priceChangePercent))
      )
      .slice(0, 5)

    lines.push(`📦 <b>Приёмка от ${escapeHtml(invoice.supplierName)}</b>`)
    if (invoice.totalAmount) {
      lines.push(`Сумма: ${Number(invoice.totalAmount).toLocaleString('ru-RU')} ₽`)
    }
    lines.push('')
    lines.push('Изменения цен:')
    for (const line of top5) {
      const pct = Number(line.priceChangePercent ?? 0)
      const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '·'
      const oldPrice = line.previousPricePerKg
        ? `${Number(line.previousPricePerKg).toLocaleString('ru-RU')} → `
        : ''
      const newPrice = line.pricePerKgNormalized
        ? `${Number(line.pricePerKgNormalized).toLocaleString('ru-RU')} ₽`
        : '—'
      const sign = pct > 0 ? '+' : ''
      lines.push(
        `  ${arrow} ${escapeHtml(line.rawName)}: ${oldPrice}${newPrice} (${sign}${pct}%) ${levelEmoji[line.priceChangeLevel]}`
      )
    }

    // Овощи к воскресной проверке
    const vegLines = invoice.lines.filter(
      (l) => l.matchedIngredient?.isVegetable === true
    )
    if (vegLines.length > 0) {
      lines.push('')
      lines.push('🥬 Проверить на рынке в воскресенье:')
      for (const l of vegLines) {
        const newPrice = l.pricePerKgNormalized
          ? `${Number(l.pricePerKgNormalized).toLocaleString('ru-RU')} ₽`
          : '—'
        lines.push(`  ${escapeHtml(l.matchedIngredient!.name)} — ${newPrice}`)
      }
    }
    lines.push('')
    lines.push(`Подробнее: ${APP_URL}/invoices/${invoiceId}`)
  }

  const msg = lines.join('\n')

  // Маршрутизация: HIGH → группа + личные ADMIN_PRO; MEDIUM/NEW → только группа.
  if (maxLevel === 'HIGH') {
    await notifyGroup(msg, { parseMode: 'HTML' })
    const { notifyAllAdminProDirect } = await import('@/lib/telegram/notify')
    await notifyAllAdminProDirect(msg, { parseMode: 'HTML' })
  } else {
    // MEDIUM или NEW
    await notifyGroup(msg, { parseMode: 'HTML' })
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { alertLevelSent: maxLevel },
  })
}
