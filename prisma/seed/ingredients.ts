import { PrismaClient } from '@prisma/client'

interface IngredientSeed {
  name: string
  unit: 'KG' | 'L' | 'PCS'
  pricePerUnit: number
}

const INGREDIENTS: IngredientSeed[] = [
  // Мясо
  { name: 'Говядина (вырезка)',     unit: 'KG', pricePerUnit: 850 },
  { name: 'Куриное филе',           unit: 'KG', pricePerUnit: 380 },
  { name: 'Свинина',                unit: 'KG', pricePerUnit: 520 },
  { name: 'Фарш говяжий',           unit: 'KG', pricePerUnit: 590 },
  // Овощи
  { name: 'Картофель',              unit: 'KG', pricePerUnit: 45 },
  { name: 'Лук репчатый',           unit: 'KG', pricePerUnit: 50 },
  { name: 'Морковь',                unit: 'KG', pricePerUnit: 55 },
  { name: 'Капуста белокочанная',   unit: 'KG', pricePerUnit: 40 },
  { name: 'Огурцы свежие',          unit: 'KG', pricePerUnit: 180 },
  { name: 'Помидоры',               unit: 'KG', pricePerUnit: 220 },
  { name: 'Перец болгарский',       unit: 'KG', pricePerUnit: 240 },
  { name: 'Свёкла',                 unit: 'KG', pricePerUnit: 50 },
  { name: 'Чеснок',                 unit: 'KG', pricePerUnit: 320 },
  { name: 'Зелень (укроп/петрушка)',unit: 'KG', pricePerUnit: 600 },
  // Крупы и мука
  { name: 'Рис',                    unit: 'KG', pricePerUnit: 110 },
  { name: 'Гречка',                 unit: 'KG', pricePerUnit: 130 },
  { name: 'Овсянка',                unit: 'KG', pricePerUnit: 95 },
  { name: 'Макароны',               unit: 'KG', pricePerUnit: 120 },
  { name: 'Мука пшеничная',         unit: 'KG', pricePerUnit: 65 },
  // Молочка / яйца
  { name: 'Молоко',                 unit: 'L',  pricePerUnit: 90 },
  { name: 'Сметана',                unit: 'KG', pricePerUnit: 280 },
  { name: 'Сливочное масло',        unit: 'KG', pricePerUnit: 720 },
  { name: 'Сыр',                    unit: 'KG', pricePerUnit: 680 },
  { name: 'Яйца',                   unit: 'PCS', pricePerUnit: 12 },
  // Базовые
  { name: 'Растительное масло',     unit: 'L',  pricePerUnit: 140 },
  { name: 'Соль',                   unit: 'KG', pricePerUnit: 25 },
  { name: 'Сахар',                  unit: 'KG', pricePerUnit: 70 },
  // Напитки и хлеб
  { name: 'Сухофрукты для компота', unit: 'KG', pricePerUnit: 280 },
  { name: 'Хлеб белый (буханка)',   unit: 'PCS', pricePerUnit: 45 },
  { name: 'Хлеб чёрный (буханка)',  unit: 'PCS', pricePerUnit: 50 },
]

export async function seedIngredients(prisma: PrismaClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  for (const ing of INGREDIENTS) {
    const result = await prisma.ingredient.upsert({
      where: { name: ing.name },
      create: {
        name: ing.name,
        unit: ing.unit,
        pricePerUnit: ing.pricePerUnit,
      },
      update: {
        unit: ing.unit,
        pricePerUnit: ing.pricePerUnit,
      },
    })
    map.set(ing.name, result.id)
  }

  return map
}
