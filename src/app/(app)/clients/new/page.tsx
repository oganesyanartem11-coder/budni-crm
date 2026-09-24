import { PageHeader } from '@/components/layout/page-header'
import { ClientForm } from '../client-form'
import { requireRole } from '@/lib/auth/current-user'
import { listActiveOurLegalEntitiesForClientForm } from '../actions'
import { getLeadPrefill } from '@/lib/db/queries/sales'
import { isSalesRole } from '@/lib/sales/labels'
import { formatPhoneMask } from '@/lib/utils/format'

interface PageProps {
  searchParams: Promise<{ leadId?: string | string[] }>
}

export default async function NewClientPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  // Sprint 8.0: /clients/new?leadId= — предзаполнение из заявки воронки.
  // Заявку читаем только для SALES_ROLES; остальным — обычная пустая форма.
  const { leadId: rawLeadId } = await searchParams
  const leadId = typeof rawLeadId === 'string' && rawLeadId.trim() ? rawLeadId.trim() : null

  const [legalEntities, lead] = await Promise.all([
    listActiveOurLegalEntitiesForClientForm(),
    leadId && isSalesRole(user.role) ? getLeadPrefill(leadId) : Promise.resolve(null),
  ])

  const initialValues = lead
    ? {
        name: lead.company || lead.name || '',
        contactName: lead.name ?? '',
        contactPhone: formatPhoneMask(lead.phone),
      }
    : undefined

  return (
    <>
      <PageHeader
        title="Новый клиент"
        subtitle={
          lead
            ? 'Из заявки: проверьте данные, заполните остальное и при желании первую точку'
            : 'Заполните основные поля и при желании первую точку'
        }
      />
      <ClientForm isNew legalEntities={legalEntities} initialValues={initialValues} leadId={lead?.id} />
    </>
  )
}
