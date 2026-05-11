import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'
import { getCurrentUser } from '@/lib/auth/current-user'
import { buildOnboardingDeeplink } from '@/lib/bot/onboarding'
import { MaxNotificationsSection } from './max-notifications-section'

export default async function SettingsPage() {
  const user = await getCurrentUser()

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'

  return (
    <>
      <PageHeader title="Настройки" subtitle={user.name} />

      <div className="space-y-5">
        {isAdminOrManager && (
          <MaxNotificationsSection
            currentChatId={user.maxChatId}
            initialDeeplink={
              user.maxOnboardingToken ? buildOnboardingDeeplink(user.maxOnboardingToken) : null
            }
            onboardedAt={user.onboardedAt}
          />
        )}

        <ComingSoon title="Управление пользователями, токены, бэкап" sprint="Спринт 6" />
      </div>
    </>
  )
}
