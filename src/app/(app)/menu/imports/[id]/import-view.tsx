'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Archive,
  Loader2,
  Check,
  Undo2,
} from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { MondayPicker, toISODate } from '@/components/ui/monday-picker'
import { cn } from '@/lib/utils/cn'
import { formatDateNumeric } from '@/lib/utils/format'
import { getMondayOfWeek } from '@/lib/utils/week'
import { addWeeks } from 'date-fns'
import {
  rollbackEntireImport,
  submitImportForApproval,
  approveMenuImport,
  rejectMenuImport,
  countReplaceableCycles,
} from '../actions'
import { MenuTreeView, type SerializedCycle } from './menu-tree-view'
import { DishesListView, type SerializedDish } from './dishes-list-view'
import { MENU_STATUS_LABELS } from '@/lib/constants/menu-status'
import { isAdminLike } from '@/lib/auth/role-helpers'
import type { MenuStatus, UserRole } from '@prisma/client'

export interface AllIngredient {
  id: string
  name: string
  unit: string
}

export interface ApprovalInfo {
  approvedAt: Date | null
  rejectionComment: string | null
  startDate: Date | null
  approvedByName: string | null
}

export interface ImportViewProps {
  menuImportId: string
  dishes: SerializedDish[]
  menuCycles: SerializedCycle[]
  allIngredients: AllIngredient[]
  status: MenuStatus
  dishesCount: number
  userRole: UserRole
  approval: ApprovalInfo
}

const REJECT_COMMENT_MAX = 2000

type Tab = 'menu' | 'dishes'

