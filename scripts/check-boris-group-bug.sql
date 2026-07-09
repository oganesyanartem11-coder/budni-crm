-- ============================================================================
-- check-boris-group-bug.sql
-- READ-ONLY диагностика бага «Боря ответил на не-адресованное "Хорошо"».
-- Чат: «Рабочий чат | Будни» (Telegram), бот «Ассистент Борис».
--
-- НЕ выполнять на локальной БД — там нет этих данных. Выполнять ТОЛЬКО на
-- Production (Vercel/Neon SQL Editor).
--
-- ВАЖНО про таблицы: групповой Борис пишет в BorisConversation / BorisMessage /
-- BorisGroupReplyTracker. Таблицы BotConversation/BotMessage — это КЛИЕНТСКИЙ
-- MAX-бот, к этому багу отношения НЕ имеют (исходный шаблон SQL был не из того
-- слоя — здесь исправлено).
--
-- ВАЖНО про время: createdAt/updatedAt хранятся в UTC. МСК = UTC+3.
--   17:27 МСК (ответ Бори «Понял, жду задачу») = 14:27 UTC.
--   08 июня целиком по МСК = 2026-06-07 21:00 UTC .. 2026-06-08 21:00 UTC.
-- Ниже окна заданы в UTC и берут весь день с запасом.
--
-- ВАЖНО про решение адресности: вердикт Haiku-классификатора (relates true/false)
-- и причина гейта (direct_mention / in_window / window_closed) В БД НЕ ПИШУТСЯ.
-- Они идут только в console-логи Vercel ('[haiku-cost]', '[context-classifier]',
-- '[boris-handler]'). Чтобы увидеть, был ли вызван Haiku на «Хорошо» и что он
-- вернул — смотри Runtime Logs функции /api/telegram/webhook за ~14:27 UTC.
--
-- Подставь <GROUP_CHAT_ID> = значение env TELEGRAM_GROUP_CHAT_ID (id группового
-- чата Telegram, для супергрупп это отрицательное число вида -100xxxxxxxxxx).
-- ============================================================================

-- Q1. Якорь «контекстного окна»: последний message_id ответа Бори в этом чате
--     и когда он обновлён. Это ГЛАВНАЯ улика: окно (20 сообщений) считается от
--     lastReplyMessageId. updatedAt покажет, когда Боря последний раз отвечал.
SELECT "tgChatId", "lastReplyMessageId", "updatedAt"
FROM "BorisGroupReplyTracker"
WHERE "tgChatId" = '<GROUP_CHAT_ID>';

-- Q2. Беседы Бори в этом чате за 8 июня (только для ИДЕНТИФИЦИРОВАННЫХ юзеров;
--     анонимная группа идёт stateless и здесь НЕ появится). Показывает, была ли
--     старая беседа закрыта по TTL и создана ли новая в районе 17:20 МСК.
--     messagesCount в схеме НЕТ — считаем подзапросом.
SELECT c.id, c."userId", c."chatId" AS chat_id,
       c."createdAt", c."lastMessageAt", c."closedAt", c."expiresAt",
       (SELECT COUNT(*) FROM "BorisMessage" m WHERE m."conversationId" = c.id) AS messages_count
FROM "BorisConversation" c
WHERE c."chatId" = '<GROUP_CHAT_ID>'
  AND (c."createdAt" >= '2026-06-07 21:00:00' OR c."lastMessageAt" >= '2026-06-07 21:00:00')
ORDER BY c."createdAt";

-- Q3. Реальные сообщения Бори (вход/выход) за 8 июня в этом чате — текст лежит в
--     content (Json, массив Anthropic content-блоков). role: user|assistant|tool.
--     Покажет, что именно пришло («Хорошо») и что Боря ответил («Понял, жду…»).
SELECT m."createdAt", m.role, m."toolName", m.content
FROM "BorisMessage" m
JOIN "BorisConversation" c ON c.id = m."conversationId"
WHERE c."chatId" = '<GROUP_CHAT_ID>'
  AND m."createdAt" >= '2026-06-07 21:00:00' AND m."createdAt" < '2026-06-08 21:00:00'
ORDER BY m."createdAt";

-- Q3b. Точечный поиск текста-триггера в content за день (есть ли «Слушаю» /
--      «Хорошо» / «Борис» в сохранённых сообщениях этого чата).
SELECT m."createdAt", m.role, m.content::text AS content_text
FROM "BorisMessage" m
JOIN "BorisConversation" c ON c.id = m."conversationId"
WHERE c."chatId" = '<GROUP_CHAT_ID>'
  AND m."createdAt" >= '2026-06-07 21:00:00' AND m."createdAt" < '2026-06-08 21:00:00'
  AND (m.content::text ILIKE '%Слушаю%'
    OR m.content::text ILIKE '%Хорошо%'
    OR m.content::text ILIKE '%жду задачу%'
    OR m.content::text ILIKE '%Борис%')
ORDER BY m."createdAt";

-- Q4. ActivityLog за окно 14:00–15:00 UTC (= 17:00–18:00 МСК). NB: адресность
--     Бори тут НЕ логируется (см. заголовок). Запрос оставлен на случай иных
--     bot/boris-событий рядом по времени; вероятно вернёт пусто.
SELECT "createdAt", action, "entityType", "entityId", payload
FROM "ActivityLog"
WHERE "createdAt" >= '2026-06-08 14:00:00' AND "createdAt" < '2026-06-08 15:00:00'
  AND (action ILIKE '%boris%' OR action ILIKE '%bot%')
ORDER BY "createdAt";
