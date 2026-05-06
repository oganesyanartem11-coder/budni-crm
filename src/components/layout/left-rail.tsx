'use client'

import { Search, Bell, Sparkles, User, Sun, Moon } from 'lucide-react'
import { useState } from 'react'
import { LogoutButton } from './logout-button'

const RAIL_ITEMS = [
  { id: 'search', icon: Search, label: 'Поиск' },
  { id: 'notifications', icon: Bell, label: 'Уведомления', badge: true },
  { id: 'ai', icon: Sparkles, label: 'AI-помощник' },
  { id: 'profile', icon: User, label: 'Профиль' },
]

export function LeftRail() {
  const [darkMode, setDarkMode] = useState(false)

  return (
    <aside className="hidden md:flex flex-col items-center gap-2 py-6 px-3 bg-surface border-r border-border">
      <div className="flex flex-col gap-2 flex-1">
        {RAIL_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              className="relative w-10 h-10 rounded-full bg-surface-2 hover:bg-border text-fg-muted hover:text-fg transition-colors flex items-center justify-center"
            >
              <Icon className="w-4 h-4" strokeWidth={1.75} />
              {item.badge && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-danger" />
              )}
            </button>
          )
        })}
        <LogoutButton />
      </div>

      <button
        type="button"
        onClick={() => setDarkMode(!darkMode)}
        aria-label="Переключить тему"
        className="w-10 h-10 rounded-full bg-accent text-accent-fg hover:opacity-90 transition-opacity flex items-center justify-center"
      >
        {darkMode ? (
          <Moon className="w-4 h-4" strokeWidth={1.75} />
        ) : (
          <Sun className="w-4 h-4" strokeWidth={1.75} />
        )}
      </button>
    </aside>
  )
}
