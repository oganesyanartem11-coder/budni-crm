import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { SALES_ROLES } from '@/lib/sales/labels'
import { NewLeadForm } from './new-lead-form'

/** Sprint 8.0 «Продажи»: ручное заведение заявки (звонок, мессенджер, рекомендация). */
export default async function NewLeadPage() {
  await requireRole([...SALES_ROLES])

  return (
    <>
      <PageHeader title="Новая заявка" subtitle="Звонок, мессенджер или рекомендация" className="mb-6" />
      <NewLeadForm />
    </>
  )
}
