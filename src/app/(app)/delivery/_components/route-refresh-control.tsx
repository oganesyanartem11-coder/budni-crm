'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  ROUTE_REFRESH_INTERVAL_MS,
  shouldAutoRefreshRoute,
} from '@/lib/delivery/route-refresh-policy'
import { cn } from '@/lib/utils/cn'

export function RouteRefreshControl({
  className,
  label = 'Обновить маршрут',
  announcement: announcementText = 'Маршрут обновлён',
}: {
  className?: string
  label?: string
  announcement?: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [liveAnnouncement, setLiveAnnouncement] = useState('')
  const announcementTimer = useRef<number | null>(null)
  const announceAfterRefresh = useRef(false)
  const sawPendingRefresh = useRef(false)

  const refresh = useCallback((announce: boolean) => {
    if (announce) {
      setLiveAnnouncement('')
      announceAfterRefresh.current = true
      sawPendingRefresh.current = false
      if (announcementTimer.current !== null) {
        window.clearTimeout(announcementTimer.current)
        announcementTimer.current = null
      }
    }
    startTransition(() => {
      router.refresh()
    })
  }, [router])

  useEffect(() => {
    if (isPending) {
      if (announceAfterRefresh.current) sawPendingRefresh.current = true
      return
    }
    if (!sawPendingRefresh.current || !announceAfterRefresh.current) return

    sawPendingRefresh.current = false
    announceAfterRefresh.current = false
    announcementTimer.current = window.setTimeout(() => {
      setLiveAnnouncement(announcementText)
      announcementTimer.current = null
    }, 50)
  }, [announcementText, isPending])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (shouldAutoRefreshRoute(document.visibilityState)) refresh(false)
    }, ROUTE_REFRESH_INTERVAL_MS)

    const onVisibilityChange = () => {
      if (shouldAutoRefreshRoute(document.visibilityState)) refresh(false)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(interval)
      if (announcementTimer.current !== null) {
        window.clearTimeout(announcementTimer.current)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  return (
    <>
      <button
        type="button"
        onClick={() => refresh(true)}
        disabled={isPending}
        aria-label={label}
        className={cn(
          'inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-fg-muted',
          'transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50 motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
          '[touch-action:manipulation]',
          className,
        )}
      >
        <RefreshCw
          aria-hidden="true"
          className={cn('size-5', isPending && 'animate-spin motion-reduce:animate-none')}
          strokeWidth={1.75}
        />
      </button>
      <span className="sr-only" aria-live="polite">{liveAnnouncement}</span>
    </>
  )
}
