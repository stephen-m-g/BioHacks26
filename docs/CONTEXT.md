# Shared context (v2: scrolling study document, teacher-only)

This replaces the slide-based parts of the original shared context. Patient facts, UI rules, stack, deploy and checkpoints are unchanged. What changed:
- **No slides.** The live board is one long scrolling document, and the end product is an interactive study document, not a PDF.
- **Teacher-only for now.** The board is projected for the class; the study documents live on the site. No student join, student view, join codes or publish step. These may come back later with auth and roles.

## Patient (unchanged, short)
Alex Chen, 47, senior high-school biology teacher with ALS. Handwriting is illegible after ~10 min. Right key pinch is 3 kg and he can't hold it for more than a few seconds (left hand is stronger now). Speech drops from 165 wpm / 98% intelligible at 9 am to 118 wpm / 91% at 4 pm.
**UI rules:** tap targets at least 64px; no pinch, long-press or double-tap; works left-handed; few taps per action; tolerant of imprecise input.

## Screens
| Route | Screen |
|---|---|
| `/` | **Dashboard.** *Prepared lectures* (not archived): New, Start, Edit, Archive, plus a link to *All lectures*. *Past sessions*: View notes, View raw, Delete (confirm). A still-live session shows Resume. |
| `/lectures` | **All lectures**, including archived: Edit, Archive/Restore, Delete. Deleting a lecture also deletes its past sessions; the confirm dialog says so. |
| `/prep/:lectureId` | **Prep**, chat-style. He uploads images, PDFs and .txt files, or types/pastes text. Each item gets an AI acknowledgement (label, description, key terms from `/describe`). Images go to the image bank for the live session; text and PDFs become session context. Editable title and a Start session button. |
| `/teach/:sessionId` | **Live session** (below). Projected for the class. `/teach/demo` runs fully offline with sample data, so the UI can be tested without Supabase. |
| `/notes/:sessionId` | **Study document** (processed notes). Shows "compiling…" until the notes land, plus Recompile and Print/PDF buttons. |
| `/sessions/:sessionId/raw` | **Raw view.** The board as it ended (read-only), plus the timestamped transcript. |

A prepared lecture can be launched any number of times; each launch is a new session. Archiving only hides it from the dashboard.

