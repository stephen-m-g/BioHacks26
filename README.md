<div align="center">
  <img src="web/public/aside-logo.png" alt="Aside logo" width="110" />

# Aside

### A voice-powered whiteboard that keeps up with the teacher.

**Winner of Best Use of Gemini API · BioHacks 2026**

An accessible teaching workspace that turns spoken explanations, lecture materials, and visual annotations into interactive study notes.

[**Live app**](https://web-sigma-beryl-41.vercel.app/) · [**Source code**](https://github.com/stephen-m-g/BioHacks26)

</div>

---

## Why Aside?

Traditional whiteboards assume a teacher can continuously write, draw, and speak at the same time. For educators with limited hand dexterity or progressive motor conditions such as ALS, that can become a barrier to teaching.

Aside puts the explanation first. A teacher speaks naturally while the app builds a scrolling board of lecture content. They can draw on images or circle a region to connect their spoken explanation to a specific part of the material. Students can follow along live and revisit the lesson afterward.

## Features

- **Live speech-to-whiteboard** — ElevenLabs Scribe v2 Realtime transcribes the teacher's speech as the lesson unfolds.
- **Context-aware transcript cleanup** — Gemini removes filler words, accidental repetitions, and false starts while preserving the lecture's meaning and sequence. The original raw transcription remains accessible.
- **Visual lecture materials** — Upload PDFs, images, and text notes. Multi-page PDFs appear as individually annotatable pages on the board.
- **Smart annotations** — Circle part of an image or PDF page while speaking to associate an explanation with that exact region. Hover over the circle later to see the linked speech.
- **Page-aware transcription** — Speech is associated with the PDF page that was active when it was spoken, including when the teacher revisits an earlier page.
- **Live student follow-along** — Students use a session code to watch a read-only version of the live board.
- **Interactive study notes** — After the session, Aside compiles cleaned lecture text alongside the original images and annotations, with a separate view for the raw transcript.

## How it works

```text
Teacher's voice ──> ElevenLabs Scribe v2 Realtime ──> timestamped speech
                                                         │
PDFs, images, notes ──> live teaching board <─────────────┤
                              │                          │
                       Ink and Smart circles             │
                              │                          ▼
                              └──────────────> Gemini transcript refinement
                                                 │
                                                 ▼
                                        Saved lecture session
                                                 │
                                                 ▼
                                        Interactive study notes
                                        + original transcript
```

The application uses timestamps and persisted IDs to associate speech with annotations and PDF pages. Gemini refines the words and helps organize notes; it does not guess which circle or page the teacher was discussing.

## Technology

| Layer                                  | Stack                                    |
| -------------------------------------- | ---------------------------------------- |
| Frontend                               | React, TypeScript, Vite, Zustand         |
| Speech recognition                     | ElevenLabs Scribe v2 Realtime            |
| AI text refinement and note generation | Google Gemini (`google-genai`)           |
| Backend                                | Python, FastAPI                          |
| Database and storage                   | Supabase (PostgreSQL, Realtime, Storage) |
| PDF rendering                          | PDFium (`pypdfium2`)                     |
| Hosting                                | Vercel (web), Render (API)               |

## Try Aside

Explore the [live app](https://web-sigma-beryl-41.vercel.app/).

A typical teaching session:

1. **Prepare a lecture.** Upload a PDF, image, or text note, then save the materials.
2. **Teach naturally.** Start a session, enable the microphone, and speak while navigating the visual material.
3. **Annotate visually.** Use Ink to draw or Smart mode to circle regions and link spoken explanations.
4. **Share the lesson.** Students enter the displayed session code to follow along live.
5. **Review afterward.** Open Study Notes for the cleaned, interactive document or Transcript to read the original speech recognition output.

> **Prototype note:** This is a software project exploring accessible classroom interaction, not a certified medical or assistive device. The full workflow requires configured third-party services and browser microphone permissions.

## Run locally

### Prerequisites

- Node.js and npm compatible with `web/package.json`
- Python 3.12 (the deployment uses Python 3.12.10)
- A Supabase project
- Google Gemini and ElevenLabs API keys

### 1. Configure Supabase

For a **new development project**, run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor. See [`supabase/migrations/`](supabase/migrations/) for incremental changes to existing databases; do **not** reapply migrations or duplicate schema changes already present in your database.

**Security:** The current prototype does not implement user authentication and its database configuration uses permissive access rules. Use a dedicated test project, do not upload sensitive student information, and review access policies before production deployment.

### 2. Start the API

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # fill in your server-side credentials
python -m uvicorn main:app --reload --port 8000
```

Set the values documented in [`api/.env.example`](api/.env.example). Never expose the Supabase service-role key, Gemini key, or ElevenLabs key in the frontend.

### 3. Start the frontend

In a separate terminal:

```bash
cd web
cp .env.example .env.local  # configure Supabase and API URL
npm install
npm run dev
```

Open **http://localhost:5173**. On a device other than localhost, microphone access normally requires HTTPS.

### Run tests

```bash
# Frontend (from web/)
npm test
npm run build

# Backend (from api/ with your virtual environment active)
pip install -r requirements-dev.txt
python -m pytest tests -q
```

## Repository layout

```text
web/        React app: preparation, teaching board, student view, notes
api/        FastAPI: Gemini processing, transcription tokens, PDF rendering
supabase/   Database schema and migrations
docs/       Internal technical context and implementation notes
```

## Recognition

Aside originated at **BioHacks 2026**, where it won **Best Use of Gemini API**. The project continues the idea beyond the event: making teaching materials easier to create, annotate, share, and revisit when writing or fine motor interaction is difficult.

---

_Helping keep a teacher's ideas on the board, even when writing becomes difficult._
