-- Student join codes. While a session is live, the teacher's projected screen shows a 6-character code;
-- students open /join, type it, and follow the board read-only at /live/:sessionId.
-- The teacher's page sets the code when a live session opens. Without this column the app still works (no code shown).
-- Run once in the Supabase SQL editor on an existing database. (schema.sql already includes this.)

alter table sessions add column if not exists join_code text unique;
