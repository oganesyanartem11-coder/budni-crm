/**
 * Режет массив на батчи фиксированного размера с сохранением порядка.
 * Последний батч — неполный, если длина не кратна size. Пустой вход → [].
 *
 * Извлечён из recipe-generator.ts (51a56e0, батчинг generateRecipes по 15 блюд)
 * как переиспользуемый и юнит-тестируемый helper (MEGA-C) — защита от регрессии
 * размера/порядка батчей.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
