export type OnboardingStepKey = 'location' | 'mealConfig' | 'phone' | 'legalEntity' | 'max'

export interface OnboardingStep {
  key: OnboardingStepKey
  label: string
  done: boolean
  actionHref?: string
}

export interface OnboardingStatus {
  steps: OnboardingStep[]
  doneCount: number
  totalCount: number
  isComplete: boolean
}

/**
 * Минимально необходимая форма клиента для расчёта онбординга.
 * Совместимо с тем что грузит clients/[id]/page.tsx через include.
 */
export interface ClientForOnboarding {
  id: string
  contactPhone: string | null
  defaultOurLegalEntityId: string | null
  // 7.56: «MAX подключён» = есть активный ClientMaxUser (не Client.maxChatId).
  maxUsers: Array<{ isActive: boolean }>
  locations: Array<{ isActive: boolean }>
  mealConfigs: Array<{ isActive: boolean }>
}

/**
 * Рассчитывает статус 5-шагового онбординга нового клиента.
 * Pure helper: не дёргает БД, принимает уже-загруженный объект с relations.
 *
 * actionHref ведёт либо к якорю на текущей странице (для табов и MAX-блока,
 * которые уже отображаются на /clients/[id]), либо к /edit (для скалярных
 * полей contactPhone / defaultOurLegalEntityId).
 */
export function getOnboardingStatus(client: ClientForOnboarding): OnboardingStatus {
  const hasActiveLocation = client.locations.some((l) => l.isActive)
  const hasActiveMealConfig = client.mealConfigs.some((m) => m.isActive)
  const hasPhone = !!client.contactPhone && client.contactPhone.trim().length > 0
  const hasLegalEntity = !!client.defaultOurLegalEntityId
  const hasMax = client.maxUsers?.some((u) => u.isActive) ?? false

  const editHref = `/clients/${client.id}/edit`

  const steps: OnboardingStep[] = [
    {
      key: 'location',
      label: 'Точка доставки',
      done: hasActiveLocation,
      actionHref: '#client-tabs',
    },
    {
      key: 'mealConfig',
      label: 'Конфиг питания',
      done: hasActiveMealConfig,
      actionHref: '?tab=configs#client-tabs',
    },
    {
      key: 'phone',
      label: 'Телефон контакта',
      done: hasPhone,
      actionHref: editHref,
    },
    {
      key: 'legalEntity',
      label: 'Юрлицо отгрузки',
      done: hasLegalEntity,
      actionHref: editHref,
    },
    {
      key: 'max',
      label: 'MAX-привязка',
      done: hasMax,
      actionHref: '#max-users-section',
    },
  ]

  const doneCount = steps.filter((s) => s.done).length
  const totalCount = steps.length
  const isComplete = doneCount === totalCount

  return { steps, doneCount, totalCount, isComplete }
}
