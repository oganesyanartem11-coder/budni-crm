import { z } from 'zod'
import {
  validateInn,
  validateOgrn,
  validateBic,
  validateAccount,
  validateCorrAccount,
} from './russian-requisites'

export const legalEntitySchema = z
  .object({
    shortName: z.string().trim().min(1, 'Обязательное поле').max(100),
    fullName: z.string().trim().min(1, 'Обязательное поле').max(500),
    entityType: z.enum(['INDIVIDUAL_ENTREPRENEUR', 'LLC']),

    inn: z
      .string()
      .trim()
      .refine(validateInn, 'Некорректный ИНН (проверка контрольной суммы не прошла)'),
    kpp: z
      .string()
      .trim()
      .regex(/^\d{9}$/, 'КПП — 9 цифр')
      .optional()
      .or(z.literal('')),
    ogrn: z
      .string()
      .trim()
      .refine(validateOgrn, 'Некорректный ОГРН/ОГРНИП'),

    legalAddress: z.string().trim().min(1, 'Обязательное поле').max(500),

    phone: z.string().trim().optional().or(z.literal('')),
    email: z
      .string()
      .trim()
      .email('Некорректный email')
      .optional()
      .or(z.literal('')),

    bankName: z.string().trim().min(1, 'Обязательное поле').max(200),
    bankBic: z.string().trim().refine(validateBic, 'Некорректный БИК'),
    bankAccount: z.string().trim(), // валидация ниже через superRefine — нужен BIC
    bankCorrAccount: z.string().trim(),

    directorName: z.string().trim().min(1, 'Обязательное поле').max(200),
    directorPosition: z.string().trim().min(1).max(100).default('Директор'),

    vatMode: z.enum(['NONE', 'VAT_10_INCLUSIVE']),
    vatRate: z.number().min(0).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    // 1. ИНН: соответствие типу юрлица
    if (data.entityType === 'INDIVIDUAL_ENTREPRENEUR' && data.inn.length !== 12) {
      ctx.addIssue({
        code: 'custom',
        path: ['inn'],
        message: 'ИНН ИП должен содержать 12 цифр',
      })
    }
    if (data.entityType === 'LLC' && data.inn.length !== 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['inn'],
        message: 'ИНН ООО должен содержать 10 цифр',
      })
    }

    // 2. ОГРН: соответствие типу юрлица
    if (data.entityType === 'INDIVIDUAL_ENTREPRENEUR' && data.ogrn.length !== 15) {
      ctx.addIssue({
        code: 'custom',
        path: ['ogrn'],
        message: 'ОГРНИП должен содержать 15 цифр',
      })
    }
    if (data.entityType === 'LLC' && data.ogrn.length !== 13) {
      ctx.addIssue({
        code: 'custom',
        path: ['ogrn'],
        message: 'ОГРН должен содержать 13 цифр',
      })
    }

    // 3. КПП: обязателен только для ООО
    if (data.entityType === 'LLC' && (!data.kpp || data.kpp === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['kpp'],
        message: 'КПП обязателен для ООО',
      })
    }
    if (
      data.entityType === 'INDIVIDUAL_ENTREPRENEUR' &&
      data.kpp &&
      data.kpp !== ''
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['kpp'],
        message: 'КПП не используется для ИП — оставьте пустым',
      })
    }

    // 4. НДС-режим консистентен
    if (data.vatMode === 'VAT_10_INCLUSIVE' && !data.vatRate) {
      ctx.addIssue({
        code: 'custom',
        path: ['vatRate'],
        message: 'Укажите ставку НДС',
      })
    }
    if (
      data.vatMode === 'NONE' &&
      data.vatRate !== undefined &&
      data.vatRate !== 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['vatRate'],
        message: 'При режиме «Без НДС» оставьте ставку пустой',
      })
    }

    // 5. Расчётный счёт — контрольная сумма с учётом БИК
    if (!validateAccount(data.bankAccount, data.bankBic)) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankAccount'],
        message: 'Расчётный счёт: контрольная сумма не сходится с БИК',
      })
    }

    // 6. Корр. счёт — отдельный алгоритм 153-И (счёт ведётся в ЦБ РФ)
    if (!validateCorrAccount(data.bankCorrAccount, data.bankBic)) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankCorrAccount'],
        message: 'Корр. счёт: контрольная сумма не сходится с БИК',
      })
    }
  })

export type LegalEntityFormData = z.infer<typeof legalEntitySchema>
