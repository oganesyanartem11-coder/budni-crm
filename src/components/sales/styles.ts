/**
 * Sprint 8.0 «Продажи»: общие классы UI воронки (/sales, карточка заявки,
 * модалки). Только токен-классы дизайн-системы, touch-цели ≥44px (min-h-11).
 */

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface'

/** Основная капсула (чёрная, с тенью капсулы). */
export const CAPSULE_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none [touch-action:manipulation] ' +
  FOCUS_RING

/** Вторичная капсула (контурная). */
export const CAPSULE_OUTLINE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-pill border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none [touch-action:manipulation] ' +
  FOCUS_RING

/** Квадратная (круглая) иконка-кнопка 44×44. */
export const ICON_BUTTON =
  'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill border border-border bg-surface text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none [touch-action:manipulation] ' +
  FOCUS_RING

/** Карточка-секция. */
export const CARD_CLASS = 'rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5'

export const SECTION_TITLE_CLASS = 'font-display text-base font-bold text-fg-strong'

/** Поля ввода (как в client-form: 44px, rounded-xl). */
export const INPUT_CLASS =
  'w-full min-h-11 rounded-xl border border-border bg-surface px-3 py-2.5 text-base text-fg placeholder:text-fg-subtle transition-colors focus:border-brand-green focus:outline-none focus:ring-1 focus:ring-brand-green/30 disabled:opacity-50 [touch-action:manipulation]'

export const TEXTAREA_CLASS = INPUT_CLASS + ' resize-none'

export const SELECT_TRIGGER_CLASS =
  'w-full !h-auto min-h-11 rounded-xl border-border bg-surface px-3 py-2.5 text-base text-fg transition-colors data-placeholder:text-fg-subtle focus-visible:border-brand-green focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-green/30 [touch-action:manipulation]'

/** Выбираемый чип (тип задачи, слот, фильтр). */
export const CHOICE_CHIP_BASE =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-pill px-4 py-2 text-sm font-medium transition-colors motion-reduce:transition-none [touch-action:manipulation] disabled:cursor-not-allowed disabled:opacity-50 ' +
  FOCUS_RING
export const CHOICE_CHIP_IDLE = 'border border-border bg-surface text-fg hover:bg-surface-2'
export const CHOICE_CHIP_ACTIVE = 'border border-primary bg-primary text-primary-foreground'

/** Мелкий информационный чип (форма/источник). */
export const META_CHIP =
  'inline-flex max-w-full items-center rounded-pill bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg-muted'

export const FIELD_LABEL_CLASS = 'mb-1.5 block text-xs font-bold uppercase tracking-wide text-fg-muted'

/** Карточка диалога воронки: помещается в экран 375px и скроллится внутри. */
export const DIALOG_CONTENT_CLASS = 'max-h-[calc(100dvh-2rem)] overflow-y-auto bg-surface sm:max-w-md'

/** Капсула необратимого/негативного действия (отказ, удаление). */
export const CAPSULE_DANGER =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-pill bg-danger-fg px-5 py-2.5 text-sm font-semibold text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none [touch-action:manipulation] ' +
  FOCUS_RING
