'use client'

import { useState, useTransition, useRef, type DragEvent, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Camera, X, Loader2, AlertCircle } from 'lucide-react'
import { upload } from '@vercel/blob/client'
import { compressImage } from '@/lib/uploads/image-compress'
import { extractExif } from '@/lib/uploads/exif'
import { createInvoiceFromUpload } from '../actions'
import { cn } from '@/lib/utils/cn'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
// 25 МБ — исходник до клиентской компрессии; iPhone photos в HEIC обычно 3–6 МБ,
// но Android в JPEG max-quality легко уходят за 15 МБ.
const MAX_INPUT_SIZE = 25 * 1024 * 1024

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  function accept(f: File | null) {
    setError(null)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    if (!f) {
      setFile(null)
      setPreviewUrl(null)
      return
    }
    // HEIC/HEIF на iPhone иногда приходят с пустым MIME — fallback по расширению.
    const typeOk = ALLOWED_TYPES.includes(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)
    if (!typeOk) {
      setError('Поддерживаются только фото (JPEG, PNG, WebP, HEIC).')
      return
    }
    if (f.size > MAX_INPUT_SIZE) {
      setError('Файл больше 25 МБ. Уменьшите размер.')
      return
    }
    setFile(f)
    try {
      setPreviewUrl(URL.createObjectURL(f))
    } catch {
      setPreviewUrl(null)
    }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    accept(e.target.files?.[0] ?? null)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
    accept(e.dataTransfer.files[0] ?? null)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(true)
  }

  function onDragLeave() {
    setIsDragging(false)
  }

  function clear() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null)
    setPreviewUrl(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function handleUpload() {
    if (!file) return
    setError(null)
    setIsUploading(true)
    setUploadProgress(0)
    try {
      // 1. Сжимаем клиентски (createImageBitmap → canvas → JPEG 0.85, max 1600px).
      // На большинстве браузеров createImageBitmap нативно декодирует HEIC, но
      // если нет (старая Chrome на Android) — упадёт здесь.
      let compressed
      try {
        compressed = await compressImage(file)
      } catch (e) {
        const m = (e as Error).message
        if (/heic|heif|imageBitmap|decoding/i.test(m)) {
          throw new Error('HEIC файлы не поддерживаются в этом браузере. Попробуйте JPEG.')
        }
        throw new Error(`Не удалось обработать фото: ${m}`)
      }

      // 2. EXIF (best-effort).
      const exif = await extractExif(file).catch(() => ({ takenAt: null, isSuspicious: true }))

      // 3. Upload в Vercel Blob (client-direct через handleUpload-token endpoint).
      const pathname = `invoices/${crypto.randomUUID()}.jpg`
      const blob = await upload(pathname, compressed.blob, {
        access: 'public',
        handleUploadUrl: '/api/uploads/invoice-token',
        contentType: 'image/jpeg',
        onUploadProgress: (event) => {
          setUploadProgress(Math.round(event.percentage))
        },
      })

      // 4. Создаём Invoice — fire-and-forget orchestrator на сервере.
      startTransition(async () => {
        const r = await createInvoiceFromUpload({
          imageUrl: blob.url,
          imageWidth: compressed.width,
          imageHeight: compressed.height,
          exifTakenAt: exif.takenAt ? exif.takenAt.toISOString() : undefined,
          exifSuspicious: exif.isSuspicious,
        })
        if (!r.ok) {
          setError(r.error)
          setIsUploading(false)
          return
        }
        router.push(`/invoices/${r.data.invoiceId}`)
      })
    } catch (e) {
      setError((e as Error).message || 'Не удалось загрузить файл')
      setIsUploading(false)
    }
  }

  const busy = isUploading || isPending

  return (
    <div className="max-w-2xl space-y-4">
      {!file ? (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors',
            isDragging ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:border-fg/20',
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            capture="environment"
            className="hidden"
            onChange={onInputChange}
            disabled={busy}
          />
          <Camera className="w-12 h-12 text-fg-subtle mx-auto mb-3" strokeWidth={1.5} />
          <p className="font-medium text-fg mb-1">Сфотографируйте накладную</p>
          <p className="text-sm text-fg-muted">или перетащите файл сюда · JPEG / PNG / HEIC · до 25 МБ</p>
        </div>
      ) : (
        <div
          className="rounded-2xl border border-border bg-surface p-4 space-y-3"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          {previewUrl && (
            // Локальный preview через object URL — next/image тут не подходит,
            // src — blob:-схема, не https.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="превью накладной"
              className="w-full max-h-96 object-contain rounded-lg bg-bg"
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-fg-muted truncate">
              {file.name} · {(file.size / 1024 / 1024).toFixed(2)} МБ
            </div>
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className="p-1.5 rounded-md hover:bg-fg/5"
              aria-label="Убрать файл"
            >
              <X className="w-4 h-4 text-fg-muted" />
            </button>
          </div>

          {isUploading && (
            <div className="space-y-1">
              <div className="h-2 bg-bg rounded-full overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="text-xs text-fg-subtle">Загружаем · {uploadProgress}%</p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger-fg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleUpload}
          disabled={!file || busy}
          className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {busy ? 'Отправляем…' : 'Загрузить'}
        </button>
        <Link
          href="/invoices"
          className="px-5 py-2.5 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors"
        >
          Отмена
        </Link>
      </div>
    </div>
  )
}
