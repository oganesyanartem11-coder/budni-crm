import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Страж границы «мозг ↔ полигон»: ВЕСЬ боевой код (src/**.ts), не только
 * boris-direct, НЕ должен импортировать ничего из sim/. Зависимость строго
 * односторонняя: полигон знает про мозг, боевой код про полигон — никогда
 * (иначе прод-сборка начнёт зависеть от симулятора). Общие типы зеркалятся
 * вручную (reason-codes.ts ↔ sim/types.ts).
 *
 * Скан по всему src/ (а не только boris-direct/) — интринсик-защита: ловит
 * будущий импорт sim/ из любого модуля, включая src/app/**.
 */

const BORIS_DIRECT_DIR = dirname(fileURLToPath(import.meta.url))
// src/ — корень боевого кода (три уровня вверх от src/lib/boris-direct/).
const SRC_DIR = dirname(dirname(BORIS_DIRECT_DIR))

/** Импорт-из-полигона: путь в кавычках после from содержит сегмент sim/
 * (относительный или алиасный — регэксп ловит оба). */
const SIM_IMPORT_RE = /from\s+['"].*\bsim\//

/** Все .ts в директории мозга (рекурсивно; поддиректория полигона исключена). */
function collectTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Сам полигон (если однажды окажется внутри) может импортировать себя.
      if (entry.name === 'sim') continue
      files.push(...collectTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('граница мозг ↔ полигон', () => {
  it('ни один .ts во всём src/ не импортирует из sim/', () => {
    const files = collectTsFiles(SRC_DIR)
    expect(files.length).toBeGreaterThan(0) // скан реально что-то видит

    const offenders = files.filter((file) => SIM_IMPORT_RE.test(readFileSync(file, 'utf8')))

    expect(
      offenders.map((file) => relative(SRC_DIR, file)),
      'ГРАНИЦА НАРУШЕНА: боевой код импортирует из sim/ — полигон должен ' +
        'зависеть от мозга, не наоборот. Уберите импорт; общие типы зеркальте ' +
        'вручную (как reason-codes.ts ↔ sim/types.ts). Файлы-нарушители перечислены выше.'
    ).toEqual([])
  })
})
