import {
  LayoutDashboard,
  ClipboardList,
  Building2,
  UtensilsCrossed,
  Carrot,
  ChefHat,
  Truck,
  BarChart3,
  Settings,
  CalendarDays,
  FileBarChart,
  type LucideIcon,
} from 'lucide-react'

export type NavSection = {
  href: string
  label: string
  icon: LucideIcon
  // Кому показывать раздел (если undefined — показываем всем)
  roles?: Array<'ADMIN' | 'MANAGER' | 'CHEF' | 'COURIER'>
}

// Главное меню в топ-навигации
export const TOP_NAV_SECTIONS: NavSection[] = [
  { href: '/dashboard', label: 'Дашборд', icon: LayoutDashboard, roles: ['ADMIN', 'MANAGER'] },
  { href: '/orders', label: 'Заказы', icon: ClipboardList, roles: ['ADMIN', 'MANAGER'] },
  { href: '/clients', label: 'Клиенты', icon: Building2, roles: ['ADMIN', 'MANAGER'] },
  { href: '/dishes', label: 'Блюда', icon: UtensilsCrossed, roles: ['ADMIN', 'MANAGER', 'CHEF'] },
  { href: '/menu', label: 'Меню', icon: CalendarDays, roles: ['ADMIN', 'MANAGER', 'CHEF'] },
  { href: '/ingredients', label: 'Сырьё', icon: Carrot, roles: ['ADMIN', 'CHEF'] },
  { href: '/production', label: 'Производство', icon: ChefHat, roles: ['ADMIN', 'CHEF'] },
  { href: '/delivery', label: 'Доставка', icon: Truck, roles: ['ADMIN', 'MANAGER', 'COURIER'] },
  { href: '/reports', label: 'Отчёты', icon: FileBarChart, roles: ['ADMIN', 'MANAGER'] },
  { href: '/analytics', label: 'Аналитика', icon: BarChart3, roles: ['ADMIN'] },
]

// Только для админа в выпадашке профиля
export const ADMIN_NAV_SECTIONS: NavSection[] = [
  { href: '/settings', label: 'Настройки', icon: Settings, roles: ['ADMIN'] },
]

// Мобильный таббар — приоритет роли курьера на главные функции
export const MOBILE_TABBAR_BY_ROLE = {
  COURIER: [
    { href: '/delivery', label: 'Доставка', icon: Truck },
  ],
  MANAGER: [
    { href: '/orders', label: 'Заказы', icon: ClipboardList },
    { href: '/clients', label: 'Клиенты', icon: Building2 },
    { href: '/delivery', label: 'Доставка', icon: Truck },
    { href: '/reports', label: 'Отчёты', icon: FileBarChart },
  ],
  CHEF: [
    { href: '/production', label: 'Цех', icon: ChefHat },
    { href: '/dishes', label: 'Блюда', icon: UtensilsCrossed },
    { href: '/ingredients', label: 'Сырьё', icon: Carrot },
    { href: '/menu', label: 'Меню', icon: CalendarDays },
  ],
  ADMIN: [
    { href: '/dashboard', label: 'Дашборд', icon: LayoutDashboard },
    { href: '/orders', label: 'Заказы', icon: ClipboardList },
    { href: '/production', label: 'Цех', icon: ChefHat },
    { href: '/reports', label: 'Отчёты', icon: FileBarChart },
  ],
} as const

// Стартовая страница после логина — по роли
export const HOME_BY_ROLE = {
  ADMIN: '/dashboard',
  MANAGER: '/orders',
  CHEF: '/production',
  COURIER: '/delivery',
} as const
