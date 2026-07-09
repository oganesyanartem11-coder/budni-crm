import { PrismaClient } from '@prisma/client'
import {
  getMenuStructureFromImport,
  expandMenuFromStructure,
} from '../src/lib/menu-import/expand-menu'

const ROLLBACK_SENTINEL = '__sanity_rollback__'

const p = new PrismaClient()

function nextMondayFromTodayUTC(): Date {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay()
  const days = dow === 1 ? 7 : (8 - dow) % 7
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

async function main() {
  const draft = await p.menuImport.findFirst({
    where: { status: 'DRAFT' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, progress: true, _count: { select: { dishes: true } } },
  })
  if (!draft) {
    console.log('no DRAFT import locally — пропускаю sanity-тест')
    await p.$disconnect()
    return
  }

  const admin = await p.user.findFirst({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, name: true },
  })
  const adminId = admin?.id ?? 'sanity-no-admin-fallback'

  const startDate = nextMondayFromTodayUTC()
  console.log(
    `target draft import: ${draft.id} (dishes=${draft._count.dishes}, progress=${draft.progress})`
  )
  console.log(`admin for approvedBy: ${admin ? `${admin.name} (${admin.id})` : '<none, fallback id used>'}`)
  console.log(`startDate (next Monday UTC): ${startDate.toISOString().slice(0, 10)}`)

  let result: unknown = null

  try {
    await p.$transaction(async (tx) => {
      const structure = await getMenuStructureFromImport(draft.id, tx)
      const cyclesCreated = await expandMenuFromStructure(
        structure,
        startDate,
        13,
        draft.id,
        adminId,
        tx
      )
      const firstCycle = await tx.menuCycle.findFirst({
        where: { menuImportId: draft.id },
        orderBy: { validFrom: 'asc' },
        select: { name: true, validFrom: true, validTo: true, status: true },
      })
      const lastCycle = await tx.menuCycle.findFirst({
        where: { menuImportId: draft.id },
        orderBy: { validFrom: 'desc' },
        select: { name: true, validFrom: true, validTo: true, status: true },
      })
      const totalNewMenuDays = await tx.menuDay.count({
        where: { menuCycle: { menuImportId: draft.id } },
      })
      const totalNewMenuDayDishes = await tx.menuDayDish.count({
        where: { menuDay: { menuCycle: { menuImportId: draft.id } } },
      })

      result = {
        weekA_days: structure.weekA.days.length,
        weekB_days: structure.weekB?.days.length ?? null,
        cyclesCreated,
        firstCycle,
        lastCycle,
        totalNewMenuDays,
        totalNewMenuDayDishes,
      }
      throw new Error(ROLLBACK_SENTINEL)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg !== ROLLBACK_SENTINEL) {
      console.error('UNEXPECTED ERROR:', err)
      await p.$disconnect()
      process.exit(1)
    }
  }

  console.log('\nSANITY RESULTS (transaction rolled back, БД не модифицирована):')
  console.log(JSON.stringify(result, null, 2))

  const cyclesPersisted = await p.menuCycle.count({ where: { menuImportId: draft.id } })
  console.log(
    `\npost-rollback verify: MenuCycle.menuImportId=draft  →  count=${cyclesPersisted} (ожидается 0)`
  )

  await p.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
