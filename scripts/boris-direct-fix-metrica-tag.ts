/**
 * ШАГ 1 — ЕДИНСТВЕННЫЙ одобренный владельцем ручной write: восстановить
 * ADD_METRICA_TAG=YES на кампании 711897777 (сейчас реально NO — подтверждено
 * сырым campaigns.get). Атрибуция заявок Метрикой без yclid-разметки сломана.
 *
 * Использует САНКЦИОНИРОВАННУЮ структуру restoreMetricaTag() из транспорта
 * (та же, что применял бы write-gate). Guard: пишем ТОЛЬКО если сейчас NO;
 * после апдейта — повторный get и подтверждение YES. Токены не печатаются.
 *
 * Запуск: dotenv -e .env.local -- tsx scripts/boris-direct-fix-metrica-tag.ts
 */

import {
  getCampaignState,
  getAddMetricaTagValue,
  restoreMetricaTag,
  extractWriteIssues,
} from '../src/lib/boris-direct/direct-client'

async function main(): Promise<void> {
  console.log('ШАГ 1 — восстановление ADD_METRICA_TAG на кампании 711897777')

  const before = getAddMetricaTagValue(await getCampaignState())
  console.log('ДО апдейта, ADD_METRICA_TAG =', before)

  if (before === 'YES') {
    console.log('Уже YES — write НЕ нужен, выходим (ни одного пишущего запроса).')
    return
  }

  console.log('Значение NO → выполняю campaigns.update Settings [{ADD_METRICA_TAG: YES}] …')
  const result = await restoreMetricaTag()
  const issues = extractWriteIssues(result)
  console.log('Ответ update — errors:', JSON.stringify(issues.errors))
  console.log('Ответ update — warnings:', JSON.stringify(issues.warnings))
  if (issues.errors.length > 0) {
    console.log('❌ Апдейт вернул ошибки — тег НЕ подтверждён. Останавливаюсь.')
    process.exitCode = 1
    return
  }

  const after = getAddMetricaTagValue(await getCampaignState())
  console.log('ПОСЛЕ апдейта, ADD_METRICA_TAG =', after)
  console.log(after === 'YES' ? '✅ Тег восстановлен: YES.' : '⚠️ Всё ещё не YES — нужен разбор.')
  if (after !== 'YES') process.exitCode = 1
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
