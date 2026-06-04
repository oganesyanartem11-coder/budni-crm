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
  Bot,
  Home,
  ShoppingBag,
  Factory,
  Settings,
  UserCircle,
  type LucideIcon,
} from 'lucide-react'
import type { UserRole } from '@prisma/client'

// 7.14A: ROLE_LABELS переехал в @/lib/constants/roles — единая точка истины
// для лейблов/цветов/описаний ролей. Реэкспортируем здесь, чтобы существующие
// импорты `import { ROLE_LABELS } from '@/lib/navigation'` не сломались.
export { ROLE_LABELS } from '@/lib/constants/roles'

// ── Волна 2: реструктуризация навигации (было 5 групп → стало 3) ────────────
// Mapping старое→новое (по каждому пункту):
//   daily/dashboard       → TOP_NAV (рендерится перед группами, не в группе)
//   daily/inbox           → sales
//   daily/orders          → sales
//   daily/delivery        → more
//   production/production  → production
//   production/menu        → sales (Меню недели)
//   production/menu/imports→ sales (Импорт меню) [плоско — см. TODO 1]
//   production/invoices    → production (Накладные)
//   directory/clients      → sales
//   directory/dishes       → sales
//   directory/ingredients  → production (Сырьё)
//   analytics/<accordion>  → more (раскрываемый узел «Аналитика», как есть)
//   boris/boris            → BOTTOM_NAV (рендерится после групп)
//   (новый) settings       → more (Настройки)
// ─────────────────────────────────────────────────────────────────────────

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

export type NavGroupId = 'sales' | 'production' | 'more'

export interface NavGroup {
  id: NavGroupId
  title: string
  items: NavItem[]
}

/**
 * Top-level пункт(ы), которые рендерятся ПЕРЕД группами (B рендерит
 * TOP_NAV → NAV_GROUPS → BOTTOM_NAV). Фильтруются по roles, как и любой NavItem.
 */
export const TOP_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Дашборд', icon: LayoutDashboard, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
]

/**
 * Группы навигации для Sidebar (десктоп) и MobileDrawer.
 * Порядок групп = вертикальный порядок в Sidebar: sales → production → more.
 * Внутри группы видны только пункты, чья roles содержит текущую роль —
 * пустая после фильтрации группа в Sidebar/Drawer не рендерится.
 */
