// Конвертер-память Бориса-Директа (ШАГ 3а).
//
// Подтверждённые ВЛАДЕЛЬЦЕМ фразы-конвертеры первой недели (истина из чата
// «Заявки Будни», доказаны атрибуцией yclid→Метрика directSearchPhrase +
// Директ SQ). Это ПОИСКОВЫЕ ФРАЗЫ, не контакты клиентов.
//
// Под конвертер-защитой: НЕ минусовать / НЕ выключать / НЕ понижать ставку с
// мотивом «дорого». В «худшие» отчётов такие фразы попадают только с оговоркой
// «конвертер». Заявка ценнее экономии на клике (см. economics.ts).
//
// Почему код-константа, а не строка БД: сид прод-БД из этой сессии недоступен
// (Neon в автосне), а знание должно жить в проде детерминированно — ровно как
// доктрина (doctrine/items/*.json). Штатный lesson-механизм подхватывает их в
// секцию «ОПЫТ» через converterLessonsForContext(). Фантом-правило (phantom.ts)
// использует подтверждённость: достижение конвертера весит 1 даже до фикса фронта.

/** Одна подтверждённая фраза-конвертер. */
export interface ConverterEntry {
  /** Канонический текст поисковой фразы (как в отчёте Директа). */
  phrase: string
  /** Группа объявлений (контекст). */
  adGroup: string
  /** Дата заявки, МСК 'YYYY-MM-DD'. */
  dateMsk: string
  /** Короткая пометка происхождения (без контактов). */
  note: string
}

/**
 * Реестр подтверждённых конвертеров недели 1 (2026-06-30..07-06).
 * Каждая доказана: Метрика ym:s:directSearchPhrase с достижением цели 575665118
 * в день лида + клик в той же группе в Директ SQ.
 */
export const CONFIRMED_CONVERTERS: ConverterEntry[] = [
  { phrase: 'комплексные обеды доставка дубна московская область', adGroup: 'G1', dateMsk: '2026-07-01', note: 'квиз, доставлена' },
  { phrase: 'бизнес ланч доставка москва', adGroup: 'G1', dateMsk: '2026-07-02', note: 'попап menu-full, доставлена' },
  { phrase: 'корпоративное питание с доставкой москва', adGroup: 'G2', dateMsk: '2026-07-03', note: 'потеряна фронтом, доказана расследованием' },
  { phrase: 'комплексные обеды с доставкой', adGroup: 'G1', dateMsk: '2026-07-05', note: 'квиз, доставлена' },
  { phrase: 'обеды на заказ с доставкой в москве', adGroup: 'G1', dateMsk: '2026-07-06', note: 'попап rabochih-hero, доставлена' },
]

/** Нормализация фразы для сравнения: lower, ё→е, срез операторов, схлопывание пробелов. */
export function normalizeConverterPhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["«»[\]+!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const CONVERTER_KEYS = new Set(CONFIRMED_CONVERTERS.map((c) => normalizeConverterPhrase(c.phrase)))

/** Зарегистрирована ли фраза как подтверждённый конвертер (защита). */
export function isRegisteredConverter(phrase: string | null | undefined): boolean {
  if (!phrase) return false
  return CONVERTER_KEYS.has(normalizeConverterPhrase(phrase))
}

/** 'YYYY-MM-DD' → 'DD.MM'. */
function ddmm(dateMsk: string): string {
  return `${dateMsk.slice(8, 10)}.${dateMsk.slice(5, 7)}`
}

/**
 * Уроки-конвертеры для секции «ОПЫТ» (LessonForContext-совместимо, см. lessons.ts):
 * штатный механизм памяти подмешивает их в контекст/отчёты Бориса.
 */
export function converterLessonsForContext(): Array<{ id: string; kind: string; text: string }> {
  return CONFIRMED_CONVERTERS.map((c) => ({
    id: `converter:${normalizeConverterPhrase(c.phrase)}`,
    kind: 'converter',
    text: `Фраза «${c.phrase}» (${c.adGroup}, заявка ${ddmm(c.dateMsk)}) — КОНВЕРТЕР под защитой: не минусовать, не выключать, не понижать ставку с мотивом «дорого».`,
  }))
}
