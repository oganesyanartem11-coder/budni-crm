'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Plus,
  Check,
  Clock,
  Send,
  Archive,
  Undo2,
  AlertCircle,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { StatusBadge } from '@/components/ui/status-badge'
import { DayEditor } from './day-editor'
import {
  createDraftMenu,
  submitMenuForApproval,
  approveMenu,
  rejectMenu,
  unapproveMenu,
  archiveMenu,
} from './actions'
import {
  formatWeekRange,
  shiftWeek,
  isCurrentWeek,
  WEEKDAY_NAMES_SHORT,
  WEEKDAY_NAMES_FULL,
  getDateForDayOfWeek,
} from '@/lib/utils/week'
import { MENU_STATUS_LABELS, MENU_STATUS_VARIANT } from '@/lib/constants/menu-status'
import { DISH_CATEGORY_ICONS } from '@/lib/constants/dish-categories'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils/cn'
import type { Dish, MealType, DishCategory, UserRole, MenuStatus } from '@prisma/client'

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
}

const MEAL_TYPE_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

const REJECT_COMMENT_MAX = 500

interface MenuDayDish {
  id: string
  dishId: string
  slotCategory: DishCategory
  dish: Dish
}

interface MealSetItemData {
  dishCategory: DishCategory
  quantity: number
}

interface MenuDayData {
  id: string
  dayOfWeek: number
  mealType: MealType
  mealSet: {
    id: string
    name: string
    items: MealSetItemData[]
  } | null
  dishes: MenuDayDish[]
}

interface MenuData {
  id: string
  name: string
  validFrom: Date
  validTo: Date
  status: MenuStatus
  approvedAt: Date | null
  approvedBy: { id: string; name: string } | null
  rejectionComment: string | null
  days: MenuDayData[]
}

interface Props {
  weekStartIso: string
  menu: MenuData | null
  dishes: Dish[]
  userRole: UserRole
  previewImportId: string | null
}

