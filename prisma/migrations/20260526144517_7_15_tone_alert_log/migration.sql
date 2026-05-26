-- CreateTable
CREATE TABLE "ToneAlertLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToneAlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToneAlertLog_clientId_tone_createdAt_idx" ON "ToneAlertLog"("clientId", "tone", "createdAt");

-- AddForeignKey
ALTER TABLE "ToneAlertLog" ADD CONSTRAINT "ToneAlertLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
