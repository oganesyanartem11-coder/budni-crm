import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import DeliveryLoading from './loading'
import StopLoading from './stops/[stopId]/loading'
import DeliveryError from './error'
import StopNotFound from './stops/[stopId]/not-found'

describe('delivery route boundaries', () => {
  it('provides meaningful day-route and stop loading states', () => {
    const routeHtml = renderToStaticMarkup(createElement(DeliveryLoading))
    const stopHtml = renderToStaticMarkup(createElement(StopLoading))

    expect(routeHtml).toContain('Загружаем маршрут')
    expect(routeHtml).toContain('aria-busy="true"')
    expect(stopHtml).toContain('Загружаем точку')
    expect(stopHtml).toContain('aria-busy="true"')
  })

  it('offers an accessible retry after an uncaught delivery error', () => {
    const html = renderToStaticMarkup(createElement(DeliveryError, {
      error: new Error('boom'),
      reset: vi.fn(),
    }))

    expect(html).toContain('Не удалось загрузить маршрут')
    expect(html).toContain('Попробовать снова')
    expect(html).toContain('role="alert"')
  })

  it('keeps a foreign or removed stop on a safe back path', () => {
    const html = renderToStaticMarkup(createElement(StopNotFound))

    expect(html).toContain('Точка недоступна')
    expect(html).toContain('Все точки')
    expect(html).toContain('href="/delivery"')
  })
})
