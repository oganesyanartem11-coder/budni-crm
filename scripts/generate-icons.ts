import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const PNG_PATH = resolve('public/branding/logo-source.png')
const JPG_PATH = resolve('public/branding/logo-source.jpg')

const SOURCE_PATH = existsSync(PNG_PATH) ? PNG_PATH : JPG_PATH

const ICON_PNG = resolve('src/app/icon.png')
const APPLE_ICON_PNG = resolve('src/app/apple-icon.png')
const FAVICON_ICO = resolve('src/app/favicon.ico')

async function centerSquare(input: string) {
  const meta = await sharp(input).metadata()
  if (!meta.width || !meta.height) throw new Error('source has no dimensions')
  const side = Math.min(meta.width, meta.height)
  const left = Math.floor((meta.width - side) / 2)
  const top = Math.floor((meta.height - side) / 2)
  return sharp(input).extract({ left, top, width: side, height: side })
}

async function main() {
  if (!existsSync(SOURCE_PATH)) {
    throw new Error(`source image not found at ${SOURCE_PATH}`)
  }
  console.log(`source: ${SOURCE_PATH}`)
  const srcMeta = await sharp(SOURCE_PATH).metadata()
  console.log(`source meta: ${srcMeta.width}x${srcMeta.height}, format=${srcMeta.format}`)

  // 32x32 icon.png
  const icon32 = await (await centerSquare(SOURCE_PATH)).resize(32, 32).png().toBuffer()
  await writeFile(ICON_PNG, icon32)
  console.log(`wrote ${ICON_PNG} (${icon32.length} bytes)`)

  // 180x180 apple-icon.png
  const apple180 = await (await centerSquare(SOURCE_PATH)).resize(180, 180).png().toBuffer()
  await writeFile(APPLE_ICON_PNG, apple180)
  console.log(`wrote ${APPLE_ICON_PNG} (${apple180.length} bytes)`)

  // favicon.ico — multi-size 16/32/48
  const sizes = [16, 32, 48]
  const pngBuffers: Buffer[] = []
  for (const size of sizes) {
    const buf = await (await centerSquare(SOURCE_PATH)).resize(size, size).png().toBuffer()
    pngBuffers.push(buf)
  }
  const icoBuf = await pngToIco(pngBuffers)
  await writeFile(FAVICON_ICO, icoBuf)
  console.log(`wrote ${FAVICON_ICO} (${icoBuf.length} bytes, sizes: ${sizes.join('/')})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
