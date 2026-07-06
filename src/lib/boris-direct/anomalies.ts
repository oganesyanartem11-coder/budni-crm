// Детекция аномалий кампании (Борис-Директ). ЧИСТЫЕ функции — все числа
// уже посчитаны кодом снаружи (снапшоты/отчёты/лиды), здесь только сравнения
// с порогами. null во входе = «данных нет» → соответствующая проверка молчит.

export interface Anomaly {
  severity: 'warn' | 'critical'
  kind: string
  text: string
}

// ---------- Пороги (локальные, с обоснованием) ----------

/** Скачок расхода: вчера больше чем ×2 к среднему за 7 дней — деньги улетают. */
const SPEND_SPIKE_FACTOR = 2

/** Обрыв показов: вчера меньше 20% среднего — кампанию, вероятно, «выключило». */
const IMPRESSIONS_DROP_RATIO = 0.2

/** Обрыв показов меряем только при осмысленном среднем (≥50 показов/день). */
const IMPRESSIONS_MIN_AVG = 50

/**
 * Ноль заявок тревожит ТОЛЬКО при СОЛИДНОМ недавнем потоке (≥2 заявки/день в
 * среднем за 7 дней). Было ≥1 — но на низкообъёмном B2B (1–2 заявки/день) с
 * лагом конверсии единичный нулевой будний день ПОСЛЕ выходных — норма, не
 * поломка формы. Порог 2 отсекает лаг-эхо низкого объёма, оставляя реальные
 * обвалы (была устойчивая ≥2/день — вдруг ноль). [Цикл 2.0, виток 7:
 * было≥1 → стало≥2, на утверждение владельца.]
 */
const LEADS_ZERO_MIN_AVG = 2

/** Катастрофа: расход сегодня пробил дневной бюджет с запасом ×1.5. */
const CATASTROPHE_BUDGET_FACTOR = 1.5

// ---------- Детекция ----------

export interface AnomalyInput {
  spentYesterdayRub: number | null
  avgSpend7dRub: number | null
  impressionsYesterday: number | null
  avgImpressions7d: number | null
  addMetricaTag: 'YES' | 'NO' | null
  leadsYesterday: number
  avgLeads7d: number | null
  rejectedAdsCount: number
  apiErrors: string[]
  /**
   * Вчера был выходной по МСК (сб/вс)? У нас B2B-доставка обедов: выходные
   * почти мёртвые по спросу (сигнал движка/жизни есть). Тогда обрыв показов и
   * ноль заявок — ОЖИДАЕМАЯ сезонность, НЕ аномалия: эти две проверки молчат,
   * чтобы не сыпать ложными алёртами каждую субботу-воскресенье. Скачок расхода,
   * слёт тега, отклонения, ошибки API — по-прежнему проверяются (они от дня
   * недели не зависят).
   */
  yesterdayIsWeekend: boolean
}

