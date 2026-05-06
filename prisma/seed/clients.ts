import { PrismaClient, type MealType, type OrderType, type ScheduleType, type PackagingType, type DeliveryHorizon } from '@prisma/client'

interface ConfigSeed {
  mealType: MealType
  orderType: OrderType
  deliveryHorizon?: DeliveryHorizon
  scheduleType: ScheduleType
  scheduleData?: object
  fixedPortions?: number
  pricePerPortion: number
}

interface LocationSeed {
  name: string
  address: string
  deliveryWindowFrom?: string
  deliveryWindowTo?: string
  packaging: PackagingType
  tags?: string[]
  configs?: ConfigSeed[] // Конфиги на уровне точки
}

interface ClientSeed {
  name: string
  contactName?: string
  contactPhone?: string
  contactMessenger?: string
  notes?: string
  locations: LocationSeed[]
  // Конфиги на уровне всего клиента (без привязки к точке)
  globalConfigs?: ConfigSeed[]
}

const CLIENTS: ClientSeed[] = [
  {
    name: 'СтройМонолит',
    contactName: 'Игорь Петров',
    contactPhone: '+7 (999) 123-45-67',
    contactMessenger: '@igor_stroy',
    notes: 'Стройка офисного центра, активные мужчины. Едят много.',
    locations: [
      {
        name: 'Стройка №3',
        address: 'Ленинский проспект, 145, стр. 3',
        deliveryWindowFrom: '12:00',
        deliveryWindowTo: '12:30',
        packaging: 'BULK',
        tags: ['Прораб — аллергия на цитрус', 'Без лука в первой коробке'],
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'DYNAMIC',
            scheduleType: 'WEEKDAYS',
            pricePerPortion: 320,
          },
        ],
      },
    ],
  },
  {
    name: 'Офис на Ленина',
    contactName: 'Анна Соколова',
    contactPhone: '+7 (999) 234-56-78',
    contactMessenger: '@anna_office',
    notes: 'IT-компания, 3 этажа, разные пожелания.',
    locations: [
      {
        name: 'Этаж 5 (разработка)',
        address: 'Ленина, 15, оф. 501',
        deliveryWindowFrom: '13:00',
        deliveryWindowTo: '13:30',
        packaging: 'INDIVIDUAL',
        tags: ['Двое вегетарианцев'],
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'DYNAMIC',
            scheduleType: 'WEEKDAYS',
            pricePerPortion: 380,
          },
        ],
      },
      {
        name: 'Этаж 6 (продажи)',
        address: 'Ленина, 15, оф. 601',
        deliveryWindowFrom: '13:00',
        deliveryWindowTo: '13:30',
        packaging: 'INDIVIDUAL',
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'FIXED',
            scheduleType: 'WEEKDAYS',
            fixedPortions: 12,
            pricePerPortion: 380,
          },
        ],
      },
      {
        name: 'Этаж 7 (руководство)',
        address: 'Ленина, 15, оф. 701',
        deliveryWindowFrom: '13:30',
        deliveryWindowTo: '14:00',
        packaging: 'INDIVIDUAL',
        tags: ['Директор — без чеснока'],
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'FIXED',
            scheduleType: 'WEEKDAYS',
            fixedPortions: 6,
            pricePerPortion: 420,
          },
        ],
      },
    ],
  },
  {
    name: 'Школа №7',
    contactName: 'Марина Витальевна',
    contactPhone: '+7 (999) 345-67-89',
    notes: 'Школа, питание для младших классов. Дети.',
    locations: [
      {
        name: 'Главное здание',
        address: 'Школьный переулок, 7',
        deliveryWindowFrom: '11:00',
        deliveryWindowTo: '11:30',
        packaging: 'INDIVIDUAL',
        tags: ['Без острого', 'Меньше соли'],
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'FIXED',
            scheduleType: 'WEEKDAYS',
            fixedPortions: 85,
            pricePerPortion: 250,
          },
        ],
      },
    ],
  },
  {
    name: 'Завод "Прогресс"',
    contactName: 'Виктор Семёнов',
    contactPhone: '+7 (999) 456-78-90',
    contactMessenger: '@progress_food',
    notes: 'Большой завод, 2 смены — обед и ужин. Кол-во обедов = кол-ву ужинов.',
    locations: [
      {
        name: 'Цех №1',
        address: 'Промзона, ул. Заводская, 12, цех 1',
        deliveryWindowFrom: '12:30',
        deliveryWindowTo: '13:00',
        packaging: 'BULK',
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'FIXED',
            scheduleType: 'DAILY',
            fixedPortions: 40,
            pricePerPortion: 290,
          },
          {
            mealType: 'DINNER',
            orderType: 'FIXED',
            scheduleType: 'DAILY',
            fixedPortions: 40,
            pricePerPortion: 270,
          },
        ],
      },
      {
        name: 'Цех №2',
        address: 'Промзона, ул. Заводская, 12, цех 2',
        deliveryWindowFrom: '12:30',
        deliveryWindowTo: '13:00',
        packaging: 'BULK',
        configs: [
          {
            mealType: 'LUNCH',
            orderType: 'FIXED',
            scheduleType: 'DAILY',
            fixedPortions: 35,
            pricePerPortion: 290,
          },
          {
            mealType: 'DINNER',
            orderType: 'FIXED',
            scheduleType: 'DAILY',
            fixedPortions: 35,
            pricePerPortion: 270,
          },
        ],
      },
      {
        name: 'Администрация',
        address: 'Промзона, ул. Заводская, 12, админкорпус',
        deliveryWindowFrom: '13:00',
        deliveryWindowTo: '13:30',
        packaging: 'INDIVIDUAL',
        tags: ['Главный инженер — диабет'],
        configs: [
          {
            mealType: 'BREAKFAST',
            orderType: 'FIXED',
            scheduleType: 'WEEKDAYS',
            fixedPortions: 8,
            pricePerPortion: 200,
          },
          {
            mealType: 'LUNCH',
            orderType: 'FIXED',
            scheduleType: 'WEEKDAYS',
            fixedPortions: 8,
            pricePerPortion: 380,
          },
        ],
      },
    ],
  },
  {
    name: 'Свадьба Ивановых',
    contactName: 'Елена Иванова',
    contactPhone: '+7 (999) 567-89-01',
    notes: 'Разовый заказ — банкет на 60 человек.',
    locations: [
      {
        name: 'Ресторан "Берёзка"',
        address: 'ул. Зелёная, 22',
        deliveryWindowFrom: '17:00',
        deliveryWindowTo: '17:30',
        packaging: 'BULK',
        tags: ['Особое меню — ужин премиум'],
        configs: [],
      },
    ],
  },
]

