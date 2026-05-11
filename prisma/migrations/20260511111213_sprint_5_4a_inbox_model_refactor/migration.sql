-- Sprint 5.4a: rethink Inbox model.
-- 1. Client.maxUsername: handle for max.ru/<username> deeplink (saved on bot_started + message_created).
-- 2. InboxItemStatus: OPEN/RESOLVED_SENT/RESOLVED_IGNORED -> UNREAD/READ.
--    Mapping: OPEN, IN_PROGRESS (legacy) -> UNREAD. RESOLVED_SENT, RESOLVED_IGNORED -> READ.

-- 1. Add Client.maxUsername
ALTER TABLE "Client" ADD COLUMN "maxUsername" TEXT;

-- 2. New enum
CREATE TYPE "InboxItemStatus_new" AS ENUM ('UNREAD', 'READ');

-- 3. Drop default on InboxItem.status (cannot ALTER TYPE while a default references the old enum)
ALTER TABLE "InboxItem" ALTER COLUMN "status" DROP DEFAULT;

-- 4. Convert column to new enum with explicit value mapping
ALTER TABLE "InboxItem"
  ALTER COLUMN "status" TYPE "InboxItemStatus_new"
  USING (
    CASE "status"::text
      WHEN 'OPEN' THEN 'UNREAD'::"InboxItemStatus_new"
      WHEN 'IN_PROGRESS' THEN 'READ'::"InboxItemStatus_new"
      WHEN 'RESOLVED_SENT' THEN 'READ'::"InboxItemStatus_new"
      WHEN 'RESOLVED_IGNORED' THEN 'READ'::"InboxItemStatus_new"
      ELSE 'UNREAD'::"InboxItemStatus_new"
    END
  );

-- 5. Swap names
DROP TYPE "InboxItemStatus";
ALTER TYPE "InboxItemStatus_new" RENAME TO "InboxItemStatus";

-- 6. Restore default
ALTER TABLE "InboxItem" ALTER COLUMN "status" SET DEFAULT 'UNREAD';
