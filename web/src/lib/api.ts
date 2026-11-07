// Thin fetch wrapper for the FastAPI backend (P2). Never put the Gemini key in the frontend.
import type { NotesContent } from '../types'

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export const api = {
  health: async () => (await fetch(`${API_URL}/health`)).json() as Promise<{ ok: boolean }>,
  describeAsset: (assetId: string) =>
    post<{ label: string; description: string; key_terms: string[] }>(`/assets/${assetId}/describe`),
  cleanSegment: (segmentId: string) => post<{ clean_text: string }>(`/segments/${segmentId}/clean`),
  closeAnnotation: (annotationId: string, cropPngBase64?: string) =>
    post<{ label: string | null; bubble_text: string | null }>(`/annotations/${annotationId}/close`, {
      crop_png_base64: cropPngBase64,
    }),
  compileSession: (sessionId: string) => post<NotesContent>(`/sessions/${sessionId}/compile`),
}
