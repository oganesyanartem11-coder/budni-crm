import type { MenuImportProgress } from '@prisma/client'

export const PROGRESS_LABELS: Record<MenuImportProgress, string> = {
  EXTRACTING: 'Чтение файла',
  PARSING_SCHEDULE: 'Распознаю меню',
  GENERATING_RECIPES: 'Генерирую техкарты',
  ASSEMBLING: 'Сборка',
  READY: 'Готов',
  FAILED: 'Ошибка',
}

// Линейка этапов для UI-прогресса. READY — финальное состояние (показывается
// последним пунктом списка). FAILED обрабатывается отдельно — как ошибка под
// списком этапов, а не как одна из стадий (LLM может упасть на любом этапе и
// progress сразу переходит в FAILED, не сохраняя где именно).
export const PROGRESS_STAGES: Array<{
  key: Exclude<MenuImportProgress, 'FAILED'>
  label: string
}> = [
  { key: 'EXTRACTING', label: 'Чтение файла' },
  { key: 'PARSING_SCHEDULE', label: 'Распознаю меню' },
  { key: 'GENERATING_RECIPES', label: 'Генерирую техкарты' },
  { key: 'ASSEMBLING', label: 'Сборка' },
  { key: 'READY', label: 'Готово' },
]
