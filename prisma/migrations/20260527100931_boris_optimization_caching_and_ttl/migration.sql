-- Sprint 7.16.D: оптимизация Action-Бориса (prompt caching, TTL, sliding window).
-- Pure additive: одно nullable поле на BorisConversation, два NOT NULL DEFAULT 0
-- поля на BorisMetrics. Никаких DROP/RENAME/ALTER COLUMN на существующих
-- структурах.

-- AlterTable: TTL auto-close беседы. expiresAt = lastMessageAt + TTL_MINUTES
-- заполняется в момент закрытия по неактивности (см. resolveActiveConversation).
ALTER TABLE "BorisConversation" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- AlterTable: prompt caching счётчики Anthropic.
-- cache_creation_input_tokens — токены, записанные в кеш (1.25× обычной цены).
-- cache_read_input_tokens     — токены, прочитанные из кеша (0.10× обычной цены).
ALTER TABLE "BorisMetrics" ADD COLUMN "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0;
