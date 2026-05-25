import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from './client'
import { getVisionModel } from '@/lib/ai/models'

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

export type RecognizedInvoiceLine = {
  rawName: string
  quantity: number
  unit: string // "г" / "кг" / "л" / "мл" / "шт" / "уп" / etc
  pricePerUnit: number
  amount: number
  boundingBox?: { x: number; y: number; width: number; height: number } // 0-1 relative
}

export type RecognizedInvoice = {
  supplierName: string
  invoiceNumber: string
  invoiceDate: string // ISO YYYY-MM-DD
  totalAmount: number | null
  lines: RecognizedInvoiceLine[]
}

// JSON Schema (НЕ Zod) — формат для Anthropic tool_use input_schema.
// Первый случай tool_use в проекте (см. AGENTS.md: ничего не предполагать про API).
const INVOICE_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_invoice_data',
  description: 'Submit recognized data from supplier invoice for catering company',
  input_schema: {
    type: 'object',
    properties: {
      supplierName: { type: 'string', description: 'Поставщик/контрагент' },
      invoiceNumber: { type: 'string', description: 'Номер накладной' },
      invoiceDate: { type: 'string', description: 'Дата накладной в формате YYYY-MM-DD' },
      totalAmount: {
        type: ['number', 'null'],
        description: 'Итоговая сумма ₽ или null если не видна',
      },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rawName: { type: 'string' },
            quantity: { type: 'number' },
            unit: {
              type: 'string',
              description: 'г / кг / л / мл / шт / уп — оставляй как в накладной',
            },
            pricePerUnit: { type: 'number' },
            amount: { type: 'number' },
            boundingBox: {
              type: ['object', 'null'],
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
              },
              required: ['x', 'y', 'width', 'height'],
            },
          },
          required: ['rawName', 'quantity', 'unit', 'pricePerUnit', 'amount'],
        },
      },
    },
    required: ['supplierName', 'invoiceNumber', 'invoiceDate', 'lines'],
  },
}

export async function recognizeInvoiceImage(input: {
  imageBase64: string
  imageMediaType: ImageMediaType
}): Promise<RecognizedInvoice> {
  const client = getAnthropicClient()

  const systemPrompt = `Ты распознаёшь накладную для кейтеринг-компании. Извлекай данные ТОЧНО как в документе.
Правила:
- Если поле не видно или неоднозначно — оставь пустым (null/пустая строка), НЕ выдумывай.
- Цены оставляй как в документе (с НДС или без — не конвертируй).
- Единицы измерения оставляй как в накладной (г/кг/л/мл/шт/уп) — не нормализуй.
- Для каждой строки по возможности укажи bounding box в относительных координатах (0-1).
- Дата накладной в формате YYYY-MM-DD.`

  const response = await client.messages.create({
    model: getVisionModel(),
    max_tokens: 4096,
    system: systemPrompt,
    tools: [INVOICE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_invoice_data' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: input.imageMediaType,
              data: input.imageBase64,
            },
          },
          { type: 'text', text: 'Распознай эту накладную и вызови submit_invoice_data.' },
        ],
      },
    ],
  })

  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
  )
  if (!toolUse || toolUse.name !== 'submit_invoice_data') {
    throw new Error(
      `LLM did not return tool_use for invoice; stop_reason=${response.stop_reason}`
    )
  }

  return toolUse.input as RecognizedInvoice
}
