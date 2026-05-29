import { test, expect } from './fixtures/auth'

/**
 * CI-only smoke. Бежит из daily-smoke.yml на проде с E2E_BOT_PIN.
 * Не запускается локально по умолчанию (нужен grep @ci).
 *
 * Бюджет AI/LLM: только GET, никакого создания заказов / отправки сообщений.
 */

test('@ci логин под E2E Bot', async ({ page }) => {
  // Фикстура auth уже залогинила. Проверяем что мы на /dashboard.
  await page.goto('/dashboard')
  expect(page.url()).toContain('/dashboard')
  await expect(page.locator('main').first()).toBeVisible()
})

test('@ci /dashboard рендерится', async ({ page }) => {
  const response = await page.goto('/dashboard')
  expect(response).not.toBeNull()
  const status = response?.status() ?? 0
  expect(status, `dashboard returned ${status}`).toBeLessThan(500)
  await expect(page.locator('main').first()).toBeVisible()
})

test('@ci /api/health возвращает ok=true', async ({ request }) => {
  const secret = process.env.HEALTH_CHECK_SECRET
  if (!secret) {
    throw new Error('HEALTH_CHECK_SECRET not set in env')
  }
  const response = await request.get('/api/health', {
    headers: { Authorization: `Bearer ${secret}` },
  })
  const bodyText = await response.text()
  expect(response.status(), `health status=${response.status()} body=${bodyText}`).toBe(200)
  const json = JSON.parse(bodyText) as { ok: boolean }
  expect(json.ok, `health.ok=false body=${bodyText}`).toBe(true)
})
