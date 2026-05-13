import { formatPhoneLink } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface PhoneLinkProps {
  phone: string | null | undefined
  className?: string
  /** Что отображать; по умолчанию исходная строка телефона (с маской). */
  children?: React.ReactNode
}

/**
 * Кликабельный телефон. Текст отображается как в БД (с маской «+7 (...)»),
 * href нормализован в E.164 с «+» — нужно iOS Safari для autodial.
 * Если phone пустой или короче 10 цифр, рендерится как span без ссылки.
 */
export function PhoneLink({ phone, className, children }: PhoneLinkProps) {
  if (!phone) return null
  const tel = formatPhoneLink(phone)
  const display = children ?? phone
  if (!tel) return <span className={className}>{display}</span>
  return (
    <a href={`tel:${tel}`} className={cn('hover:underline', className)}>
      {display}
    </a>
  )
}
