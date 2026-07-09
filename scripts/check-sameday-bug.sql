-- check-sameday-bug.sql
-- Разведка спринта: same-day клиент «Ск Техник» получает напоминания «до 16:00»
-- в 07:40 / 14:00 / 15:30, игнорируя персональный cut-off ~8:40 (08.06.2026, пн).
--
-- ЗАПУСКАТЬ ВРУЧНУЮ в Neon SQL Editor. Скрипт только читает (SELECT), ничего не меняет.
-- Имена таблиц/колонок — PascalCase в кавычках (Prisma без @@map).
--
-- Все поля cut-off живут на ClientLocation:
--   "sameDayDelivery" boolean, "cutoffHourMsk" int NULL, "cutoffMinuteMsk" int NULL
--   (NULL → fallback 16:00 в коде).
--
-- МСК-день 08.06.2026 в UTC = [2026-06-07 21:00:00Z, 2026-06-08 21:00:00Z).

-- ────────────────────────────────────────────────────────────────────────────
-- Q1. Клиент «Ск Техник» + его локации с cut-off и same-day флагом.
--     Хотим увидеть: есть ли sameDayDelivery=true и какое значение cutoffHourMsk/
--     cutoffMinuteMsk (8:40? NULL? иное?).
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  c.id              AS client_id,
  c.name            AS client_name,
  c."maxChatId"     AS max_chat_id,
  c."isActive"      AS client_active,
  l.id              AS location_id,
  l.name            AS location_name,
  l."isActive"      AS location_active,
  l."sameDayDelivery",
  l."cutoffHourMsk",
  l."cutoffMinuteMsk",
  -- как код это интерпретирует (fallback 16:00 / :00):
  COALESCE(l."cutoffHourMsk", 16)   AS effective_cutoff_hour,
  COALESCE(l."cutoffMinuteMsk", 0)  AS effective_cutoff_minute
FROM "Client" c
LEFT JOIN "ClientLocation" l ON l."clientId" = c.id
WHERE c.id = 'cmpvbx3jl000xlg04u3o7qj07'
ORDER BY l."isActive" DESC, l.name;

-- ────────────────────────────────────────────────────────────────────────────
-- Q2. BotConversation этого клиента за МСК-08.06 (статус + deliveryDate).
--     Подтверждает, что в этот день была PENDING-conv (которую ловят reminder-1/2).
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  bc.id            AS conversation_id,
  bc.status,
  bc."deliveryDate",
  bc."questionVariant",
  bc."createdAt"   AS created_at_utc,
  (bc."createdAt" AT TIME ZONE 'Europe/Moscow') AS created_at_msk
FROM "BotConversation" bc
WHERE bc."clientId" = 'cmpvbx3jl000xlg04u3o7qj07'
  AND bc."createdAt" >= '2026-06-07 21:00:00+00'
  AND bc."createdAt" <  '2026-06-08 21:00:00+00'
ORDER BY bc."createdAt";

-- ────────────────────────────────────────────────────────────────────────────
-- Q3. ВСЕ BotMessage этого клиента за МСК-08.06: время (МСК), направление, текст.
--     Проверяем гипотезу: реально ли ушли OUT-сообщения ~07:40 / ~14:00 / ~15:30
--     с «до 16:00». Если да — reminder-1/2 их не отфильтровали (баг рассылки),
--     а 07:40 — баг текста (хардкод «до 16:00» без персонального cut-off).
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  (bm."createdAt" AT TIME ZONE 'Europe/Moscow') AS sent_at_msk,
  bm.direction,
  bm."conversationId",
  bm.text
FROM "BotMessage" bm
WHERE bm."clientId" = 'cmpvbx3jl000xlg04u3o7qj07'
  AND bm."createdAt" >= '2026-06-07 21:00:00+00'
  AND bm."createdAt" <  '2026-06-08 21:00:00+00'
ORDER BY bm."createdAt";

-- ────────────────────────────────────────────────────────────────────────────
-- Q4. (опционально) Поиск по maxChatId, если clientId окажется не тот.
--     285138900 — MAX-чат из жалобы. Резолвим клиента по чату и смотрим его cut-off.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  c.id, c.name, c."maxChatId",
  l.name AS location_name, l."sameDayDelivery",
  l."cutoffHourMsk", l."cutoffMinuteMsk"
FROM "Client" c
LEFT JOIN "ClientLocation" l ON l."clientId" = c.id
WHERE c."maxChatId" = '285138900';
