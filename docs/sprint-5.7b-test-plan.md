# Sprint 5.7b — ручной тест-план через MAX-бот → клиент СИРИУС

Проверяем подключение парсера к PENDING-conv. Все шаги через продакшн-MAX,
тестовый клиент — СИРИУС (один из двух DYNAMIC-клиентов на данный момент).

## Предусловия

- 5.7b задеплоен на Vercel
- Cron `/api/cron/daily-questions` отработал сегодня в 13:00 МСК или будет вручную
  триггернут через `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/daily-questions`
- В БД для СИРИУСа создана `BotConversation` со статусом `PENDING`
- Менеджер с `maxChatId` подключён — будет получать push'и
- Текущее время МСК известно (от него зависит ветка cutoff)

SQL чтобы посмотреть актуальную PENDING-conv:
```sql
SELECT id, "deliveryDate", status, "createdAt"
FROM "BotConversation"
WHERE "clientId" = '<sirius-id>'
ORDER BY "createdAt" DESC
LIMIT 5;
```

---

## Шаг 1 — Кейс A: первый ответ числом, до 18:00 МСК

**Действие:** клиент пишет в MAX: `50`

**Ожидаемый результат:**
- Бот отвечает в MAX: `Принято на DD.MM: <Название точки> — 50.`
  (DD.MM = deliveryDate существующей PENDING-conv)
- В `/inbox` НОВОЙ записи по СИРИУСу нет (если до этого была — она там и остаётся, ничего не дублируется)
- `BotConversation.status` → `CONFIRMED`
- Создан `Order` со `portions=50`, `source=BOT`, `sourceConversationId=<conv-id>`

**SQL-проверка:**
```sql
SELECT status FROM "BotConversation" WHERE id = '<conv-id>';
-- ожидаем CONFIRMED

SELECT id, portions, "totalPrice", source, "sourceConversationId"
FROM "Order"
WHERE "clientId" = '<sirius-id>' AND "deliveryDate" = '<DD>'
ORDER BY "createdAt" DESC LIMIT 5;
-- ожидаем 1 запись portions=50, source='BOT'

SELECT direction, text FROM "BotMessage"
WHERE "conversationId" = '<conv-id>' ORDER BY "createdAt" DESC LIMIT 5;
-- ожидаем IN с parsedJson + OUT с текстом «Принято на DD.MM: ...»
```

---

## Шаг 2 — Кейс B: повторный ответ числом, до 18:00 МСК

**Предусловие:** Шаг 1 уже выполнен, `conv.status='CONFIRMED'`, `Order.portions=50`.

**Действие:** клиент пишет в MAX: `60`

