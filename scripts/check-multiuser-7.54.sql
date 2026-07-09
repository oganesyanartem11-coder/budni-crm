-- check-multiuser-7.54.sql
-- Разведка спринта 7.54 (фундамент multi-user MAX): сейчас Client.maxChatId —
-- единственная привязка (String? @unique), один клиент = один MAX-пользователь.
-- Хотим N пользователей на клиента, один активный. Этот SQL оценивает данные
-- ПЕРЕД миграцией. ТОЛЬКО SELECT, ничего не меняет. Запускать вручную в Neon.
--
-- Факты схемы (для интерпретации):
--   • Client.maxChatId String? @unique (schema:398). Прочие Max-поля: maxUsername,
--     maxOnboardingToken @unique, locationAliases (для локаций, НЕ chatId).
--   • BotMessage НЕ имеет своего chatId — только clientId (NOT NULL). Значит
--     «входящее от неопознанного chatId» в БД НЕ логируется (process-message при
--     unknown chatId молча выходит). Масштаб «неопознанных» из БД не измерить —
--     только из webhook-логов Vercel. Q3 переформулирован под измеримое.
--   • Единственные хранилища chatId клиента: Client.maxChatId и
--     PendingOrderChange.sourceMaxChatId (снимок на момент запроса, schema:515).

-- ────────────────────────────────────────────────────────────────────────────
-- Q1. Сколько активных клиентов реально привязано к MAX (есть maxChatId) vs нет.
--     Показывает объём привязок к миграции в новую таблицу.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  COUNT(*) FILTER (WHERE "maxChatId" IS NOT NULL) AS active_with_chat,
  COUNT(*) FILTER (WHERE "maxChatId" IS NULL)     AS active_without_chat,
  COUNT(*)                                        AS active_total
FROM "Client"
WHERE "isActive" = true;

-- ────────────────────────────────────────────────────────────────────────────
-- Q2. Дубли maxChatId — один и тот же chatId у РАЗНЫХ клиентов.
--     @unique теоретически это запрещает, но проверяем фактически (вдруг
--     ограничение добавлено позже данных / есть аномалии). Если строки есть —
--     разрулить ДО миграции. Ожидание: 0 строк.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  "maxChatId",
  COUNT(*)                       AS clients_count,
  array_agg("id")                AS client_ids,
  array_agg("name")              AS client_names
FROM "Client"
WHERE "maxChatId" IS NOT NULL
GROUP BY "maxChatId"
HAVING COUNT(*) > 1;

-- ────────────────────────────────────────────────────────────────────────────
-- Q3a. Активность входящих за 30 дней: сколько РАЗНЫХ клиентов реально пишут
--      боту (direction='IN'), и объём. Все они опознаны (clientId NOT NULL).
--      Контекст «сколько привязок живые», а не музейные.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                          AS in_messages_30d,
  COUNT(DISTINCT "clientId")        AS distinct_clients_inbound_30d
FROM "BotMessage"
WHERE direction = 'IN'
  AND "createdAt" >= now() - interval '30 days';

-- ────────────────────────────────────────────────────────────────────────────
-- Q3b. Прокси «неопознанных / дрейфа chatId»: chatId, засветившиеся в
--      PendingOrderChange.sourceMaxChatId, которых НЕТ ни у одного Client.maxChatId.
--      Если строки есть — это chatId, которые писали (создали change), но больше
--      не привязаны к клиенту (сменили/отвязали). Сигнал, что снимок sourceMaxChatId
--      и «активный пользователь» расходятся — важно для дизайна active-session.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  poc."sourceMaxChatId",
  COUNT(*)                          AS changes_count,
  MIN(poc."createdAt")              AS first_seen,
  MAX(poc."createdAt")              AS last_seen
FROM "PendingOrderChange" poc
LEFT JOIN "Client" c ON c."maxChatId" = poc."sourceMaxChatId"
WHERE c."id" IS NULL
GROUP BY poc."sourceMaxChatId"
ORDER BY last_seen DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- Q3c. (контекст) Распределение клиентов по объёму входящих за 30 дней —
--      топ говорящих. Помогает понять, у кого многопользовательский доступ
--      вероятнее всего понадобится (большие клиенты с несколькими сотрудниками).
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  c."name"                          AS client_name,
  c."maxChatId",
  COUNT(*)                          AS in_messages_30d
FROM "BotMessage" bm
JOIN "Client" c ON c."id" = bm."clientId"
WHERE bm.direction = 'IN'
  AND bm."createdAt" >= now() - interval '30 days'
GROUP BY c."id", c."name", c."maxChatId"
ORDER BY in_messages_30d DESC
LIMIT 30;
