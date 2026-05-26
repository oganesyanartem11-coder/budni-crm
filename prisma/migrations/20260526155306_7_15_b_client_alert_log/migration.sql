-- CreateTable
CREATE TABLE "ClientAlertLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "inboxItemId" TEXT,
    "tone" TEXT,
    "reason" TEXT,
    "priority" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientAlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientAlertLog_clientId_createdAt_idx" ON "ClientAlertLog"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientAlertLog" ADD CONSTRAINT "ClientAlertLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAlertLog" ADD CONSTRAINT "ClientAlertLog_inboxItemId_fkey" FOREIGN KEY ("inboxItemId") REFERENCES "InboxItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
