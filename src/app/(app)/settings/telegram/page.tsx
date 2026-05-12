import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { getCurrentUser } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { getTelegramEnv } from '@/lib/telegram/env'
import { TelegramSettingsClient } from './_components/telegram-settings-client'

export default async function TelegramSettingsPage() {
  const me = await getCurrentUser()

  // Тянем свежие данные напрямую из БД — состояние могло обновиться webhook'ом
  // после redirect'а из onboarding.
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    select: {
      id: true,
      name: true,
      telegramChatId: true,
      telegramUsername: true,
      telegramOnboardingToken: true,
      telegramOnboardingExpiresAt: true,
    },
  })

  // Если уже есть активная (не истёкшая) ссылка — сразу покажем её,
  // не заставляя жать «Сгенерировать» повторно.
  let initialDeeplink: string | null = null
  if (
    user.telegramOnboardingToken &&
    user.telegramOnboardingExpiresAt &&
    user.telegramOnboardingExpiresAt > new Date()
  ) {
    try {
      const { botUsername } = getTelegramEnv()
      initialDeeplink = `https://t.me/${botUsername}?start=${user.telegramOnboardingToken}`
    } catch {
      // ENV не настроен — UI всё равно нарисуется, генерация просто упадёт с тостом
      initialDeeplink = null
    }
  }

  return (
    <>
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К настройкам
        </Link>
      </div>

      <PageHeader title="Telegram-уведомления" subtitle={user.name} />

      <TelegramSettingsClient
        isLinked={user.telegramChatId !== null}
        telegramUsername={user.telegramUsername}
        initialDeeplink={initialDeeplink}
        initialDeeplinkExpiresAt={
          user.telegramOnboardingExpiresAt ? user.telegramOnboardingExpiresAt.toISOString() : null
        }
      />
    </>
  )
}
