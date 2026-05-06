'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Trash2, ArrowLeft, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { createDish, updateDish, deleteDish, getDishUsage } from './actions'
import {
  DISH_CATEGORY_LABELS,
  DISH_CATEGORY_ORDER,
  DISH_UNIT_LABELS,
  INGREDIENT_UNIT_LABELS,
} from '@/lib/constants/dish-categories'
import { calculateDishCost } from '@/lib/utils/dish-cost'
import { formatMoney } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { Dish, DishCategory, DishIngredient, Ingredient, DishUnit, IngredientUnit } from '@prisma/client'

type SerializedIngredient = {
  id: string
  name: string
  unit: IngredientUnit
  pricePerUnit: number
}

type SerializedDishWithIngredients = Omit<Dish, never> & {
  ingredients: Array<{
    id: string
    ingredientId: string
    bruttoGrams: number
    nettoGrams: number
    ingredient: SerializedIngredient
  }>
}

interface IngredientLine {
  // временный id для key в React (не отправляется на сервер)
  key: string
  ingredientId: string
  bruttoGrams: number
  nettoGrams: number
}

interface Props {
  dish?: SerializedDishWithIngredients
  ingredients: SerializedIngredient[]
}

export function DishForm({ dish, ingredients }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [deletePending, startDelete] = useTransition()

  const [name, setName] = useState(dish?.name ?? '')
  const [category, setCategory] = useState<DishCategory>(dish?.category ?? 'MAIN')
  const [unit, setUnit] = useState<DishUnit>(dish?.unit ?? 'PORTION')
  const [portionSize, setPortionSize] = useState<string>(
    dish?.portionSize?.toString() ?? ''
  )
  const [notes, setNotes] = useState<string>(dish?.notes ?? '')

  const [lines, setLines] = useState<IngredientLine[]>(() => {
    if (dish) {
      return dish.ingredients.map((line) => ({
        key: line.id,
        ingredientId: line.ingredientId,
        bruttoGrams: line.bruttoGrams,
        nettoGrams: line.nettoGrams,
      }))
    }
    return [{ key: crypto.randomUUID(), ingredientId: '', bruttoGrams: 0, nettoGrams: 0 }]
  })

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteUsage, setDeleteUsage] = useState<Awaited<ReturnType<typeof getDishUsage>> | null>(null)

  // Live-расчёт себестоимости
  const cost = useMemo(() => {
    const validLines = lines
      .filter((l) => l.ingredientId && l.bruttoGrams > 0)
      .map((l) => {
        const ing = ingredients.find((i) => i.id === l.ingredientId)
        if (!ing) return null
        return {
          bruttoGrams: l.bruttoGrams,
          ingredient: {
            pricePerUnit: ing.pricePerUnit,
            unit: ing.unit,
          },
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null)

    return calculateDishCost(validLines)
  }, [lines, ingredients])

  function addLine() {
    setLines((prev) => [
      ...prev,
      { key: crypto.randomUUID(), ingredientId: '', bruttoGrams: 0, nettoGrams: 0 },
    ])
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key))
  }

  function updateLine(key: string, patch: Partial<IngredientLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!name.trim()) e.name = 'Название обязательно'
    if (lines.length === 0) e.ingredients = 'Добавьте хотя бы один ингредиент'

    lines.forEach((line, i) => {
      if (!line.ingredientId) e[`line-${i}-ingredient`] = 'Выберите ингредиент'
      if (line.bruttoGrams <= 0) e[`line-${i}-brutto`] = 'Брутто > 0'
      if (line.nettoGrams < 0) e[`line-${i}-netto`] = 'Нетто >= 0'
      if (line.nettoGrams > line.bruttoGrams) {
        e[`line-${i}-netto`] = 'Нетто не больше брутто'
      }
    })

    // Дубликаты ингредиентов
    const ingIds = lines.map((l) => l.ingredientId).filter(Boolean)
    const dupes = ingIds.filter((id, i) => ingIds.indexOf(id) !== i)
    if (dupes.length > 0) {
      e.duplicates = 'Один ингредиент не может быть добавлен дважды'
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) {
      toast.error('Проверьте поля формы')
      return
    }

    startTransition(async () => {
      const data = {
        name: name.trim(),
        category,
        unit,
        portionSize: portionSize ? parseInt(portionSize, 10) : null,
        notes: notes.trim() || null,
        ingredients: lines.map((l) => ({
          ingredientId: l.ingredientId,
          bruttoGrams: l.bruttoGrams,
          nettoGrams: l.nettoGrams,
        })),
      }

      const result = dish
        ? await updateDish(dish.id, data)
        : await createDish(data)

      if (result.ok) {
        toast.success(dish ? 'Блюдо обновлено' : 'Блюдо создано')
        router.push('/dishes')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  async function handleDeleteClick() {
    if (!dish) return
    const usage = await getDishUsage(dish.id)
    setDeleteUsage(usage)
    setShowDeleteDialog(true)
  }

  function confirmDelete() {
    if (!dish) return
    startDelete(async () => {
      const result = await deleteDish(dish.id, true)
      if (result.ok) {
        toast.success('Блюдо удалено')
        router.push('/dishes')
        router.refresh()
      } else {
        toast.error(result.error)
        setShowDeleteDialog(false)
      }
    })
  }

  return (
    <>
      <div className="mb-6">
        <Link
          href="/dishes"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Все блюда
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Основная информация */}
        <div className="rounded-2xl bg-surface border border-border p-6 space-y-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h2 className="text-lg font-semibold">Основное</h2>

          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">Название</label>
            <input
              id="name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(
                'w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors',
                errors.name && 'border-danger'
              )}
            />
            {errors.name && <p className="text-xs text-danger">{errors.name}</p>}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="category" className="text-sm font-medium">Категория</label>
              <select
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value as DishCategory)}
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
              >
                {DISH_CATEGORY_ORDER.map((cat) => (
                  <option key={cat} value={cat}>
                    {DISH_CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="unit" className="text-sm font-medium">Базовая единица</label>
              <select
                id="unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value as DishUnit)}
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
              >
                <option value="PORTION">порция</option>
                <option value="LITER">литр</option>
                <option value="KG">килограмм</option>
                <option value="PIECE">штука</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="portionSize" className="text-sm font-medium">
                Размер порции, {unit === 'LITER' ? 'мл' : unit === 'KG' ? 'г' : 'г/шт'}
              </label>
              <input
                id="portionSize"
                type="number"
                min="0"
                step="1"
                value={portionSize}
                onChange={(e) => setPortionSize(e.target.value)}
                placeholder="Опционально"
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="notes" className="text-sm font-medium">Заметки</label>
            <textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Опционально"
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors resize-none"
            />
          </div>
        </div>

        {/* Техкарта */}
        <div className="rounded-2xl bg-surface border border-border p-6 space-y-4" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Техкарта</h2>
              <p className="text-xs text-fg-muted mt-0.5">
                {unit === 'PORTION' && 'Расчёт на 1 порцию'}
                {unit === 'LITER' && 'Расчёт на 1 литр'}
                {unit === 'KG' && 'Расчёт на 1 кг'}
                {unit === 'PIECE' && 'Расчёт на 1 штуку'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-fg-muted">Себестоимость</p>
              <p className="text-xl font-bold tabular-nums">
                {formatMoney(cost, { withKopecks: true })}
              </p>
            </div>
          </div>

          {errors.duplicates && (
            <div className="rounded-xl bg-danger-bg text-danger-fg px-3 py-2 text-sm">
              {errors.duplicates}
            </div>
          )}

          <div className="space-y-2">
            {lines.map((line, i) => {
              const ing = ingredients.find((x) => x.id === line.ingredientId)
              return (
                <IngredientRow
                  key={line.key}
                  index={i}
                  line={line}
                  ingredient={ing}
                  ingredients={ingredients}
                  onUpdate={(patch) => updateLine(line.key, patch)}
                  onRemove={() => removeLine(line.key)}
                  errors={errors}
                  canRemove={lines.length > 1}
                />
              )
            })}
          </div>

          <button
            type="button"
            onClick={addLine}
            className="w-full px-4 py-2.5 rounded-xl border-2 border-dashed border-border text-fg-muted hover:border-border-strong hover:text-fg transition-colors flex items-center justify-center gap-2 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Добавить ингредиент
          </button>

          {errors.ingredients && (
            <p className="text-xs text-danger">{errors.ingredients}</p>
          )}
        </div>

        {/* Кнопки управления */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            {dish && (
              <button
                type="button"
                onClick={handleDeleteClick}
                disabled={isPending || deletePending}
                className="px-4 py-2.5 rounded-pill text-danger-fg bg-danger-bg hover:bg-danger hover:text-accent-fg transition-colors text-sm font-medium flex items-center gap-2 disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                Удалить
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dishes"
              className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors"
            >
              Отмена
            </Link>
            <button
              type="submit"
              disabled={isPending}
              className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isPending ? 'Сохраняем…' : dish ? 'Сохранить' : 'Создать блюдо'}
            </button>
          </div>
        </div>
      </form>

      {/* Диалог удаления */}
      {showDeleteDialog && dish && deleteUsage && (
        <DeleteDialog
          dishName={dish.name}
          usage={deleteUsage}
          onConfirm={confirmDelete}
          onCancel={() => setShowDeleteDialog(false)}
          isPending={deletePending}
        />
      )}
    </>
  )
}

function IngredientRow({
  index,
  line,
  ingredient,
  ingredients,
  onUpdate,
  onRemove,
  errors,
  canRemove,
}: {
  index: number
  line: IngredientLine
  ingredient: SerializedIngredient | undefined
  ingredients: SerializedIngredient[]
  onUpdate: (patch: Partial<IngredientLine>) => void
  onRemove: () => void
  errors: Record<string, string>
  canRemove: boolean
}) {
  const lineCost = useMemo(() => {
    if (!ingredient || line.bruttoGrams <= 0) return 0
    if (ingredient.unit === 'PCS') {
      return line.bruttoGrams * ingredient.pricePerUnit
    }
    return (line.bruttoGrams / 1000) * ingredient.pricePerUnit
  }, [ingredient, line.bruttoGrams])

  const unitSuffix = ingredient
    ? ingredient.unit === 'PCS' ? 'шт' : ingredient.unit === 'L' ? 'мл' : 'г'
    : 'г'

  return (
    <div className="grid grid-cols-12 gap-2 items-start bg-bg/40 rounded-xl p-2.5">
      {/* Ингредиент */}
      <div className="col-span-12 md:col-span-5">
        <select
          value={line.ingredientId}
          onChange={(e) => onUpdate({ ingredientId: e.target.value })}
          className={cn(
            'w-full px-3 py-2 rounded-lg bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm',
            errors[`line-${index}-ingredient`] && 'border-danger'
          )}
        >
          <option value="">— выберите ингредиент —</option>
          {ingredients.map((ing) => (
            <option key={ing.id} value={ing.id}>
              {ing.name} ({INGREDIENT_UNIT_LABELS[ing.unit]})
            </option>
          ))}
        </select>
      </div>

      {/* Брутто */}
      <div className="col-span-5 md:col-span-3">
        <div className="relative">
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Брутто"
            value={line.bruttoGrams || ''}
            onChange={(e) => onUpdate({ bruttoGrams: parseFloat(e.target.value) || 0 })}
            className={cn(
              'w-full px-3 py-2 pr-9 rounded-lg bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm tabular-nums',
              errors[`line-${index}-brutto`] && 'border-danger'
            )}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle pointer-events-none">
            {unitSuffix}
          </span>
        </div>
      </div>

      {/* Нетто */}
      <div className="col-span-5 md:col-span-3">
        <div className="relative">
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Нетто"
            value={line.nettoGrams || ''}
            onChange={(e) => onUpdate({ nettoGrams: parseFloat(e.target.value) || 0 })}
            className={cn(
              'w-full px-3 py-2 pr-9 rounded-lg bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm tabular-nums',
              errors[`line-${index}-netto`] && 'border-danger'
            )}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle pointer-events-none">
            {unitSuffix}
          </span>
        </div>
      </div>

      {/* Удалить */}
      <div className="col-span-2 md:col-span-1 flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Удалить ингредиент"
          className="w-9 h-9 rounded-full hover:bg-danger-bg hover:text-danger-fg text-fg-muted flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Цена строки */}
      {ingredient && line.bruttoGrams > 0 && (
        <div className="col-span-12 text-xs text-fg-subtle text-right tabular-nums">
          {formatMoney(lineCost, { withKopecks: true })} в этой строке
        </div>
      )}
    </div>
  )
}

function DeleteDialog({
  dishName,
  usage,
  onConfirm,
  onCancel,
  isPending,
}: {
  dishName: string
  usage: Awaited<ReturnType<typeof getDishUsage>>
  onConfirm: () => void
  onCancel: () => void
  isPending: boolean
}) {
  const STATUS_LABELS: Record<string, string> = {
    DRAFT: 'Черновик',
    APPROVED: 'Утверждено',
    ARCHIVED: 'Архив',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-surface border border-border p-6" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-warning-bg text-warning-fg flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Удалить «{dishName}»?</h2>
            <p className="text-sm text-fg-muted mt-1">
              Действие нельзя отменить.
            </p>
          </div>
        </div>

        {usage.menuCount > 0 && (
          <div className="mb-5 rounded-xl bg-warning-bg/50 border border-warning/20 px-4 py-3">
            <p className="text-sm text-warning-fg font-medium mb-2">
              Блюдо используется в {usage.menuCount}{' '}
              {usage.menuCount === 1 ? 'меню' : 'меню'}:
            </p>
            <ul className="space-y-1 text-sm text-warning-fg/80">
              {usage.menus.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{m.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-warning-bg shrink-0">
                    {STATUS_LABELS[m.status] ?? m.status}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-warning-fg/70 mt-2">
              Блюдо будет удалено из этих меню. История заказов сохранится.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill bg-danger text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isPending ? 'Удаляем…' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  )
}
