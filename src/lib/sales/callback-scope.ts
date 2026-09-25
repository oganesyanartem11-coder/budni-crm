/**
 * Scope inline-кнопок воронки в callback-router (`sales:<action>:<id>`).
 *
 * Отдельный модуль БЕЗ импортов — намеренно. telegram/handlers/sales.ts читает
 * scope на верхнем уровне (registerCallbackHandler при импорте), а
 * sales/notify.ts сидит в цикле импортов: sales/notify → telegram/notify →
 * telegram/send → telegram/bot → telegram/handlers/sales → sales/notify.
 * Когда граф входил через sales/notify (cron sales-reminders), хендлер читал
 * константу до её инициализации — TDZ «Cannot access … before initialization»
 * ронял всю функцию Vercel, включая вебхук MAX (инцидент 2026-09-25).
 * Из листового модуля значение доступно всегда.
 */
export const SALES_CALLBACK_SCOPE = 'sales'
