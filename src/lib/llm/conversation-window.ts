/**
 * Безопасное сужение истории Anthropic-сообщений до окна заданного размера.
 *
 * Зачем нужно: Action-Борис (Спринт 7.16.D) шлёт в API только последние N
 * BorisMessage чтобы input не рос линейно. Простой `slice(-N)` ломается, если
 * граница окна попадает между assistant.tool_use и user.tool_result —
 * Anthropic API на orphan tool_result отвечает 400.
 *
 * Стратегия: сначала пытаемся РАСШИРИТЬ окно назад на пару сообщений, чтобы
 * захватить parent assistant (по запросу владельца: «отдать на 1-2 message
 * больше чем заломить пару»). Если за `MAX_EXPAND_BACK` шагов не нашли
 * безопасный старт — сдвигаем вперёд, дропая проблемные user-сообщения.
 *
 * Контракт:
 *  - input: упорядоченный array MessageParam (asc по времени)
 *  - output: subset того же array (по ссылочно — это не copy блоков, только
 *    обрезка границ)
 */
import type Anthropic from '@anthropic-ai/sdk'

type Message = Anthropic.Messages.MessageParam

/**
 * Сколько сообщений мы готовы захватить ДО начала окна, чтобы спасти
 * tool_use ↔ tool_result пару от обрезания. Покрывает случай нескольких
 * tool_use'ов в одном assistant-блоке.
 */
const MAX_EXPAND_BACK = 5

export function clipConversationWindow(
  messages: Message[],
  windowSize: number,
): Message[] {
  if (windowSize <= 0) return []
  if (messages.length <= windowSize) return messages.slice()

  let startIdx = messages.length - windowSize

  // 1. Расширяем окно НАЗАД пока стартовая граница небезопасна.
  let expanded = 0
  while (
    startIdx > 0 &&
    expanded < MAX_EXPAND_BACK &&
    !isSafeStart(messages, startIdx)
  ) {
    startIdx--
    expanded++
  }

  // 2. Если расширение исчерпано, но всё ещё orphan — сдвигаем ВПЕРЁД,
  // дропая сообщения с orphan tool_result. Это потеря 1-N user-блоков,
  // но безопаснее чем 400 от Anthropic.
  while (
    startIdx < messages.length &&
    !isSafeStart(messages, startIdx)
  ) {
    startIdx++
  }

  return messages.slice(startIdx)
}

/**
 * Безопасный старт окна: первое сообщение НЕ должно содержать tool_result.
 * - user со string content → ok
 * - user с array content без tool_result-блоков → ok
 * - assistant (любой) → ok (это не tool_result-владелец, его tool_use может
 *   быть закрыт следующим user.tool_result, всё внутри окна)
 * - user с array content, в котором есть хоть один tool_result → НЕ ok
 *   (parent tool_use где-то раньше; либо он влез благодаря расширению,
 *   либо точно вне окна — orphan)
 */
function isSafeStart(messages: Message[], startIdx: number): boolean {
  const msg = messages[startIdx]
  if (!msg) return true
  if (msg.role === 'assistant') return true
  // role === 'user'
  if (typeof msg.content === 'string') return true
  for (const block of msg.content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'tool_result'
    ) {
      return false
    }
  }
  return true
}
