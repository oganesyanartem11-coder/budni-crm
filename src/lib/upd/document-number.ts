import { Prisma } from '@prisma/client'

// Атомарно инкрементирует счётчик документов на OurLegalEntity с автоматическим
// ресетом на 1 января. UPDATE ... RETURNING берёт row lock в Postgres, что
// защищает от гонок при параллельной генерации УПД.
export async function getNextDocumentNumber(
  tx: Prisma.TransactionClient,
  ourLegalEntityId: string
): Promise<{ number: number; year: number; documentNumber: string }> {
  const currentYear = new Date().getFullYear()
  const rows = await tx.$queryRaw<Array<{ lastDocumentNumber: number; lastDocumentYear: number }>>`
    UPDATE "OurLegalEntity"
    SET "lastDocumentNumber" = CASE WHEN "lastDocumentYear" = ${currentYear}
          THEN "lastDocumentNumber" + 1 ELSE 1 END,
        "lastDocumentYear" = ${currentYear}
    WHERE id = ${ourLegalEntityId}
    RETURNING "lastDocumentNumber", "lastDocumentYear"
  `
  if (rows.length === 0) throw new Error('OurLegalEntity not found for numbering')
  const number = rows[0].lastDocumentNumber
  const year = rows[0].lastDocumentYear
  const documentNumber = `УПД-${year}-${String(number).padStart(4, '0')}`
  return { number, year, documentNumber }
}
