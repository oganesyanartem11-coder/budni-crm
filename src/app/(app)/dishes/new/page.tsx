import { PageHeader } from '@/components/layout/page-header'
import { DishForm } from '../dish-form'
import { requireRole } from '@/lib/auth/current-user'
import { listActiveIngredientsLight } from '@/lib/db/queries/ingredients'
import { serialize } from '@/lib/utils/serialize'

export default async function NewDishPage() {
  await requireRole(['ADMIN', 'CHEF'])

  const ingredients = serialize(await listActiveIngredientsLight())

  return (
    <>
      <PageHeader
        title="Новое блюдо"
        subtitle="Заполните основные поля и техкарту"
      />
      <DishForm ingredients={ingredients} />
    </>
  )
}
