# MAX-бот

Бот в MAX = AI-ассистент бизнеса (Спринт 5). На 5.1 — только эхо-смок.

## Конфигурация (.env)

| Переменная | Значение |
|---|---|
| `MAX_BOT_TOKEN` | Токен из dev.max.ru → личный кабинет → Чат-боты → Интеграция → Получить токен |
| `MAX_WEBHOOK_SECRET` | Произвольная строка ≥32 символов; такая же должна быть в настройках webhook на dev.max.ru |
| `MAX_TRANSPORT` | `webhook` (prod) или `long_polling` (local dev) |

## Локальный dev (long polling)

1. В `.env.local`: `MAX_TRANSPORT=long_polling`, заполнить `MAX_BOT_TOKEN`
2. `npm run bot:dev` — воркер тянет апдейты от MAX и отвечает эхо
3. Написать боту в MAX → `echo: <твой текст>`

## Прод (webhook)

1. В Vercel → Settings → Environment Variables: `MAX_TRANSPORT=webhook`, `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET`
2. Деплой (`git push` → автодеплой)
3. На dev.max.ru → Чат-боты → Webhook:
   - URL: `https://budni-crm.vercel.app/api/max/webhook`
   - Secret: тот же что в `MAX_WEBHOOK_SECRET`
4. Тест: написать боту в MAX → должен ответить `echo: <текст>`

## Health-check

`GET https://budni-crm.vercel.app/api/max/webhook` → `{"status":"ok","service":"max-bot-webhook"}`

## Архитектура (Спринты 5.2-5.9, не реализовано)

- 13:00 МСК cron шлёт вопрос клиентам с DYNAMIC-конфигом
- Claude Haiku парсит ответ → JSON `[{locationId, mealType, portions}]` + confidence + reason
- Аномалии (отклонение ±50% от средней по дню недели, число > 100 или ровное, confidence < 0.8) эскалируются в inbox менеджера
- Тон-фильтр: грубое сообщение → priority HIGH в inbox
- Новый клиент: первые 5 ответов всегда в inbox, потом авто-режим
- Полный лог сообщений в `BotMessage` (схема в Sprint 5.0b)
