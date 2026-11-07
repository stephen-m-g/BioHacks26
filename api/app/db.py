"""Supabase client using the service role key (server-side only)."""
from functools import lru_cache

from supabase import Client, create_client

from . import config


@lru_cache
def get_db() -> Client:
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (copy api/.env.example to api/.env)")
    return create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)


def storage_public_url(storage_path: str) -> str:
    return get_db().storage.from_("assets").get_public_url(storage_path)
