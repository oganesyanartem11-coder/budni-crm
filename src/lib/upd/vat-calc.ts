import { Prisma } from '@prisma/client'

export interface UpdAmounts {
  totalAmount: Prisma.Decimal
  amountWithoutVat: Prisma.Decimal
  vatAmount: Prisma.Decimal | null
  vatRate: Prisma.Decimal | null
}

export function calculateUpdAmounts(
  total: Prisma.Decimal,
  vatRate: Prisma.Decimal | null
): UpdAmounts {
  if (vatRate === null) {
    return {
      totalAmount: total,
      amountWithoutVat: total,
      vatAmount: null,
      vatRate: null,
    }
  }

  const vatAmount = total
    .mul(vatRate)
    .div(new Prisma.Decimal(100).add(vatRate))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

  const amountWithoutVat = total.sub(vatAmount)

  return {
    totalAmount: total,
    amountWithoutVat,
    vatAmount,
    vatRate,
  }
}
