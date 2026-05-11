import { parseClientResponse } from '../src/lib/llm/parser'
import { detectAnomalies } from '../src/lib/orders/anomaly-detector'

const fakeLocations = [
  { id: 'loc_1', name: 'Цех №1', aliases: ['цех', 'первый', 'производство'] },
  { id: 'loc_2', name: 'Склад', aliases: ['склад', 'второй'] },
]

const fakeRecentOrders = [
  { date: '2026-05-04', locationName: 'Цех №1', portions: 50 },
  { date: '2026-05-04', locationName: 'Склад', portions: 30 },
  { date: '2026-05-05', locationName: 'Цех №1', portions: 48 },
  { date: '2026-05-05', locationName: 'Склад', portions: 32 },
  { date: '2026-05-06', locationName: 'Цех №1', portions: 52 },
]

const fakeStats = {
  averageByDayOfWeek: 50,
  sampleSize: 5,
  recentOrders: fakeRecentOrders.map((o) => ({ ...o, date: new Date(o.date) })),
  typicalRange: { min: 30, max: 55 },
}

const testCases = [
  '50',
  'цех 50 склад 30',
  '50 на цех и 30 на склад',
  'первый — 50, второй — 30',
  '5',
  '777',
  '500',
  'у нас завтра праздник, заказа не будет',
  'привет, как вы',
  'СКОЛЬКО МОЖНО ЖДАТЬ',
  'спасибо за вчерашний обед!',
  'сколько стоит обед?',
]

async function main() {
  for (const text of testCases) {
    console.log('\n' + '='.repeat(60))
    console.log(`INPUT: "${text}"`)
    try {
      const parsed = await parseClientResponse({
        clientText: text,
        clientName: 'Завод Ромашка',
        mealTypeRu: 'обед',
        locations: fakeLocations,
        recentOrders: fakeRecentOrders,
      })
      console.log(
        'PARSED:',
        JSON.stringify(
          {
            type: parsed.type,
            items: parsed.items,
            confidence: parsed.confidence,
            reason: parsed.reason,
            tone: parsed.toneLabel,
          },
          null,
          2
        )
      )

      const anomaly = detectAnomalies({
        parsed,
        stats: fakeStats,
        isNewClient: false,
        isPastCutoff: false,
      })
      console.log(
        'ANOMALY:',
        anomaly.isAnomaly
          ? `YES — ${anomaly.reason} (${anomaly.priority})\n  ${anomaly.humanReason}`
          : 'NO'
      )
    } catch (e) {
      console.error('ERROR:', e)
    }
  }
}

main().catch(console.error)
