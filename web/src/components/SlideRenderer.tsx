// P1 owns this component. P4 reuses it read-only on the student view.
// Renders a 16:9 Konva stage fit to its container and converts normalized coords to pixels.
import { useEffect, useRef, useState } from 'react'
import { Layer, Rect, Stage } from 'react-konva'
import type { Annotation, PlacedImage, Slide, Stroke } from '../types'

export interface SlideRendererProps {
  slide: Slide | null
  strokes: Stroke[]
  placedImages: PlacedImage[]
  annotations: Annotation[]
  readOnly: boolean
  onAnnotationTap?: (annotation: Annotation) => void
}

const ASPECT = 16 / 9

export default function SlideRenderer(_props: SlideRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      const w = Math.min(width, height * ASPECT)
      setSize({ width: w, height: w / ASPECT })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {size.width > 0 && (
        <Stage width={size.width} height={size.height}>
          <Layer>
            <Rect width={size.width} height={size.height} fill="white" stroke="#ddd" />
            {/* TODO (P1): background image, ink strokes, placed images, annotations */}
          </Layer>
        </Stage>
      )}
    </div>
  )
}
