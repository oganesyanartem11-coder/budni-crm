import { test, expect } from './fixtures/auth'
import { SMOKE_CLIENT_NAME, SMOKE_LOCATION_NAME } from './helpers/smoke-client'

/**
 * E2E для модуля «Заказы».
 *
 * БЮДЖЕТ AI: тесты НЕ дёргают AI-триггеры. Создание разового заказа в форме
 * /orders/new — это серверный action `createOrder`, который не вызывает
 * LLM и не запускает Бориса. FIRST_DELIVERY / RUDE / MENU_APPROVED срабатывают
 * только в потоках доставки/тон-аналитики/меню, которые мы не трогаем.
 *
 * Все созданные заказы немедленно отменяются (CANCELLED) — это финальный
 * статус, дальше по конвейеру они уже не пойдут.
 */

// Завтрашняя и вчерашняя даты в формате YYYY-MM-DD (локальное время).
// Допустимо для теста — серверный cutoff сравнивает по startOfTodayMsk(),
// и сдвиг на 24 часа гарантированно перепрыгивает границу суток.
function tomorrowIso(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function yesterdayIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

test('открыть /orders — список грузится @smoke', async ({ page }) => {
  await page.goto('/orders')
  expect(page.url()).toContain('/orders')
  // Базовый layout страницы — <main> присутствует на всех страницах (app).
  await expect(page.locator('main').first()).toBeVisible()
  // Заголовок страницы — «Заказы».
  await expect(page.getByRole('heading', { name: 'Заказы' }).first()).toBeVisible()
})

test.describe.serial('создание и отмена', () => {
  let orderId: string | null = null

  test('создать разовый заказ на SMOKE_TEST_CLIENT на завтра', async ({ page }) => {
    await page.goto('/orders/new')
    await expect(page.getByRole('heading', { name: 'Новый заказ' })).toBeVisible()

    // Форма использует Radix-Select (role=combobox). Триггер открывается
    // кликом, опции рендерятся в портале с role=option.
    const comboboxes = page.getByRole('combobox')

    // Поле 1: Клиент — берём combobox с placeholder «— выберите —»
    // (Точка пока disabled, mealType показывает «Обед» — порядок стабилен).
    const clientCombo = comboboxes.nth(0)
    await clientCombo.click()
    await page.getByRole('option', { name: SMOKE_CLIENT_NAME }).click()

    // Поле 2: Точка — после выбора клиента combobox разблокируется.
    // Текст опции = «<name> · <address>», поэтому матчим по подстроке.
    const locationCombo = comboboxes.nth(1)
    // Ждём пока поле точки станет активным (запрос getClientForOrderForm).
    await expect(locationCombo).toBeEnabled({ timeout: 10_000 })
    await locationCombo.click()
    await page
      .getByRole('option', { name: new RegExp(SMOKE_LOCATION_NAME, 'i') })
      .first()
      .click()

    // Поле 4: тип питания — по умолчанию LUNCH, оставляем как есть.
    // (это третий combobox в форме)

    // Поле «Дата доставки» — единственный input[type=date] на странице.
    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill(tomorrowIso())

    // Поле «Порций» — number input. На странице их два (порций и цена).
    // Берём по соседней метке.
    const portionsInput = page.getByRole('spinbutton').first()
    await portionsInput.fill('5')

    // Поле «Цена за порцию» — если конфиг подставил цену, оставляем её.
    // Если пусто (нет конфига для SMOKE), задаём 100.
    const priceInput = page.getByRole('spinbutton').nth(1)
    const priceValue = await priceInput.inputValue()
    if (!priceValue || priceValue === '0') {
      await priceInput.fill('100')
    }

    // Submit. Дожидаемся редиректа на /orders?date=...
    await page.getByRole('button', { name: /^Создать заказ$/ }).click()
    await page.waitForURL(/\/orders(\?|$)/, { timeout: 15_000 })

    // На списке должна появиться строка SMOKE_TEST_CLIENT.
    // Используем getByRole('link') — имя клиента — это <Link> в строке.
    const clientLink = page.getByRole('link', { name: SMOKE_CLIENT_NAME }).first()
    await expect(clientLink).toBeVisible({ timeout: 10_000 })

    // Статус заказа: createOrder ставит CONFIRMED (manual = уже договорились).
    // Это не AI-триггер — это обычный server action. Допустимы любые статусы
    // КРОМЕ финальных или продакшн-стадий (LOCKED/IN_PRODUCTION/OUT_FOR_DELIVERY/
    // DELIVERED). Достаточно убедиться что заказ не в DELIVERED/IN_PRODUCTION:
    // мы можем его отменить.
    const row = page.locator('tr').filter({ hasText: SMOKE_CLIENT_NAME }).first()
    await expect(row).toBeVisible()
    // Запрещённые статусы — проверяем отсутствие.
    await expect(row).not.toContainText('На производстве')
    await expect(row).not.toContainText('Доставлен')
    await expect(row).not.toContainText('В доставке')

    // Достаём orderId — кликаем по строке и парсим URL /orders/<id>.
    await row.click()
    await page.waitForURL(/\/orders\/[^/?#]+/, { timeout: 10_000 })
    const match = page.url().match(/\/orders\/([^/?#]+)/)
    expect(match).not.toBeNull()
    orderId = match![1]
  })

  test('past-date guard: создание на вчера → ошибка', async ({ page }) => {
    await page.goto('/orders/new')
    await expect(page.getByRole('heading', { name: 'Новый заказ' })).toBeVisible()

    const comboboxes = page.getByRole('combobox')

    await comboboxes.nth(0).click()
    await page.getByRole('option', { name: SMOKE_CLIENT_NAME }).click()

    const locationCombo = comboboxes.nth(1)
    await expect(locationCombo).toBeEnabled({ timeout: 10_000 })
    await locationCombo.click()
    await page
      .getByRole('option', { name: new RegExp(SMOKE_LOCATION_NAME, 'i') })
      .first()
      .click()

    // Подставляем вчерашнюю дату.
    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill(yesterdayIso())

    await page.getByRole('spinbutton').first().fill('5')
    const priceInput = page.getByRole('spinbutton').nth(1)
    const priceValue = await priceInput.inputValue()
    if (!priceValue || priceValue === '0') {
      await priceInput.fill('100')
    }

    const submit = page.getByRole('button', { name: /^Создать заказ$/ })
    await submit.click()

    // Сервер возвращает ошибку «Нельзя создать или перенести заказ на прошедшую дату»,
    // форма показывает её через toast (sonner). Тост — это div с текстом ошибки.
    // Альтернативно: страница НЕ редиректит на /orders.
    await expect(
      page.getByText(/прошедшую|нельзя.*перенести|past|вчера/i).first()
    ).toBeVisible({ timeout: 10_000 })

    // Подстраховка: мы всё ещё на /orders/new (если был редирект — guard не сработал).
    expect(page.url()).toContain('/orders/new')
  })

  test('отменить заказ из (a) — статус CANCELLED', async ({ page }) => {
    test.skip(!orderId, 'Заказ не был создан в предыдущем тесте')

    await page.goto(`/orders/${orderId}`)
    await expect(page.getByRole('heading', { name: 'Параметры' })).toBeVisible({
      timeout: 10_000,
    })

    // Кнопка «Отменить заказ» в правой колонке.
    await page.getByRole('button', { name: /^Отменить заказ$/ }).click()

    // Модалка — заголовок «Отменить заказ» дублируется, ищем textarea
    // по placeholder, чтобы убедиться что модалка открыта.
    const reason = page.getByPlaceholder(/клиент перенёс|совещание/i)
    await expect(reason).toBeVisible()
    await reason.fill('smoke cleanup')

    // Подтверждаем отмену.
    await page.getByRole('button', { name: /Подтвердить отмену/ }).click()

    // После отмены router.refresh() — статус заказа становится CANCELLED.
    // Статус-бейдж содержит текст «Отменён».
    await expect(page.getByText('Отменён').first()).toBeVisible({ timeout: 10_000 })

    // Дополнительно: кнопка «Отменить заказ» больше не должна показываться
    // (isCancellable=false для CANCELLED).
    await expect(
      page.getByRole('button', { name: /^Отменить заказ$/ })
    ).toHaveCount(0)
  })

  test.afterAll(async ({ browser }) => {
    // Best-effort cleanup: если основной cancel-тест упал и orderId остался,
    // открываем список заказов на завтра и отменяем любой активный заказ
    // для SMOKE_TEST_CLIENT.
    //
    // Не критично если упадёт — основной cleanup гарантирован тестом 2c.
    if (!orderId) return

    const context = await browser.newContext({
      storageState: 'e2e/.auth/admin.json',
    })
    const page = await context.newPage()
    try {
      await page.goto(`/orders/${orderId}`, { timeout: 10_000 })
      // Если кнопка отмены ещё есть — значит, заказ не был отменён, добиваем.
      const cancelBtn = page.getByRole('button', { name: /^Отменить заказ$/ })
      if (await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await cancelBtn.click()
        const reason = page.getByPlaceholder(/клиент перенёс|совещание/i)
        if (await reason.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await reason.fill('afterAll cleanup')
        }
        await page
          .getByRole('button', { name: /Подтвердить отмену/ })
          .click()
          .catch(() => {
            /* ignore */
          })
      }
    } catch {
      // ignore — это best-effort
    } finally {
      await context.close()
    }
  })
})
