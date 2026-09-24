import { describe, it, expect } from 'vitest'
import {
  ACTIVE_STATUSES,
  PIPELINE_STATUS_RU,
  dealStatusToPipeline,
  pipelineToDealStatus,
  sourceLabel,
  SOURCE_LABELS,
} from './labels'
import { toPhoneDigits } from './phone'

describe('pipelineToDealStatus', () => {
  it('NEW → NONE, промежуточные → IN_PROGRESS, финальные как есть', () => {
    expect(pipelineToDealStatus('NEW')).toBe('NONE')
    for (const s of ['IN_PROGRESS', 'PROPOSAL_SENT', 'TRIAL', 'CONTRACT'] as const) {
      expect(pipelineToDealStatus(s)).toBe('IN_PROGRESS')
    }
    expect(pipelineToDealStatus('WON')).toBe('WON')
    expect(pipelineToDealStatus('LOST')).toBe('LOST')
  })
})

describe('dealStatusToPipeline', () => {
  it('WON/LOST — всегда', () => {
    expect(dealStatusToPipeline('WON', 'TRIAL')).toBe('WON')
    expect(dealStatusToPipeline('LOST', 'NEW')).toBe('LOST')
  })
  it('IN_PROGRESS — только из NEW', () => {
    expect(dealStatusToPipeline('IN_PROGRESS', 'NEW')).toBe('IN_PROGRESS')
    expect(dealStatusToPipeline('IN_PROGRESS', 'PROPOSAL_SENT')).toBeNull()
  })
  it('NONE — без изменений', () => {
    expect(dealStatusToPipeline('NONE', 'WON')).toBeNull()
    expect(dealStatusToPipeline('NONE', 'NEW')).toBeNull()
  })
  it('идемпотентно: уже такая стадия → null', () => {
    expect(dealStatusToPipeline('WON', 'WON')).toBeNull()
    expect(dealStatusToPipeline('LOST', 'LOST')).toBeNull()
  })
  it('туда-обратно согласовано: стадия → dealStatus → стадия не меняет стадию', () => {
    for (const s of Object.keys(PIPELINE_STATUS_RU) as (keyof typeof PIPELINE_STATUS_RU)[]) {
      expect(dealStatusToPipeline(pipelineToDealStatus(s), s)).toBeNull()
    }
  })
})

describe('ACTIVE_STATUSES', () => {
  it('без WON/LOST', () => {
    expect(ACTIVE_STATUSES).not.toContain('WON')
    expect(ACTIVE_STATUSES).not.toContain('LOST')
    expect(ACTIVE_STATUSES).toHaveLength(5)
  })
})

describe('sourceLabel', () => {
  it('точное совпадение важнее префикса', () => {
    expect(sourceLabel('menu-full')).toBe(SOURCE_LABELS['menu-full'])
    expect(sourceLabel('menu-zima')).toBe('Меню')
  })
  it('префиксы подстраниц', () => {
    expect(sourceLabel('korp-moskva')).toBe('Корпоративное питание')
    expect(sourceLabel('obedy-ofis-siti')).toBe('Обеды в офис')
    expect(sourceLabel('sotrudniki-sklad')).toBe('Питание сотрудников')
    expect(sourceLabel('rabochih-stroika')).toBe('Питание рабочих')
  })
  it('ручные и Борис, неизвестный — сырой код, пустой — null', () => {
    expect(sourceLabel('manual-telegram')).toBe('Telegram')
    expect(sourceLabel('boris_call_intake')).toBe('Звонок (через Бориса)')
    expect(sourceLabel('weird-code')).toBe('weird-code')
    expect(sourceLabel(null)).toBeNull()
  })
})

describe('toPhoneDigits', () => {
  it('маска сайта', () => {
    expect(toPhoneDigits('+7 (999) 123-45-67')).toBe('79991234567')
  })
  it('8… → 7…', () => {
    expect(toPhoneDigits('8 999 123 45 67')).toBe('79991234567')
  })
  it('10 цифр без кода → 7…', () => {
    expect(toPhoneDigits('9991234567')).toBe('79991234567')
  })
  it('уже канонические цифры', () => {
    expect(toPhoneDigits('79991234567')).toBe('79991234567')
  })
  it('мало цифр / пусто → null', () => {
    expect(toPhoneDigits('12345')).toBeNull()
    expect(toPhoneDigits('')).toBeNull()
    expect(toPhoneDigits(null)).toBeNull()
  })
  it('не РФ-формат или лишние цифры → null', () => {
    expect(toPhoneDigits('+1 555 123 4567')).toBeNull()
    expect(toPhoneDigits('8 (999) 123-45-67 доб 12')).toBeNull()
  })
})
