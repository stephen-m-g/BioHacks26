-- Speech under PDF pages. While a PDF page is the active page on the live board, the words spoken are saved with
-- that page's block id (transcript_segments.page_block_id, decided by when each word was spoken, not by Gemini).
-- Refine cleans each page's speech separately and inserts the paragraph right under that page's existing
-- paragraphs (blocks.page_block_id), so it stays under its page after a reload and in the compiled notes.
-- Both null = ordinary live speech, appended at the end of the board as before.
-- Needs 2026-11-08_pdf_pages.sql first. Run once in the Supabase SQL editor. (schema.sql already includes this.)
-- This migration is intentionally not run by the repository task.

alter table transcript_segments
  add column if not exists page_block_id uuid references blocks on delete set null;

alter table blocks
  add column if not exists page_block_id uuid references blocks on delete set null;
