import { describe, it, expect } from 'vitest'
import { chunk } from './chunk'

/**
 * Регрессионные тесты для батчинга generateRecipes (51a56e0): на 59 блюдах
 * один LLM-вызов обрезался по max_tokens, поэтому блюда режутся на батчи по 15
 * и шлются параллельно. chunk — основа этого; тесты защищают размер/порядок/
 * edge-cases (если кто-то поменяет логику и сломает merge или последний батч).
 */
describe('chunk', () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  it('59 элементов по 15 → 4 батча [15,15,15,14] с сохранением порядка', () => {
    const result = chunk(range(59), 15)
    expect(result.map((b) => b.length)).toEqual([15, 15, 15, 14])
    // flatten === исходный массив → порядок и полнота не нарушены
    expect(result.flat()).toEqual(range(59))
    expect(result[0][0]).toBe(1)
    expect(result[3][result[3].length - 1]).toBe(59)
  })

  it('пустой массив → []', () => {
    expect(chunk([], 15)).toEqual([])
  })

  it('ровно один полный батч (15 по 15) → один батч из 15', () => {
    const result = chunk(range(15), 15)
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(15)
  })

  it('30 по 15 → 2 полных батча', () => {
    const result = chunk(range(30), 15)
    expect(result.map((b) => b.length)).toEqual([15, 15])
    expect(result.flat()).toEqual(range(30))
  })

  it('один элемент (неполный последний батч) → [[1]]', () => {
    expect(chunk([1], 15)).toEqual([[1]])
  })
})
