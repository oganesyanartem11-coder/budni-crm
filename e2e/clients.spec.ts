import { test, expect } from './fixtures/auth'
import { SMOKE_CLIENT_NAME, SMOKE_LOCATION_NAME } from './helpers/smoke-client'

/**
 * e2e: страница /clients и карточка SMOKE_TEST_CLIENT.
 *
 * Ограничения по бюджету AI/LLM:
 *  - Никаких мутаций: не вызываем archiveClient/unarchiveClient,
 *    не меняем выбор в селекте курьера (это бы триггерило assignCourierToLocation).
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

test('селект курьера присутствует в строке точки @smoke', async ({ page }) => {
  await page.goto('/clients')

  const clientLink = page.getByRole('link', { name: new RegExp(SMOKE_CLIENT_NAME) }).first()
  await clientLink.click()
  await page.waitForURL(/\/clients\/[^/]+$/)

  // Опорный якорь — заголовок точки виден.
  await expect(
    page.getByRole('heading', { name: SMOKE_LOCATION_NAME, level: 3 }),
  ).toBeVisible()

  // Курьерский <select> идентифицируем по уникальной option «Не назначен»
  // с value="" — структурный признак, не CSS-класс. Других select'ов с
  // такой опцией на странице нет.
  const unassignedOption = page.locator('select option[value=""]', {
    hasText: 'Не назначен',
  })
  await expect(unassignedOption.first()).toBeVisible()

  // НЕ меняем выбор — иначе сработал бы assignCourierToLocation
  // и сломал бы изоляцию между прогонами.
})

test.skip('archiveClient cancels future orders — требует hard-delete API/cleanup, заход 3', () => {
  // Заглушка под будущий заход. Этот сценарий требует:
  //  - server action archiveClient (мутация),
  //  - очистку отменённых заказов после теста (hard-delete API),
  //  - изоляцию от других @smoke-тестов.
  // Пока инфраструктуры нет — skip.
})
