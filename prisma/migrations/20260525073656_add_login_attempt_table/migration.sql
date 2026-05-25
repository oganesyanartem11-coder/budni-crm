-- Sprint 7.9: global rate-limit storage for login attempts
CREATE TABLE "LoginAttempt" (
  "id"        TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "success"   BOOLEAN NOT NULL,
  "ipAddress" TEXT,
  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginAttempt_createdAt_success_idx" ON "LoginAttempt"("createdAt", "success");
