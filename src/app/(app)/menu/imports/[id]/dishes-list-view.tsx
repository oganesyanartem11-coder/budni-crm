'use client'

import { useState, useMemo, useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  Search,
  Sparkles,
  AlertTriangle,
  X,
  Plus,
  Loader2,
} from 'lucide-react'
import type { DishCategory, DishUnit } from '@prisma/client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DISH_CATEGORY_LABELS,
  DISH_UNIT_LABELS,
} from '@/lib/constants/dish-categories'
import {
  CORRECTION_LEVEL_COLORS,
  CORRECTION_LEVEL_LABELS,
} from '@/lib/menu-import/category-labels'
import {
  findDuplicateCandidates,
  type DuplicateGroup,
} from '@/lib/menu-import/find-duplicates'
import { cn } from '@/lib/utils/cn'
import { updateDishIngredients, deleteDishFromImport } from '../actions'
import { MergeDishDialog } from './merge-dish-dialog'
import type { AllIngredient } from './import-view'

export interface SerializedDish {
  id: string
  name: string
  correctedName: string | null
  originalName: string | null
  correctionLevel: string | null
  correctionNote: string | null
  category: DishCategory
  unit: DishUnit
  portionSize: number | null
  ingredients: Array<{
    id: string
    bruttoGrams: number
    nettoGrams: number
    ingredient: { id: string; name: string; unit: string }
  }>
}

type LevelFilter = 'all' | 'corrections' | 'critical'

interface Props {
  dishes: SerializedDish[]
  allIngredients: AllIngredient[]
  canEdit: boolean
  expandedDishId: string | null
  onExpandedChange: (id: string | null) => void
}

export function DishesListView({
  dishes,
  allIngredients,
  canEdit,
  expandedDishId,
  onExpandedChange,
}: Props) {
  const [filter, setFilter] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [mergeSource, setMergeSource] = useState<SerializedDish | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [search])

  const duplicateGroups = useMemo(() => findDuplicateCandidates(dishes), [dishes])
  const totalCount = dishes.length
  const correctionsCount = useMemo(
    () => dishes.filter((d) => d.correctionLevel && d.correctionLevel !== 'none').length,
    [dishes]
  )

  const visible = useMemo(() => {
    return dishes.filter((d) => {
      if (filter === 'corrections') {
        if (!d.correctionLevel || d.correctionLevel === 'none') return false
      } else if (filter === 'critical') {
        if (d.correctionLevel !== 'critical') return false
      }
      if (debouncedSearch) {
        const haystack = `${d.correctedName ?? d.name} ${d.originalName ?? ''}`.toLowerCase()
        if (!haystack.includes(debouncedSearch)) return false
      }
      return true
    })
  }, [dishes, filter, debouncedSearch])

  return (
    <div className="space-y-4">
      {duplicateGroups.length > 0 && (
        <DuplicatesBanner
          groups={duplicateGroups}
          open={duplicatesOpen}
          onToggle={() => setDuplicatesOpen((v) => !v)}
          onDishClick={(id) => onExpandedChange(id)}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-fg-muted">
          Всего: <span className="font-medium text-fg">{totalCount}</span>
          {correctionsCount > 0 && (
            <>
              {' · '}
              <span className="inline-flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-fg-subtle" />
                С AI-правками:{' '}
                <span className="font-medium text-fg">{correctionsCount}</span>
              </span>
            </>
          )}
        </div>

        <div className="inline-flex p-1 rounded-pill bg-surface border border-border">
          {(['all', 'corrections', 'critical'] as LevelFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1 rounded-pill text-xs font-medium transition-colors',
                filter === f ? 'bg-fg text-bg' : 'text-fg-muted hover:text-fg'
              )}
            >
              {f === 'all' && 'Все'}
              {f === 'corrections' && 'С правками'}
              {f === 'critical' && 'Critical'}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по названию"
          className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface border border-border focus:border-fg/30 focus:outline-none transition-colors"
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-fg-muted text-center">
          Ничего не найдено.
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((dish) => (
            <DishCard
              key={dish.id}
              dish={dish}
              allIngredients={allIngredients}
              canEdit={canEdit}
              expanded={expandedDishId === dish.id}
              onToggle={() =>
                onExpandedChange(expandedDishId === dish.id ? null : dish.id)
              }
              onRequestMerge={() => setMergeSource(dish)}
            />
          ))}
        </ul>
      )}

      <MergeDishDialog
        open={mergeSource !== null}
        onClose={() => setMergeSource(null)}
        source={mergeSource}
        allDishes={dishes}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────────
