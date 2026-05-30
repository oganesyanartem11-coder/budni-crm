'use client'

/* ─────────────────────────────────────────────────────────────
   F — ConfettiBurst: CSS-частицы, БЕЗ библиотек.
   Полагается на класс .hero-confetti-piece / @keyframes hero-confetti,
   объявленные в HeroStyles (hero-today-tomorrow.tsx).
   ───────────────────────────────────────────────────────────── */
const CONFETTI_PIECES = Array.from({ length: 18 }, (_, i) => i)
const CONFETTI_COLORS = [
  'var(--color-brand-orange)',
  'var(--color-brand-green-accent)',
  'var(--color-brand-yellow)',
  'var(--color-brand-green)',
]

export function ConfettiBurst() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
      {CONFETTI_PIECES.map((i) => {
        const left = (i * 53) % 100 // псевдо-разброс по X
        const delay = (i % 6) * 60
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
        const drift = (i % 2 === 0 ? 1 : -1) * (20 + (i % 5) * 14)
        return (
          <span
            key={i}
            className="hero-confetti-piece absolute top-2 block h-2 w-1.5 rounded-[1px]"
            style={{
              left: `${left}%`,
              background: color,
              animationDelay: `${delay}ms`,
              ['--confetti-drift' as string]: `${drift}px`,
            }}
          />
        )
      })}
    </div>
  )
}

export default ConfettiBurst
