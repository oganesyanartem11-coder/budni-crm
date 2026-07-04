import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

// ШАГ 2 Борис-Директ: сохранение лида с лендинга budni.pro в БД (LandingLead)
// ради атрибуции yclid/utm. Модуль строго аддитивный: persistLandingLead
// НИКОГДА не кидает — ошибка записи логируется и не ломает отправку в Telegram.

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

// UTM-ключи берём либерально: лендинг может слать и 'source', и 'utm_source'.
function pickUtm(utm: Record<string, unknown> | null, key: string): string | null {
  if (!utm) return null
  return asString(utm[key]) ?? asString(utm[`utm_${key}`])
}

// Json?-поля: объект сохраняем как есть; иначе undefined (поле не задаём),
// чтобы не связываться с Prisma.JsonNull.
function asJsonObject(v: unknown): Prisma.InputJsonObject | undefined {
  const rec = asRecord(v)
  return rec ? (rec as Prisma.InputJsonObject) : undefined
}

/**
 * Чистый маппинг тела запроса /api/leads/intake → Prisma.LandingLeadCreateInput.
 * null — если body не объект или нет валидного phone (двойная защита:
 * роут уже отвалидировал phone до вызова).
 */
export function mapLeadBody(body: unknown): Prisma.LandingLeadCreateInput | null {
  const rec = asRecord(body)
  if (!rec) return null

  const phone = asString(rec.phone)
  if (!phone) return null

  const utm = asRecord(rec.utm)
  const clickIds = asRecord(rec.click_ids)
  const page = asRecord(rec.page)

  return {
    // как в buildMessage роута: всё, что не 'quiz', считаем 'popup'
    formType: rec.form_type === 'quiz' ? 'quiz' : 'popup',
    name: asString(rec.name),
    phone,
    phoneDigits: asString(rec.phone_digits),
    source: asString(rec.source),
    utmSource: pickUtm(utm, 'source'),
    utmMedium: pickUtm(utm, 'medium'),
    utmCampaign: pickUtm(utm, 'campaign'),
    utmContent: pickUtm(utm, 'content'),
    utmTerm: pickUtm(utm, 'term'),
    yclid: asString(clickIds?.yclid),
    gclid: asString(clickIds?.gclid),
    pageUrl: asString(page?.url),
    pageReferrer: asString(page?.referrer),
    answers: asJsonObject(rec.answers),
    meta: asJsonObject(rec.meta),
  }
}

/**
 * Записывает лид в БД. Никогда не кидает: невалидное тело — молча return,
 * ошибка create — console.error без переброса (Telegram-путь не страдает).
 */
export async function persistLandingLead(body: unknown): Promise<void> {
  const data = mapLeadBody(body)
  if (!data) return

  try {
    await prisma.landingLead.create({ data })
  } catch (err) {
    // Без секретов и без переброса: запись в БД — best effort.
    console.error(
      '[leads/intake] persist failed:',
      err instanceof Error ? err.message : err
    )
  }
}
