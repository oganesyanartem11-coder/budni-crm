'use client'

interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

interface Line {
  id: string
  boundingBoxes: unknown // Json, может быть null или невалидный
}

interface Props {
  lines: Line[]
  imageWidth: number
  imageHeight: number
  hoveredLineId: string | null
}

function parseBox(raw: unknown): BoundingBox | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const x = obj.x,
    y = obj.y,
    w = obj.width,
    h = obj.height
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return null
  }
  return { x, y, width: w, height: h }
}

export function BboxOverlay({ lines, imageWidth, imageHeight, hoveredLineId }: Props) {
  // Относительные координаты 0-1 → абсолютные пиксели через viewBox.
  return (
    <svg
      viewBox={`0 0 1 1`}
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}
    >
      {lines.map((line) => {
        const box = parseBox(line.boundingBoxes)
        if (!box) return null
        const isHovered = hoveredLineId === line.id
        return (
          <rect
            key={line.id}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={isHovered ? 'rgba(220, 38, 38, 0.3)' : 'transparent'}
            stroke={isHovered ? 'rgb(220, 38, 38)' : 'transparent'}
            strokeWidth="0.005"
          />
        )
      })}
    </svg>
  )
}
