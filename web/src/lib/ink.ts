// Geometry helpers for ink and lassos. Points are normalized to the image; the SVG viewBox is
// VB_W wide and VB_W / aspect tall, so scale by (VB_W, VB_W / aspect) to draw.
import { getStroke } from 'perfect-freehand'
import type { BBox, Point } from '../types'

export const VB_W = 1000

/** Filled outline path for an ink stroke (perfect-freehand). */
export function strokePath(points: Point[], width: number, sx: number, sy: number): string {
  if (points.length === 0) return ''
  const pts = points.map(([x, y, p]) => [x * sx, y * sy, p])
  const simulate = points.every((p) => p[2] === 0.5)
  const outline = getStroke(pts, {
    size: Math.max(1, width * sx),
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: simulate,
    last: true,
  })
  if (outline.length === 0) return ''
  const d: (string | number)[] = ['M', outline[0][0], outline[0][1], 'Q']
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % outline.length]
    d.push(round(x0), round(y0), round((x0 + x1) / 2), round((y0 + y1) / 2))
  }
  d.push('Z')
  return d.join(' ')
}

/** Closed polyline path for a lasso. */
export function lassoPath(points: Point[], sx: number, sy: number, close = true): string {
  if (points.length === 0) return ''
  const parts = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x * sx)} ${round(y * sy)}`)
  return parts.join(' ') + (close ? ' Z' : '')
}

export function bboxOf(points: Point[]): BBox {
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) }
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function round(v: number) {
  return Math.round(v * 10) / 10
}
