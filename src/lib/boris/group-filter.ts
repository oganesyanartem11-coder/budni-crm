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

export type BorisChatType = 'private' | 'group' | 'supergroup' | 'channel'

export interface BorisAccess {
  /** Отвечать ли вообще (false → молча выйти). */
  respond: boolean
  /** Требуется ли идентификация: если true и user=null → reply «не нашёл». */
  requireIdentify: boolean
  /** Можно ли создавать mutate-pending (всегда требует идентифицированного user). */
  canMutate: boolean
  /** Персистить ли диалог в БД. false → stateless read-only (анонимная группа). */
  persistConversation: boolean
}

/**
 * П4: решение о доступе Бориса по типу чата и наличию идентифицированного user.
 *
 * Чистая функция (тестируемая без grammy-ctx). Семантика:
 *  - private: идентификация ОБЯЗАТЕЛЬНА. user=null → reply «не нашёл», диалога нет.
 *    С user — полный диалог; mutate возможен (финальный ярус role-проверки в agent.ts).
 *  - group/supergroup: идентификация ОПЦИОНАЛЬНА.
 *      • user есть → обычный персистируемый диалог (атрибуция), mutate всё равно
 *        запрещён в группе (canMutate=false — ярус chat-type в agent.ts).
 *      • user=null → read-only БЕЗ персистинга (BorisConversation.userId — required FK
 *        к User, фейк-юзеров не заводим). mutate невозможен (только READ-tools).
 *  - channel/прочее → respond=false.
 *
 * mutate в группе заблокирован ВСЕГДА: canMutate=false для любого group/supergroup,
 * вне зависимости от наличия user. Анонимная группа дополнительно изолирована тем,
 * что идёт по stateless read-only пути (READ-tools), где pending физически не строится.
 */
export function resolveBorisAccess(
  chatType: BorisChatType | undefined,
  hasUser: boolean,
): BorisAccess {
  if (chatType === 'private') {
    return {
      respond: true,
      requireIdentify: true,
      canMutate: hasUser, // финальный ярус (role=ADMIN_PRO) — в agent.ts
      persistConversation: hasUser,
    }
  }
  if (chatType === 'group' || chatType === 'supergroup') {
    return {
      respond: true,
      requireIdentify: false,
      canMutate: false, // в группе mutate запрещён всегда
      persistConversation: hasUser, // анонимная группа → stateless
    }
  }
  return { respond: false, requireIdentify: false, canMutate: false, persistConversation: false }
}
