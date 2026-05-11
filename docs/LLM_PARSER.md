# LLM-парсер ответов клиента (Спринт 5.2)

Парсит свободный текст клиента в MAX → структурированный заказ или эскалацию.

## Модель

- **Anthropic Claude Haiku 4.5** (пинованная версия `claude-haiku-4-5-20251001`)
- ENV: `ANTHROPIC_API_KEY`
- ~~$0.001 за вызов (input ≈ 800 токенов, output ≈ 150). При 50-200 клиентах в день: ~$5-15/мес.

## Структура `ParsedResponse`

```ts
type ParsedResponse = {
  type: 'numeric' | 'cancellation_intent' | 'question' | 'noise'
  items: { locationId: string; locationName: string; portions: number }[]
  confidence: number    // 0..1
  reason: string        // человеческое объяснение
  toneLabel: 'neutral' | 'rude' | 'thanks' | 'urgent'
  rawClientText: string
  rawLlmResponse: string
}
```

## Что считается аномалией

`detectAnomalies(parsed, stats, isNewClient, isPastCutoff)` возвращает `AnomalyResult`. Приоритеты проверок (первое сработавшее побеждает):

| # | Причина (`InboxItemReason`) | Условие | Priority |
|---|---|---|---|
| 1 | `POST_CUTOFF` | Сообщение после 18:00 МСК | NORMAL |
| 2 | `NON_NUMERIC` (rude) | `toneLabel === 'rude'` | **HIGH** |
| 3 | `CANCELLATION_INTENT` | LLM распознал отмену | NORMAL |
| 4 | `NON_NUMERIC` | `type === 'question' \| 'noise'` | NORMAL |
| 5 | `ANOMALY_LLM_CONFIDENCE` | `confidence < 0.8` | NORMAL |
| 6 | `ANOMALY_THRESHOLD` | `portions < 10 \| > 200 \| ∈ {100, 200, 300, 500, 777, 1000}` | NORMAL |
| 7 | `ANOMALY_HISTORICAL` | Отклонение >50% от средней по дню недели (если sampleSize ≥ 3) | NORMAL |
| 8 | `NEW_CLIENT` | `safeAnswerStreak < 5` | NORMAL |

«Безопасный» ответ (не сработала ни одна проверка) → бот сохраняет молча, инкрементирует `Client.safeAnswerStreak`.

## Smoke-тест

Требует `ANTHROPIC_API_KEY` в `.env.local`. Запуск:

```bash
npm run test:llm
```

12 тестовых кейсов: цифры, синонимы точек, отмена, грубый тон, благодарность, вопрос. Скрипт распечатает `PARSED:` и `ANOMALY:` для каждого. **Стоит ~$0.012 за прогон** (12 вызовов × ~$0.001).

## Что НЕ делает 5.2

- Не вызывается из webhook (это в 5.3)
- Не сохраняет `BotMessage`/`InboxItem` в БД (это в 5.3)
- Не учитывает прошлые reply'и в той же `BotConversation` — каждый вызов изолированный (multi-turn — в 5.4+)
