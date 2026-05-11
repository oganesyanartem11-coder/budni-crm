import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { fetchInboxListData } from './actions'
import { InboxList } from './inbox-list'

export default async function InboxPage() {
  await requireRole(['ADMIN', 'MANAGER'])
  const initial = await fetchInboxListData()

  return (
    <>
      <PageHeader title="Inbox" subtitle="Переписка с клиентами" />
      <InboxList initialItems={initial} />
    </>
  )
}
