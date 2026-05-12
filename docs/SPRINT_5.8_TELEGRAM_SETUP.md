# Sprint 5.8 — Telegram migration setup

Миграция пушей о новых обращениях и сводок менеджеров с MAX на Telegram.

## 5.8a — что я (Артём) должен сделать вручную

### 1. Завести бота в Telegram

1. Открыть [@BotFather](https://t.me/BotFather) в Telegram
2. `/newbot` → задать имя и username (username должен заканчиваться на `bot`)
3. BotFather пришлёт **HTTP API token** в формате `1234567890:AAH...` — это `TELEGRAM_BOT_TOKEN`
4. Username бота (без `@`) — это `TELEGRAM_BOT_USERNAME`. Узнать позже можно через `/mybots` → выбрать бота → видно `@<username>`, копируй БЕЗ `@`

### 2. Сгенерировать webhook secret

В терминале:

```bash
openssl rand -hex 32
```

Полученная строка — `TELEGRAM_WEBHOOK_SECRET`. Это значение Telegram будет присылать в заголовке `X-Telegram-Bot-Api-Secret-Token` на каждый webhook, чтобы мы могли убедиться что запрос пришёл от Telegram, а не от кого-то ещё.

Минимальная длина — 16 символов, но рекомендуется 64 (`openssl rand -hex 32`).

### 3. Добавить переменные в `.env.local`

Формат (примеры, **без реальных значений**):

```
TELEGRAM_BOT_TOKEN=1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_USERNAME=budni_crm_bot
TELEGRAM_WEBHOOK_SECRET=<вывод openssl rand -hex 32>
```

**НЕ коммитить `.env.local`** — он в `.gitignore`. Если случайно закоммитил — отозвать токен у BotFather (`/revoke`) и перевыпустить.

### 4. Добавить те же переменные в Vercel

Project Settings → Environment Variables. Скоупы:

- `TELEGRAM_BOT_TOKEN` — Production, Preview (Development НЕ нужен — там `.env.local`)
- `TELEGRAM_BOT_USERNAME` — Production, Preview
- `TELEGRAM_WEBHOOK_SECRET` — Production, Preview

После добавления — redeploy (или они подтянутся при следующем деплое).

### 5. Проверка

Локально:

```bash
npm run dev
```

При первом импорте `getTelegramEnv()` (это будет в 5.8b) валидация проверит все три переменные. Если хоть одна не задана или не валидна — будет понятная ошибка с указанием что именно не так.

---

## Что уже сделано в 5.8a (автоматически)

- Установлен `grammy` (Telegram Bot API client для Node.js)
- В `prisma/schema.prisma` в модель `User` добавлены поля:
  - `telegramChatId` (unique, nullable)
  - `telegramUsername` (nullable)
  - `telegramOnboardingToken` (unique, nullable)
  - `telegramOnboardingExpiresAt` (nullable)
- Создан `src/lib/telegram/env.ts` с функцией `getTelegramEnv()` (ленивая валидация — кидается только при вызове, не при импорте)

## Что НЕ сделано и пойдёт в 5.8b/c

- Обработчики бота (`grammy` Bot instance, команды `/start`, обработка ответов)
- Webhook-эндпоинт `/api/telegram/webhook`
- Send-функции для пушей менеджерам и сводок
- Onboarding-флоу: генерация токена, deeplink `https://t.me/<username>?start=<token>`, привязка `telegramChatId` к User
- Переключение существующих пушей с MAX-канала менеджеров на Telegram
