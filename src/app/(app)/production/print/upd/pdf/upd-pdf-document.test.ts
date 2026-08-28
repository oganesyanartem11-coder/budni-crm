import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import { UpdPdfDocument, type UpdPdfDocData } from './upd-pdf-document'

describe('UpdPdfDocument', () => {
  it('renders a PDF when every optional buyer requisite is missing', async () => {
    const doc: UpdPdfDocData = {
      documentNumber: 'УПД-2026-0001',
      deliveryDate: new Date('2026-08-28T00:00:00.000Z'),
      totalAmount: '3500.00',
      vatAmount: null,
      vatRate: null,
      amountWithoutVat: '3500.00',
      supplier: {
        shortName: 'ООО «Будни»',
        fullName: 'Общество с ограниченной ответственностью «Будни»',
        entityType: 'LLC',
        inn: '7700000000',
        kpp: '770001001',
        ogrn: '1234567890123',
        legalAddress: 'г. Москва, ул. Примерная, д. 1',
        phone: '+7 495 000-00-00',
        email: 'info@example.test',
        bankName: 'АО «Пример Банк»',
        bankBic: '044525000',
        bankAccount: '40702810000000000000',
        bankCorrAccount: '30101810000000000000',
        directorName: 'Иванов Иван Иванович',
        directorPosition: 'Генеральный директор',
      },
      buyer: {
        clientName: 'Покупатель без реквизитов',
        legalName: null,
        inn: null,
        kpp: null,
        ogrn: null,
        legalAddress: null,
        bankName: null,
        bankBic: null,
        bankAccount: null,
        bankCorrAccount: null,
        contractNumber: null,
        contractDateIso: null,
        locationName: 'Основная точка',
        locationAddress: 'г. Москва, ул. Покупателя, д. 2',
      },
      lines: [
        {
          kind: 'FOOD',
          orderId: 'order_1',
          mealType: 'LUNCH',
          mealLabel: 'Обед',
          deliveryDateIso: '2026-08-28T00:00:00.000Z',
          portions: 10,
          pricePerPortion: '350.00',
          lineTotal: '3500.00',
          lineTotalWithoutVat: '3500.00',
          lineVat: null,
        },
      ],
    }

    const element = createElement(UpdPdfDocument, { docs: [doc] })
    const pdf = await renderToBuffer(
      element as Parameters<typeof renderToBuffer>[0],
    )

    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF')
    expect(pdf.length).toBeGreaterThan(10_000)
  })
})
