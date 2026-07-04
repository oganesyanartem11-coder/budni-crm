// Публичный API слоя доктрины Бориса-Директа.
//
// Доктрина — слой ВНЕШНИХ знаний (справка Яндекса о механике Директа/Метрики),
// дистиллированный своими словами. СПРАВКА, не приказ: код-предохранители и
// собственный опыт кампании важнее. Влияет ТОЛЬКО на LLM-суждения и тексты,
// НИКОГДА на код-пороги/предохранители.

export {
  DoctrineCardSchema,
  DoctrineFileSchema,
  DOCTRINE_TYPES,
  DOCTRINE_APPLIES_TO,
  DOCTRINE_CONFIDENCE,
  DOCTRINE_STANCE,
  DOCTRINE_STATUS,
  DOCTRINE_CLAIM_MAX,
  type DoctrineCard,
  type DoctrineType,
  type DoctrineStatus,
} from './schema'

export {
  getDoctrine,
  getDoctrineBlock,
  getAllDoctrineCards,
  selectDoctrine,
  renderDoctrineBlock,
  estimateCardTokens,
  DOCTRINE_PREAMBLE,
  filterRefuted,
  getRefutedCards,
  renderKnowledgeExperienceConflicts,
  type GetDoctrineOpts,
} from './loader'
