'use client'

import { useState, useTransition } from 'react'
import { FileText, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { generateAndGetUpdForDate } from './actions'

export function GenerateButton({
  dateIso,
  disabled,
}: {
  dateIso: string
  disabled?: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)

  // Глобальный Toaster в layout — top-right (единообразно для CRM). На странице
  // УПД кнопки тоже в правом верхнем углу — тост перекрывал бы их. Поэтому
  // ТОЛЬКО эти тосты выводим снизу-справа, глобальную позицию не меняем.
  const toastOpts = { position: 'bottom-right' as const }

  function run(after: () => void, onError?: () => void) {
    if (disabled || pending || busy) return
    setBusy(true)
    startTransition(async () => {
      try {
        const res = await generateAndGetUpdForDate(dateIso)
        if (!res.ok) {
          toast.error(res.error, toastOpts)
          onError?.()
          return
        }
        const { createdCount, reusedCount, conflicts } = res.data
        if (conflicts.length > 0) {
          toast.warning(`УПД сформированы (новых: ${createdCount}, существующих: ${reusedCount}). Конфликтов: ${conflicts.length}.`, toastOpts)
        } else if (createdCount === 0 && reusedCount > 0) {
          toast.success(`Используются ранее сформированные УПД (${reusedCount}).`, toastOpts)
        } else {
          toast.success(`Сформировано УПД: ${createdCount}${reusedCount ? `, переиспользовано: ${reusedCount}` : ''}.`, toastOpts)
        }
        after()
      } finally {
        // Сбрасываем busy всегда: и attachment (location.href только триггерит
        // скачивание, страница остаётся), и inline (window.open новой вкладкой)
        // не уводят текущую страницу — без finally кнопка зависала бы в «Формирую…».
        setBusy(false)
      }
    })
  }

  function onPrint() {
    if (disabled || pending || busy) return
    // Окно открываем СИНХРОННО до любого await: после await Safari/Chrome
    // считают вызов window.open не-юзер-жестом и блокируют попап без ошибки.
    const win = window.open('', '_blank')
    if (!win) {
      toast.error(
        'Браузер заблокировал новое окно. Разрешите всплывающие окна для печати или используйте «Скачать PDF».',
        toastOpts,
      )
      return
    }
    run(
      () => {
        win.location.href = `/production/print/upd/pdf?date=${encodeURIComponent(dateIso)}&disposition=inline`
      },
      () => {
        win.close()
      },
    )
  }

  function onDownload() {
    run(() => {
      window.location.href = `/production/print/upd/pdf?date=${encodeURIComponent(dateIso)}`
    })
  }

  const btnClass =
    'px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onPrint}
        disabled={disabled || pending || busy}
        className={btnClass}
      >
        <Printer className="w-4 h-4" />
        {pending || busy ? 'Формирую…' : 'Печать'}
      </button>
      <button
        type="button"
        onClick={onDownload}
        disabled={disabled || pending || busy}
        className={btnClass}
      >
        <FileText className="w-4 h-4" />
        {pending || busy ? 'Формирую…' : 'Скачать PDF'}
      </button>
    </div>
  )
}
