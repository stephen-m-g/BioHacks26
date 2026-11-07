-- Run once in the Supabase SQL editor. RLS is off for the hackathon.
-- v2: no slides. The board is an ordered list of blocks (text paragraphs and images).
-- Keep web/src/types.ts and docs/CONTEXT.md in sync with this file.

create table lectures (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Untitled lecture',
  archived_at timestamptz,
  created_at timestamptz default now()
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  lecture_id uuid references lectures on delete cascade,
  kind text check (kind in ('image','text','pdf')),
  storage_path text,          -- path inside the "assets" bucket: {lectureId}/{assetId}.{ext}
  text_content text,
  file_name text,
  label text,
  description text,
  key_terms text[],
  created_at timestamptz default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  lecture_id uuid references lectures on delete cascade,
  status text default 'live' check (status in ('live','ended')),
  started_at timestamptz default now(),
  ended_at timestamptz
);

-- The board: blocks sorted by position. Inserting between two blocks uses the midpoint.
create table blocks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  kind text check (kind in ('text','image')),
  position double precision not null,
  text text,                  -- text blocks: refined paragraph
  asset_id uuid references assets on delete set null,  -- image blocks
  aspect real,                -- image blocks: width / height
  created_at timestamptz default now()
);

-- Ink on an image block. points = [[x, y, pressure], ...] normalized to the image; width = fraction of image width.
create table strokes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  block_id uuid references blocks on delete cascade,
  points jsonb not null,
  color text default '#111111',
  width real default 0.006,
  created_at timestamptz default now()
);

-- Smart (lasso) annotation on an image block. bbox = {x, y, w, h} normalized to the image.
create table annotations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  block_id uuid references blocks on delete cascade,
  path jsonb,
  bbox jsonb,
  status text default 'pending' check (status in ('pending','confirmed','rejected')),
  drawn_at timestamptz default now(),
  closed_at timestamptz,
  label text,
  bubble_text text
);

create table transcript_segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  t_start timestamptz,
  t_end timestamptz,
  raw_text text not null,
  confidence real,
  annotation_id uuid references annotations on delete set null,
  text_block_id uuid references blocks on delete set null,  -- null = not refined yet
  created_at timestamptz default now()
);

-- Compiled study document. No publish step while the tool is teacher-only.
create table lecture_notes (
  session_id uuid primary key references sessions on delete cascade,
  content jsonb,
  created_at timestamptz default now()
);

alter publication supabase_realtime add table sessions, blocks, strokes, annotations, transcript_segments, lecture_notes;

-- Public storage bucket for uploads.
insert into storage.buckets (id, name, public) values ('assets', 'assets', true) on conflict (id) do nothing;
-- Let the anon key upload, read and delete in the bucket (hackathon only).
create policy "assets anon read" on storage.objects for select using (bucket_id = 'assets');
create policy "assets anon insert" on storage.objects for insert with check (bucket_id = 'assets');
create policy "assets anon delete" on storage.objects for delete using (bucket_id = 'assets');
