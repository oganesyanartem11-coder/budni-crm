import Link from 'next/link'
import { ArrowLeft, Printer, ChefHat, Package, FileText, FileStack, Truck, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function PrintMenuPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  const params = await searchParams
  const date = params.date ?? (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  })()

  return (
    <>
      <div className="mb-6">
        <Link
          href={`/production?date=${date}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К сводке производства
        </Link>
      </div>
      <PageHeader
        title="Печать на дату"
        subtitle="Выберите какой документ распечатать"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <PrintCard
          href={`/production/print/kitchen?date=${date}`}
          icon={ChefHat}
          title="Кухонный лист"
          description="Что готовить и сколько. Крупный шрифт, в цех."
        />
        <PrintCard
          href={`/production/print/assembly?date=${date}`}
          icon={Package}
          title="Лист сборки заказов"
          description="Клиент → точка → порций → упаковка → теги. Для упаковщика."
        />
        <PrintCard
          href={`/production/print/upd?date=${date}`}
          icon={FileText}
          title="УПД"
          description="Универсальный передаточный документ. Превью, формирование, печать в двух экземплярах."
        />
        <PrintCard
          href={`/production/print/route-sheet?date=${date}`}
          icon={Truck}
          title="Маршрутный лист"
          description="Точка → заказы → порции → упаковка. Для курьера/развоза."
        />
        <PrintCard
          href="/production/print/upd/list"
          icon={FileStack}
          title="Выписанные УПД"
          description="Перепечать ранее сформированных. Номера не меняются."
        />
      </div>
    </>
  )
}

function PrintCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <Link
      href={href}
      className="block rounded-2xl bg-surface border border-border p-5 hover:border-border-strong transition-all"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="w-12 h-12 rounded-full bg-bg flex items-center justify-center mb-4">
        <Icon className="w-5 h-5 text-fg-muted" strokeWidth={1.75} />
      </div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-fg-muted">{description}</p>
      <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-info-fg">
        <Printer className="w-3.5 h-3.5" />
        Открыть для печати
      </div>
    </Link>
  )
}
