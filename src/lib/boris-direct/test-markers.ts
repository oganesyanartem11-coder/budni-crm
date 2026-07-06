// Тест-фильтр заявок (ШАГ 3в).
//
// Маркеры тестовых заявок владельца/команды — исключаются из счёта заявок и
// конвертер-логики, чтобы тесты не отравляли экономику и «Доставлено».
// Это СЛУЖЕБНЫЕ тестовые маркеры (не контакты клиентов): фиктивный номер и
// тестовое имя. Список расширяемый — добавляй сюда новые тест-маркеры.

/** Цифры тестовых телефонов (только цифры). +79995555555 — тест владельца 03.07. */
export const TEST_PHONE_DIGITS: string[] = ['79995555555']

/** Тестовые имена (нормализованные: lower, ё→е, trim). */
export const TEST_NAMES: string[] = ['тестик']

function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/ё/g, 'е').trim()
}
function digitsOf(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/** Поля лида, по которым распознаём тест. */
export interface TestLeadCheck {
  phoneDigits?: string | null
  phone?: string | null
  name?: string | null
}

/** Тестовая ли это заявка (по номеру ИЛИ имени-маркеру). */
export function isTestLead(lead: TestLeadCheck): boolean {
  const digits =
    lead.phoneDigits && lead.phoneDigits.trim() ? digitsOf(lead.phoneDigits) : digitsOf(lead.phone)
  if (digits && TEST_PHONE_DIGITS.includes(digits)) return true
  const name = normName(lead.name)
  if (name && TEST_NAMES.includes(name)) return true
  return false
}

/** Убирает тестовые заявки из списка (счёт заявок/конвертер-логика). */
export function filterOutTestLeads<T extends TestLeadCheck>(leads: T[]): T[] {
  return leads.filter((lead) => !isTestLead(lead))
}
