import { PrismaClient, type DishCategory, type DishUnit } from '@prisma/client'

interface IngredientLine {
  name: string
  bruttoGrams: number
  nettoGrams: number
}

interface DishSeed {
  name: string
  category: DishCategory
  unit: DishUnit
  portionSize?: number
  ingredients: IngredientLine[]
}

const DISHES: DishSeed[] = [
  // СУПЫ (на 1 порцию = 300 мл)
  {
    name: 'Борщ', category: 'SOUP', unit: 'PORTION', portionSize: 300,
    ingredients: [
      { name: 'Говядина (вырезка)', bruttoGrams: 60, nettoGrams: 50 },
      { name: 'Свёкла', bruttoGrams: 80, nettoGrams: 65 },
      { name: 'Капуста белокочанная', bruttoGrams: 70, nettoGrams: 60 },
      { name: 'Картофель', bruttoGrams: 60, nettoGrams: 45 },
      { name: 'Лук репчатый', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Морковь', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Растительное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Соль', bruttoGrams: 3, nettoGrams: 3 },
    ],
  },
  {
    name: 'Куриная лапша', category: 'SOUP', unit: 'PORTION', portionSize: 300,
    ingredients: [
      { name: 'Куриное филе', bruttoGrams: 50, nettoGrams: 45 },
      { name: 'Макароны', bruttoGrams: 30, nettoGrams: 30 },
      { name: 'Картофель', bruttoGrams: 50, nettoGrams: 40 },
      { name: 'Лук репчатый', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Морковь', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Зелень (укроп/петрушка)', bruttoGrams: 5, nettoGrams: 4 },
      { name: 'Соль', bruttoGrams: 3, nettoGrams: 3 },
    ],
  },
  {
    name: 'Солянка мясная', category: 'SOUP', unit: 'PORTION', portionSize: 300,
    ingredients: [
      { name: 'Говядина (вырезка)', bruttoGrams: 50, nettoGrams: 42 },
      { name: 'Свинина', bruttoGrams: 40, nettoGrams: 34 },
      { name: 'Лук репчатый', bruttoGrams: 30, nettoGrams: 24 },
      { name: 'Картофель', bruttoGrams: 50, nettoGrams: 40 },
      { name: 'Помидоры', bruttoGrams: 40, nettoGrams: 36 },
      { name: 'Сметана', bruttoGrams: 20, nettoGrams: 20 },
      { name: 'Соль', bruttoGrams: 3, nettoGrams: 3 },
    ],
  },
  {
    name: 'Гороховый суп', category: 'SOUP', unit: 'PORTION', portionSize: 300,
    ingredients: [
      { name: 'Свинина', bruttoGrams: 50, nettoGrams: 42 },
      { name: 'Картофель', bruttoGrams: 70, nettoGrams: 55 },
      { name: 'Лук репчатый', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Морковь', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Растительное масло', bruttoGrams: 6, nettoGrams: 6 },
      { name: 'Соль', bruttoGrams: 3, nettoGrams: 3 },
    ],
  },
  {
    name: 'Щи из свежей капусты', category: 'SOUP', unit: 'PORTION', portionSize: 300,
    ingredients: [
      { name: 'Говядина (вырезка)', bruttoGrams: 55, nettoGrams: 48 },
      { name: 'Капуста белокочанная', bruttoGrams: 90, nettoGrams: 78 },
      { name: 'Картофель', bruttoGrams: 50, nettoGrams: 40 },
      { name: 'Лук репчатый', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Морковь', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Сметана', bruttoGrams: 15, nettoGrams: 15 },
      { name: 'Соль', bruttoGrams: 3, nettoGrams: 3 },
    ],
  },
  // ГОРЯЧЕЕ (на 1 порцию)
  {
    name: 'Котлеты домашние', category: 'MAIN', unit: 'PORTION', portionSize: 120,
    ingredients: [
      { name: 'Фарш говяжий', bruttoGrams: 110, nettoGrams: 100 },
      { name: 'Лук репчатый', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Хлеб белый (буханка)', bruttoGrams: 0.1, nettoGrams: 0.08 },
      { name: 'Яйца', bruttoGrams: 0.2, nettoGrams: 0.2 },
      { name: 'Растительное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Куриные биточки', category: 'MAIN', unit: 'PORTION', portionSize: 120,
    ingredients: [
      { name: 'Куриное филе', bruttoGrams: 130, nettoGrams: 115 },
      { name: 'Лук репчатый', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Яйца', bruttoGrams: 0.15, nettoGrams: 0.15 },
      { name: 'Мука пшеничная', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Растительное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Гуляш из говядины', category: 'MAIN', unit: 'PORTION', portionSize: 150,
    ingredients: [
      { name: 'Говядина (вырезка)', bruttoGrams: 140, nettoGrams: 120 },
      { name: 'Лук репчатый', bruttoGrams: 30, nettoGrams: 24 },
      { name: 'Морковь', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Помидоры', bruttoGrams: 40, nettoGrams: 36 },
      { name: 'Мука пшеничная', bruttoGrams: 5, nettoGrams: 5 },
      { name: 'Растительное масло', bruttoGrams: 10, nettoGrams: 10 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Тефтели в томатном соусе', category: 'MAIN', unit: 'PORTION', portionSize: 130,
    ingredients: [
      { name: 'Фарш говяжий', bruttoGrams: 100, nettoGrams: 90 },
      { name: 'Рис', bruttoGrams: 20, nettoGrams: 20 },
      { name: 'Лук репчатый', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Помидоры', bruttoGrams: 35, nettoGrams: 32 },
      { name: 'Растительное масло', bruttoGrams: 6, nettoGrams: 6 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Свинина по-домашнему', category: 'MAIN', unit: 'PORTION', portionSize: 140,
    ingredients: [
      { name: 'Свинина', bruttoGrams: 130, nettoGrams: 115 },
      { name: 'Лук репчатый', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Морковь', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Растительное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Чеснок', bruttoGrams: 3, nettoGrams: 2.5 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Куриная грудка запечённая', category: 'MAIN', unit: 'PORTION', portionSize: 130,
    ingredients: [
      { name: 'Куриное филе', bruttoGrams: 140, nettoGrams: 125 },
      { name: 'Растительное масло', bruttoGrams: 6, nettoGrams: 6 },
      { name: 'Чеснок', bruttoGrams: 3, nettoGrams: 2.5 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  // ГАРНИРЫ
  {
    name: 'Картофельное пюре', category: 'GARNISH', unit: 'PORTION', portionSize: 180,
    ingredients: [
      { name: 'Картофель', bruttoGrams: 200, nettoGrams: 160 },
      { name: 'Молоко', bruttoGrams: 30, nettoGrams: 30 },
      { name: 'Сливочное масло', bruttoGrams: 10, nettoGrams: 10 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Гречка отварная', category: 'GARNISH', unit: 'PORTION', portionSize: 150,
    ingredients: [
      { name: 'Гречка', bruttoGrams: 60, nettoGrams: 60 },
      { name: 'Сливочное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Рис отварной', category: 'GARNISH', unit: 'PORTION', portionSize: 150,
    ingredients: [
      { name: 'Рис', bruttoGrams: 60, nettoGrams: 60 },
      { name: 'Сливочное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Макароны отварные', category: 'GARNISH', unit: 'PORTION', portionSize: 150,
    ingredients: [
      { name: 'Макароны', bruttoGrams: 70, nettoGrams: 70 },
      { name: 'Сливочное масло', bruttoGrams: 10, nettoGrams: 10 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  {
    name: 'Тушёная капуста', category: 'GARNISH', unit: 'PORTION', portionSize: 160,
    ingredients: [
      { name: 'Капуста белокочанная', bruttoGrams: 200, nettoGrams: 170 },
      { name: 'Морковь', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Лук репчатый', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Растительное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Соль', bruttoGrams: 2, nettoGrams: 2 },
    ],
  },
  // САЛАТЫ
  {
    name: 'Салат "Витаминный"', category: 'SALAD', unit: 'PORTION', portionSize: 100,
    ingredients: [
      { name: 'Капуста белокочанная', bruttoGrams: 80, nettoGrams: 70 },
      { name: 'Морковь', bruttoGrams: 30, nettoGrams: 24 },
      { name: 'Растительное масло', bruttoGrams: 5, nettoGrams: 5 },
      { name: 'Соль', bruttoGrams: 1, nettoGrams: 1 },
    ],
  },
  {
    name: 'Салат "Свежесть"', category: 'SALAD', unit: 'PORTION', portionSize: 100,
    ingredients: [
      { name: 'Огурцы свежие', bruttoGrams: 50, nettoGrams: 45 },
      { name: 'Помидоры', bruttoGrams: 50, nettoGrams: 45 },
      { name: 'Перец болгарский', bruttoGrams: 20, nettoGrams: 16 },
      { name: 'Зелень (укроп/петрушка)', bruttoGrams: 5, nettoGrams: 4 },
      { name: 'Растительное масло', bruttoGrams: 5, nettoGrams: 5 },
      { name: 'Соль', bruttoGrams: 1, nettoGrams: 1 },
    ],
  },
  {
    name: 'Винегрет', category: 'SALAD', unit: 'PORTION', portionSize: 100,
    ingredients: [
      { name: 'Свёкла', bruttoGrams: 40, nettoGrams: 32 },
      { name: 'Картофель', bruttoGrams: 30, nettoGrams: 24 },
      { name: 'Морковь', bruttoGrams: 25, nettoGrams: 20 },
      { name: 'Лук репчатый', bruttoGrams: 15, nettoGrams: 12 },
      { name: 'Растительное масло', bruttoGrams: 6, nettoGrams: 6 },
      { name: 'Соль', bruttoGrams: 1, nettoGrams: 1 },
    ],
  },
  {
    name: 'Салат "Морковный с чесноком"', category: 'SALAD', unit: 'PORTION', portionSize: 100,
    ingredients: [
      { name: 'Морковь', bruttoGrams: 100, nettoGrams: 80 },
      { name: 'Чеснок', bruttoGrams: 4, nettoGrams: 3 },
      { name: 'Сметана', bruttoGrams: 20, nettoGrams: 20 },
      { name: 'Соль', bruttoGrams: 1, nettoGrams: 1 },
    ],
  },
  // ДЕСЕРТЫ
  {
    name: 'Печенье песочное', category: 'DESSERT', unit: 'PORTION', portionSize: 50,
    ingredients: [
      { name: 'Мука пшеничная', bruttoGrams: 30, nettoGrams: 30 },
      { name: 'Сливочное масло', bruttoGrams: 15, nettoGrams: 15 },
      { name: 'Сахар', bruttoGrams: 12, nettoGrams: 12 },
      { name: 'Яйца', bruttoGrams: 0.1, nettoGrams: 0.1 },
    ],
  },
  {
    name: 'Сырник', category: 'DESSERT', unit: 'PORTION', portionSize: 80,
    ingredients: [
      { name: 'Сыр', bruttoGrams: 60, nettoGrams: 60 },
      { name: 'Мука пшеничная', bruttoGrams: 10, nettoGrams: 10 },
      { name: 'Яйца', bruttoGrams: 0.2, nettoGrams: 0.2 },
      { name: 'Сахар', bruttoGrams: 10, nettoGrams: 10 },
      { name: 'Растительное масло', bruttoGrams: 5, nettoGrams: 5 },
    ],
  },
  {
    name: 'Шарлотка яблочная', category: 'DESSERT', unit: 'PORTION', portionSize: 80,
    ingredients: [
      { name: 'Мука пшеничная', bruttoGrams: 25, nettoGrams: 25 },
      { name: 'Яйца', bruttoGrams: 0.5, nettoGrams: 0.5 },
      { name: 'Сахар', bruttoGrams: 20, nettoGrams: 20 },
      { name: 'Сливочное масло', bruttoGrams: 5, nettoGrams: 5 },
    ],
  },
  // НАПИТКИ
  {
    name: 'Компот из сухофруктов', category: 'DRINK', unit: 'PORTION', portionSize: 200,
    ingredients: [
      { name: 'Сухофрукты для компота', bruttoGrams: 30, nettoGrams: 30 },
      { name: 'Сахар', bruttoGrams: 20, nettoGrams: 20 },
    ],
  },
  // ХЛЕБ
  {
    name: 'Хлеб белый', category: 'BREAD_WHITE', unit: 'PIECE', portionSize: 30,
    ingredients: [
      { name: 'Хлеб белый (буханка)', bruttoGrams: 0.05, nettoGrams: 0.05 },
    ],
  },
  {
    name: 'Хлеб чёрный', category: 'BREAD_DARK', unit: 'PIECE', portionSize: 30,
    ingredients: [
      { name: 'Хлеб чёрный (буханка)', bruttoGrams: 0.05, nettoGrams: 0.05 },
    ],
  },
  // ЗАВТРАК
  {
    name: 'Овсяная каша на молоке', category: 'PORRIDGE', unit: 'PORTION', portionSize: 250,
    ingredients: [
      { name: 'Овсянка', bruttoGrams: 50, nettoGrams: 50 },
      { name: 'Молоко', bruttoGrams: 200, nettoGrams: 200 },
      { name: 'Сливочное масло', bruttoGrams: 8, nettoGrams: 8 },
      { name: 'Сахар', bruttoGrams: 10, nettoGrams: 10 },
      { name: 'Соль', bruttoGrams: 1, nettoGrams: 1 },
    ],
  },
  {
    name: 'Омлет', category: 'EGGS', unit: 'PORTION', portionSize: 150,
    ingredients: [
      { name: 'Яйца', bruttoGrams: 2, nettoGrams: 2 },
      { name: 'Молоко', bruttoGrams: 30, nettoGrams: 30 },
      { name: 'Сливочное масло', bruttoGrams: 5, nettoGrams: 5 },
      { name: 'Соль', bruttoGrams: 1, nettoGrams: 1 },
    ],
  },
  // УЖИН
  {
    name: 'Блинчики с творогом', category: 'PANCAKE', unit: 'PIECE', portionSize: 60,
    ingredients: [
      { name: 'Мука пшеничная', bruttoGrams: 15, nettoGrams: 15 },
      { name: 'Молоко', bruttoGrams: 30, nettoGrams: 30 },
      { name: 'Яйца', bruttoGrams: 0.15, nettoGrams: 0.15 },
      { name: 'Сыр', bruttoGrams: 15, nettoGrams: 15 },
      { name: 'Сахар', bruttoGrams: 4, nettoGrams: 4 },
      { name: 'Растительное масло', bruttoGrams: 3, nettoGrams: 3 },
    ],
  },
]

export async function seedDishes(
  prisma: PrismaClient,
  ingredientMap: Map<string, string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  for (const dish of DISHES) {
    // Upsert блюда (по name + category)
    const existing = await prisma.dish.findFirst({
      where: { name: dish.name, category: dish.category },
    })

    let dishId: string
    if (existing) {
      const updated = await prisma.dish.update({
        where: { id: existing.id },
        data: {
          unit: dish.unit,
          portionSize: dish.portionSize,
          isActive: true,
        },
      })
      dishId = updated.id
      // Удалим старые ингредиенты, чтобы пересоздать
      await prisma.dishIngredient.deleteMany({ where: { dishId } })
    } else {
      const created = await prisma.dish.create({
        data: {
          name: dish.name,
          category: dish.category,
          unit: dish.unit,
          portionSize: dish.portionSize,
        },
      })
      dishId = created.id
    }

    // Создаём техкарту
    for (const line of dish.ingredients) {
      const ingredientId = ingredientMap.get(line.name)
      if (!ingredientId) {
        throw new Error(`Ингредиент "${line.name}" не найден для блюда "${dish.name}"`)
      }
      await prisma.dishIngredient.create({
        data: {
          dishId,
          ingredientId,
          bruttoGrams: line.bruttoGrams,
          nettoGrams: line.nettoGrams,
        },
      })
    }

    map.set(dish.name, dishId)
  }

  return map
}
