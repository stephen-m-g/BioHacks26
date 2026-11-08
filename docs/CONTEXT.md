# Shared context (v2: scrolling study document, read-only student view)

This replaces the slide-based parts of the original shared context. Patient facts, UI rules, stack, deploy and checkpoints are unchanged. What changed:
- **No slides.** The live board is one long scrolling document, and the end product is an interactive study document, not a PDF.
- **Students follow along read-only.** The board is projected for the class. While a session is live, the teacher's breadcrumb shows a join pill: `{host}/join` and a 6-character code. Students open `/join` on their phones and type the code (or open `/join/ABC123`), which takes them to `/live/:sessionId`: the same board, read-only and live over Realtime. When the session ends they get a link to the study notes. No accounts, roles or publish step; anyone with the code can watch (RLS is off).

## Patient (unchanged, short)
Alex Chen, 47, senior high-school biology teacher with ALS. Handwriting is illegible after ~10 min. Right key pinch is 3 kg and he can't hold it for more than a few seconds (left hand is stronger now). Speech drops from 165 wpm / 98% intelligible at 9 am to 118 wpm / 91% at 4 pm.
**UI rules:** tap targets at least 64px; no pinch, long-press or double-tap; works left-handed; few taps per action; tolerant of imprecise input.

## Screens
| Route | Screen |
|---|---|
| `/` | **Dashboard**, bento layout that fits one screen (no page scroll). Row 1: aside logo, **New lecture**. Row 2: class filter (All + multi-select class chips; selecting every class or none returns to All; a lecture/session shows if it's in any selected class; **+** adds or edits classes). Grid: top left **Ready to present** (count next to the title, arrow to `/lectures`; list scrolls in its card: Start, Edit, ⋯ Classes…/Archive/Delete); bottom left **Archive** (link card to `/archive`); right **Recorded sessions** (count next to the title, arrow to `/sessions`; list scrolls in its card: Notes or Resume, ⋯ Transcript/Classes…/Delete). Portrait iPad stacks the cards; phones and very short windows let the page scroll. |
| `/lectures` | **Lectures**: active lectures only (Start, Edit, ⋯ Archive/Delete). Opened from the arrow on the dashboard's Ready to present card. |
| `/archive` | **Archive**: archived lectures only (Edit, ⋯ Restore/Delete permanently). Opened from the dashboard's Archive card. Deleting a lecture also deletes its past sessions; the confirm dialog says so. |
| `/sessions` | **Recorded sessions**: every session, newest first (Notes or Resume, Transcript, ⋯ Classes…/Delete). Opened from the arrow on the dashboard's Recorded sessions card. |
| `/prep/:lectureId` | **Prep** (create/edit a lecture), fits one screen. Header: ←, the editable title and **Save lecture** on the right (same save as the dialog's Save, then back to the dashboard; for a brand-new lecture it stays disabled until at least one upload or typed note has been stored, and while an upload is still running). ← asks **Save / Don't save / Cancel** when anything would be lost (always for a brand-new lecture, since not saving deletes it); with no changes it just goes back. Save applies title, classes and removals. Class chips (dashboard-style, + for a new class) under the header. **Materials** chat card fills the middle and scrolls inside itself: uploads (images, PDFs, .txt) and typed notes, each with an AI acknowledgement from `/describe`; images go to the image bank, the rest becomes context. Composer at the bottom: Attach, a notes field that grows to about six lines, Send (grey until there's text). |
| `/teach/:sessionId` | **Live session** (below). Projected for the class. While live, a dark pill on the right of the breadcrumb shows `{host}/join` and the session's join code in large monospace, readable from the back of the room. |
| `/notes/:sessionId` | **Study document** (processed notes). Shows "compiling…" until the notes land (compiling once itself if End session's compile never arrives), plus a Print/PDF button. With `?student=1` (opened from the student view) a **Board** link back to `/live/:sessionId` replaces Lectures, and the page never starts that compile itself (only the teacher's page does). |
| `/sessions/:sessionId/raw` | **Raw view.** The board as it ended (read-only), plus the timestamped transcript. Not linked from anywhere for now. |
| `/join`, `/join/:code` | **Join** (students, phone-first). One card: enter the code on the board (big monospace field, Join enabled at 6 characters). An unknown code says "No lecture with that code. Check the board and try again." `/join/:code` joins straight away. Goes to `/live/:sessionId`. |
| `/live/:sessionId` | **Student live view.** The board read-only and live: title with a pulsing Live dot (or an Ended badge), pending lassos shimmer, tapping a circle shows his words ("Linking his words…" until `/close` writes back). Follows new content unless the student scrolls up; a **Jump to latest ↓** button appears when far from the bottom. Once ended: a banner with **Open study notes** (`/notes/:id?student=1`). No links to teacher pages. |

A prepared lecture can be launched any number of times; each launch is a new session. Archiving only hides it from the dashboard.

## Live session
- **Canvas:** a vertical document. Speech is transcribed live; unprocessed text shows in grey italics at the bottom. About every 15 s the teacher client calls `POST /sessions/{id}/refine`, which cleans the unprocessed segments into one **text block** (a paragraph) appended to the board.
- **Auto-scroll:** the board follows new text only when he's near the bottom, no lasso is open, and he hasn't touched the board (drawing, placing an image, scrolling) in the last 20 s, so it never scrolls away from a diagram he's working on.
- **Images** are blocks too. To place one: drag a thumbnail from the sidebar onto a drop slot between blocks, **or** tap a thumbnail and then tap a slot.
- **PDFs** show in the sidebar as one item each under **Documents** (first-page thumbnail, file name, page count). Dragging (or tap, then tap a slot) places **every page**, in order, as consecutive image blocks, so ink and Smart annotations work on pages unchanged. Each page has a quiet "file.pdf · Page 2 of 4" line above it. A PDF is placed once per session; tapping it again scrolls to its first page.
- **Speech under its PDF page:** one page at a time is the **active page** (marked with a dot on its label): the page crossing a reading line 35% down the board after the teacher's own scrolling settles (300 ms; auto-scroll and "show this PDF" don't count), the page or page paragraph he last touched, or page 1 right after placing a PDF. Each active-page change is timed, and every spoken word goes to the page that was active when it was spoken (ElevenLabs word timestamps; the page captured at the start of the utterance when timing is missing), so a late transcript still lands correctly. The segment's `page_block_id` is saved with it; grey speech and the refined paragraphs show right under that page's earlier paragraphs, so going back to page 1 appends there. On an ordinary paragraph or image there's no active page and speech goes to the end as before. While a page is active the board doesn't auto-scroll to the end. Annotations work as before, independent of pages. Gemini never decides the page. Pages are rendered once per PDF by `POST /assets/{id}/pages` (normally right after the upload in prep; a live session renders any PDF that doesn't have pages yet, e.g. uploaded before this existed), so later sessions reuse the same page images.
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
- `assets(id, lecture_id, kind 'image'|'text'|'pdf'|'pdf_page', storage_path, text_content, file_name, label, description, key_terms[], source_asset_id, page_number, page_count, aspect, created_at)`. A `pdf_page` row is one rendered page (PNG at `{lectureId}/{pdfId}/page-0001.png`) of the PDF in `source_asset_id` (deleted with it), unique per (`source_asset_id`, `page_number`); a PDF's `page_count` is set once every page is rendered. Migration `supabase/migrations/2026-11-08_pdf_pages.sql`; without it the app works but PDFs can't go on the board.
- `sessions(id, lecture_id → lectures on delete cascade, title, status 'live'|'ended', started_at, ended_at, join_code unique)`. `title` starts as the lecture title and can be renamed per session. `join_code` is 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), set by the teacher's page when a live session opens; migration `supabase/migrations/2026-11-07_join_codes.sql`. Without the column the app still works, just with no code shown.
- `blocks(id, session_id, kind 'text'|'image', position float, text, asset_id, aspect, page_block_id, created_at)`. The board is the blocks sorted by `position`; an image inserted between two blocks gets the midpoint position. `aspect` = image width/height. `page_block_id` (text blocks) = the PDF page block this paragraph is about (null otherwise; set null if the page is deleted).
- `strokes(id, session_id, block_id, points [[x,y,pressure]], color, width, created_at)`
- `annotations(id, session_id, block_id, path [[x,y,p]], bbox {x,y,w,h}, status 'pending'|'confirmed'|'rejected', drawn_at, closed_at, label, bubble_text)`
- `transcript_segments(id, session_id, t_start, t_end, raw_text, confidence, annotation_id, text_block_id, text_start, text_end, created_at)`. `text_block_id` null means not refined yet; `text_start`/`text_end` are a half-open UTF-16 range inside the cleaned block text, matching browser string indexing; both are null when the segment was only filler and left no cleaned text. `page_block_id` = the PDF page block that was active when the words were spoken (null = no page). Migration `supabase/migrations/2026-11-08_page_speech.sql` (adds it to both tables); without it the app works, but speech always goes to the end of the board.
- `lecture_notes(session_id, content jsonb, created_at)`
- Realtime: sessions, blocks, strokes, annotations, transcript_segments, lecture_notes. Storage: public bucket `assets`, path `{lectureId}/{assetId}.{ext}`.

## API contract (FastAPI, P2)
- `GET /health`
- `POST /assets/{id}/describe` → `{label, description, key_terms}`. Image: send the image. PDF: send the PDF as a document part. Text: send `text_content`.
- `POST /assets/{id}/pages` → `{page_count, pages}`. Renders every page of a PDF asset with PDFium (pypdfium2) to a PNG `pdf_page` asset: long side 2000 px (at most 4x), its own aspect and rotation, white background. Idempotent: a complete PDF returns its existing rows without rendering; page ids and paths are deterministic, so a retry after a partial failure overwrites instead of duplicating; one render per PDF at a time. Errors (shown to the teacher as `detail`): 422 damaged / password-protected / no pages, 413 over 50 MB or over 100 pages, 404 file missing, 503 migration not run.
- `POST /sessions/{id}/refine` → `{block, segment_ids, moved_blocks}`. Takes the session's oldest segments where `text_block_id is null` while they share one page (`page_block_id`, at most about 150 words), cleans them into one paragraph (vocabulary = the lecture's asset `key_terms`, context = the previous text block), and sets `text_block_id` on those segments. No page: the text block goes at `max(position)+1`. A page: it goes after that page's last paragraph (or the page itself) with `page_block_id` set; if the gap between positions is too small, the following blocks shift down and come back in `moved_blocks`. The client calls it up to four times per tick to drain speech spanning several pages. Each segment's cleanup is validated on its own (`api/cleanup.py`: only filler, repetition, false-start and sound-alike edits pass); a missing or unsafe segment, or a failed Gemini call, gets a deterministic um/uh/stutter cleanup instead, without discarding the other segments. A batch that was only filler is attached to the previous text block instead of adding an empty paragraph. **Already implemented.**
- `POST /annotations/{id}/close` body `{crop_png_base64?}` → `{label, bubble_text}`. Sets `confirmed`/`closed_at`, reconciles only unowned segments fully contained in the capture interval, and cleans all captured speech without selecting or dropping lines.
- `POST /sessions/{id}/compile` → notes JSON; upserts `lecture_notes`. Each PDF page on the board becomes its own section (heading "Forces worksheet, page 2", the page as its figure, then exactly the refined paragraphs with that `page_block_id`, in board order); the rest keeps Gemini's sections. The Notes page shows a PDF page above its paragraphs.
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

Exception (chosen): the dashboard bento lists, row buttons, card-header arrows and class chips use 48px tap areas so rows can be thin. "New lecture" and every other page keep 64px.
