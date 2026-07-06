import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * ШАГ 2 Борис-Директ — тесты сохранения лида с лендинга (атрибуция yclid/utm).
 * Мокаем prisma.landingLead.create; проверяем:
 *  - mapLeadBody: оба формата utm-ключей, quiz/popup, phone обязателен, yclid;
 *  - persistLandingLead: create вызван с ожидаемыми данными;
 *  - ошибка create НЕ пробрасывается (Telegram-путь не должен страдать).
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    landingLead: {
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import { mapLeadBody, persistLandingLead } from './persist-landing-lead'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('mapLeadBody', () => {
  it('возвращает null, если body не объект', () => {
    expect(mapLeadBody(null)).toBeNull()
    expect(mapLeadBody('строка')).toBeNull()
    expect(mapLeadBody([1, 2])).toBeNull()
  })

  it('возвращает null без валидного phone', () => {
    expect(mapLeadBody({ name: 'Иван' })).toBeNull()
    expect(mapLeadBody({ phone: '   ' })).toBeNull()
    expect(mapLeadBody({ phone: 42 })).toBeNull()
  })

  it('минимальное тело: только phone → popup, остальное null/undefined', () => {
    const data = mapLeadBody({ phone: ' +7 900 000-00-00 ' })
    expect(data).toMatchObject({
      formType: 'popup',
      phone: '+7 900 000-00-00', // trim
      name: null,
      source: null,
      utmSource: null,
      yclid: null,
    })
    expect(data?.answers).toBeUndefined()
    expect(data?.meta).toBeUndefined()
  })

  it('form_type=quiz → quiz; любое иное → popup', () => {
    expect(mapLeadBody({ phone: '1', form_type: 'quiz' })?.formType).toBe('quiz')
    expect(mapLeadBody({ phone: '1', form_type: 'popup' })?.formType).toBe('popup')
    expect(mapLeadBody({ phone: '1', form_type: 'weird' })?.formType).toBe('popup')
  })

  it('utm с короткими ключами (source/medium/...)', () => {
    const data = mapLeadBody({
      phone: '1',
      utm: {
        source: 'yandex',
        medium: 'cpc',
        campaign: 'brand',
        content: 'ad1',
        term: 'обеды в офис',
      },
    })
    expect(data).toMatchObject({
      utmSource: 'yandex',
      utmMedium: 'cpc',
      utmCampaign: 'brand',
      utmContent: 'ad1',
      utmTerm: 'обеды в офис',
    })
  })

  it('utm с префиксными ключами (utm_source/utm_medium/...)', () => {
    const data = mapLeadBody({
      phone: '1',
      utm: {
        utm_source: ' yandex ',
        utm_medium: 'cpc',
        utm_campaign: 'brand',
        utm_content: 'ad2',
        utm_term: 'кейтеринг',
      },
    })
    expect(data).toMatchObject({
      utmSource: 'yandex', // trim
      utmMedium: 'cpc',
      utmCampaign: 'brand',
      utmContent: 'ad2',
      utmTerm: 'кейтеринг',
    })
  })

  it('click_ids: yclid и gclid попадают в данные', () => {
    const data = mapLeadBody({
      phone: '1',
      click_ids: { yclid: 'y-123', gclid: 'g-456' },
    })
    expect(data?.yclid).toBe('y-123')
    expect(data?.gclid).toBe('g-456')
  })

  it('page → pageUrl/pageReferrer; answers/meta-объекты сохраняются как есть', () => {
    const answers = { people: '50', budget: '300' }
    const meta = { ab: 'v2' }
    const data = mapLeadBody({
      phone: '1',
      page: { url: 'https://budni.pro/?yclid=y-123', referrer: 'https://ya.ru' },
      answers,
      meta,
    })
    expect(data?.pageUrl).toBe('https://budni.pro/?yclid=y-123')
    expect(data?.pageReferrer).toBe('https://ya.ru')
    expect(data?.answers).toEqual(answers)
    expect(data?.meta).toEqual(meta)
  })

  it('answers/meta не-объекты → undefined (поле не задаём)', () => {
    const data = mapLeadBody({ phone: '1', answers: 'oops', meta: [1] })
    expect(data?.answers).toBeUndefined()
    expect(data?.meta).toBeUndefined()
  })
})

describe('persistLandingLead', () => {
  it('вызывает prisma.landingLead.create с замапленными данными → {created, id}', async () => {
    mockPrisma.landingLead.create.mockResolvedValue({ id: 'l1' })
    const res = await persistLandingLead({
      phone: '+79000000000',
      form_type: 'quiz',
      utm: { utm_source: 'yandex', medium: 'cpc' },
      click_ids: { yclid: 'y-777' },
    })
    expect(res).toEqual({ status: 'created', id: 'l1' })
    expect(mockPrisma.landingLead.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.landingLead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        formType: 'quiz',
        phone: '+79000000000',
        utmSource: 'yandex',
        utmMedium: 'cpc',
        yclid: 'y-777',
      }),
      select: { id: true },
    })
  })

  it('невалидное тело → create НЕ вызывается, {skipped}', async () => {
    await expect(persistLandingLead({ name: 'без телефона' })).resolves.toEqual({
      status: 'skipped',
    })
    expect(mockPrisma.landingLead.create).not.toHaveBeenCalled()
  })

  it('ошибка create НЕ пробрасывается, {failed, error} + console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPrisma.landingLead.create.mockRejectedValue(new Error('db down'))
    await expect(persistLandingLead({ phone: '1' })).resolves.toEqual({
      status: 'failed',
      error: 'db down',
    })
    expect(errorSpy).toHaveBeenCalledWith('[leads/intake] persist failed:', 'db down')
    errorSpy.mockRestore()
  })
})
