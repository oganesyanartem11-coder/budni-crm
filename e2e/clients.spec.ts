import { test, expect } from './fixtures/auth'
import { SMOKE_CLIENT_NAME, SMOKE_LOCATION_NAME } from './helpers/smoke-client'

/**
 * e2e: страница /clients и карточка SMOKE_TEST_CLIENT.
 *
 * Ограничения по бюджету AI/LLM:
 *  - Никаких мутаций: не вызываем archiveClient/unarchiveClient и не сохраняем
 *    форму точки.
 *  - Только GET страниц + проверка наличия UI-элементов.
 */

test('открыть /clients — список грузится @smoke', async ({ page }) => {
  await page.goto('/clients')
  expect(page.url()).toContain('/clients')

  // Базовый layout жив.
  await expect(page.locator('main').first()).toBeVisible()

  // Где-то на странице есть карточка/строка с клиентом — проверим
  // что seed-клиент SMOKE_TEST_CLIENT отрисовался. Если его нет,
  // тест упадёт с понятной ошибкой — значит надо прогнать seed.
  await expect(page.getByText(SMOKE_CLIENT_NAME).first()).toBeVisible()
})

test('открыть SMOKE_TEST_CLIENT — карточка с локациями @smoke', async ({ page }) => {
  await page.goto('/clients')

  // Карточка клиента — это <a href="/clients/<id>"> с текстом названия внутри.
  // getByRole('link', { name }) корректно матчит ссылку по доступному имени.
  const clientLink = page.getByRole('link', { name: new RegExp(SMOKE_CLIENT_NAME) }).first()
  await expect(clientLink).toBeVisible()
  await clientLink.click()

  // URL должен содержать /clients/<id>, а не просто /clients.
  await page.waitForURL(/\/clients\/[^/]+$/)
  expect(page.url()).toMatch(/\/clients\/[^/]+$/)

  // На карточке клиента — таб «Точки» открыт по умолчанию,
  // и в нём виден SMOKE_TEST_LOCATION.
  await expect(page.getByRole('heading', { name: SMOKE_LOCATION_NAME, level: 3 })).toBeVisible()
})

test('настройки доставки точки открываются без мутации @smoke', async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 390, height: 844 })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) {
          success({
            coords: {
              latitude: 59.9386,
              longitude: 30.3141,
              accuracy: 8,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
              toJSON: () => ({}),
            },
            timestamp: Date.now(),
            toJSON: () => ({}),
          })
        },
      },
    })
  })

  await page.goto('/clients')

  const clientLink = page.getByRole('link', { name: new RegExp(SMOKE_CLIENT_NAME) }).first()
  await expect(clientLink).toBeVisible()
  await Promise.all([
    page.waitForURL(/\/clients\/[^/]+$/),
    clientLink.click(),
  ])

  // Опорный якорь — заголовок точки виден.
  await expect(
    page.getByRole('heading', { name: SMOKE_LOCATION_NAME, level: 3 }),
  ).toBeVisible()

  await page.getByRole('button', { name: `Редактировать точку ${SMOKE_LOCATION_NAME}` }).click()
  const dialog = page.getByRole('dialog', { name: 'Редактировать точку' })
  await expect(dialog).toBeVisible()

  await expect(page.locator('body')).toHaveCSS('font-family', /Onest/)
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(236, 237, 238)')
  await expect(dialog.locator(':scope > div')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

  const packagingSelect = dialog.getByRole('combobox', { name: 'Упаковка' })
  await expect(packagingSelect).toBeVisible()
  const originalPackaging = await packagingSelect.inputValue()
  const alternatePackaging = originalPackaging === 'INDIVIDUAL' ? 'BULK' : 'INDIVIDUAL'
  await packagingSelect.selectOption(alternatePackaging)
  await expect(packagingSelect).toHaveValue(alternatePackaging)
  await packagingSelect.selectOption(originalPackaging)

  const modeSelect = dialog.getByRole('combobox', { name: 'Режим доставки' })
  await expect(modeSelect).toBeVisible()
  const originalMode = await modeSelect.inputValue()
  const originalCourier = originalMode === 'IN_HOUSE'
    ? await dialog.getByRole('combobox', { name: 'Наш курьер' }).inputValue()
    : ''

  if (originalMode === 'IN_HOUSE') {
    await modeSelect.selectOption('EXTERNAL')
    await expect(dialog.getByRole('combobox', { name: 'Наш курьер' })).toHaveCount(0)
  }

  await modeSelect.selectOption('IN_HOUSE')
  const courierSelect = dialog.getByRole('combobox', { name: 'Наш курьер' })
  await expect(courierSelect).toBeVisible()
  const courierOptionCount = await courierSelect.locator('option').count()
  expect(courierOptionCount).toBeGreaterThan(0)
  if (courierOptionCount > 1) {
    await courierSelect.selectOption({ index: 1 })
    await expect(courierSelect).not.toHaveValue('')
  }

  await modeSelect.selectOption('EXTERNAL')
  await expect(courierSelect).toHaveCount(0)
  await modeSelect.selectOption(originalMode)
  if (originalMode === 'IN_HOUSE' && originalCourier) {
    await dialog.getByRole('combobox', { name: 'Наш курьер' }).selectOption(originalCourier)
  }

  await expect(dialog.getByLabel('Телефон')).toBeVisible()
  await expect(dialog.getByLabel('Контроль геозоны')).toBeVisible()

  await dialog
    .getByLabel('Полная ссылка Яндекс.Карт')
    .fill('https://yandex.ru/maps/?ll=37.6173%2C55.7558')
  await dialog.getByRole('button', { name: 'Взять координаты' }).click()
  await expect(dialog.getByLabel('Широта')).toHaveValue('55.7558')
  await expect(dialog.getByLabel('Долгота')).toHaveValue('37.6173')

  await dialog.getByRole('button', { name: 'Взять мою позицию' }).click()
  await expect(dialog.getByLabel('Широта')).toHaveValue('59.9386')
  await expect(dialog.getByLabel('Долгота')).toHaveValue('30.3141')

  const submitButton = dialog.getByRole('button', { name: 'Сохранить точку' })
  await expect(submitButton).toHaveCSS('background-color', 'rgb(16, 20, 26)')
  await expect(submitButton).toHaveCSS('min-height', '44px')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)

  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  await expect(dialog).toBeHidden()
})

test.skip('archiveClient cancels future orders — требует hard-delete API/cleanup, заход 3', () => {
  // Заглушка под будущий заход. Этот сценарий требует:
  //  - server action archiveClient (мутация),
  //  - очистку отменённых заказов после теста (hard-delete API),
  //  - изоляцию от других @smoke-тестов.
  // Пока инфраструктуры нет — skip.
})
