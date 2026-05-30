'use client'

import { useEffect, useRef, useState } from 'react'

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

export function useCountUp(target: number, reduced: boolean): number {
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

export default useCountUp
