-- CreateTable
CREATE TABLE "ClientMaxGroup" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "chatId" TEXT,
    "token" TEXT,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3),

    CONSTRAINT "ClientMaxGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientMaxGroup_clientId_key" ON "ClientMaxGroup"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMaxGroup_chatId_key" ON "ClientMaxGroup"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMaxGroup_token_key" ON "ClientMaxGroup"("token");

-- AddForeignKey
ALTER TABLE "ClientMaxGroup" ADD CONSTRAINT "ClientMaxGroup_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

