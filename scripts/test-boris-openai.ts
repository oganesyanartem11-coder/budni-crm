/** Живой smoke-тест настоящего agent-loop и промпта Бориса на тестовых данных.
 * Никаких обращений к БД или Telegram; инструменты возвращают фикстуры.
 * OPENAI_API_KEY должен быть передан окружением.
 */
import { runAgentLoop, type AgentTool } from '../src/lib/llm/agent-loop'
import { getBorisModel } from '../src/lib/ai/models'
import { getBorisSystemPrompt } from '../src/lib/boris/personality'

async function main() {
  const model = getBorisModel()
  if (model !== 'gpt-6-luna') throw new Error('Smoke test requires gpt-6-luna')
  const readTool: AgentTool = {
    name: 'get_orders_for_date', description: 'Получить все заказы на дату.',
    input_schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
    execute: async (input) => {
      if ((input as { date?: string }).date !== '2026-11-03') throw new Error('Unexpected date')
      return { date: '2026-11-03', clients: [{ clientId: 'test-client', clientName: 'Тестовый офис',
        orders: [{ orderId: 'test-order', location: 'Офис', mealType: 'Обед', mealTypeCode: 'LUNCH',
          portions: '731', portionsNumber: 731, status: 'Подтверждён', statusCode: 'CONFIRMED' }] }],
      totalOrders: 1, truncated: false }
    },
  }
  const read = await runAgentLoop({
    model, systemPrompt: getBorisSystemPrompt({ canMutate: false, chatType: 'group', isAdminPro: false }),
    initialMessages: [{ role: 'user', content: 'Сколько обедов 03.11.2026? Проверь заказы инструментом.' }],
    tools: [readTool], maxIterations: 4, maxTokens: 1000,
  })
  if (read.stopReason !== 'end_turn' || !read.finalText.includes('731')
    || !read.toolCalls.some((call) => call.name === 'get_orders_for_date')) throw new Error('Read test failed')
  console.log(JSON.stringify({ test: 'boris-read-tool-and-reply', ok: true, model,
    iterations: read.iterations, reply: read.finalText }))

  let readDone = false
  const updatedAt = '2026-11-02T10:00:00.000Z'
  const find: AgentTool = {
    name: 'find_orders', description: 'Найти актуальные заказы клиента, обязательно перед изменением.',
    input_schema: { type: 'object', properties: { clientNameQuery: { type: 'string' }, date: { type: 'string' },
      mealType: { type: 'string', enum: ['BREAKFAST', 'LUNCH', 'DINNER'] } }, required: ['clientNameQuery'] },
    execute: async () => {
      readDone = true
      return { items: [{ orderId: 'test-order', client: { id: 'test-client', name: 'Тестовый офис' },
        location: { id: 'test-office', name: 'Офис' }, mealType: 'Обед', deliveryDateIso: '2026-11-03',
        portions: '30', portionsNumber: 30, updatedAt, statusCode: 'CONFIRMED' }], truncated: false }
    },
  }
  const pending: AgentTool = {
    name: 'edit_order_portions',
    description: 'Запланировать изменение количества. portions — итоговое число. Сначала find_orders. Возвращает pending, требует подтверждения.',
    input_schema: { type: 'object', properties: { orderId: { type: 'string' }, portions: { type: 'integer', minimum: 0 },
      expectedUpdatedAt: { type: 'string' } }, required: ['orderId', 'portions'] },
    execute: async (input) => {
      const data = input as { orderId?: string; portions?: number; expectedUpdatedAt?: string }
      if (!readDone || data.orderId !== 'test-order' || data.portions !== 50) throw new Error('Invalid pending change')
      return { pending: true, action: { tool: 'edit_order_portions', input: data }, preview: 'Тестовый офис: 30 → 50 обедов. Требуется подтверждение.' }
    },
  }
  const change = await runAgentLoop({
    model, systemPrompt: getBorisSystemPrompt({ canMutate: true, chatType: 'private', isAdminPro: true }),
    initialMessages: [{ role: 'user', content: 'Для клиента «Тестовый офис» на 03.11.2026 измени итоговое количество обедов на 50.' }],
    tools: [find, pending], maxIterations: 6, maxTokens: 1500,
  })
  if (change.stopReason !== 'end_turn' || !change.finalText
    || !change.toolCalls.some((call) => call.name === 'edit_order_portions'
      && (call.result as { pending?: boolean }).pending === true)) throw new Error('Pending change test failed')
  console.log(JSON.stringify({ test: 'boris-pending-change', ok: true, model,
    iterations: change.iterations, reply: change.finalText }))
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Boris smoke test failed'); process.exitCode = 1 })
