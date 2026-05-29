import { test, expect } from './fixtures/auth'

test('@smoke инфраструктура жива', async ({ page }) => {
  await page.goto('/dashboard')
  expect(page.url()).toContain('/dashboard')
  // Stable selector: <main> присутствует на каждой странице layout.
  await expect(page.locator('main').first()).toBeVisible()
})
