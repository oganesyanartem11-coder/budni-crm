import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import {
  recognizeInvoiceImage,
  type RecognizedInvoice,
} from '@/lib/llm/invoice-recognizer'
import {
  matchInvoiceLines,
  type MatchResult,
  type ExistingIngredient,
} from './match-ingredients'
import { normalizePriceToIngredientUnit } from './normalize-price'
import type { PriceChangeLevel } from '@prisma/client'

const PRICE_CHANGE_LEVEL_THRESHOLDS = {
  LOW: 10, // < 10%
  MEDIUM: 30, // 10..30%
  HIGH: 30, // ≥ 30%
} as const

function calcPriceChangeLevel(percent: number | null, isNew: boolean): PriceChangeLevel {
  if (isNew) return 'NEW'
  if (percent === null) return 'LOW'
  const abs = Math.abs(percent)
  if (abs >= PRICE_CHANGE_LEVEL_THRESHOLDS.MEDIUM) return 'HIGH'
  if (abs >= PRICE_CHANGE_LEVEL_THRESHOLDS.LOW) return 'MEDIUM'
  return 'LOW'
}

/**
 * Главный pipeline: Vision → match → normalize → persist.
 * Вызывается через after() из createInvoiceFromUpload. НЕ throw наружу —
 * любая ошибка фиксируется в Invoice.status=FAILED + aiErrorMessage.
 */
export async function recognizeInvoice(invoiceId: string): Promise<void> {
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) return // удалён — ничего не делаем

    // 1. RECOGNIZING
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { progress: 'RECOGNIZING' },
    })

    // 2. Скачать blob → base64
    const resp = await fetch(invoice.imageUrl)
    if (!resp.ok) throw new Error(`Не удалось скачать изображение: ${resp.status}`)
    const arrayBuf = await resp.arrayBuffer()
    const base64 = Buffer.from(arrayBuf).toString('base64')
    const contentType = resp.headers.get('content-type') ?? 'image/jpeg'
    const mediaType = (
      ['image/jpeg', 'image/png', 'image/webp'].includes(contentType)
        ? contentType
        : 'image/jpeg'
    ) as 'image/jpeg' | 'image/png' | 'image/webp'

    // 3. Vision
    const recognized: RecognizedInvoice = await recognizeInvoiceImage({
      imageBase64: base64,
      imageMediaType: mediaType,
    })

    // 4. MATCHING
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        progress: 'MATCHING',
        aiRawResponse: recognized as unknown as object,
      },
    })

    const existingIngs = await prisma.ingredient.findMany({
      where: { isActive: true, status: 'APPROVED' },
      select: {
        id: true,
        name: true,
        unit: true,
        brandVariants: true,
        pricePerUnit: true,
      },
    })
    const existingForMatch: ExistingIngredient[] = existingIngs.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      brandVariants: (i.brandVariants as unknown[]) ?? undefined,
    }))

    const matches: MatchResult[] = await matchInvoiceLines({
      lines: recognized.lines,
      existingIngredients: existingForMatch,
    })

    // 5. Дедупликация по бизнес-ключу (supplierLower + number + date).
    const supplierLower = recognized.supplierName.trim().toLowerCase()
    const existingByBusinessKey = await prisma.invoice.findFirst({
      where: {
        supplierNameLower: supplierLower,
        invoiceNumber: recognized.invoiceNumber,
        invoiceDate: new Date(recognized.invoiceDate),
        NOT: { id: invoiceId },
      },
      select: { id: true },
    })
    if (existingByBusinessKey) {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'FAILED',
          progress: 'FAILED',
          aiErrorMessage: `Дубль: уже есть Invoice ${existingByBusinessKey.id} с теми же supplier+number+date`,
        },
      })
      return
    }

    // 6. Записать всё в одной транзакции через prismaDirect (interactive tx).
    await prismaDirect.$transaction(async (tx) => {
      // 6a. Обновить Invoice бизнес-данными.
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          supplierName: recognized.supplierName,
          supplierNameLower: supplierLower,
          invoiceNumber: recognized.invoiceNumber,
          invoiceDate: new Date(recognized.invoiceDate),
          totalAmount: recognized.totalAmount ?? undefined,
        },
      })

      // 6b. Создать InvoiceLine для каждой строки.
      for (let i = 0; i < recognized.lines.length; i++) {
        const line = recognized.lines[i]
        const match = matches[i]
        const matchedIng = match.matchedIngredientId
          ? existingIngs.find((e) => e.id === match.matchedIngredientId)
          : null

        // 6c. Нормализация цены
        let pricePerNormalized: number | null = null
        let previousPrice: number | null = null
        let changePercent: number | null = null
        let changeLevel: PriceChangeLevel = 'LOW'

        if (matchedIng) {
          const norm = normalizePriceToIngredientUnit({
            pricePerUnit: line.pricePerUnit,
            quantity: line.quantity,
            unit: line.unit,
            ingredientUnit: matchedIng.unit,
          })
          if (norm.pricePerNormalizedUnit > 0) {
            pricePerNormalized = norm.pricePerNormalizedUnit
            previousPrice = Number(matchedIng.pricePerUnit)
            if (previousPrice > 0) {
              changePercent =
                Math.round(((pricePerNormalized - previousPrice) / previousPrice) * 1000) / 10
            } else {
              changePercent = null // была плейсхолдер-цена (0) → не считаем %
            }
          }
        }
        const isNew = match.action === 'CREATED_NEW'
        changeLevel = calcPriceChangeLevel(changePercent, isNew)

        await tx.invoiceLine.create({
          data: {
            invoiceId,
            lineIndex: i + 1,
            rawName: line.rawName,
            rawQuantity: line.quantity,
            rawUnit: line.unit,
            rawPricePerUnit: line.pricePerUnit,
            rawAmount: line.amount,
            matchedIngredientId: match.matchedIngredientId,
            matchedAction: match.action,
            aiConfidence: match.confidence,
            aiContext: match.context,
            pricePerKgNormalized: pricePerNormalized ?? undefined,
            previousPricePerKg: previousPrice ?? undefined,
            priceChangePercent: changePercent ?? undefined,
            priceChangeLevel: changeLevel,
            boundingBoxes: line.boundingBox
              ? (line.boundingBox as unknown as object)
              : undefined,
          },
        })
      }

      // 6d. Финализация Invoice.
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { progress: 'READY', status: 'AWAITING_ACCEPT' },
      })
    })
  } catch (err) {
    // Любая ошибка — Invoice.FAILED + trackError
    const errorMessage = err instanceof Error ? err.message : String(err)
    try {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { progress: 'FAILED', status: 'FAILED', aiErrorMessage: errorMessage },
      })
    } catch {}
    try {
      const { trackError } = await import('@/lib/errors/tracker')
      await trackError({
        error: err as Error,
        extra: { invoiceId, source: 'recognizeInvoice' },
      })
    } catch {}
  }
}
