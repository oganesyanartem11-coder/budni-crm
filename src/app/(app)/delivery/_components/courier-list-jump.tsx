'use client'

import type { MouseEvent } from 'react'

export function CourierListJump({ count }: { count: number }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById('courier-routes')
    if (!target) return

    event.preventDefault()
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'start' })
    window.history.replaceState(null, '', '#courier-routes')
  }

  return (
    <a
      href="#courier-routes"
      onClick={handleClick}
      className="inline-flex min-h-11 w-full items-center justify-center rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 sm:w-auto lg:hidden [touch-action:manipulation]"
    >
      К курьерам · {count}
    </a>
  )
}
