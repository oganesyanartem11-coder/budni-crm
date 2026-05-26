'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Search } from 'lucide-react'

interface Props {
  initial?: string
}

export function SearchBar({ initial }: Props) {
  const [value, setValue] = useState(initial ?? '')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setValue(initial ?? '')
  }, [initial])

  function handleChange(next: string) {
    setValue(next)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      const sp = new URLSearchParams(searchParams.toString())
      if (next.trim()) sp.set('q', next.trim())
      else sp.delete('q')
      const qs = sp.toString()
      router.push(qs ? `${pathname}?${qs}` : pathname)
    }, 300)
  }

  return (
    <div className="relative max-w-sm">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Поиск по поставщику или номеру"
        className="w-full pl-9 pr-3 py-2 rounded-pill bg-bg border border-border text-sm focus:outline-none focus:border-accent"
      />
    </div>
  )
}
