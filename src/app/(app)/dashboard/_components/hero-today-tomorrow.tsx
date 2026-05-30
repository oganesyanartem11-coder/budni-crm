'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'
import type { TodayHeroData, TomorrowHeroData } from '@/lib/db/queries/dashboard-hero'
import { pluralize } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

/* ─────────────────────────────────────────────────────────────
   usePrefersReducedMotion — подписка на media-query через
   useSyncExternalStore (SSR-safe: на сервере → false).
   Экспортируется для переиспользования в finance-week-block.tsx.
   ───────────────────────────────────────────────────────────── */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => (typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false),
    () => false,
  )
}

/* ─────────────────────────────────────────────────────────────
   Текущий час МСК (дробный, для позиции progress-полосы).
   Берём через Intl с timeZone Europe/Moscow — НЕ локальный час.
   ───────────────────────────────────────────────────────────── */
function getMoscowFractionalHour(now: Date): number {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  // '24' иногда отдаётся для полуночи — нормализуем
  return (h % 24) + m / 60
}

/** Текущий день недели по-русски в МСК (для "vs прошлая {день}"). */
function getMoscowWeekdayRu(now: Date): string {
  // ru-RU long weekday → "пятница" и т.п.
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    weekday: 'long',
  }).format(now)
}

const WORKDAY_START = 9
const WORKDAY_END = 16

interface Props {
  today: TodayHeroData
  tomorrow: TomorrowHeroData
  dailyRecord: number
}

