import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { ClientInboxView } from './client-thread'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  params: Promise<{ clientId: string }>
}

const HISTORY_LIMIT = 50

export default async function ClientInboxPage({ params }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const { clientId } = await params
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, contactPhone: true,
      maxChatId: true, maxUsername: true,
    },
  })
  if (!client) notFound()

  const items = await prisma.inboxItem.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      id: true, status: true, reason: true, priority: true,
      humanReason: true, clientMessage: true, draftReply: true,
      managerReply: true, parsedJson: true, clientStatsSnapshot: true,
      createdAt: true, resolvedAt: true, conversationId: true,
      resolvedBy: { select: { id: true, name: true } },
    },
  })

  // Активный = последний UNREAD; если все READ — самый свежий из истории.
  // Драйвит форму ответа и контекстный блок.
  const activeItem = items.find((i) => i.status === 'UNREAD') ?? items[0] ?? null

  const messages = await prisma.botMessage.findMany({
    where: { clientId, createdAt: { gte: sevenDaysAgo } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, direction: true, text: true, createdAt: true, toneLabel: true },
  })

  await prisma.botMessage.updateMany({
    where: { clientId, direction: 'IN', readAt: null },
    data: { readAt: new Date() },
  })

  return (
    <>
      <div className="mb-6">
        <Link
          href="/inbox"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К списку
        </Link>
      </div>
      <PageHeader title={client.name} subtitle="Переписка с клиентом" />
      <ClientInboxView
        client={serialize(client)}
        activeItem={activeItem ? serialize(activeItem) : null}
        history={serialize(items)}
        messages={serialize(messages)}
      />
    </>
  )
}
