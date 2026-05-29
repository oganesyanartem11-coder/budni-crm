import { test as base, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Auth-фикстура: открывает /login, вводит PIN из PLAYWRIGHT_ADMIN_PIN,
 * ждёт редирект на /dashboard, кеширует storageState в .auth/admin.json.
 *
 * Между тестами повторно НЕ логинимся — Playwright читает кэш и
 * восстанавливает cookies. Если файла нет (первый запуск или
 * принудительная очистка) — логин выполняется в setup-фазе.
 *
 * PIN считывается ТОЛЬКО из process.env, в коде не хранится.
 */

const AUTH_DIR = path.join(process.cwd(), 'e2e', '.auth')
const AUTH_FILE = path.join(AUTH_DIR, 'admin.json')

async function loginViaPin(page: Page, pin: string): Promise<void> {
  await page.goto('/login')

  // PIN-форма — 4 раздельных OTP-поля. Кликаем в первое, дальше браузер сам
  // переводит фокус между ними при вводе. page.keyboard.type работает через
  // активный элемент, что и нужно для OTP-инпутов.
  const firstSlot = page
    .locator('input[inputmode="numeric"], input[type="password"], input[name="pin"]')
    .first()
  await firstSlot.waitFor({ state: 'visible', timeout: 10_000 })
  await firstSlot.click()
  await page.keyboard.type(pin, { delay: 50 })

  // Многие OTP-формы сабмитят автоматически после ввода последней цифры.
  // Даём 1.5с на авто-сабмит; если редирект не пришёл — пробуем найти кнопку
  // или жмём Enter.
  try {
    await page.waitForURL(/\/dashboard/, { timeout: 1_500 })
    return
  } catch {
    // авто-сабмит не сработал — продолжаем вручную
  }

  const submitBtn = page.locator('button[type="submit"]').first()
  if (await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.click()
  } else {
    await page.keyboard.press('Enter')
  }
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 })
}

async function ensureAuthState(page: Page): Promise<void> {
  const pin = process.env.E2E_BOT_PIN ?? process.env.PLAYWRIGHT_ADMIN_PIN
  if (!pin) {
    throw new Error('E2E_BOT_PIN or PLAYWRIGHT_ADMIN_PIN not set in env')
  }

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  }

  // Если файла нет — логинимся и сохраняем.
  if (!fs.existsSync(AUTH_FILE)) {
    await loginViaPin(page, pin)
    await page.context().storageState({ path: AUTH_FILE })
    return
  }

  // Файл есть — проверим что сессия живая.
  // Простейшая проверка: открыть /dashboard. Если редиректнуло на /login —
  // сессия протухла, логинимся заново.
  await page.goto('/dashboard')
  if (page.url().includes('/login')) {
    await loginViaPin(page, pin)
    await page.context().storageState({ path: AUTH_FILE })
  }
}

/**
 * Расширенный test: page открывается с авторизованным state.
 * Используй как `import { test, expect } from './fixtures/auth'`.
 */
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ browser }, use) => {
    const storageStateExists = fs.existsSync(AUTH_FILE)
    const context = await browser.newContext(
      storageStateExists ? { storageState: AUTH_FILE } : {},
    )
    const page = await context.newPage()
    await ensureAuthState(page)
    await use(page)
    await context.close()
  },
  page: async ({ authedPage }, use) => {
    await use(authedPage)
  },
})

export { expect }
