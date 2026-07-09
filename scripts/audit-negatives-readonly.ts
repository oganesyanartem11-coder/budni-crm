/**
 * АУДИТ (read-only): живой список минус-фраз кампании 711897777.
 * Только campaigns.get — ни одного write. Токен не печатаем.
 * Запуск: dotenv -e .env.local -- tsx scripts/audit-negatives-readonly.ts
 */
import { getCampaignSettings, getAdGroups } from '../src/lib/boris-direct/direct-client'

async function main() {
  const s = await getCampaignSettings()
  const items = s.NegativeKeywords?.Items ?? []
  console.log(`campaign NegativeKeywords: ${items.length} фраз`)
  console.log(`первые 5: ${items.slice(0, 5).join(' | ')}`)
  console.log(`последние 5: ${items.slice(-5).join(' | ')}`)
  const hasSotrudnik = items.filter((i) => i.toLowerCase().includes('сотрудник')).length
  console.log(`фраз с токеном «сотрудник»: ${hasSotrudnik}`)
  const groups = await getAdGroups()
  for (const g of groups) {
    console.log(`группа ${g.Id} «${g.Name}»: групповые минуса = ${g.NegativeKeywords ? g.NegativeKeywords.Items.length : 'null'}`)
  }
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exit(1)
})
