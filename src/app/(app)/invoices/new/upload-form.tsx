'use client'

import { useState, useTransition, useRef, type DragEvent, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Camera, ImageIcon, X, Loader2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { compressImage } from '@/lib/uploads/image-compress'
import { extractExif } from '@/lib/uploads/exif'
import { createInvoiceFromUpload } from '../actions'
import { cn } from '@/lib/utils/cn'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic,image/heif'
// 25 МБ — исходник до клиентской компрессии; iPhone photos в HEIC обычно 3–6 МБ,
// но Android в JPEG max-quality легко уходят за 15 МБ.
const MAX_INPUT_SIZE = 25 * 1024 * 1024
const LARGE_COMPRESSED_WARN = 10 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 90_000

function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /network|fetch|timeout|connection|econnreset|enotfound/i.test(msg)
}

function isAbortError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return true
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /aborted|timeout/i.test(msg)
}

function isTooLargeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /too large|413|maximum.*size/i.test(msg)
}

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (cameraInputRef.current) cameraInputRef.current.value = ''
    if (galleryInputRef.current) galleryInputRef.current.value = ''
  }

  // Загружает файл на наш endpoint /api/uploads/invoice-blob через XHR.
  // XHR используется вместо fetch потому что только он даёт onProgress upload-байтов.
  // Endpoint сам ходит в Vercel Blob через put() (BLOB_READ_WRITE_TOKEN), обходя CORS.
  function uploadToServer(
    blobBody: Blob,
    filename: string,
    signal: AbortSignal,
  ): Promise<{ url: string; pathname: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const form = new FormData()
      form.append('file', blobBody, filename)

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          setUploadProgress(Math.round((event.loaded / event.total) * 100))
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText) as { url: string; pathname: string }
            resolve(data)
          } catch {
            reject(new Error('Invalid response'))
          }
        } else {
          let msg = `Upload failed with status ${xhr.status}`
          try {
            const data = JSON.parse(xhr.responseText) as { error?: string }
            if (data.error) msg = data.error
          } catch {}
          if (xhr.status === 413) {
            msg = `${msg} (too large)`
          }
          reject(new Error(msg))
        }
      })

      xhr.addEventListener('error', () => reject(new Error('Network error')))
      xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))

      const onAbort = () => xhr.abort()
      signal.addEventListener('abort', onAbort)

      xhr.open('POST', '/api/uploads/invoice-blob')
      xhr.send(form)
    })
  }

  async function uploadWithRetry(
    blobBody: Blob,
    filename: string,
    signal: AbortSignal,
    retriesLeft = 1,
  ): Promise<{ url: string; pathname: string }> {
    try {
      return await uploadToServer(blobBody, filename, signal)
    } catch (err) {
      // НЕ retry-им если abort (по таймауту или пользователем) и НЕ 4xx.
      if (retriesLeft > 0 && !isAbortError(err) && !isTooLargeError(err) && isNetworkError(err)) {
        await new Promise((r) => setTimeout(r, 1000))
        return uploadWithRetry(blobBody, filename, signal, retriesLeft - 1)
      }
      throw err
    }
  }

  async function handleUpload() {
    if (!file) return
    setError(null)
    setIsUploading(true)
    setUploadProgress(0)

    abortControllerRef.current = new AbortController()
    timeoutRef.current = setTimeout(() => {
      abortControllerRef.current?.abort('timeout')
    }, UPLOAD_TIMEOUT_MS)

    try {
      // 1. Клиентский compress (createImageBitmap → canvas → JPEG 0.75, max 1200px).
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

      if (compressed.blob.size > LARGE_COMPRESSED_WARN) {
        const mb = (compressed.blob.size / 1024 / 1024).toFixed(1)
        toast.info(`Файл большой (${mb} МБ), загрузка может занять до минуты`)
      }

      // 2. EXIF (best-effort).
      const exif = await extractExif(file).catch(() => ({ takenAt: null, isSuspicious: true }))

      // 3. Upload через наш server-side endpoint (обходит CORS на vercel.com/api/blob).
      //    Имя файла — UUID.jpg; реальный pathname в Blob формирует сервер.
      const filename = `${crypto.randomUUID()}.jpg`
      const blob = await uploadWithRetry(compressed.blob, filename, abortControllerRef.current.signal)

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
      if (isAbortError(e)) {
        setError('Загрузка слишком долгая. Проверьте интернет и попробуйте ещё раз.')
      } else if (isTooLargeError(e)) {
        setError('Фото слишком большое. Попробуйте сфотографировать заново.')
      } else if (e instanceof Error && /HEIC файлы не поддерживаются/.test(e.message)) {
        setError(e.message)
      } else if (e instanceof Error && /Не удалось обработать фото/.test(e.message)) {
        setError(e.message)
      } else if (isNetworkError(e)) {
        setError('Не удалось загрузить фото. Проверьте интернет и попробуйте ещё раз.')
      } else {
        setError((e as Error).message || 'Не удалось загрузить фото. Попробуйте ещё раз.')
      }
      setUploadProgress(0)
    } finally {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      // На успешном пути startTransition уже взял эстафету (busy = isUploading
      // || isPending), кнопка остаётся занятой до router.push. На неуспешном —
      // сбрасываем явно. Безусловный setIsUploading(false) безопасен.
      setIsUploading(false)
    }
  }

  const busy = isUploading || isPending

  return (
    <div className="max-w-2xl space-y-4">
      {/* Скрытые file-inputs — один для камеры, один для галереи. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        capture="environment"
        className="hidden"
        onChange={onInputChange}
        disabled={busy}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={onInputChange}
        disabled={busy}
      />

      {!file ? (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={cn(
            'border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-colors',
            isDragging ? 'border-accent bg-accent/5' : 'border-border bg-surface',
          )}
        >
          <Camera className="w-12 h-12 text-fg-subtle mx-auto mb-3" strokeWidth={1.5} />
          <p className="font-medium text-fg mb-1">Загрузить накладную</p>
          <p className="text-sm text-fg-muted mb-5">
            JPEG / PNG / HEIC · до 25 МБ
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center max-w-md mx-auto">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Camera className="w-4 h-4" />
              Сфотографировать
            </button>
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-pill border border-border text-fg text-sm font-medium hover:bg-fg/5 transition-colors disabled:opacity-40"
            >
              <ImageIcon className="w-4 h-4" />
              Из галереи
            </button>
          </div>
          <p className="text-xs text-fg-subtle mt-4 hidden sm:block">
            …или перетащите файл сюда
          </p>
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
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
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
