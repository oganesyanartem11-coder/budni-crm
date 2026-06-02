import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { UploadForm } from './upload-form'

export default async function NewInvoicePage() {
  await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])

  return (
    <>
      <PageHeader
        title="Загрузить поставку"
        actions={
          <Link
            href="/invoices"
            className="px-4 py-2 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            К списку
          </Link>
        }
      />
      <UploadForm />
    </>
  )
}
