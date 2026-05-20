import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { UploadForm } from './upload-form'

export default async function NewMenuImportPage() {
  await requireRole(['ADMIN', 'CHEF'])

  return (
    <>
      <PageHeader
        title="Новый импорт меню"
        subtitle="Загрузите Excel-файл с расписанием меню — AI разберёт структуру и составит черновики техкарт."
      />
      <UploadForm />
    </>
  )
}
