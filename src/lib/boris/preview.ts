/**
 * Boris multi-action preview builder.
 *
 * Собирает HTML-сообщение для Telegram (parse_mode: HTML), которое показывается
 * пользователю перед подтверждением одного или нескольких pending-действий.
 *
 * Используется agent.ts (B2): после того как LLM вернул tool_use, мы аккумулируем
 * pending-actions и просим юзера подтвердить — текст этого confirm-сообщения
 * строится именно тут.
 *
 * Sprint 7.16.A.2, блок B4.
 */

export interface PendingActionForPreview {
  /** Имя tool: 'edit_order_portions', 'cancel_order', 'create_one_time_order', ... */
  tool: string
  /** Сырой input от LLM (валидированный по zod-схеме tool'а). */
  input: Record<string, unknown>
  /** Опциональный готовый preview-текст от tool.execute (приоритет над fallback). */
  preview?: string
}

export interface PreviewContext {
  /**
   * Опциональные обогащения. На момент Sprint 7.16.A.2 не используются —
   * закладываем типы под будущие итерации (B5+), когда будем подмешивать
   * человекочитаемые имена клиентов/точек вместо id.
   */
  resolvedClientNames?: Record<string, string>
  resolvedLocationNames?: Record<string, string>
}

/**
 * Заголовки по tool name. unknown tool → `Действие: ${tool}`.
 */
const TOOL_TITLES: Record<string, string> = {
  edit_order_portions: 'Изменение порций',
  cancel_order: 'Отмена заказа',
  restore_order: 'Восстановление заказа',
  create_one_time_order: 'Новый разовый заказ',
  reschedule_order: 'Перенос заказа',
  add_order_note: 'Заметка к заказу',
}

function getTitle(tool: string): string {
  return TOOL_TITLES[tool] ?? `Действие: ${tool}`
}

/**
 * Telegram HTML parse_mode требует экранирования &, <, > в любых вставляемых
 * данных. " и ' экранировать не нужно (HTML mode не использует quoted-атрибуты
 * для встроенных тегов).
 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Fallback formatter, если у action.preview не задан.
 * Используется когда tool.execute не вернул собственный preview-блок
 * (или мы строим preview ДО вызова tool.execute — что и есть основной кейс
 * в подтвержд-флоу).
 */
function fallbackBody(action: PendingActionForPreview): string {
  const { tool, input } = action

  switch (tool) {
    case 'edit_order_portions':
      return `Заказ ${escapeHtml(input.orderId)}: → ${escapeHtml(input.portions)} порций`

    case 'cancel_order': {
      const reason = input.reason ? `: ${escapeHtml(input.reason)}` : ''
      return `Заказ ${escapeHtml(input.orderId)}${reason}`
    }

    case 'restore_order':
      return `Заказ ${escapeHtml(input.orderId)}`

    case 'create_one_time_order':
      return (
        `Клиент ${escapeHtml(input.clientId)}, ` +
        `${escapeHtml(input.deliveryDate)}, ` +
        `${escapeHtml(input.mealType)}, ` +
        `${escapeHtml(input.portions)} порций`
      )

    case 'reschedule_order':
      return `Заказ ${escapeHtml(input.orderId)} → ${escapeHtml(input.newDate)}`

    case 'add_order_note': {
      const noteRaw = String(input.note ?? '')
      const sliced = noteRaw.slice(0, 60)
      const ellipsis = noteRaw.length > 60 ? '…' : ''
      return `Заказ ${escapeHtml(input.orderId)}: «${escapeHtml(sliced)}${ellipsis}»`
    }

    default:
      // Без специфичного форматтера — сериализуем input как fallback (escape on).
      try {
        return escapeHtml(JSON.stringify(input))
      } catch {
        return '(нет данных)'
      }
  }
}

/**
 * Готовый body для одного action: action.preview (если есть) иначе fallback.
 * Если используется action.preview — он не экранируется (предполагается, что
 * tool.execute уже сам собрал безопасный текст или сделал escape).
 */
function bodyFor(action: PendingActionForPreview): string {
  if (action.preview && action.preview.trim().length > 0) {
    return action.preview
  }
  return fallbackBody(action)
}

/**
 * Главный экспорт — собирает HTML-preview для одной или нескольких pending-actions.
 *
 * Edge case: пустой массив → возвращаем сообщение-плейсхолдер
 * («Нет действий для выполнения»). Это защита от логических багов в agent.ts —
 * confirm-сообщение всё равно бессмысленно без действий, но мы не падаем.
 */
export function buildMultiActionPreview(
  actions: PendingActionForPreview[],
  _context?: PreviewContext,
): string {
  if (!actions || actions.length === 0) {
    return 'Нет действий для выполнения.'
  }

  // Одиночный action: компактный preview с заголовком конкретного tool.
  if (actions.length === 1) {
    const action = actions[0]
    const title = getTitle(action.tool)
    const body = bodyFor(action)
    return `📋 <b>${escapeHtml(title)}</b>\n\n${body}\n\nПодтверждаешь?`
  }

  // Несколько действий: нумерованный список.
  const header = `📋 <b>Запланировано ${actions.length} действий:</b>`
  const items = actions
    .map((action, idx) => {
      const title = getTitle(action.tool)
      const body = bodyFor(action)
      // Отступ в две пробельные единицы для каждой строки тела (читаемее в TG).
      const indentedBody = body
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n')
      return `${idx + 1}) <b>${escapeHtml(title)}</b>\n${indentedBody}`
    })
    .join('\n\n')

  return `${header}\n\n${items}\n\nПодтверждаешь все?`
}
