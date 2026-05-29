import { test, expect } from './fixtures/auth'

/**
 * E2E smoke для Boris-фич.
 *
 * БЮДЖЕТНЫЙ КОНТЕКСТ:
 * Любая отправка сообщения через UI/API Бориса → вызов Anthropic LLM
 * (chatWithBoris). В smoke-наборе это запрещено: тесты ниже только
 * проверяют наличие/доступность страниц через page.goto + assertion
 * DOM-элементов. Без POST в /api/boris/*, без кликов «Подтвердить»
 * в pending-actions, без чат-ввода.
 *
 * Сценарии 3 и 4 умышленно помечены test.skip с пояснением:
 * требуют seed-данных или mock LLM — на заход 3.
 */

test('открыть /dashboard — main блок виден @smoke', async ({ page }) => {
  await page.goto('/dashboard')
  expect(page.url()).toContain('/dashboard')

  // <main> — стабильный якорь app-layout'а.
  await expect(page.locator('main').first()).toBeVisible()

  // Любой заголовок на странице: h1/h2 от PageHeader или текстовый
  // якорь по русским/английским ключевым словам.
  const heading = page.getByRole('heading').first()
  const headingFallback = page.getByText(/dashboard|будни|главн/i).first()
  const headingVisible =
    (await heading.isVisible().catch(() => false)) ||
    (await headingFallback.isVisible().catch(() => false))
  expect(headingVisible).toBe(true)
})

test('если /boris существует — грузится', async ({ page }) => {
  // waitUntil:'commit' — не ждём полной загрузки, достаточно ответа сервера,
  // чтобы прочитать статус и итоговый URL (на случай редиректа).
  const response = await page.goto('/boris', { waitUntil: 'commit' })

  // Если страница вернула 404 или редиректнула с /boris (например,
  // requireRole отбрасывает не-ADMIN_PRO юзера на /dashboard) —
  // считаем, что маршрут недоступен в текущем окружении и пропускаем.
  if (!response || response.status() === 404 || !page.url().includes('/boris')) {
    test.skip(true, '/boris маршрут отсутствует или недоступен текущей роли')
    return
  }

  await expect(page.locator('main').first()).toBeVisible()
})

test.skip(
  'бейдж "Боря" в /orders — требует BORIS-заказ в seed, заход 3',
  async () => {
    // ПОЧЕМУ SKIP:
    // Бейдж «Боря» отображается только для заказов, созданных через
    // Boris-pipeline (origin=BORIS / pending-action approve). В текущем
    // seed таких заказов нет, а создавать их через UI означает вызвать
    // LLM (запрещено бюджетом). Корректное покрытие — заход 3:
    //   1) seed-скрипт делает Order с borisOrigin=true БЕЗ LLM,
    //   2) этот тест ходит в /orders и проверяет наличие badge.
  },
)

test.skip(
  'чат с Борей — LLM-risk: каждое сообщение = вызов Anthropic. Заход 3 со mock LLM.',
  async () => {
    // ПОЧЕМУ SKIP:
    // Любой ввод в Boris-чат триггерит chatWithBoris → Anthropic API call.
    // Это (а) тратит бюджет на каждый прогон CI, (б) делает тест нон-
    // детерминированным (LLM-ответ варьируется). Корректное покрытие —
    // заход 3 с моком LLM на уровне сетевого слоя (page.route на
    // api.anthropic.com) и фиксированным response fixture'ом.
  },
)
