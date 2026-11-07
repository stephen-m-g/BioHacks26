# BioHacks 2026: iPad whiteboard for a teacher with ALS

Wearables & Quality of Life track. A teacher-only web app, projected in class, that replaces Alex Chen's whiteboard. His speech becomes a live, scrolling board of cleaned-up paragraphs and lecture images. He can ink on images or lasso part of one to link what he's saying to it. Each session is saved as an interactive study document.

**The current spec is [docs/CONTEXT.md](docs/CONTEXT.md)** (screens, schema, API contract, notes JSON, ownership).

## Layout

| Path | What | Owner |
|---|---|---|
| `web/src/pages/Teach.tsx`, `components/{Board,ImageBlock,Sidebar}.tsx` | Live session: board, ink, lasso + shimmer + ✓/✗, image bank, settings | P1 |
| `web/src/hooks/useTeacherActions.ts`, `useSessionData.ts` | Optimistic board actions; session loading + realtime | P1 / shared |
| `web/src/hooks/useScribeTranscription.ts` | Speech recognition (ElevenLabs Scribe v2 Realtime) | P3 |
| `web/src/pages/{Dashboard,AllLectures,Prep,Notes,RawSession}.tsx` | Dashboard, archive, chat-style prep, study document, raw board | P4 |
| `web/src/store/session.ts`, `store/settings.ts` | Live UI state (mode, ink, pending lasso); persisted device settings | shared |
| `web/src/types.ts`, `web/src/lib/api.ts` | DB types, typed API client | shared |
| `api/` | Python 3.11 FastAPI + google-genai + supabase-py | P2 |
| `supabase/schema.sql` | Tables, realtime publication, storage bucket | P4 |

Routes: `/` dashboard, `/lectures` all lectures/archive, `/prep/:lectureId`, `/teach/:sessionId`, `/notes/:sessionId`, `/sessions/:sessionId/raw`. **`/teach/demo` runs the live board offline with sample images**, so you can try it without Supabase.

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
cp .env.example .env         # fill in GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ELEVENLABS_API_KEY
uvicorn main:app --reload --port 8000
python smoke.py              # hits every endpoint
```

The Gemini, ElevenLabs and service role keys live only in `api/.env`. Never put them in `web/`.

## Coordinates

Slides are 16:9. Every x, y, w, h and stroke width is normalized to [0,1] of the slide's width/height. Stroke points are `[[x, y, pressure], ...]`. bbox is `{x, y, w, h}`.

## Deploy (HTTPS is required for the mic on iPad Safari)

- **Web → Vercel:** import the repo, set Root Directory to `web`, framework Vite, add the three `VITE_*` env vars. `web/vercel.json` handles SPA routing.
- **API → Render:** New → Blueprint, pick this repo (`render.yaml`), then set the secrets. Add the Vercel URL to `WEB_ORIGIN`. Vultr is an option for its sponsor prize. For quick testing: `cloudflared tunnel --url http://localhost:8000`.

## UI rules

Every tap target is at least 64px. No pinch, long-press or double-tap. Works left-handed. Few taps per action. Tolerates imprecise input.

## Adaptive volume

Needs a lapel or headset mic, with the speaker pointed away from it to avoid feedback.
