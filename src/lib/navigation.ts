import {
  LayoutDashboard,
  ClipboardList,
  Users,
  Utensils,
  CalendarDays,
  Wheat,
  ChefHat,
  Truck,
  FileBarChart,
  TrendingUp,
  Inbox,
  Menu,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { UserRole } from '@prisma/client'

export type NavBadgeKey = 'pendingCount' | 'inboxCount'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: UserRole[]
  badge?: NavBadgeKey
}

export type NavGroupId = 'daily' | 'production' | 'directory' | 'analytics'

export interface NavGroup {
  id: NavGroupId
  title: string
  items: NavItem[]
}

/**
 * Группы навигации для Sidebar (десктоп) и MobileDrawer.
 * Порядок групп = вертикальный порядок в Sidebar.
 * Внутри группы видны только пункты, чья roles содержит текущую роль —
 * пустая после фильтрации группа в Sidebar/Drawer не рендерится.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'daily',
    title: 'Ежедневно',
    items: [
      { href: '/dashboard', label: 'Дашборд',  icon: LayoutDashboard, roles: ['ADMIN', 'MANAGER'] },
      { href: '/inbox',     label: 'Inbox',    icon: Inbox,           roles: ['ADMIN', 'MANAGER'], badge: 'inboxCount' },
      { href: '/orders',    label: 'Заказы',   icon: ClipboardList,   roles: ['ADMIN', 'MANAGER'], badge: 'pendingCount' },
      { href: '/delivery',  label: 'Доставка', icon: Truck,           roles: ['ADMIN', 'MANAGER', 'COURIER'] },
    ],
  },
  {
    id: 'production',
    title: 'Производство',
    items: [
      { href: '/production',    label: 'Производство', icon: ChefHat,      roles: ['ADMIN', 'CHEF', 'MANAGER'] },
      { href: '/menu',          label: 'Меню недели',  icon: CalendarDays, roles: ['ADMIN', 'MANAGER', 'CHEF'] },
      { href: '/menu/imports',  label: 'Импорт меню',  icon: Sparkles,     roles: ['ADMIN', 'CHEF'] },
    ],
  },
  {
    id: 'directory',
    title: 'Справочники',
    items: [
      { href: '/clients',     label: 'Клиенты', icon: Users,    roles: ['ADMIN', 'MANAGER'] },
      { href: '/dishes',      label: 'Блюда',   icon: Utensils, roles: ['ADMIN', 'MANAGER', 'CHEF'] },
      { href: '/ingredients', label: 'Сырьё',   icon: Wheat,    roles: ['ADMIN', 'CHEF'] },
    ],
  },
  {
    id: 'analytics',
    title: 'Аналитика',
    items: [
      { href: '/reports',   label: 'Отчёты',    icon: FileBarChart, roles: ['ADMIN', 'MANAGER'] },
      { href: '/analytics', label: 'Аналитика', icon: TrendingUp,   roles: ['ADMIN', 'MANAGER'] },
    ],
  },
]

/**
 * Mobile-tabbar. Спец-маркер '__more__' рендерится как кнопка, открывающая
 * MobileDrawer со всеми NAV_GROUPS. Если у роли только один пункт (COURIER) —
 * 'more' не нужен, tabbar показывает одну плитку.
 */
export const MORE_HREF = '__more__'

export interface TabbarItem {
  href: string
  label: string
  icon: LucideIcon
}

export const MOBILE_TABBAR_BY_ROLE: Record<UserRole, TabbarItem[]> = {
  ADMIN: [
    { href: '/dashboard', label: 'Дашборд',  icon: LayoutDashboard },
    { href: '/inbox',     label: 'Inbox',    icon: Inbox },
    { href: '/orders',    label: 'Заказы',   icon: ClipboardList },
    { href: MORE_HREF,    label: 'Ещё',      icon: Menu },
  ],
  MANAGER: [
    { href: '/inbox',    label: 'Inbox',    icon: Inbox },
    { href: '/orders',   label: 'Заказы',   icon: ClipboardList },
    { href: '/delivery', label: 'Доставка', icon: Truck },
    { href: MORE_HREF,   label: 'Ещё',      icon: Menu },
  ],
  CHEF: [
    { href: '/production', label: 'Цех',    icon: ChefHat },
    { href: '/menu',       label: 'Меню',   icon: CalendarDays },
    { href: '/dishes',     label: 'Блюда',  icon: Utensils },
    { href: MORE_HREF,     label: 'Ещё',    icon: Menu },
  ],
  COURIER: [
    { href: '/delivery', label: 'Доставка', icon: Truck },
  ],
}

/** Стартовая страница после логина по роли. */
export const HOME_BY_ROLE: Record<UserRole, string> = {
  ADMIN: '/dashboard',
  MANAGER: '/orders',
  CHEF: '/production',
  COURIER: '/delivery',
}

/** Человеческие лейблы для роли — UI вывод (Sidebar profile, ProfileMenu). */
export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  CHEF: 'Шеф',
  COURIER: 'Курьер',
}