**Ожидаемый результат:**
- Бот отвечает: `Принято изменение, теперь на DD.MM: <Название точки> — 60.`
- `Order.portions` → 60 (та же запись обновлена, не дубль)
- `BotConversation.status` остаётся `CONFIRMED` (не меняется)
- В `/inbox` создаётся новая запись с `reason='ANOMALY_HISTORICAL'` (мы переиспользуем это значение
  из-за отсутствия `ORDER_UPDATED` в enum'е; `humanReason='Клиент изменил уже подтверждённый заказ'`).
  Метка в UI будет «Отклонение от нормы» — проверять по `humanReason`.
- Менеджеру приходит push в MAX

**SQL-проверка:**
```sql
SELECT id, portions FROM "Order" WHERE "sourceConversationId" = '<conv-id>';
-- portions=60, та же id что после Шага 1

SELECT status FROM "BotConversation" WHERE id = '<conv-id>';
-- всё ещё CONFIRMED

SELECT reason, "humanReason", "createdAt" FROM "InboxItem"
WHERE "clientId" = '<sirius-id>' ORDER BY "createdAt" DESC LIMIT 3;
-- последний: reason='ANOMALY_HISTORICAL', humanReason='Клиент изменил...'
```

---

## Шаг 3 — Кейс C: ответ числом после 18:00 МСК

**Предусловие:** текущее время в МСК ≥ 18:00. Если тест днём — можно временно
поменять системное время на машине-тестере, либо подождать вечера, либо сменить
`CUTOFF_HOUR_MSK` в `src/lib/orders/cutoff.ts` на 0 (не делать в проде!).

**Действие:** клиент пишет: `70`

**Ожидаемый результат:**
- Бот отвечает: `Заявки принимаем до 18:00, уточняем по возможности.`
  (НЕ «Принято на DD.MM: ...» — именно эта фраза)
- `Order.portions` обновлён до 70 (или создан если шагов 1-2 не было)
- `BotConversation.status` → `CONFIRMED`
- В `/inbox` запись с `reason='POST_CUTOFF'`, `humanReason='Клиент ответил после 18:00...'`
- Менеджеру push'

**SQL:**
```sql
SELECT reason FROM "InboxItem"
WHERE "clientId" = '<sirius-id>' ORDER BY "createdAt" DESC LIMIT 1;
-- POST_CUTOFF

SELECT portions FROM "Order" WHERE "sourceConversationId" = '<conv-id>';
-- 70
```

---

## Шаг 4 — Кейс D: парсер не понял (жалоба/вопрос)

**Действие:** клиент пишет: `не будет завтра, праздник` (или `а что у вас на ужин?`)

**Ожидаемый результат:**
- Бот **молчит** (нет ответного сообщения в MAX)
- `BotConversation.status` → `AWAITING_MANAGER`
- В `/inbox` запись с `reason='CANCELLATION_INTENT'` (для «не будет завтра»)
  или `reason='NON_NUMERIC'` (для «что у вас на ужин») — зависит от ответа парсера
- Менеджеру push'

**SQL:**
```sql
SELECT status FROM "BotConversation" WHERE id = '<conv-id>';
-- AWAITING_MANAGER

SELECT reason, "humanReason" FROM "InboxItem"
WHERE "clientId" = '<sirius-id>' ORDER BY "createdAt" DESC LIMIT 1;
-- CANCELLATION_INTENT или NON_NUMERIC

SELECT direction, text FROM "BotMessage"
WHERE "conversationId" = '<conv-id>' ORDER BY "createdAt" DESC LIMIT 2;
-- последнее IN с parsedJson.type='cancellation_intent' (или 'question'/'noise')
-- НЕТ OUT (бот не отвечал)
```

---

## Шаг 5 — Кейс E: спонтанное сообщение без PENDING-conv

**Предусловие:** у клиента в БД нет PENDING-conv свежее 30 дней. Если есть —
закрой её через UI или вручную SQL:
```sql
UPDATE "BotConversation" SET status='CANCELLED'
WHERE "clientId"='<sirius-id>' AND status IN ('PENDING','CONFIRMED');
```

**Действие:** клиент пишет: `где мой заказ за прошлый понедельник?`

**Ожидаемый результат:**
- Поведение как в 5.4: бот молчит, создаётся (или продолжается) `AWAITING_MANAGER` conv,
  `InboxItem` с `reason='NON_NUMERIC'`, `humanReason='Спонтанное сообщение от клиента'`
- Push менеджеру

**SQL:**
```sql
SELECT status, "deliveryDate" FROM "BotConversation"
WHERE "clientId"='<sirius-id>' ORDER BY "createdAt" DESC LIMIT 1;
-- AWAITING_MANAGER, deliveryDate = сегодня UTC midnight

SELECT reason, "humanReason" FROM "InboxItem"
WHERE "clientId"='<sirius-id>' ORDER BY "createdAt" DESC LIMIT 1;
-- NON_NUMERIC, 'Спонтанное сообщение от клиента'
```

---

## Дополнительные проверки

### 5.1 — В /inbox/[id] тред показывает все сообщения

После любого шага открыть `/inbox/<inbox-item-id>` менеджером и убедиться что в
треде видны:
- IN-сообщение клиента (с tone-меткой если она не neutral)
- OUT-сообщение бота (если кейсы A/B/C — должно быть)
- Дата/время совпадают

### 5.2 — process-message.ts не падает на пустой текст

Если клиент пришлёт пустое сообщение или с пробелами — должно вернуть
`{action: 'empty_message'}`, в БД ничего не пишется.

### 5.3 — Дубль одного и того же ответа (race condition)

Если клиент быстро отправит `50` два раза подряд — обе обработки должны прийти
к одному и тому же Order (idempotency через бизнес-ключ в saveBotOrders).
Бот ответит дважды (пока — приемлемо).

---

## Что НЕ покрыто этим тест-планом

- Multi-location клиент с разными числами по точкам — нужен второй клиент с 2+ active locations.
- Аномалия по threshold (`portions > MAX_PORTIONS_THRESHOLD`) — отдельно если интересно.
- `safeAnswerStreak` increment — косвенно проверяется через шаги 1 и 2.
- Грубый тон → InboxItem с `priority=HIGH` — отдельно.
