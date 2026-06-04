/**
 * Тесты строгого резолвера клиента (MEGA-4a, фикс П6).
 */
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { normalizeClientName, resolveClient, type ResolvedClient } from './client-resolver'

type StubLocation = { id: string; sameDayDelivery: boolean; isActive: boolean }

/** Минимальный фабричный helper для Client-стаба (с локациями для same-day). */
function client(
  name: string,
  isActive = true,
  id = name,
  locations: StubLocation[] = []
): ResolvedClient {
  return { id, name, isActive, locations } as unknown as ResolvedClient
}

/**
 * Стаб prisma: findMany имитирует ILIKE contains (case-insensitive) + isActive.
 * Резолвер сам делает строгую категоризацию в памяти — стабу достаточно
 * корректно отдать «широкую» выборку (с уже подгруженными locations).
 */
function makePrisma(all: ResolvedClient[]): PrismaClient {
  const findMany = vi.fn(async (args: {
    where: { isActive?: boolean; name?: { contains?: string } }
  }) => {
    const needle = (args.where.name?.contains ?? '').toLowerCase()
    return all.filter((c) => {
      if (args.where.isActive === true && !c.isActive) return false
      return c.name.toLowerCase().includes(needle)
    })
  })
  return { client: { findMany } } as unknown as PrismaClient
}

describe('normalizeClientName', () => {
  it('убирает ООО и кавычки', () => {
    expect(normalizeClientName('ООО "ИНПАРТ АВТО"')).toBe('инпарт авто')
  })

  it('убирает ИП как отдельный токен', () => {
    expect(normalizeClientName('ИП Комель Денис')).toBe('комель денис')
  })

  it('collapse двойных пробелов', () => {
    expect(normalizeClientName('инпарт   авто')).toBe('инпарт авто')
  })

  it('убирает разные виды кавычек', () => {
    expect(normalizeClientName('«ИНПАРТ» “АВТО”')).toBe('инпарт авто')
  })

  it('не режет юр.форму внутри слова', () => {
    // «иполит» содержит «ип» как подстроку, но НЕ как отдельный токен.
    expect(normalizeClientName('Иполит')).toBe('иполит')
  })

  it('обрабатывает прочие юр.формы (АО/ЗАО/ПАО)', () => {
    expect(normalizeClientName('ЗАО Ромашка')).toBe('ромашка')
    expect(normalizeClientName('ПАО Сбер')).toBe('сбер')
    expect(normalizeClientName('АО Тест')).toBe('тест')
  })
})

