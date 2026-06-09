-- 7.56: одноразовые приглашения для multi-user MAX. Additive: новая таблица
-- ClientMaxInvite + индексы + FK (clientId CASCADE, createdById SET NULL).

-- CreateTable
CREATE TABLE "ClientMaxInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "label" TEXT,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMaxInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientMaxInvite_token_key" ON "ClientMaxInvite"("token");

-- CreateIndex
CREATE INDEX "ClientMaxInvite_clientId_idx" ON "ClientMaxInvite"("clientId");

-- CreateIndex
CREATE INDEX "ClientMaxInvite_token_idx" ON "ClientMaxInvite"("token");

-- AddForeignKey
ALTER TABLE "ClientMaxInvite" ADD CONSTRAINT "ClientMaxInvite_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMaxInvite" ADD CONSTRAINT "ClientMaxInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

