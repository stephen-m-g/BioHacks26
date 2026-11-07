-- Run once in the Supabase SQL editor. RLS is off for the hackathon.
-- Keep web/src/types.ts in sync with this file.

create table lectures (id uuid primary key default gen_random_uuid(), title text not null, scheduled_for date, created_at timestamptz default now());

create table assets (id uuid primary key default gen_random_uuid(), lecture_id uuid references lectures on delete cascade, kind text check (kind in ('image','text')), storage_path text, text_content text, label text, description text, key_terms text[], created_at timestamptz default now());

create table slides (id uuid primary key default gen_random_uuid(), lecture_id uuid references lectures on delete cascade, idx int not null, background_asset_id uuid references assets);

create table sessions (id uuid primary key default gen_random_uuid(), lecture_id uuid references lectures, join_code text unique, status text default 'live' check (status in ('live','ended')), current_slide_id uuid references slides, started_at timestamptz default now(), ended_at timestamptz);

create table strokes (id uuid primary key default gen_random_uuid(), session_id uuid references sessions on delete cascade, slide_id uuid references slides, points jsonb not null, color text default '#111111', width real default 0.004, created_at timestamptz default now());

create table placed_images (id uuid primary key default gen_random_uuid(), session_id uuid references sessions on delete cascade, slide_id uuid references slides, asset_id uuid references assets, x real, y real, w real, h real, created_at timestamptz default now());

create table annotations (id uuid primary key default gen_random_uuid(), session_id uuid references sessions on delete cascade, slide_id uuid references slides, kind text check (kind in ('circle','image')), path jsonb, bbox jsonb, placed_image_id uuid references placed_images, status text default 'pending' check (status in ('pending','confirmed','rejected')), drawn_at timestamptz default now(), closed_at timestamptz, label text, bubble_text text);

create table transcript_segments (id uuid primary key default gen_random_uuid(), session_id uuid references sessions on delete cascade, slide_id uuid references slides, t_start timestamptz, t_end timestamptz, raw_text text not null, clean_text text, confidence real, annotation_id uuid references annotations, created_at timestamptz default now());

create table lecture_notes (session_id uuid primary key references sessions on delete cascade, content jsonb, status text default 'draft' check (status in ('draft','published')), created_at timestamptz default now());

alter publication supabase_realtime add table sessions, strokes, placed_images, annotations, transcript_segments, lecture_notes;

-- bbox = {x, y, w, h} normalized to [0,1].

-- Public storage bucket for uploaded images (path: assets/{lectureId}/{uuid}.png).
insert into storage.buckets (id, name, public) values ('assets', 'assets', true) on conflict (id) do nothing;
-- Let the anon key upload to and read from the bucket (hackathon only).
create policy "assets anon read" on storage.objects for select using (bucket_id = 'assets');
create policy "assets anon insert" on storage.objects for insert with check (bucket_id = 'assets');
