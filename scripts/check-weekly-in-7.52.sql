-- check-weekly-in-7.52.sql
-- Разведка 2 (спринт 7.52): «помоему я не видел что клиент написал» — про
-- WEEKLY-клиентов (раз в неделю присылают заявку на след. неделю).
--
-- Что показывает код (для интерпретации результатов):
--   • Входящее WEEKLY-сообщение ЛОГИРУЕТСЯ как BotMessage(IN, conversationId=NULL)
--     ДО парсинга — src/lib/max/handlers.ts:84-91 (фикс #6).
--   • Список /inbox строится по BotMessage(IN, readAt IS NULL) — а НЕ по InboxItem
--     (src/app/(app)/inbox/actions.ts:46,67-71). Значит unread-бейдж должен гореть.
--   • Успешная WEEKLY-заявка InboxItem НЕ создаёт (только дубль/файл-вложение);
--     surfacing менеджеру — Telegram-пуш notifyManagerAboutWeeklySubmission.
--
-- Цель SQL — эмпирически проверить: (а) приходят ли IN от WEEKLY вообще;
-- (б) какой у них readAt (NULL = должны бейджиться); (в) есть ли по ним InboxItem.
-- ТОЛЬКО SELECT. Запускать вручную в Neon SQL Editor.

-- ────────────────────────────────────────────────────────────────────────────
-- Q1. WEEKLY-клиенты: клиент + точка + конфиг (orderType='WEEKLY').
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  c.id            AS client_id,
  c.name          AS client_name,
  c."maxChatId",
  c."isActive"    AS client_active,
  l.id            AS location_id,
  l.name          AS location_name,
  mc.id           AS config_id,
  mc."mealType",
  mc."orderType",
  mc."isActive"   AS config_active
FROM "Client" c
JOIN "ClientMealConfig" mc ON mc."clientId" = c.id AND mc."orderType" = 'WEEKLY'
JOIN "ClientLocation" l ON l.id = mc."locationId"
ORDER BY c.name, l.name;

-- ────────────────────────────────────────────────────────────────────────────
-- Q2. Все IN-сообщения от WEEKLY-клиентов за 14 дней: время (МСК), conversationId,
--     readAt (NULL → должно гореть unread в /inbox), текст.
--     Если строк НЕТ при том, что клиенты явно писали → IN реально теряются.
--     Если строки ЕСТЬ и readAt=NULL → сообщение в БД и должно быть видно в списке.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  (bm."createdAt" AT TIME ZONE 'Europe/Moscow') AS sent_at_msk,
  c.name           AS client_name,
  bm."conversationId",
  bm."readAt",
  bm.text
FROM "BotMessage" bm
JOIN "Client" c ON c.id = bm."clientId"
WHERE bm.direction = 'IN'
  AND bm."createdAt" >= now() - interval '14 days'
  AND bm."clientId" IN (
    SELECT DISTINCT mc."clientId"
    FROM "ClientMealConfig" mc
    WHERE mc."orderType" = 'WEEKLY'
  )
ORDER BY bm."createdAt" DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- Q3. InboxItem по тем же WEEKLY-клиентам за 14 дней: reason, status, есть ли
--     managerReply (hasReply), привязка к conversation. Покажет, создаётся ли
--     вообще InboxItem на WEEKLY (ожидаемо — только для дублей/файлов).
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  (ii."createdAt" AT TIME ZONE 'Europe/Moscow') AS created_at_msk,
  c.name              AS client_name,
  ii.reason,
  ii.status,
  ii."conversationId",
  (ii."managerReply" IS NOT NULL) AS has_reply,
  ii."humanReason"
FROM "InboxItem" ii
JOIN "Client" c ON c.id = ii."clientId"
WHERE ii."createdAt" >= now() - interval '14 days'
  AND ii."clientId" IN (
    SELECT DISTINCT mc."clientId"
    FROM "ClientMealConfig" mc
    WHERE mc."orderType" = 'WEEKLY'
  )
ORDER BY ii."createdAt" DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- Q4. (контекст) WeeklyOrderSubmission по WEEKLY-клиентам за 14 дней: статус
--     обработки заявок (AUTO_CONFIRMED / NEEDS_REVIEW / FAILED), чтобы сопоставить
--     с наличием IN-сообщений и пушей.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  (w."createdAt" AT TIME ZONE 'Europe/Moscow') AS created_at_msk,
  c.name AS client_name,
  w.status,
  w."weekStartDate",
  w.source
FROM "WeeklyOrderSubmission" w
JOIN "Client" c ON c.id = w."clientId"
WHERE w."createdAt" >= now() - interval '14 days'
ORDER BY w."createdAt" DESC;
