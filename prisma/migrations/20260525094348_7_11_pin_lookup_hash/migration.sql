-- 7.11: HMAC-индекс по PIN для O(1)-логина вместо O(N×bcrypt).
-- pinLookupHash = HMAC-SHA256(JWT_SECRET, pin)[:16] (см. src/lib/auth/pin-lookup.ts).
-- bcrypt.compare остаётся primary verify; этот столбец — только индекс.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pinLookupHash" TEXT;

-- CreateIndex
-- Partial UNIQUE (WHERE NOT NULL): юзеры до 7.11 имеют NULL и заполняются
-- лениво при следующем успешном логине; до этого момента дубли по NULL
-- не должны конфликтовать с unique.
CREATE UNIQUE INDEX "User_pinLookupHash_key" ON "User"("pinLookupHash") WHERE "pinLookupHash" IS NOT NULL;
