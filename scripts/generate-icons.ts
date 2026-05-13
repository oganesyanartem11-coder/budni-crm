import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const V2_PATH = resolve('public/branding/logo-v2.png')
const PNG_PATH = resolve('public/branding/logo-source.png')
const JPG_PATH = resolve('public/branding/logo-source.jpg')

// Приоритет: logo-v2.png (актуальный лого), затем legacy logo-source.png/.jpg
// (оставлены на случай отката).
const SOURCE_PATH = existsSync(V2_PATH)
  ? V2_PATH
  : existsSync(PNG_PATH)
    ? PNG_PATH
    : JPG_PATH

const ICON_PNG = resolve('src/app/icon.png')
const APPLE_ICON_PNG = resolve('src/app/apple-icon.png')
const FAVICON_ICO = resolve('src/app/favicon.ico')

// Inset 8% по краям убирает кремовое поле и золотую рамку logo-v2.png
// перед resize. На iOS Home Screen иначе получается «двойной бордер»:
// iOS округляет квадратную плитку поверх лого, который сам по себе уже
// с закруглённой золотой рамкой и кремовым отступом — между ними остаётся
// видимая белая полоса.
const INSET_PCT = 0.08

async function fitSquare(srcMeta: sharp.Metadata, size: number): Promise<Buffer> {
  const w = srcMeta.width!
  const h = srcMeta.height!
  const insetX = Math.round(w * INSET_PCT)
  const insetY = Math.round(h * INSET_PCT)
  return sharp(SOURCE_PATH)
    .extract({ left: insetX, top: insetY, width: w - insetX * 2, height: h - insetY * 2 })
    .resize(size, size, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer()
}

async function main() {
  if (!existsSync(SOURCE_PATH)) {
    throw new Error(`source image not found at ${SOURCE_PATH}`)
  }
  console.log(`source: ${SOURCE_PATH}`)
  const srcMeta = await sharp(SOURCE_PATH).metadata()
  console.log(`source meta: ${srcMeta.width}x${srcMeta.height}, format=${srcMeta.format}, inset=${INSET_PCT * 100}%`)

  const icon32 = await fitSquare(srcMeta, 32)
  await writeFile(ICON_PNG, icon32)
  console.log(`wrote ${ICON_PNG} (${icon32.length} bytes)`)

  const apple180 = await fitSquare(srcMeta, 180)
  await writeFile(APPLE_ICON_PNG, apple180)
  console.log(`wrote ${APPLE_ICON_PNG} (${apple180.length} bytes)`)

  // favicon.ico — multi-size 16/32/48
  const sizes = [16, 32, 48]
  const pngBuffers: Buffer[] = []
  for (const size of sizes) {
    pngBuffers.push(await fitSquare(srcMeta, size))
  }
  const icoBuf = await pngToIco(pngBuffers)
  await writeFile(FAVICON_ICO, icoBuf)
  console.log(`wrote ${FAVICON_ICO} (${icoBuf.length} bytes, sizes: ${sizes.join('/')})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
