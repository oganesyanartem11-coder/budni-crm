'use client'

import { useState, useTransition, useEffect } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { createClientContact, updateClientContact } from './contact-actions'
import type { ClientContactDTO } from './contact-actions'

interface Props {
  clientId: string
  contact?: ClientContactDTO
  open: boolean
  onClose: () => void
}

export function ContactModal({ clientId, contact, open, onClose }: Props) {
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(contact?.name ?? '')
  const [role, setRole] = useState(contact?.role ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [notes, setNotes] = useState(contact?.notes ?? '')

  useEffect(() => {
    if (!open) return
    if (contact) {
      setName(contact.name ?? '')
      setRole(contact.role ?? '')
      setPhone(contact.phone)
      setEmail(contact.email ?? '')
      setNotes(contact.notes ?? '')
    } else {
      setName('')
      setRole('')
      setPhone('')
      setEmail('')
      setNotes('')
    }
  }, [open, contact])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (phone.trim().length < 5) {
      toast.error('Укажите телефон')
      return
    }

    startTransition(async () => {
      const data = {
        name: name.trim() || null,
        role: role.trim() || null,
        phone: phone.trim(),
        email: email.trim() || null,
        notes: notes.trim() || null,
      }

      const result = contact
        ? await updateClientContact(contact.id, data)
        : await createClientContact(clientId, data)

      if (result.ok) {
        toast.success(contact ? 'Контакт обновлён' : 'Контакт добавлен')
        onClose()
      } else {
        toast.error(result.error)
      }
    })
  }

  const inputClass =
    'w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-surface border border-border"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-display text-lg font-bold text-fg-strong">
            {contact ? 'Редактировать контакт' : 'Новый контакт'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            style={{ touchAction: 'manipulation' }}
            className="min-h-[44px] min-w-[44px] w-11 h-11 -mr-2 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Имя</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Роль</label>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="прораб, бухгалтер"
                className={inputClass}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">
              Телефон <span className="text-danger-fg">*</span>
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 (999) 999-99-99"
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Заметка</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors resize-y"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              style={{ touchAction: 'manipulation' }}
              className="min-h-[44px] px-5 py-2.5 rounded-xl border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isPending}
              style={{
                touchAction: 'manipulation',
                background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)',
                boxShadow: 'var(--shadow-capsule)',
              }}
              className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              {isPending ? 'Сохраняем…' : contact ? 'Сохранить' : 'Добавить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