describe('resolveClient', () => {
  it('exact === 1 → suggested, rejected=null', async () => {
    const prisma = makePrisma([client('Сириус'), client('Другой')])
    const r = await resolveClient('сириус', prisma)
    expect(r.suggested?.name).toBe('Сириус')
    expect(r.rejected).toBeNull()
    expect(r.exact).toHaveLength(1)
  })

  it('exact 0 + startsWith 1 → suggested', async () => {
    const prisma = makePrisma([client('Инпарт Логистика'), client('Розница соседи')])
    const r = await resolveClient('инпарт', prisma)
    expect(r.exact).toHaveLength(0)
    expect(r.startsWith).toHaveLength(1)
    expect(r.suggested?.name).toBe('Инпарт Логистика')
    expect(r.rejected).toBeNull()
  })

  it('паразитный contains x3 → ambiguous, suggested=null, candidates=3', async () => {
    const prisma = makePrisma([
      client('Розница Инпарт соседи'),
      client('Сеть Инпарт регион'),
      client('Маркет Инпарт центр'),
    ])
    const r = await resolveClient('инпарт', prisma)
    expect(r.suggested).toBeNull()
    expect(r.rejected).toBe('ambiguous')
    expect(r.matched).toHaveLength(3)
    expect(r.contains).toHaveLength(3)
  })

  it('no_match → suggested=null, rejected=no_match, candidates пустой', async () => {
    const prisma = makePrisma([client('Сириус'), client('Будни')])
    const r = await resolveClient('несуществующий', prisma)
    expect(r.suggested).toBeNull()
    expect(r.rejected).toBe('no_match')
    expect(r.matched).toHaveLength(0)
  })

  it('isActive=false исключены из всех категорий', async () => {
    const prisma = makePrisma([
      client('Сириус', false),
      client('Сириус Юг', false),
    ])
    const r = await resolveClient('сириус', prisma)
    expect(r.matched).toHaveLength(0)
    expect(r.rejected).toBe('no_match')
  })

  it('прод-кейс ИНПАРТ: query="инпарт авто" → exact один (ООО "ИНПАРТ АВТО")', async () => {
    const prisma = makePrisma([
      client('ООО "ИНПАРТ АВТО"'),
      client('Розница Инпарт соседи'),
      client('ИНПАРТ Логистика'),
    ])
    const r = await resolveClient('инпарт авто', prisma)
    expect(r.suggested?.name).toBe('ООО "ИНПАРТ АВТО"')
    expect(r.rejected).toBeNull()
    expect(r.exact).toHaveLength(1)
  })

  it('прод-кейс ИНПАРТ: query="инпарт" → ambiguous (нет exact, >1)', async () => {
    const prisma = makePrisma([
      client('ООО "ИНПАРТ АВТО"'),
      client('Розница Инпарт соседи'),
      client('ИНПАРТ Логистика'),
    ])
    const r = await resolveClient('инпарт', prisma)
    expect(r.suggested).toBeNull()
    expect(r.rejected).toBe('ambiguous')
    expect(r.matched).toHaveLength(3)
  })

  it('СК Техник: name="Ск Техник", query="ск техник" → exact (case-insensitive)', async () => {
    const prisma = makePrisma([client('Ск Техник'), client('Ск Монтаж')])
    const r = await resolveClient('ск техник', prisma)
    expect(r.suggested?.name).toBe('Ск Техник')
    expect(r.rejected).toBeNull()
    expect(r.exact).toHaveLength(1)
  })

  it('matched упорядочен exact → startsWith → contains', async () => {
    const prisma = makePrisma([
      client('Альфа Бета', true, 'contains'),
      client('Бета', true, 'exact'),
      client('Бета Гамма', true, 'startsWith'),
    ])
    const r = await resolveClient('бета', prisma)
    // exact=Бета, startsWith=Бета Гамма, contains=Альфа Бета
    expect(r.matched.map((c) => c.id)).toEqual(['exact', 'startsWith', 'contains'])
    // exact один → suggested
    expect(r.suggested?.id).toBe('exact')
  })
})

describe('resolveClient isSameDayClient (MEGA-4a-fix)', () => {
  const sameDayLoc = { id: 'l1', sameDayDelivery: true, isActive: true }
  const normalLoc = { id: 'l2', sameDayDelivery: false, isActive: true }

  it('suggested с активной same-day локацией → isSameDayClient=true', async () => {
    const prisma = makePrisma([client('Ск Техник', true, 'sk', [sameDayLoc])])
    const r = await resolveClient('ск техник', prisma)
    expect(r.suggested?.id).toBe('sk')
    expect(r.isSameDayClient).toBe(true)
  })

  it('suggested без same-day локаций → isSameDayClient=false', async () => {
    const prisma = makePrisma([client('Обычный', true, 'reg', [normalLoc])])
    const r = await resolveClient('обычный', prisma)
    expect(r.suggested?.id).toBe('reg')
    expect(r.isSameDayClient).toBe(false)
  })

  it('mixed: одна same-day + одна обычная локация → isSameDayClient=true', async () => {
    const prisma = makePrisma([client('Микс', true, 'mix', [normalLoc, sameDayLoc])])
    const r = await resolveClient('микс', prisma)
    expect(r.isSameDayClient).toBe(true)
  })

  it('same-day локация НЕактивна → isSameDayClient=false (только активные считаются)', async () => {
    const inactiveSameDay = { id: 'l3', sameDayDelivery: true, isActive: false }
    const prisma = makePrisma([client('Спящий', true, 'slp', [inactiveSameDay])])
    const r = await resolveClient('спящий', prisma)
    expect(r.suggested?.id).toBe('slp')
    expect(r.isSameDayClient).toBe(false)
  })

  it('suggested=null (ambiguous) → isSameDayClient=false', async () => {
    const prisma = makePrisma([
      client('Розница Инпарт соседи', true, 'a', [sameDayLoc]),
      client('Сеть Инпарт регион', true, 'b', [sameDayLoc]),
    ])
    const r = await resolveClient('инпарт', prisma)
    expect(r.suggested).toBeNull()
    expect(r.isSameDayClient).toBe(false)
  })
})
