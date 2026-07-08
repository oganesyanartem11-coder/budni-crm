import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Write-gate: единственная дверь пишущих запросов в Директ.
 * Транспорт, состояние роли и prisma мокаются — без сети и БД.
 */

const { mockPrisma, mockGetState, mockDirect } = vi.hoisted(() => ({
  mockPrisma: {
    borisDirectActionLog: { create: vi.fn() },
    borisDirectSnapshot: { findFirst: vi.fn() },
  },
  mockGetState: vi.fn(),
  mockDirect: {
    setKeywordBids: vi.fn(),
    updateCampaignNegatives: vi.fn(),
    restoreMetricaTag: vi.fn(),
    suspendKeywords: vi.fn(),
    suspendCampaign: vi.fn(),
    updateDailyBudget: vi.fn(),
    getCampaignSettings: vi.fn(),
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./state', () => ({ getDirectRoleState: mockGetState }))
vi.mock('./direct-client', () => mockDirect)

import {
  executeDirectWrite,
  applyBidChanges,
  applyNegativeKeywords,
  addNegativeKeywords,
  suspendKeywordsGated,
  suspendCampaignEmergency,
  applyDailyBudget,
} from './write-gate'
import { BID_CEILING_MICRO, MICRO, CB_MAX_BID_CHANGES_PER_TICK } from './config'

function setState(state: { mode: 'OBSERVE' | 'LIVE'; frozen?: boolean }) {
  mockGetState.mockResolvedValue({
    mode: state.mode,
    frozen: state.frozen ?? false,
    autoNegativesEnabled: false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  let n = 0
  mockPrisma.borisDirectActionLog.create.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: `log-${++n}`,
    ...(data as object),
  }))
  for (const fn of Object.values(mockDirect)) fn.mockResolvedValue({})
  // Дефолт: снапшота нет → fail-safe усыхания не срабатывает.
  mockPrisma.borisDirectSnapshot.findFirst.mockResolvedValue(null)
})

/** Ответ campaigns.get с заданным живым минус-списком. */
function settingsWith(items: string[]) {
  return { Id: 711897777, Name: 'test', NegativeKeywords: { Items: items } }
}

describe('executeDirectWrite — гейт режима', () => {
  it('OBSERVE: perform НЕ вызывается, лог applied=false («сделал бы»)', async () => {
    setState({ mode: 'OBSERVE' })
    const perform = vi.fn().mockResolvedValue({})

    const res = await executeDirectWrite({
      action: 'keywordbids.set',
      targetType: 'keyword',
      reason: 'тест',
      perform,
    })

    expect(perform).not.toHaveBeenCalled()
    expect(res.applied).toBe(false)
    expect(res.logId).toBe('log-1')
    const logged = mockPrisma.borisDirectActionLog.create.mock.calls[0][0].data
    expect(logged).toMatchObject({ applied: false, mode: 'OBSERVE', reason: 'тест' })
  })

  it('LIVE: perform вызывается, лог applied=true', async () => {
    setState({ mode: 'LIVE' })
    const perform = vi.fn().mockResolvedValue({})

    const res = await executeDirectWrite({
      action: 'keywordbids.set',
      targetType: 'keyword',
      reason: 'тест',
      perform,
    })

    expect(perform).toHaveBeenCalledTimes(1)
    expect(res.applied).toBe(true)
    expect(mockPrisma.borisDirectActionLog.create.mock.calls[0][0].data.applied).toBe(true)
  })

  it('frozen (стоп-кран) блокирует даже LIVE', async () => {
    setState({ mode: 'LIVE', frozen: true })
    const perform = vi.fn()

    const res = await executeDirectWrite({
      action: 'campaigns.update.negatives',
      targetType: 'campaign',
      reason: 'тест',
      perform,
    })

    expect(perform).not.toHaveBeenCalled()
    expect(res.applied).toBe(false)
  })

  it('emergency проходит сквозь frozen в LIVE (защита денег)', async () => {
    setState({ mode: 'LIVE', frozen: true })
    const perform = vi.fn().mockResolvedValue({})

    const res = await executeDirectWrite({
      action: 'campaigns.suspend',
      targetType: 'campaign',
      reason: 'катастрофа',
      perform,
      emergency: true,
    })

    expect(perform).toHaveBeenCalledTimes(1)
    expect(res.applied).toBe(true)
  })

  it('emergency в OBSERVE всё равно НЕ применяется', async () => {
    setState({ mode: 'OBSERVE' })
    const perform = vi.fn()

    const res = await suspendCampaignEmergency('катастрофа')

    expect(perform).not.toHaveBeenCalled()
    expect(mockDirect.suspendCampaign).not.toHaveBeenCalled()
    expect(res.applied).toBe(false)
  })

  it('perform кинул → лог applied=false с ERROR в reason, исключение пробрасывается', async () => {
    setState({ mode: 'LIVE' })
    const perform = vi.fn().mockRejectedValue(new Error('code=54 not enough units'))

    await expect(
      executeDirectWrite({ action: 'keywordbids.set', targetType: 'keyword', reason: 'тест', perform })
    ).rejects.toThrow('not enough units')

    const logged = mockPrisma.borisDirectActionLog.create.mock.calls[0][0].data
    expect(logged.applied).toBe(false)
    expect(logged.reason).toContain('тест | ERROR: code=54 not enough units')
  })

  it('revertOfId прокидывается в запись лога', async () => {
    setState({ mode: 'LIVE' })
    await executeDirectWrite({
      action: 'keywordbids.set',
      targetType: 'keyword',
      reason: 'откат',
      perform: async () => ({}),
      revertOfId: 'orig-1',
    })
    expect(mockPrisma.borisDirectActionLog.create.mock.calls[0][0].data.revertOfId).toBe('orig-1')
  })
})

describe('applyBidChanges', () => {
  it('LIVE: ставка выше потолка клампится (clamped считается), setKeywordBids получает срезанную', async () => {
    setState({ mode: 'LIVE' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // from 350 ₽ → clamp до 400 ₽: сдвиг массы ~14% — breaker молчит, проверяем именно clamp.
    const res = await applyBidChanges(
      [{ keywordId: 11, fromMicro: 350 * MICRO, toMicro: BID_CEILING_MICRO + 50 * MICRO }],
      'тест'
    )

    expect(res.applied).toBe(true)
    expect(res.clamped).toBe(1)
    expect(res.breakerTripped).toBe(false)
    expect(mockDirect.setKeywordBids).toHaveBeenCalledWith([
      { keywordId: 11, searchBidMicro: BID_CEILING_MICRO },
    ])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('circuit breaker ПЕРЕД гейтом: не применяем, breakerTripped=true, транспорт не тронут', async () => {
    setState({ mode: 'LIVE' })
    const changes = Array.from({ length: CB_MAX_BID_CHANGES_PER_TICK + 1 }, (_, i) => ({
      keywordId: i,
      fromMicro: 100 * MICRO,
      toMicro: 101 * MICRO,
    }))

    const res = await applyBidChanges(changes, 'тест')

    expect(res.applied).toBe(false)
    expect(res.breakerTripped).toBe(true)
    expect(mockDirect.setKeywordBids).not.toHaveBeenCalled()
    const logged = mockPrisma.borisDirectActionLog.create.mock.calls[0][0].data
    expect(logged.applied).toBe(false)
    expect(logged.reason).toContain('CIRCUIT BREAKER')
  })

  it('OBSERVE: setKeywordBids не вызывается, лог с before/after ставок', async () => {
    setState({ mode: 'OBSERVE' })

    const res = await applyBidChanges(
      [{ keywordId: 7, fromMicro: 100 * MICRO, toMicro: 150 * MICRO }],
      'тест'
    )

    expect(res.applied).toBe(false)
    expect(mockDirect.setKeywordBids).not.toHaveBeenCalled()
    const logged = mockPrisma.borisDirectActionLog.create.mock.calls[0][0].data
    expect(logged.before).toEqual([{ keywordId: 7, bidMicro: 100 * MICRO }])
    expect(logged.after).toEqual([{ keywordId: 7, bidMicro: 150 * MICRO }])
  })
})

describe('applyNegativeKeywords', () => {
  it('LIVE: updateCampaignNegatives + СРАЗУ restoreMetricaTag (страховка тега)', async () => {
    setState({ mode: 'LIVE' })

    const res = await applyNegativeKeywords(['старое', 'новое'], ['старое'], 'минусовка')

    expect(res.applied).toBe(true)
    expect(mockDirect.updateCampaignNegatives).toHaveBeenCalledWith(['старое', 'новое'])
    expect(mockDirect.restoreMetricaTag).toHaveBeenCalledTimes(1)
    // Две записи лога: сам update и восстановление тега.
    const actions = mockPrisma.borisDirectActionLog.create.mock.calls.map(
      (c) => c[0].data.action
    )
    expect(actions).toEqual(['campaigns.update.negatives', 'campaigns.update.metrica_tag_restore'])
  })

  it('OBSERVE: ни негативы, ни тег не трогаем — только лог «сделал бы»', async () => {
    setState({ mode: 'OBSERVE' })

    const res = await applyNegativeKeywords(['новое'], [], 'минусовка')

    expect(res.applied).toBe(false)
    expect(mockDirect.updateCampaignNegatives).not.toHaveBeenCalled()
    expect(mockDirect.restoreMetricaTag).not.toHaveBeenCalled()
    expect(mockPrisma.borisDirectActionLog.create).toHaveBeenCalledTimes(1)
  })
})

describe('addNegativeKeywords — единая точка мержа с ЖИВЫМ списком кабинета', () => {
  it('LIVE: живой список из N фраз + K новых → уходит ОБЪЕДИНЕНИЕ, before=живой список, тег страхуется', async () => {
    setState({ mode: 'LIVE' })
    // Первый campaigns.get — живой список (3 фразы); второй — контрольное чтение (4).
    mockDirect.getCampaignSettings
      .mockResolvedValueOnce(settingsWith(['аренда', 'вакансии', 'рецепт']))
      .mockResolvedValueOnce(settingsWith(['аренда', 'вакансии', 'рецепт', 'опт']))

    const res = await addNegativeKeywords(['опт'], 'минусовка')

    expect(res.applied).toBe(true)
    expect(res.aborted).toBe(false)
    expect(res.added).toBe(1)
    expect(res.verifyMismatch).toBeFalsy()
    // В кабинет ушёл ОБЪЕДИНЁННЫЙ список, а не голая новая фраза.
    expect(mockDirect.updateCampaignNegatives).toHaveBeenCalledWith(['аренда', 'вакансии', 'рецепт', 'опт'])
    // before лога = свежий живой список (для честного отката), after = объединение.
    const negLog = mockPrisma.borisDirectActionLog.create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.action === 'campaigns.update.negatives')
    expect(negLog.before).toEqual(['аренда', 'вакансии', 'рецепт'])
    expect(negLog.after).toEqual(['аренда', 'вакансии', 'рецепт', 'опт'])
    // ADD_METRICA_TAG страхуется после update.
    expect(mockDirect.restoreMetricaTag).toHaveBeenCalledTimes(1)
  })

  it('дедуп против живого списка: фраза, уже стоящая в кабинете, не задваивается', async () => {
    setState({ mode: 'LIVE' })
    mockDirect.getCampaignSettings
      .mockResolvedValueOnce(settingsWith(['аренда', 'вакансии']))
      .mockResolvedValueOnce(settingsWith(['аренда', 'вакансии', 'рецепт']))

    const res = await addNegativeKeywords(['вакансии', 'рецепт'], 'минусовка')

    expect(res.added).toBe(1)
    expect(mockDirect.updateCampaignNegatives).toHaveBeenCalledWith(['аренда', 'вакансии', 'рецепт'])
  })

  it('FAIL-SAFE: живой список не прочитался (campaigns.get упал) → write НЕ вызван, aborted', async () => {
    setState({ mode: 'LIVE' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDirect.getCampaignSettings.mockRejectedValue(new Error('code=500 direct down'))

    const res = await addNegativeKeywords(['опт'], 'минусовка')

    expect(res.aborted).toBe(true)
    expect(res.applied).toBe(false)
    expect(res.abortReason).toBeTruthy()
    expect(mockDirect.updateCampaignNegatives).not.toHaveBeenCalled()
    expect(mockPrisma.borisDirectActionLog.create).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('FAIL-SAFE: живой список подозрительно усох против снапшота → write НЕ вызван, aborted', async () => {
    setState({ mode: 'LIVE' })
    // Живой список внезапно 1 фраза, а в снапшоте было 1178 → катастрофа усыхания.
    mockDirect.getCampaignSettings.mockResolvedValue(settingsWith(['осталась одна']))
    mockPrisma.borisDirectSnapshot.findFirst.mockResolvedValue({
      payload: { NegativeKeywords: { Items: Array.from({ length: 1178 }, (_, i) => `ф${i}`) } },
    })

    const res = await addNegativeKeywords(['опт'], 'минусовка')

    expect(res.aborted).toBe(true)
    expect(res.abortReason).toContain('усох')
    expect(mockDirect.updateCampaignNegatives).not.toHaveBeenCalled()
  })

  it('OBSERVE: читаем живой список, лог «сделал бы» с before=живой/after=объединение, транспорт не тронут', async () => {
    setState({ mode: 'OBSERVE' })
    mockDirect.getCampaignSettings.mockResolvedValue(settingsWith(['аренда', 'вакансии']))

    const res = await addNegativeKeywords(['опт'], 'минусовка')

    expect(res.applied).toBe(false)
    expect(res.aborted).toBe(false)
    expect(res.added).toBe(1)
    expect(mockDirect.updateCampaignNegatives).not.toHaveBeenCalled()
    const negLog = mockPrisma.borisDirectActionLog.create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.action === 'campaigns.update.negatives')
    expect(negLog.before).toEqual(['аренда', 'вакансии'])
    expect(negLog.after).toEqual(['аренда', 'вакансии', 'опт'])
    // В OBSERVE контрольного чтения нет → getCampaignSettings звали один раз.
    expect(mockDirect.getCampaignSettings).toHaveBeenCalledTimes(1)
  })

  it('контрольное чтение: кабинет усох НИЖЕ живой базы → verifyMismatch (потеря базы)', async () => {
    setState({ mode: 'LIVE' })
    // Живая база 2 фразы; после write кабинет вернул 1 (< live.length) — часть базы потеряна.
    mockDirect.getCampaignSettings
      .mockResolvedValueOnce(settingsWith(['аренда', 'рецепт']))
      .mockResolvedValueOnce(settingsWith(['аренда']))

    const res = await addNegativeKeywords(['опт'], 'минусовка')

    expect(res.applied).toBe(true)
    expect(res.verifyMismatch).toBe(true)
  })

  it('контрольное чтение: Яндекс схлопнул новую фразу (кабинет == живой базы, но < merged) → НЕ ложная тревога', async () => {
    setState({ mode: 'LIVE' })
    // База 2; отправили 3 (base+new); кабинет вернул 2 (== live.length) — новая схлопнута,
    // но БАЗА цела → тревоги быть не должно.
    mockDirect.getCampaignSettings
      .mockResolvedValueOnce(settingsWith(['аренда', 'рецепт']))
      .mockResolvedValueOnce(settingsWith(['аренда', 'рецепт']))

    const res = await addNegativeKeywords(['опт'], 'минусовка')

    expect(res.applied).toBe(true)
    expect(res.verifyMismatch).toBeFalsy()
  })

  it('все фразы уже в кабинете → added=0, кабинет не трогаем, не aborted', async () => {
    setState({ mode: 'LIVE' })
    mockDirect.getCampaignSettings.mockResolvedValue(settingsWith(['аренда', 'вакансии']))

    const res = await addNegativeKeywords(['аренда'], 'минусовка')

    expect(res.added).toBe(0)
    expect(res.aborted).toBe(false)
    expect(res.applied).toBe(false)
    expect(mockDirect.updateCampaignNegatives).not.toHaveBeenCalled()
  })
})

describe('обёртки остановок и бюджета', () => {
  it('suspendKeywordsGated в LIVE зовёт транспорт', async () => {
    setState({ mode: 'LIVE' })
    const res = await suspendKeywordsGated([1, 2], 'слив бюджета')
    expect(res.applied).toBe(true)
    expect(mockDirect.suspendKeywords).toHaveBeenCalledWith([1, 2])
  })

  it('suspendCampaignEmergency в LIVE+frozen применяется (emergency)', async () => {
    setState({ mode: 'LIVE', frozen: true })
    const res = await suspendCampaignEmergency('катастрофа расхода')
    expect(res.applied).toBe(true)
    expect(mockDirect.suspendCampaign).toHaveBeenCalledTimes(1)
  })

  it('applyDailyBudget в LIVE зовёт транспорт и страхует тег', async () => {
    setState({ mode: 'LIVE' })
    const res = await applyDailyBudget(3500 * MICRO, 'да владельца на предложение')
    expect(res.applied).toBe(true)
    expect(mockDirect.updateDailyBudget).toHaveBeenCalledWith(3500 * MICRO)
    expect(mockDirect.restoreMetricaTag).toHaveBeenCalledTimes(1)
  })
})
