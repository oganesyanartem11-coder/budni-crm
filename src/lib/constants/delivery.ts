export const DELIVERY_ISSUE_REASONS = [
  'ADDRESS_WRONG',
  'CLIENT_UNAVAILABLE',
  'ACCESS_DENIED',
  'WEATHER',
  'OTHER',
] as const

export type DeliveryIssueReason = (typeof DELIVERY_ISSUE_REASONS)[number]

export const DELIVERY_ISSUE_REASON_LABELS: Record<DeliveryIssueReason, string> = {
  ADDRESS_WRONG: 'Адрес неверный',
  CLIENT_UNAVAILABLE: 'Никого нет на точке',
  ACCESS_DENIED: 'Не пускают (охрана/проблема с проходом)',
  WEATHER: 'Погода / пробки',
  OTHER: 'Другое',
}
