/**
 * Холодная загрузка каждого API-роута из прод-сборки (.next), по одному на процесс.
 *
 * Зачем: на Vercel роуты с одинаковым конфигом (напр. maxDuration=60) живут в
 * одной функции и делят кэш модулей. Если роут, загруженный ПЕРВЫМ, входит в
 * цикл импортов «не с той стороны», модуль падает с TDZ («Cannot access '…'
 * before initialization»), кэш отравлен — и 500 отдают все роуты функции.
 * Инцидент 2026-09-25: cron sales-reminders уронил вебхук MAX.
 * `next start` и vitest это не ловят (другой порядок/семантика циклов), а
 * require скомпилированного Turbopack-роута в чистом процессе — ловит.
 *
 * Запуск: npx next build && npm run check:cold-load
 * Ничего не шлёт и в БД не ходит: только загрузка модулей (PrismaClient без запросов).
 */
const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const apiDir = path.join(root, '.next/server/app/api')

if (!existsSync(apiDir)) {
  console.error('Нет .next/server/app/api — сначала `npx next build`.')
  process.exit(2)
}

function findRoutes(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...findRoutes(full))
    else if (name === 'route.js') out.push(full)
  }
  return out
}

// PrismaClient падает при конструировании без URL; соединения при загрузке нет,
// поэтому для CI без секретов хватает заглушки.
const placeholderDb = 'postgresql://user:pass@localhost:5432/cold_load_check'
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || placeholderDb,
  DIRECT_URL: process.env.DIRECT_URL || placeholderDb,
}

const loader = `
  try {
    require(process.argv[1])
  } catch (e) {
    console.error((e && e.stack) || String(e))
    process.exit(1)
  }
`

const failures = []
for (const file of findRoutes(apiDir)) {
  const route = '/api/' + path.relative(apiDir, path.dirname(file))
  try {
    execFileSync(process.execPath, ['-e', loader, file], { cwd: root, env, stdio: 'pipe' })
    console.log(`ok    ${route}`)
  } catch (e) {
    const stderr = String(e.stderr || '').split('\n').slice(0, 3).join('\n  ')
    console.log(`FAIL  ${route}\n  ${stderr}`)
    failures.push(route)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} роут(ов) не грузятся первыми: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nВсе API-роуты грузятся первыми без ошибок.')
