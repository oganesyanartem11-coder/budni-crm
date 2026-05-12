# Sprint 5.8a-fix — починка миграции add_telegram_fields_to_user

На dev-ветке Neon есть исторический дрифт: индексы и unique-констрейнты в БД уже соответствуют `schema.prisma`, но не записаны в истории миграций. `prisma migrate dev` из-за этого требует reset (=стереть все данные), чего мы не хотим.

Решение: миграционный файл уже создан вручную в `prisma/migrations/20260512135502_add_telegram_fields_to_user/migration.sql`. Осталось:

1. Применить DDL напрямую в Neon (dev-ветка) — Блок 1
2. Зарегистрировать миграцию в служебной таблице `_prisma_migrations` — Блок 2
3. Проверить через `prisma migrate status` что всё чисто

Prod-ветку трогать не нужно — Vercel при следующем деплое сам прогонит `prisma migrate deploy` (это уже есть в `vercel-build` скрипте в `package.json`).

---

## Блок 1 — DDL (применить к dev-ветке Neon)

```sql
ALTER TABLE "User" ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "telegramOnboardingExpiresAt" TIMESTAMP(3),
ADD COLUMN     "telegramOnboardingToken" TEXT,
ADD COLUMN     "telegramUsername" TEXT;

CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");
CREATE UNIQUE INDEX "User_telegramOnboardingToken_key" ON "User"("telegramOnboardingToken");
```

## Блок 2 — регистрация миграции в `_prisma_migrations` (ТОЛЬКО dev-ветка)

```sql
INSERT INTO "_prisma_migrations" (
  id,
  checksum,
  finished_at,
  migration_name,
  logs,
  rolled_back_at,
  started_at,
  applied_steps_count
) VALUES (
  gen_random_uuid()::text,
  'ec33f0a1ee17e5f685e54eb405b9c9de382b073b18f0cb57e072131c46d75803',
  NOW(),
  '20260512135502_add_telegram_fields_to_user',
  NULL,
  NULL,
  NOW(),
  1
);
```

Checksum получен через `shasum -a 256 prisma/migrations/20260512135502_add_telegram_fields_to_user/migration.sql` от точного содержимого файла (417 байт, включая trailing newline). Prisma при `migrate status` сравнит этот hash байт-в-байт с содержимым файла.

---

## Что делать Артёму

1. Открыть Neon Console → выбрать ветку **dev** → SQL Editor
2. Выполнить **Блок 1** (DDL). Ожидаемый результат: `ALTER TABLE` и два `CREATE UNIQUE INDEX` без ошибок.
3. Выполнить **Блок 2** (INSERT в `_prisma_migrations`). Ожидаемый результат: `INSERT 0 1`.
4. Локально в терминале:

   ```bash
   npx dotenv -e .env.local -- prisma migrate status
   ```

   Ожидаемо: `Database schema is up to date!` (а НЕ `drift detected` и НЕ `pending migrations`).
5. Локально (на всякий случай):

   ```bash
   npm run db:generate
   ```
6. Подтвердить в чат: «5.8a-fix применил, migrate status чистый».

## Про prod (production-ветку Neon)

**НЕ трогать руками.** В `package.json` есть скрипт:

```
"vercel-build": "prisma migrate deploy && prisma generate && next build"
```

Когда папка `prisma/migrations/20260512135502_add_telegram_fields_to_user/` уйдёт в `main` коммитом, Vercel при сборке прогонит `prisma migrate deploy` против prod-ветки Neon и применит миграцию автоматически. На prod дрифта быть не должно — там история миграций чистая (она наполнялась ровно через `migrate deploy`).

Если на prod внезапно тоже окажется дрифт — `migrate deploy` упадёт, и тогда придётся повторить ту же процедуру (Блок 1 + Блок 2 → Neon prod SQL Editor). Но это маловероятно.

## Откатить если что-то пошло не так

Если Блок 1 применился, а Блок 2 ещё нет — повторить только Блок 2.

Если Блок 1 применился частично (например упал на CREATE INDEX потому что индекс уже был) — это и есть симптом старого дрифта. Тогда:

```sql
-- На dev-ветке Neon, безопасный вариант
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT,
  ADD COLUMN IF NOT EXISTS "telegramOnboardingExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "telegramOnboardingToken" TEXT,
  ADD COLUMN IF NOT EXISTS "telegramUsername" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramChatId_key" ON "User"("telegramChatId");
CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramOnboardingToken_key" ON "User"("telegramOnboardingToken");
```

Затем тот же Блок 2.

Если Блок 2 применился дважды (две записи в `_prisma_migrations` с одинаковым `migration_name`) — удалить одну из них:

```sql
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260512135502_add_telegram_fields_to_user'
  AND id NOT IN (
    SELECT id FROM "_prisma_migrations"
    WHERE migration_name = '20260512135502_add_telegram_fields_to_user'
    ORDER BY started_at ASC
    LIMIT 1
  );
```
