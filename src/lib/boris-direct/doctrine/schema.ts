// Схема доктрин-карточки Бориса-Директа.
//
// Доктрина = СЛОЙ ВНЕШНИХ ЗНАНИЙ (справка Яндекса о механике Директа/Метрики),
// дистиллированный СВОИМИ словами. Это СПРАВКА, а НЕ приказ: предохранители
// кода и собственный опыт кампании важнее (см. loader.renderDoctrineBlock).
//
// Карточки хранятся в items/*.json по темам, валидируются этой схемой при
// загрузке (loader.ts) и в тесте (schema.test.ts). verbatim-тексты НЕ храним —
// только claim своими словами + URL источника.

import { z } from 'zod'

export const DOCTRINE_TYPES = ['MECHANIC', 'LIMIT', 'RECOMMENDATION'] as const
export const DOCTRINE_APPLIES_TO = ['search', 'rsya', 'autostrategy', 'manual', 'all'] as const
export const DOCTRINE_CONFIDENCE = ['HIGH', 'MEDIUM'] as const
export const DOCTRINE_STANCE = ['ALIGNED', 'NEUTRAL', 'CONFLICTS'] as const
export const DOCTRINE_STATUS = ['ACTIVE', 'REFUTED_BY_EXPERIENCE', 'STALE'] as const

export type DoctrineType = (typeof DOCTRINE_TYPES)[number]
export type DoctrineStatus = (typeof DOCTRINE_STATUS)[number]

/** Максимум длины claim — карточка это ТЕЗИС, а не абзац (и защита от копипаста). */
export const DOCTRINE_CLAIM_MAX = 400

export const DoctrineSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
})

/** Ссылка на урок опыта, опровергнувший карточку (аудит, не удаляем — ШАГ 5). */
export const RefutedBySchema = z.object({
  lessonRef: z.string().min(1),
  note: z.string().optional(),
})

export const DoctrineCardSchema = z
  .object({
    id: z.string().min(1),
    /** Утверждение СВОИМИ словами (≤400 знаков). Копипаст запрещён. */
    claim: z.string().min(1).max(DOCTRINE_CLAIM_MAX),
    type: z.enum(DOCTRINE_TYPES),
    source: DoctrineSourceSchema,
    tags: z.array(z.string().min(1)).min(1),
    appliesTo: z.array(z.enum(DOCTRINE_APPLIES_TO)).min(1),
    confidence: z.enum(DOCTRINE_CONFIDENCE),
    projectStance: z.enum(DOCTRINE_STANCE),
    /** Обязателен при projectStance=CONFLICTS: с каким нашим правилом конфликт. */
    conflictNote: z.string().min(1).optional(),
    status: z.enum(DOCTRINE_STATUS),
    /** ISO-дата добавления. */
    addedAt: z.string().min(1),
    refutedBy: RefutedBySchema.optional(),
  })
  // CONFLICTS без conflictNote — ошибка (ШАГ 7).
  .refine((c) => !(c.projectStance === 'CONFLICTS' && !c.conflictNote?.trim()), {
    message: 'projectStance=CONFLICTS требует непустой conflictNote',
    path: ['conflictNote'],
  })
  // REFUTED_BY_EXPERIENCE обязан ссылаться на урок (аудит).
  .refine((c) => !(c.status === 'REFUTED_BY_EXPERIENCE' && !c.refutedBy), {
    message: 'status=REFUTED_BY_EXPERIENCE требует refutedBy (ссылку на урок опыта)',
    path: ['refutedBy'],
  })

export type DoctrineCard = z.infer<typeof DoctrineCardSchema>

/** Массив сырых карточек одного тематического файла. */
export const DoctrineFileSchema = z.array(DoctrineCardSchema)
