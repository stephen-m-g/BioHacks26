-- Persist deterministic source spans for annotation-specific highlighting.
-- Offsets use UTF-16 code units so they have the same meaning in browser String.slice.
-- This migration is intentionally not run by the repository task.
alter table transcript_segments
  add column if not exists text_start integer,
  add column if not exists text_end integer;

alter table transcript_segments
  add constraint transcript_segments_text_offsets_valid
  check (
    (text_start is null and text_end is null)
    or (text_start >= 0 and text_end > text_start)
  ) not valid;
