-- 7.55: фундамент multi-user MAX — таблица ClientMaxUser (N пользователей на
-- клиента, один активный). Строго additive: новая таблица + индексы + FK +
-- partial-unique + backfill 4 существующих привязок. Существующие объекты не меняются.

-- CreateTable
CREATE TABLE "ClientMaxUser" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "ClientMaxUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientMaxUser_chatId_key" ON "ClientMaxUser"("chatId");

-- CreateIndex
CREATE INDEX "ClientMaxUser_clientId_isActive_idx" ON "ClientMaxUser"("clientId", "isActive");

-- AddForeignKey
ALTER TABLE "ClientMaxUser" ADD CONSTRAINT "ClientMaxUser_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index: ровно один активный пользователь на клиента.
-- Prisma декларативно partial-index не выражает — добавляем raw SQL.
CREATE UNIQUE INDEX "ClientMaxUser_clientId_active_unique" ON "ClientMaxUser"("clientId") WHERE "isActive" = true;

-- Backfill: каждый Client с непустым maxChatId → ровно одна активная привязка.
-- Детерминировано: одна строка на клиента (chatId @unique гарантирует отсутствие дублей).
INSERT INTO "ClientMaxUser" ("id", "clientId", "chatId", "username", "isActive", "linkedAt")
SELECT
  'cmxu_' || substring(md5(random()::text || "id") from 1 for 20),
  "id",
  "maxChatId",
  "maxUsername",
  true,
  COALESCE("createdAt", now())
FROM "Client"
WHERE "maxChatId" IS NOT NULL;
