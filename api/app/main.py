import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .routers import annotations, assets, sessions

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="BioHacks26 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    # Any Vercel preview deploy for this project
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": config.GEMINI_MODEL,
        "gemini_key_set": bool(config.GEMINI_API_KEY),
        "supabase_set": bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY),
    }


app.include_router(assets.router)
app.include_router(annotations.router)
app.include_router(sessions.router)
