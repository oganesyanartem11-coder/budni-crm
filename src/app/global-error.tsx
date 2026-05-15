'use client'

import { useEffect } from 'react'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

// Fallback для случая, когда падает сам root layout — CSS-переменные из
// globals.css могут не загрузиться, поэтому используем inline-стили
// с базовыми значениями палитры «Будни».
export default function GlobalError({ error, reset }: Props) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          backgroundColor: '#F5F3EE',
          color: '#1A1A1A',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: '420px',
            width: '100%',
            backgroundColor: '#FFFFFF',
            border: '1px solid #E8E5DF',
            borderRadius: '16px',
            padding: '32px',
            textAlign: 'center',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04)',
          }}
        >
          <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
            Произошла ошибка
          </h1>
          <p style={{ fontSize: '14px', color: '#6B6B68', margin: '0 0 20px' }}>
            Приложение неожиданно остановилось. Попробуйте обновить страницу.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: '12px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: '#9A9A95',
                margin: '0 0 20px',
              }}
            >
              Код ошибки: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '10px 20px',
              borderRadius: '999px',
              backgroundColor: '#0F0F0F',
              color: '#FFFFFF',
              border: 'none',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Попробовать снова
          </button>
        </div>
      </body>
    </html>
  )
}
