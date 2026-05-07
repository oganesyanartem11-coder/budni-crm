import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const result = await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'Order'
    ORDER BY ordinal_position
  ` as Array<{ column_name: string; data_type: string; is_nullable: string }>

  console.log('Columns in Order table:')
  for (const col of result) {
    console.log(`  ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? '(nullable)' : ''}`)
  }

  const hasSourceConfigId = result.some(c => c.column_name === 'sourceConfigId')
  const hasCreatedById = result.some(c => c.column_name === 'createdById')
  console.log('')
  console.log('sourceConfigId exists:', hasSourceConfigId)
  console.log('createdById exists:', hasCreatedById)
}
main().finally(() => prisma.$disconnect())
