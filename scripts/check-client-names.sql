-- ============================================================================
-- check-client-names.sql
-- READ-ONLY диагностика имён клиентов (ШАГ 0 мегаспринта Бориса).
--
-- НЕ выполнять на локальной БД (.env.test / .env.local) — там нет пилотных
-- клиентов. Выполнять ТОЛЬКО на Production через Vercel Postgres SQL Editor
-- (или Neon SQL Editor / psql с production DATABASE_URL).
--
-- Цель: понять, хранит ли Client.name юрлицо (напр. «СК Техник») или название
-- точки (напр. «Торбеево»). От этого зависит, баг 14/9 в коде или в данных.
-- ============================================================================

-- Q1. Все активные клиенты: имя (юрлицо?), привязка к MAX-чату, активность.
SELECT id, name, "maxChatId", "isActive"
FROM "Client"
WHERE "isActive" = true
ORDER BY name;

-- Q2. Перепроверка конкретных клиентов из жалобы (Торбеево / Аэропорт / ТЭЦ).
--     Сопоставляет Client.name с названиями их локаций (ClientLocation.name),
--     чтобы увидеть, не «уехало» ли название точки в поле юрлица.
SELECT c.id, c.name, l.name AS location_name
FROM "Client" c
LEFT JOIN "ClientLocation" l ON l."clientId" = c.id
WHERE c."isActive" = true
  AND (
    c.name ILIKE '%торбеево%' OR c.name ILIKE '%аэропорт%' OR c.name ILIKE '%тэц%'
    OR l.name ILIKE '%торбеево%' OR l.name ILIKE '%аэропорт%' OR l.name ILIKE '%тэц%'
  )
ORDER BY c.name;
