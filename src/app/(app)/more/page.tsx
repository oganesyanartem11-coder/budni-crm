import Link from 'next/link'
import {
  Users,
  CalendarDays,
  Sparkles,
  Utensils,
  ReceiptText,
  Wheat,
  Truck,
  BarChart3,
  TrendingUp,
  FileText,
  FileBarChart,
  Settings,
  Bot,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import type { UserRole } from '@prisma/client'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'

// 7.20 / Волна 4: полноценная mobile overflow-страница «Ещё».
// Источник истины по ролям — src/lib/navigation.ts (NAV_GROUPS/BOTTOM_NAV):
// каждый roles[] ниже скопирован 1:1 из соответствующего NavItem, чтобы
// сайдбар (десктоп) и /more (мобайл) не разошлись.
//
// Страница гейтится requireRole(['ADMIN_PRO','ADMIN','MANAGER']) — CHEF/COURIER
// сюда не попадают (редирект на /dashboard в requireRole). Внутри каждый пункт
// дополнительно фильтруется по roles, поэтому matrix актуальна для трёх ролей.

interface MoreItem {
  href: string
  label: string
  subtitle?: string
  icon: LucideIcon
  roles: UserRole[]
  /** Бейдж справа от тайтла (напр. «AI» у Бориса). */
  badge?: string
  /** Раскрываемая группа: рендерится как <details> с детьми-ссылками. */
  children?: MoreItem[]
}

interface MoreSection {
  /** caption-заголовок секции (uppercase). */
  title: string
  items: MoreItem[]
}

// roles скопированы из src/lib/navigation.ts. Дочерние «Аналитики» —
// из NavItem children, «Борис» — из BOTTOM_NAV.
const SECTIONS: MoreSection[] = [
  {
    title: 'Продажи',
    items: [
      { href: '/clients',      label: 'Клиенты',     icon: Users,        roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
      { href: '/menu',         label: 'Меню недели', icon: CalendarDays, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
      { href: '/menu/imports', label: 'Импорт меню', icon: Sparkles,     roles: ['ADMIN_PRO', 'ADMIN', 'CHEF'] },
      { href: '/dishes',       label: 'Блюда',       icon: Utensils,     roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
    ],
  },
  {
    title: 'Производство',
    items: [
      { href: '/invoices',    label: 'Поставки', icon: ReceiptText, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
      { href: '/ingredients', label: 'Сырьё',     icon: Wheat,       roles: ['ADMIN_PRO', 'ADMIN', 'CHEF'] },
    ],
  },
  {
    title: 'Ещё',
    items: [
      { href: '/delivery', label: 'Доставка', icon: Truck, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'COURIER'] },
      {
        href: '/analytics',
        label: 'Аналитика',
        icon: BarChart3,
        roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'],
        children: [
          { href: '/analytics/cost',     label: 'Себестоимость', icon: TrendingUp,   roles: ['ADMIN_PRO', 'ADMIN'] },
          { href: '/analytics/invoices', label: 'Приёмки',       icon: ReceiptText,  roles: ['ADMIN_PRO'] },
          { href: '/reports',            label: 'Отчёты',        icon: FileText,     roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
          { href: '/analytics',          label: 'Сводка',        icon: FileBarChart, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
        ],
      },
      {
        href: '/settings',
        label: 'Настройки',
        icon: Settings,
        roles: ['ADMIN_PRO', 'ADMIN'],
        children: [
          { href: '/settings/users',           label: 'Пользователи', icon: Users,        roles: ['ADMIN_PRO', 'ADMIN'] },
          { href: '/settings/telegram',        label: 'Telegram',     icon: Bot,          roles: ['ADMIN_PRO', 'ADMIN'] },
          { href: '/settings/legal-entities',  label: 'Юрлица',       icon: FileText,     roles: ['ADMIN_PRO', 'ADMIN'] },
          { href: '/settings/errors',          label: 'Ошибки',       icon: FileBarChart, roles: ['ADMIN_PRO', 'ADMIN'] },
        ],
      },
    ],
  },
  {
    title: 'Инструменты',
    items: [
      { href: '/boris', label: 'Борис', subtitle: 'AI-ассистент производства', icon: Bot, badge: 'AI', roles: ['ADMIN_PRO'] },
    ],
  },
]

const ROW_BASE =
  'flex items-center gap-3 rounded-xl bg-surface border border-border p-4 min-h-[56px] text-fg ' +
  'transition-colors motion-reduce:transition-none [touch-action:manipulation] ' +
  'hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green focus-visible:ring-offset-2 focus-visible:ring-offset-surface'

function IconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex w-10 h-10 shrink-0 items-center justify-center rounded-lg bg-brand-green-light text-brand-green-deep">
      <Icon className="w-5 h-5" strokeWidth={1.75} aria-hidden="true" />
    </span>
  )
}

function RowContent({ item }: { item: MoreItem }) {
  return (
    <>
      <IconBox icon={item.icon} />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2">
          <span className="font-semibold leading-tight">{item.label}</span>
          {item.badge && (
            <span className="rounded bg-brand-orange px-2 py-0.5 text-xs font-bold text-white">
              {item.badge}
            </span>
          )}
        </span>
        {item.subtitle && (
          <span className="text-sm text-fg-muted leading-tight">{item.subtitle}</span>
        )}
      </span>
    </>
  )
}

/** Плоская карточка-ссылка. */
function LinkRow({ item }: { item: MoreItem }) {
  return (
    <Link href={item.href} className={`${ROW_BASE} justify-between`}>
      <span className="flex min-w-0 items-center gap-3">
        <RowContent item={item} />
      </span>
      <ChevronRight className="w-5 h-5 shrink-0 text-fg-subtle" aria-hidden="true" />
    </Link>
  )
}

/**
 * Раскрываемая группа на нативном <details> (без 'use client'): <summary> —
 * та же карточка, ChevronRight поворачивается через group-open:rotate-90.
 * Дети — вложенный стек LinkRow, видны только отфильтрованные по роли.
 */
function DisclosureRow({ item, role }: { item: MoreItem; role: UserRole }) {
  const children = (item.children ?? []).filter((c) => c.roles.includes(role))
  if (children.length === 0) return null

  return (
    <details className="group">
      <summary
        className={`${ROW_BASE} justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <RowContent item={item} />
        </span>
        <ChevronRight
          className="w-5 h-5 shrink-0 text-fg-subtle transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <ul className="mt-2 space-y-2 pl-4">
        {children.map((child) => (
          <li key={child.href}>
            <LinkRow item={child} />
          </li>
        ))}
      </ul>
    </details>
  )
}

export default async function MorePage() {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER'])
  const role = user.role

  // Фильтр секций: оставляем пункты, доступные роли; для раскрываемых узлов —
  // узел виден, только если у роли есть хотя бы один доступный ребёнок.
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => {
      if (!item.roles.includes(role)) return false
      if (item.children) {
        return item.children.some((c) => c.roles.includes(role))
      }
      return true
    }),
  })).filter((section) => section.items.length > 0)

  return (
    <>
      <PageHeader title="Ещё" subtitle="Все разделы CRM" />

      <div className="space-y-8">
        {sections.map((section) => (
          <section key={section.title} className="space-y-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {section.title}
            </h2>
            <ul className="space-y-2">
              {section.items.map((item) => (
                <li key={item.href}>
                  {item.children ? (
                    <DisclosureRow item={item} role={role} />
                  ) : (
                    <LinkRow item={item} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}
