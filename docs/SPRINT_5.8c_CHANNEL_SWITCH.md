# Sprint 5.8c — переключение управленческих каналов с MAX на Telegram

В 5.8c менеджерские push-уведомления и сводки полностью переехали с MAX на Telegram. MAX остался **только** для клиентов (СИРИУС в проде использует его).

## Что переехало с MAX на Telegram

| Канал | Когда | Куда раньше | Куда теперь |
|---|---|---|---|
| Пуш «новое в Inbox» (POST_CUTOFF) | в момент cutoff в кейсе C | MAX, в личку каждого менеджера | Telegram, личка |
| Пуш «новое в Inbox» (аномалии, кейс D) | при ANOMALY_* / NON_NUMERIC | MAX, личка | Telegram, личка |
| Пуш «новое в Inbox» (спонтанное, кейс E) | при сообщении клиента вне cron-цикла | MAX, личка | Telegram, личка |
| Сводка 14:00 МСК | cron `reminder-and-summary-1` | MAX, личка | Telegram, личка |
| Сводка 15:30 МСК | cron `reminder-and-summary-2` | MAX, личка | Telegram, личка |

Все эти пуши теперь содержат inline-кнопку **«📥 Открыть инбокс»**, ведущую на `/inbox` (тех-долг 6.x: когда появится `/inbox/<clientId>`, переделаем `inboxButton(clientId)` на ссылку на конкретного клиента, см. [src/lib/telegram/buttons.ts](../src/lib/telegram/buttons.ts)).

## Новые cron'ы в групповой чат

### 16:05 МСК — `/api/cron/production-summary`

Производственная сводка на **завтра**. Шлётся в `TELEGRAM_GROUP_CHAT_ID`. Кнопка ведёт на `/production?date=<завтра>`.

Содержит:
- Total: порций, локаций, клиентов
- По типу питания: завтрак / обед / ужин (только не-нулевые)
- ✅ Подтверждено — заказы из DYNAMIC-конфигов (или manual без sourceConfig)
- 🔁 Фиксированные — заказы из FIXED-конфигов (Order.sourceConfig.orderType=FIXED)
- ⚠️ Не ответили — активные DYNAMIC-конфиги на завтра без созданного Order

Если заказов нет совсем — короткое «Заказов пока нет, проверьте всё ли в порядке».

### 22:00 МСК — `/api/cron/end-of-day-digest`

Сводка за **сегодня** (день закрылся). Шлётся в групповой чат. Кнопка → `/reports`.

Содержит:
- Total: порций
- Клиентов уникальных
- DELIVERED / общее количество заказов в статусах CONFIRMED, LOCKED, IN_PRODUCTION, OUT_FOR_DELIVERY, DELIVERED

Если заказов на сегодня нет — «Сегодня не было заказов».

Оба cron'а:
- Защищены `Authorization: Bearer ${CRON_SECRET}`
- Идемпотентны на сутки (защита от Vercel cron retry) через `ActivityLog` с action `PRODUCTION_SUMMARY_SENT` / `END_OF_DAY_DIGEST_SENT`
- Пишут метрики в `ActivityLog.payload`

## ENV-переменные

Добавлены в [SPRINT_5.8_TELEGRAM_SETUP.md](SPRINT_5.8_TELEGRAM_SETUP.md):

- `TELEGRAM_GROUP_CHAT_ID` — **required**, ID группового чата (начинается с `-`)
- `TELEGRAM_APP_BASE_URL` — optional, дефолт `https://budni-crm.vercel.app`

Артём добавил оба в `.env.local` локально + Vercel.

## Архитектура (5.8c)

Все управленческие пуши теперь идут через слой [src/lib/telegram/notify.ts](../src/lib/telegram/notify.ts):

- `notifyManagerDirect(userId, text, opts)` — конкретному юзеру в личку (skipped если нет telegramChatId или неактивен)
- `notifyAllManagersDirect(text, opts)` — всем активным ADMIN+MANAGER параллельно. Возвращает `{ sentTo, skippedNoTelegram, failed }`
- `notifyGroup(text, opts)` — в `TELEGRAM_GROUP_CHAT_ID`

`opts` принимает `parseMode` (default 'HTML') и `replyMarkup` (grammy `InlineKeyboard`).

Helper'ы для кнопок: [src/lib/telegram/buttons.ts](../src/lib/telegram/buttons.ts) — `inboxListButton`, `inboxButton`, `productionSummaryButton`, `reportsButton`.

HTML escape: `escapeHtml(text)` экспортируется из notify.ts. **Обязательно** оборачивать все пользовательские строки (имена клиентов, локаций) при parseMode='HTML', иначе Telegram упадёт на `<`, `>`, `&` в данных.