## Live session
- **Canvas:** a vertical document. Speech is transcribed live; unprocessed text shows in grey italics at the bottom. About every 15 s the teacher client calls `POST /sessions/{id}/refine`, which cleans the unprocessed segments into one **text block** (a paragraph) appended to the board.
- **Images** are blocks too. To place one: drag a thumbnail from the sidebar onto a drop slot between blocks, **or** tap a thumbnail and then tap a slot.
- **Ink and lassos are only allowed on images**, stored in coordinates normalized to that image (x, y in [0,1] of the image's width/height; stroke width as a fraction of image width).
- **Sidebar** (left by default; a setting moves it right). From top to bottom:
  - session title with a dropdown: **Rename session** (inline edit; double-click on the title also works for mouse users, but double-tap is never required) and **End session**;
  - **mode toggle: Ink / Smart**;
  - ink presets: 4 colors × 3 widths, plus Undo;
  - image bank;
  - a small button at the bottom to move the sidebar to the other side.
- **Pencil auto-detect:** fingers draw on images until an Apple Pencil touches one; from then on (for that page load) only the pencil draws and fingers scroll, which stops palm marks. There is no toggle.
  - **End session** (confirm dialog).
- **Smart annotation** (lasso): drawing a loop on an image in Smart mode creates a `pending` annotation. While it's pending:
  - the outline has an animated **shimmer**;
  - final speech segments are tagged with its `annotation_id`;
  - big ✓ and ✗ buttons sit next to it;
  - **no new lasso and no image insertion** until he presses ✓ or ✗ (ink is still allowed).
  - ✓ calls `POST /annotations/{id}/close`. Gemini decides which sentences belong to it, using the time window (5 s before `drawn_at` until `closed_at`) and the tagged segments as guides. ✗ sets `rejected` and un-tags the segments.
- **End session:** confirm any pending annotation, run a final refine, set `status='ended'`, start `POST /sessions/{id}/compile` without waiting for it, then open `/notes/:id`, which shows "compiling…" until the notes arrive over realtime.

## Database (`supabase/schema.sql`, RLS off)
- `lectures(id, title, archived_at, created_at)`
- `assets(id, lecture_id, kind 'image'|'text'|'pdf', storage_path, text_content, file_name, label, description, key_terms[], created_at)`
- `sessions(id, lecture_id → lectures on delete cascade, title, status 'live'|'ended', started_at, ended_at)`. `title` starts as the lecture title and can be renamed per session.
- `blocks(id, session_id, kind 'text'|'image', position float, text, asset_id, aspect, created_at)`. The board is the blocks sorted by `position`; an image inserted between two blocks gets the midpoint position. `aspect` = image width/height.
- `strokes(id, session_id, block_id, points [[x,y,pressure]], color, width, created_at)`
- `annotations(id, session_id, block_id, path [[x,y,p]], bbox {x,y,w,h}, status 'pending'|'confirmed'|'rejected', drawn_at, closed_at, label, bubble_text)`
- `transcript_segments(id, session_id, t_start, t_end, raw_text, confidence, annotation_id, text_block_id, created_at)`. `text_block_id` null means not refined yet.
- `lecture_notes(session_id, content jsonb, created_at)`
- Realtime: sessions, blocks, strokes, annotations, transcript_segments, lecture_notes. Storage: public bucket `assets`, path `{lectureId}/{assetId}.{ext}`.

## API contract (FastAPI, P2)
- `GET /health`
- `POST /assets/{id}/describe` → `{label, description, key_terms}`. Image: send the image. PDF: send the PDF as a document part. Text: send `text_content`.
- `POST /sessions/{id}/refine` → `{block, segment_ids}`. Takes the session's segments where `text_block_id is null`, cleans them into one paragraph (vocabulary = the lecture's asset `key_terms`, context = the previous text block), inserts a text block at `max(position)+1`, and sets `text_block_id` on those segments. Falls back to the joined raw text if Gemini fails. **Already implemented.**
- `POST /annotations/{id}/close` body `{crop_png_base64?}` → `{label, bubble_text}`. Sets `confirmed`/`closed_at`, picks his words about the selection, writes `label`/`bubble_text`, and sets `annotation_id` on the segments it used.
- `POST /sessions/{id}/compile` → notes JSON; upserts `lecture_notes`.
- `POST /segments/{id}/clean` is **removed** (replaced by batch refine).

## Notes JSON (compile output)
```json
{
  "title": "...", "overview": "...",
  "sections": [{
    "id": "s1", "heading": "...",
    "paragraphs": ["... **bold** allowed ..."],
    "key_terms": [{"term": "...", "definition": "..."}],
    "figures": [{"image_block_id": "uuid", "caption": "..."}],
    "annotation_ids": ["uuid"]
  }],
  "review_questions": ["..."]
}
```
Figures render the image with its confirmed annotations. Hovering an annotation shows `label` + `bubble_text`. Clicking it (tapping, then "Go to section", on touch) scrolls to the section whose `annotation_ids` contains it.

## Ownership after the redesign
- **P1** (canvas): `components/ImageBlock.tsx` (ink, lasso, shimmer, ✓/✗, popovers), `components/Board.tsx`, `pages/Teach.tsx`, `components/Sidebar.tsx`.
- **P2** (AI): `/describe` (+PDF), `/close`, `/compile` with notes v2; `/refine` is done but needs tuning.
- **P3** (speech): `hooks/useTranscription.ts` (a basic Web Speech version exists; harden it or swap in Deepgram), metrics, adaptive volume.
- **P4** (platform): `pages/Dashboard.tsx`, `AllLectures.tsx`, `Prep.tsx`, `Notes.tsx`, `RawSession.tsx`; run the new `schema.sql`; deploy; pitch.

## Not built yet / open
- `/describe` (incl. PDF), `/close` and `/compile` are still stubs, so prep acknowledgements say just "Saved." and the notes come back empty.
- Nothing has been tested against a real Supabase project (no keys yet), and nothing has been tested on an iPad.
- The crop image for `/close` isn't sent yet. The backend can crop the asset image to `bbox` itself.
- Adaptive volume and speech metrics (P3) aren't started.
