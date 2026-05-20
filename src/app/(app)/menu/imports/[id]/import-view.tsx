'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Archive, Loader2 } from 'lucide-react'
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
import { cn } from '@/lib/utils/cn'
import { rollbackEntireImport, submitImportForApproval } from '../actions'
import { MenuTreeView, type SerializedCycle } from './menu-tree-view'
import { DishesListView, type SerializedDish } from './dishes-list-view'
import { MENU_STATUS_LABELS } from '@/lib/constants/menu-status'
import type { MenuStatus } from '@prisma/client'

export interface AllIngredient {
  id: string
  name: string
  unit: string
}

export interface ImportViewProps {
  menuImportId: string
  dishes: SerializedDish[]
  menuCycles: SerializedCycle[]
  allIngredients: AllIngredient[]
  status: MenuStatus
  dishesCount: number
}

type Tab = 'menu' | 'dishes'

export function ImportView({
  menuImportId,
  dishes,
  menuCycles,
  allIngredients,
  status,
  dishesCount,
}: ImportViewProps) {
  const [tab, setTab] = useState<Tab>('menu')
  const [expandedDishId, setExpandedDishId] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<null | 'submit' | 'rollback'>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function openDish(dishId: string) {
    setExpandedDishId(dishId)
    setTab('dishes')
  }

  const isDraft = status === 'DRAFT'
  const canEdit = isDraft

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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
      {/* Левая колонка — рабочая область */}
      <div className="min-w-0 space-y-6">
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
          <StatusBanner status={status} />
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

function StatusBanner({ status }: { status: MenuStatus }) {
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
    return (
      <div className="rounded-2xl border border-success/30 bg-success/5 p-4 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-fg">{label}</p>
          <p className="text-fg-muted">Меню утверждено. Импорт закрыт.</p>
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
