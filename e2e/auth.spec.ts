import { test, expect } from './fixtures/auth'

/**
 * E2E логин — bcrypt-only path, БЕЗ LLM-вызовов.
 *
 * UI: 4 отдельных <input> по одной цифре с aria-label "Цифра PIN N".
 * Авто-сабмит при заполнении всех 4 цифр (см. src/app/(auth)/login/login-form.tsx).
 *
 * Заведомо неверные PIN'ы в тестах: '0000' и '9999' — формат валиден
 * (isValidPinFormat = 4 цифры), но это не настоящий админский PIN.
 * Настоящий PIN читается фикстурой из PLAYWRIGHT_ADMIN_PIN и здесь не используется.
 */

const WRONG_PIN_A = '0000'
const WRONG_PIN_B = '9999'

async function fillPin(page: import('@playwright/test').Page, pin: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.getByLabel(`Цифра PIN ${i + 1}`).fill(pin[i])
  }
}

test('успешный логин редиректит на /dashboard @smoke', async ({ page }) => {
  // Фикстура auth уже залогинила page и восстановила storageState.
  await page.goto('/dashboard')
  expect(page.url()).toContain('/dashboard')
  // <main> присутствует на каждой странице layout — стабильный якорь.
  await expect(page.locator('main').first()).toBeVisible()
})

test.describe('негативные сценарии', () => {
  // Свежий контекст без auth-cookies, чтобы /login не редиректил сразу на /dashboard.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('неверный PIN показывает ошибку', async ({ page }) => {
    await page.goto('/login')
    await fillPin(page, WRONG_PIN_A)

    // Форма авто-сабмитится при вводе последней цифры — ждём результата.
    // Главное: НЕ редиректнуло на /dashboard.
    // Даём серверу до 5с на bcrypt + ответ.
    await page.waitForTimeout(3000)
    expect(page.url()).not.toContain('/dashboard')

    // Доп.проверка (мягкая): текст ошибки виден. Регекс охватывает
    // "Неверный PIN", "PIN должен...", "заблокирован", "слишком много".
    const errorVisible = await page
      .getByText(/неверн|ошибк|invalid|заблокирован|слишком/i)
      .first()
      .isVisible()
      .catch(() => false)
    expect(errorVisible).toBe(true)
  })

  test.skip(
    'после N неудач rate-limit — глобальный 20/5мин слишком долгий для CI, заход 3',
    async () => {
      // ПОЧЕМУ SKIP:
      // 1) Глобальный rate-limit в loginAction = 20 неудачных LoginAttempt
      //    за 5 минут (RATE_LIMIT_MAX_FAILED=20, RATE_LIMIT_WINDOW_MIN=5).
      //    20 последовательных bcrypt-сверок через UI займут ~30-60с,
      //    что неприемлемо для smoke-набора на каждом push'е.
      // 2) Per-user lockout (PER_USER_LOCKOUT_THRESHOLD=5) — более быстрая
      //    альтернатива, НО срабатывает только для СУЩЕСТВУЮЩЕГО юзера
      //    (fastCandidate найден через pinLookupHash). Для PIN='9999' и
      //    подобных тестовых значений fastCandidate=null → счётчик
      //    инкрементировать некого → блокировки не будет.
      // 3) Использовать настоящий админский PIN для триггера per-user
      //    lockout запрещено правилом задачи (блокировка реального
      //    аккаунта на 15 минут разрушит остальные тесты).
      //
      // Покрытие rate-limit нужно делать unit-тестом на loginAction
      // (мок prisma.loginAttempt.count → 20), а не e2e через UI.
    },
  )
})
