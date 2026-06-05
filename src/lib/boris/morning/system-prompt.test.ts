import { describe, it, expect } from 'vitest'
import { getMorningSystemPrompt } from './system-prompt'

describe('getMorningSystemPrompt (П5: убран буллет «не подтвердили на завтра»)', () => {
  const prompt = getMorningSystemPrompt()

  it('НЕ инструктирует рендерить буллет «не подтвердили на завтра»', () => {
    // На завтра клиентов спрашивают только в 11:00 МСК — в 08:00 цифра вводит в заблуждение.
    // Допускается лишь явный запрет («НЕ выводи ... на завтра»), но не инструкция «добавь буллет».
    expect(prompt).not.toContain('добавь буллет «не подтвердили на завтра')
    expect(prompt).not.toContain('pendingConfirmationTomorrow')
  })

  it('СОХРАНЯЕТ same-day буллет с cut-off (валиден в 08:00)', () => {
    expect(prompt).toContain('pendingSameDayToday')
    expect(prompt).toContain('не подтвердили на сегодня (cut-off {cutoffLabel})')
  })

  it('даёт смысл для триггера monday_start_of_week', () => {
    expect(prompt).toContain('monday_start_of_week')
  })

  it('требует плейн-текст заряда без markdown', () => {
    expect(prompt).toContain('без markdown')
  })
})
