import { NextResponse, type NextRequest } from 'next/server'
import { put } from '@vercel/blob' // ВАЖНО: НЕ @vercel/blob/client — это server-side upload через BLOB_READ_WRITE_TOKEN.
import { randomUUID } from 'node:crypto'
import { requireRole } from '@/lib/auth/current-user'

export const runtime = 'nodejs'

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]

// 15 МБ — мы жмём на клиенте до ~1.5 МБ, запас для edge-cases.
const MAX_SIZE = 15 * 1024 * 1024

export async function POST(request: NextRequest) {
  try {
    await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])

    const formData = await request.formData()
    const fileEntry = formData.get('file')

    if (!(fileEntry instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const file = fileEntry

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Invalid file type: ${file.type}` },
        { status: 400 },
      )
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: `File too large: ${file.size} bytes (max ${MAX_SIZE})` },
        { status: 413 },
      )
    }

    const subtype = file.type.split('/')[1] ?? 'jpg'
    const ext = subtype === 'jpeg' ? 'jpg' : subtype
    const pathname = `invoices/${randomUUID()}.${ext}`

    const blob = await put(pathname, file, {
      access: 'public',
      contentType: file.type,
    })

    return NextResponse.json({
      url: blob.url,
      pathname: blob.pathname,
      contentType: blob.contentType,
      size: file.size,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[invoice-blob-upload]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
