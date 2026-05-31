import type { Metadata, Viewport } from 'next'
import { Inter, Onest } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
  display: 'swap',
})

const onest = Onest({
  subsets: ['latin', 'cyrillic'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-onest',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Будни. Как дома',
  description: 'CRM для B2B-обедов',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Будни',
  },
  // icons НЕ указываем — Next сам возьмёт src/app/icon.png + src/app/apple-icon.png
}

// Next 16: themeColor живёт в viewport-экспорте, не в metadata.
export const viewport: Viewport = {
  themeColor: '#10141A',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ru" className={`${inter.variable} ${onest.variable}`}>
      <body className="font-sans antialiased bg-bg text-fg">
        {children}
        <Toaster position="top-right" />
      </body>
    </html>
  )
}
