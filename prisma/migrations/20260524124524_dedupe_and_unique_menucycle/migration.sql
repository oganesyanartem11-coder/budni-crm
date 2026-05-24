-- Sprint 7.6 B.2: dedupe orphan DRAFT cycles before adding unique constraint

WITH ranked AS (
  SELECT
    id,
    "validFrom",
    status,
    ROW_NUMBER() OVER (
      PARTITION BY "validFrom"
      ORDER BY
        CASE status
          WHEN 'APPROVED'         THEN 1
          WHEN 'PENDING_APPROVAL' THEN 2
          WHEN 'DRAFT'            THEN 3
          WHEN 'ARCHIVED'         THEN 4
          ELSE 5
        END,
        "createdAt" ASC
    ) AS rn
  FROM "MenuCycle"
),
to_delete AS (
  SELECT id FROM ranked WHERE rn > 1
)
DELETE FROM "MenuCycle"
WHERE id IN (SELECT id FROM to_delete);

CREATE UNIQUE INDEX "MenuCycle_validFrom_key" ON "MenuCycle"("validFrom");
