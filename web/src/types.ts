// Hand-written types mirroring supabase/schema.sql. Keep them in sync.
// Every x, y, w, h and stroke width is normalized to [0,1] of the 16:9 slide.

export type UUID = string
export type Timestamp = string // ISO 8601

/** [x, y, pressure] */
export type StrokePoint = [number, number, number]

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Lecture {
  id: UUID
  title: string
  scheduled_for: string | null
  created_at: Timestamp
}

export type AssetKind = 'image' | 'text'

export interface Asset {
  id: UUID
  lecture_id: UUID
  kind: AssetKind
  storage_path: string | null
  text_content: string | null
  label: string | null
  description: string | null
  key_terms: string[] | null
  created_at: Timestamp
}

export interface Slide {
  id: UUID
  lecture_id: UUID
  idx: number
  background_asset_id: UUID | null
}

export type SessionStatus = 'live' | 'ended'

export interface Session {
  id: UUID
  lecture_id: UUID
  join_code: string
  status: SessionStatus
  current_slide_id: UUID | null
  started_at: Timestamp
  ended_at: Timestamp | null
}

export interface Stroke {
  id: UUID
  session_id: UUID
  slide_id: UUID
  points: StrokePoint[]
  color: string
  width: number
  created_at: Timestamp
}

export interface PlacedImage {
  id: UUID
  session_id: UUID
  slide_id: UUID
  asset_id: UUID
  x: number
  y: number
  w: number
  h: number
  created_at: Timestamp
}

export type AnnotationKind = 'circle' | 'image'
export type AnnotationStatus = 'pending' | 'confirmed' | 'rejected'

export interface Annotation {
  id: UUID
  session_id: UUID
  slide_id: UUID
  kind: AnnotationKind
  path: StrokePoint[] | null
  bbox: BBox | null
  placed_image_id: UUID | null
  status: AnnotationStatus
  drawn_at: Timestamp
  closed_at: Timestamp | null
  label: string | null
  bubble_text: string | null
}

export interface TranscriptSegment {
  id: UUID
  session_id: UUID
  slide_id: UUID | null
  t_start: Timestamp | null
  t_end: Timestamp | null
  raw_text: string
  clean_text: string | null
  confidence: number | null
  annotation_id: UUID | null
  created_at: Timestamp
}

export type NotesStatus = 'draft' | 'published'

export interface NotesSection {
  slide_index: number
  heading: string
  bullets: string[]
  key_terms: { term: string; definition: string }[]
  figures: { annotation_id?: UUID; asset_id?: UUID; caption: string }[]
}

export interface NotesContent {
  title: string
  overview: string
  sections: NotesSection[]
  review_questions: string[]
}

export interface LectureNotes {
  session_id: UUID
  content: NotesContent | null
  status: NotesStatus
  created_at: Timestamp
}
