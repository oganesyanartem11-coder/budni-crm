/**
 * Идемпотентный seed для e2e-тестов: создаёт/обновляет SMOKE_TEST_CLIENT,
 * SMOKE_TEST_LOCATION, SMOKE_TEST_LEGAL.
 *
 * Запуск: `npm run db:seed:smoke` (через dotenv -e .env.test).
 * Safety-net: отказ если DATABASE_URL похож на прод (neon.tech).
 */

import { prisma } from '../src/lib/db/prisma'

const SMOKE_CLIENT_NAME = 'SMOKE_TEST_CLIENT'
const SMOKE_LOCATION_NAME = 'SMOKE_TEST_LOCATION'
const SMOKE_LEGAL_SHORT_NAME = 'SMOKE_TEST_LEGAL'
const SMOKE_LEGAL_INN = '0000000001' // фиктивный, уникальный за счёт префикса нулей
const SMOKE_LEGAL_OGRN = '000000000000001'

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (/neon\.tech|prod|production/i.test(dbUrl)) {
    console.error('❌ DATABASE_URL похож на прод. Seed только для локалки.')
    process.exit(1)
  }

  // 1. OurLegalEntity — upsert по inn (уникальное).
  const legal = await prisma.ourLegalEntity.upsert({
    where: { inn: SMOKE_LEGAL_INN },
    create: {
      shortName: SMOKE_LEGAL_SHORT_NAME,
      fullName: 'Тестовое юрлицо для e2e SMOKE_TEST',
      entityType: 'INDIVIDUAL_ENTREPRENEUR',
      inn: SMOKE_LEGAL_INN,
      ogrn: SMOKE_LEGAL_OGRN,
      legalAddress: 'г. Москва, ул. Тестовая, д. 1',
      bankName: 'Тестбанк',
      bankBic: '044525000',
      bankAccount: '40802810000000000000',
      bankCorrAccount: '30101810000000000000',
      directorName: 'Тестовый Тест Тестович',
      vatMode: 'NONE',
      isActive: true,
    },
    update: {
      shortName: SMOKE_LEGAL_SHORT_NAME,
      isActive: true,
    },
  })

  // 2. Client — у name нет @unique, используем findFirst → create/update.
  let client = await prisma.client.findFirst({ where: { name: SMOKE_CLIENT_NAME } })
  if (client) {
    client = await prisma.client.update({
      where: { id: client.id },
      data: { isActive: true, defaultOurLegalEntityId: legal.id },
    })
  } else {
    client = await prisma.client.create({
      data: {
        name: SMOKE_CLIENT_NAME,
        isActive: true,
        defaultOurLegalEntityId: legal.id,
      },
    })
  }

  // 3. ClientLocation — то же: findFirst по (clientId, name).
  let location = await prisma.clientLocation.findFirst({
    where: { clientId: client.id, name: SMOKE_LOCATION_NAME },
  })
  if (location) {
    location = await prisma.clientLocation.update({
      where: { id: location.id },
      data: {
        address: 'г. Москва, ул. Тестовая, д. 2',
        deliveryWindowFrom: '12:00',
        deliveryWindowTo: '14:00',
        packaging: 'INDIVIDUAL',
        isActive: true,
      },
    })
  } else {
    location = await prisma.clientLocation.create({
      data: {
        clientId: client.id,
        name: SMOKE_LOCATION_NAME,
        address: 'г. Москва, ул. Тестовая, д. 2',
        deliveryWindowFrom: '12:00',
        deliveryWindowTo: '14:00',
        packaging: 'INDIVIDUAL',
        isActive: true,
      },
    })
  }

  console.log('✅ Smoke seed готов:')
  console.log(`  legalEntityId: ${legal.id}`)
  console.log(`  clientId:      ${client.id}`)
  console.log(`  locationId:    ${location.id}`)
}

main()
  .catch((err) => {
    console.error('❌ Seed упал:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
