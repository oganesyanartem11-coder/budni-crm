import fs from 'node:fs'
import path from 'node:path'
import { recognizeMenu, type ImageMediaType } from '../src/lib/llm/menu-recognizer'

function detectMediaType(filePath: string): ImageMediaType {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  console.error(`Unsupported image extension: ${ext}. Use .jpg/.jpeg, .png, or .webp`)
  process.exit(1)
}

const imgPath = process.argv[2]
if (!imgPath) {
  console.error('Usage: npx tsx scripts/test-menu-recognizer.ts <path-to-menu-image>')
  process.exit(1)
}

const mediaType = detectMediaType(imgPath)
const imageBase64 = fs.readFileSync(imgPath).toString('base64')

const existingIngredients = [
  { id: '1', name: 'Картофель' },
  { id: '2', name: 'Говядина' },
  { id: '3', name: 'Свёкла' },
  { id: '4', name: 'Капуста' },
  { id: '5', name: 'Морковь' },
  { id: '6', name: 'Лук репчатый' },
  { id: '7', name: 'Рис' },
  { id: '8', name: 'Куриное филе' },
]

async function main() {
  const result = await recognizeMenu({
    imageBase64,
    imageMediaType: mediaType,
    existingIngredients,
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
