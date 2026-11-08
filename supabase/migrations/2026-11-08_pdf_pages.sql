-- PDF pages on the board. Each page of an uploaded PDF is rendered once (POST /assets/{id}/pages) to a PNG
-- asset row of kind 'pdf_page' that points back at its PDF, so board image blocks, ink and Smart annotations
-- work on pages unchanged. The PDF row itself stays kind 'pdf' (context for Gemini) and records its page count.
-- Run once in the Supabase SQL editor on an existing database. (schema.sql already includes this.)
-- This migration is intentionally not run by the repository task.

alter table assets drop constraint if exists assets_kind_check;
alter table assets add constraint assets_kind_check check (kind in ('image','text','pdf','pdf_page'));

alter table assets
  add column if not exists source_asset_id uuid references assets on delete cascade, -- pdf_page: its PDF
  add column if not exists page_number integer,                                     -- pdf_page: 1-based
  add column if not exists page_count integer,                                      -- pdf: set once every page is rendered
  add column if not exists aspect real;                                             -- pdf_page: width / height

-- One row per page of a PDF, so rendering again (another session, a retry) never duplicates pages.
create unique index if not exists assets_pdf_page_unique on assets (source_asset_id, page_number)
  where source_asset_id is not null;
