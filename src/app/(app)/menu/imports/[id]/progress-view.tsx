'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertCircle, Loader2, CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { getMenuImportProgress } from '../actions'
import { PROGRESS_STAGES } from '@/lib/menu-import/progress-labels'
import { ImportView, type AllIngredient, type ApprovalInfo } from './import-view'
import type { SerializedDish } from './dishes-list-view'
import type { SerializedCycle } from './menu-tree-view'
import type { MenuImportProgress, MenuStatus, UserRole } from '@prisma/client'

interface Props {
  menuImportId: string
  initialProgress: MenuImportProgress
  initialReason: string | null
  initialErrorMessage: string | null
  dishesCount: number
  importStatus: MenuStatus
  // Подгружается в page.tsx когда progress === 'READY' — иначе null.
  importData: {
    dishes: SerializedDish[]
    menuCycles: SerializedCycle[]
    allIngredients: AllIngredient[]
  } | null
  userRole: UserRole
  approval: ApprovalInfo
}

export function ProgressView({
  menuImportId,
  initialProgress,
  initialReason,
  initialErrorMessage,
  dishesCount,
  importStatus,
  importData,
  userRole,
  approval,
}: Props) {
  const [progress, setProgress] = useState<MenuImportProgress>(initialProgress)
  const [reason, setReason] = useState<string | null>(initialReason)
  const [errorMessage, setErrorMessage] = useState<string | null>(initialErrorMessage)
  const router = useRouter()
  // prev !== null означает что был хотя бы один effect-цикл — при первом монтировании
  // (страница свежеоткрыта с уже READY-импортом) toast не пуляем, только при реальной
  // смене статуса во время polling-а.
  const prevProgressRef = useRef<MenuImportProgress | null>(null)

  useEffect(() => {
    // Если уже терминальный — не запускаем интервал.
    if (initialProgress === 'READY' || initialProgress === 'FAILED') return

    let stopped = false
    const interval = setInterval(async () => {
      if (stopped) return
      const r = await getMenuImportProgress(menuImportId)
      if (!r.ok || stopped) return
      setProgress(r.data.progress)
      setReason(r.data.reason)
      setErrorMessage(r.data.errorMessage)
      if (r.data.progress === 'READY' || r.data.progress === 'FAILED') {
        stopped = true
        clearInterval(interval)
        // На READY обновляем server-side данные (актуальный _count.dishes).
        if (r.data.progress === 'READY') router.refresh()
      }
    }, 2000)

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [menuImportId, initialProgress, router])

  // Toast при РЕАЛЬНОМ переходе из НЕ-READY в READY (polling завершил пайплайн на глазах
  // у пользователя). При первом монтировании с уже READY-импортом — ref=null, toast не пуляем.
  useEffect(() => {
    const prev = prevProgressRef.current
    prevProgressRef.current = progress
    if (prev !== null && prev !== 'READY' && progress === 'READY') {
      toast.success(`Меню распознано: ${dishesCount} ${pluralDishes(dishesCount)}`)
    }
  }, [progress, dishesCount])

  const isFailed = progress === 'FAILED'
  const isReady = progress === 'READY'
  const currentIndex = PROGRESS_STAGES.findIndex((s) => s.key === progress)

  return (
    <div className="space-y-6">
      {/* Прогресс-блок 5 этапов — только во время активного импорта.
          После READY/FAILED трансляция теряет смысл — большой success-блок тоже
          не показываем (его роль выполняет toast при переходе + compact-строка
          внутри ImportView). */}
      {!isReady && !isFailed && (
        <div
          className="max-w-2xl bg-surface border border-border rounded-2xl p-6"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <ol className="space-y-3">
            {PROGRESS_STAGES.map((stage, i) => {
              let state: 'done' | 'active' | 'pending'
              if (i < currentIndex) state = 'done'
              else if (i === currentIndex) state = 'active'
              else state = 'pending'

              return (
                <li key={stage.key} className="flex items-center gap-3">
                  <StageIcon state={state} />
                  <span
                    className={cn(
                      'text-sm',
                      state === 'done' && 'text-fg-muted',
                      state === 'active' && 'text-fg font-medium',
                      state === 'pending' && 'text-fg-subtle'
                    )}
                  >
                    {stage.label}
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="mt-5 text-xs text-fg-subtle">
            Обработка занимает 2–3 минуты. Можно закрыть страницу — импорт продолжится в фоне.
          </p>
        </div>
      )}

      {isFailed && (
        <div className="max-w-2xl rounded-2xl border border-danger/30 bg-danger/5 p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-6 h-6 text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-fg mb-1">Импорт не удался</p>
              <p className="text-sm text-fg-muted mb-4 whitespace-pre-wrap">
                {errorMessage ?? reason ?? 'Причина неизвестна. Проверьте логи сервера.'}
              </p>
              <Link
                href="/menu/imports/new"
                className="inline-flex px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Попробовать снова
              </Link>
            </div>
          </div>
        </div>
      )}

      {isReady && importData && (
        <ImportView
          menuImportId={menuImportId}
          dishes={importData.dishes}
          menuCycles={importData.menuCycles}
          allIngredients={importData.allIngredients}
          status={importStatus}
          dishesCount={dishesCount}
          userRole={userRole}
          approval={approval}
        />
      )}
    </div>
  )
}

function StageIcon({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') return <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
  if (state === 'active') return <Loader2 className="w-5 h-5 text-accent shrink-0 animate-spin" />
  return <Circle className="w-5 h-5 text-fg-subtle shrink-0" strokeWidth={1.5} />
}

function pluralDishes(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'блюдо'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'блюда'
  return 'блюд'
}
