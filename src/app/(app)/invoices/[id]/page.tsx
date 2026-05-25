import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { ProgressView } from './progress-view'
import { InvoiceView } from './invoice-view'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function InvoiceDetailPage({ params }: PageProps) {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])
  const { id } = await params

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineIndex: 'asc' }, include: { matchedIngredient: true } },
      receivedBy: { select: { id: true, name: true } },
      acceptedBy: { select: { id: true, name: true } },
      revertedBy: { select: { id: true, name: true } },
    },
  })
  if (!invoice) notFound()

  // Пока recognizer работает (status=PROCESSING + ещё не дошёл до READY/FAILED)
  // показываем progress-view с polling. На READY/FAILED — полноценный InvoiceView
  // (даже на FAILED — там есть retry-кнопка).
  const stillProcessing =
    invoice.status === 'PROCESSING' && invoice.progress !== 'READY' && invoice.progress !== 'FAILED'

  if (stillProcessing) {
    return (
      <ProgressView
        invoiceId={invoice.id}
        initialProgress={invoice.progress}
        initialStatus={invoice.status}
        initialErrorMessage={invoice.aiErrorMessage}
      />
    )
  }

  return <InvoiceView invoice={serialize(invoice)} currentUserRole={user.role} />
}
