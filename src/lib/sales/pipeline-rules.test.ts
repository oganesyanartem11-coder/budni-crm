import { describe, it, expect } from 'vitest'
import { suggestStatusAfterTask, sortLeadsForList } from './pipeline-rules'
import type { LeadTaskItem } from './types'

describe('suggestStatusAfterTask — куда сдвинуть стадию после задачи', () => {
  it('«Отправить КП» → КП отправлено (из Новая / В работе)', () => {
    expect(suggestStatusAfterTask('SEND_PROPOSAL', 'NEW')).toBe('PROPOSAL_SENT')
    expect(suggestStatusAfterTask('SEND_PROPOSAL', 'IN_PROGRESS')).toBe('PROPOSAL_SENT')
  })

  it('«Пробный день» → Пробный день', () => {
    expect(suggestStatusAfterTask('TRIAL', 'PROPOSAL_SENT')).toBe('TRIAL')
  })

  it('звонок/письмо/встреча → «В работе» только из «Новая»', () => {
    for (const t of ['CALL', 'WRITE', 'MEETING'] as const) {
      expect(suggestStatusAfterTask(t, 'NEW')).toBe('IN_PROGRESS')
      expect(suggestStatusAfterTask(t, 'IN_PROGRESS')).toBeNull()
      expect(suggestStatusAfterTask(t, 'PROPOSAL_SENT')).toBeNull()
    }
  })

  it('назад не откатываем: КП на стадии Договор/Пробный/КП → null', () => {
    expect(suggestStatusAfterTask('SEND_PROPOSAL', 'CONTRACT')).toBeNull()
    expect(suggestStatusAfterTask('SEND_PROPOSAL', 'TRIAL')).toBeNull()
    expect(suggestStatusAfterTask('SEND_PROPOSAL', 'PROPOSAL_SENT')).toBeNull()
    expect(suggestStatusAfterTask('TRIAL', 'CONTRACT')).toBeNull()
  })

  it('«Другое» → null; закрытая заявка (WON/LOST) → null', () => {
    expect(suggestStatusAfterTask('OTHER', 'NEW')).toBeNull()
    expect(suggestStatusAfterTask('SEND_PROPOSAL', 'WON')).toBeNull()
    expect(suggestStatusAfterTask('CALL', 'LOST')).toBeNull()
  })
})

describe('sortLeadsForList — порядок списка /sales', () => {
  const NOW = new Date('2026-09-24T09:00:00Z')
  const task = (dueAt: string): LeadTaskItem => ({
    id: `t-${dueAt}`,
    type: 'CALL',
    title: 'Позвонить',
    dueAt: new Date(dueAt),
    note: null,
    assigneeId: null,
  })
  const lead = (id: string, lastActivityAt: string, nextTask: LeadTaskItem | null) => ({
    id,
    lastActivityAt: new Date(lastActivityAt),
    nextTask,
  })

  it('просроченные (старые сроки выше) → будущие (ближайшие выше) → без задач (свежие выше)', () => {
    const items = [
      lead('noTaskOld', '2026-09-20T09:00:00Z', null),
      lead('future2', '2026-09-24T08:00:00Z', task('2026-09-26T07:00:00Z')),
      lead('overdue1', '2026-09-23T09:00:00Z', task('2026-09-24T08:30:00Z')),
      lead('noTaskNew', '2026-09-24T08:59:00Z', null),
      lead('future1', '2026-09-21T09:00:00Z', task('2026-09-24T10:00:00Z')),
      lead('overdue0', '2026-09-24T08:00:00Z', task('2026-09-22T07:00:00Z')),
    ]
    expect(sortLeadsForList(items, NOW).map((l) => l.id)).toEqual([
      'overdue0',
      'overdue1',
      'future1',
      'future2',
      'noTaskNew',
      'noTaskOld',
    ])
  })

  it('не мутирует вход', () => {
    const items = [lead('b', '2026-09-20T09:00:00Z', null), lead('a', '2026-09-21T09:00:00Z', null)]
    const copy = [...items]
    sortLeadsForList(items, NOW)
    expect(items).toEqual(copy)
  })
})