export async function seedClients(prisma: PrismaClient): Promise<{
  clientCount: number
  locationCount: number
  configCount: number
}> {
  let clientCount = 0
  let locationCount = 0
  let configCount = 0

  for (const c of CLIENTS) {
    // Upsert клиента по имени
    const existing = await prisma.client.findFirst({ where: { name: c.name } })

    let clientId: string
    if (existing) {
      const updated = await prisma.client.update({
        where: { id: existing.id },
        data: {
          contactName: c.contactName,
          contactPhone: c.contactPhone,
          contactMessenger: c.contactMessenger,
          notes: c.notes,
          isActive: true,
        },
      })
      clientId = updated.id
    } else {
      const created = await prisma.client.create({
        data: {
          name: c.name,
          contactName: c.contactName,
          contactPhone: c.contactPhone,
          contactMessenger: c.contactMessenger,
          notes: c.notes,
        },
      })
      clientId = created.id
    }
    clientCount++

    // Удаляем старые точки и конфиги — будем пересоздавать
    await prisma.clientMealConfig.deleteMany({ where: { clientId } })
    await prisma.clientLocation.deleteMany({ where: { clientId } })

    // Создаём точки
    for (const loc of c.locations) {
      const location = await prisma.clientLocation.create({
        data: {
          clientId,
          name: loc.name,
          address: loc.address,
          deliveryWindowFrom: loc.deliveryWindowFrom,
          deliveryWindowTo: loc.deliveryWindowTo,
          packaging: loc.packaging,
          tags: loc.tags ?? [],
        },
      })
      locationCount++

      for (const cfg of loc.configs ?? []) {
        await prisma.clientMealConfig.create({
          data: {
            clientId,
            locationId: location.id,
            mealType: cfg.mealType,
            orderType: cfg.orderType,
            deliveryHorizon: cfg.deliveryHorizon ?? 'NEXT_DAY',
            scheduleType: cfg.scheduleType,
            scheduleData: cfg.scheduleData ?? undefined,
            fixedPortions: cfg.fixedPortions,
            pricePerPortion: cfg.pricePerPortion,
          },
        })
        configCount++
      }
    }

    // Глобальные конфиги (на уровне клиента)
    for (const cfg of c.globalConfigs ?? []) {
      await prisma.clientMealConfig.create({
        data: {
          clientId,
          mealType: cfg.mealType,
          orderType: cfg.orderType,
          deliveryHorizon: cfg.deliveryHorizon ?? 'NEXT_DAY',
          scheduleType: cfg.scheduleType,
          scheduleData: cfg.scheduleData ?? undefined,
          fixedPortions: cfg.fixedPortions,
          pricePerPortion: cfg.pricePerPortion,
        },
      })
      configCount++
    }
  }

  return { clientCount, locationCount, configCount }
}
