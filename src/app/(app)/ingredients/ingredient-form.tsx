'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTransition } from 'react'
import { toast } from 'sonner'
import { createIngredient, updateIngredient } from './actions'
import { cn } from '@/lib/utils/cn'
import type { Ingredient } from '@prisma/client'

const formSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(100),
  unit: z.enum(['KG', 'L', 'PCS']),
  pricePerUnit: z.number().nonnegative('Цена не может быть отрицательной'),
  notes: z.string().max(500).optional().nullable(),
})

type FormValues = z.infer<typeof formSchema>

type SerializedIngredient = Omit<Ingredient, 'pricePerUnit'> & {
  pricePerUnit: number
}

interface Props {
  ingredient?: SerializedIngredient
  onSuccess: () => void
  onCancel: () => void
}

export function IngredientForm({ ingredient, onSuccess, onCancel }: Props) {
  const [isPending, startTransition] = useTransition()

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: ingredient?.name ?? '',
      unit: (ingredient?.unit as 'KG' | 'L' | 'PCS') ?? 'KG',
      pricePerUnit: ingredient?.pricePerUnit ?? 0,
      notes: ingredient?.notes ?? '',
    },
  })

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const action = ingredient
        ? () => updateIngredient(ingredient.id, values)
        : () => createIngredient(values)

      const result = await action()

      if (result.ok) {
        toast.success(ingredient ? 'Ингредиент обновлён' : 'Ингредиент добавлен')
        onSuccess()
      } else {
        toast.error(result.error)
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              form.setError(field as keyof FormValues, { message: messages[0] })
            }
          }
        }
      }
    })
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="name" className="text-sm font-medium">Название</label>
        <input
          id="name"
          type="text"
          autoFocus
          {...form.register('name')}
          className={cn(
            'w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors',
            form.formState.errors.name && 'border-danger'
          )}
        />
        {form.formState.errors.name && (
          <p className="text-xs text-danger">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="unit" className="text-sm font-medium">Единица</label>
          <select
            id="unit"
            {...form.register('unit')}
            className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent"
          >
            <option value="KG">килограммы (кг)</option>
            <option value="L">литры (л)</option>
            <option value="PCS">штуки (шт)</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="pricePerUnit" className="text-sm font-medium">
            Цена, ₽ за единицу
          </label>
          <input
            id="pricePerUnit"
            type="number"
            min="0"
            step="0.01"
            {...form.register('pricePerUnit', { valueAsNumber: true })}
            className={cn(
              'w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors',
              form.formState.errors.pricePerUnit && 'border-danger'
            )}
          />
          {form.formState.errors.pricePerUnit && (
            <p className="text-xs text-danger">{form.formState.errors.pricePerUnit.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="notes" className="text-sm font-medium">Заметки</label>
        <textarea
          id="notes"
          rows={2}
          {...form.register('notes')}
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors resize-none"
          placeholder="Опционально"
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending ? 'Сохраняем…' : ingredient ? 'Сохранить' : 'Добавить'}
        </button>
      </div>
    </form>
  )
}
