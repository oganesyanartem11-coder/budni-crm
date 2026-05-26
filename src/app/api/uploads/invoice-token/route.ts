import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/current-user'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  // Все юзеры с доступом к CRM (кроме COURIER) могут загрузить накладную.
  // Тогда COURIER не сможет — а ADMIN, ADMIN_PRO, MANAGER, CHEF смогут.
  await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])

  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Защита от перезаписи / нежелательного контента.
        return {
          allowedContentTypes: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/heic',
            'image/heif',
          ],
          // 7.14B-1 hotfix: клиент жмёт до ~1.5MB (1200px@0.75), запас 10× даём
          // на детальные фото / edge-cases. Раньше было 5MB — фото upload'ы
          // упирались в финальную фазу PUT и зависали на 86-88%.
          maximumSizeInBytes: 15 * 1024 * 1024,
          tokenPayload: JSON.stringify({ pathname }),
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Не создаём Invoice здесь — это сделает отдельный server action
        // после получения URL из клиента.
        console.log('[invoice-token] uploaded:', blob.pathname, 'token:', tokenPayload)
      },
    })
    return NextResponse.json(jsonResponse)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
