import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ group: vi.fn(), resolve: vi.fn(), process: vi.fn(), log: vi.fn(), inbox: vi.fn() }))
vi.mock('@/lib/db/prisma', () => ({ prisma: { clientMaxGroup: { findUnique: mocks.group } } }))
vi.mock('@/lib/bot/max-users', () => ({ resolveClientByChatId: mocks.resolve }))
vi.mock('@/lib/bot/process-message', () => ({ processClientMessage: mocks.process }))
vi.mock('@/lib/bot/log-message', () => ({ logBotMessage: mocks.log }))
vi.mock('@/lib/bot/create-inbox-item', () => ({ createInboxItem: mocks.inbox }))
vi.mock('@/lib/bot/notify-client-signal', () => ({ notifyClientSignal: vi.fn() }))
vi.mock('@/lib/telegram/notify', () => ({ escapeHtml: (s: string) => s, notifyAllAdminProDirect: vi.fn() }))
vi.mock('@/lib/max/handlers/weekly', () => ({ handleWeeklyPhotoSubmission: vi.fn(), handleWeeklyTextSubmission: vi.fn() }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: vi.fn() }))
vi.mock('@/lib/max/client-message-lock', () => ({ withMaxClientLock: (_id: string, _message: unknown, run: () => Promise<void>) => run() }))
import { handleMessage } from './handlers'
import { maxGroupContext } from './group-context'

function ctx(text: string, userId = 1, extras = {}) {
  return { chatId: -42, message: { sender: { user_id: userId, name: `Участник ${userId}`, is_bot: false }, recipient: { chat_type: 'chat', chat_id: -42 }, body: { text, attachments: [] }, ...extras } } as never
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.group.mockResolvedValue({ isActive: true, clientId: 'c1' })
  mocks.resolve.mockResolvedValue({ id: 'c1', isActive: true, locations: [] })
  mocks.process.mockResolvedValue({ action: 'saved' })
})
describe('входящие группы', () => {
  it('оба участника отвечают за одного клиента в тот же чат', async () => {
    await handleMessage(ctx('8', 1))
    await handleMessage(ctx('9', 2))
    expect(mocks.process.mock.calls).toEqual([[{ maxChatId: '-42', text: '8' }], [{ maxChatId: '-42', text: '9' }]])
  })
  it('сохраняет автора во время обработки и не переносит контекст в другой запрос', async () => {
    mocks.process.mockImplementation(async () => {
      expect(maxGroupContext.getStore()).toEqual({ chatId: '-42', senderId: '2', senderName: 'Участник 2' })
      return { action: 'saved' }
    })
    await handleMessage(ctx('9', 2))
    expect(maxGroupContext.getStore()).toBeUndefined()
  })
  it('посторонняя беседа остаётся только в истории', async () => {
    await handleMessage(ctx('Встреча в 12:30'))
    expect(mocks.log).toHaveBeenCalled()
    expect(mocks.process).not.toHaveBeenCalled()
    expect(mocks.inbox).not.toHaveBeenCalled()
  })
  it('отключенная группа не меняет заказы', async () => {
    mocks.group.mockResolvedValue({ isActive: false })
    await handleMessage(ctx('8'))
    expect(mocks.process).not.toHaveBeenCalled()
  })
  it('упоминание бота с цифрами в username не попадает в парсер количества', async () => {
    await handleMessage(ctx('@id503018232259_bot 8'))
    expect(mocks.process).toHaveBeenCalledWith({ maxChatId: '-42', text: '8' })
  })
  it('reply боту распознаётся и в webhook без botInfo', async () => {
    await handleMessage(ctx('не надо', 1, { link: { type: 'reply', sender: { is_bot: true, username: 'id503018232259_bot' } } }))
    expect(mocks.process).toHaveBeenCalledWith({ maxChatId: '-42', text: 'не надо' })
  })
  it('сообщение другого бота не вызывает петлю', async () => {
    await handleMessage(ctx('8', 1, { sender: { is_bot: true } }))
    expect(mocks.process).not.toHaveBeenCalled()
  })
})
