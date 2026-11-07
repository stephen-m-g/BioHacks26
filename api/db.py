"""Supabase client (service role, server-side only) + small query helpers."""
import os
from functools import lru_cache

from supabase import Client, create_client


@lru_cache
def get_db() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def public_url(storage_path: str) -> str:
    return get_db().storage.from_("assets").get_public_url(storage_path)
