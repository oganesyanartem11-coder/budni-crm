import { PageHeader } from '@/components/layout/page-header'
import { DishForm } from '../dish-form'
import { requireRole } from '@/lib/auth/current-user'
import { listActiveIngredientsLight } from '@/lib/db/queries/ingredients'
import { serialize } from '@/lib/utils/serialize'

export default async function NewDishPage() {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const ingredients = serialize(await listActiveIngredientsLight())
  const canSeePrices = user.role !== 'CHEF'

  // Defense-in-depth: для CHEF зануляем цены ингредиентов в техкарте,
  // чтобы live-калькуляция возвращала 0 (UI всё равно её скрывает).
  const safeIngredients = canSeePrices
    ? ingredients
    : ingredients.map((ing) => ({ ...ing, pricePerUnit: 0 }))

  return (
    <>
      <PageHeader
        title="Новое блюдо"
        subtitle="Заполните основные поля и техкарту"
      />
      <DishForm ingredients={safeIngredients} canSeePrices={canSeePrices} />
    </>
  )
}
