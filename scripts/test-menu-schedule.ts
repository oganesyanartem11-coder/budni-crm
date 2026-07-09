import fs from 'node:fs'
import { extractXlsxText, extractedToText } from '../src/lib/excel/menu-extractor'
import { parseMenuSchedule } from '../src/lib/llm/menu-schedule-parser'

async function main() {
  const buf = fs.readFileSync('test-data/menu.xlsx')

  const sheets = extractXlsxText(buf)
  const text = extractedToText(sheets)

  console.log('=== СЫРОЙ ТЕКСТ ИЗ EXCEL ===')
  console.log(text)
  console.log()
  console.log('=== РАЗБОР OPUS ===')

  const result = await parseMenuSchedule(text)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
