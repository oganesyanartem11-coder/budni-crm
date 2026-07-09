/**
 * Нормализация формы ответа keywordbids.get Директа.
 *
 * Вынесено ОТДЕЛЬНЫМ модулем (не в direct-client.ts) сознательно: в полигоне
 * `@/lib/boris-direct/direct-client` подменяется фейком (sim/runner/mocks.setup.ts),
 * поэтому фейк НЕ может импортировать нормализатор из direct-client (получил бы сам
 * себя — цикл). Этот модуль НЕ мокается, и его импортируют И боевой direct-client,
 * И sim-фейк — так обе стороны прогоняют СЫРУЮ форму через ОДНУ нормализацию.
 *
 * Импорт типов из direct-client — type-only (стирается в рантайме) → runtime-цикла нет.
 */

import type { AuctionBid, KeywordBidRecord } from './direct-client'

/**
 * СЫРАЯ форма записи keywordbids.get ДО нормализации. Живой API отдаёт
 * Search.AuctionBids ОБЪЕКТОМ { AuctionBidItems: [...] } (выверено зондом
 * кабинета 711897777), а НЕ плоским массивом. Поддерживаем и плоский массив —
 * на случай вариативности ответа API между версиями/срезами.
 */
export interface RawKeywordBidRecord {
  KeywordId: number
  AdGroupId: number
  CampaignId: number
  Search?: {
    Bid?: number
    AuctionBids?: { AuctionBidItems?: AuctionBid[] } | AuctionBid[]
  }
}

/**
 * Нормализует сырую форму AuctionBids Директа в плоский AuctionBid[]:
 * объект { AuctionBidItems: [...] } → его массив; уже-плоский массив → как есть;
 * отсутствие/пусто → [] (фраза без лесенки аукциона — корректный случай, не ошибка).
 */
export function normalizeAuctionBids(
  raw: { AuctionBidItems?: AuctionBid[] } | AuctionBid[] | null | undefined
): AuctionBid[] {
  if (Array.isArray(raw)) return raw
  const items = raw?.AuctionBidItems
  return Array.isArray(items) ? items : []
}

/**
 * Сырая запись ставки → чистый KeywordBidRecord (Search.AuctionBids ВСЕГДА
 * плоский массив). Единая точка нормализации транспорта: дальше по коду —
 * только нормализованный массив.
 */
export function normalizeKeywordBidRecord(raw: RawKeywordBidRecord): KeywordBidRecord {
  return {
    KeywordId: raw.KeywordId,
    AdGroupId: raw.AdGroupId,
    CampaignId: raw.CampaignId,
    Search: raw.Search
      ? { Bid: raw.Search.Bid, AuctionBids: normalizeAuctionBids(raw.Search.AuctionBids) }
      : undefined,
  }
}
