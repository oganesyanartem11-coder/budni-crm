'use client'

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
  originalSize: number
  compressedSize: number
}

export async function compressImage(
  file: File,
  opts: { maxDim?: number; quality?: number } = {},
): Promise<CompressedImage> {
  const maxDim = opts.maxDim ?? 1600
  const quality = opts.quality ?? 0.85

  // createImageBitmap нативно декодирует HEIC на Safari/iOS и большинстве браузеров.
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas.toBlob returned null'))),
      'image/jpeg',
      quality,
    )
  })

  return {
    blob,
    width,
    height,
    originalSize: file.size,
    compressedSize: blob.size,
  }
}
