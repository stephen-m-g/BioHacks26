# BioHacks 2026: iPad whiteboard for a teacher with ALS

Wearables & Quality of Life track. A web app that replaces Alex Chen's whiteboard with an iPad: live ink, circles that link his speech to what he selects, live cleaned-up speaker notes for students, and compiled lecture notes at the end.

## Layout

| Path | What | Owner |
|---|---|---|
| `web/` | Vite + React + TS, react-konva, perfect-freehand, zustand, supabase-js | P1, P3, P4 |
| `web/src/components/SlideRenderer.tsx` | Shared 16:9 board renderer (teacher + read-only student) | P1 |
| `web/src/pages/Teach.tsx` | `/teach/:sessionId` teacher canvas | P1 |
| `web/src/components/SpeakerNotes.tsx`, `web/src/hooks/useTranscription.ts` | Speech pipeline, speaker notes, adaptive volume | P3 |
| `web/src/pages/{PrepList,PrepLecture,Join,Student,Notes}.tsx` | Prep flow, student view, notes page | P4 |
| `web/src/store/session.ts` | Shared zustand store (P1 writes, P3 reads) | P4 stub |
| `web/src/types.ts` | Types mirroring the DB tables | P4 |
| `web/src/lib/api.ts` | Typed fetch wrappers for every API endpoint | shared |
| `api/` | Python 3.11 FastAPI + google-genai + supabase-py | P2 |
| `supabase/schema.sql` | Tables, realtime publication, storage bucket | P4 |

Routes: `/prep`, `/prep/:lectureId`, `/teach/:sessionId`, `/join`, `/s/:sessionId`, `/notes/:sessionId`. The home page `/` has a system check that shows whether the API and Supabase are reachable.

## Setup

### 1. Supabase (P4, once)
Create a project, then paste `supabase/schema.sql` into the SQL editor and run it. It creates the tables, adds them to realtime, and creates the public `assets` bucket. Share the project URL, anon key and service role key with the team (not in git).

### 2. Web
```bash
cd web
cp .env.example .env.local   # fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL
npm install
npm run dev                  # http://localhost:5173
```

### 3. API
```bash
cd api
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env         # fill in GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
uvicorn app.main:app --reload --port 8000
python scripts/smoke_test.py # hits every endpoint
```

The Gemini key and the service role key live only in `api/.env`. Never put them in `web/`.

## Coordinates

Slides are 16:9. Every x, y, w, h and stroke width is normalized to [0,1] of the slide's width/height. Stroke points are `[[x, y, pressure], ...]`. bbox is `{x, y, w, h}`.

## Deploy (HTTPS is required for the mic on iPad Safari)

- **Web → Vercel:** import the repo, set Root Directory to `web`, framework Vite, add the three `VITE_*` env vars. `web/vercel.json` handles SPA routing.
- **API → Render:** New → Blueprint, pick this repo (`render.yaml`), then set the secrets. Add the Vercel URL to `CORS_ORIGINS` (`*.vercel.app` is already allowed). Vultr is an option for its sponsor prize. For quick testing: `cloudflared tunnel --url http://localhost:8000`.

## UI rules

Every tap target is at least 64px. No pinch, long-press or double-tap. Works left-handed. Few taps per action. Tolerates imprecise input.

## Adaptive volume

Needs a lapel or headset mic, with the speaker pointed away from it to avoid feedback.
