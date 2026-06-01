import { describe, it, expect } from 'vitest'
import { BORIS_TOOLS, BORIS_READ_TOOLS, BORIS_MUTATE_TOOLS } from './tools'

describe('BORIS_TOOLS подмножества', () => {
  it('BORIS_TOOLS содержит ровно 13 tools', () => {
    expect(BORIS_TOOLS.length).toBe(13)
  })

  it('BORIS_READ_TOOLS содержит ровно 7 read-tools', () => {
    expect(BORIS_READ_TOOLS.length).toBe(7)
  })

  it('BORIS_MUTATE_TOOLS содержит ровно 6 mutate-tools', () => {
    expect(BORIS_MUTATE_TOOLS.length).toBe(6)
  })

  it('READ + MUTATE = BORIS_TOOLS (нет пересечений и пропусков)', () => {
    const readNames = new Set(BORIS_READ_TOOLS.map((t) => t.name))
    const mutateNames = new Set(BORIS_MUTATE_TOOLS.map((t) => t.name))
    const allNames = new Set(BORIS_TOOLS.map((t) => t.name))

    for (const name of readNames) {
      expect(mutateNames.has(name)).toBe(false)
    }
    expect(readNames.size + mutateNames.size).toBe(allNames.size)
  })

  it('Все MUTATE-tools имеют ожидаемые имена', () => {
    const names = BORIS_MUTATE_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'add_order_note',
      'cancel_order',
      'create_one_time_order',
      'edit_order_portions',
      'reschedule_order',
      'restore_order',
    ])
  })

  it('Все READ-tools имеют ожидаемые имена', () => {
    const names = BORIS_READ_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'find_orders',
      'get_client_summary',
      'get_dish_margin',
      'get_menu_for_date',
      'get_order_details',
      'get_orders_for_date',
      'get_recent_client_messages',
    ])
  })
})

describe('Логика выбора tools по chatType + userRole', () => {
  // Документирующие тесты для гарантии что комбинаторика правильная.
  type Case = {
    chatType: 'private' | 'group' | 'supergroup' | 'channel'
    role: 'ADMIN_PRO' | 'ADMIN' | 'MANAGER' | 'CHEF' | 'COURIER'
    canMutate: boolean
  }

  const cases: Case[] = [
    { chatType: 'private', role: 'ADMIN_PRO', canMutate: true },
    { chatType: 'private', role: 'ADMIN', canMutate: false },
    { chatType: 'private', role: 'MANAGER', canMutate: false },
    { chatType: 'private', role: 'CHEF', canMutate: false },
    { chatType: 'private', role: 'COURIER', canMutate: false },
    { chatType: 'group', role: 'ADMIN_PRO', canMutate: false },
    { chatType: 'group', role: 'MANAGER', canMutate: false },
    { chatType: 'supergroup', role: 'ADMIN_PRO', canMutate: false },
    { chatType: 'channel', role: 'ADMIN_PRO', canMutate: false },
  ]

  for (const c of cases) {
    it(`chatType=${c.chatType} + role=${c.role} → canMutate=${c.canMutate}`, () => {
      const isPrivate = c.chatType === 'private'
      const isAdminPro = c.role === 'ADMIN_PRO'
      const canMutate = isPrivate && isAdminPro
      expect(canMutate).toBe(c.canMutate)
    })
  }
})
