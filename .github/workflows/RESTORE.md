# Восстановление БД из бэкапа

## Что хранится
GitHub Actions Artifacts — `budni-backup-YYYYMMDD-HHMMSS.dump`. Retention 30 дней. Формат `pg_dump -Fc` (custom, сжатый).

## Как скачать
1. https://github.com/oganesyanartem11-coder/budni-crm/actions
2. Открыть нужный запуск workflow "Backup Neon Database"
3. Внизу страницы — раздел "Artifacts", скачать `.zip`
4. Распаковать — внутри `.dump` файл

## Как восстановить
**ВНИМАНИЕ:** восстановление перезатирает текущую БД. Сначала сделать новый бэкап того что есть!

Локально (Postgres.app):
```bash
# Создать чистую БД
createdb budni_restored
# Восстановить
pg_restore --clean --no-owner --no-acl -d budni_restored ./budni-YYYYMMDD-HHMMSS.dump
```

В Neon production (опасно — обсудить с командой!):
```bash
# DATABASE_URL = DIRECT_URL прода без -pooler
pg_restore --clean --no-owner --no-acl --dbname="$DATABASE_URL" ./budni-YYYYMMDD-HHMMSS.dump
```

## Версия pg_restore
Должна совпадать с версией pg_dump (PostgreSQL 18). На локалке Postgres.app 18 — совпадает.

## Что делать если бэкап повредился / не читается
1. Проверить `pg_restore --list ./budni-*.dump` — должна вывести список таблиц
2. Если ошибка — взять бэкап предыдущего дня (хранится 30 дней)
3. Если все бэкапы битые — критический инцидент, спросить команду
