import { test, expect } from './fixtures/auth'

/**
 * E2E /delivery — read-only smoke.
 *
 * Бюджет AI/LLM: НЕ дёргаем server-actions markStopDelivered /
 * undoStopDelivered / reportDeliveryIssue — они триггерят Borя-LLM
 * (FIRST_DELIVERY, AFTER_LATE) и/или уведомления в общий TG-канал.
 * Здесь только GET + проверка наличия UI.
 */

test('@smoke открыть /delivery — страница грузится', async ({ page }) => {
  await page.goto('/delivery')

  expect(page.url()).toContain('/delivery')

  // <main> присутствует в общем layout (app)/layout.tsx.
  await expect(page.locator('main').first()).toBeVisible()

  // Заголовок страницы: PageHeader рендерит <h1>Доставка</h1>.
  // Подстрахуемся regex'ом «доставк|маршрут» на случай вариаций (роль COURIER
  // получает subtitle «Маршрут на сегодня»).
  const heading = page.getByRole('heading', { level: 1 }).first()
  await expect(heading).toBeVisible()
  await expect(heading).toHaveText(/доставк|маршрут/i)
})

test('видна сегодняшняя дата или date-picker', async ({ page }) => {
  await page.goto('/delivery')
  await expect(page.locator('main').first()).toBeVisible()

  // На /delivery date-навигатор рендерит либо «Сегодня» (isToday),
  // либо formatDateShort(targetDate) + formatDateNumeric (число.месяц.год).
  // Мягкий regex покрывает: «Сегодня», «today», или цифровую дату dd.mm
  // (formatDateNumeric → ru-RU «28.05.2026» и т.п.), либо <input type="date">.
  const dateInput = page.locator('input[type="date"]').first()
  const dateText = page
    .getByText(/сегодня|today|\d{1,2}[.\/-]\d{1,2}/i)
    .first()

  // Достаточно одного из вариантов: либо нативный date-picker, либо текст.
  const hasDateInput = await dateInput.isVisible().catch(() => false)
  const hasDateText = await dateText.isVisible().catch(() => false)

  expect(hasDateInput || hasDateText).toBe(true)
})

test.skip(
  'markStopDelivered — LLM-risk: FIRST_DELIVERY/AFTER_LATE триггерят Боря-LLM. Заход 3 со mock LLM.',
  async () => {},
)

test.skip(
  'reportDeliveryIssue — отправляет уведомление в групповой канал, шум на проде. Заход 3.',
  async () => {},
)
