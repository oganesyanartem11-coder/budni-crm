import * as XLSX from 'xlsx'

export interface ExtractedSheet {
  sheetName: string
  rows: string[][]
}

// Тупой дамп ячеек .xlsx в string[][] по каждому листу. Никакой структурной
// логики (где неделя/день/обед/ужин) — это задача LLM-разборщика дальше по
// конвейеру. Здесь только цель: получить весь текст листа в виде матрицы.
export function extractXlsxText(buffer: Buffer): ExtractedSheet[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' })

  return workbook.SheetNames.map((sheetName) => {
    const ws = workbook.Sheets[sheetName]
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: '',
    })
    const rows: string[][] = aoa.map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
    )
    return { sheetName, rows }
  })
}

// Плоский читаемый текст для LLM. Формат:
//   === Лист: <name> ===
//   <cell> | <cell> | <cell>
//   <cell> | <cell> | <cell>
// Пустые ячейки сохраняются (важно для понимания "промежутков" блоками).
export function extractedToText(sheets: ExtractedSheet[]): string {
  return sheets
    .map((s) => {
      const header = `=== Лист: ${s.sheetName} ===`
      const body = s.rows.map((row) => row.join(' | ')).join('\n')
      return `${header}\n${body}`
    })
    .join('\n\n')
}
