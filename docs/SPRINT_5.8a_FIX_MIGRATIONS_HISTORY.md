# Sprint 5.8a-fix — восстановление истории миграций на dev-ветке Neon

На dev-ветке Neon таблица `_prisma_migrations` пустая (или почти пустая) — все 9 миграций считаются непримененными, хотя по факту схема в БД им полностью соответствует и данные на месте. Это и есть источник «drift detected» при попытках `prisma migrate dev`.

Решение: одним SQL-скриптом задним числом регистрируем все 9 миграций как успешно применённые. Никакого реального DDL — только записи в служебной таблице.

Контекст: мы уже вручную вставляли запись для последней (telegram) миграции в [SPRINT_5.8a_FIX_SQL.md](SPRINT_5.8a_FIX_SQL.md). Чтобы избежать дубля, скрипт ниже сначала удаляет эту запись, а потом INSERT'ит все 9 целиком.

## SQL для dev-ветки Neon

```sql
-- Сначала чистим возможную запись telegram-миграции (мы её уже вставляли вручную, избегаем дубля)
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260512135502_add_telegram_fields_to_user';

-- Регистрируем все 9 миграций как успешно применённые
INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES
  (gen_random_uuid()::text, '4e39006bc5734e0eb9202bb1bbf98c29e0fd1be9997ab4fdf58990a2371f739b', NOW(), '20260506161232_init', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, '909fd00710af5eaf97aefd54044825266ffecda7b9dae9d9b8104d93fe0c9954', NOW(), '20260507081152_add_order_source_config_and_created_by', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, '3924ae753d4308fbca0b712560b09d3c15d3ae671a93bf3a2d8db2160e565a99', NOW(), '20260507093756_add_order_edited_after_lock', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, '51e4db54be12d9e08598d008861c61707823e29eb8e2976d45b7ddfdb0d8c008', NOW(), '20260508173628_sprint_5_0b_bot_schema_and_timezone', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, '9e774bb062b3dd4375dd7f632d0398e43d49b3c66761c00a913df5d8fb2407f4', NOW(), '20260511085335_sprint_5_3a_schema_cleanup', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, '2689a62d4728f5d828a82be9e800075fad28ff2d15100f737057efe61add9f35', NOW(), '20260511100323_sprint_5_5_6_max_integration', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, 'df5cc641b7f0edbae84bbc07beab7c347cd055d62da326633610fa7655ad3178', NOW(), '20260511111213_sprint_5_4a_inbox_model_refactor', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, '64bcc8a3fa471dd078c486baa474382e4a7fa5f3837d1a79739c8326fa038ba8', NOW(), '20260511124211_sprint_5_4d_message_read_at', NULL, NULL, NOW(), 1),
  (gen_random_uuid()::text, 'ec33f0a1ee17e5f685e54eb405b9c9de382b073b18f0cb57e072131c46d75803', NOW(), '20260512135502_add_telegram_fields_to_user', NULL, NULL, NOW(), 1);
```

## Что делать Артёму

1. Neon Console → ветка **dev** (НЕ production!) → SQL Editor
2. Выполнить весь блок целиком
3. Ожидаемо: `DELETE 0` или `DELETE 1` (зависит от того, успел ли отработать предыдущий INSERT из SPRINT_5.8a_FIX_SQL.md), и затем `INSERT 0 9`
4. Локально в терминале:

   ```bash
   npx dotenv -e .env.local -- prisma migrate status
   ```
5. Ожидаемо: `Database schema is up to date!` (а НЕ `drift detected` и НЕ `Following migrations have not yet been applied`)

## Если Блок 1 (DDL) из SPRINT_5.8a_FIX_SQL.md ещё НЕ применялся

То физически колонок `telegramChatId`, `telegramOnboardingExpiresAt`, `telegramOnboardingToken`, `telegramUsername` и двух unique-индексов в таблице `"User"` нет. После регистрации миграции в `_prisma_migrations` Prisma подумает, что они есть, а реально их нет — `migrate status` тогда покажет drift в обратную сторону (schema.prisma vs БД).

Решение: применить Блок 1 из [SPRINT_5.8a_FIX_SQL.md](SPRINT_5.8a_FIX_SQL.md) **до** или **после** этого скрипта (порядок неважен, главное оба прогнать).

## Откатить если что-то пошло не так

Удалить все 9 свежевставленных записей:

```sql
DELETE FROM "_prisma_migrations"
WHERE migration_name IN (
  '20260506161232_init',
  '20260507081152_add_order_source_config_and_created_by',
  '20260507093756_add_order_edited_after_lock',
  '20260508173628_sprint_5_0b_bot_schema_and_timezone',
  '20260511085335_sprint_5_3a_schema_cleanup',
  '20260511100323_sprint_5_5_6_max_integration',
  '20260511111213_sprint_5_4a_inbox_model_refactor',
  '20260511124211_sprint_5_4d_message_read_at',
  '20260512135502_add_telegram_fields_to_user'
);
```

После — повторно прогнать INSERT-блок выше.

## Prod не трогаем

На prod-ветке Neon история миграций должна быть корректной (она наполняется через `prisma migrate deploy` из `vercel-build`). Этот скрипт **только для dev**.
