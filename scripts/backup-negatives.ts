/**
 * READ-ONLY страховочный снимок минус-списка кампании 711897777 ДО правок.
 * Только campaigns.get — ни одного write. Токен не печатаем.
 * Запуск: dotenv -e .env.local -- tsx scripts/backup-negatives.ts
 */
import { writeFileSync } from 'node:fs'
import { getCampaignSettings } from '../src/lib/boris-direct/direct-client'

async function main() {
  const s = await getCampaignSettings()
  const items = s.NegativeKeywords?.Items ?? []
  const path = 'backups/negatives-2026-07-08.txt'
  writeFileSync(path, items.join('\n') + (items.length ? '\n' : ''), 'utf8')
  console.log(`СНИМОК: ${path} — ${items.length} фраз`)
  if (items.length < 1000) console.log('[ВНИМАНИЕ] фраз заметно меньше 1178 — проверь!')
}
main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exit(1)
})
