import { test, expect } from './fixtures/auth'

/**
 * Smoke-тесты страницы /menu.
 *
 * БЮДЖЕТ AI/LLM: запрещено триггерить approveMenu / approveMenuImport /
 * submitMenuForApproval — переключение MenuCycle в PENDING_APPROVAL эмитит
 * нотификации и может зацепить Borya-LLM. Импорт через AI/Vision —
 * тоже под запретом. Поэтому тесты ограничены чтением страницы и
 * проверкой UI-элементов; никаких кликов по action-кнопкам.
 *
 * Тесты 3 и 4 — заглушки (test.skip) для будущего захода с mock LLM
 * и заранее подготовленным MenuImport-фикстурным состоянием.
 */

test('открыть /menu — страница грузится @smoke', async ({ page }) => {
  await page.goto('/menu')

  // URL остался на /menu (не редирект на /login и не на /dashboard).
  expect(page.url()).toContain('/menu')

  // Layout-каркас присутствует.
  await expect(page.locator('main').first()).toBeVisible()

  // Заголовок страницы из PageHeader (h1 "Меню недели").
  // Берём первый matching heading — в layout может быть и другие.
  const heading = page.getByRole('heading', { name: /меню|цикл/i }).first()
  await expect(heading).toBeVisible()
})

test('видны фильтры и кнопка импорта', async ({ page }) => {
  await page.goto('/menu')

  // Кнопка импорта/создания/меню. На /menu всегда либо empty-state
  // с "Создать меню", либо action-row со статусными кнопками — но
  // навигация по неделям ("Предыдущая неделя"/"Следующая неделя") —
  // это <button> с aria-label, которые подпадают под регэксп.
  // Берём .first() — нам важно лишь то, что какая-то кнопка из
  // ожидаемого семейства присутствует, кликать не будем.
  const actionButton = page
    .getByRole('button', { name: /импорт|загрузить|создать|новое|меню|неделя/i })
    .first()
  await expect(actionButton).toBeVisible()

  // Хотя бы один фильтр/переключатель: на /menu это переключатель
  // недели (кнопки "Предыдущая неделя" / "Следующая неделя" с
  // aria-label) и текст с диапазоном дат недели в заголовке блока.
  // Проверяем наличие текста "неделя" — он присутствует и в "Меню
  // недели", и в aria-label навигации, и при необходимости в
  // подписи к "Текущая". Это просто проверка наличия, не клик.
  const weekHint = page.getByText(/неделя|период|статус/i).first()
  await expect(weekHint).toBeVisible()
})

// eslint-disable-next-line playwright/no-skipped-test
test.skip(
  'approve/unapprove cycle — LLM-risk: эмит MENU_APPROVED → Боря-LLM. Заход 3 со mock LLM.',
  async () => {},
)

// eslint-disable-next-line playwright/no-skipped-test
test.skip(
  'import menu via AI — LLM-risk: Vision/LLM-парсер. Заход 3 с фикстурой готового MenuImport.',
  async () => {},
)