export function ImportView({
  menuImportId,
  dishes,
  menuCycles,
  allIngredients,
  status,
  dishesCount,
  userRole,
  approval,
}: ImportViewProps) {
  const [tab, setTab] = useState<Tab>('menu')
  const [expandedDishId, setExpandedDishId] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<
    null | 'submit' | 'rollback' | 'approve' | 'reject'
  >(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [rejectComment, setRejectComment] = useState('')
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [replaceableCount, setReplaceableCount] = useState<number | null>(null)
  const [countLoading, setCountLoading] = useState(false)
  const router = useRouter()

  function openDish(dishId: string) {
    setExpandedDishId(dishId)
    setTab('dishes')
  }

  const isAdmin = isAdminLike(userRole)
  const isDraft = status === 'DRAFT'
  const isPendingApproval = status === 'PENDING_APPROVAL'
  const canEdit = isDraft
  const showRejectionBanner = isDraft && !!approval.rejectionComment

  // Дебаунс запроса countReplaceableCycles при изменении даты в approve-модалке.
  // 300ms — обычный SPA-комфорт; запрос лёгкий (один count), но юзер быстро кликает
  // по календарю и без дебаунса будет flicker подсказки.
  useEffect(() => {
    if (confirmAction !== 'approve' || !selectedDate) {
      setReplaceableCount(null)
      setCountLoading(false)
      return
    }
    setCountLoading(true)
    const iso = toISODate(selectedDate)
    const timer = setTimeout(async () => {
      const r = await countReplaceableCycles({ menuImportId, startDate: iso })
      if (r.ok) setReplaceableCount(r.data.count)
      else setReplaceableCount(null)
      setCountLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [confirmAction, selectedDate, menuImportId])

  function onSubmit() {
    setError(null)
    startTransition(async () => {
      const r = await submitImportForApproval({ menuImportId })
      if (r.ok) {
        setConfirmAction(null)
        router.refresh()
        // Шеф должен увидеть верх страницы — там обновляется chip + появляется
        // StatusBanner (PENDING_APPROVAL).
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
      } else {
        setError(r.error)
      }
    })
  }

  function onRollback() {
    setError(null)
    startTransition(async () => {
      const r = await rollbackEntireImport({ menuImportId })
      if (r.ok) {
        setConfirmAction(null)
        router.push('/menu/imports')
      } else {
        setError(r.error)
      }
    })
  }

  function openApprove() {
    setError(null)
    setReplaceableCount(null)
    // Дефолт — понедельник следующей недели. Считаем в момент открытия, а не как
    // initial state, чтобы дата не «протухала» при долгой жизни компонента.
    setSelectedDate(getMondayOfWeek(addWeeks(new Date(), 1)))
    setConfirmAction('approve')
  }

  function closeApprove() {
    setConfirmAction(null)
    setSelectedDate(undefined)
    setReplaceableCount(null)
  }

  function openReject() {
    setError(null)
    setRejectComment('')
    setConfirmAction('reject')
  }

  function closeReject() {
    setConfirmAction(null)
    setRejectComment('')
  }

  function onApprove() {
    if (!selectedDate) return
    startTransition(async () => {
      const r = await approveMenuImport({
        menuImportId,
        startDate: toISODate(selectedDate),
      })
      if (r.ok) {
        toast.success(
          `Меню утверждено и развёрнуто на ${r.data.cyclesCreated} недель`
        )
        closeApprove()
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  function onReject() {
    const comment = rejectComment.trim()
    if (!comment) return
    startTransition(async () => {
      const r = await rejectMenuImport({ menuImportId, comment })
      if (r.ok) {
        toast.success('Импорт возвращён шефу на доработку')
        closeReject()
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
      {/* Левая колонка — рабочая область */}
      <div className="min-w-0 space-y-6">
        {showRejectionBanner && approval.rejectionComment && (
          <div className="rounded-2xl border-l-4 border-warning bg-warning-bg/30 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-warning-fg shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="font-semibold text-sm text-warning-fg">
                Возвращено на доработку администратором
              </p>
              <p className="text-sm text-warning-fg whitespace-pre-wrap break-words">
                {approval.rejectionComment}
              </p>
              <p className="text-xs text-fg-muted">
                После правок отправьте импорт снова на согласование.
              </p>
            </div>
          </div>
        )}

        {/* Compact-строка контекста: «Распознано N блюд» — лёгкая, без карточки.
            Виден всегда на READY-странице для контекста после перезагрузки. */}
        <div className="flex items-center gap-2 text-sm text-success-fg/80">
          <CheckCircle2 className="w-4 h-4" />
          <span>Распознано {dishesCount} блюд · готовы к ревью</span>
        </div>

        <div className="inline-flex p-1 rounded-pill bg-surface border border-border">
          <TabButton active={tab === 'menu'} onClick={() => setTab('menu')}>
            Меню
          </TabButton>
          <TabButton active={tab === 'dishes'} onClick={() => setTab('dishes')}>
            Блюда · {dishes.length}
          </TabButton>
        </div>

        {tab === 'menu' && (
          <MenuTreeView cycles={menuCycles} onDishClick={openDish} />
        )}
        {tab === 'dishes' && (
          <DishesListView
            dishes={dishes}
            allIngredients={allIngredients}
            canEdit={canEdit}
            expandedDishId={expandedDishId}
            onExpandedChange={setExpandedDishId}
          />
        )}

        {isDraft && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-border">
            <button
              type="button"
              onClick={() => setConfirmAction('rollback')}
              disabled={pending}
              className="px-4 py-2 rounded-pill text-sm text-danger hover:bg-danger/5 transition-colors disabled:opacity-40"
            >
              Отменить весь импорт
            </button>
            <button
              type="button"
              onClick={() => setConfirmAction('submit')}
              disabled={pending || dishes.length === 0}
              className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              Отправить на утверждение
            </button>
          </div>
        )}

        {isPendingApproval && isAdmin && (
          <div className="flex flex-wrap items-center justify-end gap-3 pt-4 border-t border-border">
            <button
              type="button"
              onClick={openReject}
              disabled={pending}
              className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg hover:bg-bg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              <Undo2 className="w-4 h-4" />
              Вернуть на доработку
            </button>
            <button
              type="button"
              onClick={openApprove}
              disabled={pending}
              className="px-5 py-2.5 rounded-pill bg-success text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
            >
              <Check className="w-4 h-4" />
              Утвердить с датой…
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
            {error}
          </div>
        )}
      </div>

      {/* Правая колонка — sticky-aside.
          DRAFT → памятка-помощник «Что дальше».
          PENDING_APPROVAL/APPROVED/ARCHIVED → StatusBanner. */}
      <aside className="lg:sticky lg:top-6 self-start space-y-4">
        {isDraft ? (
          <div className="rounded-2xl border border-border bg-fg/5 p-4 text-xs text-fg-muted">
            <p className="font-medium text-fg mb-1">Что дальше</p>
            <p>
              Проверьте дерево меню и составы блюд. Когда всё ок — нажмите «На утверждение» внизу.
            </p>
          </div>
        ) : (
          <StatusBanner status={status} approval={approval} />
        )}
      </aside>

      <AlertDialog
        open={confirmAction === 'submit'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отправить меню на утверждение?</AlertDialogTitle>
            <AlertDialogDescription>
              ADMIN получит уведомление и сможет одобрить или вернуть на доработку.
              Пока меню на утверждении, правки и удаление блюд недоступны.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button onClick={onSubmit} disabled={pending}>
                {pending ? 'Отправляю…' : 'Отправить'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmAction === 'rollback'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить импорт меню?</AlertDialogTitle>
            <AlertDialogDescription>
              Все распознанные {dishes.length} блюд и расписание будут безвозвратно удалены.
              Ингредиенты останутся в справочнике (можно почистить отдельно).
              Действие нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Не отменять</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={onRollback} disabled={pending}>
                {pending ? 'Удаляю…' : 'Да, удалить'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={confirmAction === 'approve'}
        onOpenChange={(open) => {
          if (!open) closeApprove()
        }}
      >
        <DialogContent className="overflow-visible">
          <DialogHeader>
            <DialogTitle>Утвердить импорт</DialogTitle>
            <DialogDescription>
              Выберите дату-понедельник, с которой меню начнёт действовать.
              Меню развернётся на 13 недель вперёд, чередуя Нед.А / Нед.Б.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block text-xs uppercase tracking-wider text-fg-muted">
              Дата старта (понедельник)
            </label>
            <MondayPicker
              value={selectedDate}
              onChange={setSelectedDate}
              disabled={pending}
            />

            <div className="min-h-[1.5rem] text-xs">
              {countLoading && (
                <span className="inline-flex items-center gap-2 text-fg-muted">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Проверяю существующие меню…
                </span>
              )}
              {!countLoading && replaceableCount === 0 && selectedDate && (
                <span className="inline-flex items-center gap-1.5 text-success-fg">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  С этой даты циклов нет — конфликтов не будет.
                </span>
              )}
              {!countLoading && replaceableCount !== null && replaceableCount > 0 && selectedDate && (
                <span className="inline-flex items-start gap-1.5 text-warning-fg">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Будет удалено {replaceableCount} циклов от других меню
                    (в т.ч. ручные, если есть), начиная с {formatDateNumeric(selectedDate)}.
                  </span>
                </span>
              )}
            </div>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={closeApprove}
              disabled={pending}
              className="px-4 py-2 rounded-pill text-fg-muted text-sm hover:text-fg disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={!selectedDate || countLoading || pending}
              className="px-5 py-2.5 rounded-pill bg-success text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              Утвердить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmAction === 'reject'}
        onOpenChange={(open) => {
          if (!open) closeReject()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Вернуть импорт на доработку?</DialogTitle>
            <DialogDescription>
              Импорт вернётся в черновик. Шеф сможет внести правки и отправить снова.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <label className="block text-xs uppercase tracking-wider text-fg-muted">
              Комментарий шефу
            </label>
            <textarea
              value={rejectComment}
              onChange={(e) =>
                setRejectComment(e.target.value.slice(0, REJECT_COMMENT_MAX))
              }
              placeholder="Опишите что нужно поправить — это поможет шефу."
              maxLength={REJECT_COMMENT_MAX}
              rows={4}
              disabled={pending}
              className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm resize-none"
            />
            <div className="text-right text-xs text-fg-muted">
              {rejectComment.length}/{REJECT_COMMENT_MAX}
            </div>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={closeReject}
              disabled={pending}
              className="px-4 py-2 rounded-pill text-fg-muted text-sm hover:text-fg disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={pending || rejectComment.trim().length === 0}
              className="px-5 py-2.5 rounded-pill bg-danger text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              Вернуть
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-4 py-1.5 rounded-pill text-sm font-medium transition-colors',
        active ? 'bg-fg text-bg' : 'text-fg-muted hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

function StatusBanner({
  status,
  approval,
}: {
  status: MenuStatus
  approval: ApprovalInfo
}) {
  const label = MENU_STATUS_LABELS[status]
  if (status === 'PENDING_APPROVAL') {
    return (
      <div className="rounded-2xl border border-warning/30 bg-warning/5 p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-warning-fg shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-fg">{label}</p>
          <p className="text-fg-muted">
            На утверждении у администратора. Правки недоступны, пока ADMIN не одобрит или не отклонит.
          </p>
        </div>
      </div>
    )
  }
  if (status === 'APPROVED') {
    const approvedAtLine =
      approval.approvedAt
        ? `Утверждено ${formatDateNumeric(approval.approvedAt)}${approval.approvedByName ? ` (${approval.approvedByName})` : ''}.`
        : 'Меню утверждено.'
    const startDateLine = approval.startDate
      ? `Развёрнуто на 13 недель с ${formatDateNumeric(approval.startDate)}.`
      : null
    return (
      <div className="rounded-2xl border border-success/30 bg-success/5 p-4 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
        <div className="text-sm space-y-1">
          <p className="font-medium text-fg">{label}</p>
          <p className="text-fg-muted">{approvedAtLine}</p>
          {startDateLine && <p className="text-fg-muted">{startDateLine}</p>}
        </div>
      </div>
    )
  }
  if (status === 'ARCHIVED') {
    return (
      <div className="rounded-2xl border border-border bg-fg/5 p-4 flex items-start gap-3">
        <Archive className="w-5 h-5 text-fg-subtle shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-fg">{label}</p>
          <p className="text-fg-muted">Импорт в архиве, правки недоступны.</p>
        </div>
      </div>
    )
  }
  return null
}
