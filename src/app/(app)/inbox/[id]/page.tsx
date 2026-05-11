import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { InboxItemDetail } from './detail'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function InboxItemPage({ params }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const { id } = await params
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const item = await prisma.inboxItem.findUnique({
    where: { id },
    include: {
      client: {
        select: {
          id: true, name: true, contactPhone: true,
          maxChatId: true, maxUsername: true,
        },
      },
      conversation: {
        select: {
          id: true,
          deliveryDate: true,
          status: true,
          messages: {
            where: { createdAt: { gte: sevenDaysAgo } },
            orderBy: { createdAt: 'asc' },
            select: { id: true, direction: true, text: true, createdAt: true, toneLabel: true },
          },
        },
      },
      resolvedBy: { select: { id: true, name: true } },
    },
  })
  if (!item) notFound()

  // Помечаем все непрочитанные IN-сообщения этого клиента как прочитанные.
  // Бэдж в навигации обновится через polling из /inbox (10 сек).
  await prisma.botMessage.updateMany({
    where: {
      clientId: item.client.id,
      direction: 'IN',
      readAt: null,
    },
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
          К inbox
        </Link>
      </div>
      <PageHeader title={item.client.name} subtitle="Обращение клиента" />
      <InboxItemDetail item={serialize(item)} />
    </>
  )
}
