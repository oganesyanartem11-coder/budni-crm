-- check-morning-briefing-7.52.sql
-- Разведка 1 (спринт 7.52): в утреннем брифинге Бори для same-day-клиентов,
-- не подтвердивших заказ, в тексте звучит НАЗВАНИЕ ТОЧКИ (location.name,
-- напр. «Торбеево»), а не ЮРЛИЦО (client.name, напр. «СК Техник»).
--
-- Корень в коде: src/lib/boris/morning/context-builder.ts:212-236 строит
-- pendingSameDayToday, выбирая ТОЛЬКО location.name (client.name не тянется);
-- ветка attention :356-362 и system-prompt.ts:31,67 печатают locationName.
--
-- ЭТОТ SQL — для ГЛАЗНОЙ перепроверки: какие реальные имена попадали в брифинги
-- исторически (точки или юрлица). ТОЛЬКО SELECT, ничего не меняет.
-- Запускать вручную в Neon SQL Editor.

-- content всех утренних брифингов за 14 дней (свежие сверху).
SELECT
  b."generatedAt",
  (b."generatedAt" AT TIME ZONE 'Europe/Moscow') AS generated_at_msk,
  b."sentToTg",
  b."isDryRun",
  b.content
FROM "BorisBriefing" b
WHERE b.type = 'MORNING'
  AND b."generatedAt" >= now() - interval '14 days'
ORDER BY b."generatedAt" DESC
LIMIT 14;

-- (опц.) Заодно — что именно лежало во входных данных LLM (contextData),
-- ветка day.pendingSameDayToday: видно, что там только locationName/cutoffLabel.
-- Раскомментируй при необходимости:
-- SELECT
--   b."generatedAt",
--   b."contextData" -> 'day' -> 'pendingSameDayToday' AS pending_sameday_input
-- FROM "BorisBriefing" b
-- WHERE b.type = 'MORNING'
--   AND b."generatedAt" >= now() - interval '14 days'
-- ORDER BY b."generatedAt" DESC
-- LIMIT 14;
