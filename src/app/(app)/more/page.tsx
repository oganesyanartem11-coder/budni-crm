import Link from 'next/link'
import {
  Truck,
  BarChart3,
  Settings,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'

interface MoreLink {
  href: string
  label: string
  icon: LucideIcon
}

// Волна 2: заглушка зоны «Ещё». Детальная проработка — Волна 4.
const MORE_LINKS: MoreLink[] = [
  { href: '/delivery',  label: 'Доставка',  icon: Truck },
  { href: '/analytics', label: 'Аналитика', icon: BarChart3 },
  { href: '/settings',  label: 'Настройки', icon: Settings },
]

export default function MorePage() {
  return (
    <>
      <PageHeader title="Ещё" subtitle="Разделы, перенесённые в раздел «Ещё»" />

      <ul className="space-y-2">
        {MORE_LINKS.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex items-center justify-between gap-3 rounded-2xl bg-surface border border-border p-4 text-fg hover:bg-surface-2 transition-colors"
            >
              <span className="flex items-center gap-3">
                <Icon className="w-5 h-5 text-fg-muted" strokeWidth={1.75} aria-hidden="true" />
                <span className="font-medium">{label}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-fg-subtle" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
