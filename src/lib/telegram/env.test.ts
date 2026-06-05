import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readProductionChatId } from './env'

/**
 * П1-фикс: readProductionChatId принимает id любой группы (ведущий минус), а не
 * только супергруппы «-100…». Раньше обычная группа «-49…» отвергалась → пуши
 * (сводка 16:05, курьерский обзор) уходили в личку ADMIN_PRO вместо чата.
 */
const KEY = 'TELEGRAM_PRODUCTION_CHAT_ID'

describe('readProductionChatId', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const original = process.env[KEY]

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env[KEY]
  })
  afterEach(() => {
    warnSpy.mockRestore()
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
  })

  it('супергруппа «-100…» → возвращает строку', () => {
    process.env[KEY] = '-1001234567890'
    expect(readProductionChatId()).toBe('-1001234567890')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('обычная группа «-49…» → возвращает строку (главный кейс фикса)', () => {
    process.env[KEY] = '-491234567890'
    expect(readProductionChatId()).toBe('-491234567890')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('без минуса → null + warning', () => {
    process.env[KEY] = '491234567890'
    expect(readProductionChatId()).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('пробелы → null без warning (trim → пусто)', () => {
    process.env[KEY] = '   '
    expect(readProductionChatId()).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('не задан (undefined) → null без warning', () => {
    delete process.env[KEY]
    expect(readProductionChatId()).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('значение с обрамляющими пробелами → trim и принимается', () => {
    process.env[KEY] = '  -491234567890  '
    expect(readProductionChatId()).toBe('-491234567890')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
