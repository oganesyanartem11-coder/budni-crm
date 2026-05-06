'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { IngredientForm } from './ingredient-form'
import type { Ingredient } from '@prisma/client'

type SerializedIngredient = Omit<Ingredient, 'pricePerUnit'> & {
  pricePerUnit: number
}

interface Props {
  ingredient?: SerializedIngredient
  open: boolean
  onClose: () => void
}

export function IngredientModal({ ingredient, open, onClose }: Props) {
  // ESC закрывает modal
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  // Блокируем скролл body когда modal открыт
  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-surface border border-border p-6" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-semibold">
            {ingredient ? 'Редактировать ингредиент' : 'Добавить ингредиент'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <IngredientForm
          ingredient={ingredient}
          onSuccess={onClose}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}
