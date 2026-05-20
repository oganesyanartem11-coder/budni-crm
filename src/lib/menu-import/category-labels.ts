import type { MealType } from '@prisma/client'

// DISH_CATEGORY_LABELS / DISH_UNIT_LABELS уже есть в @/lib/constants/dish-categories.
// WEEKDAY_NAMES_FULL — в @/lib/utils/week.
// MealType-лейблов в общем проекте не было (только локально в menu-view.tsx) — выносим сюда.
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
}

// Цвета индикатора AI-правок (correctionLevel в Dish — String, не enum в схеме,
// принимает значения 'none' | 'light' | 'medium' | 'critical' из recipe-generator).
export const CORRECTION_LEVEL_COLORS: Record<string, string> = {
  light: '#EAB308',    // yellow-500 — мелкая правка (опечатка, пробелы)
  medium: '#F97316',   // orange-500 — переформулировка
  critical: '#DC2626', // red-600 — возможный дубль / нужно решение шефа
}

export const CORRECTION_LEVEL_LABELS: Record<string, string> = {
  none: 'без правок',
  light: 'мелкая правка',
  medium: 'переформулировка',
  critical: 'нужно решение',
}
