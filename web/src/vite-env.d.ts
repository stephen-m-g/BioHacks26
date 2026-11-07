/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_API_URL: string
  /** Optional comma-separated ElevenLabs keyterms; replaces the built-in biology list. */
  readonly VITE_ELEVENLABS_KEYTERMS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