export function HeroTodayTomorrow({ today, tomorrow, dailyRecord }: Props) {
  const prefersReducedMotion = usePrefersReducedMotion()

  // Позиция progress-полосы: 9:00→0%, 16:00→100%, клампим.
  // Вычисляем после mount, чтобы избежать гидрационного рассинхрона (SSR не знает МСК-час так же).
  const [progressPct, setProgressPct] = useState(0)
  useEffect(() => {
    function update() {
      const hour = getMoscowFractionalHour(new Date())
      const raw = ((hour - WORKDAY_START) / (WORKDAY_END - WORKDAY_START)) * 100
      setProgressPct(Math.max(0, Math.min(100, raw)))
    }
    update()
    const id = window.setInterval(update, 60_000)
    return () => window.clearInterval(id)
  }, [])

  const weekday = getMoscowWeekdayRu(new Date())

  // D — count-up (spring easeOutBack), ТОЛЬКО при первом mount.
  const animatedPortions = useCountUp(today.portions, prefersReducedMotion)

  // F — confetti milestone: новый рекорд ИЛИ кратный 10 рубеж.
  // Считаем ОДИН раз на mount (useRef-гейт), чтобы не палить на каждом рендере.
  const milestoneDecided = useRef(false)
  const [confetti, setConfetti] = useState(false)
  useEffect(() => {
    if (milestoneDecided.current) return
    milestoneDecided.current = true
    const isNewRecord = today.portions > dailyRecord && today.portions > 0
    const isRoundMilestone = today.portions > 0 && today.portions % 10 === 0
    if (isNewRecord || isRoundMilestone) {
      setConfetti(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const delta = today.deltaPctVsLastWeek
  const hasDelta = delta !== null
  const deltaUp = hasDelta && (delta as number) >= 0

  // Завтра vs сегодня
  const tomorrowLine = buildTomorrowLine(today.portions, tomorrow.portions)

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5 sm:p-6"
      style={{ boxShadow: 'var(--shadow-card)' }}
      aria-label="Сводка на сегодня и завтра"
    >
      <HeroStyles />

      {/* Оранжевая progress-полоса СЛЕВА (вертикальная) */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-1.5 overflow-hidden bg-brand-orange-light"
        aria-hidden="true"
      >
        <div
          className="hero-progress absolute inset-x-0 bottom-0"
          style={{
            height: prefersReducedMotion ? `${progressPct}%` : undefined,
            ['--hero-progress' as string]: `${progressPct}%`,
          }}
        />
      </div>

      {/* LIVE-индикатор в правом верхнем углу */}
      <div className="absolute right-4 top-4 inline-flex items-center gap-1.5">
        <span className="hero-pulse-dot inline-block h-2 w-2 rounded-full bg-brand-green-accent" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-green-deep">LIVE</span>
      </div>

      {/* F — Confetti поверх (только при milestone) */}
      {confetti && !prefersReducedMotion && <ConfettiBurst />}

      <div className="relative pl-3 sm:pl-4">
        <p className="text-[11px] font-medium uppercase tracking-widest text-fg-muted">Порций сегодня</p>

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className="hero-number font-display text-5xl font-extrabold tabular-nums leading-none text-fg-strong sm:text-6xl"
            style={{ animationPlayState: prefersReducedMotion ? 'paused' : undefined }}
          >
            {animatedPortions}
          </span>

          {hasDelta && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-sm font-semibold tabular-nums',
                deltaUp ? 'bg-brand-green-light text-brand-green-deep' : 'bg-danger-bg text-danger-fg',
              )}
            >
              {deltaUp ? (
                <TrendingUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <TrendingDown className="h-4 w-4" aria-hidden="true" />
              )}
              {`${deltaUp ? '+' : ''}${(delta as number).toFixed(1)}%`}
            </span>
          )}
        </div>

        <p className="mt-2 text-sm text-fg-muted">
          vs прошлая {weekday}
          {' · '}
          {today.clientCount} {pluralize(today.clientCount, ['клиент', 'клиента', 'клиентов'])}
        </p>

        {/* Разделитель */}
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-sm text-fg">
            <span className="text-fg-muted">Завтра </span>
            <span className="font-semibold tabular-nums">{tomorrow.portions}</span>{' '}
            {pluralize(tomorrow.portions, ['порц', 'порц', 'порц'])}
            {tomorrowLine && (
              <span className="text-fg-muted"> · {tomorrowLine}</span>
            )}
          </p>
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   D — count-up hook. Spring-ish easeOutBack, ~600ms, один раз.
   useRef-гейт «уже анимировали» → не перезапускается на ре-рендерах.
   reduced-motion → значение мгновенно.
   ───────────────────────────────────────────────────────────── */
function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function useCountUp(target: number, reduced: boolean): number {
  const [value, setValue] = useState(reduced ? target : 0)
  const animated = useRef(false)

  useEffect(() => {
    if (animated.current) return
    animated.current = true

    if (reduced || target <= 0) {
      setValue(target)
      return
    }

    const duration = 600
    let raf = 0
    let start: number | null = null

    const tick = (ts: number) => {
      if (start === null) start = ts
      const elapsed = ts - start
      const progress = Math.min(1, elapsed / duration)
      const eased = easeOutBack(progress)
      // easeOutBack может слегка перелетать — клампим к target вверху
      setValue(Math.min(target, Math.round(eased * target)))
      if (progress < 1) {
        raf = requestAnimationFrame(tick)
      } else {
        setValue(target)
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return value
}

/* ─────────────────────────────────────────────────────────────
   Строка «завтра»: легче/больше на N%. Без % если today==0.
   ───────────────────────────────────────────────────────────── */
function buildTomorrowLine(todayPortions: number, tomorrowPortions: number): string | null {
  if (todayPortions === 0) return null
  const diffPct = Math.round(((tomorrowPortions - todayPortions) / todayPortions) * 100)
  if (diffPct === 0) return 'столько же'
  if (diffPct > 0) return `больше на ${diffPct}%`
  return `легче на ${Math.abs(diffPct)}%`
}

/* ─────────────────────────────────────────────────────────────
   F — ConfettiBurst: CSS-частицы, БЕЗ библиотек. Inline в файле.
   ───────────────────────────────────────────────────────────── */
const CONFETTI_PIECES = Array.from({ length: 18 }, (_, i) => i)
const CONFETTI_COLORS = [
  'var(--color-brand-orange)',
  'var(--color-brand-green-accent)',
  'var(--color-brand-yellow)',
  'var(--color-brand-green)',
]

function ConfettiBurst() {
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

/* ─────────────────────────────────────────────────────────────
   Scoped keyframes. reduced-motion → всё animation:none.
   B-shimmer, C-breathing-glow, pulse-dot, F-confetti.
   ───────────────────────────────────────────────────────────── */
function HeroStyles() {
  return (
    <style>{`
      .hero-progress {
        height: var(--hero-progress, 0%);
        background: linear-gradient(
          to top,
          var(--color-brand-orange-dark),
          var(--color-brand-orange)
        );
        transition: height 800ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      .hero-progress::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(
          to top,
          transparent 0%,
          rgba(255, 255, 255, 0.55) 50%,
          transparent 100%
        );
        animation: hero-shimmer 3.5s ease-in-out infinite;
      }
      @keyframes hero-shimmer {
        0% { transform: translateY(100%); opacity: 0; }
        25% { opacity: 1; }
        100% { transform: translateY(-100%); opacity: 0; }
      }

      .hero-pulse-dot {
        animation: hero-pulse 1.8s ease-in-out infinite;
      }
      @keyframes hero-pulse {
        0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(61, 159, 68, 0.45); }
        50% { transform: scale(1.15); opacity: 0.85; box-shadow: 0 0 0 5px rgba(61, 159, 68, 0); }
      }

      .hero-number {
        animation: hero-breathe 2.4s ease-in-out infinite;
      }
      @keyframes hero-breathe {
        0%, 100% { text-shadow: 0 0 0 rgba(232, 93, 42, 0); }
        50% { text-shadow: 0 2px 22px rgba(232, 93, 42, 0.22); }
      }

      .hero-confetti-piece {
        opacity: 0;
        animation: hero-confetti 1100ms cubic-bezier(0.2, 0.8, 0.3, 1) forwards;
      }
      @keyframes hero-confetti {
        0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
        12% { opacity: 1; }
        100% { transform: translate(var(--confetti-drift, 0), 220px) rotate(540deg); opacity: 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        .hero-progress { transition: none; }
        .hero-progress::after,
        .hero-pulse-dot,
        .hero-number,
        .hero-confetti-piece {
          animation: none !important;
        }
      }
    `}</style>
  )
}