// 7.14A: ADMIN_PRO видит всё, что видит ADMIN, поэтому добавлен в каждый
// items.roles рядом с 'ADMIN'. Эксклюзивные пункты ADMIN_PRO (если появятся,
// напр. /invoices) добавляются с `roles: ['ADMIN_PRO']` без ADMIN.
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'sales',
    title: 'Продажи',
    items: [
      { href: '/orders',        label: 'Заказы',      icon: ClipboardList, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'], badge: 'pendingCount' },
      { href: '/inbox',         label: 'Inbox',       icon: Inbox,         roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'], badge: 'inboxCount' },
      { href: '/clients',       label: 'Клиенты',     icon: Users,         roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER'] },
      { href: '/menu',          label: 'Меню недели', icon: CalendarDays,  roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
      // TODO Артём: menu/imports оставлен ПЛОСКО (не вложен в menu) — см. todosForArtem #1.
      { href: '/menu/imports',  label: 'Импорт меню', icon: Sparkles,      roles: ['ADMIN_PRO', 'ADMIN', 'CHEF'] },
      { href: '/dishes',        label: 'Блюда',       icon: Utensils,      roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'] },
    ],
  },
  {
    id: 'production',
    title: 'Производство',
    items: [
      { href: '/production',  label: 'Производство', icon: ChefHat,     roles: ['ADMIN_PRO', 'ADMIN', 'CHEF', 'MANAGER'] },
      { href: '/invoices',    label: 'Поставки',    icon: ReceiptText, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'], badge: 'invoicesAwaitingCount' },
      { href: '/ingredients', label: 'Сырьё',        icon: Wheat,       roles: ['ADMIN_PRO', 'ADMIN', 'CHEF'] },
    ],
  },
  {
    id: 'more',
    title: 'Ещё',
    items: [
      { href: '/delivery', label: 'Доставка', icon: Truck, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'COURIER'] },
      // 7.MEGA-CLEANUP / BLOCK A: единый раскрываемый узел «Аналитика» с под-ссылками.
      // Сам узел не имеет своей страницы — href здесь используется только
      // как ключ активного состояния (startsWith). Клик по узлу открывает
      // аккордеон, переходов нет — переходы по children. Скопирован как есть.
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
      // Новый пункт. roles зеркалят guard страницы: /settings вызывает
      // requireRole(['ADMIN']); ADMIN_PRO видит всё, что ADMIN → ['ADMIN_PRO','ADMIN'].
      // См. todosForArtem #3.
      { href: '/settings', label: 'Настройки', icon: Settings, roles: ['ADMIN_PRO', 'ADMIN'] },
    ],
  },
]

/**
 * Top-level пункт(ы), которые рендерятся ПОСЛЕ групп (B рендерит
 * TOP_NAV → NAV_GROUPS → BOTTOM_NAV). Фильтруются по roles.
 */
export const BOTTOM_NAV: NavItem[] = [
  { href: '/boris', label: 'Борис', icon: Bot, roles: ['ADMIN_PRO'] },
  // П5/MEGA-1: смена своего PIN доступна КАЖДОМУ залогиненному. Сама страница
  // /settings/profile роле-агностична (getCurrentUser), но /settings и сайдбар
  // гейтятся под ADMIN — поэтому даём прямую ссылку «Профиль» всем 5 ролям,
  // в самом низу сайдбара (после групп и Бориса).
  { href: '/settings/profile', label: 'Профиль', icon: UserCircle, roles: ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF', 'COURIER'] },
]

export interface TabbarItem {
  href: string
  label: string
  icon: LucideIcon
  badge?: NavBadgeKey
}

export const MOBILE_TABBAR_BY_ROLE: Record<UserRole, TabbarItem[]> = {
  // Волна 2: 5 вкладок; последняя «Ещё» ведёт прямой ссылкой на /more
  // (drawer-маркер MORE_HREF удалён).
  ADMIN_PRO: [
    { href: '/dashboard',  label: 'Главная',      icon: Home },
    { href: '/inbox',      label: 'Inbox',        icon: Bot,         badge: 'inboxCount' },
    { href: '/orders',     label: 'Продажи',      icon: ShoppingBag, badge: 'pendingCount' },
    { href: '/production', label: 'Производство', icon: Factory },
    { href: '/more',       label: 'Ещё',          icon: Menu },
  ],
  ADMIN: [
    { href: '/dashboard',  label: 'Главная',      icon: Home },
    { href: '/inbox',      label: 'Inbox',        icon: Bot,         badge: 'inboxCount' },
    { href: '/orders',     label: 'Продажи',      icon: ShoppingBag, badge: 'pendingCount' },
    { href: '/production', label: 'Производство', icon: Factory },
    { href: '/more',       label: 'Ещё',          icon: Menu },
  ],
  // MANAGER входит в roles dashboard (TOP_NAV) и production (NAV_GROUPS) — те же 5 вкладок.
  MANAGER: [
    { href: '/dashboard',  label: 'Главная',      icon: Home },
    { href: '/inbox',      label: 'Inbox',        icon: Bot,         badge: 'inboxCount' },
    { href: '/orders',     label: 'Продажи',      icon: ShoppingBag, badge: 'pendingCount' },
    { href: '/production', label: 'Производство', icon: Factory },
    { href: '/more',       label: 'Ещё',          icon: Menu },
  ],
  CHEF: [
    { href: '/production', label: 'Цех',   icon: ChefHat },
    { href: '/menu',       label: 'Меню',  icon: CalendarDays },
    { href: '/dishes',     label: 'Блюда', icon: Utensils },
    { href: '/more',       label: 'Ещё',   icon: Menu },
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
