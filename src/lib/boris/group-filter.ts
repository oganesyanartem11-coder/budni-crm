import type { Context } from 'grammy'

/**
 * Проверяет упоминание слова «Борис» в тексте (любое склонение,
 * любое место). Word boundary для кириллицы — через Unicode property
 * classes \p{L}\p{N} с флагом /u (стандартный \b НЕ работает
 * с русскими буквами в JS).
 *
 * Совпадает: «Борис, …», «спроси Бориса», «БОРИС подскажи», «нам Борис»
 * НЕ совпадает: «борисович», «Borisbot», «borisич»
 */
export function mentionsBoris(text: string): boolean {
  if (!text) return false
  return /(?:^|[^\p{L}\p{N}])борис(а|у|ом|е|ами|ы)?(?=[^\p{L}\p{N}]|$)/iu.test(text)
}

/**
 * Должен ли Борис отвечать на это сообщение?
 *
 * - В private (личка) — всегда true: семантика «диалог 1-на-1»
 * - В group/supergroup — true только если text содержит «Борис» как
 *   отдельное слово. Без явного адресного обращения молчим, чтобы
 *   не лезть в чужие переписки и не жечь LLM на мусор.
 * - В channel и других типах — false (не наша зона).
 */
export function shouldRespondInChat(ctx: Context): boolean {
  const chatType = ctx.chat?.type
  if (chatType === 'private') return true
  if (chatType === 'group' || chatType === 'supergroup') {
    const text = ctx.message?.text ?? ''
    return mentionsBoris(text)
  }
  return false
}
