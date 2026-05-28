import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const expectedSecret = process.env.CRON_SECRET
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const MAX_ATTEMPTS = 3
  let lastError: unknown = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`
      console.log('[cron:keep-warm] db warm')
      return NextResponse.json({ ok: true, attempt })
    } catch (err) {
      lastError = err
      console.warn(`[cron:keep-warm] attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }

  console.error('[cron:keep-warm] all attempts failed:', lastError)
  return NextResponse.json({ ok: false }, { status: 500 })
}
