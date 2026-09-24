'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { SalesActionResult } from '@/lib/sales/types'

/**
 * Sprint 8.0 «Продажи»: единый шаблон мутации воронки —
 * server action → toast (ошибка/успех) → router.refresh().
 * Actions сами делают revalidatePath; refresh — страховка для текущего роута.
 */
export function useSalesMutation() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function run<T>(
    action: () => Promise<SalesActionResult<T>>,
    options: {
      success?: string | ((data: T) => string)
      onSuccess?: (data: T) => void
    } = {}
  ) {
    startTransition(async () => {
      try {
        const result = await action()
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        const { success, onSuccess } = options
        if (success) toast.success(typeof success === 'function' ? success(result.data) : success)
        onSuccess?.(result.data)
        router.refresh()
      } catch {
        toast.error('Не удалось сохранить. Проверь связь и попробуй ещё раз')
      }
    })
  }

  return { run, isPending }
}
