import { notFound, redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'

interface PageProps {
  params: Promise<{ id: string }>
}

/**
 * 6.2: маршрут /inbox/[id] заменён на /inbox/[clientId]. Этот файл остаётся
 * как тонкий redirect — старые Telegram-пуши (отправленные до миграции)
 * ссылаются на InboxItem.id, новые формирует notify-managers с clientId.
 */
export default async function InboxItemRedirect({ params }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const { id } = await params
  const item = await prisma.inboxItem.findUnique({
    where: { id },
    select: { clientId: true },
  })
  if (!item) notFound()

  redirect(`/inbox/${item.clientId}`)
}
