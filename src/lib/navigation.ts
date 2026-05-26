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
  FileText,
  TrendingUp,
  Inbox,
  Menu,
  Sparkles,
  ReceiptText,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'
import type { UserRole } from '@prisma/client'

// 7.14A: ROLE_LABELS переехал в @/lib/constants/roles — единая точка истины
// для лейблов/цветов/описаний ролей. Реэкспортируем здесь, чтобы существующие
// импорты `import { ROLE_LABELS } from '@/lib/navigation'` не сломались.
export { ROLE_LABELS } from '@/lib/constants/roles'

export type NavBadgeKey = 'pendingCount' | 'inboxCount' | 'invoicesAwaitingCount'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: UserRole[]
  badge?: NavBadgeKey
  /**
   * Если задано — пункт рендерится как раскрываемый узел с под-ссылками.
   * Сам href узла используется как «активный» матч (startsWith) и
   * default-таргет клика (но клик по узлу открывает/закрывает аккордеон,
   * не переходит — см. sidebar.tsx). Каждый child фильтруется по roles
   * отдельно: ребёнок с роль-mismatch скрывается, а если ВСЕ дети скрыты,
   * скрывается и сам узел.
   */
  children?: NavItem[]
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
// 7.14A: ADMIN_PRO видит всё, что видит ADMIN, поэтому добавлен в каждый
// items.roles рядом с 'ADMIN'. Эксклюзивные пункты ADMIN_PRO (если появятся,
// напр. /invoices) добавляются с `roles: ['ADMIN_PRO']` без ADMIN.
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'daily',
    title: 'Ежедневно',
    items: [
      { href: '/dashboard', label: 'Дашборд',  icon: LayoutDashboard, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
      { href: '/inbox',     label: 'Inbox',    icon: Inbox,           roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'], badge: 'inboxCount' },
      { href: '/orders',    label: 'Заказы',   icon: ClipboardList,   roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'], badge: 'pendingCount' },
      { href: '/delivery',  label: 'Доставка', icon: Truck,           roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'COURIER'] },
    ],
  },
  {
    id: 'production',
    title: 'Производство',
    items: [
      { href: '/production',    label: 'Производство', icon: ChefHat,      roles: ['ADMIN_PRO', 'ADMIN', 'CHEF', 'MANAGER'] },
      { href: '/menu',          label: 'Меню недели',  icon: CalendarDays, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
      { href: '/menu/imports',  label: 'Импорт меню',  icon: Sparkles,     roles: ['ADMIN_PRO', 'ADMIN', 'CHEF'] },
      { href: '/invoices',      label: 'Накладные',    icon: ReceiptText,  roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'], badge: 'invoicesAwaitingCount' },
    ],
  },
  {
    id: 'directory',
    title: 'Справочники',
    items: [
      { href: '/clients',     label: 'Клиенты', icon: Users,    roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
      { href: '/dishes',      label: 'Блюда',   icon: Utensils, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
      { href: '/ingredients', label: 'Сырьё',   icon: Wheat,    roles: ['ADMIN_PRO', 'ADMIN', 'CHEF'] },
    ],
  },
  {
    id: 'analytics',
    title: 'Аналитика',
    items: [
      // 7.MEGA-CLEANUP / BLOCK A: единый раскрываемый узел «Аналитика» с под-ссылками.
      // Сам узел не имеет своей страницы — href здесь используется только
      // как ключ активного состояния (startsWith). Клик по узлу открывает
      // аккордеон, переходов нет — переходы по children.
      {
        href: '/analytics',
        label: 'Аналитика',
        icon: BarChart3,
        // Объединение всех ролей дочерних пунктов: если у роли есть хотя бы
        // одна доступная подссылка — узел показывается.
        roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'],
        children: [
          { href: '/analytics/cost',     label: 'Себестоимость', icon: TrendingUp,   roles: ['ADMIN_PRO', 'ADMIN'] },
          { href: '/analytics/invoices', label: 'Приёмки',       icon: ReceiptText,  roles: ['ADMIN_PRO'] },
          { href: '/reports',            label: 'Отчёты',        icon: FileText,     roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
          { href: '/analytics',          label: 'Сводка',        icon: FileBarChart, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
        ],
      },
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
  // 7.14A: ADMIN_PRO повторяет раскладку ADMIN — дополнительные функции
  // (приёмка накладных) доступны через /invoices и пункт в "Ещё".
  ADMIN_PRO: [
    { href: '/dashboard', label: 'Дашборд',  icon: LayoutDashboard },
    { href: '/inbox',     label: 'Inbox',    icon: Inbox },
    { href: '/orders',    label: 'Заказы',   icon: ClipboardList },
    { href: MORE_HREF,    label: 'Ещё',      icon: Menu },
  ],
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
  ADMIN_PRO: '/dashboard',
  ADMIN: '/dashboard',
  MANAGER: '/orders',
  CHEF: '/production',
  COURIER: '/delivery',
}
