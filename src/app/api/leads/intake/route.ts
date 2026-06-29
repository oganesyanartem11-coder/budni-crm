import { NextResponse } from 'next/server'
import { notifyLeads, escapeHtml } from '@/lib/telegram/notify'
import { readLeadsIntakeSecret } from '@/lib/telegram/env'

export const dynamic = 'force-dynamic'

// Лиды с лендинга budni.pro (вариант «лид→Telegram»): БД не трогаем, только
// шлём аккуратное сообщение в отдельный чат заявок через notifyLeads().
// Образец защиты/структуры — /api/internal/boris-alert, но:
//  - свой секрет LEADS_INTAKE_SECRET (НЕ HEALTH_CHECK_SECRET);
//  - CORS, т.к. запрос идёт из браузера с другого домена (budni.pro);
//  - лёгкий антиспам (honeypot).

const ALLOWED_ORIGIN = 'https://budni.pro'

// Человекочитаемые имена источников (data-source блоков лендинга budni.pro).
// В сообщении показываем читаемое имя; тех-код остаётся в скобках и в хэштеге,
// чтобы фильтрация в чате не зависела от перевода. Неизвестный source —
// показываем как есть (fallback, не падаем).
const SOURCE_LABELS: Record<string, string> = {
  'mobile-menu': 'Меню (моб.) — Рассчитать бюджет',
  'hero-secondary': 'Hero — Заказать дегустацию',
  'aud-office': 'Попап: Офисы',
  'aud-build': 'Попап: Стройки и объекты',
  'aud-warehouse': 'Попап: Склады и производства',
  'aud-med': 'Попап: Медучреждения',
  'aud-film': 'Попап: Съёмочные группы',
  'aud-event': 'Попап: Разовые мероприятия',
  'block-8-shashlyk': 'Шашлык — Хочу шашлык в команду',
  'menu-full': 'Меню — Получить полное меню',
  'case-night': 'Кейс — Оставить заявку',
  chef: 'Шеф Иван — Заказать дегустацию',
  'tasting-block': 'Блок дегустации',
  'final-tasting': 'Финал — дегустация',
  'floating-button': 'Плавающая кнопка',
  'quiz-block-3': 'Квиз (блок 3)',
  'quiz-block-18-final': 'Квиз (финал)',
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Vary: Origin — чтобы CDN/прокси не закэшировал CORS-ответ под другой origin.
  Vary: 'Origin',
}

function corsJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS })
}

// Preflight: браузер шлёт OPTIONS перед POST с кастомными заголовками.
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

type FormType = 'popup' | 'quiz'

interface LeadBody {
  form_type?: unknown
  name?: unknown
  phone?: unknown
  phone_digits?: unknown
  source?: unknown
  utm?: unknown
  click_ids?: unknown
  page?: unknown
  answers?: unknown
  meta?: unknown
  // honeypot-поля: бот заполнит, человек — нет.
  hp?: unknown
  website?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

// #источник_<source>: чистим до [a-z0-9_], чтобы получился валидный хэштег.
function sourceHashtag(source: string | null): string | null {
  if (!source) return null
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, '_')
    .replace(/^_+|_+$/g, '')
  return slug ? `#источник_${slug}` : null
}

