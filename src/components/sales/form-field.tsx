import { AlertCircle } from 'lucide-react'
import { FIELD_LABEL_CLASS } from './styles'

/** Поле формы воронки: подпись сверху, подсказка/ошибка снизу (как в client-form). */
export function SalesField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-fg-subtle">{hint}</p>}
      {error && (
        <p className="mt-1 flex items-center gap-1 text-sm text-danger-fg" role="alert">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
