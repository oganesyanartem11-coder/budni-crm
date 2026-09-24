'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { completeTask } from '@/app/(app)/sales/actions'
import type { CompleteTaskResult } from '@/lib/sales/types'
import { NextStepDialog } from './next-step-dialog'

/**
 * Sprint 8.0 «Продажи»: «✅ Выполнено» → completeTask → NextStepDialog.
 * Хук держит результат на уровне вьюхи (а не строки задачи): после
 * revalidatePath строка исчезает из списка, а модалка должна остаться.
 * `dialog` нужно отрендерить один раз в корне вьюхи.
 */
export function useTaskCompletion() {
  const router = useRouter()
  const [result, setResult] = useState<CompleteTaskResult | null>(null)
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)

  async function complete(taskId: string) {
    if (pendingTaskId) return
    setPendingTaskId(taskId)
    try {
      const r = await completeTask(taskId)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      if (r.data.alreadyDone) {
        toast.info('Задача уже была выполнена')
        router.refresh()
        return
      }
      setResult(r.data)
    } catch {
      toast.error('Не удалось отметить задачу. Проверь связь и попробуй ещё раз')
    } finally {
      setPendingTaskId(null)
    }
  }

  const dialog = (
    <NextStepDialog open={result !== null} result={result} onDone={() => setResult(null)} />
  )

  return { complete, pendingTaskId, dialog }
}
