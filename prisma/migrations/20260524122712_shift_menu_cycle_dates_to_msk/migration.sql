-- Sprint 7.6 A.2: shift MenuCycle dates from UTC-midnight to MSK-midnight as UTC point
-- validFrom (Mon 00:00) → (Sun 21:00 same week) — представление MSK Mon 00:00
-- validTo  (Sun 00:00) → (Sun 20:59:59.999 same Sun) — представление MSK Sun 23:59:59.999
--
-- Колонки timestamp without time zone — EXTRACT работает над записанными компонентами TZ-нейтрально.
-- Условие WHERE = 'компоненты времени == полночь' защищает от двойного применения и
-- от записей с уже-сдвинутым временем.

UPDATE "MenuCycle"
SET "validFrom" = "validFrom" - INTERVAL '3 hours'
WHERE EXTRACT(HOUR FROM "validFrom") = 0
  AND EXTRACT(MINUTE FROM "validFrom") = 0
  AND EXTRACT(SECOND FROM "validFrom") = 0;

UPDATE "MenuCycle"
SET "validTo" = "validTo" + INTERVAL '20 hours 59 minutes 59 seconds 999 milliseconds'
WHERE EXTRACT(HOUR FROM "validTo") = 0
  AND EXTRACT(MINUTE FROM "validTo") = 0
  AND EXTRACT(SECOND FROM "validTo") = 0;
