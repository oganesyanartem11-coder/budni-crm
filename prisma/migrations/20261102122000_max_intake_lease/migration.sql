ALTER TABLE "ClientMaxGroup"
ADD COLUMN "processingToken" TEXT,
ADD COLUMN "processingUntil" TIMESTAMP(3);

CREATE TABLE "MaxInboundReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MaxInboundReceipt_clientId_status_idx" ON "MaxInboundReceipt"("clientId", "status");