function buildMessage(body: LeadBody): string {
  const formType = body.form_type === 'quiz' ? 'quiz' : 'popup'
  const formLabel = formType === 'quiz' ? '🧩 Квиз' : '💬 Попап'

  const name = asString(body.name)
  const phone = asString(body.phone) as string // гарантирован валидацией выше
  const phoneDigits = asString(body.phone_digits)
  const source = asString(body.source)
  const utm = asRecord(body.utm)
  const clickIds = asRecord(body.click_ids)
  const page = asRecord(body.page)
  const answers = asRecord(body.answers)

  const lines: string[] = []
  lines.push(`🆕 <b>Новая заявка с budni.pro</b>`)
  lines.push('')
  lines.push(`👤 Имя: <b>${name ? escapeHtml(name) : '—'}</b>`)
  // tel: ссылку оставляем кликабельной; для отображения экранируем отдельно.
  lines.push(`📞 Телефон: <a href="tel:${escapeHtml(phoneDigits ?? phone)}">${escapeHtml(phone)}</a>`)
  lines.push(`🗂 Форма: ${formLabel}`)
  if (source) {
    const label = SOURCE_LABELS[source]
    // Есть перевод → «Читаемое имя (тех-код)»; нет — показываем сам код.
    lines.push(
      label
        ? `📍 Источник: ${escapeHtml(label)} (<code>${escapeHtml(source)}</code>)`
        : `📍 Источник: ${escapeHtml(source)}`
    )
  }

  if (utm) {
    const utmLine = Object.entries(utm)
      .filter(([, val]) => asString(val) !== null)
      .map(([key, val]) => `${escapeHtml(key)}=${escapeHtml(String(val))}`)
      .join(', ')
    if (utmLine) lines.push(`🎯 UTM: ${utmLine}`)
  }

  if (clickIds) {
    const cidLine = Object.entries(clickIds)
      .filter(([, val]) => asString(val) !== null)
      .map(([key, val]) => `${escapeHtml(key)}=${escapeHtml(String(val))}`)
      .join(', ')
    if (cidLine) lines.push(`🔗 Click IDs: ${cidLine}`)
  }

  if (page) {
    const referrer = asString(page.referrer)
    const url = asString(page.url)
    if (referrer) lines.push(`↩️ Referrer: ${escapeHtml(referrer)}`)
    if (url) lines.push(`🌐 Страница: ${escapeHtml(url)}`)
  }

  if (formType === 'quiz' && answers) {
    const answerLines = Object.entries(answers)
      .filter(([, val]) => asString(val) !== null || typeof val === 'number')
      .map(([key, val]) => `  • ${escapeHtml(key)}: ${escapeHtml(String(val))}`)
    if (answerLines.length > 0) {
      lines.push('')
      lines.push(`📝 <b>Ответы квиза:</b>`)
      lines.push(...answerLines)
    }
  }

  const hashtag = sourceHashtag(source)
  if (hashtag) {
    lines.push('')
    lines.push(escapeHtml(hashtag))
  }

  return lines.join('\n')
}

export async function POST(request: Request) {
  // 1) Двойная авторизация — легитимно, если ЛЮБОЕ из:
  //   (а) валидный Authorization: Bearer <LEADS_INTAKE_SECRET> — служебный/тест;
  //   (б) Origin строго == https://budni.pro — публичная форма лендинга без
  //       секрета в JS (точное совпадение, без www и прочих доменов).
  // Иначе — 401. Секрет читаем мягко: если ENV не задан, путь (б) всё равно
  // работает; падать на 500 не нужно, раз есть валидный Origin.
  const originOk = request.headers.get('origin') === ALLOWED_ORIGIN

  let bearerOk = false
  try {
    const expectedSecret = readLeadsIntakeSecret()
    bearerOk = request.headers.get('authorization') === `Bearer ${expectedSecret}`
  } catch (err) {
    // ENV-секрет не задан — Bearer-путь недоступен, но это не повод ронять
    // легитимный Origin-запрос. Логируем как warn (не error, не утечка).
    console.warn(
      '[leads/intake] LEADS_INTAKE_SECRET not set — bearer path disabled, origin path only:',
      err instanceof Error ? err.message : err
    )
  }

  if (!originOk && !bearerOk) {
    return corsJson({ ok: false, error: 'unauthorized' }, 401)
  }

  // 2) Тело запроса.
  let body: LeadBody
  try {
    body = (await request.json()) as LeadBody
  } catch {
    return corsJson({ ok: false, error: 'invalid_json' }, 400)
  }
  if (typeof body !== 'object' || body === null) {
    return corsJson({ ok: false, error: 'invalid_body' }, 400)
  }

  // 3) Honeypot: бот заполнил скрытое поле → тихо «успех», в чат НЕ шлём.
  if (asString(body.hp) !== null || asString(body.website) !== null) {
    console.log('[leads/intake] honeypot triggered — silently accepted, not forwarded')
    return corsJson({ ok: true }, 200)
  }

  // 4) Валидация минимума: phone обязателен, остальное опционально.
  const phone = asString(body.phone)
  if (!phone) {
    return corsJson({ ok: false, error: 'phone_required' }, 400)
  }

  // 5) Сборка сообщения и отправка в чат заявок.
  const text = buildMessage(body)
  try {
    const result = await notifyLeads(text, { parseMode: 'HTML' })
    if (!result.ok) {
      console.error(`[leads/intake] notifyLeads failed: ${result.error}`)
      return corsJson({ ok: false, error: 'send_failed' }, 500)
    }
  } catch (err) {
    // readLeadsChatId/бот мог кинуть — логируем без утечки секретов.
    console.error('[leads/intake] send threw:', err instanceof Error ? err.message : err)
    return corsJson({ ok: false, error: 'send_failed' }, 500)
  }

  return corsJson({ ok: true }, 200)
}
