'use client'

interface Props {
  hoveredLineIndex: number | null
  totalLines: number
}

/**
 * Стрелка-указатель слева от фото накладной. На hover карточки строки
 * указывает примерное место в фото (без точной привязки к bounding boxes —
 * AI-координаты оказались неточными, заменили на простую визуальную подсказку).
 * Только desktop (md:block+).
 */
export function LineIndicator({ hoveredLineIndex, totalLines }: Props) {
  const isActive = hoveredLineIndex !== null && totalLines > 0
  // Позиция вертикально: пропорциональная (linear), цель — общее ощущение
  // «эта строка скорее наверху/посередине/внизу». Точно по pixel — не нужно.
  const topPct =
    hoveredLineIndex !== null && totalLines > 0
      ? Math.min(95, Math.max(5, ((hoveredLineIndex + 0.5) / totalLines) * 100))
      : 50

  return (
    <div
      className="hidden md:block pointer-events-none absolute top-0 -left-12 h-full transition-opacity duration-200"
      style={{ opacity: isActive ? 1 : 0 }}
      aria-hidden="true"
    >
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        className="absolute -translate-y-1/2 transition-all duration-200"
        style={{ top: `${topPct}%`, color: '#C97B3F' }}
      >
        <path
          d="M4 16 L24 16 M16 8 L24 16 L16 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