## Что НЕ менялось

- MAX-бот клиентов: `src/lib/max/**`, `src/app/api/max/webhook/route.ts` — нетронуты
- MAX-канал для клиентских ответов: `process-message.ts:211/244/261` — `sendBotMessage(client.maxChatId!, reply)` остаётся
- Клиентские cron'ы в MAX: `daily-questions` (рассылка вопросов), `cutoff-notice` (закрытие в 16:00), client-reminders в `daily-summary.ts:sendRemindersToSilentClients`
- Поле `User.maxChatId` в Prisma — **deprecated**, но не удалено (миграция позже, чтобы не ломать UI и старые ActivityLog)
- UI: `/settings` → `MaxNotificationsSection`, `/settings/users` показывают MAX-онбординг менеджера — это deprecated UI, переделаем в 6.x

## Smoke-инструкция (Артёму после деплоя)

ENV `TELEGRAM_GROUP_CHAT_ID` должен быть проставлен в Vercel **до** деплоя — иначе production-summary / end-of-day-digest упадут на первом вызове.

### 1. Пуши в инбоксе (личка)

В личке у каждого менеджера с привязанным Telegram должен появиться пуш при:
- кейсе C — клиент ответил после 16:00
- кейсе D — аномалия / не-числовой ответ
- кейсе E — клиент написал спонтанно

Проверка: создать тестовое сообщение через MAX от тестового клиента после 16:00 → должен прийти пуш в личку Telegram (а не в MAX).

### 2. Сводки 14:00 / 15:30 (личка)

Триггер вручную:

```bash
curl -i -X GET "https://budni-crm.vercel.app/api/cron/reminder-and-summary-1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Должна прилететь сводка в личку Telegram. В ответе JSON будет `sent_summaries_to_managers: N`. В Vercel logs — `[telegram/notify] notifyAllManagers: sentTo=N skippedNoTelegram=M failed=K`.

### 3. Производственная сводка 16:05 (группа)

```bash
curl -i -X GET "https://budni-crm.vercel.app/api/cron/production-summary" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Должно прилететь в групповой чат, с кнопкой «🍳 Производственная сводка» → `/production?date=YYYY-MM-DD`.

Повторный вызов в тот же день вернёт `{ skipped: true, reason: 'already_ran_today' }` — это идемпотентность работает.

### 4. End-of-day-digest 22:00 (группа)

```bash
curl -i -X GET "https://budni-crm.vercel.app/api/cron/end-of-day-digest" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Должно прилететь в групповой чат с кнопкой «📊 Открыть аналитику».

## Откатить если что-то пошло не так

### Полный откат cron'ов (если форматы сообщений ломаются)

Удалить 2 строки из `vercel.json`:

```json
{ "path": "/api/cron/production-summary", "schedule": "5 13 * * *" },
{ "path": "/api/cron/end-of-day-digest", "schedule": "0 19 * * *" }
```

Закоммитить, задеплоить → Vercel перестанет их триггерить.

### Откатить пуши обратно в MAX (нежелательно, но возможно)

В `git log` найти коммит до 5.8c и cherry-pick откатные правки:
- `src/lib/bot/notify-managers.ts` — вернуть импорт `sendBotMessage` и обход по `User.maxChatId`
- `src/lib/bot/daily-summary.ts:sendSummaryToManagers` — то же

Поля `User.maxChatId` всё ещё в БД, данные не потеряны, откат технически возможен. Но MAX-канал менеджеров не получал апдейтов с 5.8c — менеджеры могли пройти онбординг только в Telegram, у некоторых maxChatId уже null.

### Бот не пишет в группу (403)

Симптом: `production-summary` / `end-of-day-digest` возвращают `{ sentToGroup: false, error: 'forbidden' }` или `'chat_not_found'`.

Причины:
- Бот не добавлен в группу
- Бота кикнули
- Неверный `TELEGRAM_GROUP_CHAT_ID`
- В супергруппах с топиками: бот должен иметь право писать в General

Лечение: добавить бота заново через @BotFather → группа → Add admins (или Members с правом «Send messages»). Проверить ID через `getUpdates` или `@getidsbot`.

## Известные ограничения

- inline-кнопки в пушах инбокса ведут на список `/inbox`, а не на конкретный `/inbox/<clientId>` — тех-долг 6.x.
- Менеджеры без Telegram-онбординга пропускаются в счётчике `skippedNoTelegram`. В UI это пока не видно — стоит в 6.x добавить badge в `/settings/users` «нет TG».
- `User.maxChatId` deprecated, но всё ещё показывается в UI карточек юзеров (как «✓ привязан» / «—»). Подчистим в 6.x вместе с дропом поля из схемы.
