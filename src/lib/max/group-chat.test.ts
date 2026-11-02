import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  clientMaxGroup: { findUnique: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: db }))
import { bindGroup, handleBotRemoved, isGroupOrderMessage } from './group-chat'

beforeEach(() => {
  vi.resetAllMocks()
  db.$transaction.mockImplementation((fn) => fn(db))
  db.clientMaxGroup.updateMany.mockResolvedValue({ count: 1 })
})

describe('сообщения группы', () => {
  it.each(['8', 'На завтра 8 порций', 'обед 8, ужин 10', 'с 7 по 14 +1 обед', 'без изменений', 'аналогично', 'добавьте 2', 'давайте 7 на пятницу', 'С 03.11.26 33 порции стабильно'])('принимает %s', (text) => {
    expect(isGroupOrderMessage(text, false, false)).toBe(true)
  })
  it.each(['Привет!', 'увидимся завтра', 'Встреча в 12:30', '+79991234567', 'Код 123456', 'Счёт 123 оплачен'])('пропускает переписку %s', (text) => {
    expect(isGroupOrderMessage(text, false, false)).toBe(false)
  })
  it('фото недельной заявки можно прислать без подписи', () => {
    expect(isGroupOrderMessage('', false, true, true)).toBe(true)
  })
  it('ответ на вопрос бота передаёт существующему обработчику', () => {
    expect(isGroupOrderMessage('Завтра не нужно', true, false)).toBe(true)
    expect(isGroupOrderMessage('', true, true)).toBe(true)
  })
})

describe('одноразовая привязка', () => {
  const invite = { id: 'g1', clientId: 'c1', client: { name: 'Клиент', isActive: true }, expiresAt: new Date('2099-01-01') }
  it('потребляет токен атомарно и привязывает чат', async () => {
    db.clientMaxGroup.findUnique.mockResolvedValueOnce(invite).mockResolvedValueOnce(null)
    expect(await bindGroup('-42', 'token')).toContain('Группа подключена')
    expect(db.clientMaxGroup.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ chatId: '-42', token: null, isActive: true }) }))
  })
  it('истёкший код не привязывает чат', async () => {
    db.clientMaxGroup.findUnique.mockResolvedValue({ ...invite, expiresAt: new Date(0) })
    expect(await bindGroup('-42', 'token')).toContain('истёк')
    expect(db.clientMaxGroup.updateMany).not.toHaveBeenCalled()
  })
  it('не переносит группу чужого клиента', async () => {
    db.clientMaxGroup.findUnique.mockResolvedValueOnce(invite).mockResolvedValueOnce({ clientId: 'other' })
    expect(await bindGroup('-42', 'token')).toContain('другому клиенту')
    expect(db.clientMaxGroup.updateMany).not.toHaveBeenCalled()
  })
  it('второе одновременное использование кода не срабатывает', async () => {
    db.clientMaxGroup.findUnique.mockResolvedValueOnce(invite).mockResolvedValueOnce(null)
    db.clientMaxGroup.updateMany.mockResolvedValue({ count: 0 })
    expect(await bindGroup('-42', 'token')).toContain('уже использован')
    expect(db.activityLog.create).not.toHaveBeenCalled()
  })
  it('при удалении бота из группы отключает рассылку', async () => {
    await handleBotRemoved({ chatId: -42 } as never)
    expect(db.clientMaxGroup.updateMany).toHaveBeenCalledWith({ where: { chatId: '-42' }, data: { isActive: false } })
  })
})
