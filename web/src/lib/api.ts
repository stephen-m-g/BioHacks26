// Thin fetch wrapper for the FastAPI backend (P2). Never put the Gemini key in the frontend.
import type { Asset, Block, NotesContent } from '../types'

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** FastAPI's `detail` string, when the server sent one (written for the teacher). */
    readonly detail: string | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function detailOf(body: string): string | null {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail
    return typeof detail === 'string' ? detail : null
  } catch {
    return null
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(`POST ${path} failed: ${res.status} ${text}`, res.status, detailOf(text))
  }
  return res.json() as Promise<T>
}

/** A message to show the teacher for a failed API call. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.detail ?? fallback
  return navigator.onLine === false ? 'You’re offline.' : `${fallback} The server couldn’t be reached.`
}

export const api = {
  health: async () => (await fetch(`${API_URL}/health`)).json() as Promise<{ ok: boolean }>,
  describeAsset: (assetId: string) =>
    post<{ label: string; description: string; key_terms: string[] }>(`/assets/${assetId}/describe`),
  /** Render a PDF's pages to page-image assets (once; later calls return the same pages). */
  renderPdfPages: (assetId: string) => post<{ page_count: number; pages: Asset[] }>(`/assets/${assetId}/pages`),
  /** Batch-clean unrefined speech into one text block: appended to the board, or under its PDF page. */
  refineSession: (sessionId: string) =>
    post<{ block: Block | null; segment_ids: string[]; moved_blocks?: Block[] }>(`/sessions/${sessionId}/refine`),
  closeAnnotation: (annotationId: string, cropPngBase64?: string) =>
    post<{ label: string | null; bubble_text: string | null }>(`/annotations/${annotationId}/close`, {
      crop_png_base64: cropPngBase64,
    }),
  compileSession: (sessionId: string) => post<NotesContent>(`/sessions/${sessionId}/compile`),
  /** Single-use ElevenLabs Scribe Realtime token; the API key stays on the server. */
  scribeToken: (sessionId: string) => post<{ token: string }>(`/sessions/${sessionId}/scribe-token`),
}
