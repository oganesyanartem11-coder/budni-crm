-- CreateTable
CREATE TABLE "UpdDocument" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "ourLegalEntityId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "supplierSnapshot" JSONB NOT NULL,
    "buyerSnapshot" JSONB NOT NULL,
    "linesSnapshot" JSONB NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "vatRate" DECIMAL(5,2),
    "vatAmount" DECIMAL(12,2),
    "amountWithoutVat" DECIMAL(12,2) NOT NULL,
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdDocumentOrder" (
    "id" TEXT NOT NULL,
    "updDocumentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "UpdDocumentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpdDocument_ourLegalEntityId_year_idx" ON "UpdDocument"("ourLegalEntityId", "year");

-- CreateIndex
CREATE INDEX "UpdDocument_clientId_idx" ON "UpdDocument"("clientId");

-- CreateIndex
CREATE INDEX "UpdDocument_createdAt_idx" ON "UpdDocument"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UpdDocument_ourLegalEntityId_clientId_locationId_deliveryDa_key" ON "UpdDocument"("ourLegalEntityId", "clientId", "locationId", "deliveryDate");

-- CreateIndex
CREATE INDEX "UpdDocumentOrder_orderId_idx" ON "UpdDocumentOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "UpdDocumentOrder_updDocumentId_orderId_key" ON "UpdDocumentOrder"("updDocumentId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "UpdDocumentOrder_orderId_key" ON "UpdDocumentOrder"("orderId");

-- AddForeignKey
ALTER TABLE "UpdDocument" ADD CONSTRAINT "UpdDocument_ourLegalEntityId_fkey" FOREIGN KEY ("ourLegalEntityId") REFERENCES "OurLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdDocument" ADD CONSTRAINT "UpdDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdDocument" ADD CONSTRAINT "UpdDocument_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdDocument" ADD CONSTRAINT "UpdDocument_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdDocumentOrder" ADD CONSTRAINT "UpdDocumentOrder_updDocumentId_fkey" FOREIGN KEY ("updDocumentId") REFERENCES "UpdDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdDocumentOrder" ADD CONSTRAINT "UpdDocumentOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

