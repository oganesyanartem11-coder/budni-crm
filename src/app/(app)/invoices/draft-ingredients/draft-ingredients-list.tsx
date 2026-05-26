'use client'

import type { IngredientUnit } from '@prisma/client'
import { DraftIngredientCard } from './draft-ingredient-card'

export interface DraftIngredient {
  id: string
  name: string
  unit: IngredientUnit
  pricePerUnit: number
  brandVariants: unknown
  invoiceLines: Array<{
    invoice: { id: string; supplierName: string; invoiceDate: Date | string }
  }>
  _count: { dishIngredients: number }
}

export interface ApprovedOption {
  id: string
  name: string
  unit: IngredientUnit
}

export function DraftIngredientsList({
  drafts,
  approved,
}: {
  drafts: DraftIngredient[]
  approved: ApprovedOption[]
}) {
  if (drafts.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center">
        <p className="text-fg-muted">Нет ингредиентов на утверждение</p>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {drafts.map((d) => (
        <DraftIngredientCard key={d.id} draft={d} approvedOptions={approved} />
      ))}
    </div>
  )
}