export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const anomalies: Anomaly[] = []

  // Скачок расхода: вчера > 2× среднего (при осмысленном среднем > 0).
  if (
    input.spentYesterdayRub != null &&
    input.avgSpend7dRub != null &&
    input.avgSpend7dRub > 0 &&
    input.spentYesterdayRub > input.avgSpend7dRub * SPEND_SPIKE_FACTOR
  ) {
    anomalies.push({
      severity: 'critical',
      kind: 'spend_spike',
      text: `Скачок расхода: вчера ${input.spentYesterdayRub.toFixed(0)} ₽ при среднем ${input.avgSpend7dRub.toFixed(0)} ₽/день за 7 дней (больше ×${SPEND_SPIKE_FACTOR}).`,
    })
  }

  // Обрыв показов: вчера < 20% среднего при среднем ≥ 50. В выходной молчим —
  // низкий охват в сб/вс — это B2B-сезонность, а не «кампанию выключило».
  if (
    !input.yesterdayIsWeekend &&
    input.impressionsYesterday != null &&
    input.avgImpressions7d != null &&
    input.avgImpressions7d >= IMPRESSIONS_MIN_AVG &&
    input.impressionsYesterday < input.avgImpressions7d * IMPRESSIONS_DROP_RATIO
  ) {
    anomalies.push({
      severity: 'critical',
      kind: 'impressions_drop',
      text: `Обрыв показов: вчера ${input.impressionsYesterday} при среднем ${input.avgImpressions7d.toFixed(0)}/день — показы фактически встали.`,
    })
  }

  // ADD_METRICA_TAG слетел в NO → атрибуция заявок ломается, чинить сразу.
  if (input.addMetricaTag === 'NO') {
    anomalies.push({
      severity: 'critical',
      kind: 'metrica_tag_off',
      text: 'ADD_METRICA_TAG=NO: разметка ссылок Метрикой выключена — атрибуция заявок сломана, нужно вернуть YES.',
    })
  }

  // Заявки упали в ноль после того, как БЫЛИ (avg7d ≥ 1). В выходной молчим —
  // ноль заявок в сб/вс у B2B-обедов ожидаем, это не «форма сломалась».
  if (
    !input.yesterdayIsWeekend &&
    input.leadsYesterday === 0 &&
    input.avgLeads7d != null &&
    input.avgLeads7d >= LEADS_ZERO_MIN_AVG
  ) {
    anomalies.push({
      severity: 'warn',
      kind: 'leads_zero',
      text: `Ноль заявок за вчера при среднем ${input.avgLeads7d.toFixed(1)}/день за 7 дней — проверить форму, звонки, кампанию.`,
    })
  }

  // Отклонения модерации.
  if (input.rejectedAdsCount > 0) {
    anomalies.push({
      severity: 'warn',
      kind: 'rejected',
      text: `Отклонено модерацией: ${input.rejectedAdsCount} шт. — часть трафика не работает.`,
    })
  }

  // Ошибки API за тик — само не рассосётся, надо смотреть.
  if (input.apiErrors.length > 0) {
    anomalies.push({
      severity: 'warn',
      kind: 'api_errors',
      text: `Ошибки API за тик (${input.apiErrors.length}): ${input.apiErrors.join('; ')}`,
    })
  }

  return anomalies
}

/**
 * ШАГ 3: чувствительная сверка «конверсии Метрики (цель) vs заявки в БД»,
 * порог 1. Общий гейт DATA_MISMATCH (MIN_COUNT=3) прячет потерю ОДНОЙ заявки;
 * здесь ловим именно её: конверсия(и) по цели есть, а записей в БД меньше =
 * вероятная ПОТЕРЯ лида (persist упал / заявка не дошла). Возвращает
 * critical-аномалию или null. Прочие сверки/пороги не трогает.
 *
 * Направление одно — metrikaGoal > leadsTotal: конверсия без записи. Обратное
 * (в БД больше, чем целей) — обычно adblock/тест/лаг Метрики, не потеря; его
 * ловит существующий DATA_MISMATCH ≥2×, здесь не шумим.
 */
export function detectLeadReconcileLoss(input: {
  reportConv: number
  metrikaGoal: number
  leadsTotal: number
}): Anomaly | null {
  if (input.metrikaGoal > input.leadsTotal) {
    return {
      severity: 'critical',
      kind: 'lead_reconcile_loss',
      text:
        `[СВЕРКА] конверсий по цели есть ${input.metrikaGoal}, а заявок в БД ${input.leadsTotal} — ` +
        `возможна потеря заявки. Директ ${input.reportConv} / Метрика ${input.metrikaGoal} / БД ${input.leadsTotal}. ` +
        `Проверьте чат «Заявки Будни» и логи intake.`,
    }
  }
  return null
}

/**
 * Катастрофа: неуправляемый расход — потрачено сегодня больше дневного
 * бюджета ×1.5, бюджетный предохранитель Директа прорван (баг/сбой).
 * Крайняя мера: suspendCampaignEmergency + написать владельцу (делает
 * вызывающий код, не этот модуль).
 */
export function isCatastrophe(input: { spentTodayRub: number; dailyBudgetRub: number }): boolean {
  return input.spentTodayRub > input.dailyBudgetRub * CATASTROPHE_BUDGET_FACTOR
}
