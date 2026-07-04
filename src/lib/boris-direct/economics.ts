// Экономическая конституция Бориса-Директа (ШАГ 6).
//
// Принцип: ЗАЯВКА ценнее экономии на клике. Цена клика САМА ПО СЕБЕ — НЕ
// критерий отсечения. Отсекаем ТОЛЬКО объём-показов-без-конверсий по порогам
// (rules/config PLAYBOOK). Конвертер — фраза с ≥1 заявкой за окно 30 дней —
// НЕ кандидат на выключение/минус/понижение ставки с мотивом «дорого»: по
// таким только «наблюдать/кормить». Цену заявки меряем в % от ценности заявки
// (LEAD_VALUE_RUB): пока CPL < ценности — заявка выгодна, паниковать нечего.
//
// Чистые функции. На код-предохранители и числовые пороги НЕ влияют — только
// на отбор кандидатов и тексты сводок.

import { getLeadValueRub } from './config'

/** Окно защиты конвертера, дней: ≥1 заявка за 30 дней → фраза защищена. */
export const CONVERTER_PROTECT_WINDOW_DAYS = 30

/**
 * Защита конвертера: фраза с ≥1 конверсией за окно 30 дней НЕ подлежит
 * выключению / минусовке / понижению ставки с мотивом «дорого». Заявка
 * ценнее экономии на клике — такие фразы только наблюдаем/кормим.
 */
export function isProtectedConverter(conversions30d: number): boolean {
  return conversions30d >= 1
}

/**
 * Убирает из списка минус-кандидатов защищённых конвертеров (≥1 заявка за
 * 30 дней), даже если в узком окне минусовки у них 0 заявок. Возвращает
 * оставшиеся кандидаты + список защищённых (их только наблюдаем).
 */
export function filterOutProtectedConverters(
  candidates: string[],
  conversions30dOf: (candidate: string) => number
): { kept: string[]; protectedConverters: string[] } {
  const kept: string[] = []
  const protectedConverters: string[] = []
  for (const c of candidates) {
    if (isProtectedConverter(conversions30dOf(c))) protectedConverters.push(c)
    else kept.push(c)
  }
  return { kept, protectedConverters }
}

/** Цена заявки как доля ценности заявки, % (null → нет данных). */
export function cplPctOfValue(cplRub: number | null): number | null {
  if (cplRub == null) return null
  const value = getLeadValueRub()
  if (value <= 0) return null
  return (cplRub / value) * 100
}

/** Дешевле ли заявка своей ценности (нет повода паниковать при CPL < Value). */
export function cplBelowValue(cplRub: number | null): boolean {
  if (cplRub == null) return false
  const value = getLeadValueRub()
  return value > 0 && cplRub < value
}

/**
 * Цена заявки для сводок в % от ценности: «900 ₽ (4,5% ценности заявки)».
 * null → «нет данных». Так CPL < Value читается спокойно, без паники от
 * абсолютной цифры (ШАГ 6(б)).
 */
export function formatCplWithValue(cplRub: number | null): string {
  if (cplRub == null) return 'нет данных'
  const pct = cplPctOfValue(cplRub)
  const pctStr = pct == null ? '' : ` (${pct.toFixed(1).replace('.', ',')}% ценности заявки)`
  return `${Math.round(cplRub)} ₽${pctStr}`
}