export function MenuView({ weekStartIso, menu, dishes, userRole, previewImportId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editingDay, setEditingDay] = useState<MenuDayData | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectComment, setRejectComment] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [unapproveOpen, setUnapproveOpen] = useState(false)

  const monday = new Date(weekStartIso)
  const isCurrent = isCurrentWeek(monday)
  const canEdit = userRole === 'ADMIN' || userRole === 'CHEF'
  const isAdmin = userRole === 'ADMIN'
  const isChef = userRole === 'CHEF'
  const isEditable = !!menu && menu.status === 'DRAFT' && canEdit

  function navigateWeek(weeks: number) {
    const newWeek = shiftWeek(monday, weeks)
    router.push(`/menu?week=${newWeek.toISOString()}`)
  }

  function navigateToToday() {
    router.push('/menu')
  }

  function handleCreateDraft() {
    startTransition(async () => {
      const result = await createDraftMenu(monday.toISOString())
      if (result.ok) {
        toast.success('Черновик меню создан')
        router.refresh()
      } else if (result.importId) {
        const importId = result.importId
        toast.error(result.error, {
          action: {
            label: 'Открыть импорт',
            onClick: () => router.push(`/menu/imports/${importId}`),
          },
        })
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleSubmitForApproval() {
    if (!menu) return
    startTransition(async () => {
      const result = await submitMenuForApproval(menu.id)
      if (result.ok) {
        toast.success('Меню отправлено на согласование')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleApprove() {
    if (!menu) return
    startTransition(async () => {
      const result = await approveMenu(menu.id)
      if (result.ok) {
        toast.success('Меню утверждено')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleReject() {
    if (!menu) return
    const commentToSend = rejectComment.trim() || undefined
    startTransition(async () => {
      const result = await rejectMenu(menu.id, commentToSend)
      if (result.ok) {
        toast.success('Меню возвращено шефу')
        setRejectOpen(false)
        setRejectComment('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleUnapprove() {
    if (!menu) return
    startTransition(async () => {
      const result = await unapproveMenu(menu.id)
      if (result.ok) {
        toast.success('Утверждение отозвано')
        setUnapproveOpen(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleArchive() {
    if (!menu) return
    startTransition(async () => {
      const result = await archiveMenu(menu.id)
      if (result.ok) {
        toast.success('Меню архивировано')
        setArchiveOpen(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  // Группируем дни по dayOfWeek
  const daysByDow = new Map<number, Map<MealType, MenuDayData>>()
  if (menu) {
    for (const day of menu.days) {
      if (!daysByDow.has(day.dayOfWeek)) {
        daysByDow.set(day.dayOfWeek, new Map())
      }
      daysByDow.get(day.dayOfWeek)!.set(day.mealType, day)
    }
  }

  const showRejectionBanner =
    !!menu && menu.status === 'DRAFT' && !!menu.rejectionComment
  const showPreviewBanner = !!previewImportId && canEdit

  return (
    <div className="space-y-5">
      {showPreviewBanner && (
        <div className="rounded-2xl border-l-4 border-warning bg-warning-bg/30 p-4 flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-warning-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-1">
            <p className="font-semibold text-sm text-warning-fg">
              Это preview AI-импорта
            </p>
            <p className="text-sm text-warning-fg">
              Меню сгенерировано AI и пока не утверждено. Перейдите в импорт чтобы
              проверить блюда и развернуть его на 13 недель.
            </p>
          </div>
          <Link
            href={`/menu/imports/${previewImportId}`}
            className="shrink-0 px-3 py-1.5 rounded-pill bg-warning text-accent-fg font-medium text-xs hover:opacity-90 transition-opacity flex items-center gap-1.5"
          >
            Утвердить →
          </Link>
        </div>
      )}

      {showRejectionBanner && menu && (
        <div className="rounded-2xl border-l-4 border-warning bg-warning-bg/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-warning-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-1">
            <p className="font-semibold text-sm text-warning-fg">
              Возвращено на доработку
            </p>
            {menu.rejectionComment && (
              <p className="text-sm text-warning-fg whitespace-pre-wrap break-words">
                {menu.rejectionComment}
              </p>
            )}
            <p className="text-xs text-fg-muted">
              После того как внесёте правки, отправьте меню снова на согласование.
            </p>
          </div>
        </div>
      )}

      {/* Шапка недели */}
      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigateWeek(-1)}
              aria-label="Предыдущая неделя"
              className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <div className="px-3">
              <p className="font-semibold text-base">
                {formatWeekRange(monday)}
              </p>
              {menu && (
                <p className="text-xs text-fg-muted">{menu.name}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => navigateWeek(1)}
              aria-label="Следующая неделя"
              className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            {!isCurrent && (
              <button
                type="button"
                onClick={navigateToToday}
                className="ml-2 px-3 py-1.5 rounded-pill bg-bg hover:bg-border text-fg-muted hover:text-fg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <CalendarDays className="w-3.5 h-3.5" />
                Текущая
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {menu && (
              <StatusBadge variant={MENU_STATUS_VARIANT[menu.status]}>
                {MENU_STATUS_LABELS[menu.status]}
              </StatusBadge>
            )}

            {menu?.approvedBy && menu.status === 'APPROVED' && (
              <span className="text-xs text-fg-muted">
                Утвердил: {menu.approvedBy.name}
              </span>
            )}

            {menu?.status === 'PENDING_APPROVAL' && isChef && (
              <span className="text-xs text-fg-muted flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Меню на согласовании у администратора. Редактирование заблокировано.
              </span>
            )}

            {menu?.status === 'DRAFT' && canEdit && !previewImportId && (
              <button
                type="button"
                onClick={handleSubmitForApproval}
                disabled={isPending}
                className="px-4 py-2 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                Отправить на согласование
              </button>
            )}

            {menu?.status === 'DRAFT' && isAdmin && !previewImportId && (
              <button
                type="button"
                onClick={() => setArchiveOpen(true)}
                disabled={isPending}
                className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg-muted hover:text-fg hover:bg-bg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <Archive className="w-4 h-4" />
                Архивировать
              </button>
            )}

            {menu?.status === 'PENDING_APPROVAL' && isAdmin && (
              <>
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={isPending}
                  className="px-4 py-2 rounded-pill bg-success text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50"
                >
                  <Check className="w-4 h-4" />
                  Утвердить
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRejectComment('')
                    setRejectOpen(true)
                  }}
                  disabled={isPending}
                  className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg hover:bg-bg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Undo2 className="w-4 h-4" />
                  Вернуть на доработку
                </button>
                <button
                  type="button"
                  onClick={() => setArchiveOpen(true)}
                  disabled={isPending}
                  className="px-4 py-2 rounded-pill border border-border bg-surface text-fg-muted hover:text-danger-fg hover:bg-danger-bg/40 font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Archive className="w-4 h-4" />
                  Архивировать
                </button>
              </>
            )}

            {menu?.status === 'APPROVED' && isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setUnapproveOpen(true)}
                  disabled={isPending}
                  className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg-muted hover:text-fg hover:bg-bg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  Снять утверждение
                </button>
                <button
                  type="button"
                  onClick={() => setArchiveOpen(true)}
                  disabled={isPending}
                  className="px-4 py-2 rounded-pill border border-border bg-surface text-fg-muted hover:text-fg hover:bg-bg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Archive className="w-4 h-4" />
                  Архивировать
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Сетка меню */}
      {!menu ? (
        <EmptyState canCreate={canEdit} onCreate={handleCreateDraft} isPending={isPending} />
      ) : (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-bg/50">
                  <th className="text-left px-3 py-3 text-xs uppercase tracking-wider text-fg-muted font-medium w-32">
                    День
                  </th>
                  {MEAL_TYPE_ORDER.map((mt) => (
                    <th key={mt} className="text-left px-3 py-3 text-xs uppercase tracking-wider text-fg-muted font-medium">
                      {MEAL_TYPE_LABELS[mt]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
                  const dayDate = getDateForDayOfWeek(monday, dow)
                  const isToday = dayDate.toDateString() === new Date().toDateString()

                  return (
                    <tr key={dow} className={cn(isToday && 'bg-warning-bg/20')}>
                      <td className="px-3 py-4 align-top">
                        <div className="font-semibold">{WEEKDAY_NAMES_SHORT[dow]}</div>
                        <div className="text-xs text-fg-muted">
                          {dayDate.getDate()}.{(dayDate.getMonth() + 1).toString().padStart(2, '0')}
                        </div>
                      </td>
                      {MEAL_TYPE_ORDER.map((mt) => {
                        const day = daysByDow.get(dow)?.get(mt)
                        return (
                          <td key={mt} className="px-3 py-3 align-top min-w-[200px]">
                            <DaySlotCell
                              day={day}
                              canEdit={isEditable}
                              onEdit={() => day && setEditingDay(day)}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Редактор дня (модалка) — открывается только если isEditable */}
      {editingDay && (
        <DayEditor
          day={editingDay}
          dishes={dishes}
          dayLabel={`${WEEKDAY_NAMES_FULL[editingDay.dayOfWeek]} · ${MEAL_TYPE_LABELS[editingDay.mealType]}`}
          onClose={() => setEditingDay(null)}
          onSaved={() => {
            setEditingDay(null)
            router.refresh()
          }}
        />
      )}

      {/* Диалог: вернуть на доработку с опциональным комментарием */}
      <Dialog
        open={rejectOpen}
        onOpenChange={(o) => {
          if (!o) {
            setRejectOpen(false)
            setRejectComment('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Вернуть меню {menu ? `«${menu.name}»` : ''} на доработку?
            </DialogTitle>
            <DialogDescription>
              Меню вернётся в черновик. Шеф получит уведомление и сможет внести правки.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <label className="block text-xs uppercase tracking-wider text-fg-muted">
              Комментарий шефу (необязательно)
            </label>
            <textarea
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value.slice(0, REJECT_COMMENT_MAX))}
              placeholder="Опишите что нужно поправить — это поможет шефу."
              maxLength={REJECT_COMMENT_MAX}
              rows={4}
              disabled={isPending}
              className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm resize-none"
            />
            <div className="text-right text-xs text-fg-muted">
              {rejectComment.length}/{REJECT_COMMENT_MAX}
            </div>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => {
                setRejectOpen(false)
                setRejectComment('')
              }}
              disabled={isPending}
              className="px-4 py-2 rounded-pill text-fg-muted text-sm hover:text-fg disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={isPending}
              className="px-4 py-2 rounded-pill bg-danger text-accent-fg font-medium text-sm hover:opacity-90 disabled:opacity-50"
            >
              Вернуть
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={archiveOpen}
        onOpenChange={(o) => {
          if (!o) setArchiveOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Архивировать меню?</AlertDialogTitle>
            <AlertDialogDescription>
              Это действие можно отменить только вручную через БД. Меню перестанет
              отображаться в активных списках.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault()
                handleArchive()
              }}
              disabled={isPending}
            >
              Архивировать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={unapproveOpen}
        onOpenChange={(o) => {
          if (!o) setUnapproveOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Снять утверждение и вернуть в черновик?</AlertDialogTitle>
            <AlertDialogDescription>
              Меню снова станет редактируемым. Поля «Кто утвердил» и «Когда» обнулятся.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleUnapprove()
              }}
              disabled={isPending}
            >
              Снять утверждение
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function DaySlotCell({
  day,
  canEdit,
  onEdit,
}: {
  day: MenuDayData | undefined
  canEdit: boolean
  onEdit: () => void
}) {
  if (!day) {
    return <div className="text-xs text-fg-subtle">—</div>
  }

  if (day.dishes.length === 0) {
    return (
      <button
        type="button"
        onClick={onEdit}
        disabled={!canEdit}
        className={cn(
          'w-full text-left px-3 py-2.5 rounded-xl border border-dashed transition-colors text-xs',
          canEdit
            ? 'border-border-strong text-fg-muted hover:border-fg-muted hover:text-fg cursor-pointer'
            : 'border-border text-fg-subtle cursor-default'
        )}
      >
        {canEdit ? '+ Добавить блюда' : 'Не задано'}
      </button>
    )
  }

  // Группируем по slotCategory для вывода
  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={!canEdit}
      className={cn(
        'w-full text-left rounded-xl p-2 transition-colors',
        canEdit ? 'hover:bg-bg/50 cursor-pointer' : 'cursor-default'
      )}
    >
      <ul className="space-y-1">
        {day.dishes.map((d) => (
          <li key={d.id} className="flex items-baseline gap-1.5 text-xs">
            <span aria-hidden className="shrink-0">{DISH_CATEGORY_ICONS[d.slotCategory]}</span>
            <span className="truncate">{d.dish.name}</span>
          </li>
        ))}
      </ul>
    </button>
  )
}

function EmptyState({
  canCreate,
  onCreate,
  isPending,
}: {
  canCreate: boolean
  onCreate: () => void
  isPending: boolean
}) {
  return (
    <div
      className="w-full rounded-3xl bg-surface border border-border p-12 flex flex-col items-center justify-center text-center min-h-[400px]"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <CalendarDays className="w-12 h-12 text-fg-subtle mb-4" strokeWidth={1.5} />
      <p className="font-medium text-fg mb-1">Меню на эту неделю не создано</p>
      <p className="text-sm text-fg-muted max-w-sm mb-5">
        {canCreate
          ? 'Создайте черновик меню — вы сможете заполнить его блюдами и отправить на утверждение.'
          : 'Шеф ещё не создал меню на эту неделю.'}
      </p>
      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {isPending ? 'Создаём…' : 'Создать меню'}
        </button>
      )}
    </div>
  )
}