// DuplicatesBanner — collapsible плашка возможных дублей.
// ────────────────────────────────────────────────────────────────────────────────

function DuplicatesBanner({
  groups,
  open,
  onToggle,
  onDishClick,
}: {
  groups: DuplicateGroup[]
  open: boolean
  onToggle: () => void
  onDishClick: (dishId: string) => void
}) {
  return (
    <div className="rounded-2xl border border-warning/30 bg-warning/5 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-warning/10 transition-colors"
      >
        <AlertTriangle className="w-5 h-5 text-warning-fg shrink-0" />
        <div className="flex-1 text-sm">
          <p className="font-medium text-fg">
            AI нашёл {groups.length} {pluralDuplicate(groups.length)} — проверьте перед утверждением
          </p>
          <p className="text-xs text-fg-muted">
            {open ? 'Кликните чтобы скрыть' : 'Кликните чтобы развернуть'}
          </p>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-fg-subtle shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-fg-subtle shrink-0" />
        )}
      </button>
      {open && (
        <div className="border-t border-warning/30 p-4 space-y-3 bg-warning/5">
          {groups.map((g) => (
            <div key={g.key}>
              <p className="text-xs text-fg-muted mb-1.5">{g.reason}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.dishes.map((d) => {
                  const color = d.correctionLevel
                    ? CORRECTION_LEVEL_COLORS[d.correctionLevel]
                    : undefined
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => onDishClick(d.id)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-fg bg-fg/5 hover:bg-fg/10"
                    >
                      {color && (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                      )}
                      {d.correctedName}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────────
// DishCard — карточка блюда: collapsed, expanded (просмотр), expanded (правки).
// ────────────────────────────────────────────────────────────────────────────────

interface EditableLine {
  // Используем nano-key для React, ingredientId — для server action.
  key: string
  ingredientId: string
  ingredientName: string
  ingredientUnit: string
  nettoGrams: number
}

function DishCard({
  dish,
  allIngredients,
  canEdit,
  expanded,
  onToggle,
  onRequestMerge,
}: {
  dish: SerializedDish
  allIngredients: AllIngredient[]
  canEdit: boolean
  expanded: boolean
  onToggle: () => void
  onRequestMerge: () => void
}) {
  const ref = useRef<HTMLLIElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditableLine[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const displayName = dish.correctedName ?? dish.name
  const levelColor = dish.correctionLevel ? CORRECTION_LEVEL_COLORS[dish.correctionLevel] : undefined
  const hasCorrection = dish.correctionLevel && dish.correctionLevel !== 'none'
  const nameDiffers =
    hasCorrection && dish.originalName && dish.originalName !== dish.correctedName

  useEffect(() => {
    if (expanded && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [expanded])

  function startEdit() {
    setDraft(
      dish.ingredients.map((line) => ({
        key: `${line.id}`,
        ingredientId: line.ingredient.id,
        ingredientName: line.ingredient.name,
        ingredientUnit: line.ingredient.unit,
        nettoGrams: Math.round(line.nettoGrams),
      }))
    )
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setDraft([])
  }

  function setLineGrams(idx: number, value: number) {
    setDraft((d) => d.map((l, i) => (i === idx ? { ...l, nettoGrams: value } : l)))
  }

  function removeLine(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx))
  }

  function addLine(ing: AllIngredient) {
    if (draft.some((l) => l.ingredientId === ing.id)) {
      toast.info('Ингредиент уже в составе — изменяйте его граммовку')
      return
    }
    setDraft((d) => [
      ...d,
      {
        key: `new-${ing.id}-${Date.now()}`,
        ingredientId: ing.id,
        ingredientName: ing.name,
        ingredientUnit: ing.unit,
        nettoGrams: 0,
      },
    ])
  }

  function save() {
    // Защита: все nettoGrams >= 0
    const invalid = draft.find((l) => l.nettoGrams < 0 || l.nettoGrams > 10000)
    if (invalid) {
      toast.error(`Граммовка «${invalid.ingredientName}» вне диапазона 0–10000`)
      return
    }
    startTransition(async () => {
      const r = await updateDishIngredients({
        dishId: dish.id,
        ingredients: draft.map((l) => ({
          ingredientId: l.ingredientId,
          nettoGrams: l.nettoGrams,
        })),
      })
      if (r.ok) {
        toast.success('Состав сохранён')
        setEditing(false)
        setDraft([])
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  function onDelete() {
    startTransition(async () => {
      const r = await deleteDishFromImport({ dishId: dish.id })
      if (r.ok) {
        toast.success(
          r.data.menuDayDishesRemoved > 0
            ? `Удалено: блюдо и ${r.data.menuDayDishesRemoved} связей в меню`
            : 'Блюдо удалено'
        )
        setConfirmDelete(false)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  // Если редактируется — клик на заголовок не закрывает карточку.
  function handleToggle() {
    if (editing) return
    onToggle()
  }

  return (
    <li
      ref={ref}
      className="bg-surface border border-border rounded-2xl overflow-hidden"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          'w-full text-left p-4 transition-colors flex items-center gap-3',
          editing ? 'cursor-default' : 'hover:bg-fg/5'
        )}
      >
        {levelColor && (
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: levelColor }}
            aria-label="AI правка"
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fg truncate">{displayName}</p>
          <p className="text-xs text-fg-muted">
            {DISH_CATEGORY_LABELS[dish.category]} ·{' '}
            {DISH_UNIT_LABELS[dish.unit]}
            {dish.portionSize ? ` · ${dish.portionSize} г` : ''}
          </p>
        </div>
        <span className="text-xs text-fg-subtle shrink-0">
          {(editing ? draft.length : dish.ingredients.length)} ингр.
        </span>
        {!editing && (
          expanded ? (
            <ChevronUp className="w-4 h-4 text-fg-subtle shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-fg-subtle shrink-0" />
          )
        )}
      </button>

      {expanded && (
        <div className="border-t border-border p-4 space-y-4 bg-bg">
          {hasCorrection && (
            <div className="rounded-xl bg-fg/5 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: levelColor }}
                />
                <span className="text-xs font-medium text-fg">
                  AI правка: {CORRECTION_LEVEL_LABELS[dish.correctionLevel!] ?? dish.correctionLevel}
                </span>
              </div>
              {nameDiffers && (
                <p className="text-xs text-fg-muted">
                  Исходное имя: <span className="text-fg">«{dish.originalName}»</span>
                </p>
              )}
              {dish.correctionNote && (
                <p className="text-xs text-fg-muted">{dish.correctionNote}</p>
              )}
            </div>
          )}

          {editing ? (
            <EditingComposition
              draft={draft}
              allIngredients={allIngredients}
              pending={pending}
              onChangeGrams={setLineGrams}
              onRemove={removeLine}
              onAdd={addLine}
              onSave={save}
              onCancel={cancelEdit}
            />
          ) : (
            <ViewComposition dish={dish} />
          )}

          {canEdit && !editing && (
            <div className="flex flex-wrap gap-2 pt-2">
              <ActionButton onClick={startEdit}>Редактировать состав</ActionButton>
              <ActionButton onClick={onRequestMerge}>Слить с другим блюдом</ActionButton>
              <ActionButton onClick={() => setConfirmDelete(true)} danger>
                Удалить из импорта
              </ActionButton>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить блюдо «{displayName}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Блюдо будет удалено из импорта, все связи в меню-расписании этого блюда тоже исчезнут.
              Действие необратимо.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={onDelete} disabled={pending}>
                {pending ? 'Удаляю…' : 'Удалить'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

function ViewComposition({ dish }: { dish: SerializedDish }) {
  return (
    <div>
      <p className="text-xs text-fg-subtle mb-2 uppercase tracking-wider">
        Состав ({dish.ingredients.length})
      </p>
      <ul className="space-y-1">
        {dish.ingredients.map((line) => (
          <li
            key={line.id}
            className="flex items-baseline justify-between gap-3 text-sm py-1 border-b border-border/40 last:border-b-0"
          >
            <span className="text-fg">{line.ingredient.name}</span>
            <span className="text-fg-muted tabular-nums shrink-0">
              {Math.round(line.nettoGrams)} г
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EditingComposition({
  draft,
  allIngredients,
  pending,
  onChangeGrams,
  onRemove,
  onAdd,
  onSave,
  onCancel,
}: {
  draft: EditableLine[]
  allIngredients: AllIngredient[]
  pending: boolean
  onChangeGrams: (idx: number, value: number) => void
  onRemove: (idx: number) => void
  onAdd: (ing: AllIngredient) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-subtle uppercase tracking-wider">
        Состав — редактирование ({draft.length})
      </p>
      <ul className="space-y-1.5">
        {draft.map((line, idx) => (
          <li key={line.key} className="flex items-center gap-2 py-1">
            <span className="flex-1 text-sm text-fg truncate">{line.ingredientName}</span>
            <input
              type="number"
              value={line.nettoGrams}
              onChange={(e) => onChangeGrams(idx, Number(e.target.value) || 0)}
              min={0}
              max={10000}
              step={1}
              disabled={pending}
              className="w-24 px-2 py-1 text-sm rounded-md bg-surface border border-border focus:border-fg/30 focus:outline-none text-right tabular-nums"
            />
            <span className="text-xs text-fg-subtle w-4">г</span>
            <button
              type="button"
              onClick={() => onRemove(idx)}
              disabled={pending}
              className="p-1 rounded-md hover:bg-danger/10 text-fg-subtle hover:text-danger"
              aria-label="Удалить ингредиент"
            >
              <X className="w-4 h-4" />
            </button>
          </li>
        ))}
      </ul>

      {pickerOpen ? (
        <IngredientPicker
          allIngredients={allIngredients}
          excludeIds={draft.map((l) => l.ingredientId)}
          onPick={(ing) => {
            onAdd(ing)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={pending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border text-xs text-fg-muted hover:bg-fg/5"
        >
          <Plus className="w-3.5 h-3.5" />
          Добавить ингредиент
        </button>
      )}

      <div className="flex gap-2 pt-2">
        <Button onClick={onSave} disabled={pending} size="sm">
          {pending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
          {pending ? 'Сохраняю…' : 'Сохранить'}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={pending} size="sm">
          Отмена
        </Button>
      </div>
    </div>
  )
}

function IngredientPicker({
  allIngredients,
  excludeIds,
  onPick,
  onClose,
}: {
  allIngredients: AllIngredient[]
  excludeIds: string[]
  onPick: (ing: AllIngredient) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const exclude = new Set(excludeIds)
    const query = q.trim().toLowerCase()
    return allIngredients
      .filter((i) => !exclude.has(i.id))
      .filter((i) => !query || i.name.toLowerCase().includes(query))
      .slice(0, 50) // ограничим размер списка для скорости рендера
  }, [allIngredients, excludeIds, q])

  return (
    <div className="rounded-xl border border-border bg-surface p-2 space-y-2">
      <div className="flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-fg-subtle ml-1" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Найти ингредиент…"
          autoFocus
          className="flex-1 px-2 py-1 text-sm bg-transparent focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md hover:bg-fg/5 text-fg-subtle"
          aria-label="Закрыть"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <ul className="max-h-48 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-2 py-3 text-xs text-fg-subtle text-center">Не найдено</li>
        ) : (
          filtered.map((ing) => (
            <li key={ing.id}>
              <button
                type="button"
                onClick={() => onPick(ing)}
                className="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-fg/5 text-fg"
              >
                {ing.name}{' '}
                <span className="text-xs text-fg-subtle">({ing.unit})</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function ActionButton({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-pill border text-xs transition-colors',
        danger
          ? 'border-danger/30 text-danger hover:bg-danger/5'
          : 'border-border text-fg-muted hover:text-fg hover:bg-fg/5'
      )}
    >
      {children}
    </button>
  )
}

function pluralDuplicate(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'возможный дубль'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'возможных дубля'
  return 'возможных дублей'
}
