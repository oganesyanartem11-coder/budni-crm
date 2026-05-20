'use client'

import { useState, useTransition, useRef, type DragEvent, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Upload, FileSpreadsheet, X, Loader2 } from 'lucide-react'
import { createMenuImport } from '../actions'
import { cn } from '@/lib/utils/cn'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 МБ — то же ограничение что в server action

function isExcel(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.xlsx') || lower.endsWith('.xls')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`
}

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [submitting, startTransition] = useTransition()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  function accept(f: File | null) {
    setError(null)
    if (!f) {
      setFile(null)
      return
    }
    if (!isExcel(f.name)) {
      setError('Поддерживаются только Excel-файлы (.xlsx, .xls). Фото-меню добавим позже.')
      setFile(null)
      return
    }
    if (f.size > MAX_FILE_SIZE) {
      setError('Файл больше 10 МБ. Уменьшите или сожмите.')
      setFile(null)
      return
    }
    setFile(f)
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    accept(e.target.files?.[0] ?? null)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    accept(e.dataTransfer.files[0] ?? null)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(true)
  }

  function onDragLeave() {
    setDragOver(false)
  }

  function clear() {
    setFile(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  function onSubmit() {
    if (!file) return
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      const r = await createMenuImport(fd)
      if (r.ok) {
        router.push(`/menu/imports/${r.data.menuImportId}`)
      } else {
        setError(r.error)
      }
    })
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors',
          dragOver ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:border-fg/20',
          submitting && 'pointer-events-none opacity-60'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={onInputChange}
          disabled={submitting}
        />
        {!file ? (
          <>
            <Upload className="w-12 h-12 text-fg-subtle mx-auto mb-3" strokeWidth={1.5} />
            <p className="font-medium text-fg mb-1">Перетащите Excel сюда или нажмите для выбора</p>
            <p className="text-sm text-fg-muted">.xlsx, .xls · до 10 МБ</p>
          </>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <FileSpreadsheet className="w-8 h-8 text-accent shrink-0" />
            <div className="text-left">
              <p className="font-medium text-fg truncate max-w-xs">{file.name}</p>
              <p className="text-sm text-fg-muted">{formatSize(file.size)}</p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                clear()
              }}
              className="ml-2 p-1 rounded-md hover:bg-fg/5"
              aria-label="Убрать файл"
              disabled={submitting}
            >
              <X className="w-4 h-4 text-fg-muted" />
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <p className="text-sm text-fg-muted">
        Обработка занимает 2–3 минуты. Можно закрыть страницу — импорт продолжится в фоне.
        Сейчас поддерживается только Excel; фото-меню добавим позже.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!file || submitting}
          className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting ? 'Загружаю…' : 'Запустить импорт'}
        </button>
        <Link
          href="/menu/imports"
          className="px-5 py-2.5 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors"
        >
          Отмена
        </Link>
      </div>
    </div>
  )
}
