import type { DishCategory } from '@prisma/client'

export const DISH_CATEGORY_LABELS: Record<DishCategory, string> = {
  SOUP: 'Суп',
  MAIN: 'Горячее',
  GARNISH: 'Гарнир',
  SALAD: 'Салат',
  DESSERT: 'Десерт',
  DRINK: 'Напиток',
  BREAD_WHITE: 'Хлеб белый',
  BREAD_DARK: 'Хлеб чёрный',
  PORRIDGE: 'Каша',
  EGGS: 'Яйца',
  PANCAKE: 'Блинчики',
  OTHER: 'Прочее',
}

export const DISH_CATEGORY_PLURAL: Record<DishCategory, string> = {
  SOUP: 'Супы',
  MAIN: 'Горячее',
  GARNISH: 'Гарниры',
  SALAD: 'Салаты',
  DESSERT: 'Десерты',
  DRINK: 'Напитки',
  BREAD_WHITE: 'Хлеб белый',
  BREAD_DARK: 'Хлеб чёрный',
  PORRIDGE: 'Каши',
  EGGS: 'Яйца',
  PANCAKE: 'Блинчики',
  OTHER: 'Прочее',
}

export const DISH_CATEGORY_ICONS: Record<DishCategory, string> = {
  SOUP: '🥣',
  MAIN: '🍖',
  GARNISH: '🍚',
  SALAD: '🥗',
  DESSERT: '🍰',
  DRINK: '🥤',
  BREAD_WHITE: '🍞',
  BREAD_DARK: '🍞',
  PORRIDGE: '🥣',
  EGGS: '🍳',
  PANCAKE: '🥞',
  OTHER: '🍽️',
}

// Порядок категорий для фильтров и группировки
export const DISH_CATEGORY_ORDER: DishCategory[] = [
  'SOUP',
  'MAIN',
  'GARNISH',
  'SALAD',
  'DESSERT',
  'DRINK',
  'PORRIDGE',
  'EGGS',
  'PANCAKE',
  'BREAD_WHITE',
  'BREAD_DARK',
  'OTHER',
]

// Единицы измерения dish.unit — для UI
export const DISH_UNIT_LABELS = {
  PORTION: 'порция',
  LITER: 'литр',
  KG: 'кг',
  PIECE: 'шт',
} as const

// Единицы ингредиентов
export const INGREDIENT_UNIT_LABELS = {
  KG: 'кг',
  L: 'л',
  PCS: 'шт',
} as const
