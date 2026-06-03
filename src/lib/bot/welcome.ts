import type { OrderType } from '@prisma/client'

/**
 * Перепозиционирование MAX-канала: бот общается от лица «менеджеров компании
 * Будни», без слов «бот»/«ассистент»/«помощник». Welcome-текст ветвится по
 * типу клиента — у трёх категорий разный сценарий ежедневной заявки.
 */
export type WelcomeKind = 'FIXED' | 'DYNAMIC' | 'SAMEDAY'

/**
 * Минимальный срез Client для выбора ветки. handleBotStarted подгружает
 * mealConfigs (orderType) и locations (sameDayDelivery) — этого достаточно.
 */
export interface ClientForWelcome {
  mealConfigs: { orderType: OrderType }[]
  locations: { sameDayDelivery: boolean }[]
}

/**
 * Выбор ветки welcome по приоритету от самой специфичной к общей:
 * 1. Есть хоть одна локация sameDayDelivery=true → 'SAMEDAY' (утренний клиент).
 * 2. Иначе есть хоть один конфиг orderType='DYNAMIC' → 'DYNAMIC'.
 * 3. Иначе (только FIXED-конфиги или конфигов нет) → 'FIXED' (нейтральный).
 */
export function pickWelcomeKind(client: ClientForWelcome): WelcomeKind {
  if (client.locations.some((l) => l.sameDayDelivery)) return 'SAMEDAY'
  if (client.mealConfigs.some((c) => c.orderType === 'DYNAMIC')) return 'DYNAMIC'
  return 'FIXED'
}

// Тексты согласованы с владельцем — вставлены как есть, без эмодзи и
// перефразирования. Подпись «— Будни» обязательна.

export const WELCOME_FIXED = `Здравствуйте! Это Будни. Подключили вас к каналу для оперативной связи.

Если в какой-то день нужно изменить количество, отменить или предупредить о чём-то особенном — пишите сюда. Подстраиваемся, если успеваем до 16:00 накануне.

— Будни`

export const WELCOME_DYNAMIC = `Здравствуйте! Это Будни. Подключили вас к каналу для оперативной связи.

Каждый рабочий день около 11:00 будем присылать сюда заявку на следующий день — пришлите в ответ количество порций. Принимаем до 16:00.

Если в течение дня что-то меняется или нужно что-то спросить — пишите. Стараемся отвечать быстро.

— Будни`

export const WELCOME_SAMEDAY = `Здравствуйте! Это Будни. Подключили вас к каналу для оперативной связи.

Каждый рабочий день около 07:40 будем присылать сюда заявку на сегодня — пришлите в ответ количество порций. Принимаем до 08:40, чтобы успеть приготовить и довезти.

Если что-то срочное — пишите прямо здесь, мы видим.

— Будни`

/** Роутер: ветка → текст. */
export function getWelcomeText(kind: WelcomeKind): string {
  switch (kind) {
    case 'SAMEDAY':
      return WELCOME_SAMEDAY
    case 'DYNAMIC':
      return WELCOME_DYNAMIC
    case 'FIXED':
      return WELCOME_FIXED
  }
}
