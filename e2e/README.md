# e2e — Playwright тесты CRM «Будни»

## Запуск локально

1. **Поднять окружение:**
   - Локальная БД (Postgres.app) с накатанными миграциями.
   - Dev-сервер: `npm run dev` (запускается отдельно, конфиг НЕ поднимает его автоматически).
   - Seed тестового клиента: `npm run db:seed:smoke` (создаёт `SMOKE_TEST_CLIENT` + точку).
   - Установить переменную: `export PLAYWRIGHT_ADMIN_PIN=...` (значение из локального `.env.test`).

2. **Запуск:**
   - `npm run test:e2e` — все тесты.
   - `npm run test:e2e:smoke` — только тесты с тегом `@smoke`.
   - `npm run test:e2e:ui` — UI-режим Playwright (отладка).
   - `npm run test:e2e:report` — открыть HTML-отчёт после прогона.

## Структура

- `fixtures/auth.ts` — фикстура с авторизованной страницей. Логинится через PIN, кеширует storage в `.auth/admin.json`.
- `helpers/smoke-client.ts` — константы и хелперы для работы с `SMOKE_TEST_CLIENT`.
- `*.spec.ts` — сами тесты.

## SMOKE_TEST_CLIENT

В БД seed создаёт клиент-«робота» с предсказуемыми данными:
- `Client.name = 'SMOKE_TEST_CLIENT'`
- `ClientLocation.name = 'SMOKE_TEST_LOCATION'`, окно доставки 12:00-14:00.
- `OurLegalEntity.shortName = 'SMOKE_TEST_LEGAL'`.

Тесты работают только с этими сущностями, не трогают живые данные.

## Браузеры

Только Chromium (один проект). Firefox/WebKit не устанавливаем — экономим время и место.

## CI

В GitHub Actions: `retries: 2` (защита от фантомов), `workers: 1` (БД не параллелится на пилоте).
