# Sprint 5.8b — Telegram bot runtime

В 5.8b поднят рантайм Telegram-бота для менеджеров: webhook, onboarding, send-функция, UI на `/settings/telegram`.

**Push'и о новых обращениях и сводки 14:00/15:30 в этом спринте ПОКА остаются на MAX.** Переключение источников — в 5.8c. MAX-бот клиентов не трогаем — он живой и работает.

## Архитектура

| Файл | Назначение |
|---|---|
| [src/lib/telegram/env.ts](../src/lib/telegram/env.ts) | `getTelegramEnv()` — ленивая валидация ENV |
| [src/lib/telegram/bot.ts](../src/lib/telegram/bot.ts) | Singleton `Bot` из grammy + хендлеры `/start` и fallback |
| [src/lib/telegram/send.ts](../src/lib/telegram/send.ts) | `sendTelegramMessage(chatId, text)` — не кидает, возвращает `{ok, error?}` |
| [src/lib/telegram/actions.ts](../src/lib/telegram/actions.ts) | Server actions: `generateTelegramOnboardingToken`, `unlinkTelegram` |
| [src/app/api/telegram/webhook/route.ts](../src/app/api/telegram/webhook/route.ts) | POST handler с проверкой `X-Telegram-Bot-Api-Secret-Token` |
| [src/app/(app)/settings/telegram/page.tsx](../src/app/(app)/settings/telegram/page.tsx) | UI — статус, deeplink, отвязка |
| [scripts/setup-telegram-webhook.ts](../scripts/setup-telegram-webhook.ts) | Разовая регистрация webhook'а в Telegram |

## Как зарегистрировать webhook (после деплоя 5.8b)

1. Убедись что 5.8b задеплоен на прод. Быстрая проверка:

   ```bash
   curl -i https://budni-crm.vercel.app/api/telegram/webhook
   ```
   Ожидаемо: `HTTP/2 405` с телом `method not allowed` — это норма (Telegram шлёт только POST).

2. Локально в терминале:

   ```bash
   WEBHOOK_BASE_URL=https://budni-crm.vercel.app npm run telegram:setup-webhook
   ```

   Скрипт читает `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET` из `.env.local` (через `dotenv-cli` в npm-скрипте). `WEBHOOK_BASE_URL` обязателен в переменной окружения вызова.

3. Скрипт выведет `✅ Webhook зарегистрирован: <url>` + `getWebhookInfo` с тем же url и `has_custom_certificate: false`. Если в `getWebhookInfo` `last_error_message` пустой — всё ок.

4. Тест: открой Telegram → найди `@<bot_username>` (тот же, что в `TELEGRAM_BOT_USERNAME`) → отправь `/start` (без аргумента) → бот должен ответить:

   > Добро пожаловать. Этот бот — для менеджеров CRM «Будни». Чтобы привязать аккаунт, зайдите в CRM → Настройки → Telegram и сгенерируйте ссылку.

   Если ответа нет — смотри логи Vercel (`/api/telegram/webhook`) или `getWebhookInfo`.

## Smoke-тест onboarding

1. Зайти в `https://budni-crm.vercel.app/login` → залогиниться под ADMIN (или MANAGER).
2. Открыть `https://budni-crm.vercel.app/settings/telegram`.
3. Нажать «Сгенерировать ссылку» → появится deeplink вида `https://t.me/<bot_username>?start=<48-hex-char-token>`.
4. Кликнуть «Открыть в Telegram» → Telegram откроет диалог с ботом → нажать `START` (или `/start`).
5. Бот ответит: `Готово, <имя>. Уведомления и сводки теперь будут приходить сюда.`
6. Вернуться на `/settings/telegram` (или router.refresh / F5) → теперь видно «Telegram привязан» + `@<username>` + кнопка «Отвязать».
7. Проверить в Neon (dev SQL Editor):

   ```sql
   SELECT id, name, "telegramChatId", "telegramUsername",
          "telegramOnboardingToken", "telegramOnboardingExpiresAt"
   FROM "User"
   WHERE id = '<your user id>';
   ```

   Ожидаемо: `telegramChatId` и `telegramUsername` заполнены, оба onboarding-поля = `NULL`.

8. Проверить ActivityLog:

   ```sql
   SELECT "createdAt", action, "entityId", payload
   FROM "ActivityLog"
   WHERE action IN ('TELEGRAM_ONBOARDED', 'TELEGRAM_UNLINKED')
   ORDER BY "createdAt" DESC
   LIMIT 5;
   ```

## Откатить если что-то пошло не так

### Снять webhook у Telegram

Через curl (нужен `TELEGRAM_BOT_TOKEN`):

```bash
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=true"
```

После этого Telegram перестанет слать апдейты, бот замолчит. Заново зарегистрировать — снова `npm run telegram:setup-webhook`.

### Откатить миграцию

Не требуется. Поля `telegramChatId / telegramUsername / telegramOnboardingToken / telegramOnboardingExpiresAt` все nullable — они не сломают MAX-бот клиентов, cron'ы или любые существующие запросы. В крайнем случае можно ALTER TABLE DROP COLUMN (по одной), но это не требуется для отката функционала — достаточно снять webhook.

### Отвязать всем юзерам разом (на случай если что-то пошло не так в проде)

```sql
UPDATE "User"
SET "telegramChatId" = NULL,
    "telegramUsername" = NULL,
    "telegramOnboardingToken" = NULL,
    "telegramOnboardingExpiresAt" = NULL;
```

После этого юзеры пройдут onboarding заново.

## Ограничения 5.8b (закрыто в 5.8c)

- Нет навигационной ссылки на `/settings/telegram` из `/settings` — открывать прямым URL.
- Push'и менеджерам и сводки 14:00/15:30 пока шлются в MAX (`src/lib/inbox/process-message.ts`, cron'ы). Переключение — в 5.8c.
- Бот не отвечает на текстовые сообщения кроме fallback-фразы — это сознательно, обработка ответов менеджера в Telegram пока не планируется.
