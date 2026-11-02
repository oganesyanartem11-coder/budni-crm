# Будни CRM

CRM для кейтеринг-компании «Будни». Управление клиентами, меню, заказами, доставкой и финансовой отчётностью.

## Tech stack
Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, Prisma 6 + PostgreSQL (Neon), shadcn/ui (radix-nova), recharts, lucide-react, sonner, jose.

## Local development
```bash
npm install
cp .env.example .env.local
# Fill in DATABASE_URL, DIRECT_URL, JWT_SECRET, CRON_SECRET
npx prisma migrate dev
npm run db:seed
npm run dev
```
Open http://localhost:3000. Test users: ADMIN 1111, MANAGER 2222, CHEF 3333, COURIER 4444.

## AI для клиентских сообщений

Добавьте `OPENAI_API_KEY` в `.env.local` (локально) и переменные окружения
Vercel (production). При наличии ключа разбор заказов и изменений, определение
тона, черновики ответов и классификатор обращений к Борису используют
`gpt-6-luna` через OpenAI Responses API. После изменения переменных перезапустите
локальный сервер / выполните новый deployment в Vercel.

- `OPENAI_MODEL_INBOX` — имя модели, по умолчанию `gpt-6-luna`.
- `INBOX_AI_PROVIDER=openai` — явное включение OpenAI; отсутствие ключа считается ошибкой.
- `INBOX_AI_PROVIDER=anthropic` — ручной возврат к Haiku с `ANTHROPIC_API_KEY`
  и необязательным `ANTHROPIC_MODEL_INBOX`.
- Без явного провайдера и без ключа OpenAI сохраняется прежнее подключение Haiku.

Ошибки OpenAI не переключают запрос на другого провайдера. Сохраняются текущие
защиты парсеров и проверки изменений заказов. Вызовы используют `store: false`,
таймаут 20 секунд и один повтор при HTTP 429/5xx. Учёт токенов передаётся в
существующий журнал классификатора (историческое имя таблицы `BorisHaikuLog`).
Борис в CRM и Telegram, утренние брифинги, самоанализ и командные отчёты также
используют Luna при наличии ключа OpenAI. `OPENAI_MODEL_BORIS` задаёт модель,
`BORIS_AI_PROVIDER=anthropic` возвращает прежнее подключение независимо от
провайдера клиентских сообщений. История и подтверждение изменений заказов
сохраняют существующий формат. Стоимость учитывается по тарифам Luna с
отдельными счётчиками кеша.

Борис-Директ, меню, техкарты и накладные используют существующие настройки
Anthropic. Живой тест чата с фиктивными инструментами, без БД и Telegram:
`node --require tsx/cjs scripts/test-boris-openai.ts` (ключ передаётся окружением).

## Production deployment
1. Push code to GitHub repo
2. Import project in Vercel
3. Configure environment variables (see .env.example)
4. Deploy
5. After first deploy, run migrations: `npx prisma migrate deploy`
6. Run setup script for initial admin: `npm run db:seed:prod`

## Cron jobs
Configured in vercel.json:
- 03:00 UTC (06:00 MSK) — auto-generate FIXED/DYNAMIC orders
- 15:00 UTC (18:00 MSK) — lock orders for next day

Both protected by CRON_SECRET via Authorization: Bearer header.

## Roles
- **ADMIN** — full access, all data, settings
- **MANAGER** — clients, orders, production, delivery, reports
- **CHEF** — production summary, kitchen prints, catalog (read-only)
- **COURIER** — delivery only, mobile-first
