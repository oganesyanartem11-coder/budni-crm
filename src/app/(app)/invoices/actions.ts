'use server'

import { del } from '@vercel/blob'
import { after } from 'next/server'
import type { InvoiceProgress, InvoiceStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Создаёт Invoice после успешной client-side загрузки в Vercel Blob.
 * Запускает recognizeInvoice() через after() — не блокирует ответ клиенту.
 */
export async function createInvoiceFromUpload(input: {
  imageUrl: string
  imageWidth?: number
  imageHeight?: number
  exifTakenAt?: string // ISO
  exifSuspicious?: boolean
}): Promise<ActionResult<{ invoiceId: string }>> {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])

  if (!input.imageUrl || !input.imageUrl.startsWith('https://')) {
    return { ok: false, error: 'Некорректный URL изображения' }
  }

  // Бизнес-ключ (supplier+number+date) появится только после распознавания;
  // на этом шаге создаём с PROCESSING/UPLOADED + плейсхолдерами.
  // Уникальность по бизнес-ключу проверяется в orchestrator при попытке записать
  // распознанные данные — если коллизия (дубль), помечаем FAILED с aiErrorMessage.
  const invoice = await prisma.invoice.create({
    data: {
      supplierName: 'Распознаётся…',
      supplierNameLower: `__pending__${Date.now()}`, // временный уникальный плейсхолдер
      invoiceNumber: `__pending__${Date.now()}`,
      invoiceDate: new Date(),
      receivedById: user.id,
      imageUrl: input.imageUrl,
      imageWidth: input.imageWidth ?? null,
      imageHeight: input.imageHeight ?? null,
      exifTakenAt: input.exifTakenAt ? new Date(input.exifTakenAt) : null,
      exifSuspicious: input.exifSuspicious ?? false,
      status: 'PROCESSING',
      progress: 'UPLOADED',
    },
  })

  // Fire-and-forget — клиент получает invoiceId сразу, не ждёт LLM.
  after(async () => {
    try {
      const { recognizeInvoice } = await import('@/lib/invoices/recognize-and-match')
      await recognizeInvoice(invoice.id)
    } catch (err) {
      // trackError из 7.12 — не валим background task
      try {
        const { trackError } = await import('@/lib/errors/tracker')
        await trackError({
          error: err as Error,
          extra: { invoiceId: invoice.id, source: 'createInvoiceFromUpload.after' },
        })
      } catch {}
    }
  })

  return { ok: true, data: { invoiceId: invoice.id } }
}

/**
 * Удаляет blob-картинку накладной. Сам Invoice оставляем для аудита.
 * Используется при reject/revert через C.5 — может быть импортирован оттуда.
 */
export async function deleteInvoiceImage(invoiceId: string): Promise<ActionResult> {
  await requireRole(['ADMIN_PRO'])

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { imageUrl: true },
  })
  if (!invoice) return { ok: false, error: 'Invoice не найден' }

  if (invoice.imageUrl) {
    try {
      await del(invoice.imageUrl)
    } catch (err) {
      // лог через trackError, но не валим (blob мог быть уже удалён)
      try {
        const { trackError } = await import('@/lib/errors/tracker')
        await trackError({
          error: err as Error,
          extra: { invoiceId, source: 'deleteInvoiceImage' },
        })
      } catch {}
    }
    await prisma.invoice.update({ where: { id: invoiceId }, data: { imageUrl: '' } })
  }

  return { ok: true, data: undefined }
}

/**
 * Лёгкий poll-эндпоинт для progress-view.tsx — возвращает только то,
 * что нужно клиенту для прогресс-бара (без всей картинки и линий).
 */
export async function getInvoiceProgress(invoiceId: string): Promise<ActionResult<{
  progress: InvoiceProgress
  status: InvoiceStatus
  aiErrorMessage: string | null
  hasLines: boolean
}>> {
  await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      progress: true,
      status: true,
      aiErrorMessage: true,
      _count: { select: { lines: true } },
    },
  })

  if (!invoice) return { ok: false, error: 'Поставка не найдена' }

  return {
    ok: true,
    data: {
      progress: invoice.progress,
      status: invoice.status,
      aiErrorMessage: invoice.aiErrorMessage,
      hasLines: invoice._count.lines > 0,
    },
  }
}

/**
 * Перезапуск распознавания для FAILED-накладной. Чтобы не плодить отдельные
 * Invoice-записи, переиспользуем существующую: сбрасываем progress/status в
 * UPLOADED/PROCESSING и снова запускаем orchestrator через after().
 */
export async function retryRecognition(invoiceId: string): Promise<ActionResult> {
  await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, imageUrl: true },
  })
  if (!invoice) return { ok: false, error: 'Поставка не найдена' }
  if (invoice.status !== 'FAILED') {
    return { ok: false, error: `Можно перераспознать только FAILED, сейчас ${invoice.status}` }
  }
  if (!invoice.imageUrl) {
    return { ok: false, error: 'У поставки нет фото — повторное распознавание невозможно' }
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'PROCESSING', progress: 'UPLOADED', aiErrorMessage: null },
  })

  // Удалить старые InvoiceLine'ы (если были — например MATCHING упал посередине),
  // чтобы orchestrator создавал заново без дублей.
  await prisma.invoiceLine.deleteMany({ where: { invoiceId } })

  after(async () => {
    try {
      const { recognizeInvoice } = await import('@/lib/invoices/recognize-and-match')
      await recognizeInvoice(invoiceId)
    } catch (err) {
      try {
        const { trackError } = await import('@/lib/errors/tracker')
        await trackError({ error: err as Error, extra: { invoiceId, source: 'retryRecognition.after' } })
      } catch {}
    }
  })

  return { ok: true, data: undefined }
}
