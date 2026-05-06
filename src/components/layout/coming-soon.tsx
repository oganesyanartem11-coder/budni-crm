import { Construction } from 'lucide-react'

interface ComingSoonProps {
  title: string
  description?: string
  sprint: string
}

export function ComingSoon({ title, description, sprint }: ComingSoonProps) {
  return (
    <div className="rounded-2xl bg-surface border border-border p-12 text-center" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="w-16 h-16 mx-auto rounded-full bg-bg flex items-center justify-center mb-6">
        <Construction className="w-7 h-7 text-fg-muted" strokeWidth={1.5} />
      </div>
      <h2 className="text-xl font-semibold mb-2">{title}</h2>
      {description && (
        <p className="text-fg-muted max-w-md mx-auto">{description}</p>
      )}
      <p className="text-xs text-fg-subtle mt-6 font-mono">{sprint}</p>
    </div>
  )
}
