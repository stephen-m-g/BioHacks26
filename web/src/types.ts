// Hand-written types mirroring supabase/schema.sql (v2, no slides). Keep them in sync.
// Ink and annotation coordinates are normalized to the image they are drawn on.

export type UUID = string
export type Timestamp = string // ISO 8601

/** [x, y, pressure], x and y in [0,1] of the image width/height */
export type Point = [number, number, number]

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Lecture {
  id: UUID
  title: string
  archived_at: Timestamp | null
  created_at: Timestamp
}

export type AssetKind = 'image' | 'text' | 'pdf'

export interface Asset {
  id: UUID
  lecture_id: UUID
  kind: AssetKind
  storage_path: string | null
  text_content: string | null
  file_name: string | null
  label: string | null
  description: string | null
  key_terms: string[] | null
  created_at: Timestamp
}

export type SessionStatus = 'live' | 'ended'

export interface Session {
  id: UUID
  lecture_id: UUID
  status: SessionStatus
  started_at: Timestamp
  ended_at: Timestamp | null
}

export type BlockKind = 'text' | 'image'

export interface Block {
  id: UUID
  session_id: UUID
  kind: BlockKind
  position: number
  text: string | null
  asset_id: UUID | null
  /** image width / height */
  aspect: number | null
  created_at: Timestamp
}

export interface Stroke {
  id: UUID
  session_id: UUID
  block_id: UUID
  points: Point[]
  color: string
  /** fraction of image width */
  width: number
  created_at: Timestamp
}

export type AnnotationStatus = 'pending' | 'confirmed' | 'rejected'

export interface Annotation {
  id: UUID
  session_id: UUID
  block_id: UUID
  path: Point[]
  bbox: BBox
  status: AnnotationStatus
  drawn_at: Timestamp
  closed_at: Timestamp | null
  label: string | null
  bubble_text: string | null
}

export interface TranscriptSegment {
  id: UUID
  session_id: UUID
  t_start: Timestamp | null
  t_end: Timestamp | null
  raw_text: string
  confidence: number | null
  annotation_id: UUID | null
  /** null = not refined into a text block yet */
  text_block_id: UUID | null
  created_at: Timestamp
}

export interface NotesSection {
  id: string
  heading: string
  /** plain text; **bold** is allowed */
  paragraphs: string[]
  key_terms: { term: string; definition: string }[]
  figures: { image_block_id: UUID; caption: string }[]
  annotation_ids: UUID[]
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
  created_at: Timestamp
}
