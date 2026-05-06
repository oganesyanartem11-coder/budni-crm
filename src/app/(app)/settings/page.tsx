import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Настройки"
        subtitle="Пользователи, токены, бэкап"
      />
      <ComingSoon
        title="Настройки в разработке"
        sprint="Спринт 6"
      />
    </>
  )
}
