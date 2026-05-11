import { notFound } from 'next/navigation'
import Link from 'next/link'
import { revalidatePath } from 'next/cache'
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
  const user = await requireRole(['ADMIN', 'MANAGER'])

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

  // Авто-mark-as-read при открытии. Делаем здесь чтобы счётчик в навигации
  // обновился сразу же, без дополнительного round-trip из клиента.
  if (item.status === 'UNREAD') {
    await prisma.inboxItem.update({
      where: { id: item.id },
      data: { status: 'READ', resolvedAt: new Date(), resolvedById: user.id },
    })
    item.status = 'READ'
    revalidatePath('/inbox')
  }

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
