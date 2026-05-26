import { Suspense } from 'react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { isToneLabel } from '@/lib/inbox/tone-labels'
import { fetchInboxListData } from './actions'
import { InboxList } from './inbox-list'
import { ToneFilterBar } from './tone-filter-bar'

interface PageProps {
  searchParams: Promise<{ tone?: string }>
}

export default async function InboxPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])
  const params = await searchParams
  const tone = isToneLabel(params.tone) ? params.tone : undefined
  const initial = await fetchInboxListData(tone)

  return (
    <>
      <PageHeader title="Inbox" subtitle="Переписка с клиентами" />
      <Suspense fallback={null}>
        <ToneFilterBar activeTone={tone} />
      </Suspense>
      <InboxList initialItems={initial} activeTone={tone} />
    </>
  )
}
