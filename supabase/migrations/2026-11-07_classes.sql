-- Classes: named groupings (different classes, or sections of the same class) with a color.
-- A lecture and a session can each belong to any number of classes.
-- Run once in the Supabase SQL editor on an existing database. (schema.sql already includes this.)

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null,                -- hex, from the palette in web/src/lib/classes.ts
  created_at timestamptz default now()
);

create table if not exists lecture_classes (
  lecture_id uuid not null references lectures on delete cascade,
  class_id uuid not null references classes on delete cascade,
  primary key (lecture_id, class_id)
);

create table if not exists session_classes (
  session_id uuid not null references sessions on delete cascade,
  class_id uuid not null references classes on delete cascade,
  primary key (session_id, class_id)
);

-- Hackathon: RLS off, like the other tables.
alter table classes disable row level security;
alter table lecture_classes disable row level security;
alter table session_classes disable row level security;
