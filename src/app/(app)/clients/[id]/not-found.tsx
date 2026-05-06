import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="rounded-2xl bg-surface border border-border p-12 text-center" style={{ boxShadow: 'var(--shadow-card)' }}>
      <h2 className="text-xl font-semibold mb-2">Клиент не найден</h2>
      <p className="text-fg-muted mb-6">Возможно, он был удалён или ссылка неверна.</p>
      <Link
        href="/clients"
        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity"
      >
        <ArrowLeft className="w-4 h-4" />
        Все клиенты
      </Link>
    </div>
  )
}
