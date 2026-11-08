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
| `/` | **Dashboard**, bento layout that fits one screen (no page scroll). Row 1: aside logo, **New lecture**. Row 2: class filter (All + multi-select class chips; selecting every class or none returns to All; a lecture/session shows if it's in any selected class; **+** adds or edits classes). Grid: top left **Ready to present** (count next to the title, arrow to `/lectures`; list scrolls in its card: Start, Edit, ⋯ Classes…/Archive/Delete); bottom left **Archive** (link card to `/archive`); right **Recorded sessions** (list, scrolls in its card: Notes or Resume, ⋯ Transcript/Classes…/Delete). Portrait iPad stacks the cards; phones and very short windows let the page scroll. |
| `/lectures` | **Lectures**: active lectures only (Start, Edit, ⋯ Archive/Delete). Opened from the arrow on the dashboard's Ready to present card. |
| `/archive` | **Archive**: archived lectures only (Edit, ⋯ Restore/Delete permanently). Opened from the dashboard's Archive card. Deleting a lecture also deletes its past sessions; the confirm dialog says so. |
| `/prep/:lectureId` | **Prep**, chat-style. A **Classes** row toggles which classes the lecture is in (applied on Save, undone by ← Lectures; "New class" creates one immediately). He uploads images, PDFs and .txt files, or types/pastes text. Each item gets an AI acknowledgement (label, description, key terms from `/describe`). Images go to the image bank for the live session; text and PDFs become session context. Editable title. **Save** applies the title and removals and returns to the dashboard (it does not start a session). **← Dashboard** leaves without saving: uploads from this visit are deleted again, removed items come back, and a brand-new lecture (opened with `?new=1`) is deleted entirely. It asks to confirm only if something would be lost. |
| `/teach/:sessionId` | **Live session** (below). Projected for the class. |
| `/notes/:sessionId` | **Study document** (processed notes). Shows "compiling…" until the notes land, plus Recompile and Print/PDF buttons. |
| `/sessions/:sessionId/raw` | **Raw view.** The board as it ended (read-only), plus the timestamped transcript. Not linked from anywhere for now. |

A prepared lecture can be launched any number of times; each launch is a new session. Archiving only hides it from the dashboard.

## Live session
- **Canvas:** a vertical document. Speech is transcribed live; unprocessed text shows in grey italics at the bottom. About every 15 s the teacher client calls `POST /sessions/{id}/refine`, which cleans the unprocessed segments into one **text block** (a paragraph) appended to the board.
- **Auto-scroll:** the board follows new text only when he's near the bottom, no lasso is open, and he hasn't touched the board (drawing, placing an image, scrolling) in the last 20 s, so it never scrolls away from a diagram he's working on.
- **Images** are blocks too. To place one: drag a thumbnail from the sidebar onto a drop slot between blocks, **or** tap a thumbnail and then tap a slot.
- **Ink and lassos are only allowed on images**, stored in coordinates normalized to that image (x, y in [0,1] of the image's width/height; stroke width as a fraction of image width).
- **Sidebar** (left by default; a button at the bottom moves it right; its contents stay left-aligned on either side). From top to bottom:
  - session title: tap opens a dropdown with **Start/Pause recording** and **End session**; double-click renames it inline (Enter saves, Esc cancels);
  - **mode toggle: Ink / Smart**;
  - ink presets: 4 colors × 3 widths, plus Undo;
  - image bank;
  - bottom row: a small button to move the sidebar to the other side, and the session clock with a recording dot (red pulse while listening; shows Mic off / Speech error).
- **The mic starts off** whenever a session opens (new, resumed or reloaded); a red "Mic off" notice sits under the title until he picks Start recording. Nothing asks for mic permission or mints an ElevenLabs token before that. While it's on, dropped connections reconnect automatically; after he pauses it, nothing restarts it.
- **Pencil auto-detect:** fingers draw on images until an Apple Pencil touches one; from then on (for that page load) only the pencil draws and fingers scroll, which stops palm marks. There is no toggle.
  - **End session** (confirm dialog).
- **Smart annotation** (lasso): drawing a loop on an image in Smart mode creates a `pending` annotation. While it's pending:
  - the outline has an animated **shimmer**;
  - the completed loop records `drawn_at`; word-timestamped speech after it is tagged with its `annotation_id`;
  - big ✓ and ✗ buttons sit next to it;
  - **no new lasso and no image insertion** until he presses ✓ or ✗ (ink is still allowed).
  - ✓ records `closed_at`, flushes in-flight Scribe audio, then calls `POST /annotations/{id}/close`. Speech association is deterministic from word occurrence time in `[drawn_at, closed_at)`; Gemini only cleans the already-associated words. ✗ sets `rejected` and un-tags the segments.
- **End session:** confirm any pending annotation, run a final refine, set `status='ended'`, start `POST /sessions/{id}/compile` without waiting for it, then open `/notes/:id`, which shows "compiling…" until the notes arrive over realtime.

## Database (`supabase/schema.sql`, RLS off)
- `lectures(id, title, archived_at, created_at)`
- `assets(id, lecture_id, kind 'image'|'text'|'pdf', storage_path, text_content, file_name, label, description, key_terms[], created_at)`
- `sessions(id, lecture_id → lectures on delete cascade, title, status 'live'|'ended', started_at, ended_at)`. `title` starts as the lecture title and can be renamed per session.
- `blocks(id, session_id, kind 'text'|'image', position float, text, asset_id, aspect, created_at)`. The board is the blocks sorted by `position`; an image inserted between two blocks gets the midpoint position. `aspect` = image width/height.
- `strokes(id, session_id, block_id, points [[x,y,pressure]], color, width, created_at)`
- `annotations(id, session_id, block_id, path [[x,y,p]], bbox {x,y,w,h}, status 'pending'|'confirmed'|'rejected', drawn_at, closed_at, label, bubble_text)`
- `transcript_segments(id, session_id, t_start, t_end, raw_text, confidence, annotation_id, text_block_id, text_start, text_end, created_at)`. `text_block_id` null means not refined yet; `text_start`/`text_end` are a half-open UTF-16 range inside the cleaned block text, matching browser string indexing.
- `lecture_notes(session_id, content jsonb, created_at)`
- Realtime: sessions, blocks, strokes, annotations, transcript_segments, lecture_notes. Storage: public bucket `assets`, path `{lectureId}/{assetId}.{ext}`.

## API contract (FastAPI, P2)
- `GET /health`
- `POST /assets/{id}/describe` → `{label, description, key_terms}`. Image: send the image. PDF: send the PDF as a document part. Text: send `text_content`.
- `POST /sessions/{id}/refine` → `{block, segment_ids}`. Takes the session's segments where `text_block_id is null`, cleans them into one paragraph (vocabulary = the lecture's asset `key_terms`, context = the previous text block), inserts a text block at `max(position)+1`, and sets `text_block_id` on those segments. Falls back to the joined raw text if Gemini fails. **Already implemented.**
- `POST /annotations/{id}/close` body `{crop_png_base64?}` → `{label, bubble_text}`. Sets `confirmed`/`closed_at`, reconciles only unowned segments fully contained in the capture interval, and cleans all captured speech without selecting or dropping lines.
- `POST /sessions/{id}/compile` → notes JSON; upserts `lecture_notes`.
- `POST /sessions/{id}/scribe-token` → `{token}`. Single-use ElevenLabs Scribe Realtime token (expires in 15 min) for live transcription (ElevenLabs is the only speech-to-text engine). Only for existing `live` sessions, rate-limited (10/min per session, 60/min total). 503 if `ELEVENLABS_API_KEY` is unset. No user auth yet, so anyone who knows a live session id can mint tokens.
- `POST /segments/{id}/clean` is **removed** (replaced by batch refine).

## Notes JSON (compile output)
```json
{
  "title": "...", "overview": "...",
  "sections": [{
    "id": "s1", "heading": "...",
    "paragraphs": ["... **bold** allowed ..."],
    "paragraph_block_ids": ["uuid"],
    "key_terms": [{"term": "...", "definition": "..."}],
    "figures": [{"image_block_id": "uuid", "caption": "..."}],
    "annotation_ids": ["uuid"]
  }],
  "review_questions": ["..."]
}
```
Figures render the image with one card per confirmed annotation. Selecting a circle or card selects the same stable annotation id and highlights only transcript source spans whose persisted `annotation_id` matches it. Empty annotations show "No explanation recorded." and do not highlight transcript text.

## Ownership after the redesign
- **P1** (canvas): `components/ImageBlock.tsx` (ink, lasso, shimmer, ✓/✗, popovers), `components/Board.tsx`, `pages/Teach.tsx`, `components/Sidebar.tsx`.
- **P2** (AI): `/describe` (+PDF), `/close`, `/compile` with notes v2; `/refine` is done but needs tuning.
- **P3** (speech): `hooks/useScribeTranscription.ts` (ElevenLabs Scribe v2 Realtime, the only speech-to-text engine; if it's unavailable the sidebar shows the error, with no fallback), metrics, adaptive volume.
- **P4** (platform): `pages/Dashboard.tsx`, `AllLectures.tsx`, `Prep.tsx`, `Notes.tsx`, `RawSession.tsx`; run the new `schema.sql`; deploy; pitch.

## Not built yet / open
- `/describe` (incl. PDF), `/close` and `/compile` are still stubs, so prep acknowledgements say just "Saved." and the notes come back empty.
- Nothing has been tested against a real Supabase project (no keys yet), and nothing has been tested on an iPad.
- The crop image for `/close` isn't sent yet. The backend can crop the asset image to `bbox` itself.
- Adaptive volume and speech metrics (P3) aren't started.

## Classes
Named, colored groupings: different classes, or sections of one class. Tables `classes(id, name, color)`, `lecture_classes(lecture_id, class_id)`,
`session_classes(session_id, class_id)` (many-to-many; migration `supabase/migrations/2026-11-07_classes.sql`). A new session copies its lecture's
classes. A lecture created while the dashboard is filtered to a class starts in that class. Deleting a class keeps its lectures and sessions.

## Design system
Colors, type, spacing and radii live in `web/src/styles/tokens.css` (SF Pro system font, neutral black-and-white palette, contrast >= 4.5:1, 64px tap targets). Page stylesheets reference these tokens instead of defining their own.
