'use client'

import { useSyncExternalStore } from 'react'

/* ─────────────────────────────────────────────────────────────
   usePrefersReducedMotion — подписка на media-query через
   useSyncExternalStore (SSR-safe: на сервере → false).
   Shared-хук: переиспользуется в hero, finance-week-block,
   client-analytics-tab.
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

export default usePrefersReducedMotion
